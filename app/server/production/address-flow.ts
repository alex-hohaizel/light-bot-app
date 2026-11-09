import {createHash} from 'node:crypto';
import type {Express,RequestHandler} from 'express';
import type {BotContext,BotState} from '../../shared/bot/types.ts';
import {normalizeAddressText,houseMatchesQuery} from '../../shared/address-index.ts';
import {dayBounds,localParts} from '../../shared/schedule-core.ts';
import type {createAddressCatalog,AddressSearchResult,AddressCandidateResult} from './address-catalog.ts';
import {ProductionProfileStoreError,type createProductionProfileStore} from './profile-store.ts';
import type {VerifiedLegacyPrincipal,LegacyProfileReadQuery,LegacyProfileReadPool} from './profile-reader.ts';

export const OWNED_ADDRESS_LOOKUP_SCHEMA_SQL=`
create table if not exists lba_production_address_lookup (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,
 operation_id varchar(96) not null,input_digest char(64) not null,generation bigint not null,
 state jsonb not null,updated_at timestamptz not null,primary key(owner_id,session_id)
);
create table if not exists lba_production_address_lookup_requests (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,
 operation_id varchar(96) not null,input_digest char(64) not null,result jsonb,recorded_at timestamptz not null,
 primary key(owner_id,session_id,operation_id)
);`;
const directory=Object.freeze({id:'yasno:25/902',namespace:'yasno:25/902',operatorId:'dtek-kem',locality:'Київ',localityId:'source:yasno:25/902:locality:kyiv',territoryId:'source:yasno:25/902',territoryLabel:'Київ · ДТЕК Київські електромережі'});
const obj=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,96}$/.test(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const fail=(code:string):never=>{throw new ProductionProfileStoreError(code);};
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
interface LookupRequest {id:string;expectedSessionId:string;expectedRevision:number;operation:'streets'|'houses'|'resolve';query?:string;streetSnapshotId?:string;streetId?:number;houseSnapshotId?:string;houseId?:number}
type OwnedState={directoryId:string;optionIds:string[];optionExpiries?:Record<string,string>;catalogStatus:'ready'|'loading'|'unavailable';streets?:any;houses?:any};
function parse(value:unknown):LookupRequest{
 if(!obj(value)||Object.keys(value).some(k=>!['id','expectedSessionId','expectedRevision','operation','query','streetSnapshotId','streetId','houseSnapshotId','houseId','directoryId'].includes(k))||
  !id(value.id)||typeof value.expectedSessionId!=='string'||value.expectedSessionId.length>128||!value.expectedSessionId||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||
  !['streets','houses','resolve'].includes(value.operation)||value.directoryId!==undefined&&value.directoryId!==directory.id)return fail('ADDRESS_FLOW_INVALID_INPUT');
 const base=['id','expectedSessionId','expectedRevision','operation','directoryId'];
 const extra=value.operation==='streets'?['query']:value.operation==='houses'?['query','streetSnapshotId','streetId']:['streetSnapshotId','streetId','houseSnapshotId','houseId'];
 if(Object.keys(value).some(k=>![...base,...extra].includes(k)))return fail('ADDRESS_FLOW_INVALID_INPUT');
 try{if(value.operation!=='resolve'&&(typeof value.query!=='string'||value.query.length>100||normalizeAddressText(value.query).length<(value.operation==='streets'?2:1)))return fail('ADDRESS_FLOW_INVALID_INPUT');}catch{return fail('ADDRESS_FLOW_INVALID_INPUT');}
 if(value.operation!=='streets'&&(!uuid(value.streetSnapshotId)||!integer(value.streetId)))return fail('ADDRESS_FLOW_INVALID_INPUT');
 if(value.operation==='resolve'&&(!uuid(value.houseSnapshotId)||!integer(value.houseId)))return fail('ADDRESS_FLOW_INVALID_INPUT');
 const {directoryId:_ignored,...request}=value;return request as LookupRequest;
}
const empty=():OwnedState=>({directoryId:directory.id,optionIds:[],catalogStatus:'ready'});
const copy=(v:OwnedState)=>structuredClone(v);
export function createProductAddressFlow(options:{enabled?:boolean;store:Pick<ReturnType<typeof createProductionProfileStore>,'withLockedProfile'>;
 pool:LegacyProfileReadPool;catalog:ReturnType<typeof createAddressCatalog>;now:()=>string;refreshPublicContext:()=>Promise<void>}){
 const memory=new Map<string,OwnedState>(),key=(owner:string,session:string)=>JSON.stringify([owner,session]);
 async function row(c:LegacyProfileReadQuery,owner:string,session:string){
  const rows=(await c.query('select operation_id as "operationId",input_digest as "inputDigest",generation,state from lba_production_address_lookup where owner_id=$1 and session_id=$2 for update',[owner,session])).rows;
  if(rows.length>1)return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');return rows[0];
 }
 async function refreshOwned(){
  if(options.enabled!==true)return;const c=await options.pool.connect();
  try{const rows=(await c.query('select q.owner_id,q.session_id,q.state from lba_production_address_lookup q join lba_production_profiles p on p.owner_id=q.owner_id and p.session_id=q.session_id limit 5001')).rows;
   if(rows.length>5000)return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');memory.clear();for(const r of rows)if(obj(r.state)&&Array.isArray(r.state.optionIds))memory.set(key(r.owner_id,r.session_id),copy(r.state as OwnedState));
  }finally{c.release();}
 }
 async function lookup(identity:VerifiedLegacyPrincipal,raw:unknown):Promise<any>{
  if(options.enabled!==true)return {state:'disabled',code:'ADDRESS_FLOW_DISABLED'};
  const request=parse(raw),digest=createHash('sha256').update(canonical(request)).digest('hex');
  const scope={sessionId:request.expectedSessionId,revision:request.expectedRevision};
  const reservation=await options.store.withLockedProfile(identity,scope,async({client,state,serverNow})=>{
   const old=await row(client,identity.ownerId,state.sessionId),saved:OwnedState=old?copy(old.state):empty();
   const previous=(await client.query('select input_digest as "inputDigest",result from lba_production_address_lookup_requests where owner_id=$1 and session_id=$2 and operation_id=$3',[identity.ownerId,state.sessionId,request.id])).rows;
   if(previous.length>1)return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');
   if(previous[0]&&previous[0].inputDigest!==digest)return fail('ADDRESS_FLOW_INPUT_ID_CONFLICT');
   if(previous[0]&&old?.operationId!==request.id)return fail('ADDRESS_FLOW_SELECTION_CHANGED');
   if(previous[0]?.result){
    const replay=previous[0].result;if(!obj(replay)||replay.state!=='available')return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');
    const expires=replay.snapshot?.expiresAt??replay.expiresAt;
    if(typeof expires!=='string'||!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=Date.parse(serverNow))return fail('ADDRESS_FLOW_SELECTION_CHANGED');
    return {generation:Number(old.generation),saved,replay};
   }
   if(old?.operationId===request.id&&old.inputDigest!==digest)return fail('ADDRESS_FLOW_INPUT_ID_CONFLICT');
   if(request.operation!=='streets'&&(saved.streets?.snapshotId!==request.streetSnapshotId||!saved.streets.items?.some((v:any)=>v.id===request.streetId)))return fail('ADDRESS_FLOW_SELECTION_CHANGED');
   if(request.operation==='resolve'&&(saved.houses?.houseSnapshotId!==request.houseSnapshotId||saved.houses.streetId!==request.streetId||!saved.houses.items?.some((v:any)=>v.id===request.houseId)))return fail('ADDRESS_FLOW_SELECTION_CHANGED');
   const generation=old?.operationId===request.id?Number(old.generation):Number(old?.generation??0)+1;
   if(!Number.isSafeInteger(generation)||generation<1)return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');
   if(!previous.length)await client.query('insert into lba_production_address_lookup_requests(owner_id,session_id,operation_id,input_digest,result,recorded_at) values($1,$2,$3,$4,null,$5)',[identity.ownerId,state.sessionId,request.id,digest,serverNow]);
   const next={...saved,catalogStatus:'loading' as const};
   await client.query(`insert into lba_production_address_lookup(owner_id,session_id,operation_id,input_digest,generation,state,updated_at) values($1,$2,$3,$4,$5,$6::jsonb,$7)
    on conflict(owner_id,session_id) do update set operation_id=excluded.operation_id,input_digest=excluded.input_digest,generation=excluded.generation,state=excluded.state,updated_at=excluded.updated_at`,[identity.ownerId,state.sessionId,request.id,digest,generation,JSON.stringify(next),serverNow]);
   return {generation,saved,replay:null};
  });
  if(reservation.replay)return structuredClone(reservation.replay);
  memory.set(key(identity.ownerId,request.expectedSessionId),{...reservation.saved,catalogStatus:'loading'});
  // The canonical owner transaction is closed before any bounded provider GET.
  let result:AddressSearchResult|AddressCandidateResult;
  if(request.operation==='streets')result=await options.catalog.searchStreets({namespace:directory.namespace,query:request.query});
  else if(request.operation==='houses')result=await options.catalog.searchHouses({streetSnapshotId:request.streetSnapshotId,streetId:request.streetId,query:request.query});
  else result=await options.catalog.resolveCandidate({streetSnapshotId:request.streetSnapshotId,streetId:request.streetId,houseSnapshotId:request.houseSnapshotId,houseId:request.houseId});
  // An otherwise fresh capture cannot carry a user's selection into another
  // Kyiv service day. Shortening the consumer TTL never extends provider proof.
  if(result.state==='available'){
   const end=dayBounds(localParts(Date.parse('snapshot'in result?result.snapshot.observedAt:result.observedAt)).date).end;
   if('snapshot'in result)result={...result,snapshot:{...result.snapshot,expiresAt:new Date(Math.min(Date.parse(result.snapshot.expiresAt),end)).toISOString()}};
   else result={...result,expiresAt:new Date(Math.min(Date.parse(result.expiresAt),end)).toISOString()};
  }
  const committed=await options.store.withLockedProfile(identity,scope,async({client,state,serverNow})=>{
   const current=await row(client,identity.ownerId,state.sessionId);
   if(!current||current.operationId!==request.id||current.inputDigest!==digest||Number(current.generation)!==reservation.generation)return fail('ADDRESS_FLOW_SELECTION_CHANGED');
   const saved:OwnedState=copy(current.state);saved.catalogStatus=result.state==='available'?'ready':'unavailable';
   if(request.operation==='streets'){
    const available=result.state==='available'&&'snapshot'in result?result.snapshot:undefined;
    saved.streets={directoryId:directory.id,state:result.state,query:request.query,...(available?{snapshotId:available.id,expiresAt:available.expiresAt,items:available.items}:{items:[],code:'code'in result?result.code:'ADDRESS_FLOW_UNAVAILABLE',...('retryAt'in result?{retryAt:result.retryAt}:{})})};delete saved.houses;
   }else if(request.operation==='houses'){
    const available=result.state==='available'&&'snapshot'in result?result.snapshot:undefined;
    saved.houses={directoryId:directory.id,state:result.state,query:request.query,streetId:request.streetId,streetValue:saved.streets.items.find((v:any)=>v.id===request.streetId).value,streetSnapshotId:request.streetSnapshotId,
     ...(available?{houseSnapshotId:available.id,expiresAt:available.expiresAt,items:available.items}:{items:[],code:'code'in result?result.code:'ADDRESS_FLOW_UNAVAILABLE',...('retryAt'in result?{retryAt:result.retryAt}:{})})};
   }else if(result.state==='available'&&'option'in result){
    saved.optionIds=[...new Set([...saved.optionIds,result.option.id])].slice(-20);
    const expiry=new Date(Math.min(Date.parse(saved.streets.expiresAt),Date.parse(saved.houses.expiresAt),Date.parse(result.expiresAt))).toISOString();
    saved.optionExpiries=Object.fromEntries(saved.optionIds.map(optionId=>[optionId,optionId===result.option.id?expiry:saved.optionExpiries?.[optionId]??'1970-01-01T00:00:00.000Z']));
    if(saved.houses){saved.houses.expiresAt=expiry;saved.houses.items=saved.houses.items.map((h:any)=>h.id===request.houseId?{...h,optionId:result.option.id}:h);}
   }
   await client.query('update lba_production_address_lookup set state=$3::jsonb,updated_at=$4 where owner_id=$1 and session_id=$2',[identity.ownerId,state.sessionId,JSON.stringify(saved),serverNow]);
   if(result.state==='available')await client.query('update lba_production_address_lookup_requests set result=$4::jsonb where owner_id=$1 and session_id=$2 and operation_id=$3',[identity.ownerId,state.sessionId,request.id,JSON.stringify(result)]);
   return copy(saved);
  });
  memory.set(key(identity.ownerId,request.expectedSessionId),committed);
  if(request.operation==='resolve'&&result.state==='available')await options.refreshPublicContext();return result;
 }
 function forProfile(owner:string,state:BotState,now:string):Partial<BotContext>{
  const saved=memory.get(key(owner,state.sessionId));if(options.enabled!==true)return {};
  const expires=(v:any)=>v&&v.state==='available'&&(!Number.isFinite(Date.parse(v.expiresAt))||Date.parse(v.expiresAt)<=Date.parse(now))?{...v,state:'stale',items:[]}:v;
  return {providerDirectory:[directory],...(saved?.streets?{providerStreets:expires(saved.streets)}:{}),...(saved?.houses?{providerHouses:expires(saved.houses)}:{}),
   addressCatalogStatus:saved?.catalogStatus??'ready'} as Partial<BotContext>;
 }
 return Object.freeze({lookup,refreshOwned,forProfile,ownedOptionIds:(owner:string,session:string)=>{const saved=memory.get(key(owner,session)),now=Date.parse(options.now());return new Set((saved?.optionIds??[]).filter(id=>Date.parse(saved?.optionExpiries?.[id]??'')>now));}});
}
export function registerProductAddressRoutes(app:Express,ports:{authenticate:RequestHandler;flow:ReturnType<typeof createProductAddressFlow>}){
 app.post('/api/product/address/lookup',ports.authenticate,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');const owner=(req.user as any)?.claims?.sub;
  if(typeof owner!=='string'||!owner||owner.length>255||/[\u0000-\u001f]/.test(owner))return void res.sendStatus(401);
  if(Object.keys(req.query).length)return void res.status(400).json({state:'unavailable',code:'ADDRESS_FLOW_INVALID_INPUT'});
  try{res.json(await ports.flow.lookup({kind:'verified_server_principal',ownerId:owner,verified:true},req.body));}
  catch(e){const code=e instanceof Error?e.message:'';const known=['ADDRESS_FLOW_INVALID_INPUT','ADDRESS_FLOW_SELECTION_CHANGED','ADDRESS_FLOW_INPUT_ID_CONFLICT','PRODUCTION_PROFILE_REVISION_CONFLICT'];
   res.status(code==='ADDRESS_FLOW_INVALID_INPUT'?400:known.includes(code)?409:503).json({state:'unavailable',code:known.includes(code)?code:'ADDRESS_FLOW_UNAVAILABLE'});}
 });
}
