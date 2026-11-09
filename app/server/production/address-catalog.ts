import {createHash,randomUUID} from 'node:crypto';
import {buildYasnoAddressCandidate,readYasnoStreetCandidates,readYasnoHouseCandidates,YASNO_KYIV_ADDRESS_SCOPE,
 type YasnoAddressCapture,type YasnoAddressCandidate,type AddressCaptureProof,type ProviderAddressItem} from '../domain/yasno-address-adapter.ts';
import {localParts} from '../../shared/schedule-core.ts';
import type {AddressOption} from '../../shared/bot/types.ts';
import type {LegacyProfileReadPool,LegacyProfileReadClient,LegacyProfileReadQuery} from './profile-reader.ts';
import type {SourceHttpTransport} from './source-intake.ts';
import {TECHNICAL_SOURCE_REVIEW,YASNO_SHARED_ORIGIN_BUDGET_MS} from './source-operating-policy.ts';
import {collectAddressCapture,type AddressHttpCode,type AddressHttpResult} from './address-catalog-http.ts';
import {createPublicSourceReservationGuard,type SourceReservationFailure} from './public-source-reservation.ts';
import {legacyYasnoAddressRequestKey} from '../domain/public-address-request-identity.ts';
import type {OdesaOperatorHouseNotice} from '../domain/odesa-address-adapter.ts';

/** Apply explicitly AFTER SOURCE_INGESTION_SCHEMA_SQL. No import/construction DDL.
 * These rows contain public provider catalog facts, never owners or user labels.
 */
export const ADDRESS_CATALOG_SCHEMA_SQL=`
create table if not exists lba_public_address_capture (
 id uuid primary key,operation text not null check(operation in ('streets','houses','group')),
 request_url text not null check(length(request_url)<=2048),capture jsonb not null,
 observed_at timestamptz not null,control_epoch bigint not null
);
create table if not exists lba_public_address_query (
 request_key char(64) primary key,request_url text not null check(length(request_url)<=2048),
 last_attempt_at timestamptz not null,last_failure text,
 latest_capture_id uuid references lba_public_address_capture(id)
);
create table if not exists lba_public_address_candidate (
 address_id text primary key,streets_id uuid not null references lba_public_address_capture(id),
 houses_id uuid not null references lba_public_address_capture(id),group_id uuid not null references lba_public_address_capture(id)
);
create index if not exists lba_public_address_capture_observed on lba_public_address_capture(observed_at);
`;
export const ADDRESS_CATALOG_POLICY=Object.freeze({revisionId:'yasno-25-902-address/2026-11-08/1',
 namespace:'yasno:25/902' as const,origin:'https://app.yasno.ua',
 reviewedAt:TECHNICAL_SOURCE_REVIEW.reviewedAt,validUntil:TECHNICAL_SOURCE_REVIEW.validUntil,
 cacheTtlMs:600000,maximumCaptureAgeMs:600000,maxQueries:2048,maxCaptures:4096,maxCandidates:512,
 accessCost:0,formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources',
 addressBindingVerified:false,deliveryEligible:false});
const PREFIX='https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/';
type Operation='streets'|'houses'|'group';
export type AddressCatalogCode=AddressHttpCode|'ADDRESS_SERVICE_DISABLED'|'ADDRESS_INVALID_REQUEST'|'ADDRESS_SCOPE_UNSUPPORTED'|
 'ADDRESS_CONTROL_REJECTED'|'ADDRESS_EPOCH_CONFLICT'|'ADDRESS_STORAGE_UNAVAILABLE'|'ADDRESS_CLOCK_INVALID'|
 'ADDRESS_ADMISSION_EXPIRED'|'ADDRESS_WORKER_BUSY'|'ADDRESS_WORKER_HELD'|'ADDRESS_ORIGIN_HELD'|'ADDRESS_BUDGET_DEFERRED'|
 'ADDRESS_SNAPSHOT_NOT_FOUND'|'ADDRESS_STALE_SNAPSHOT'|'ADDRESS_SELECTION_REJECTED'|'ADDRESS_SCHEMA_REJECTED'|
 'ADDRESS_CACHE_CAPACITY'|'ADDRESS_PUBLICATION_UNKNOWN';
