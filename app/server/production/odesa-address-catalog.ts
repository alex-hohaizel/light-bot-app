import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {dayBounds,localParts} from '../../shared/schedule-core.ts';
import {normalizeAddressText,houseMatchesQuery} from '../../shared/address-index.ts';
import type {AddressOption} from '../../shared/bot/types.ts';
import {buildOdesaStreetRowCandidate,readOdesaStreetCatalog,readOdesaHouseChoices,
 type OdesaAjaxCapture,type OdesaAddressCandidate,type OdesaOperatorHouseNotice} from '../domain/odesa-address-adapter.ts';
import {odesaPublicAddressRequestIdentity} from '../domain/public-address-request-identity.ts';
import {createOdesaPublicClient,getOdesaInternalIntake,isNativeOdesaPublicResult,
 type OdesaBeforeHop,type OdesaPublicClient} from '../providers/odesa-public-client.ts';
import {createPublicSourceReservationGuard,type SourceReservationFailure} from './public-source-reservation.ts';
import type {LegacyProfileReadPool,LegacyProfileReadQuery} from './profile-reader.ts';

const ORIGIN='https://www.dtek-oem.com.ua',AJAX='https://www.dtek-oem.com.ua/ua/ajax' as const;
const TTL=600000,MAX_QUERIES=2048,MAX_CAPTURES=4096,MAX_CANDIDATES=512,MAX_ODESA_BYTES=64*1024*1024;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Mode='standard_fetch_https'|'fixture_unverified';
type Row={id:string;capture:OdesaAjaxCapture;mode:Mode};
type Level='localities'|'streets'|'houses';
export interface OperatorAddressSnapshot {
 kind:'lba-provider-address-snapshot/2';id:string;revisionId:string;namespace:'dtek:oem';level:Level;
 catalogSnapshotId:string;cityKey?:string;streetKey?:string;observedAt:string;expiresAt:string;
 items:Array<{key:string;value:string}>;offset:number;hasMore:boolean;catalogCompleteness:'unknown';
}
export type OdesaCatalogRejected={state:'disabled'|'unavailable'|'deferred'|'stale';code:string;retryAt?:string};
export type OdesaCatalogSearch={state:'available';cache:'hit'|'miss';snapshot:OperatorAddressSnapshot}|OdesaCatalogRejected;
export type OdesaCatalogCandidate={state:'available';cache:'hit';snapshotId:string;options:AddressOption[];
 operatorNotice:OdesaOperatorHouseNotice;mappingFingerprint:string;candidateProof:OdesaAddressCandidate['proof'];
 observedAt:string;expiresAt:string;addressBindingVerified:false;deliveryEligible:false}|OdesaCatalogRejected;
type Options={enabled?:boolean;expectedControlEpoch:number;pool:LegacyProfileReadPool;now:()=>number};
class Refused extends Error{constructor(readonly code:string,readonly retryAt?:string){super(code);}}
function fail(code:string,retryAt?:string):never{throw new Refused(code,retryAt);}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function closed(value:unknown,allowed:string[],required=allowed):asserts value is Record<string,unknown>{
 if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('ADDRESS_INVALID_REQUEST');
 const fields=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).some(k=>typeof k!=='string'||!allowed.includes(k)||!('value'in fields[k]))||required.some(k=>!fields[k]))fail('ADDRESS_INVALID_REQUEST');
}
function literal(value:unknown,max=300):string{
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value)||Buffer.from(value).toString('utf8')!==value)fail('ADDRESS_INVALID_REQUEST');return value as string;
}
function query(value:unknown):string{const text=literal(value,100);try{return normalizeAddressText(text);}catch{return fail('ADDRESS_INVALID_REQUEST');}}
function offset(value:unknown):number{if(value===undefined)return 0;if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>20000)fail('ADDRESS_INVALID_REQUEST');return Number(value);}
function stamp(value:unknown):number{const n=value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;if(!Number.isFinite(n))fail('ADDRESS_SCHEMA_REJECTED');return n;}
const reject=(error:unknown):OdesaCatalogRejected=>{
 const code=error instanceof Refused?error.code:'ADDRESS_SOURCE_UNAVAILABLE';return {state:code==='ADDRESS_SERVICE_DISABLED'?'disabled':code==='ADDRESS_STALE_SNAPSHOT'?'stale':
  ['ADDRESS_WORKER_HELD','ADDRESS_ORIGIN_HELD','ADDRESS_BUDGET_DEFERRED'].includes(code)?'deferred':'unavailable',code,...(error instanceof Refused&&error.retryAt?{retryAt:error.retryAt}:{})};
};
function reservationError(value:SourceReservationFailure):never{
 return fail(value.code==='RESERVATION_WORKER_HELD'?'ADDRESS_WORKER_HELD':value.code==='RESERVATION_ORIGIN_HELD'?'ADDRESS_ORIGIN_HELD':
  value.code==='RESERVATION_LOCAL_BUDGET_DEFERRED'?'ADDRESS_BUDGET_DEFERRED':value.code==='RESERVATION_EPOCH_CONFLICT'?'ADDRESS_EPOCH_CONFLICT':
  value.code==='RESERVATION_CONTROL_REJECTED'?'ADDRESS_CONTROL_REJECTED':'ADDRESS_PUBLICATION_UNKNOWN',value.retryAt);
}
const identity=(operation:OdesaAjaxCapture['operation'],fields:OdesaAjaxCapture['request'])=>odesaPublicAddressRequestIdentity({method:'POST',url:AJAX,operation,fields});
const asOptions=(candidate:OdesaAddressCandidate):AddressOption[]=>candidate.bindingChoices.map(binding=>({
 id:candidate.address.id+':group:'+binding.targetId,address:structuredClone(candidate.address),binding:structuredClone(binding),
 territoryLabel:'Одеська область · ДТЕК Одеські електромережі',connectionLabel:'Група '+binding.targetId.replace(/^GPV/,'')
}));

