import {createHash,randomUUID} from 'node:crypto';
import {validInstant} from '../../shared/schedule-core.ts';
import type {BotInput} from '../../shared/bot/types.ts';
import {TELEGRAM_INBOX_BOT_ID,type TelegramPrivateInput,type TelegramInboxPool,type TelegramInboxClient,type TelegramInboxQuery} from './telegram-inbox.ts';
import type {createProductionProfileStore,ProductionBotCommitGuard,ProductionProfileReceipt} from './profile-store.ts';
import type {VerifiedLegacyPrincipal} from './profile-reader.ts';

export const TELEGRAM_PROCESSOR_VERSION='lba-telegram-processor/1' as const;
/** Explicit additive migration. No startup, seed, reset, dequeue/send or DDL execution. */
export const TELEGRAM_PROCESSOR_SCHEMA_SQL=`
create table if not exists lba_production_telegram_processing (
 bot_id varchar(32) not null,update_id bigint not null,chat_key varchar(96) not null,control_epoch bigint not null,
 ingress_sha256 char(64) not null,input_sha256 char(64) not null,
 status text not null check(status in ('leased','dispatching','uncertain','held','processed')),
 lease_token uuid,generation bigint not null check(generation>0 and generation<=9007199254740991),
 lease_until timestamptz,attempts integer not null check(attempts>0),
 bound_owner_id varchar(255),identity_revision char(64),dispatch_started_at timestamptz,
 last_error text,canonical_receipt jsonb,receipt jsonb,created_at timestamptz not null,updated_at timestamptz not null,
 primary key(bot_id,update_id),foreign key(bot_id,update_id) references lba_production_telegram_inbox(bot_id,update_id),
 check((bound_owner_id is null and identity_revision is null) or (bound_owner_id is not null and identity_revision is not null)),
 check((status='processed' and canonical_receipt is not null and receipt is not null and lease_token is null and lease_until is null)
 or (status='held' and receipt is null and lease_token is null and lease_until is null)
 or (status in ('leased','dispatching','uncertain') and lease_token is not null and lease_until is not null and receipt is null))
);
create index if not exists lba_production_telegram_processing_chat on lba_production_telegram_processing(bot_id,chat_key,control_epoch,update_id);
create table if not exists lba_production_telegram_processor_scan (
 bot_id varchar(32) not null,control_epoch bigint not null check(control_epoch>0),
 after_update_id bigint not null check(after_update_id>=0 and after_update_id<=4503599627370495),
 updated_at timestamptz not null,primary key(bot_id,control_epoch)
);
`;
export type TelegramOwnerResolution={status:'verified';ownerId:string;revisionId:string}|{status:'missing'|'ambiguous'|'dangling'};
export type TelegramOwnerResolver=(client:TelegramInboxQuery,actorTelegramId:string)=>Promise<TelegramOwnerResolution>;
export type TelegramProcessorCode='PROCESSOR_DISABLED'|'PROCESSOR_CONTROL_REJECTED'|'PROCESSOR_EPOCH_CONFLICT'|'PROCESSOR_STORAGE_UNAVAILABLE'|'PROCESSOR_COMMIT_UNKNOWN'|'PROCESSOR_SCAN_BUSY'|
 'INVALID_INBOX_WORK'|'INBOX_WORK_CHANGED'|'IDENTITY_MISSING'|'IDENTITY_AMBIGUOUS'|'IDENTITY_DANGLING'|'IDENTITY_CHANGED'|'LEASE_LOST'|'LEASE_EXPIRED'|
 'ORDER_BLOCKED'|'LATE_UPDATE'|'RETRY_EXHAUSTED'|'CANONICAL_UNKNOWN'|'CANONICAL_RECEIPT_INVALID'|'CANONICAL_CONFLICT'|'DOMAIN_REPAIR_REQUIRED';
export interface TelegramProcessingReceipt{
 version:typeof TELEGRAM_PROCESSOR_VERSION;phase:'canonical_confirmed';botId:typeof TELEGRAM_INBOX_BOT_ID;updateId:string;controlEpoch:number;
 canonicalReceiptId:string;canonicalSessionRevision:number;domainOutcome:'committed'|'handled_rejection';replyOutbox:'pending'|'none';recordedAt:string;
}
export type TelegramProcessorResult={status:'processed';receipt:TelegramProcessingReceipt;replayed:boolean}|
 {status:'idle'|'busy'|'held'|'unknown'|'unavailable';code?:TelegramProcessorCode;updateId?:string};