export interface AddressCatalogSnapshot {
 id:string;revisionId:string;operation:'streets'|'houses';namespace:'yasno:25/902';observedAt:string;expiresAt:string;
 items:ProviderAddressItem[];proof:AddressCaptureProof;streetId?:number;catalogCompleteness:'unknown';
}
type Rejected={state:'disabled'|'unsupported'|'deferred'|'unavailable'|'stale';code:AddressCatalogCode;retryAt?:string};
export type AddressSearchResult={state:'available';cache:'hit'|'miss';snapshot:AddressCatalogSnapshot}|Rejected;
export type AddressCandidateResult={state:'available';cache:'hit'|'miss';snapshotId:string;option:AddressOption;
 candidateProof:YasnoAddressCandidate['proof'];observedAt:string;expiresAt:string}|Rejected;
export interface AddressCandidatesSnapshot {
 state:'available'|'disabled'|'unavailable';code?:AddressCatalogCode;options:AddressOption[];
 observations:Array<{addressId:string;observedAt?:string;expiresAt?:string;state:'current'|'stale'}>;
 operatorNotices?:Array<{addressId:string;notice:OdesaOperatorHouseNotice}>;
 providerStates?:Array<{namespace:string;state:string;code?:string}>;
 addressBindingVerified:false;deliveryEligible:false;
}
type CaptureRow={id:string;operation:Operation;requestUrl:string;capture:YasnoAddressCapture};
class Failure extends Error {
 readonly code:AddressCatalogCode;readonly retryAt?:string;
 constructor(code:AddressCatalogCode,retryAt?:string){super(code);this.code=code;this.retryAt=retryAt;}
}
function fail(code:AddressCatalogCode,retryAt?:string):never{throw new Failure(code,retryAt);}
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
function closed(v:unknown,keys:string[]):asserts v is Record<string,unknown>{
 if(!plain(v)||Object.keys(v).some(k=>!keys.includes(k))||Object.values(Object.getOwnPropertyDescriptors(v)).some(d=>!('value'in d)))fail('ADDRESS_INVALID_REQUEST');
}
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function query(v:unknown,minimum=1):string{
 if(typeof v!=='string'||v.length>100||/[\u0000-\u001f\u007f]/.test(v))return fail('ADDRESS_INVALID_REQUEST');
 const value=v.normalize('NFC').trim();if(value.length<minimum)return fail('ADDRESS_INVALID_REQUEST');return value;
}
const instant=(v:unknown):number=>{const n=v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;if(!Number.isFinite(n))return fail('ADDRESS_STORAGE_UNAVAILABLE');return n;};
const reject=(e:unknown):Rejected=>{const code=e instanceof Failure?e.code:'ADDRESS_STORAGE_UNAVAILABLE';return {
 state:code==='ADDRESS_SERVICE_DISABLED'?'disabled':code==='ADDRESS_SCOPE_UNSUPPORTED'?'unsupported':code==='ADDRESS_STALE_SNAPSHOT'?'stale':
 ['ADDRESS_WORKER_BUSY','ADDRESS_WORKER_HELD','ADDRESS_ORIGIN_HELD','ADDRESS_BUDGET_DEFERRED','ADDRESS_RATE_LIMITED'].includes(code)?'deferred':'unavailable',code,
 ...(e instanceof Failure&&e.retryAt?{retryAt:e.retryAt}:{})};};
const endpoint=(operation:Operation,values:Record<string,string|number>)=>{
 const u=new URL(PREFIX+operation);u.searchParams.set('regionId','25');u.searchParams.set('dsoId','902');
 for(const[k,v]of Object.entries(values))u.searchParams.set(k,String(v));return u.href;
};

/** One App/Bot public catalog. No fetch defaults, account/owner input, automatic
 * activation, background loop, private identity lookup or profile writes.
 * Search/resolve may GET; readSnapshot/readCandidates are strictly PG-only.
 */
