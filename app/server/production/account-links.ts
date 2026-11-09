import {createHash,createHmac,randomUUID} from 'node:crypto';
import {verifyTelegramInitData,verifyTelegramLoginData} from '../telegram-init-data.ts';
import {AuthReplayError,createAuthReplayGuard} from './auth-replay.ts';
import type {createProductionProfileStore} from './profile-store.ts';
import type {LegacyProfileReadQuery,LegacyProfileReadPool,VerifiedLegacyPrincipal} from './profile-reader.ts';
import {validInstant} from '../../shared/schedule-core.ts';

/** Explicit additive schema. Application import does not apply it or create a pool. */
export const ACCOUNT_LINKS_SCHEMA_SQL=`
create table if not exists lba_owner_auth_epoch(owner_id varchar(255) primary key references users(id),auth_epoch bigint not null check(auth_epoch>=1));
create table if not exists lba_account_link_challenge(
 id uuid primary key,nonce_hash char(64) not null unique,owner_id varchar(255) not null references users(id),session_binding char(64) not null,
 auth_epoch bigint not null check(auth_epoch>=0),profile_session text not null,profile_revision bigint not null,
 state text not null check(state in ('pending','proved','linked','cancelled')),subject_id varchar(255),proof_key char(64) unique,
 issued_at timestamptz not null,expires_at timestamptz not null,check(expires_at>issued_at)
);
create table if not exists lba_account_operation(
 owner_id varchar(255) not null references users(id),operation_id text not null,input_digest char(64) not null,session_binding char(64) not null,
 auth_epoch bigint not null,kind text not null check(kind in ('challenge','link','unlink')),result jsonb not null,committed_at timestamptz not null,
 primary key(owner_id,operation_id)
);
create table if not exists lba_account_verified_login(
 proof_key char(64) primary key,owner_id varchar(255) not null references users(id),session_binding char(64) not null,auth_epoch bigint not null,
 link_id varchar(255) not null,provider text not null check(provider in ('telegram','replit')),subject_digest char(64) not null,
 verified_at timestamptz not null,expires_at timestamptz not null,input_digest char(64) not null,check(expires_at>verified_at)
);
create table if not exists lba_account_detached_identity(
 provider text not null check(provider in ('telegram','replit')),subject_digest char(64) not null,former_owner_id varchar(255) not null references users(id),
 auth_epoch bigint not null,detached_at timestamptz not null,primary key(provider,subject_digest)
);
create table if not exists lba_account_widget_proof_receipt(
 challenge_id uuid primary key references lba_account_link_challenge(id),owner_id varchar(255) not null references users(id),
 session_binding char(64) not null,auth_epoch bigint not null,proof_key char(64) not null unique,
 input_digest char(64) not null,result jsonb not null,committed_at timestamptz not null
);`;

export interface AccountLinkPrincipal extends VerifiedLegacyPrincipal {webSessionId:string;authEpoch:number}
export type AccountLinkChallenge={kind:'challenge';challengeId:string;startParam:string;expiresAt:string;miniAppUrl:string|null;state:'pending';widgetBotUsername?:string};
export type AccountLinkMutation={kind:'linked'|'unlinked';operationId:string;provider:'telegram'|'replit';linkId:string;authEpoch:number;reauthenticate:boolean};
export type AccountLinkResult=AccountLinkChallenge|AccountLinkMutation;
export type AccountLinkStatus={kind:'challenge_status';challengeId:string;state:'pending'|'ready_for_confirmation'|'linked'|'expired';expiresAt:string;accountLabel?:string};
export class AccountLinkError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;this.name='AccountLinkError';}}
const fail=(code:string):never=>{throw new AccountLinkError(code);};
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=255):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const closed=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!plain(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))return fail('ACCOUNT_INVALID_REQUEST');return v;};
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const sha=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const scalar=(v:unknown)=>typeof v==='string'&&/^\d{1,16}$/.test(v)?Number(v):v;
const instant=(v:unknown):string|null=>v instanceof Date&&Number.isFinite(v.getTime())?v.toISOString():validInstant(v)?new Date(Date.parse(v)).toISOString():null;
const provider=(v:unknown):v is 'telegram'|'replit'=>v==='telegram'||v==='replit';
function principal(v:unknown):AccountLinkPrincipal{
 const p=closed(v,['kind','verified','ownerId','webSessionId','authEpoch']);
 if(p.kind!=='verified_server_principal'||p.verified!==true||!text(p.ownerId)||!text(p.webSessionId,512)||!integer(p.authEpoch))return fail('ACCOUNT_AUTH_REQUIRED');
 return structuredClone(p) as unknown as AccountLinkPrincipal;
}
function request(value:unknown,kind:'challenge'|'link'|'unlink'){
 const extra=kind==='challenge'?[]:kind==='link'?['challengeId','confirmed']:['linkId','linkRevision','confirmed'];
 const v=closed(value,['id','expectedSessionId','expectedRevision',...extra]);
 if(!text(v.id,160)||!text(v.expectedSessionId)||!integer(v.expectedRevision)||kind!=='challenge'&&v.confirmed!==true||kind==='link'&&!uuid(v.challengeId)||kind==='unlink'&&(!text(v.linkId)||typeof v.linkRevision!=='string'||!/^[a-f0-9]{64}$/.test(v.linkRevision)))return fail('ACCOUNT_INVALID_REQUEST');
 return structuredClone(v);
}
/** Missing rows represent epoch zero for pre-migration credentials only. Every
 * authenticator must explicitly stamp/compare this epoch before enabling unlink. */