type CanonicalStore=Pick<ReturnType<typeof createProductionProfileStore>,'commitGuardedBotInput'|'recoverReceipt'>;
export interface TelegramProcessorOptions{
 enabled?:boolean;expectedBotId:typeof TELEGRAM_INBOX_BOT_ID;expectedControlEpoch:number;pool:TelegramInboxPool;store:CanonicalStore;
 now:()=>string;leaseMs?:number;maxAttempts?:number;resolveOwner?:TelegramOwnerResolver;
}
class ProcessorRefusal extends Error{readonly code:TelegramProcessorCode;constructor(code:TelegramProcessorCode){super(code);this.code=code;}}
const fail=(code:TelegramProcessorCode):never=>{throw new ProcessorRefusal(code);};
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=255):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)<=2**52-1;
const integer=(v:unknown,min:number,max=Number.MAX_SAFE_INTEGER):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const keys=(v:Record<string,unknown>,allowed:string[],required=allowed)=>Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k));
const instant=(v:unknown):string=>{const s=v instanceof Date?v.toISOString():v;if(!validInstant(s))return fail('INVALID_INBOX_WORK');return s;};
const CHAT=(alias:string)=>`case when ${alias}.private_input->>'chatId' ~ '^[1-9][0-9]{0,15}$' then ${alias}.private_input->>'chatId' else 'invalid:'||${alias}.update_id::text end`;
const SOURCE_FIELDS=`i.bot_id as "botId",i.update_id as "updateId",i.control_epoch as "controlEpoch",i.payload_sha256 as "ingressSha",i.disposition,i.event_kind as "eventKind",i.ignored_reason as "ignoredReason",i.private_input as "privateInput",i.received_at as "receivedAt",${CHAT('i')} as "chatKey"`;
const JOB_FIELDS=`bot_id as "botId",update_id as "updateId",chat_key as "chatKey",control_epoch as "controlEpoch",ingress_sha256 as "ingressSha",input_sha256 as "inputSha",status,lease_token as "leaseToken",generation,lease_until as "leaseUntil",attempts,bound_owner_id as "ownerId",identity_revision as "identityRevision",dispatch_started_at as "dispatchStartedAt",last_error as "lastError",canonical_receipt as "canonicalReceipt",receipt,lease_until>clock_timestamp() as "leaseFresh"`;
const JOB=`select ${JOB_FIELDS} from lba_production_telegram_processing where bot_id=$1 and update_id=$2`;
const SOURCE=`select ${SOURCE_FIELDS} from lba_production_telegram_inbox i where i.bot_id=$1 and i.update_id=$2`;
const HEAD=`select ${SOURCE_FIELDS} from lba_production_telegram_inbox i left join lba_production_telegram_processing p on p.bot_id=i.bot_id and p.update_id=i.update_id where i.bot_id=$1 and ${CHAT('i')}=$2 and i.disposition='accepted' and (p.status is null or p.status<>'processed') order by i.update_id limit 1`;
const CANDIDATES=`select ${SOURCE_FIELDS} from lba_production_telegram_inbox i left join lba_production_telegram_processing p on p.bot_id=i.bot_id and p.update_id=i.update_id
 where i.bot_id=$1 and i.update_id>$2::bigint and i.disposition='accepted' and (p.status is null or p.status<>'processed')
 and (p.status is null or (p.status in ('leased','dispatching','uncertain') and p.lease_until<=clock_timestamp()))
 and not exists(select 1 from lba_production_telegram_inbox h left join lba_production_telegram_processing hp on hp.bot_id=h.bot_id and hp.update_id=h.update_id
 where h.bot_id=i.bot_id and ${CHAT('h')}=${CHAT('i')} and h.disposition='accepted' and h.update_id<i.update_id and (hp.status is null or hp.status<>'processed'))
 order by i.update_id limit 32`;

/** Exact existing explicit Telegram link only. FOR SHARE rows live inside the caller
 * canonical transaction during a guard; missing/ambiguous identities are never created.
 */