/** Uses existing public cache schema, never applies DDL or activates source,
 * owner profile, notifications, timers or background work. Default is inert.
 * The caller still owns operating-policy admission and all source qualification.
 */
export function createOdesaAddressCatalog(options:Options){return create(options,hook=>createOdesaPublicClient({beforeHop:hook}),false);}
/** Isolated test seam. Persisted fixture rows retain fixture mode and cannot be
 * read as native facts by the normal factory. Never substitute for source proof. */
export function createOdesaAddressCatalogForFixtureTests(options:Options&{clientFactory:(hook:OdesaBeforeHop)=>OdesaPublicClient}){
 return create(options,options.clientFactory,true);
}
function create(options:Options,factory:(hook:OdesaBeforeHop)=>OdesaPublicClient,fixtures:boolean){
 if(!options?.pool||typeof options.pool.connect!=='function'||typeof options.now!=='function'||!Number.isSafeInteger(options.expectedControlEpoch)||options.expectedControlEpoch<1||
  options.enabled!==undefined&&typeof options.enabled!=='boolean'||typeof factory!=='function')throw Error('INVALID_ODESA_CATALOG_OPTIONS');
 options={...options};const reservations=createPublicSourceReservationGuard({pool:options.pool,expectedControlEpoch:options.expectedControlEpoch});let lastClock=-Infinity;
 function clock(){const n=options.now();if(!Number.isSafeInteger(n)||n<0||n>8640000000000000||n<lastClock)fail('ADDRESS_CLOCK_INVALID');lastClock=n;return n;}
 function enabled(){if(options.enabled!==true)fail('ADDRESS_SERVICE_DISABLED');clock();}
 const policy=()=>({asOf:new Date(clock()).toISOString(),maximumCaptureAgeMs:TTL});
 function current(row:Row){const now=clock(),observed=stamp(row.capture.observedAt);if(observed>now)fail('ADDRESS_SCHEMA_REJECTED');
  if(now-observed>=TTL||localParts(now).date!==localParts(observed).date)fail('ADDRESS_STALE_SNAPSHOT');}
 async function control(q:LegacyProfileReadQuery,write=false){const rows=(await q.query('select control_epoch,writer_mode from lba_production_control where id=true'+(write?' for share':''))).rows;
  if(rows.length!==1||rows[0].writer_mode!=='canonical')fail('ADDRESS_CONTROL_REJECTED');
  const n=rows[0].control_epoch;if(!(typeof n==='number'&&Number.isSafeInteger(n)||typeof n==='string'&&/^[1-9]\d{0,15}$/.test(n))||Number(n)!==options.expectedControlEpoch)fail('ADDRESS_EPOCH_CONFLICT');}
 async function read<T>(work:(q:LegacyProfileReadQuery)=>Promise<T>,write=false):Promise<T>{enabled();const c=await options.pool.connect();let tx=false;
  try{await c.query(write?'begin isolation level read committed':'begin isolation level repeatable read read only');tx=true;await control(c,write);const result=await work(c);const committed=await c.query('commit');tx=false;
   if('command'in committed&&committed.command!=='COMMIT')fail('ADDRESS_PUBLICATION_UNKNOWN');return result;
  }finally{if(tx)await c.query('rollback').catch(()=>{});c.release();}}
 function row(value:any):Row{
  if(!uuid(value.id)||value.request_url!==AJAX||Number(value.control_epoch)!==options.expectedControlEpoch)fail('ADDRESS_SCHEMA_REJECTED');
  const envelope=value.capture;closed(envelope,['kind','mode','reservationToken','capture']);
  if(envelope.kind!=='lba-odesa-address-capture/1'||envelope.reservationToken!==value.id||
   envelope.mode!=='standard_fetch_https'&&!(fixtures&&envelope.mode==='fixture_unverified'))fail('ADDRESS_SCHEMA_REJECTED');
  const capture=envelope.capture as OdesaAjaxCapture;
  if(!capture||stamp(capture.observedAt)!==stamp(value.observed_at)||value.operation!==(capture.operation==='getStreets'?'streets':'houses'))fail('ADDRESS_SCHEMA_REJECTED');
  const result={id:value.id,capture,mode:envelope.mode as Mode};current(result);return result;
 }
 async function latest(q:LegacyProfileReadQuery,id:string,lock=false):Promise<Row>{
  const values=(await q.query('select id,operation,request_url,capture,observed_at,control_epoch from lba_public_address_capture where id=$1',[id])).rows;
  if(values.length!==1)fail('ADDRESS_SNAPSHOT_NOT_FOUND');const result=row(values[0]);
  const key=identity(result.capture.operation,result.capture.request).requestKey;
  const pointers=(await q.query('select latest_capture_id,last_attempt_at,last_failure from lba_public_address_query where request_key=$1 and request_url=$2'+(lock?' for share':''),[key,AJAX])).rows;
  if(pointers.length!==1||pointers[0].latest_capture_id!==id||pointers[0].last_failure!==null&&stamp(pointers[0].last_attempt_at)>=stamp(result.capture.observedAt))fail('ADDRESS_STALE_SNAPSHOT');
  return result;
 }
 async function cached(q:LegacyProfileReadQuery,key:string,minimum:number):Promise<Row|undefined>{
  const rows=(await q.query(`select q.last_attempt_at,q.last_failure,c.id,c.operation,c.request_url,c.capture,c.observed_at,c.control_epoch
   from lba_public_address_query q left join lba_public_address_capture c on c.id=q.latest_capture_id where q.request_key=$1`,[key])).rows;
  if(rows.length>1)fail('ADDRESS_SCHEMA_REJECTED');if(!rows[0]?.id)return;
  if(rows[0].last_failure!==null&&stamp(rows[0].last_attempt_at)>=stamp(rows[0].observed_at))return;
  try{const result=row(rows[0]);if(stamp(result.capture.observedAt)>=minimum)return result;}
  catch(error){if(!(error instanceof Refused)||error.code!=='ADDRESS_STALE_SNAPSHOT')throw error;}
 }
 async function acquire(operation:OdesaAjaxCapture['operation'],fields:OdesaAjaxCapture['request'],parent?:Row){
  enabled();const key=identity(operation,fields).requestKey,minimum=parent?stamp(parent.capture.observedAt):0;
  const validate=(r:Row)=>operation==='getStreets'?readOdesaStreetCatalog(r.capture,policy()):readOdesaHouseChoices(r.capture,parent!.capture,
   {city:(fields as any).city,street:(fields as any).street},policy());
  const hit=await read(q=>cached(q,key,minimum));if(hit){validate(hit);return {row:hit,cache:'hit' as const};}
  let raced:Row|undefined,capacity=false;
  const abort=new AbortController();
  const reserved=await reservations.reserve({origin:ORIGIN,expectedMaxHops:2,minIntervalMs:7500,strictEightPerMinute:true,deadlineMs:30000,signal:abort.signal,
   persist:async(q,receipt)=>{
    const found=await cached(q,key,minimum);if(found){validate(found);raced=found;throw Error('FRESH_SHARED_CACHE');}
    const counts=(await q.query(`select (select count(*)::int from lba_public_address_query) as queries,
     (select count(*)::int from lba_public_address_capture) as captures`)).rows[0];
    const old=(await q.query('select request_key from lba_public_address_query where request_key=$1',[key])).rows;
    if(!counts||!Number.isSafeInteger(counts.queries)||!Number.isSafeInteger(counts.captures))fail('ADDRESS_SCHEMA_REJECTED');
    if(!old.length&&counts.queries>=MAX_QUERIES||counts.captures>=MAX_CAPTURES){capacity=true;throw Error('CAPACITY');}
    await q.query(`insert into lba_public_address_query(request_key,request_url,last_attempt_at,last_failure) values($1,$2,$3,null)
     on conflict(request_key) do update set last_attempt_at=excluded.last_attempt_at`,[key,AJAX,receipt.reservedAt]);
   }});
  if(reserved.state!=='reserved'){if(raced&&reserved.code==='RESERVATION_CALLBACK_FAILED')return {row:raced,cache:'hit' as const};if(capacity)fail('ADDRESS_CACHE_CAPACITY');return reservationError(reserved);}
  const receipt=reserved.reservation.receipt;let result:Row|undefined,sourceFailure=false,workerHold=false,client:OdesaPublicClient|undefined;
  try{
   // Record public request intent only. No guest values are visible to SQL.
   // persist is finalized together with the immutable result below; the durable
   // reservation marker already prevents another writer from dispatching.
   client=factory(async(descriptor,signal)=>{const granted=await reserved.reservation.beforeHop({origin:new URL(descriptor.url).origin},signal);
    if(granted.state!=='granted')throw Error('DURABLE_HOP_DENIED');});
   const output=operation==='getStreets'?await client.catalog(abort.signal):await client.houseList({city:(fields as any).city,street:(fields as any).street},abort.signal);
   const intake=getOdesaInternalIntake(output),capture=operation==='getStreets'?intake?.captures.catalog:intake?.captures.houses;
   if(!intake||!capture||intake.mode!=='standard_fetch_https'&&!(fixtures&&intake.mode==='fixture_unverified')||!fixtures&&!isNativeOdesaPublicResult(output))fail('ADDRESS_SOURCE_UNAVAILABLE');
   result={id:receipt.reservationToken,capture:structuredClone(capture),mode:intake.mode};current(result);validate(result);
  }catch(error){result=undefined;sourceFailure=true;workerHold=Boolean(error&&typeof error==='object'&&'code'in error&&
   ['ODESA_TRANSPORT_TIMEOUT','ODESA_TRANSPORT_CANCELLED','ODESA_TRANSPORT_CLOSED'].includes(String(error.code)));}finally{client?.close();}
  const envelope=result?{kind:'lba-odesa-address-capture/1',mode:result.mode,reservationToken:result.id,capture:result.capture}:undefined;
  const finalized=await reserved.reservation.finalize({...(sourceFailure?{hold:workerHold?'worker-and-origin' as const:'origin' as const}:{}),persist:async(q,r)=>{
   await q.query(`insert into lba_public_address_query(request_key,request_url,last_attempt_at,last_failure) values($1,$2,$3,$4)
    on conflict(request_key) do update set last_attempt_at=excluded.last_attempt_at,last_failure=excluded.last_failure`,[key,AJAX,r.reservedAt,result?null:'ADDRESS_SOURCE_UNAVAILABLE']);
   if(result){
    // Compare the same PostgreSQL representation on BOTH sides. JSONB text can
    // be larger than compact JSON.stringify (spaces/key representation).
    const sizes=(await q.query("select coalesce(sum(octet_length(capture::text)),0)::text as bytes,octet_length($1::jsonb::text)::text as incoming_bytes from lba_public_address_capture where capture->>'kind'='lba-odesa-address-capture/1'",[JSON.stringify(envelope)])).rows[0];
    if(!sizes||typeof sizes.bytes!=='string'||!/^\d+$/.test(sizes.bytes)||typeof sizes.incoming_bytes!=='string'||!/^\d+$/.test(sizes.incoming_bytes)||
     !Number.isSafeInteger(Number(sizes.bytes))||!Number.isSafeInteger(Number(sizes.incoming_bytes))||Number(sizes.bytes)+Number(sizes.incoming_bytes)>MAX_ODESA_BYTES)fail('ADDRESS_CACHE_CAPACITY');
    await q.query('insert into lba_public_address_capture(id,operation,request_url,capture,observed_at,control_epoch) values($1,$2,$3,$4::jsonb,$5,$6)',
     [result.id,operation==='getStreets'?'streets':'houses',AJAX,JSON.stringify(envelope),result.capture.observedAt,options.expectedControlEpoch]);
    await q.query('update lba_public_address_query set latest_capture_id=$2,last_failure=null where request_key=$1',[key,result.id]);
   }
  }});
  if(finalized.state!=='finalized')return reservationError(finalized);if(!result)fail('ADDRESS_SOURCE_UNAVAILABLE');return {row:result,cache:'miss' as const};
 }
 function snapshot(r:Row,level:Level,items:Array<{key:string;value:string}>,page:number,catalogId:string,cityKey?:string,streetKey?:string):OperatorAddressSnapshot{
  current(r);const observed=stamp(r.capture.observedAt);return {kind:'lba-provider-address-snapshot/2',id:r.id,
   revisionId:sha(JSON.stringify([r.capture.rawSha256,level,cityKey??null,streetKey??null])),namespace:'dtek:oem',level,catalogSnapshotId:catalogId,
   ...(cityKey?{cityKey}:{}),...(streetKey?{streetKey}:{}),observedAt:r.capture.observedAt,
   expiresAt:new Date(Math.min(observed+TTL,dayBounds(localParts(observed).date).end)).toISOString(),
   items:items.slice(page,page+30),offset:page,hasMore:items.length>page+30,catalogCompleteness:'unknown'};
 }
 async function searchLocalities(value:unknown):Promise<OdesaCatalogSearch>{try{
  enabled();closed(value,['query','offset'],['query']);const needle=query(value.query),page=offset(value.offset),got=await acquire('getStreets',{});
  const catalog=readOdesaStreetCatalog(got.row.capture,policy());return {state:'available',cache:got.cache,
   snapshot:snapshot(got.row,'localities',catalog.localities.filter(v=>normalizeAddressText(v.key).includes(needle)).map(v=>({key:v.key,value:v.key})),page,got.row.id)};
 }catch(e){return reject(e);}}
 async function searchStreets(value:unknown):Promise<OdesaCatalogSearch>{try{
  enabled();closed(value,['catalogSnapshotId','cityKey','query','offset'],['catalogSnapshotId','cityKey','query']);if(!uuid(value.catalogSnapshotId))fail('ADDRESS_INVALID_REQUEST');
  const city=literal(value.cityKey),needle=query(value.query),page=offset(value.offset),r=await read(q=>latest(q,value.catalogSnapshotId as string));
  const catalog=readOdesaStreetCatalog(r.capture,policy()),entry=catalog.localities.find(v=>v.key===city);if(!entry)fail('ADDRESS_SELECTION_REJECTED');
  return {state:'available',cache:'hit',snapshot:snapshot(r,'streets',entry.streets.filter(v=>normalizeAddressText(v).includes(needle)).map(v=>({key:v,value:v})),page,r.id,city)};
 }catch(e){return reject(e);}}
 async function searchHouses(value:unknown):Promise<OdesaCatalogSearch>{try{
  enabled();closed(value,['catalogSnapshotId','cityKey','streetKey','query','offset'],['catalogSnapshotId','cityKey','streetKey','query']);if(!uuid(value.catalogSnapshotId))fail('ADDRESS_INVALID_REQUEST');
  const city=literal(value.cityKey),street=literal(value.streetKey),needle=literal(value.query,100),page=offset(value.offset),parent=await read(q=>latest(q,value.catalogSnapshotId as string));
  const catalog=readOdesaStreetCatalog(parent.capture,policy());if(!catalog.localities.some(v=>v.key===city&&v.streets.includes(street)))fail('ADDRESS_SELECTION_REJECTED');
  const got=await acquire('getHomeNum',{city,street,house_num:'',updateFact:''},parent),houses=readOdesaHouseChoices(got.row.capture,parent.capture,{city,street},policy());
  return {state:'available',cache:got.cache,snapshot:snapshot(got.row,'houses',houses.choices.filter(v=>houseMatchesQuery(v.key,needle,'prefix')).map(v=>({key:v.key,value:v.key})),page,parent.id,city,street)};
 }catch(e){return reject(e);}}
 async function resolveCandidate(value:unknown):Promise<OdesaCatalogCandidate>{try{
  enabled();closed(value,['catalogSnapshotId','houseSnapshotId','cityKey','streetKey','houseKey']);if(!uuid(value.catalogSnapshotId)||!uuid(value.houseSnapshotId))fail('ADDRESS_INVALID_REQUEST');
  const city=literal(value.cityKey),street=literal(value.streetKey),house=literal(value.houseKey,100);
  return await read(async q=>{
   await q.query("select pg_advisory_xact_lock(hashtextextended('lba-public-address-candidates',0))");
   const catalog=await latest(q,value.catalogSnapshotId as string,true),houses=await latest(q,value.houseSnapshotId as string,true);
   const built=buildOdesaStreetRowCandidate({basis:'street_row/1',selection:{city,street,house},captures:{catalog:catalog.capture,houses:houses.capture},policy:policy()});
   const counts=(await q.query('select count(*)::int n from lba_public_address_candidate')).rows[0];
   const old=(await q.query('select address_id from lba_public_address_candidate where address_id=$1',[built.address.id])).rows;
   if(!counts||!Number.isSafeInteger(counts.n)||counts.n>=MAX_CANDIDATES&&!old.length)fail('ADDRESS_CACHE_CAPACITY');
   const saved=await q.query(`insert into lba_public_address_candidate(address_id,streets_id,houses_id,group_id) values($1,$2,$3,$3)
    on conflict(address_id) do update set streets_id=excluded.streets_id,houses_id=excluded.houses_id,group_id=excluded.group_id
    where (select observed_at from lba_public_address_capture where id=excluded.group_id)>=
     (select observed_at from lba_public_address_capture where id=lba_public_address_candidate.group_id) returning address_id`,[built.address.id,catalog.id,houses.id]);
   if(saved.rows.length!==1)fail('ADDRESS_SELECTION_REJECTED');
   return {state:'available',cache:'hit',snapshotId:houses.id,options:asOptions(built),operatorNotice:built.operatorNotice,mappingFingerprint:built.mappingFingerprint,
    candidateProof:built.proof,observedAt:built.proof.observedAt,expiresAt:new Date(Math.min(...built.proof.captures.map(v=>stamp(v.observedAt)+TTL),dayBounds(localParts(stamp(built.proof.observedAt)).date).end)).toISOString(),addressBindingVerified:false,deliveryEligible:false};
  },true);
 }catch(e){return reject(e);}}
 async function readCandidates(){
  try{return await read(async q=>{
   const rows=(await q.query(`select p.address_id,p.streets_id,p.houses_id,p.group_id from lba_public_address_candidate p
    join lba_public_address_capture c on c.id=p.streets_id where c.capture->>'kind'='lba-odesa-address-capture/1' order by p.address_id limit 513`)).rows;
   if(rows.length>MAX_CANDIDATES)fail('ADDRESS_CACHE_CAPACITY');const options:AddressOption[]=[],operatorNotices:Array<{addressId:string;notice:OdesaOperatorHouseNotice}>=[];
   const observations:Array<{addressId:string;state:'current'|'stale';observedAt?:string;expiresAt?:string}>=[];
   for(const selected of rows){
    if(typeof selected.address_id!=='string'||!uuid(selected.streets_id)||!uuid(selected.houses_id)||selected.houses_id!==selected.group_id)fail('ADDRESS_SCHEMA_REJECTED');
    try{
     const catalog=await latest(q,selected.streets_id),houses=await latest(q,selected.houses_id),request=houses.capture.request as {city:string;street:string};
     const choices=readOdesaHouseChoices(houses.capture,catalog.capture,{city:request.city,street:request.street},policy());
     const matches=choices.choices.filter(v=>'provisional:dtek:oem:'+sha(JSON.stringify([request.city,request.street,v.key]))===selected.address_id);
     if(matches.length!==1)fail('ADDRESS_SELECTION_REJECTED');
     const built=buildOdesaStreetRowCandidate({basis:'street_row/1',selection:{city:request.city,street:request.street,house:matches[0].key},captures:{catalog:catalog.capture,houses:houses.capture},policy:policy()});
     options.push(...asOptions(built));operatorNotices.push({addressId:built.address.id,notice:built.operatorNotice});
     observations.push({addressId:built.address.id,state:'current',observedAt:built.proof.observedAt,
      expiresAt:new Date(Math.min(...built.proof.captures.map(v=>stamp(v.observedAt)+TTL),dayBounds(localParts(stamp(built.proof.observedAt)).date).end)).toISOString()});
    }catch(error){if(!(error instanceof Refused)||error.code!=='ADDRESS_STALE_SNAPSHOT')throw error;observations.push({addressId:selected.address_id,state:'stale'});}
   }
   return {state:'available' as const,options,operatorNotices,observations,addressBindingVerified:false as const,deliveryEligible:false as const};
  });}catch(error){return {...reject(error),options:[],operatorNotices:[],observations:[],addressBindingVerified:false as const,deliveryEligible:false as const};}
 }
 return Object.freeze({searchLocalities,searchStreets,searchHouses,resolveCandidate,readCandidates});
}