export async function readOwnerAuthEpoch(client:LegacyProfileReadQuery,ownerId:string):Promise<number>{
 if(!text(ownerId))return fail('ACCOUNT_AUTH_REQUIRED');
 const rows=(await client.query('select auth_epoch from lba_owner_auth_epoch where owner_id=$1',[ownerId])).rows;
 if(!rows.length)return 0;
 const n=scalar(rows[0]?.auth_epoch);if(rows.length!==1||!integer(n)||n<1)return fail('ACCOUNT_UNCONFIRMED');return n;
}
export async function checkOwnerAuthEpoch(client:LegacyProfileReadQuery,ownerId:string,issuedEpoch:number):Promise<boolean>{
 if(!integer(issuedEpoch))return false;return await readOwnerAuthEpoch(client,ownerId)===issuedEpoch;
}
export async function isDetachedAccountIdentity(client:LegacyProfileReadQuery,kind:'telegram'|'replit',subjectId:string):Promise<boolean>{
 if(!provider(kind)||!text(subjectId))return true;
 return (await client.query('select 1 from lba_account_detached_identity where provider=$1 and subject_digest=$2',[kind,sha([kind,subjectId])])).rows.length>0;
}
export function accountLinkRevision(link:{id:unknown;ownerId:unknown;provider:unknown;providerId:unknown;createdAt:unknown}):string{
 if(!text(link.id)||!text(link.ownerId)||!provider(link.provider)||!text(link.providerId)||instant(link.createdAt)===null)return fail('ACCOUNT_UNCONFIRMED');
 return sha([link.id,link.ownerId,link.provider,link.providerId,instant(link.createdAt)]);
}
type Store=Pick<ReturnType<typeof createProductionProfileStore>,'withLockedProfile'>;
export interface AccountLinksOptions {
 enabled?:boolean;expectedControlEpoch:number;pool:LegacyProfileReadPool;store:Store;
 botId:string;botToken:string;bindingKey:string;now:()=>number;
 /** Only a verified Telegram Mini App URL (not the normal bot start link).
  * Null/default leaves the external configuration gate explicit. */
 miniApp?:{botUsername:string;shortName:string;configurationVerified:true};
 /** Explicit browser adapter configuration. A separate release gate must verify the real provider domain. */
 browserWidget?:{botUsername:string;configurationVerified:true};
}
/** Account link operations compose the existing canonical owner transaction.
 * No profile migration, login/autocreate, subscriptions, sends, raw proof logs,
 * background work, automatic DDL or environment lookup occurs here. */