export async function resolveCurrentTelegramOwner(client:TelegramInboxQuery,actorTelegramId:string):Promise<TelegramOwnerResolution>{
 if(!id(actorTelegramId))return fail('INVALID_INBOX_WORK');
 const links=await client.query("select id,user_id as \"ownerId\",provider_id as \"actorId\" from linked_accounts where provider='telegram' and provider_id=$1 order by id for share",[actorTelegramId]);
 if(!links.rows.length)return {status:'missing'};if(links.rows.length!==1)return {status:'ambiguous'};
 const row=links.rows[0];if(!plain(row)||!keys(row,['id','ownerId','actorId'])||!text(row.id)||!text(row.ownerId)||row.actorId!==actorTelegramId)return {status:'ambiguous'};
 const users=await client.query('select id from users where id=$1 for share',[row.ownerId]);
 if(users.rows.length!==1||!plain(users.rows[0])||!keys(users.rows[0],['id'])||users.rows[0].id!==row.ownerId)return {status:'dangling'};
 return {status:'verified',ownerId:row.ownerId,revisionId:hash({version:'lba-telegram-owner/1',provider:'telegram',linkId:row.id,ownerId:row.ownerId,actorId:actorTelegramId})};
}
interface Work{updateId:string;chatKey:string;controlEpoch:number;ingressSha:string;inputSha:string;privateInput:TelegramPrivateInput;input:BotInput}
function native(row:any):Work{
 if(!plain(row)||row.botId!==TELEGRAM_INBOX_BOT_ID||!id(String(row.updateId))||!integer(Number(row.controlEpoch),1)||!text(row.chatKey,96)||typeof row.ingressSha!=='string'||! /^[a-f0-9]{64}$/.test(row.ingressSha)||row.disposition!=='accepted'||row.ignoredReason!==null)return fail('INVALID_INBOX_WORK');
 instant(row.receivedAt);const p=row.privateInput;
 if(!plain(p)||!keys(p,['version','botId','updateId','actorTelegramId','chatId','messageId','input','callbackQueryId'],['version','botId','updateId','actorTelegramId','chatId','messageId','input'])||
  p.version!=='lba-telegram-private-input/1'||p.botId!==TELEGRAM_INBOX_BOT_ID||p.updateId!==String(row.updateId)||!id(p.actorTelegramId)||p.chatId!==p.actorTelegramId||row.chatKey!==p.chatId||!integer(p.messageId,1,2**52-1)||!plain(p.input)||p.input.id!==`tg:${TELEGRAM_INBOX_BOT_ID}:${p.updateId}`)return fail('INVALID_INBOX_WORK');
 if(row.eventKind==='message'){
  if(!keys(p.input,['id','kind','text'])||!['command','text'].includes(p.input.kind)||typeof p.input.text!=='string'||!p.input.text.length||p.input.text.length>4096||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(p.input.text)||p.callbackQueryId!==undefined||(p.input.kind==='command')!==p.input.text.trimStart().startsWith('/'))return fail('INVALID_INBOX_WORK');
 }else if(row.eventKind==='callback'){
  if(!keys(p.input,['id','kind','callbackId'])||p.input.kind!=='callback'||!text(p.input.callbackId,64)||Buffer.byteLength(p.input.callbackId)>64||!text(p.callbackQueryId,256)||/[^\x21-\x7e]/.test(p.callbackQueryId))return fail('INVALID_INBOX_WORK');
 }else return fail('INVALID_INBOX_WORK');
 return {updateId:p.updateId,chatKey:p.chatId,controlEpoch:Number(row.controlEpoch),ingressSha:row.ingressSha,inputSha:hash(p),privateInput:structuredClone(p) as TelegramPrivateInput,input:structuredClone(p.input) as BotInput};
}
interface Claim extends Work{leaseToken:string;generation:number;ownerId:string|null;identityRevision:string|null}
function same(job:any,claim:Claim){return job&&job.botId===TELEGRAM_INBOX_BOT_ID&&String(job.updateId)===claim.updateId&&job.chatKey===claim.chatKey&&Number(job.controlEpoch)===claim.controlEpoch&&job.ingressSha===claim.ingressSha&&job.inputSha===claim.inputSha&&job.leaseToken===claim.leaseToken&&Number(job.generation)===claim.generation;}
function confirmed(value:unknown,claim:Claim):ProductionProfileReceipt{
 const v=value as ProductionProfileReceipt;
 if(!plain(value)||!keys(value,['runtime','id','inputId','channel','committed','sessionId','previousRevision','sessionRevision','controlEpoch','recordedAt','delivery','outboxIds','rejected'])||v.runtime!=='production'||v.channel!=='bot'||v.committed!==true||v.inputId!=='bot:'+claim.input.id||!text(v.id,128)||!text(v.sessionId,128)||!integer(v.previousRevision,0)||!integer(v.sessionRevision,v.previousRevision)||v.sessionRevision>v.previousRevision+1||v.controlEpoch!==claim.controlEpoch||!validInstant(v.recordedAt)||!Array.isArray(v.outboxIds)||v.outboxIds.length>100||v.outboxIds.some(i=>!text(i,128))||!['pending','none'].includes(v.delivery)||Boolean(v.outboxIds.length)!==(v.delivery==='pending')||v.rejected!==null&&!text(v.rejected,128))return fail('CANONICAL_RECEIPT_INVALID');
 return structuredClone(v);
}
function processingReceipt(value:unknown,updateId:string,epoch:number):TelegramProcessingReceipt{
 const v=value as TelegramProcessingReceipt;
 if(!plain(value)||!keys(value,['version','phase','botId','updateId','controlEpoch','canonicalReceiptId','canonicalSessionRevision','domainOutcome','replyOutbox','recordedAt'])||v.version!==TELEGRAM_PROCESSOR_VERSION||v.phase!=='canonical_confirmed'||v.botId!==TELEGRAM_INBOX_BOT_ID||v.updateId!==updateId||v.controlEpoch!==epoch||!text(v.canonicalReceiptId,128)||!integer(v.canonicalSessionRevision,0)||!['committed','handled_rejection'].includes(v.domainOutcome)||!['pending','none'].includes(v.replyOutbox)||!validInstant(v.recordedAt))return fail('CANONICAL_RECEIPT_INVALID');return structuredClone(v);
}
export function createTelegramProcessor(options:TelegramProcessorOptions){
 const leaseMs=options?.leaseMs??15000,maxAttempts=options?.maxAttempts??5;
 if(!options||options.expectedBotId!==TELEGRAM_INBOX_BOT_ID||!integer(options.expectedControlEpoch,1)||options.enabled!==undefined&&typeof options.enabled!=='boolean'||!options.pool||typeof options.pool.connect!=='function'||!options.store||typeof options.store.commitGuardedBotInput!=='function'||typeof options.store.recoverReceipt!=='function'||typeof options.now!=='function'||!integer(leaseMs,50,30000)||!integer(maxAttempts,1,10)||options.resolveOwner!==undefined&&typeof options.resolveOwner!=='function')throw Error('INVALID_TELEGRAM_PROCESSOR_OPTIONS');
 const enabled=options.enabled===true,epoch=options.expectedControlEpoch,pool=options.pool,store=options.store,resolver=options.resolveOwner??resolveCurrentTelegramOwner;
 const now=()=>{const value=options.now();if(!validInstant(value))return fail('PROCESSOR_STORAGE_UNAVAILABLE');return value;};
 const authority=(ownerId:string):VerifiedLegacyPrincipal=>({kind:'verified_server_principal',ownerId,verified:true});
 async function tx<T>(work:(client:TelegramInboxClient)=>Promise<T>):Promise<T>{
  if(!enabled)return fail('PROCESSOR_DISABLED');let client:TelegramInboxClient;try{client=await pool.connect();}catch{return fail('PROCESSOR_STORAGE_UNAVAILABLE');}
  let begun=false,commitStarted=false,committed=false;
  try{await client.query('begin isolation level read committed');begun=true;
   const control=await client.query('select control_epoch as "controlEpoch",writer_mode as "writerMode" from lba_production_control where id=true for share');
   if(control.rows.length!==1||control.rows[0].writerMode!=='canonical')return fail('PROCESSOR_CONTROL_REJECTED');if(Number(control.rows[0].controlEpoch)!==epoch)return fail('PROCESSOR_EPOCH_CONFLICT');
   const value=await work(client);commitStarted=true;await client.query('commit');committed=true;return value;
  }catch(error){if(begun&&!committed)try{await client.query('rollback');}catch{}if(commitStarted)return fail('PROCESSOR_COMMIT_UNKNOWN');if(error instanceof ProcessorRefusal)throw error;return fail('PROCESSOR_STORAGE_UNAVAILABLE');}
  finally{try{client.release();}catch{if(committed)return fail('PROCESSOR_COMMIT_UNKNOWN');}}
 }
 const lock=async(client:TelegramInboxQuery,chat:string,tryOnly=false)=>{
  const r=await client.query(`select pg_${tryOnly?'try_':''}advisory_xact_lock(hashtextextended($1,0)) as locked`,[`lba-telegram-processor:${TELEGRAM_INBOX_BOT_ID}:${chat}`]);return !tryOnly||r.rows[0]?.locked===true;
 };
 async function held(client:TelegramInboxQuery,source:any,job:any,code:TelegramProcessorCode):Promise<TelegramProcessorResult>{
  if(job)await client.query("update lba_production_telegram_processing set status='held',lease_token=null,lease_until=null,last_error=$3,updated_at=clock_timestamp() where bot_id=$1 and update_id=$2",[TELEGRAM_INBOX_BOT_ID,String(source.updateId),code]);
  else await client.query(`insert into lba_production_telegram_processing(bot_id,update_id,chat_key,control_epoch,ingress_sha256,input_sha256,status,lease_token,generation,lease_until,attempts,last_error,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'held',null,1,null,1,$7,clock_timestamp(),clock_timestamp())`,[TELEGRAM_INBOX_BOT_ID,String(source.updateId),source.chatKey,Number(source.controlEpoch),typeof source.ingressSha==='string'&&/^[a-f0-9]{64}$/.test(source.ingressSha)?source.ingressSha:'0'.repeat(64),'0'.repeat(64),code]);
  return {status:'held',code,updateId:String(source.updateId)};
 }
 async function claim(target?:string):Promise<Claim|TelegramProcessorResult>{return tx(async client=>{
  let candidates:any[];
  if(target)candidates=(await client.query(SOURCE,[TELEGRAM_INBOX_BOT_ID,target])).rows;
  else{
   // A durable keyset cursor advances even when every chat in a bounded page is
   // locked. Restarting replicas cannot repeatedly starve the first free head33.
   await client.query('insert into lba_production_telegram_processor_scan(bot_id,control_epoch,after_update_id,updated_at) values($1,$2,0,clock_timestamp()) on conflict(bot_id,control_epoch) do nothing',[TELEGRAM_INBOX_BOT_ID,epoch]);
   const scan=await client.query('select after_update_id as "afterId" from lba_production_telegram_processor_scan where bot_id=$1 and control_epoch=$2 for update skip locked',[TELEGRAM_INBOX_BOT_ID,epoch]);
   if(scan.rows.length!==1)return {status:'busy',code:'PROCESSOR_SCAN_BUSY'};
   const after=String(scan.rows[0].afterId);if(!/^\d{1,16}$/.test(after)||!integer(Number(after),0,2**52-1))return fail('PROCESSOR_STORAGE_UNAVAILABLE');
   candidates=(await client.query(CANDIDATES,[TELEGRAM_INBOX_BOT_ID,after])).rows;
   if(!candidates.length&&after!=='0')candidates=(await client.query(CANDIDATES,[TELEGRAM_INBOX_BOT_ID,'0'])).rows;
   if(!candidates.length){await client.query('update lba_production_telegram_processor_scan set after_update_id=0,updated_at=clock_timestamp() where bot_id=$1 and control_epoch=$2',[TELEGRAM_INBOX_BOT_ID,epoch]);return {status:'idle'};}
  }
  for(const candidate of candidates){
   if(!target)await client.query('update lba_production_telegram_processor_scan set after_update_id=$3,updated_at=clock_timestamp() where bot_id=$1 and control_epoch=$2',[TELEGRAM_INBOX_BOT_ID,epoch,String(candidate.updateId)]);
   if(!text(candidate.chatKey,96)||!await lock(client,candidate.chatKey,true)){if(target)return {status:'busy',code:'PROCESSOR_SCAN_BUSY',updateId:target};continue;}
   const src=(await client.query(SOURCE,[TELEGRAM_INBOX_BOT_ID,String(candidate.updateId)])).rows[0];if(!src)continue;if(src.disposition!=='accepted')return {status:'idle'};
   const jobs=await client.query(JOB+' for update',[TELEGRAM_INBOX_BOT_ID,String(src.updateId)]);if(jobs.rows.length>1)return fail('PROCESSOR_STORAGE_UNAVAILABLE');const job=jobs.rows[0];
   if(job?.status==='processed')return {status:'processed',receipt:processingReceipt(job.receipt,String(src.updateId),epoch),replayed:true};
   if(job?.status==='held')return {status:'held',code:job.lastError,updateId:String(src.updateId)};
   const head=(await client.query(HEAD,[TELEGRAM_INBOX_BOT_ID,src.chatKey])).rows[0];if(!head||String(head.updateId)!==String(src.updateId))return {status:'busy',code:'ORDER_BLOCKED',updateId:String(src.updateId)};
   if(job&&job.leaseFresh===true)return {status:'busy',code:'LEASE_LOST',updateId:String(src.updateId)};
   if(Number(src.controlEpoch)!==epoch)return held(client,src,job,'PROCESSOR_EPOCH_CONFLICT');
   let work:Work;try{work=native(src);}catch{return held(client,src,job,'INVALID_INBOX_WORK');}
   if(job&&(job.ingressSha!==work.ingressSha||job.inputSha!==work.inputSha))return held(client,src,job,'INBOX_WORK_CHANGED');
   const high=(await client.query('select max(update_id)::text as high from lba_production_telegram_processing where bot_id=$1 and chat_key=$2 and control_epoch=$3 and dispatch_started_at is not null',[TELEGRAM_INBOX_BOT_ID,work.chatKey,epoch])).rows[0]?.high;
   if(high!==null&&high!==undefined&&BigInt(work.updateId)<BigInt(high))return held(client,src,job,'LATE_UPDATE');
   if(job&&Number(job.attempts)>=maxAttempts&&job.ownerId===null)return held(client,src,job,'RETRY_EXHAUSTED');
   const leaseToken=randomUUID(),generation=job?Number(job.generation)+1:1;if(!integer(generation,1))return fail('PROCESSOR_STORAGE_UNAVAILABLE');
   if(job)await client.query("update lba_production_telegram_processing set status='leased',lease_token=$3,generation=$4,lease_until=clock_timestamp()+($5::int*interval '1 millisecond'),attempts=attempts+1,last_error=null,updated_at=clock_timestamp() where bot_id=$1 and update_id=$2",[TELEGRAM_INBOX_BOT_ID,work.updateId,leaseToken,generation,leaseMs]);
   else await client.query(`insert into lba_production_telegram_processing(bot_id,update_id,chat_key,control_epoch,ingress_sha256,input_sha256,status,lease_token,generation,lease_until,attempts,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'leased',$7,1,clock_timestamp()+($8::int*interval '1 millisecond'),1,clock_timestamp(),clock_timestamp())`,[TELEGRAM_INBOX_BOT_ID,work.updateId,work.chatKey,epoch,work.ingressSha,work.inputSha,leaseToken,leaseMs]);
   return {...work,leaseToken,generation,ownerId:job?.ownerId??null,identityRevision:job?.identityRevision??null};
  }return candidates.length?{status:'busy',code:'PROCESSOR_SCAN_BUSY'}:{status:'idle'};
 });}
 async function mark(claimed:Claim,status:'held'|'uncertain',code:TelegramProcessorCode):Promise<TelegramProcessorResult>{return tx(async client=>{
  await lock(client,claimed.chatKey);const row=(await client.query(JOB+' for update',[TELEGRAM_INBOX_BOT_ID,claimed.updateId])).rows[0];if(!same(row,claimed))return {status:'busy',code:'LEASE_LOST',updateId:claimed.updateId};
  await client.query(`update lba_production_telegram_processing set status=$3,last_error=$4,lease_token=case when $3='held' then null else lease_token end,lease_until=case when $3='held' then null else clock_timestamp() end,updated_at=clock_timestamp() where bot_id=$1 and update_id=$2`,[TELEGRAM_INBOX_BOT_ID,claimed.updateId,status,code]);return {status:status==='held'?'held':'unknown',code,updateId:claimed.updateId};
 });}
 async function prepare(claimed:Claim):Promise<Claim|TelegramProcessorResult>{return tx(async client=>{
  await lock(client,claimed.chatKey);const row=(await client.query(JOB+' for update',[TELEGRAM_INBOX_BOT_ID,claimed.updateId])).rows[0];if(!same(row,claimed)||row.leaseFresh!==true)return {status:'busy',code:'LEASE_LOST',updateId:claimed.updateId};
  const source=(await client.query(SOURCE,[TELEGRAM_INBOX_BOT_ID,claimed.updateId])).rows[0];let current:Work;try{current=native(source);}catch{return held(client,source??claimed,row,'INVALID_INBOX_WORK');}
  if(current.ingressSha!==claimed.ingressSha||current.inputSha!==claimed.inputSha)return held(client,source,row,'INBOX_WORK_CHANGED');
  if(Number(row.attempts)>maxAttempts)return held(client,source,row,'RETRY_EXHAUSTED');
  const resolution=await resolver(client,claimed.privateInput.actorTelegramId);
  if(resolution.status!=='verified')return held(client,source,row,resolution.status==='missing'?'IDENTITY_MISSING':resolution.status==='dangling'?'IDENTITY_DANGLING':'IDENTITY_AMBIGUOUS');
  if(!text(resolution.ownerId)||! /^[a-f0-9]{64}$/.test(resolution.revisionId))return held(client,source,row,'IDENTITY_AMBIGUOUS');
  if(row.ownerId!==null&&(row.ownerId!==resolution.ownerId||row.identityRevision!==resolution.revisionId))return held(client,source,row,'IDENTITY_CHANGED');
  await client.query("update lba_production_telegram_processing set status='dispatching',bound_owner_id=$3,identity_revision=$4,dispatch_started_at=coalesce(dispatch_started_at,clock_timestamp()),updated_at=clock_timestamp() where bot_id=$1 and update_id=$2",[TELEGRAM_INBOX_BOT_ID,claimed.updateId,resolution.ownerId,resolution.revisionId]);
  return {...claimed,ownerId:resolution.ownerId,identityRevision:resolution.revisionId};
 });}
 async function finalize(claimed:Claim,canonicalReceipt:ProductionProfileReceipt):Promise<TelegramProcessorResult>{return tx(async client=>{
  await lock(client,claimed.chatKey);const row=(await client.query(JOB+' for update',[TELEGRAM_INBOX_BOT_ID,claimed.updateId])).rows[0];
  if(row?.status==='processed')return {status:'processed',receipt:processingReceipt(row.receipt,claimed.updateId,epoch),replayed:true};
  if(!same(row,claimed)||row.ownerId!==claimed.ownerId||row.identityRevision!==claimed.identityRevision)return {status:'busy',code:'LEASE_LOST',updateId:claimed.updateId};
  const receipt:TelegramProcessingReceipt={version:TELEGRAM_PROCESSOR_VERSION,phase:'canonical_confirmed',botId:TELEGRAM_INBOX_BOT_ID,updateId:claimed.updateId,controlEpoch:epoch,canonicalReceiptId:canonicalReceipt.id,canonicalSessionRevision:canonicalReceipt.sessionRevision,domainOutcome:canonicalReceipt.rejected?'handled_rejection':'committed',replyOutbox:canonicalReceipt.delivery,recordedAt:now()};
  await client.query("update lba_production_telegram_processing set status='processed',lease_token=null,lease_until=null,last_error=null,canonical_receipt=$3::jsonb,receipt=$4::jsonb,updated_at=clock_timestamp() where bot_id=$1 and update_id=$2",[TELEGRAM_INBOX_BOT_ID,claimed.updateId,JSON.stringify(canonicalReceipt),JSON.stringify(receipt)]);
  return {status:'processed',receipt,replayed:false};
 });}
 function guard(claimed:Claim,onRefusal:(code:TelegramProcessorCode)=>void):ProductionBotCommitGuard{return async({client,principal,request})=>{
  const refuse=(code:TelegramProcessorCode)=>{onRefusal(code);return false;};
  if(principal.ownerId!==claimed.ownerId||hash(request)!==hash({input:claimed.input}))return refuse('CANONICAL_CONFLICT');
  await lock(client,claimed.chatKey);const row=(await client.query(JOB+' for share',[TELEGRAM_INBOX_BOT_ID,claimed.updateId])).rows[0];
  if(!same(row,claimed)||row.status!=='dispatching'||row.ownerId!==claimed.ownerId||row.identityRevision!==claimed.identityRevision)return refuse('LEASE_LOST');if(row.leaseFresh!==true)return refuse('LEASE_EXPIRED');
  const source=(await client.query(SOURCE+' for share of i',[TELEGRAM_INBOX_BOT_ID,claimed.updateId])).rows[0];let current:Work;try{current=native(source);}catch{return refuse('INVALID_INBOX_WORK');}
  if(current.controlEpoch!==epoch||current.ingressSha!==claimed.ingressSha||current.inputSha!==claimed.inputSha)return refuse('INBOX_WORK_CHANGED');
  const head=(await client.query(HEAD,[TELEGRAM_INBOX_BOT_ID,claimed.chatKey])).rows[0];if(!head||String(head.updateId)!==claimed.updateId)return refuse('ORDER_BLOCKED');
  const owner=await resolver(client,claimed.privateInput.actorTelegramId);if(owner.status!=='verified'||owner.ownerId!==claimed.ownerId||owner.revisionId!==claimed.identityRevision)return refuse('IDENTITY_CHANGED');
  // The resolver can wait for row locks. Its completion is not proof that the lease
  // checked before the await is still live; fence and DB clock must be checked last.
  const final=(await client.query(JOB+' for share',[TELEGRAM_INBOX_BOT_ID,claimed.updateId])).rows[0];
  if(!same(final,claimed)||final.status!=='dispatching'||final.ownerId!==claimed.ownerId||final.identityRevision!==claimed.identityRevision)return refuse('LEASE_LOST');
  if(final.leaseFresh!==true)return refuse('LEASE_EXPIRED');
  return true;
 };}
 async function execute(target?:string):Promise<TelegramProcessorResult>{
  try{
   const selection=await claim(target);if('status'in selection)return selection;let claimed=selection;
   if(claimed.ownerId!==null){
    let recovered:unknown;try{recovered=await store.recoverReceipt(authority(claimed.ownerId),{channel:'bot',request:{input:claimed.input}});}catch(error){return await mark(claimed,error instanceof Error&&error.message==='PRODUCTION_INPUT_ID_CONFLICT'?'held':'uncertain',error instanceof Error&&error.message==='PRODUCTION_INPUT_ID_CONFLICT'?'CANONICAL_CONFLICT':'CANONICAL_UNKNOWN');}
    if(recovered!==null){let known:ProductionProfileReceipt;try{known=confirmed(recovered,claimed);}catch{return await mark(claimed,'uncertain','CANONICAL_RECEIPT_INVALID');}return await finalize(claimed,known);}
   }
   const prepared=await prepare(claimed);if('status'in prepared)return prepared;claimed=prepared;
   let refused:TelegramProcessorCode|null=null;
   let committed:Awaited<ReturnType<CanonicalStore['commitGuardedBotInput']>>;
   try{
    committed=await store.commitGuardedBotInput(authority(claimed.ownerId!),{input:claimed.input},guard(claimed,code=>{refused=code;}));
   }catch(error){
    if(refused)return await mark(claimed,refused==='LEASE_EXPIRED'||refused==='LEASE_LOST'?'uncertain':'held',refused);
    const code=error instanceof Error?error.message:'';
    if(code==='PRODUCTION_INPUT_ID_CONFLICT')return await mark(claimed,'held','CANONICAL_CONFLICT');
    if(code==='PRODUCTION_RESET_NOT_AUTHORIZED'||code==='PRODUCTION_EFFECT_HANDLER_REQUIRED'||/^(?:PROFILE_|LEGACY_|PRODUCTION_BOOTSTRAP_)/.test(code))return await mark(claimed,'held','DOMAIN_REPAIR_REQUIRED');
    return await mark(claimed,'uncertain','CANONICAL_UNKNOWN');
   }
   let known:ProductionProfileReceipt;try{known=confirmed(committed.receipt,claimed);}catch{return await mark(claimed,'uncertain','CANONICAL_RECEIPT_INVALID');}
   // Own-ledger finalization uncertainty is not a canonical command failure. Let the
   // outer boundary return PROCESSOR_COMMIT_UNKNOWN without overwriting a saved receipt.
   return await finalize(claimed,known);
  }catch(error){const code=error instanceof ProcessorRefusal?error.code:'PROCESSOR_STORAGE_UNAVAILABLE';return {status:code==='PROCESSOR_COMMIT_UNKNOWN'?'unknown':'unavailable',code};}
 }
 return Object.freeze({
  processNext:()=>execute(),
  processUpdate(updateId:string){if(!id(updateId))return Promise.resolve<TelegramProcessorResult>({status:'held',code:'INVALID_INBOX_WORK'});return execute(updateId);},
 });
}