export function createAddressCatalog(input:{enabled?:boolean;expectedControlEpoch:number;pool:LegacyProfileReadPool;
 transport:SourceHttpTransport;now:()=>number;timeoutMs?:number}){
 if(!input||!input.pool||typeof input.pool.connect!=='function'||typeof input.transport!=='function'||typeof input.now!=='function'||
  !Number.isSafeInteger(input.expectedControlEpoch)||input.expectedControlEpoch<1||input.enabled!==undefined&&typeof input.enabled!=='boolean'||
  input.timeoutMs!==undefined&&(!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1||input.timeoutMs>30000))throw Error('INVALID_ADDRESS_CATALOG_OPTIONS');
 const options={...input},timeoutMs=input.timeoutMs??8000;let lastClock=-Infinity;
 const reservations=createPublicSourceReservationGuard({pool:input.pool,expectedControlEpoch:input.expectedControlEpoch});
 function clock(){const t=options.now();if(!Number.isSafeInteger(t)||t<0||t>8640000000000000||t<lastClock)return fail('ADDRESS_CLOCK_INVALID');lastClock=t;return t;}
 function admission(time:number){if(time<Date.parse(ADDRESS_CATALOG_POLICY.reviewedAt)||time>=Date.parse(ADDRESS_CATALOG_POLICY.validUntil))fail('ADDRESS_ADMISSION_EXPIRED');}
 function enabled(){if(options.enabled!==true)fail('ADDRESS_SERVICE_DISABLED');admission(clock());}
 async function control(c:LegacyProfileReadQuery,lock=false){
  const rows=(await c.query('select control_epoch,writer_mode from lba_production_control where id=true'+(lock?' for share':''))).rows;
  if(rows.length!==1||rows[0].writer_mode!=='canonical')return fail('ADDRESS_CONTROL_REJECTED');
  const n=rows[0].control_epoch;
  if(!(typeof n==='number'&&Number.isSafeInteger(n)||typeof n==='string'&&/^[1-9]\d{0,15}$/.test(n))||Number(n)!==options.expectedControlEpoch)fail('ADDRESS_EPOCH_CONFLICT');
 }
 function policy(){const time=clock();admission(time);return {asOf:new Date(time).toISOString(),maximumCaptureAgeMs:ADDRESS_CATALOG_POLICY.maximumCaptureAgeMs};}
 function row(value:Record<string,unknown>):CaptureRow{
  if(!uuid(value.id)||!['streets','houses','group'].includes(String(value.operation))||typeof value.request_url!=='string'||!plain(value.capture))return fail('ADDRESS_SCHEMA_REJECTED');
  const capture=value.capture;
  if(Object.keys(capture).sort().join(',')!=='contentType,httpStatus,method,observedAt,rawBody,rawSha256,sourceId,url'||capture.url!==value.request_url||
    capture.sourceId!=='yasno-public-address-v2'||capture.method!=='GET'||capture.httpStatus!==200||typeof capture.contentType!=='string'||
    typeof capture.observedAt!=='string'||typeof capture.rawBody!=='string'||typeof capture.rawSha256!=='string')return fail('ADDRESS_SCHEMA_REJECTED');
  return {id:value.id,operation:value.operation as Operation,requestUrl:value.request_url,capture:capture as unknown as YasnoAddressCapture};
 }
 async function select(c:LegacyProfileReadQuery,ref:string):Promise<CaptureRow>{
  const rows=(await c.query('select id,operation,request_url,capture from lba_public_address_capture where id=$1',[ref])).rows;
  if(rows.length!==1)return fail('ADDRESS_SNAPSHOT_NOT_FOUND');return row(rows[0]);
 }
 function current(capture:YasnoAddressCapture){
  const t=clock(),observed=instant(capture.observedAt);admission(t);
  if(observed>t)return fail('ADDRESS_SCHEMA_REJECTED');
  if(t-observed>=ADDRESS_CATALOG_POLICY.cacheTtlMs||localParts(t).date!==localParts(observed).date)fail('ADDRESS_STALE_SNAPSHOT');
 }
 function searchSnapshot(value:CaptureRow):AddressCatalogSnapshot{
  current(value.capture);const p=policy();
  try{
   const parsed=value.operation==='streets'?readYasnoStreetCandidates(value.capture,p):value.operation==='houses'
    ?readYasnoHouseCandidates(value.capture,Number(new URL(value.requestUrl).searchParams.get('streetId')),p):fail('ADDRESS_SELECTION_REJECTED');
   return {id:value.id,revisionId:sha(parsed.proof.canonicalRequestUrl+'\n'+parsed.proof.rawSha256),operation:value.operation as 'streets'|'houses',
    namespace:'yasno:25/902',observedAt:parsed.proof.observedAt,expiresAt:new Date(Date.parse(parsed.proof.observedAt)+ADDRESS_CATALOG_POLICY.cacheTtlMs).toISOString(),
    items:parsed.items,proof:parsed.proof,...('streetId'in parsed&&typeof parsed.streetId==='number'?{streetId:parsed.streetId}:{}),catalogCompleteness:'unknown'};
  }catch(e){if(e instanceof Failure)throw e;return fail('ADDRESS_SCHEMA_REJECTED');}
 }
 function candidate(streets:CaptureRow,houses:CaptureRow,group:CaptureRow,streetId:number,houseId:number){
  for(const capture of [streets,houses,group])current(capture.capture);
  const s=searchSnapshot(streets),h=searchSnapshot(houses);
  const street=s.items.find(v=>v.id===streetId),house=h.items.find(v=>v.id===houseId);
  if(s.operation!=='streets'||h.operation!=='houses'||group.operation!=='group'||h.streetId!==streetId||!street||!house)fail('ADDRESS_SELECTION_REJECTED');
  try{return buildYasnoAddressCandidate({scope:YASNO_KYIV_ADDRESS_SCOPE,
   selection:{streetId,streetValue:street!.value,houseId,houseLiteral:house!.value},captures:{streets:streets.capture,houses:houses.capture,group:group.capture},policy:policy()});
  }catch{return fail('ADDRESS_SELECTION_REJECTED');}
 }
 const asOption=(value:YasnoAddressCandidate):AddressOption=>({id:value.address.id,address:structuredClone(value.address),binding:structuredClone(value.binding),territoryLabel:'Київ · ДТЕК Київські електромережі'});
 async function read<T>(work:(c:LegacyProfileReadClient)=>Promise<T>):Promise<T>{
  enabled();const c=await options.pool.connect();let tx=false;
  try{await c.query('begin isolation level repeatable read read only');tx=true;await control(c);const result=await work(c);admission(clock());await c.query('commit');tx=false;return result;}
  finally{if(tx)await c.query('rollback').catch(()=>{});c.release();}
 }
 function reservationFailure(result:SourceReservationFailure):never{
  const code:AddressCatalogCode=result.code==='RESERVATION_CONTROL_REJECTED'?'ADDRESS_CONTROL_REJECTED':
   result.code==='RESERVATION_EPOCH_CONFLICT'?'ADDRESS_EPOCH_CONFLICT':result.code==='RESERVATION_WORKER_HELD'?'ADDRESS_WORKER_HELD':
   result.code==='RESERVATION_ORIGIN_HELD'?'ADDRESS_ORIGIN_HELD':result.code==='RESERVATION_LOCAL_BUDGET_DEFERRED'?'ADDRESS_BUDGET_DEFERRED':
   ['RESERVATION_COMMIT_UNKNOWN','RESERVATION_TOKEN_CONFLICT','RESERVATION_CLOSED','RESERVATION_DEADLINE','RESERVATION_ABORTED'].includes(result.code)?'ADDRESS_PUBLICATION_UNKNOWN':'ADDRESS_STORAGE_UNAVAILABLE';
  return fail(code,result.retryAt);
 }
 async function getCapture(operation:Operation,url:string,validate:(r:CaptureRow)=>unknown,minimumObserved=0):Promise<{capture:CaptureRow;cache:'hit'|'miss'}>{
  enabled();const key=legacyYasnoAddressRequestKey(url);
  async function cached(c:LegacyProfileReadQuery):Promise<CaptureRow|undefined>{
   const saved=(await c.query(`select q.last_attempt_at,q.last_failure,c.id,c.operation,c.request_url,c.capture
    from lba_public_address_query q left join lba_public_address_capture c on c.id=q.latest_capture_id where q.request_key=$1`,[key])).rows;
   if(saved.length>1)fail('ADDRESS_STORAGE_UNAVAILABLE');
   if(!saved[0]?.id)return;
   const value=row(saved[0]);
   const failedAfter=saved[0].last_failure!==null&&instant(saved[0].last_attempt_at)>=instant(value.capture.observedAt);
   try{if(!failedAfter&&instant(value.capture.observedAt)>=minimumObserved){current(value.capture);validate(value);return value;}}
   catch(e){if(!(e instanceof Failure)||e.code!=='ADDRESS_STALE_SNAPSHOT')throw e;}
  }
  // Cache reads borrow no worker token, so fresh public facts remain usable while
  // another origin is acquiring data. The reservation callback rechecks a miss.
  const hit=await read(c=>cached(c));if(hit)return {capture:hit,cache:'hit'};
  let racedHit:CaptureRow|undefined,reserveFailure:Failure|undefined;
  const abort=new AbortController();
  const reserved=await reservations.reserve({origin:ADDRESS_CATALOG_POLICY.origin,expectedMaxHops:1,
   minIntervalMs:YASNO_SHARED_ORIGIN_BUDGET_MS,deadlineMs:30000,signal:abort.signal,
   persist:async(c,receipt)=>{
    try{
     enabled();racedHit=await cached(c);if(racedHit)throw new Failure('ADDRESS_SELECTION_REJECTED');
     const count=(await c.query('select (select count(*)::int from lba_public_address_query) as queries,(select count(*)::int from lba_public_address_capture) as captures')).rows[0];
     if(!count||!Number.isSafeInteger(count.queries)||!Number.isSafeInteger(count.captures))fail('ADDRESS_STORAGE_UNAVAILABLE');
     const exists=(await c.query('select request_key from lba_public_address_query where request_key=$1',[key])).rows;
     if((!exists.length&&count.queries>=ADDRESS_CATALOG_POLICY.maxQueries)||count.captures>=ADDRESS_CATALOG_POLICY.maxCaptures)fail('ADDRESS_CACHE_CAPACITY');
     await c.query(`insert into lba_public_address_query(request_key,request_url,last_attempt_at,last_failure) values($1,$2,$3,null)
      on conflict(request_key) do update set last_attempt_at=excluded.last_attempt_at`,[key,url,receipt.reservedAt]);
    }catch(e){if(e instanceof Failure)reserveFailure=e;throw e;}
   }});
  if(reserved.state!=='reserved'){
   if(racedHit&&reserved.code==='RESERVATION_CALLBACK_FAILED')return {capture:racedHit,cache:'hit'};
   if(reserveFailure)throw reserveFailure;return reservationFailure(reserved);
  }
  const grant=await reserved.reservation.beforeHop({origin:ADDRESS_CATALOG_POLICY.origin},abort.signal);
  if(grant.state!=='granted')return reservationFailure(grant);
  // Every HTTP follows a confirmed durable grant. No borrowed PG connection,
  // advisory/session lock or owner transaction survives across this operation.
  const outcome:AddressHttpResult=await collectAddressCapture({url,transport:options.transport,now:clock,timeoutMs});
  let captured:CaptureRow|undefined,semanticFailure:AddressCatalogCode|undefined;
  if(outcome.ok){
   captured={id:reserved.reservation.receipt.reservationToken,operation,requestUrl:url,capture:outcome.capture};
   try{current(captured.capture);if(instant(captured.capture.observedAt)<minimumObserved)fail('ADDRESS_SELECTION_REJECTED');validate(captured);}
   catch(e){semanticFailure=e instanceof Failure&&e.code==='ADDRESS_ADMISSION_EXPIRED'?'ADDRESS_ADMISSION_EXPIRED':'ADDRESS_SCHEMA_REJECTED';captured=undefined;}
  }
  const finished=await reserved.reservation.finalize({
   ...(!outcome.ok&&outcome.hold?{hold:outcome.workerHold?'worker-and-origin' as const:'origin' as const}:{}),
   ...(!outcome.ok&&outcome.retryAfterMs!==undefined?{retryAfterMs:outcome.retryAfterMs}:{}),
   persist:async c=>{
    if(captured){
     await c.query('insert into lba_public_address_capture(id,operation,request_url,capture,observed_at,control_epoch) values($1,$2,$3,$4::jsonb,$5,$6)',
      [captured.id,operation,url,JSON.stringify(captured.capture),captured.capture.observedAt,options.expectedControlEpoch]);
     await c.query('update lba_public_address_query set latest_capture_id=$2,last_failure=null where request_key=$1',[key,captured.id]);
    }else await c.query('update lba_public_address_query set last_failure=$2 where request_key=$1',[key,semanticFailure??(outcome.ok?'ADDRESS_SCHEMA_REJECTED':outcome.code)]);
   }});
  // On unknown COMMIT, do not retry publication or clear a possibly newer token.
  // A real capture's UUID is the exact reservation business receipt for read-only reconciliation.
  if(finished.state!=='finalized')return reservationFailure(finished);
  if(!captured)return fail(semanticFailure??(outcome.ok?'ADDRESS_SCHEMA_REJECTED':outcome.code));
  return {capture:captured,cache:'miss'};
 }
 async function searchStreets(value:unknown):Promise<AddressSearchResult>{
  try{enabled();closed(value,['namespace','query']);if(value.namespace!=='yasno:25/902')fail('ADDRESS_SCOPE_UNSUPPORTED');const q=query(value.query,2);
   const result=await getCapture('streets',endpoint('streets',{query:q}),searchSnapshot);return {state:'available',cache:result.cache,snapshot:searchSnapshot(result.capture)};
  }catch(e){return reject(e);}
 }
 async function searchHouses(value:unknown):Promise<AddressSearchResult>{
  try{enabled();closed(value,['streetSnapshotId','streetId','query']);if(!uuid(value.streetSnapshotId)||!id(value.streetId))fail('ADDRESS_INVALID_REQUEST');
   const q=query(value.query),streetId=value.streetId,streets=await read(c=>select(c,value.streetSnapshotId as string)),s=searchSnapshot(streets);
   if(s.operation!=='streets'||!s.items.some(v=>v.id===streetId))fail('ADDRESS_SELECTION_REJECTED');
   const result=await getCapture('houses',endpoint('houses',{streetId,query:q}),searchSnapshot,instant(streets.capture.observedAt));
   return {state:'available',cache:result.cache,snapshot:searchSnapshot(result.capture)};
  }catch(e){return reject(e);}
 }
 async function resolveCandidate(value:unknown):Promise<AddressCandidateResult>{
  try{enabled();closed(value,['streetSnapshotId','houseSnapshotId','streetId','houseId']);
   if(!uuid(value.streetSnapshotId)||!uuid(value.houseSnapshotId)||!id(value.streetId)||!id(value.houseId))fail('ADDRESS_INVALID_REQUEST');
   const streetId=value.streetId,houseId=value.houseId;
   const [streets,houses]=await read(async c=>[await select(c,value.streetSnapshotId as string),await select(c,value.houseSnapshotId as string)]);
   const s=searchSnapshot(streets),h=searchSnapshot(houses);
   if(s.operation!=='streets'||h.operation!=='houses'||h.streetId!==streetId||!s.items.some(v=>v.id===streetId)||!h.items.some(v=>v.id===houseId))fail('ADDRESS_SELECTION_REJECTED');
   const result=await getCapture('group',endpoint('group',{streetId,houseId}),r=>candidate(streets,houses,r,streetId,houseId),instant(houses.capture.observedAt));
   const built=candidate(streets,houses,result.capture,streetId,houseId);
   // No owner locks exist here. Publication remains a public-only local write.
   const c=await options.pool.connect();let tx=false,discard=false;
   try{await c.query('begin isolation level read committed');tx=true;await control(c,true);
    await c.query("select pg_advisory_xact_lock(hashtextextended('lba-public-address-candidates',0))");
    candidate(streets,houses,result.capture,streetId,houseId);
    const count=(await c.query('select count(*)::int n from lba_public_address_candidate')).rows[0];
    const exists=(await c.query('select address_id from lba_public_address_candidate where address_id=$1',[built.address.id])).rows;
    if(!count||!Number.isSafeInteger(count.n)||Number(count.n)>=ADDRESS_CATALOG_POLICY.maxCandidates&&!exists.length)fail('ADDRESS_CACHE_CAPACITY');
    const published=await c.query(`insert into lba_public_address_candidate(address_id,streets_id,houses_id,group_id) values($1,$2,$3,$4)
     on conflict(address_id) do update set streets_id=excluded.streets_id,houses_id=excluded.houses_id,group_id=excluded.group_id
     where (select observed_at from lba_public_address_capture where id=excluded.group_id)>=
      (select observed_at from lba_public_address_capture where id=lba_public_address_candidate.group_id) returning address_id`,[built.address.id,streets.id,houses.id,result.capture.id]);
    if(published.rows.length!==1)fail('ADDRESS_SELECTION_REJECTED');
    try{const committed=await c.query('commit');tx=false;
     if(!('command'in committed)||committed.command!=='COMMIT'){discard=true;return fail('ADDRESS_PUBLICATION_UNKNOWN');}
    }catch{discard=true;return fail('ADDRESS_PUBLICATION_UNKNOWN');}
   }finally{if(tx)await c.query('rollback').catch(()=>{});c.release(discard);}
   return {state:'available',cache:result.cache,snapshotId:result.capture.id,option:asOption(built),candidateProof:built.proof,
    observedAt:built.proof.observedAt,expiresAt:new Date(Math.min(...built.proof.captures.map(v=>Date.parse(v.observedAt)))+ADDRESS_CATALOG_POLICY.cacheTtlMs).toISOString()};
  }catch(e){return reject(e);}
 }
 async function readSnapshot(ref:unknown):Promise<AddressSearchResult>{
  try{enabled();if(!uuid(ref))fail('ADDRESS_INVALID_REQUEST');return await read(async c=>({state:'available',cache:'hit',snapshot:searchSnapshot(await select(c,ref))}));}
  catch(e){return reject(e);}
 }
 async function readCandidates():Promise<AddressCandidatesSnapshot>{
  const empty={options:[] as AddressOption[],observations:[] as AddressCandidatesSnapshot['observations'],addressBindingVerified:false as const,deliveryEligible:false as const};
  try{return await read(async c=>{
   // Provider readers share this table. Decode only the explicit legacy format;
   // the combined catalog independently reads the Odesa envelopes.
   const rows=(await c.query(`select p.address_id,p.streets_id,p.houses_id,p.group_id from lba_public_address_candidate p
    join lba_public_address_capture c on c.id=p.streets_id where c.capture->>'sourceId'='yasno-public-address-v2' order by p.address_id limit 513`)).rows;
   if(rows.length>ADDRESS_CATALOG_POLICY.maxCandidates)fail('ADDRESS_CACHE_CAPACITY');
   const options:AddressOption[]=[],observations:AddressCandidatesSnapshot['observations']=[];
   for(const r of rows){
    if(typeof r.address_id!=='string'||!uuid(r.streets_id)||!uuid(r.houses_id)||!uuid(r.group_id))fail('ADDRESS_SCHEMA_REJECTED');
    const streets=await select(c,r.streets_id),houses=await select(c,r.houses_id),group=await select(c,r.group_id);
    const url=new URL(group.requestUrl),streetId=Number(url.searchParams.get('streetId')),houseId=Number(url.searchParams.get('houseId'));
    try{
     for(const ref of [streets,houses,group]){
      const pointer=(await c.query('select latest_capture_id,last_attempt_at,last_failure from lba_public_address_query where request_key=$1 and request_url=$2',
       [legacyYasnoAddressRequestKey(ref.requestUrl),ref.requestUrl])).rows;
      if(pointer.length!==1||pointer[0].latest_capture_id!==ref.id||pointer[0].last_failure!==null&&instant(pointer[0].last_attempt_at)>=instant(ref.capture.observedAt))fail('ADDRESS_STALE_SNAPSHOT');
     }
     const built=candidate(streets,houses,group,streetId,houseId);if(built.address.id!==r.address_id)fail('ADDRESS_SCHEMA_REJECTED');
     options.push(asOption(built));observations.push({addressId:built.address.id,observedAt:built.proof.observedAt,
      expiresAt:new Date(Math.min(...built.proof.captures.map(v=>Date.parse(v.observedAt)))+ADDRESS_CATALOG_POLICY.cacheTtlMs).toISOString(),state:'current'});
    }catch(e){if(!(e instanceof Failure)||e.code!=='ADDRESS_STALE_SNAPSHOT')throw e;
     observations.push({addressId:r.address_id,observedAt:group.capture.observedAt,
      expiresAt:new Date(Math.min(...[streets,houses,group].map(v=>instant(v.capture.observedAt)))+ADDRESS_CATALOG_POLICY.cacheTtlMs).toISOString(),state:'stale'});
    }
   }
   return {state:'available',...empty,options,observations};
  });}catch(e){const rejected=reject(e);return {state:rejected.state==='disabled'?'disabled':'unavailable',code:rejected.code,...empty};}
 }
 return Object.freeze({searchStreets,searchHouses,resolveCandidate,readSnapshot,readCandidates});
}
