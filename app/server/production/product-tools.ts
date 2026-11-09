import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {restoreBotState} from '../../shared/bot/engine.ts';
import type {BotContext,BotLocation,BotState} from '../../shared/bot/types.ts';
import {reviewShareScopeFingerprint,validReviewShareToken} from '../../shared/review-tools.ts';
import {planMatchesDisplay} from '../../shared/schedule-binding.ts';
import {localParts,nextCalendarDate,validInstant} from '../../shared/schedule-core.ts';
import {parseLiveToolsRequest,parseLiveToolReceipt,parseLivePublicShare,liveToolObject,liveToolText,type LiveToolsRequest,type LiveToolReceipt,type LiveToolsSnapshot,type LivePublicPlace,type LivePublicShare,type LiveShareSummary,type LiveToolsRecovery} from '../../shared/live-tools.ts';
import {ProductionProfileStoreError,type createProductionProfileStore} from './profile-store.ts';
import type {LegacyProfileReadQuery,LegacyProfileReadPool,VerifiedLegacyPrincipal} from './profile-reader.ts';

/** Explicit additive schema; never run at import/construction. No identity or legacy table is changed. */
export const PRODUCTION_TOOLS_SCHEMA_SQL=`
create table if not exists lba_production_tools_inbox (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),input_id varchar(102) not null,
 session_id varchar(128) not null,input_digest char(64) not null,receipt jsonb not null,recorded_at timestamptz not null,
 primary key(owner_id,input_id)
);
create table if not exists lba_production_tools_reports (
 id uuid primary key,owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,
 address_id varchar(255) not null,binding_fingerprint char(64) not null,label text not null,locality text not null,
 value text not null check(value in ('on','off')),recorded_at timestamptz not null
);
create index if not exists lba_production_tools_reports_owner_time on lba_production_tools_reports(owner_id,recorded_at,id);
create table if not exists lba_production_tools_shares (
 token char(48) primary key,owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,
 service_date date not null,created_at timestamptz not null,expires_at timestamptz not null,revoked_at timestamptz,
 private_scope jsonb not null,public_snapshot jsonb not null,check(expires_at>created_at)
);
create index if not exists lba_production_tools_shares_owner on lba_production_tools_shares(owner_id,created_at,token);
`;
type CanonicalStore=Pick<ReturnType<typeof createProductionProfileStore>,'withLockedProfile'>;
export type LiveToolsTransaction={client:LegacyProfileReadQuery;state:BotState;context:BotContext;serverNow:string};
export interface ProductionToolsOptions {store:CanonicalStore;pool:LegacyProfileReadPool;expectedControlEpoch:number;enabled?:boolean;now?:()=>string}
export class ProductionToolsError extends ProductionProfileStoreError {constructor(code:string){super(code);this.name='ProductionToolsError';}}
const fail=(code:string):never=>{throw new ProductionToolsError(code);};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const inputDigest=(r:LiveToolsRequest)=>hash(canonical(r));
const decoded=(v:unknown):unknown=>{if(typeof v!=='string')return v;try{return JSON.parse(v);}catch{return fail('LIVE_TOOLS_STORED_RESULT_INVALID');}};
function principal(p:VerifiedLegacyPrincipal):VerifiedLegacyPrincipal{
 if(!liveToolObject(p)||Object.keys(p).sort().join(',')!=='kind,ownerId,verified'||p.kind!=='verified_server_principal'||p.verified!==true||!liveToolText(p.ownerId))return fail('LIVE_TOOLS_AUTH_REQUIRED');
 return {kind:'verified_server_principal',ownerId:p.ownerId,verified:true};
}
function instant(v:unknown):string{if(v instanceof Date)v=v.toISOString();if(!validInstant(v))return fail('LIVE_TOOLS_STORED_RESULT_INVALID');return v;}
function text(v:unknown,max=4096,empty=false):string{if(!liveToolText(v,max,empty))return fail('LIVE_TOOLS_STORED_RESULT_INVALID');return v;}
function count(v:unknown):number{if(typeof v==='string'&&!/^\d+$/.test(v)||!['string','number'].includes(typeof v)||!Number.isSafeInteger(Number(v))||Number(v)<0)return fail('LIVE_TOOLS_STORED_RESULT_INVALID');return Number(v);}
/** Physical/source identity only; presentation/preferences do not silently broaden a grant. */
export function liveShareScopeFingerprint(location:BotLocation):string{
 const a=location.address;
 return hash(JSON.stringify([reviewShareScopeFingerprint(location),a.localityId??null,[...(a.localityAliases??[])].sort(),a.streetId??null,[...(a.placeNames??[])].sort(),a.objectKind??null]));
}
function scopes(value:unknown):Array<{addressId:string;fingerprint:string}>{
 const raw=decoded(value);if(!Array.isArray(raw)||!raw.length||raw.length>20)return fail('LIVE_TOOLS_STORED_RESULT_INVALID');
 const ids=new Set<string>();return raw.map(v=>{if(!liveToolObject(v)||Object.keys(v).sort().join(',')!=='addressId,fingerprint'||!liveToolText(v.addressId)||typeof v.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(v.fingerprint)||ids.has(v.addressId))return fail('LIVE_TOOLS_STORED_RESULT_INVALID');ids.add(v.addressId);return {addressId:v.addressId,fingerprint:v.fingerprint};});
}
function eligible(scope:unknown,state:BotState):boolean{
 return scopes(scope).every(s=>{const l=state.profile.locations.find(v=>v.address.id===s.addressId);return l&&liveShareScopeFingerprint(l)===s.fingerprint;});
}
/** Wire into canonical onProfileChange. Revocation is durable even across delete+readd. */
export async function invalidateProductionToolShares(input:{client:LegacyProfileReadQuery;before:BotState;after:BotState;serverNow:string}):Promise<void>{
 if(input.before.ownerId!==input.after.ownerId||!validInstant(input.serverNow))return fail('LIVE_TOOLS_INVALID_LIFECYCLE');
 const current=new Map(input.after.profile.locations.map(l=>[l.address.id,liveShareScopeFingerprint(l)]));
 const removed=input.before.profile.locations.filter(l=>current.get(l.address.id)!==liveShareScopeFingerprint(l)).map(l=>l.address.id);
 if(input.before.sessionId!==input.after.sessionId)await input.client.query('update lba_production_tools_shares set revoked_at=$2 where owner_id=$1 and revoked_at is null',[input.before.ownerId,input.serverNow]);
 else if(removed.length)await input.client.query('update lba_production_tools_shares s set revoked_at=$3 where owner_id=$1 and revoked_at is null and exists(select 1 from jsonb_array_elements(s.private_scope) x where x->>\'addressId\'=any($2::text[]))',[input.before.ownerId,removed,input.serverNow]);
}
function publicPlace(l:BotLocation,ctx:BotContext,date:string,now:string):LivePublicPlace{
 const label=text(l.address.label),localityLabel=text(l.address.locality,4096,true);
 const candidates=ctx.plans.filter(p=>p.synthetic===false&&p.serviceDate===date&&planMatchesDisplay(p,l.binding,now));
 // Never choose the first of contradictory plans.
 const unique=new Map(candidates.map(p=>[canonical(p),p]));const p=unique.size===1?[...unique.values()][0]:undefined;
 if(p&&!liveToolText(p.source.name,4096))return fail('LIVE_TOOLS_STORED_RESULT_INVALID');
 return {label,localityLabel,scope:l.binding.kind==='user_selected_group'||l.binding.kind==='operator_group'&&l.binding.status==='needs_confirmation'?'technical_group':'address',serviceDate:date,timezone:'Europe/Kyiv',
  status:unique.size>1?'conflict':p?p.status:l.binding.status==='verified'?'not_published':'needs_confirmation',dayCoverage:p?p.dayCoverage:'none',freshness:p?p.freshness:'unknown',
  intervals:p?p.intervals.map(i=>({startsAt:i.startsAt,endsAt:i.endsAt,startLocal:i.startLocal,endLocal:i.endLocal,kind:i.kind})):[],
  sourceName:p?p.source.name:unique.size>1?'Джерела містять різні плани':l.binding.status==='verified'?'План на цю дату ще не опублікований':'Прив’язку адреси потрібно підтвердити',observedAt:p?p.observedAt:null};
}
const SELECT_RECEIPT='select session_id as "sessionId",input_digest as "inputDigest",receipt from lba_production_tools_inbox where owner_id=$1 and input_id=$2';
function checkedReceipt(row:any,request:LiveToolsRequest):LiveToolReceipt{
 if(!row||row.sessionId!==request.expectedSessionId||row.inputDigest!==inputDigest(request))return fail('LIVE_TOOLS_INPUT_ID_CONFLICT');
 let receipt:LiveToolReceipt;try{receipt=parseLiveToolReceipt(decoded(row.receipt));}catch{return fail('LIVE_TOOLS_STORED_RESULT_INVALID');}
 if(receipt.id!==request.id||receipt.sessionId!==request.expectedSessionId||receipt.profileRevision!==request.expectedRevision||receipt.kind!==request.action.kind)return fail('LIVE_TOOLS_STORED_RESULT_INVALID');
 return receipt;
}
export function createProductionTools(options:ProductionToolsOptions){
 if(!options||typeof options.store?.withLockedProfile!=='function'||typeof options.pool?.connect!=='function'||!Number.isSafeInteger(options.expectedControlEpoch)||options.expectedControlEpoch<1||options.enabled!==undefined&&typeof options.enabled!=='boolean'||options.now!==undefined&&typeof options.now!=='function')return fail('LIVE_TOOLS_INVALID_OPTIONS');
 const enabled=options.enabled===true,epoch=options.expectedControlEpoch;
 const clock=()=>{const now=(options.now??(()=>new Date().toISOString()))();if(!validInstant(now))return fail('LIVE_TOOLS_CLOCK_INVALID');return now;};
 const requireEnabled=()=>{if(!enabled)return fail('LIVE_TOOLS_DISABLED');};
 async function readSnapshot({client,state,serverNow}:LiveToolsTransaction):Promise<LiveToolsSnapshot>{
  const owner=state.ownerId;
  const reports=await client.query('select id,address_id as "addressId",binding_fingerprint as fingerprint,label,locality,value,recorded_at as "recordedAt",session_id as "sessionId" from lba_production_tools_reports where owner_id=$1 order by recorded_at desc,id desc limit 200',[owner]);
  const shown=reports.rows.map(r=>{if(!['on','off'].includes(r.value))return fail('LIVE_TOOLS_STORED_RESULT_INVALID');const id=text(r.addressId,255),location=state.profile.locations.find(l=>l.address.id===id);return {id:text(r.id,128),addressId:id,label:text(r.label),locality:text(r.locality,4096,true),value:r.value as 'on'|'off',recordedAt:instant(r.recordedAt),archived:r.sessionId!==state.sessionId||!location||liveShareScopeFingerprint(location)!==r.fingerprint};});
  const throughDate=localParts(Date.parse(serverNow)).date,fromDate=new Date(Date.parse(throughDate+'T12:00:00Z')-6*86400000).toISOString().slice(0,10);
  const totals=await client.query(`select count(*)::text as total,count(*) filter(where value='on')::text as "onCount",count(*) filter(where value='off')::text as "offCount",count(distinct (recorded_at at time zone 'Europe/Kyiv')::date)::text as days from lba_production_tools_reports where owner_id=$1 and (recorded_at at time zone 'Europe/Kyiv')::date between $2::date and $3::date`,[owner,fromDate,throughDate]);
  if(totals.rows.length!==1)return fail('LIVE_TOOLS_STORED_RESULT_INVALID');const total=totals.rows[0];
  const tables=await client.query("select to_regclass('public.linked_accounts') is not null as links,to_regclass('public.users') is not null as users,to_regclass('public.power_reports') is not null as reports,to_regclass('public.weekly_digests') is not null as digests");
  if(tables.rows.length!==1)return fail('LIVE_TOOLS_STORED_RESULT_INVALID');const exists=tables.rows[0];
  for(const key of ['links','users','reports','digests'])if(typeof exists[key]!=='boolean')return fail('LIVE_TOOLS_STORED_RESULT_INVALID');
  let accounts:LiveToolsSnapshot['accounts']=[],legacyReports:LiveToolsSnapshot['legacyReports']=[],legacyDigestCount:number|null=null;
  if(exists.links&&exists.users){
   const linked=await client.query('select l.provider,l.created_at::text as "createdAt" from linked_accounts l join users u on u.id=l.user_id where l.user_id=$1 order by l.provider,l.id limit 101',[owner]);
   if(linked.rows.length>100)return fail('LIVE_TOOLS_ROW_LIMIT');
   accounts=linked.rows.map(r=>{const provider=text(r.provider,20);return {provider,label:provider==='telegram'?'Telegram':provider==='replit'?'Replit':provider,linkedAtLiteral:r.createdAt===null?null:text(r.createdAt,128)};});
  }
  if(exists.reports){
   // Null-user observations are attributed only through a CURRENT globally unique explicit Telegram link.
   const linkedClause=exists.links&&exists.users?` or (r.user_id is null and exists(select 1 from linked_accounts l join users u on u.id=l.user_id where l.user_id=$1 and l.provider='telegram' and l.provider_id=r.chat_id and (select count(*) from linked_accounts x where x.provider='telegram' and x.provider_id=l.provider_id)=1))`:'';
   const rows=await client.query(`select r.id::text as id,r.city,r.queue_id as "queueId",r.has_power as "hasPower",r.reported_at::text as "reportedAt" from power_reports r where r.user_id=$1${linkedClause} order by r.reported_at desc,r.id desc limit 200`,[owner]);
   legacyReports=rows.rows.map(r=>{if(typeof r.hasPower!=='boolean')return fail('LIVE_TOOLS_STORED_RESULT_INVALID');return {id:text(r.id,128),locality:text(r.city,4096,true),group:text(r.queueId,128,true),value:r.hasPower?'on':'off',reportedAtLiteral:text(r.reportedAt,128),timeZone:'unverified',origin:'legacy'};});
  }
  if(exists.digests){const q=await client.query('select count(*)::text n from weekly_digests where user_id=$1',[owner]);if(q.rows.length!==1)return fail('LIVE_TOOLS_STORED_RESULT_INVALID');legacyDigestCount=count(q.rows[0].n);}
  const shared=await client.query('select token,session_id as "sessionId",created_at as "createdAt",expires_at as "expiresAt",revoked_at as "revokedAt",private_scope as scope,public_snapshot as snapshot from lba_production_tools_shares where owner_id=$1 order by created_at desc,token limit 100',[owner]);
  const shares:LiveShareSummary[]=shared.rows.map(r=>{
   if(!validReviewShareToken(r.token))return fail('LIVE_TOOLS_STORED_RESULT_INVALID');let pub:LivePublicShare;try{pub=parseLivePublicShare(decoded(r.snapshot));}catch{return fail('LIVE_TOOLS_STORED_RESULT_INVALID');}
   const createdAt=instant(r.createdAt),expiresAt=instant(r.expiresAt);if(Date.parse(pub.createdAt)!==Date.parse(createdAt)||Date.parse(pub.expiresAt)!==Date.parse(expiresAt))return fail('LIVE_TOOLS_STORED_RESULT_INVALID');
   const revoked=r.revokedAt!==null;if(revoked)instant(r.revokedAt);
   return {token:r.token,url:'/shared-plan/'+r.token,serviceDate:pub.serviceDate,createdAt,expiresAt,status:revoked||r.sessionId!==state.sessionId||!eligible(r.scope,state)?'revoked':Date.parse(expiresAt)<=Date.parse(serverNow)?'expired':'active',labels:pub.places.map(p=>p.label)};
  });
  return {runtime:'production',sessionId:state.sessionId,profileRevision:state.revision,serverNow,capabilities:{reports:true,shares:true,accountLinking:false,accountUnlinking:false,verifiedOutageStatistics:false},reports:shown,legacyReports,legacyReportsStatus:exists.reports?'available':'unavailable',
   digest:{fromDate,throughDate,observationCount:count(total.total),observationDays:count(total.days),onCount:count(total.onCount),offCount:count(total.offCount),verifiedOutageDays:0,legacyDigestCount},accounts,accountsStatus:exists.links&&exists.users?'available':'unavailable',shares};
 }
 /** Trusted composition port for a canonical Bot transaction. Never nest withLockedProfile. */
 async function commitActionInTransaction(tx:LiveToolsTransaction,value:unknown):Promise<{receipt:LiveToolReceipt;replayed:boolean}>{
  requireEnabled();let request:LiveToolsRequest;try{request=parseLiveToolsRequest(value);}catch{return fail('LIVE_TOOLS_INVALID_INPUT');}
  const {client,state,context,serverNow}=tx;if(!validInstant(serverNow)||context.actorId!==state.ownerId)return fail('LIVE_TOOLS_INVALID_TRANSACTION');
  if(request.expectedSessionId!==state.sessionId)return fail('LIVE_TOOLS_SESSION_CONFLICT');
  const old=await client.query(SELECT_RECEIPT,[state.ownerId,'tools:'+request.id]);if(old.rows.length>1)return fail('LIVE_TOOLS_STORED_RESULT_INVALID');
  if(old.rows.length)return {receipt:checkedReceipt(old.rows[0],request),replayed:true};
  if(request.expectedRevision!==state.revision)return fail('LIVE_TOOLS_REVISION_CONFLICT');
  const action=request.action;let shareToken:string|undefined;
  if(action.kind==='report'){
   const location=state.profile.locations.find(l=>l.address.id===action.addressId);if(!location)return fail('LIVE_TOOLS_ADDRESS_NOT_OWNED');
   await client.query('insert into lba_production_tools_reports(id,owner_id,session_id,address_id,binding_fingerprint,label,locality,value,recorded_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),state.ownerId,state.sessionId,location.address.id,liveShareScopeFingerprint(location),text(location.address.label),text(location.address.locality,4096,true),action.value,serverNow]);
  }else if(action.kind==='share'){
   const date=localParts(Date.parse(serverNow)).date;if(![date,nextCalendarDate(date)].includes(action.serviceDate))return fail('LIVE_TOOLS_DATE_OUT_OF_RANGE');
   const locations=action.addressIds.map(id=>{const l=state.profile.locations.find(l=>l.address.id===id);if(!l)return fail('LIVE_TOOLS_ADDRESS_NOT_OWNED');return l;});
   shareToken=randomBytes(24).toString('hex');const expiresAt=new Date(Date.parse(serverNow)+action.ttlDays*86400000).toISOString();
   const pub=parseLivePublicShare({runtime:'production',mode:'saved_plan',serviceDate:action.serviceDate,createdAt:serverNow,expiresAt,places:locations.map(l=>publicPlace(l,context,action.serviceDate,serverNow))});
   await client.query('insert into lba_production_tools_shares(token,owner_id,session_id,service_date,created_at,expires_at,private_scope,public_snapshot) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',[shareToken,state.ownerId,state.sessionId,action.serviceDate,serverNow,expiresAt,JSON.stringify(locations.map(l=>({addressId:l.address.id,fingerprint:liveShareScopeFingerprint(l)}))),JSON.stringify(pub)]);
  }else{
   const changed=await client.query('update lba_production_tools_shares set revoked_at=coalesce(revoked_at,$3) where owner_id=$1 and token=$2 returning token',[state.ownerId,action.token,serverNow]);
   if(changed.rows.length!==1)return fail('LIVE_TOOLS_SHARE_NOT_FOUND');
  }
  const receipt:LiveToolReceipt={runtime:'production',id:request.id,inputId:'tools:'+request.id,sessionId:state.sessionId,profileRevision:state.revision,recordedAt:serverNow,committed:true,kind:action.kind,...(shareToken?{shareToken}:{})};
  await client.query('insert into lba_production_tools_inbox(owner_id,input_id,session_id,input_digest,receipt,recorded_at) values($1,$2,$3,$4,$5::jsonb,$6)',[state.ownerId,receipt.inputId,state.sessionId,inputDigest(request),JSON.stringify(receipt),serverNow]);
  return {receipt,replayed:false};
 }
 async function readTransaction<T>(identity:VerifiedLegacyPrincipal|undefined,work:(client:LegacyProfileReadQuery)=>Promise<T>,shared=false):Promise<T>{
  requireEnabled();if(identity)principal(identity);let client;try{client=await options.pool.connect();}catch{return fail('LIVE_TOOLS_READ_UNCONFIRMED');}
  let began=false;try{
   await client.query('begin isolation level read committed read only');began=true;
   const control=async()=>{const q=await client.query('select control_epoch as "controlEpoch",writer_mode as "writerMode" from lba_production_control where id=true');if(q.rows.length!==1||q.rows[0].writerMode!=='canonical'||Number(q.rows[0].controlEpoch)!==epoch)return fail('LIVE_TOOLS_DISABLED');};
   await control();if(identity)await client.query(`select pg_advisory_xact_lock${shared?'_shared':''}(hashtextextended($1,0))`,['lba-production-owner:'+identity.ownerId]);
   const result=await work(client);await control();await client.query('commit');return result;
  }catch(error){if(began)try{await client.query('rollback');}catch{}if(error instanceof ProductionToolsError)throw error;return fail('LIVE_TOOLS_READ_UNCONFIRMED');}
  finally{try{client.release();}catch{}}
 }
 return Object.freeze({
  async snapshot(identity:VerifiedLegacyPrincipal):Promise<LiveToolsSnapshot>{requireEnabled();const p=principal(identity);return options.store.withLockedProfile(p,undefined,readSnapshot);},
  async commit(identity:VerifiedLegacyPrincipal,value:unknown):Promise<LiveToolsSnapshot>{requireEnabled();const p=principal(identity);return options.store.withLockedProfile(p,undefined,async tx=>{const result=await commitActionInTransaction(tx,value);return {...await readSnapshot(tx),...result};});},
  async recover(identity:VerifiedLegacyPrincipal,value:unknown):Promise<LiveToolsRecovery>{
   const p=principal(identity);let request:LiveToolsRequest;try{request=parseLiveToolsRequest(value);}catch{return fail('LIVE_TOOLS_INVALID_INPUT');}
   return readTransaction(p,async client=>{
    const current=await client.query('select session_id as "sessionId" from lba_production_profiles where owner_id=$1',[p.ownerId]);if(current.rows.length!==1||current.rows[0].sessionId!==request.expectedSessionId)return fail('LIVE_TOOLS_SESSION_CONFLICT');
    const q=await client.query(SELECT_RECEIPT,[p.ownerId,'tools:'+request.id]);if(q.rows.length>1)return fail('LIVE_TOOLS_STORED_RESULT_INVALID');const receipt=q.rows.length?checkedReceipt(q.rows[0],request):null;
    return {runtime:'production',status:receipt?'recorded':'not_recorded',receipt,retry:receipt?'none':'same_request'};
   });
  },
  async publicShare(token:unknown):Promise<LivePublicShare>{
   if(!validReviewShareToken(token))return fail('LIVE_TOOLS_SHARE_NOT_FOUND');
   return readTransaction(undefined,async client=>{
    const first=await client.query('select owner_id as "ownerId" from lba_production_tools_shares where token=$1',[token]);if(first.rows.length!==1)return fail('LIVE_TOOLS_SHARE_NOT_FOUND');const owner=text(first.rows[0].ownerId,255);
    await client.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))',['lba-production-owner:'+owner]);
    const found=await client.query('select session_id as "sessionId",expires_at as "expiresAt",revoked_at as "revokedAt",private_scope as scope,public_snapshot as snapshot from lba_production_tools_shares where token=$1 and owner_id=$2',[token,owner]);
    if(found.rows.length!==1)return fail('LIVE_TOOLS_SHARE_NOT_FOUND');const r=found.rows[0],now=clock();if(r.revokedAt!==null||Date.parse(instant(r.expiresAt))<=Date.parse(now))return fail('LIVE_TOOLS_SHARE_GONE');
    const profile=await client.query('select session_id as "sessionId",state from lba_production_profiles where owner_id=$1',[owner]);if(profile.rows.length!==1)return fail('LIVE_TOOLS_SHARE_GONE');let state:BotState;try{state=restoreBotState(decoded(profile.rows[0].state),owner);}catch{return fail('LIVE_TOOLS_STORED_RESULT_INVALID');}
    if(profile.rows[0].sessionId!==state.sessionId||r.sessionId!==state.sessionId||!eligible(r.scope,state))return fail('LIVE_TOOLS_SHARE_GONE');
    let pub;try{pub=parseLivePublicShare(decoded(r.snapshot));}catch{return fail('LIVE_TOOLS_STORED_RESULT_INVALID');}if(Date.parse(pub.expiresAt)!==Date.parse(instant(r.expiresAt)))return fail('LIVE_TOOLS_STORED_RESULT_INVALID');return pub;
   },true);
  },
  commitActionInTransaction,
 });
}