export function createAccountLinks(o:AccountLinksOptions){
 if(!o||!integer(o.expectedControlEpoch)||o.expectedControlEpoch<1||!o.pool||typeof o.pool.connect!=='function'||typeof o.store?.withLockedProfile!=='function'||typeof o.now!=='function'||
  typeof o.botId!=='string'||! /^[1-9]\d{0,15}$/.test(o.botId)||typeof o.botToken!=='string'||! /^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,100}$/.test(o.botToken)||o.botToken.split(':')[0]!==o.botId||!text(o.bindingKey,4096)||o.bindingKey.length<32||
  o.enabled!==undefined&&typeof o.enabled!=='boolean'||o.miniApp!==undefined&&(!plain(o.miniApp)||Object.keys(o.miniApp).sort().join(',')!=='botUsername,configurationVerified,shortName'||o.miniApp.configurationVerified!==true||! /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(o.miniApp.botUsername)||! /^[a-zA-Z0-9_]{1,64}$/.test(o.miniApp.shortName))||
  o.browserWidget!==undefined&&(!plain(o.browserWidget)||Object.keys(o.browserWidget).sort().join(',')!=='botUsername,configurationVerified'||o.browserWidget.configurationVerified!==true||! /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(o.browserWidget.botUsername)||o.miniApp!==undefined&&o.miniApp.botUsername!==o.browserWidget.botUsername))return fail('ACCOUNT_CONFIGURATION');
 const widgetGuard=o.browserWidget?createAuthReplayGuard(o.pool,{key:o.bindingKey,now:()=>Math.floor(wall()/1000)}):undefined;
 const mac=(v:unknown)=>createHmac('sha256',o.bindingKey).update(canonical(v)).digest('hex');
 const binding=(p:AccountLinkPrincipal)=>mac(['account-session/1',p.ownerId,p.webSessionId]);
 const nonce=(p:AccountLinkPrincipal,id:string)=>mac(['account-challenge/1',p.ownerId,p.webSessionId,id]);
 const identity=(p:AccountLinkPrincipal):VerifiedLegacyPrincipal=>({kind:'verified_server_principal',verified:true,ownerId:p.ownerId});
 const enabled=()=>{if(o.enabled!==true)fail('ACCOUNT_DISABLED');};
 const widgetFields=()=>o.browserWidget?{widgetBotUsername:o.browserWidget.botUsername}:{};
 function wall(){const n=o.now();if(!integer(n))return fail('ACCOUNT_UNCONFIRMED');return n;}
 async function dbNow(client:LegacyProfileReadQuery){const rows=(await client.query('select clock_timestamp() as now')).rows,t=rows.length===1?instant(rows[0].now):null;if(!t)return fail('ACCOUNT_UNCONFIRMED');return Date.parse(t);}
 async function gate(client:LegacyProfileReadQuery,p:AccountLinkPrincipal){
  const rows=(await client.query('select control_epoch,writer_mode from lba_production_control where id=true')).rows;
  if(rows.length!==1||scalar(rows[0].control_epoch)!==o.expectedControlEpoch||rows[0].writer_mode!=='canonical')return fail('ACCOUNT_DISABLED');
  if(!await checkOwnerAuthEpoch(client,p.ownerId,p.authEpoch))return fail('ACCOUNT_SESSION_REVOKED');
 }
 async function run<T>(p:AccountLinkPrincipal,fn:(input:Parameters<Parameters<Store['withLockedProfile']>[2]>[0])=>Promise<T>):Promise<T>{
  enabled();let rejected:AccountLinkError|undefined;
  // Auth epoch and identity reads must observe a predecessor that commits while
  // the canonical owner lock is being acquired. The normal store default is RR.
  try{return await o.store.withLockedProfile(identity(p),undefined,async tx=>{try{await gate(tx.client,p);return await fn(tx);}catch(e){if(e instanceof AccountLinkError)rejected=e;throw e;}},{isolation:'read committed'});}
  catch(e){if(rejected)throw rejected;if(e instanceof AccountLinkError)throw e;const c=(e as {code?:unknown})?.code;if(c==='PRODUCTION_COMMIT_UNKNOWN')return fail('ACCOUNT_COMMIT_UNKNOWN');return fail('ACCOUNT_UNCONFIRMED');}
 }
 async function receipt(client:LegacyProfileReadQuery,p:AccountLinkPrincipal,r:Record<string,unknown>,kind:'challenge'|'link'|'unlink'):Promise<AccountLinkResult|null>{
  const rows=(await client.query('select input_digest,session_binding,auth_epoch,kind,result from lba_account_operation where owner_id=$1 and operation_id=$2',[p.ownerId,r.id])).rows;
  if(!rows.length)return null;
  if(rows.length!==1||rows[0].kind!==kind||rows[0].input_digest!==sha({kind,request:r})||rows[0].session_binding!==binding(p)||scalar(rows[0].auth_epoch)!==p.authEpoch)return fail('ACCOUNT_OPERATION_CONFLICT');
  try{
   const stored=rows[0].result;
   if(kind==='challenge'){
    const v=closed(stored,['kind','challengeId','expiresAt','state',...(plain(stored)&&Object.hasOwn(stored,'widgetBotUsername')?['widgetBotUsername']:[])]),startParam='acctlink_'+nonce(p,r.id as string);
    return validateResult({...v,startParam,miniAppUrl:o.miniApp?`https://t.me/${o.miniApp.botUsername}/${o.miniApp.shortName}?startapp=${startParam}`:null});
   }
   return mutationReceipt(stored,r,kind,rows[0].auth_epoch);
  }catch{return fail('ACCOUNT_UNCONFIRMED');}
 }
 /** A fresh verified login may read its owner's immutable mutation outcome after
  * an unlink revoked the original credential. It never inherits a challenge
  * nonce or permits an old epoch to bypass original-session receipt binding. */
 async function recoveryReceipt(client:LegacyProfileReadQuery,p:AccountLinkPrincipal,r:Record<string,unknown>,kind:'challenge'|'link'|'unlink'):Promise<AccountLinkResult|null>{
  try{return await receipt(client,p,r,kind);}catch(e){
   if(!(e instanceof AccountLinkError)||e.code!=='ACCOUNT_OPERATION_CONFLICT')throw e;
   const rows=(await client.query('select input_digest,kind,result,auth_epoch from lba_account_operation where owner_id=$1 and operation_id=$2',[p.ownerId,r.id])).rows;
   if(rows.length!==1||rows[0].kind!==kind||rows[0].input_digest!==sha({kind,request:r})||!await checkOwnerAuthEpoch(client,p.ownerId,p.authEpoch))throw e;
   if(kind==='challenge')return fail('ACCOUNT_ORIGINAL_SESSION_REQUIRED');
   try{
    return mutationReceipt(rows[0].result,r,kind,rows[0].auth_epoch);
   }catch{return fail('ACCOUNT_UNCONFIRMED');}
  }
 }
 function mutationReceipt(value:unknown,r:Record<string,unknown>,kind:'link'|'unlink',storedEpoch:unknown):AccountLinkMutation{
  const result=validateResult(value),originalEpoch=scalar(storedEpoch);
  if(result.kind==='challenge'||!integer(originalEpoch)||result.kind!==(kind==='link'?'linked':'unlinked')||result.operationId!==r.id||
   kind==='link'&&result.provider!=='telegram'||kind==='unlink'&&result.linkId!==r.linkId||result.authEpoch!==(kind==='unlink'?originalEpoch+1:originalEpoch))return fail('ACCOUNT_UNCONFIRMED');
  return result;
 }
 function validateResult(v:unknown):AccountLinkResult{
  if(!plain(v))return fail('ACCOUNT_UNCONFIRMED');
  if(v.kind==='challenge'){
 const r=closed(v,['kind','challengeId','startParam','expiresAt','miniAppUrl','state',...(Object.hasOwn(v,'widgetBotUsername')?['widgetBotUsername']:[])]);
   if(!uuid(r.challengeId)||typeof r.startParam!=='string'||! /^acctlink_[a-f0-9]{64}$/.test(r.startParam)||!validInstant(r.expiresAt)||r.state!=='pending'||r.miniAppUrl!==null&&typeof r.miniAppUrl!=='string')return fail('ACCOUNT_UNCONFIRMED');
   if(Object.hasOwn(r,'widgetBotUsername')&&(!o.browserWidget||r.widgetBotUsername!==o.browserWidget.botUsername))return fail('ACCOUNT_UNCONFIRMED');
   const expected=o.miniApp?`https://t.me/${o.miniApp.botUsername}/${o.miniApp.shortName}?startapp=${r.startParam}`:null;
   if(r.miniAppUrl!==expected)return fail('ACCOUNT_UNCONFIRMED');return structuredClone(r) as AccountLinkChallenge;
  }
  const r=closed(v,['kind','operationId','provider','linkId','authEpoch','reauthenticate']);
  if(!['linked','unlinked'].includes(r.kind as string)||!text(r.operationId,160)||!provider(r.provider)||!text(r.linkId)||!integer(r.authEpoch)||r.reauthenticate!==(r.kind==='unlinked'))return fail('ACCOUNT_UNCONFIRMED');
  return structuredClone(r) as AccountLinkMutation;
 }
 async function save(client:LegacyProfileReadQuery,p:AccountLinkPrincipal,r:Record<string,unknown>,kind:'challenge'|'link'|'unlink',result:AccountLinkResult,now:number){
  const stored=result.kind==='challenge'?{kind:result.kind,challengeId:result.challengeId,expiresAt:result.expiresAt,state:result.state,...(result.widgetBotUsername?{widgetBotUsername:result.widgetBotUsername}:{})}:result;
  await client.query('insert into lba_account_operation(owner_id,operation_id,input_digest,session_binding,auth_epoch,kind,result,committed_at) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
   [p.ownerId,r.id,sha({kind,request:r}),binding(p),p.authEpoch,kind,JSON.stringify(stored),new Date(now).toISOString()]);
 }
 function cas(state:{sessionId:string;revision:number},r:Record<string,unknown>){if(state.sessionId!==r.expectedSessionId||state.revision!==r.expectedRevision)return fail('ACCOUNT_PROFILE_CHANGED');}
 async function challenge(client:LegacyProfileReadQuery,p:AccountLinkPrincipal,id:string){
  const rows=(await client.query('select * from lba_account_link_challenge where id=$1 and owner_id=$2 for update',[id,p.ownerId])).rows;
  const row=rows[0];if(rows.length!==1||row.session_binding!==binding(p)||scalar(row.auth_epoch)!==p.authEpoch)return fail('ACCOUNT_CHALLENGE_CONFLICT');
  return row;
 }
 function fresh(row:Record<string,any>,now:number){const issued=instant(row.issued_at),expires=instant(row.expires_at);if(!issued||!expires||Date.parse(issued)>now||now>=Date.parse(expires)||Date.parse(expires)-Date.parse(issued)!==300000||!['pending','proved','linked'].includes(row.state))return fail('ACCOUNT_CHALLENGE_EXPIRED');}
 async function exactLinks(client:LegacyProfileReadQuery,kind:string,subject:string){
  return (await client.query('select id,user_id as "ownerId",provider,provider_id as "providerId",created_at as "createdAt" from linked_accounts where provider=$1 and provider_id=$2 order by id for update',[kind,subject])).rows;
 }
 return Object.freeze({
  async createChallenge(value:AccountLinkPrincipal,input:unknown):Promise<AccountLinkChallenge>{
   const p=principal(value),r=request(input,'challenge');return run(p,async({client,state})=>{
    const old=await receipt(client,p,r,'challenge');if(old){if(old.kind!=='challenge')return fail('ACCOUNT_UNCONFIRMED');return old;}
    cas(state,r);const now=await dbNow(client),raw=nonce(p,r.id as string),id=randomUUID(),expiresAt=new Date(now+300000).toISOString(),startParam='acctlink_'+raw;
    const active=(await client.query("select id from lba_account_link_challenge where owner_id=$1 and state in ('pending','proved') and expires_at>$2 limit 5",[p.ownerId,new Date(now).toISOString()])).rows;
    if(active.length>=5)return fail('ACCOUNT_CHALLENGE_CONFLICT');
    const result:AccountLinkChallenge={kind:'challenge',challengeId:id,startParam,expiresAt,miniAppUrl:o.miniApp?`https://t.me/${o.miniApp.botUsername}/${o.miniApp.shortName}?startapp=${startParam}`:null,state:'pending',...widgetFields()};
    await client.query("insert into lba_account_link_challenge(id,nonce_hash,owner_id,session_binding,auth_epoch,profile_session,profile_revision,state,issued_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)",[id,sha(raw),p.ownerId,binding(p),p.authEpoch,state.sessionId,state.revision,new Date(now).toISOString(),expiresAt]);
    await save(client,p,r,'challenge',result,now);return result;
   });
  },
  async receiveMiniProof(raw:unknown):Promise<{kind:'proof';state:'ready_for_confirmation'}>{
   enabled();let user,params:URLSearchParams;
   try{user=verifyTelegramInitData(raw,o.botToken,{nowSeconds:Math.floor(wall()/1000),maxAgeSeconds:300,futureSkewSeconds:30});params=new URLSearchParams(raw as string);}catch{return fail('ACCOUNT_PROOF_INVALID');}
   const start=params.get('start_param');if(!start||! /^acctlink_[a-f0-9]{64}$/.test(start))return fail('ACCOUNT_PROOF_INVALID');
   const nonceHash=sha(start.slice(9)),proofKey=mac(['account-link-proof/1',o.botId,params.get('hash')]);
   let lookup;try{const c=await o.pool.connect();try{lookup=(await c.query('select owner_id,session_binding,auth_epoch from lba_account_link_challenge where nonce_hash=$1',[nonceHash])).rows;}finally{c.release();}}catch{return fail('ACCOUNT_UNCONFIRMED');}
   if(lookup.length!==1||!text(lookup[0].owner_id)||typeof lookup[0].session_binding!=='string'||!integer(scalar(lookup[0].auth_epoch)))return fail('ACCOUNT_PROOF_INVALID');
   // This private lookup supplies the owner lock only, never a caller-controlled identity.
   const p:AccountLinkPrincipal={kind:'verified_server_principal',verified:true,ownerId:lookup[0].owner_id,webSessionId:'proof-receiver',authEpoch:scalar(lookup[0].auth_epoch) as number};
   return run(p,async({client,state})=>{
    const rows=(await client.query('select * from lba_account_link_challenge where nonce_hash=$1 and owner_id=$2 for update',[nonceHash,p.ownerId])).rows,row=rows[0];
    if(rows.length!==1||row.session_binding!==lookup[0].session_binding||scalar(row.auth_epoch)!==p.authEpoch)return fail('ACCOUNT_PROOF_INVALID');
    let now=await dbNow(client);fresh(row,now);
    if(row.profile_session!==state.sessionId||scalar(row.profile_revision)!==state.revision)return fail('ACCOUNT_PROFILE_CHANGED');
    if(user.authDate*1000<Date.parse(instant(row.issued_at)!)-30000||user.authDate*1000>now+30000||now-user.authDate*1000>300000)return fail('ACCOUNT_PROOF_INVALID');
    if(row.state==='linked')return fail('ACCOUNT_CHALLENGE_CONFLICT');
    if(row.state==='proved'&&(row.subject_id!==user.id||row.proof_key!==proofKey))return fail('ACCOUNT_CHALLENGE_CONFLICT');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:telegram:'+user.id]);
    const existing=await exactLinks(client,'telegram',user.id);
    if(existing.length&&(existing.length!==1||existing[0].ownerId!==p.ownerId))return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    const detached=(await client.query('select former_owner_id from lba_account_detached_identity where provider=$1 and subject_digest=$2 for update',['telegram',sha(['telegram',user.id])])).rows;
    if(detached.length>1||detached.length===1&&detached[0].former_owner_id!==p.ownerId)return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    const orphan=(await client.query('select id from users where id=$1 for share',['tg_'+user.id])).rows;
    if(orphan.length&&!existing.length)return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    const used=(await client.query('select id from lba_account_link_challenge where proof_key=$1 and id<>$2',[proofKey,row.id])).rows;if(used.length)return fail('ACCOUNT_CHALLENGE_CONFLICT');
    await client.query("update lba_account_link_challenge set state='proved',subject_id=$2,proof_key=$3 where id=$1",[row.id,user.id,proofKey]);
    now=await dbNow(client);fresh(row,now);if(now-user.authDate*1000>300000)return fail('ACCOUNT_PROOF_INVALID');
    return {kind:'proof',state:'ready_for_confirmation'};
   });
  },
  /** Existing authenticated original browser only. A Widget proof never logs in,
   * resolves/autocreates a user or replaces the current Passport session. */
  async receiveWidgetProof(value:AccountLinkPrincipal,input:unknown):Promise<{kind:'proof';state:'ready_for_confirmation'}>{
   enabled();if(!o.browserWidget||!widgetGuard)return fail('ACCOUNT_DISABLED');
   const p=principal(value),v=closed(input,['challengeId','telegramData']);if(!uuid(v.challengeId))return fail('ACCOUNT_INVALID_REQUEST');
   let user:ReturnType<typeof verifyTelegramLoginData>;try{
    user=verifyTelegramLoginData(v.telegramData,o.botToken,Math.floor(wall()/1000));
    if(Buffer.byteLength(JSON.stringify(v.telegramData))>16384||wall()-user.authDate*1000>300000)return fail('ACCOUNT_PROOF_INVALID');
   }catch{return fail('ACCOUNT_PROOF_INVALID');}
   const proofResult={kind:'proof' as const,state:'ready_for_confirmation' as const};
   return run(p,async({client,state})=>{
    const row=await challenge(client,p,v.challengeId as string);
    function widgetFresh(now:number){
     fresh(row,now);
     if(user.authDate*1000<Date.parse(instant(row.issued_at)!)-30000||user.authDate*1000>now+30000||now-user.authDate*1000>300000)return fail('ACCOUNT_PROOF_INVALID');
    }
    widgetFresh(await dbNow(client));
    if(row.profile_session!==state.sessionId||scalar(row.profile_revision)!==state.revision)return fail('ACCOUNT_PROFILE_CHANGED');
    // Only a challenge actually issued with this explicit adapter may accept its proof.
    const issued=(await client.query("select result from lba_account_operation where owner_id=$1 and kind='challenge' and result->>'challengeId'=$2",[p.ownerId,row.id])).rows;
    const dto=issued[0]?.result;
    if(issued.length!==1||!plain(dto)||Object.keys(dto).sort().join(',')!=='challengeId,expiresAt,kind,state,widgetBotUsername'||dto.kind!=='challenge'||dto.challengeId!==row.id||dto.state!=='pending'||dto.expiresAt!==instant(row.expires_at)||dto.widgetBotUsername!==o.browserWidget!.botUsername)return fail('ACCOUNT_PROOF_INVALID');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:telegram:'+user.id]);
    const existing=await exactLinks(client,'telegram',user.id);
    if(existing.length&&(existing.length!==1||existing[0].ownerId!==p.ownerId))return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    const detached=(await client.query('select former_owner_id from lba_account_detached_identity where provider=$1 and subject_digest=$2 for update',['telegram',sha(['telegram',user.id])])).rows;
    if(detached.length>1||detached.length===1&&detached[0].former_owner_id!==p.ownerId)return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    if((await client.query('select id from users where id=$1 for share',['tg_'+user.id])).rows.length&&!existing.length)return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    let claimed;
    try{claimed=await widgetGuard.claimAccountLink(client,{kind:'login',botId:o.botId,subjectId:user.id,authDate:user.authDate,signature:(v.telegramData as {hash:string}).hash},{sessionId:p.webSessionId,ownerId:p.ownerId,challengeId:row.id});}
    catch(e){if(e instanceof AuthReplayError)return fail(e.message==='AUTH_REPLAY_EXPIRED'?'ACCOUNT_PROOF_INVALID':'ACCOUNT_CHALLENGE_CONFLICT');throw e;}
    const inputDigest=sha({owner:p.ownerId,binding:binding(p),epoch:p.authEpoch,challengeId:row.id,proofKey:claimed.proofKey});
    const prior=(await client.query('select * from lba_account_widget_proof_receipt where challenge_id=$1 for update',[row.id])).rows;
    if(prior.length){
     const r=prior[0];
     if(prior.length!==1||!claimed.alreadyClaimed||r.owner_id!==p.ownerId||r.session_binding!==binding(p)||scalar(r.auth_epoch)!==p.authEpoch||r.proof_key!==claimed.proofKey||r.input_digest!==inputDigest||canonical(r.result)!==canonical(proofResult)||!['proved','linked'].includes(row.state)||row.subject_id!==user.id||row.proof_key!==claimed.proofKey)return fail('ACCOUNT_CHALLENGE_CONFLICT');
     widgetFresh(await dbNow(client));return proofResult;
    }
    if(claimed.alreadyClaimed||row.state!=='pending')return fail('ACCOUNT_CHALLENGE_CONFLICT');
    const now=await dbNow(client);widgetFresh(now);
    await client.query("update lba_account_link_challenge set state='proved',subject_id=$2,proof_key=$3 where id=$1",[row.id,user.id,claimed.proofKey]);
    await client.query('insert into lba_account_widget_proof_receipt(challenge_id,owner_id,session_binding,auth_epoch,proof_key,input_digest,result,committed_at) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[row.id,p.ownerId,binding(p),p.authEpoch,claimed.proofKey,inputDigest,JSON.stringify(proofResult),new Date(now).toISOString()]);
    widgetFresh(await dbNow(client));return proofResult;
   });
  },
  async inspectChallenge(value:AccountLinkPrincipal,id:string):Promise<AccountLinkStatus>{
   const p=principal(value);if(!uuid(id))return fail('ACCOUNT_INVALID_REQUEST');return run(p,async({client})=>{
    const row=await challenge(client,p,id),now=await dbNow(client),expires=instant(row.expires_at);if(!expires)return fail('ACCOUNT_UNCONFIRMED');
    if(['proved','linked'].includes(row.state)&&(typeof row.subject_id!=='string'||! /^[1-9]\d{0,15}$/.test(row.subject_id)))return fail('ACCOUNT_UNCONFIRMED');
    const expired=now>=Date.parse(expires)||!['pending','proved','linked'].includes(row.state);
    const state=expired?'expired':row.state==='proved'?'ready_for_confirmation':row.state==='linked'?'linked':'pending';
    return {kind:'challenge_status',challengeId:id,state,expiresAt:expires,...(!expired&&row.subject_id&&['proved','linked'].includes(row.state)?{accountLabel:'Telegram ••••'+String(row.subject_id).slice(-4)}:{})};
   });
  },
  async confirmLink(value:AccountLinkPrincipal,input:unknown):Promise<AccountLinkMutation>{
   const p=principal(value),r=request(input,'link');return run(p,async({client,state})=>{
    const old=await receipt(client,p,r,'link');if(old){if(old.kind!=='linked')return fail('ACCOUNT_UNCONFIRMED');return old;}
    cas(state,r);const row=await challenge(client,p,r.challengeId as string);fresh(row,await dbNow(client));
    if(row.state!=='proved'||! /^[1-9]\d{0,15}$/.test(row.subject_id)||! /^[a-f0-9]{64}$/.test(row.proof_key)||row.profile_session!==state.sessionId||scalar(row.profile_revision)!==state.revision)return fail('ACCOUNT_CHALLENGE_CONFLICT');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:telegram:'+row.subject_id]);
    const users=(await client.query('select id from users where id=$1 for share',[p.ownerId])).rows;if(users.length!==1)return fail('ACCOUNT_AUTH_REQUIRED');
    const links=await exactLinks(client,'telegram',row.subject_id);
    // Linking is strictly an unbound identity operation. Existing ownership is not a merge or a new link.
    if(links.length)return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    const ownedTelegram=(await client.query("select id from linked_accounts where user_id=$1 and provider='telegram' limit 1 for share",[p.ownerId])).rows;
    if(ownedTelegram.length)return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    const detached=(await client.query('select former_owner_id from lba_account_detached_identity where provider=$1 and subject_digest=$2 for update',['telegram',sha(['telegram',row.subject_id])])).rows;
    if(detached.length>1||detached.length===1&&detached[0].former_owner_id!==p.ownerId)return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    if((await client.query('select id from users where id=$1 for share',['tg_'+row.subject_id])).rows.length)return fail('ACCOUNT_RECONCILIATION_REQUIRED');
    const id=randomUUID(),now=await dbNow(client);fresh(row,now);
    await client.query("insert into linked_accounts(id,user_id,provider,provider_id,display_name) values($1,$2,'telegram',$3,'Telegram')",[id,p.ownerId,row.subject_id]);
    await client.query("update lba_account_link_challenge set state='linked' where id=$1",[row.id]);
    await client.query('delete from lba_account_detached_identity where provider=$1 and subject_digest=$2 and former_owner_id=$3',['telegram',sha(['telegram',row.subject_id]),p.ownerId]);
    const result:AccountLinkMutation={kind:'linked',operationId:r.id as string,provider:'telegram',linkId:id,authEpoch:p.authEpoch,reauthenticate:false};
    await save(client,p,r,'link',result,now);fresh(row,await dbNow(client));return result;
   });
  },
  /** Server-only hook AFTER actual provider verification and durable session save.
   * This is not an HTTP proof assertion and must never consume body/query claims. */
  async recordVerifiedLogin(value:AccountLinkPrincipal,input:{receiptId:string;provider:'telegram'|'replit';providerId:string;verifiedAt:string;validUntil:string}):Promise<void>{
   const p=principal(value),v=closed(input,['receiptId','provider','providerId','verifiedAt','validUntil']);
   if(!text(v.receiptId,512)||!provider(v.provider)||!text(v.providerId)||!validInstant(v.verifiedAt)||!validInstant(v.validUntil))return fail('ACCOUNT_INVALID_REQUEST');
   return run(p,async({client})=>{
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:'+v.provider+':'+v.providerId]);
    const links=await exactLinks(client,v.provider as string,v.providerId as string);if(links.length!==1||links[0].ownerId!==p.ownerId)return fail('ACCOUNT_LOGIN_PROOF_UNCONFIRMED');
    const now=await dbNow(client),at=Date.parse(v.verifiedAt as string),until=Date.parse(v.validUntil as string);
    if(at>now||now-at>30000||until<=now)return fail('ACCOUNT_LOGIN_PROOF_UNCONFIRMED');
    const expires=Math.min(until,at+900000),key=mac(['account-verified-login/1',v.provider,v.receiptId]),inputDigest=sha({owner:p.ownerId,binding:binding(p),epoch:p.authEpoch,input:v});
    const prior=(await client.query('select input_digest from lba_account_verified_login where proof_key=$1 for update',[key])).rows;
    if(prior.length){if(prior.length!==1||prior[0].input_digest!==inputDigest)return fail('ACCOUNT_OPERATION_CONFLICT');return;}
    await client.query('insert into lba_account_verified_login(proof_key,owner_id,session_binding,auth_epoch,link_id,provider,subject_digest,verified_at,expires_at,input_digest) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[key,p.ownerId,binding(p),p.authEpoch,links[0].id,v.provider,sha([v.provider,v.providerId]),new Date(at).toISOString(),new Date(expires).toISOString(),inputDigest]);
   });
  },
  async listAccounts(value:AccountLinkPrincipal):Promise<{links:Array<{id:string;provider:'telegram'|'replit';linkRevision:string}>;authEpoch:number}>{
   const p=principal(value);return run(p,async({client})=>{
    const rows=(await client.query('select id,user_id as "ownerId",provider,provider_id as "providerId",created_at as "createdAt" from linked_accounts where user_id=$1 order by id limit 101 for share',[p.ownerId])).rows;
    if(rows.length>100||rows.some(r=>r.ownerId!==p.ownerId||!provider(r.provider)))return fail('ACCOUNT_UNCONFIRMED');
    return {links:rows.map(r=>({id:r.id,provider:r.provider,linkRevision:accountLinkRevision(r)})),authEpoch:p.authEpoch};
   });
  },
  async unlink(value:AccountLinkPrincipal,input:unknown):Promise<AccountLinkMutation>{
   const p=principal(value),r=request(input,'unlink');return run(p,async({client,state})=>{
    const old=await receipt(client,p,r,'unlink');if(old){if(old.kind!=='unlinked')return fail('ACCOUNT_UNCONFIRMED');return old;}
    // Discover the exact identity under the owner lock, then take identity BEFORE
    // link row locks, matching login/resolver writers rather than inverting them.
    cas(state,r);const rows=(await client.query('select id,user_id as "ownerId",provider,provider_id as "providerId",created_at as "createdAt" from linked_accounts where id=$1 and user_id=$2',[r.linkId,p.ownerId])).rows,link=rows[0];
    if(rows.length!==1||!provider(link.provider)||accountLinkRevision(link)!==r.linkRevision)return fail('ACCOUNT_LINK_CONFLICT');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:'+link.provider+':'+link.providerId]);
    const exact=await exactLinks(client,link.provider,link.providerId);if(exact.length!==1||exact[0].ownerId!==p.ownerId||exact[0].id!==link.id)return fail('ACCOUNT_LINK_CONFLICT');
    const now=await dbNow(client);
    const alternatives=(await client.query(`select p.link_id,p.provider,p.subject_digest,p.verified_at,p.expires_at,l.id,l.provider_id as "providerId"
     from lba_account_verified_login p join linked_accounts l on l.id=p.link_id and l.user_id=p.owner_id and l.provider=p.provider
     join users u on u.id=l.user_id where p.owner_id=$1 and p.session_binding=$2 and p.auth_epoch=$3 and l.id<>$4
     and p.verified_at<=$5 and p.expires_at>$5 order by p.proof_key limit 101 for share of p,l,u`,[p.ownerId,binding(p),p.authEpoch,link.id,new Date(now).toISOString()])).rows;
    let remainingUntil=0;
    for(const a of alternatives){
     const at=instant(a.verified_at),until=instant(a.expires_at);if(!provider(a.provider)||!text(a.providerId)||a.link_id!==a.id||a.subject_digest!==sha([a.provider,a.providerId])||!at||!until||Date.parse(at)>now||now-Date.parse(at)>900000||Date.parse(until)<=now)continue;
     const current=await exactLinks(client,a.provider,a.providerId);if(current.length===1&&current[0].id===a.id&&current[0].ownerId===p.ownerId)remainingUntil=Math.max(remainingUntil,Math.min(Date.parse(until),Date.parse(at)+900000));
    }
    if(remainingUntil<=await dbNow(client)||alternatives.length>100)return fail('ACCOUNT_LAST_LOGIN_REQUIRED');
    if(p.authEpoch>=Number.MAX_SAFE_INTEGER)return fail('ACCOUNT_UNCONFIRMED');const next=p.authEpoch+1;
    await client.query('insert into lba_account_detached_identity(provider,subject_digest,former_owner_id,auth_epoch,detached_at) values($1,$2,$3,$4,$5) on conflict(provider,subject_digest) do update set former_owner_id=excluded.former_owner_id,auth_epoch=excluded.auth_epoch,detached_at=excluded.detached_at',[link.provider,sha([link.provider,link.providerId]),p.ownerId,next,new Date(now).toISOString()]);
    const deleted=await client.query('delete from linked_accounts where id=$1 and user_id=$2',[link.id,p.ownerId]);if(deleted.rowCount!==1)return fail('ACCOUNT_LINK_CONFLICT');
    await client.query('insert into lba_owner_auth_epoch(owner_id,auth_epoch) values($1,$2) on conflict(owner_id) do update set auth_epoch=excluded.auth_epoch',[p.ownerId,next]);
    await client.query("update lba_account_link_challenge set state='cancelled' where owner_id=$1 and state in ('pending','proved')",[p.ownerId]);
    const result:AccountLinkMutation={kind:'unlinked',operationId:r.id as string,provider:link.provider,linkId:link.id,authEpoch:next,reauthenticate:true};
    await save(client,p,r,'unlink',result,now);
    if(remainingUntil<=await dbNow(client))return fail('ACCOUNT_LAST_LOGIN_REQUIRED');return result;
   });
  },
  async recoverOperation(value:AccountLinkPrincipal,input:unknown):Promise<{kind:'recovery';state:'recorded';result:AccountLinkResult}|{kind:'recovery';state:'not_recorded'}>{
   const p=principal(value),v=closed(input,['kind','request']);if(!['challenge','link','unlink'].includes(v.kind as string))return fail('ACCOUNT_INVALID_REQUEST');
   const kind=v.kind as 'challenge'|'link'|'unlink',r=request(v.request,kind);
   // No canonical context/bootstrap is needed for immutable readback. READ
   // COMMITTED is essential: control is read before waiting for the owner lock,
   // but the ledger SELECT must see a predecessor that commits while we wait.
   enabled();let c;try{c=await o.pool.connect();}catch{return fail('ACCOUNT_UNCONFIRMED');}
   try{
    await c.query('begin isolation level read committed');
    const rows=(await c.query('select control_epoch,writer_mode from lba_production_control where id=true for share')).rows;
    if(rows.length!==1||scalar(rows[0].control_epoch)!==o.expectedControlEpoch||rows[0].writer_mode!=='canonical')return fail('ACCOUNT_DISABLED');
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba-production-owner:'+p.ownerId]);
    const old=await recoveryReceipt(c,p,r,kind),result=old?{kind:'recovery' as const,state:'recorded' as const,result:old}:{kind:'recovery' as const,state:'not_recorded' as const};
    await c.query('commit');return result;
   }catch(e){try{await c.query('rollback');}catch{}if(e instanceof AccountLinkError)throw e;return fail('ACCOUNT_UNCONFIRMED');}
   finally{try{c.release();}catch{/* A read-only release failure cannot create a mutation. */}}
  },
 });
}
export type AccountLinkService=ReturnType<typeof createAccountLinks>;
