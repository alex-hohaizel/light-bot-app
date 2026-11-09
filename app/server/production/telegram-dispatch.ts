import {createHash} from 'node:crypto';
import type {DeliveryOutcome} from '../../shared/delivery-contract.ts';
import type {BotMessage,BotState} from '../../shared/bot/types.ts';
import type {ScheduleView} from '../../shared/product-contract.ts';
import {restoreBotState} from '../../shared/bot/engine.ts';
import {canDeliver,validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
import {planMatchesDisplay} from '../../shared/schedule-binding.ts';
import {resolveNotificationPolicy} from '../../shared/notification-policy.ts';
import {campaignOperationId,type CampaignEnvelope,type CampaignTelegramSender} from '../release/update-campaign.ts';
import {telegramKeyboardFromBotButtons,type TelegramAuthorizationPort,type TelegramAuthorizationRequest,type TelegramEffectResult,type TelegramTransport,type TelegramTransportReceipt} from './telegram-transport.ts';
import {createCallbackAckConsumer} from './telegram-callback-ack.ts';
import type {LegacyCampaignRecipientSubject} from './legacy-campaign-recipient.ts';
export {TELEGRAM_CALLBACK_ACK_SCHEMA_SQL} from './telegram-callback-ack.ts';

export const DISPATCH_BOT_ID='8577497098' as const;
export const DISPATCH_VERSION='lba-telegram-dispatch/1' as const;
/** Explicit additive migration; the operator creates the bot-state row separately. */
export const TELEGRAM_DISPATCH_SCHEMA_SQL=`
create table if not exists lba_production_telegram_bot_state (
 bot_id varchar(32) primary key,hold_reason text,hold_operation char(64),
 cooldown_until timestamptz,next_send_at timestamptz,updated_at timestamptz not null
);
create table if not exists lba_production_telegram_chat_state (
 bot_id varchar(32) not null,chat_key char(64) not null,owner_id varchar(255) not null,
 reachability text not null default 'unknown' check(reachability in ('unknown','reachable','forbidden')),
 next_send_at timestamptz,last_dispatch_at timestamptz,updated_at timestamptz not null,primary key(bot_id,chat_key)
);
create table if not exists lba_production_telegram_dispatch_jobs (
 operation_id char(64) primary key,queue_seq bigserial unique,bot_id varchar(32) not null,
 source_kind text not null check(source_kind in ('profile','campaign')),source_id text not null,owner_id varchar(255) not null,
 session_id varchar(128) not null,source_revision bigint not null,source_ordinal integer not null,control_epoch bigint not null,
 payload_digest char(64) not null,payload jsonb not null,recipient_ref varchar(160) not null,
 chat_key char(64),mapping_revision varchar(160),
 state text not null default 'pending' check(state in ('pending','prepared','dispatching','retry_wait','sent','cancelled','not_sent','unknown','held')),
 fence bigint not null default 0,attempts integer not null default 0,not_before timestamptz,
 provider_receipt varchar(128),last_reason varchar(100),created_at timestamptz not null,updated_at timestamptz not null,
 unique(bot_id,source_kind,source_id)
);
create index if not exists lba_production_telegram_dispatch_head on lba_production_telegram_dispatch_jobs(bot_id,owner_id,queue_seq) where state in ('pending','prepared','dispatching','retry_wait','unknown','held');
create table if not exists lba_production_telegram_dispatch_attempts (
 operation_id char(64) not null references lba_production_telegram_dispatch_jobs(operation_id),fence bigint not null,
 worker_id varchar(128) not null,control_epoch bigint not null,
 state text not null check(state in ('prepared','dispatching','not_dispatched','sent','rate_limited','not_sent','unknown','cancelled')),
 prepared_at timestamptz not null,dispatch_marked_at timestamptz,finished_at timestamptz,
 outcome jsonb,receipt jsonb,primary key(operation_id,fence)
);
-- Explicit additive subject migration. Legacy endpoints never acquire an
-- invented owner/session merely to enter the existing durable coordinator.
alter table lba_production_telegram_dispatch_jobs add column if not exists recipient_kind text not null default 'account';
alter table lba_production_telegram_dispatch_jobs alter column owner_id drop not null;
alter table lba_production_telegram_dispatch_jobs alter column session_id drop not null;
alter table lba_production_telegram_chat_state add column if not exists recipient_kind text not null default 'account';
alter table lba_production_telegram_chat_state alter column owner_id drop not null;
do $lba_subject$ begin
 if not exists(select 1 from pg_constraint where conrelid='lba_production_telegram_dispatch_jobs'::regclass and conname='lba_dispatch_recipient_subject') then
  alter table lba_production_telegram_dispatch_jobs add constraint lba_dispatch_recipient_subject check(
   (recipient_kind='account' and owner_id is not null and session_id is not null) or
   (recipient_kind='legacy_subscription' and source_kind='campaign' and owner_id is null and session_id is null and recipient_ref like 'legacy:%'));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='lba_production_telegram_chat_state'::regclass and conname='lba_chat_recipient_subject') then
  alter table lba_production_telegram_chat_state add constraint lba_chat_recipient_subject check(
   (recipient_kind='account' and owner_id is not null) or (recipient_kind='legacy_subscription' and owner_id is null));
 end if;
end $lba_subject$;
`;
export interface DispatchClient {query(sql:string,values?:any[]):Promise<{rows:any[];rowCount:number|null}>;release(error?:Error):void}
export interface DispatchPool {connect():Promise<DispatchClient>}
export interface DispatchPayload {message:BotMessage;schedule?:ScheduleView;campaign?:CampaignEnvelope;
 briefing?:{id:string;serviceDate:string;packetDigest:string;partIndex:number;totalParts:number}}
export interface DispatchJob {
 recipientKind?:'account';
 operationId:string;queueSeq:string;sourceKind:'profile'|'campaign';sourceId:string;ownerId:string;sessionId:string;
 sourceRevision:number;sourceOrdinal:number;controlEpoch:number;payloadDigest:string;payload:DispatchPayload;recipientRef:string;
 chatKey:string|null;mappingRevision:string|null;state:string;fence:number;attempts:number;notBefore:string|null;
}
export interface LegacyCampaignDispatchJob extends Omit<DispatchJob,'recipientKind'|'ownerId'|'sessionId'|'sourceKind'> {
 recipientKind:'legacy_subscription';sourceKind:'campaign';ownerId:null;sessionId:null;
}
export type DispatchQueuedJob=DispatchJob|LegacyCampaignDispatchJob;
const legacyJob=(job:DispatchQueuedJob):job is LegacyCampaignDispatchJob=>job.recipientKind==='legacy_subscription';
export type DispatchEligibility={eligible:false;reason:'revoked'|'paused'|'deleted'|'binding_changed'|'source_unverified'|'unlinked'|'not_eligible';retryAt?:string}|{
 eligible:true;ownerId:string;recipientRef:string;chatId:string;chatType:'private';mappingRevision:string;expiresAt:string;
 sourceRevision?:string;
 /** Trusted event repository must prove reminder edge/window or schedule-event eligibility.
  * Canonical outbox v1 alone cannot establish these facts from message text. */
 eventProof?:{kind:'schedule_event'|'reminder'|'morning_briefing';revision:string;scheduleRevisionId:string;sourceRevision:string;serviceDate:string;expiresAt:string};
};
export interface DispatchEligibilityRequest {
 client:DispatchClient;job:Readonly<DispatchJob>;profile:Readonly<BotState>;now:string;
 phase:'prepare'|'dispatch'|'native';native?:Readonly<TelegramAuthorizationRequest>;signal:AbortSignal;
}
export interface DispatchIdentityReadGrant {
 actorId:string;capabilityId:string;botId:typeof DISPATCH_BOT_ID;controlEpoch:number;expiresAt:string;
}
export interface DispatchOptions {
 enabled?:boolean;expectedBotId:typeof DISPATCH_BOT_ID;expectedControlEpoch:number;workerId:string;pool:DispatchPool;now:()=>string;
 resolveEligibility:(request:DispatchEligibilityRequest)=>Promise<DispatchEligibility>;
 identityReadGrant?:(request:{actorId:string;capabilityId:string;botId:typeof DISPATCH_BOT_ID;controlEpoch:number;operationId:string;signal:AbortSignal})=>Promise<DispatchIdentityReadGrant|null>;
 createTransport:(request:{authorize:TelegramAuthorizationPort;job:Readonly<DispatchJob>;renderKey:string})=>TelegramTransport;
 createLegacyTransport?:(request:{authorize:TelegramAuthorizationPort;job:Readonly<LegacyCampaignDispatchJob>})=>TelegramTransport;
 createCallbackTransport?:(request:{authorize:TelegramAuthorizationPort;operationId:string;callbackRef:string;recipientRef:string})=>TelegramTransport;
 callbacks?:{enabled?:boolean;maxAgeMs?:number};
 resolveCampaignOwner?:(request:{client:DispatchClient;envelope:Readonly<CampaignEnvelope>;now:string;signal:AbortSignal})=>Promise<{ownerId:string;expiresAt:string}|null>;
 resolveLegacyCampaignRecipient?:(request:{client:DispatchClient;envelope:Readonly<CampaignEnvelope>;now:string;signal:AbortSignal})=>Promise<LegacyCampaignRecipientSubject|null>;
 limits?:{scan?:number;maxAttempts?:number;minBotIntervalMs?:number;minChatIntervalMs?:number;preflightRetryMs?:number};
}
export type DispatchRunResult={kind:'disabled'|'idle'|'busy'|'deferred'|'held'|'cancelled'|'completed'|'unavailable'|'unknown';
 operationId?:string;reason?:string;retryAt?:string;outcome?:DeliveryOutcome;receipt?:TelegramTransportReceipt};
export interface TelegramDispatcher {
 dispatchNextPending(signal:AbortSignal):Promise<DispatchRunResult>;
 dispatchNextCallbackAck(signal:AbortSignal):Promise<DispatchRunResult>;
 dispatchCampaign(envelope:Readonly<CampaignEnvelope>,signal:AbortSignal):Promise<DispatchRunResult>;
 recoverOperation(operationId:string):Promise<{state:string;fence:number;outcome:DeliveryOutcome|null}|null>;
}
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const id=(v:unknown,max=160):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const hashPattern=/^[a-f0-9]{64}$/;
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export const profileDispatchOperationId=(outboxId:string)=>hash([DISPATCH_VERSION,DISPATCH_BOT_ID,'profile',outboxId]);
export const dispatchPayloadDigest=(payload:DispatchPayload)=>hash(payload);
export const dispatchBotLockKey=()=>`lba-telegram-dispatch-bot:${DISPATCH_BOT_ID}`;
const nonterminal=['pending','prepared','dispatching','retry_wait','unknown','held'];
const notSent=(reason:string):DeliveryOutcome=>({kind:'not_sent',retryable:false,reason});
const unknown=(reason:string):DeliveryOutcome=>({kind:'unknown',reason});
const safeOutcome=(value:any):DeliveryOutcome=>{
 if(!plain(value))return unknown('dispatch_stored_outcome_unverified');
 if(value.kind==='sent'&&typeof value.receipt==='string'&&/^tg-msg-[1-9]\d{0,15}$/.test(value.receipt))return {kind:'sent',receipt:value.receipt};
 if(value.kind==='rate_limited'&&integer(value.retryAfterSeconds,1,86400))return {kind:'rate_limited',retryAfterSeconds:value.retryAfterSeconds};
 if(['unknown','not_sent'].includes(value.kind)&&typeof value.reason==='string'&&/^[a-z0-9_]{1,100}$/.test(value.reason)&&
  (value.kind==='unknown'||typeof value.retryable==='boolean'))return value.kind==='unknown'?unknown(value.reason):{kind:'not_sent',retryable:value.retryable,reason:value.reason};
 return unknown('dispatch_stored_outcome_unverified');
};
class DispatchError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
const fail=(code:string):never=>{throw new DispatchError(code);};
const date=(value:any):string|null=>value===null||value===undefined?null:value instanceof Date?value.toISOString():validInstant(value)?value:fail('dispatch_stored_date_invalid');
const decoded=(value:any):any=>typeof value==='string'?JSON.parse(value):value;
function keys(value:Record<string,any>,allowed:string[]){if(Object.keys(value).some(k=>!allowed.includes(k)))fail('dispatch_payload_invalid');}
/** Closed payload validation; native limits are checked without truncating content. */
export function checkedDispatchPayload(value:unknown):DispatchPayload {
 if(!plain(value))return fail('dispatch_payload_invalid');keys(value,['message','schedule','campaign','briefing']);
 const m=value.message;if(!plain(m))return fail('dispatch_payload_invalid');keys(m,['id','kind','text','buttons','commitBarrier','scheduleRevisionId']);
 if(!id(m.id)||!['reply','schedule','notification','error'].includes(m.kind)||typeof m.text!=='string'||!m.text.trim()||m.text.length>4096||!Array.isArray(m.buttons)||m.buttons.length>16||!['none','profile'].includes(m.commitBarrier))return fail('dispatch_payload_unsupported');
 for(const button of m.buttons){if(!plain(button)||Object.keys(button).sort().join(',')!=='callbackId,label'||!id(button.label,100)||!id(button.callbackId,128)||Buffer.byteLength(button.callbackId)>64)return fail('dispatch_payload_unsupported');}
 const message={id:m.id,kind:m.kind,text:m.text,buttons:m.buttons.map(b=>({label:b.label,callbackId:b.callbackId})),commitBarrier:m.commitBarrier,...(m.scheduleRevisionId?{scheduleRevisionId:m.scheduleRevisionId}:{})} as BotMessage;
 let schedule:ScheduleView|undefined;
 if(value.schedule!==undefined){
  const s=value.schedule;if(!plain(s))return fail('dispatch_payload_invalid');
  keys(s,['contractVersion','revisionId','addressId','addressLabel','localityLabel','operatorId','serviceDate','bindingRevisionId','namespace','targetId','timezone','status','dayCoverage','intervals','source','publishedAt','observedAt','freshness','synthetic','deliveryEligible','previousRevisionId','previousIntervals','notice']);
  if(!plain(s.source))return fail('dispatch_payload_invalid');keys(s.source,['id','name','url','revision','accessCost','verifiedLevel']);
  for(const intervals of [s.intervals,...(s.previousIntervals?[s.previousIntervals]:[])]){if(!Array.isArray(intervals))return fail('dispatch_payload_invalid');for(const i of intervals){if(!plain(i))return fail('dispatch_payload_invalid');keys(i,['startsAt','endsAt','startLocal','endLocal','kind']);}}
  try{validateScheduleView(s as ScheduleView);}catch{return fail('dispatch_payload_invalid');}
  if(s.synthetic!==false||message.scheduleRevisionId!==s.revisionId)return fail('dispatch_payload_invalid');schedule=structuredClone(s) as ScheduleView;
 }else if(message.scheduleRevisionId)return fail('dispatch_payload_invalid');
 if(value.campaign!==undefined)checkedCampaign(value.campaign);
 if(value.briefing!==undefined){
  const b=value.briefing;if(!plain(b)||Object.keys(b).sort().join(',')!=='id,packetDigest,partIndex,serviceDate,totalParts'||!id(b.id,128)||!/^\d{4}-\d{2}-\d{2}$/.test(b.serviceDate)||!hashPattern.test(b.packetDigest)||!integer(b.partIndex,0,99)||!integer(b.totalParts,1,100)||b.partIndex>=b.totalParts||message.kind!=='notification'||message.buttons.length||value.campaign!==undefined||schedule&&(b.totalParts!==1||b.serviceDate!==schedule.serviceDate))return fail('dispatch_payload_invalid');
 }
 return {message,...(schedule?{schedule}:{}),...(value.campaign?{campaign:structuredClone(value.campaign)}:{}),...(value.briefing?{briefing:structuredClone(value.briefing)}:{})};
}
function checkedCampaign(value:unknown):CampaignEnvelope {
 if(!plain(value))return fail('dispatch_campaign_invalid');keys(value,['releaseId','deploymentId','buildSha256','botId','origin','operationId','recipientRef','text','appUrl']);
 if(value.botId!==DISPATCH_BOT_ID||!id(value.releaseId)||!id(value.deploymentId)||!hashPattern.test(value.buildSha256)||!id(value.recipientRef)||value.operationId!==campaignOperationId(value.releaseId,value.recipientRef)||typeof value.text!=='string'||!value.text.trim()||value.text.length>4096)return fail('dispatch_campaign_invalid');
 try{const origin=new URL(value.origin),app=new URL(value.appUrl);if(origin.protocol!=='https:'||origin.origin!==value.origin||app.protocol!=='https:'||app.origin!==origin.origin||app.username||app.password||origin.username||origin.password)fail('dispatch_campaign_invalid');}catch{return fail('dispatch_campaign_invalid');}
 return structuredClone(value) as CampaignEnvelope;
}
/** A claimed success must carry the exact sanitized actual transport receipt. */
export function checkedDispatchTransportResult(value:unknown,job:Pick<DispatchJob,'operationId'|'recipientRef'>):TelegramEffectResult {
 const bad=()=>({outcome:unknown('dispatch_provider_unverified'),receipt:{botId:DISPATCH_BOT_ID,operationId:job.operationId,recipientRef:job.recipientRef,completedAt:null,attempts:[]}});
 if(!plain(value)||!plain(value.outcome)||!plain(value.receipt))return bad();
 const o=value.outcome,r=value.receipt;if(r.botId!==DISPATCH_BOT_ID||r.operationId!==job.operationId||r.recipientRef!==job.recipientRef||!Array.isArray(r.attempts)||r.attempts.length>2)return bad();
 if(r.attempts.some((a:any)=>!plain(a)||!['sendMessage','sendPhoto'].includes(a.method)||!hashPattern.test(a.requestSha256)||typeof a.providerAccepted!=='boolean'))return bad();
 if(r.attempts.some((a:any)=>a.providerAccepted&&(a.providerErrorCode!==undefined||!integer(a.messageId,1))||!a.providerAccepted&&a.messageId!==undefined))return bad();
 const last=r.attempts.at(-1);
 if(o.kind==='sent'&&(!validInstant(r.completedAt)||!last||last.providerAccepted!==true||!integer(last.messageId,1)||o.receipt!==`tg-msg-${last.messageId}`||r.attempts.slice(0,-1).some((a:any)=>a.method!=='sendPhoto'||a.providerAccepted!==false||a.providerErrorCode!==400)))return bad();
 if(o.kind==='rate_limited'&&(!validInstant(r.completedAt)||!integer(o.retryAfterSeconds,1,86400)||last?.providerErrorCode!==429||last.providerAccepted!==false||r.attempts.some((a:any)=>a.providerAccepted)))return bad();
 if(o.kind==='not_sent'&&(o.retryable!==false||r.attempts.some((a:any)=>a.providerAccepted||!integer(a.providerErrorCode,400,499)||a.providerErrorCode===429)))return bad();
 if(!['sent','rate_limited','not_sent','unknown'].includes(o.kind)||['not_sent','unknown'].includes(o.kind)&&(typeof o.reason!=='string'||!(/^[a-z0-9_]{1,100}$/).test(o.reason)||o.kind==='not_sent'&&typeof o.retryable!=='boolean'))return bad();
 const receipt:TelegramTransportReceipt={botId:DISPATCH_BOT_ID,operationId:job.operationId,recipientRef:job.recipientRef,completedAt:validInstant(r.completedAt)?r.completedAt:null,
  attempts:r.attempts.map((a:any)=>({method:a.method,requestSha256:hashPattern.test(a.requestSha256)?a.requestSha256:'0'.repeat(64),providerAccepted:a.providerAccepted===true,...(integer(a.messageId,1)?{messageId:a.messageId}:{}),...(integer(a.providerErrorCode,400,599)?{providerErrorCode:a.providerErrorCode}:{})})),
  ...(['render_failed','caption_limit','photo_rejected_400'].includes(r.fallback)?{fallback:r.fallback}:{})};
 const outcome:DeliveryOutcome=o.kind==='sent'?{kind:'sent',receipt:o.receipt}:o.kind==='rate_limited'?{kind:'rate_limited',retryAfterSeconds:o.retryAfterSeconds}:o.kind==='not_sent'?{kind:'not_sent',retryable:o.retryable,reason:o.reason}:{kind:'unknown',reason:o.reason};
 return {outcome,receipt};
}
const JOB_COLUMNS=`operation_id as "operationId",queue_seq as "queueSeq",recipient_kind as "recipientKind",source_kind as "sourceKind",source_id as "sourceId",owner_id as "ownerId",session_id as "sessionId",source_revision as "sourceRevision",source_ordinal as "sourceOrdinal",control_epoch as "controlEpoch",payload_digest as "payloadDigest",payload,recipient_ref as "recipientRef",chat_key as "chatKey",mapping_revision as "mappingRevision",state,fence,attempts,not_before as "notBefore"`;
function jobRow(row:any):DispatchQueuedJob {
 if(!plain(row)||!hashPattern.test(row.operationId)||!id(row.sourceId)||!['profile','campaign'].includes(row.sourceKind)||!integer(Number(row.sourceRevision))||!integer(Number(row.sourceOrdinal))||!integer(Number(row.controlEpoch),1)||!integer(Number(row.fence))||!integer(Number(row.attempts))||!id(row.recipientRef))return fail('dispatch_job_invalid');
 if(row.recipientKind==='legacy_subscription'){
  if(row.sourceKind!=='campaign'||row.ownerId!==null||row.sessionId!==null||!/^legacy:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row.recipientRef))return fail('dispatch_job_invalid');
 }else if(row.recipientKind!==undefined&&row.recipientKind!=='account'||!id(row.ownerId,255)||!id(row.sessionId,128))return fail('dispatch_job_invalid');
 const payload=checkedDispatchPayload(decoded(row.payload));if(dispatchPayloadDigest(payload)!==row.payloadDigest)return fail('dispatch_payload_changed');
 if(row.recipientKind==='legacy_subscription'&&(!payload.campaign||payload.schedule||payload.briefing||payload.message.kind!=='reply'||payload.message.buttons.length))return fail('dispatch_job_invalid');
 return {...row,queueSeq:String(row.queueSeq),sourceRevision:Number(row.sourceRevision),sourceOrdinal:Number(row.sourceOrdinal),controlEpoch:Number(row.controlEpoch),fence:Number(row.fence),attempts:Number(row.attempts),notBefore:date(row.notBefore),payload} as DispatchQueuedJob;
}
function profileState(row:any,owner:string):BotState {
 let state:BotState;try{state=restoreBotState(decoded(row.state),owner);}catch{return fail('dispatch_profile_invalid');}
 if(state.profile.id!==owner||state.sessionId!==row.sessionId||state.revision!==Number(row.revision))return fail('dispatch_profile_invalid');return state;
}

/** No default pool, token, HTTP, recurring runner, schema installation or legacy sender. */
export function createTelegramDispatcher(options:DispatchOptions):TelegramDispatcher {
 if(!options||options.expectedBotId!==DISPATCH_BOT_ID||!integer(options.expectedControlEpoch,1)||!id(options.workerId,128)||!options.pool||typeof options.pool.connect!=='function'||typeof options.now!=='function'||typeof options.resolveEligibility!=='function'||typeof options.createTransport!=='function'||options.identityReadGrant!==undefined&&typeof options.identityReadGrant!=='function'||options.resolveCampaignOwner!==undefined&&typeof options.resolveCampaignOwner!=='function'||options.enabled!==undefined&&typeof options.enabled!=='boolean')throw new Error('INVALID_TELEGRAM_DISPATCH_OPTIONS');
 const enabled=options.enabled===true,epoch=options.expectedControlEpoch,pool=options.pool,worker=options.workerId,clockPort=options.now,resolve=options.resolveEligibility,readGrant=options.identityReadGrant,transportFactory=options.createTransport,campaignOwner=options.resolveCampaignOwner,callbackFactory=options.createCallbackTransport;
 const legacyRecipient=options.resolveLegacyCampaignRecipient,legacyTransport=options.createLegacyTransport;
 if(legacyRecipient!==undefined&&typeof legacyRecipient!=='function'||legacyTransport!==undefined&&typeof legacyTransport!=='function'||Boolean(legacyRecipient)!==Boolean(legacyTransport))throw Error('INVALID_TELEGRAM_LEGACY_DISPATCH_OPTIONS');
 const scan=options.limits?.scan??8,maxAttempts=options.limits?.maxAttempts??3,minBotMs=options.limits?.minBotIntervalMs??50,minChatMs=options.limits?.minChatIntervalMs??1000,retryMs=options.limits?.preflightRetryMs??1000;
 if(!integer(scan,1,50)||!integer(maxAttempts,1,10)||!integer(minBotMs,0,60000)||!integer(minChatMs,0,60000)||!integer(retryMs,1,60000))throw new Error('INVALID_TELEGRAM_DISPATCH_LIMITS');
 const callbackEnabled=options.callbacks?.enabled===true,callbackMaxAge=options.callbacks?.maxAgeMs??30000;
 if(!integer(callbackMaxAge,1,120000)||callbackFactory!==undefined&&typeof callbackFactory!=='function')throw new Error('INVALID_TELEGRAM_CALLBACK_OPTIONS');
 let lastTime=-Infinity;
 const now=()=>{const value=clockPort();if(!validInstant(value)||Date.parse(value)<lastTime)return fail('dispatch_clock_invalid');lastTime=Date.parse(value);return value;};
 async function begin(client:DispatchClient){await client.query('begin isolation level read committed');const row=(await client.query('select control_epoch as "controlEpoch",writer_mode as "writerMode" from lba_production_control where id=true for share')).rows;if(row.length!==1||row[0].writerMode!=='canonical')fail('dispatch_control_not_canonical');if(Number(row[0].controlEpoch)!==epoch)fail('dispatch_epoch_conflict');}
 async function tx<T>(client:DispatchClient,work:()=>Promise<T>):Promise<T>{try{await begin(client);const result=await work();await client.query('commit');return result;}catch(error){try{await client.query('rollback');}catch{}throw error;}}
 async function globalState(client:DispatchClient){const rows=(await client.query('select hold_reason as "holdReason",hold_operation as "holdOperation",cooldown_until as "cooldownUntil",next_send_at as "nextSendAt" from lba_production_telegram_bot_state where bot_id=$1 for update',[DISPATCH_BOT_ID])).rows;if(rows.length!==1)fail('dispatch_bot_state_missing');return rows[0];}
 async function loadJob(client:DispatchClient,operation:string){const rows=await client.query(`select ${JOB_COLUMNS} from lba_production_telegram_dispatch_jobs where bot_id=$1 and operation_id=$2`,[DISPATCH_BOT_ID,operation]);return rows.rows.length?jobRow(rows.rows[0]):null;}
 async function hold(client:DispatchClient,reason:string,operation:string|null){await client.query('update lba_production_telegram_bot_state set hold_reason=$2,hold_operation=$3,updated_at=$4 where bot_id=$1',[DISPATCH_BOT_ID,reason,operation,now()]);}
 async function terminalCampaign(client:DispatchClient,campaign:CampaignEnvelope):Promise<DispatchRunResult|null>{
  const job=await loadJob(client,campaign.operationId);if(!job)return null;
  const payload:DispatchPayload={message:{id:campaign.operationId,kind:'reply',text:campaign.text,buttons:[],commitBarrier:'none'},campaign};
  if(job.sourceKind!=='campaign'||job.recipientRef!==campaign.recipientRef||job.payloadDigest!==dispatchPayloadDigest(payload))return fail('dispatch_payload_changed');
  if(['dispatching','unknown','held'].includes(job.state))return {kind:'held',operationId:job.operationId,reason:'campaign_attempt_unreconciled'};
  if(!['sent','not_sent','cancelled'].includes(job.state))return null;
  // Historical effect readback is independent of today's delivery consent.
  // Exact immutable payload + same durable attempt are required; no new send.
  const row=(await client.query('select state,dispatch_marked_at,outcome,receipt from lba_production_telegram_dispatch_attempts where operation_id=$1 and fence=$2',[job.operationId,job.fence])).rows[0];
  if(row?.receipt){
   const result=checkedDispatchTransportResult({outcome:decoded(row.outcome),receipt:decoded(row.receipt)},job);
   if(result.outcome.kind!=='unknown'&&(job.state==='sent'?row.state==='sent'&&result.outcome.kind==='sent':result.outcome.kind==='not_sent'))return {kind:'completed',operationId:job.operationId,...result};
  }else if(job.state!=='sent'&&!row?.dispatch_marked_at)return {kind:'cancelled',operationId:job.operationId,outcome:notSent('campaign_terminal')};
  await hold(client,'terminal_receipt_unverified',job.operationId);return {kind:'unknown',operationId:job.operationId,outcome:unknown('dispatch_terminal_receipt_unverified')};
 }
 const callbackConsumer=createCallbackAckConsumer({epoch,now,maxAgeMs:callbackMaxAge,maxAttempts,retryMs,minBotIntervalMs:minBotMs,transaction:tx,hold,readGrant,
  transport:request=>{if(!callbackFactory)return fail('dispatch_callback_transport_missing');return callbackFactory(request);}});
 async function cancel(client:DispatchClient,job:DispatchQueuedJob,reason:string,status:'cancelled'|'not_sent'='cancelled'){
  await client.query('update lba_production_telegram_dispatch_jobs set state=$3,last_reason=$4,updated_at=$5 where bot_id=$1 and operation_id=$2',[DISPATCH_BOT_ID,job.operationId,status,reason,now()]);
  if(job.sourceKind==='profile')await client.query("update lba_production_profile_outbox set status=$4 where id=$1 and owner_id=$2 and control_epoch=$3 and status in ('pending','dispatching')",[job.sourceId,job.ownerId,epoch,status]);
 }
 function validLegacy(value:unknown,recipientRef:string,time:string):value is LegacyCampaignRecipientSubject{
  return plain(value)&&Object.keys(value).sort().join(',')==='botId,chatId,expiresAt,kind,mappingRevision,recipientRef'&&value.kind==='legacy_subscription'&&value.botId===DISPATCH_BOT_ID&&value.recipientRef===recipientRef&&/^legacy:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(recipientRef)&&typeof value.chatId==='string'&&/^[1-9]\d{0,15}$/.test(value.chatId)&&integer(Number(value.chatId),1,2**52-1)&&/^legacy-mapping:[a-f0-9]{64}$/.test(value.mappingRevision)&&validInstant(value.expiresAt)&&Date.parse(value.expiresAt)>Date.parse(time)&&Date.parse(value.expiresAt)<=Date.parse(time)+5000;
 }
 async function legacyAdmission(client:DispatchClient,job:LegacyCampaignDispatchJob,signal:AbortSignal){
  if(signal.aborted||!legacyRecipient||!job.payload.campaign||job.payload.schedule||job.payload.briefing||job.payload.message.kind!=='reply'||job.payload.message.buttons.length||job.controlEpoch!==epoch)return null;
  const time=now(),value=await legacyRecipient({client,envelope:Object.freeze(structuredClone(job.payload.campaign)),now:time,signal});
  return !signal.aborted&&validLegacy(value,job.recipientRef,now())?value:null;
 }
 async function owned(client:DispatchClient,job:DispatchQueuedJob):Promise<BotState|null>{
  if(legacyJob(job)){if(!await legacyAdmission(client,job,new AbortController().signal))fail('dispatch_legacy_recipient_unverified');return null;}
  if(job.sourceKind==='campaign'){
   const ownerPort=campaignOwner,campaign=job.payload.campaign;if(!ownerPort||!campaign)return fail('dispatch_campaign_owner_unverified');
   const current=await ownerPort({client,envelope:Object.freeze(structuredClone(campaign)),now:now(),signal:new AbortController().signal});
   if(!current||current.ownerId!==job.ownerId||!validInstant(current.expiresAt)||Date.parse(current.expiresAt)<=Date.parse(now()))fail('dispatch_campaign_owner_unverified');
  }
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba-production-owner:'+job.ownerId]);
  const rows=(await client.query('select session_id as "sessionId",revision,state from lba_production_profiles where owner_id=$1 for share',[job.ownerId])).rows;
  if(rows.length!==1)fail('dispatch_profile_missing');const profile=profileState(rows[0],job.ownerId);
  const provenance=(await client.query('select 1 from lba_production_profile_origins o join lba_production_bootstrap_ledger b on b.owner_id=o.owner_id where o.owner_id=$1 and b.session_id=$2',[job.ownerId,profile.sessionId])).rows;if(provenance.length!==1)fail('dispatch_profile_provenance_missing');
  if(job.sessionId!==profile.sessionId||job.controlEpoch!==epoch)fail('dispatch_profile_changed');
  if(job.sourceKind==='profile'){
   const rows=(await client.query('select payload,status,session_id as "sessionId",control_epoch as "controlEpoch",revision,ordinal,address_id as "addressId" from lba_production_profile_outbox where id=$1 and owner_id=$2 for update',[job.sourceId,job.ownerId])).rows;
   if(rows.length!==1||!['pending','dispatching'].includes(rows[0].status)||rows[0].sessionId!==job.sessionId||Number(rows[0].controlEpoch)!==epoch||Number(rows[0].revision)!==job.sourceRevision||Number(rows[0].ordinal)!==job.sourceOrdinal)fail('dispatch_outbox_changed');
   if(dispatchPayloadDigest(checkedDispatchPayload(decoded(rows[0].payload)))!==job.payloadDigest)fail('dispatch_payload_changed');
   if(job.payload.schedule&&rows[0].addressId!==job.payload.schedule.addressId)fail('dispatch_binding_changed');
  }
  const view=job.payload.schedule,location=view?profile.profile.locations.find(l=>l.address.id===view.addressId):undefined;
  if(view){
   const b=location?.binding,time=now();
   const verified=b?.status==='verified'&&['building','connection','operator_group'].includes(b.kind);
   const display=job.payload.message.kind==='schedule'&&Boolean(b&&planMatchesDisplay(view,b,time));
   if(!b||(job.payload.message.kind==='schedule'?!display:!verified)||b.addressId!==view.addressId||b.operatorId!==view.operatorId||b.namespace!==view.namespace||b.targetId!==view.targetId||b.revisionId!==view.bindingRevisionId||view.synthetic||Date.parse(view.observedAt)>Date.parse(time)||view.publishedAt&&Date.parse(view.publishedAt)>Date.parse(time)||b.effectiveFrom&&(!validInstant(b.effectiveFrom)||Date.parse(b.effectiveFrom)>Date.parse(time))||b.effectiveUntil&&(!validInstant(b.effectiveUntil)||Date.parse(b.effectiveUntil)<=Date.parse(time)))fail('dispatch_binding_changed');
   if(job.payload.message.kind==='notification'&&(!location||!resolveNotificationPolicy(profile.profile.preferences,location,'telegram').enabled||!canDeliver(view,b!,profile.profile.preferences,time)))fail('dispatch_notification_ineligible');
  }else if(job.payload.message.kind==='notification'&&!job.payload.briefing)fail('dispatch_event_proof_missing');
  if(job.sourceKind==='campaign'&&profile.profile.preferences.paused)fail('dispatch_campaign_paused');
  return profile;
 }
 async function eligibility(client:DispatchClient,job:DispatchQueuedJob,profile:BotState|null,phase:DispatchEligibilityRequest['phase'],signal:AbortSignal,native?:TelegramAuthorizationRequest){
  if(signal.aborted)fail('dispatch_cancelled_before_effect');
  if(legacyJob(job)){
   if(profile!==null)fail('dispatch_recipient_subject_invalid');const value=await legacyAdmission(client,job,signal);if(!value)return {denied:true as const};
   const chatKey=hash([DISPATCH_BOT_ID,value.chatId,'private']);if(job.chatKey&&job.chatKey!==chatKey||job.mappingRevision&&job.mappingRevision!==value.mappingRevision)fail('dispatch_destination_changed');
   return {denied:false as const,decision:{eligible:true as const,ownerId:null,recipientRef:value.recipientRef,chatId:value.chatId,chatType:'private' as const,mappingRevision:value.mappingRevision,expiresAt:value.expiresAt},chatKey};
  }
  if(!profile)return fail('dispatch_profile_missing');
  const time=now(),decision=await resolve({client,job:structuredClone(job),profile:structuredClone(profile),now:time,phase,signal,...(native?{native:Object.freeze({...native})}:{})});
  if(signal.aborted)fail('dispatch_cancelled_before_effect');
  if(!plain(decision)||decision.eligible!==true){
   if(plain(decision)&&decision.eligible===false&&decision.retryAt&&validInstant(decision.retryAt)&&Date.parse(decision.retryAt)>Date.parse(now())&&Date.parse(decision.retryAt)-Date.parse(now())<=86400000)return {denied:true as const,retryAt:decision.retryAt};
   return {denied:true as const};
  }
  if(decision.ownerId!==job.ownerId||decision.recipientRef!==job.recipientRef||decision.chatType!=='private'||typeof decision.chatId!=='string'||!(/^[1-9]\d{0,15}$/).test(decision.chatId)||!integer(Number(decision.chatId),1,2**52-1)||!id(decision.mappingRevision)||!validInstant(decision.expiresAt)||Date.parse(decision.expiresAt)<=Date.parse(now()))fail('dispatch_destination_unverified');
  const chatKey=hash([DISPATCH_BOT_ID,decision.chatId,decision.chatType]);
  if(job.chatKey&&job.chatKey!==chatKey||job.mappingRevision&&job.mappingRevision!==decision.mappingRevision)fail('dispatch_destination_changed');
  const view=job.payload.schedule;
  if(view&&decision.sourceRevision!==view.source.revision)fail('dispatch_source_changed');
  if(job.payload.message.kind==='notification'){
   const proof=decision.eventProof,b=job.payload.briefing;
   if(b){
    if(!proof||job.sourceKind!=='profile'||proof.kind!=='morning_briefing'||proof.revision!==b.packetDigest||proof.scheduleRevisionId!==(view?.revisionId??'briefing:'+b.id)||proof.sourceRevision!==(view?.source.revision??b.packetDigest)||proof.serviceDate!==b.serviceDate||!validInstant(proof.expiresAt)||Date.parse(proof.expiresAt)<=Date.parse(now()))fail('dispatch_event_proof_missing');
   }else if(!proof||!['schedule_event','reminder'].includes(proof.kind)||!id(proof.revision)||!view||proof.scheduleRevisionId!==view.revisionId||proof.sourceRevision!==view.source.revision||proof.serviceDate!==view.serviceDate||!validInstant(proof.expiresAt)||Date.parse(proof.expiresAt)<=Date.parse(now()))fail('dispatch_event_proof_missing');
  }
  return {denied:false as const,decision,chatKey};
 }
 type NewQueuedJob=Omit<DispatchJob,'queueSeq'|'chatKey'|'mappingRevision'|'state'|'fence'|'attempts'|'notBefore'>|Omit<LegacyCampaignDispatchJob,'queueSeq'|'chatKey'|'mappingRevision'|'state'|'fence'|'attempts'|'notBefore'>;
 async function insertJob(client:DispatchClient,job:NewQueuedJob){
  await client.query(`insert into lba_production_telegram_dispatch_jobs(operation_id,bot_id,source_kind,source_id,owner_id,session_id,source_revision,source_ordinal,control_epoch,payload_digest,payload,recipient_ref,created_at,updated_at,recipient_kind) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$13,$14) on conflict(operation_id) do nothing`,[job.operationId,DISPATCH_BOT_ID,job.sourceKind,job.sourceId,job.ownerId,job.sessionId,job.sourceRevision,job.sourceOrdinal,epoch,job.payloadDigest,JSON.stringify(job.payload),job.recipientRef,now(),job.recipientKind??'account']);
  const existing=await loadJob(client,job.operationId);if(!existing||existing.payloadDigest!==job.payloadDigest||existing.ownerId!==job.ownerId||existing.sourceId!==job.sourceId||existing.sourceKind!==job.sourceKind||(existing.recipientKind??'account')!==(job.recipientKind??'account'))fail('dispatch_payload_changed');
 }
 async function syncProfiles(client:DispatchClient,ownerFilter?:string){
  const rows=await client.query(`select o.id,o.owner_id as "ownerId",o.session_id as "sessionId",o.revision,o.ordinal,o.payload from lba_production_profile_outbox o join lba_production_profiles p on p.owner_id=o.owner_id and p.session_id=o.session_id where o.status='pending' and o.control_epoch=$1 ${ownerFilter?'and o.owner_id=$3':''} and not exists(select 1 from lba_production_telegram_dispatch_jobs d where d.bot_id='8577497098' and d.source_kind='profile' and d.source_id=o.id::text) and not exists(select 1 from lba_production_profile_outbox h where h.owner_id=o.owner_id and h.session_id=o.session_id and h.control_epoch=o.control_epoch and h.status in ('pending','dispatching','unknown') and (h.revision,h.ordinal,h.id)<(o.revision,o.ordinal,o.id)) order by o.created_at,o.revision,o.ordinal,o.id limit $2`,[epoch,scan,...(ownerFilter?[ownerFilter]:[])]);
  for(const r of rows.rows){
   let payload:DispatchPayload;try{payload=checkedDispatchPayload(decoded(r.payload));if(payload.campaign)fail('dispatch_payload_invalid');}catch{
    await client.query(`insert into lba_production_telegram_dispatch_jobs(operation_id,bot_id,source_kind,source_id,owner_id,session_id,source_revision,source_ordinal,control_epoch,payload_digest,payload,recipient_ref,state,last_reason,created_at,updated_at) values($1,$2,'profile',$3,$4,$5,$6,$7,$8,$9,'null'::jsonb,$10,'not_sent','payload_unsupported',$11,$11) on conflict(operation_id) do nothing`,[profileDispatchOperationId(r.id),DISPATCH_BOT_ID,r.id,r.ownerId,r.sessionId,Number(r.revision),r.ordinal,epoch,hash(decoded(r.payload)),'owner:'+hash(r.ownerId).slice(0,40),now()]);
    await client.query("update lba_production_profile_outbox set status='not_sent' where id=$1 and owner_id=$2 and status='pending'",[r.id,r.ownerId]);continue;}
   await insertJob(client,{operationId:profileDispatchOperationId(r.id),sourceKind:'profile',sourceId:r.id,ownerId:r.ownerId,sessionId:r.sessionId,sourceRevision:Number(r.revision),sourceOrdinal:r.ordinal,controlEpoch:epoch,payloadDigest:dispatchPayloadDigest(payload),payload,recipientRef:'owner:'+hash(r.ownerId).slice(0,40)});
  }
 }
 async function hydrate(client:DispatchClient,signal:AbortSignal,campaignOperation?:string){
  // Campaign authority is held by its outer durable claim. The regular worker
  // must not hydrate/cancel a campaign while that claim is in local retry_wait.
  // Explicit campaign runs may hydrate their own operation plus earlier replies.
  // A standalone profile dispatcher remains usable without the optional
  // campaign repository. Only its terminal queue reconciliation needs it.
  let closedCampaigns=false;
  if(!campaignOperation){const pending=(await client.query("select 1 from lba_production_telegram_dispatch_jobs where bot_id=$1 and source_kind='campaign' and state in ('pending','retry_wait') limit 1",[DISPATCH_BOT_ID])).rows;
   if(pending.length)closedCampaigns=Boolean((await client.query("select to_regclass('public.lba_release_campaign_jobs')::text as relation")).rows[0]?.relation);}
  const closed=closedCampaigns?" or (j.source_kind='campaign' and exists(select 1 from lba_release_campaign_jobs closed where closed.operation_id=j.operation_id and closed.release_id=j.payload->'campaign'->>'releaseId' and closed.recipient_ref=j.recipient_ref and closed.record->>'state' in ('cancelled','failed')))":'';
  const rows=await client.query(`select ${JOB_COLUMNS} from lba_production_telegram_dispatch_jobs j where bot_id=$1 and control_epoch=$2 and state in ('pending','retry_wait') and (j.source_kind='profile'${campaignOperation?" or (j.source_kind='campaign' and j.operation_id=$5)":''}${closed}) and (not_before is null or not_before<=$3) and not exists(select 1 from lba_production_telegram_dispatch_jobs h where h.bot_id=j.bot_id and h.owner_id=j.owner_id and h.queue_seq<j.queue_seq and h.state in ('pending','prepared','dispatching','retry_wait','unknown','held') and not(h.source_kind='campaign' and j.source_kind='profile' and j.source_revision<=h.source_revision)) order by (chat_key is not null),queue_seq limit $4`,[DISPATCH_BOT_ID,epoch,now(),scan,...(campaignOperation?[campaignOperation]:[])]);
  for(const r of rows.rows){const job=jobRow(r);try{await tx(client,async()=>{
   const profile=await owned(client,job),admission=await eligibility(client,job,profile,'prepare',signal);
   if(admission.denied){if(admission.retryAt)await client.query("update lba_production_telegram_dispatch_jobs set state='retry_wait',not_before=$3,updated_at=$4 where bot_id=$1 and operation_id=$2",[DISPATCH_BOT_ID,job.operationId,admission.retryAt,now()]);else await cancel(client,job,'eligibility_denied');return;}
   await client.query(`insert into lba_production_telegram_chat_state(bot_id,chat_key,owner_id,updated_at,recipient_kind) values($1,$2,$3,$4,$5) on conflict(bot_id,chat_key) do nothing`,[DISPATCH_BOT_ID,admission.chatKey,job.ownerId,now(),job.recipientKind??'account']);
   let chat=(await client.query('select owner_id as "ownerId",recipient_kind as "recipientKind",reachability from lba_production_telegram_chat_state where bot_id=$1 and chat_key=$2 for update',[DISPATCH_BOT_ID,admission.chatKey])).rows[0];
   // Endpoint history is retained when a previously accountless subscriber
   // later proves a canonical identity. This never infers ownership: owned()
   // and SQL eligibility already locked the exact current unique account link.
   if(!legacyJob(job)&&chat?.recipientKind==='legacy_subscription'&&chat.ownerId===null){
    const outstanding=(await client.query(`select 1 from lba_production_telegram_dispatch_jobs d
     left join lba_legacy_campaign_recipient r on r.bot_id=d.bot_id and r.recipient_ref=d.recipient_ref
     where d.bot_id=$1 and d.recipient_kind='legacy_subscription'
     and (d.chat_key=$2 or (d.chat_key is null and r.chat_id=$3))
     and d.state in ('pending','prepared','dispatching','retry_wait','unknown','held') limit 1`,[DISPATCH_BOT_ID,admission.chatKey,admission.decision.chatId])).rows;
    if(outstanding.length)fail('dispatch_chat_subject_unreconciled');
    await client.query("update lba_production_telegram_chat_state set owner_id=$3,recipient_kind='account',updated_at=$4 where bot_id=$1 and chat_key=$2 and owner_id is null and recipient_kind='legacy_subscription'",[DISPATCH_BOT_ID,admission.chatKey,job.ownerId,now()]);chat={...chat,ownerId:job.ownerId,recipientKind:'account'};
   }
   if(chat?.ownerId!==job.ownerId||(chat.recipientKind??'account')!==(job.recipientKind??'account'))fail('dispatch_chat_owner_conflict');
   if(chat.reachability==='forbidden'){await cancel(client,job,'recipient_unreachable','not_sent');return;}
   await client.query('update lba_production_telegram_dispatch_jobs set chat_key=$3,mapping_revision=$4,updated_at=$5 where bot_id=$1 and operation_id=$2',[DISPATCH_BOT_ID,job.operationId,admission.chatKey,admission.decision.mappingRevision,now()]);
  });}catch(error){await tx(client,async()=>{if(error instanceof DispatchError)await cancel(client,job,error.code);else await client.query("update lba_production_telegram_dispatch_jobs set state='retry_wait',not_before=$3,last_reason='eligibility_unconfirmed',updated_at=$4 where bot_id=$1 and operation_id=$2",[DISPATCH_BOT_ID,job.operationId,new Date(Date.parse(now())+retryMs).toISOString(),now()]);});}}
 }
 async function recoverOrphans(client:DispatchClient):Promise<boolean>{
  return tx(client,async()=>{
   const orphan=await client.query("select operation_id as id,source_kind as kind,source_id as source,owner_id as owner,fence from lba_production_telegram_dispatch_jobs where bot_id=$1 and state='dispatching' order by queue_seq",[DISPATCH_BOT_ID]);
   if(orphan.rows.length){for(const r of orphan.rows){await client.query("update lba_production_telegram_dispatch_jobs set state='unknown',last_reason='orphan_dispatch',updated_at=$3 where bot_id=$1 and operation_id=$2",[DISPATCH_BOT_ID,r.id,now()]);await client.query("update lba_production_telegram_dispatch_attempts set state='unknown',finished_at=$3,outcome=$4::jsonb where operation_id=$1 and fence=$2",[r.id,r.fence,now(),JSON.stringify(unknown('orphan_dispatch'))]);if(r.kind==='profile')await client.query("update lba_production_profile_outbox set status='unknown' where id=$1 and owner_id=$2 and status='dispatching'",[r.source,r.owner]);}await hold(client,'orphan_dispatch',orphan.rows[0].id);return true;}
   await client.query("update lba_production_telegram_dispatch_attempts set state='not_dispatched',finished_at=$2,outcome=$3::jsonb where operation_id in(select operation_id from lba_production_telegram_dispatch_jobs where bot_id=$1 and state='prepared') and state='prepared'",[DISPATCH_BOT_ID,now(),JSON.stringify(notSent('prepared_recovered'))]);
   await client.query("update lba_production_telegram_dispatch_jobs set state='pending',last_reason='prepared_recovered',updated_at=$2 where bot_id=$1 and state='prepared'",[DISPATCH_BOT_ID,now()]);return false;
  });
 }
 async function execute(client:DispatchClient,job:DispatchQueuedJob,signal:AbortSignal):Promise<DispatchRunResult>{
  job=(await tx(client,async()=>{
   const current=(await loadJob(client,job.operationId))!;if(current.attempts>=maxAttempts){await cancel(client,current,'attempt_limit','not_sent');return null;}
   const fence=current.fence+1;await client.query("update lba_production_telegram_dispatch_jobs set state='prepared',fence=$3,attempts=attempts+1,updated_at=$4 where bot_id=$1 and operation_id=$2 and state in ('pending','retry_wait')",[DISPATCH_BOT_ID,current.operationId,fence,now()]);
   await client.query("insert into lba_production_telegram_dispatch_attempts(operation_id,fence,worker_id,control_epoch,state,prepared_at) values($1,$2,$3,$4,'prepared',$5)",[current.operationId,fence,worker,epoch,now()]);return (await loadJob(client,current.operationId))!;
  }))!;
  if(!job)return {kind:'cancelled',reason:'attempt_limit'};
  const actorId=legacyJob(job)?'service:legacy-campaign:'+hash(job.recipientRef).slice(0,40):'owner:'+hash(job.ownerId).slice(0,40),capabilityId=`dispatch:${job.operationId}:${job.fence}`,readActor='service:telegram-dispatch',readCapability=`read:${job.operationId}:${job.fence}`;
  let phase:'identity'|'dispatch'|'closed'='identity',lastNative:TelegramAuthorizationRequest|null=null;
  const authorize:TelegramAuthorizationPort=async(request,abort)=>{
   if(abort.aborted||phase==='closed')return null;
   if(phase==='identity'){
    if(request.method!=='getMe'||request.actorId!==readActor||request.capabilityId!==readCapability||request.botId!==DISPATCH_BOT_ID||request.dispatchIndex!==1||request.operationId!==undefined||request.recipientRef!==undefined||!readGrant)return null;
    const granted=await readGrant({actorId:readActor,capabilityId:readCapability,botId:DISPATCH_BOT_ID,controlEpoch:epoch,operationId:job.operationId,signal:abort});
    if(abort.aborted||!granted||granted.actorId!==readActor||granted.capabilityId!==readCapability||granted.botId!==DISPATCH_BOT_ID||granted.controlEpoch!==epoch||!validInstant(granted.expiresAt)||Date.parse(granted.expiresAt)<=Date.parse(now()))return null;
    return {...request,expiresAt:granted.expiresAt};
   }
   if(request.actorId!==actorId||request.capabilityId!==capabilityId||request.operationId!==job.operationId||request.recipientRef!==job.recipientRef||request.botId!==DISPATCH_BOT_ID||!['sendMessage','sendPhoto'].includes(request.method)||request.dispatchIndex!==1&&request.dispatchIndex!==2)return null;
   if(request.method==='sendPhoto'&&!job.payload.schedule||request.dispatchIndex===2&&(request.method!=='sendMessage'||request.fallbackFrom!=='photo_rejected_400'||lastNative?.method!=='sendPhoto'||lastNative.dispatchIndex!==1))return null;
   const profile=await owned(client,job),admission=await eligibility(client,job,profile,'native',abort,request);if(abort.aborted||admission.denied)return null;
   lastNative={...request};return {...request,expiresAt:admission.decision.expiresAt,chatId:admission.decision.chatId,chatType:'private',bindingRevision:admission.decision.mappingRevision};
  };
  const transport=legacyJob(job)?legacyTransport!({authorize,job:structuredClone(job)}):transportFactory({authorize,job:structuredClone(job),renderKey:'dispatch:'+job.operationId});
  if(!transport||transport.botId!==DISPATCH_BOT_ID||typeof transport.read?.getMe!=='function'||typeof transport.effects?.sendMessage!=='function')fail('dispatch_transport_invalid');
  const identity=await transport.read.getMe({actorId:readActor,capabilityId:readCapability},signal);
  if(!identity.ok||identity.value.botId!==DISPATCH_BOT_ID||identity.value.username!=='PowerUkraineBot'){
   phase='closed';const outcome=!identity.ok?identity.outcome:notSent('identity_unverified');
   await tx(client,async()=>{
    await client.query("update lba_production_telegram_dispatch_attempts set state='not_dispatched',finished_at=$3,outcome=$4::jsonb where operation_id=$1 and fence=$2",[job.operationId,job.fence,now(),JSON.stringify(outcome)]);
    const retryAt=new Date(Date.parse(now())+(outcome.kind==='rate_limited'?outcome.retryAfterSeconds*1000:retryMs)).toISOString();
    await client.query("update lba_production_telegram_dispatch_jobs set state='retry_wait',not_before=$3,last_reason='identity_unverified',updated_at=$4 where bot_id=$1 and operation_id=$2",[DISPATCH_BOT_ID,job.operationId,retryAt,now()]);
    await client.query('update lba_production_telegram_bot_state set next_send_at=greatest(coalesce(next_send_at,$2),$2),updated_at=$3 where bot_id=$1',[DISPATCH_BOT_ID,retryAt,now()]);
    if(outcome.kind==='rate_limited')await client.query('update lba_production_telegram_bot_state set cooldown_until=greatest(coalesce(cooldown_until,$2),$2),updated_at=$3 where bot_id=$1',[DISPATCH_BOT_ID,retryAt,now()]);
    else if(outcome.kind==='unknown')await hold(client,'identity_read_unknown',job.operationId);
   });return {kind:'deferred',operationId:job.operationId,reason:'identity_unverified'};
  }
  try{
   await tx(client,async()=>{
    const profile=await owned(client,job),decision=await eligibility(client,job,profile,'dispatch',signal);if(decision.denied)fail('dispatch_eligibility_revoked');
    await client.query("update lba_production_telegram_dispatch_jobs set state='dispatching',updated_at=$4 where bot_id=$1 and operation_id=$2 and fence=$3 and state='prepared'",[DISPATCH_BOT_ID,job.operationId,job.fence,now()]);
    await client.query("update lba_production_telegram_dispatch_attempts set state='dispatching',dispatch_marked_at=$3 where operation_id=$1 and fence=$2 and state='prepared'",[job.operationId,job.fence,now()]);
    if(job.sourceKind==='profile'){const updated=await client.query("update lba_production_profile_outbox set status='dispatching' where id=$1 and owner_id=$2 and status='pending' and control_epoch=$3",[job.sourceId,job.ownerId,epoch]);if(updated.rowCount!==1)fail('dispatch_outbox_changed');}
   });
  }catch(error){phase='closed';const unresolved=await tx(client,async()=>{const current=await loadJob(client,job.operationId);if(current?.state==='dispatching'){await hold(client,'dispatch_mark_unknown',job.operationId);return true;}await cancel(client,job,error instanceof DispatchError?error.code:'dispatch_prepare_failed');await client.query("update lba_production_telegram_dispatch_attempts set state='cancelled',finished_at=$3,outcome=$4::jsonb where operation_id=$1 and fence=$2",[job.operationId,job.fence,now(),JSON.stringify(notSent('eligibility_revoked'))]);return false;});return unresolved?{kind:'unknown',operationId:job.operationId,outcome:unknown('dispatch_mark_unknown')}:{kind:'cancelled',operationId:job.operationId,reason:'eligibility_revoked'};}
  let result:TelegramEffectResult,nativeInvoked=false;
  try{
   await begin(client);
   const profile=await owned(client,job),decision=await eligibility(client,job,profile,'dispatch',signal);if(decision.denied)fail('dispatch_eligibility_revoked');
   phase='dispatch';const ctx={actorId,capabilityId,operationId:job.operationId,recipientRef:job.recipientRef},keyboard=telegramKeyboardFromBotButtons(job.payload.message.buttons);
   nativeInvoked=true;const native=job.payload.schedule?await transport.effects.sendRenderedSchedule(ctx,{text:job.payload.message.text,renderKey:'dispatch:'+job.operationId,keyboard},signal):await transport.effects.sendMessage(ctx,{text:job.payload.message.text,...(job.payload.campaign?{keyboard:[[{text:'Відкрити застосунок',url:job.payload.campaign.appUrl}]]}:{keyboard})},signal);
   phase='closed';result=checkedDispatchTransportResult(native,job);
   const outcome=result.outcome,time=now(),final=outcome.kind==='sent'?'sent':outcome.kind==='unknown'?'unknown':outcome.kind==='rate_limited'&&job.attempts<maxAttempts?'retry_wait':'not_sent';
   const retryAt=outcome.kind==='rate_limited'?new Date(Date.parse(time)+outcome.retryAfterSeconds*1000).toISOString():null;
   const updated=await client.query('update lba_production_telegram_dispatch_jobs set state=$4,provider_receipt=$5,last_reason=$6,not_before=$7,updated_at=$8 where bot_id=$1 and operation_id=$2 and fence=$3 and state=\'dispatching\'',[DISPATCH_BOT_ID,job.operationId,job.fence,final,outcome.kind==='sent'?outcome.receipt:null,outcome.kind==='unknown'||outcome.kind==='not_sent'?outcome.reason:outcome.kind,retryAt,time]);if(updated.rowCount!==1)fail('dispatch_fence_lost');
   await client.query('update lba_production_telegram_dispatch_attempts set state=$3,finished_at=$4,outcome=$5::jsonb,receipt=$6::jsonb where operation_id=$1 and fence=$2',[job.operationId,job.fence,outcome.kind==='rate_limited'?'rate_limited':outcome.kind,time,JSON.stringify(outcome),JSON.stringify(result.receipt)]);
   if(job.sourceKind==='profile'){const updated=await client.query("update lba_production_profile_outbox set status=$4 where id=$1 and owner_id=$2 and control_epoch=$3 and status='dispatching'",[job.sourceId,job.ownerId,epoch,final==='retry_wait'?'pending':final]);if(updated.rowCount!==1)fail('dispatch_outbox_fence_lost');}
   await client.query('update lba_production_telegram_bot_state set next_send_at=$2,updated_at=$3 where bot_id=$1',[DISPATCH_BOT_ID,new Date(Date.parse(time)+minBotMs).toISOString(),time]);
   await client.query('update lba_production_telegram_chat_state set next_send_at=$3,last_dispatch_at=$4,updated_at=$4,reachability=$5 where bot_id=$1 and chat_key=$2',[DISPATCH_BOT_ID,job.chatKey,new Date(Date.parse(time)+minChatMs).toISOString(),time,outcome.kind==='not_sent'&&result.receipt.attempts.at(-1)?.providerErrorCode===403?'forbidden':outcome.kind==='sent'?'reachable':'unknown']);
   if(retryAt)await client.query('update lba_production_telegram_bot_state set cooldown_until=greatest(coalesce(cooldown_until,$2),$2),updated_at=$3 where bot_id=$1',[DISPATCH_BOT_ID,retryAt,time]);
   if(outcome.kind==='unknown')await hold(client,'provider_unknown',job.operationId);
   await client.query('commit');return {kind:outcome.kind==='unknown'?'unknown':'completed',operationId:job.operationId,outcome,receipt:result.receipt};
  }catch(error){phase='closed';try{await client.query('rollback');}catch{}
   if(!nativeInvoked){try{await tx(client,async()=>{await cancel(client,job,error instanceof DispatchError?error.code:'eligibility_unconfirmed');await client.query("update lba_production_telegram_dispatch_attempts set state='cancelled',finished_at=$3,outcome=$4::jsonb where operation_id=$1 and fence=$2",[job.operationId,job.fence,now(),JSON.stringify(notSent('eligibility_revoked'))]);});return {kind:'cancelled',operationId:job.operationId,outcome:notSent('eligibility_revoked')};}catch{}}
   try{await tx(client,async()=>{const current=await loadJob(client,job.operationId);if(current?.state==='sent')return;await client.query("update lba_production_telegram_dispatch_jobs set state='unknown',last_reason='dispatch_unconfirmed',updated_at=$3 where bot_id=$1 and operation_id=$2 and fence=$4 and state='dispatching'",[DISPATCH_BOT_ID,job.operationId,now(),job.fence]);await client.query("update lba_production_telegram_dispatch_attempts set state='unknown',finished_at=$3,outcome=$4::jsonb where operation_id=$1 and fence=$2",[job.operationId,job.fence,now(),JSON.stringify(unknown('dispatch_unconfirmed'))]);if(job.sourceKind==='profile')await client.query("update lba_production_profile_outbox set status='unknown' where id=$1 and owner_id=$2 and status='dispatching'",[job.sourceId,job.ownerId]);await hold(client,'dispatch_unconfirmed',job.operationId);});}catch{}
   return {kind:'unknown',operationId:job.operationId,outcome:unknown('dispatch_unconfirmed')};
  }
 }
 async function run(signal:AbortSignal,campaign?:CampaignEnvelope,callback=false):Promise<DispatchRunResult>{
  if(!enabled)return {kind:'disabled'};if(!signal||signal.aborted)return {kind:'cancelled',reason:'cancelled_before_effect'};
  if(callback&&(!callbackEnabled||!callbackFactory))return {kind:'disabled',reason:'callback_not_configured'};
  let client:DispatchClient;try{client=await pool.connect();}catch{return {kind:'unavailable',reason:'dispatch_storage_unavailable'};}
  let locked=false,tainted=false;
  try{
   const lock=(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',[dispatchBotLockKey()])).rows[0];if(lock?.locked!==true)return {kind:'busy'};locked=true;
   if(campaign){const terminal=await tx(client,()=>terminalCampaign(client,campaign));if(terminal)return terminal;}
   if(await recoverOrphans(client))return {kind:'held',reason:'orphan_dispatch'};
   if(await callbackConsumer.recoverOrphans(client))return {kind:'held',reason:'callback_unreconciled'};
   const gated=await tx(client,async()=>{
    const state=await globalState(client);if(state.holdReason)return {kind:'held' as const,reason:'bot_hold'};
    const old=(await client.query("select 1 from lba_production_telegram_dispatch_jobs where bot_id=$1 and control_epoch<>$2 and state in ('pending','prepared','dispatching','retry_wait','unknown','held') limit 1",[DISPATCH_BOT_ID,epoch])).rows;
    const oldOutbox=(await client.query("select 1 from lba_production_profile_outbox o left join lba_production_profiles p on p.owner_id=o.owner_id where o.status in ('pending','dispatching','unknown') and (o.control_epoch<>$1 or p.owner_id is null or p.session_id<>o.session_id) limit 1",[epoch])).rows;if(old.length||oldOutbox.length)return {kind:'held' as const,reason:'old_epoch_unreconciled'};
    const stale=(await client.query("select 1 from lba_production_profile_outbox where status in ('dispatching','unknown') limit 1")).rows;if(stale.length){await hold(client,'unreconciled_outbox',null);return {kind:'held' as const,reason:'unreconciled_outbox'};}
    const gate=[date(state.cooldownUntil),date(state.nextSendAt)].filter(Boolean).sort().at(-1);if(gate&&Date.parse(gate)>Date.parse(now()))return {kind:'deferred' as const,retryAt:gate};
    await syncProfiles(client);return null;
   });if(gated)return gated;
   if(callback){const result=await callbackConsumer.dispatchNext(client,signal);tainted=result.kind==='unknown'||result.kind==='held';return result;}
   if(campaign){
    if(campaign.recipientRef.startsWith('legacy:')?!legacyRecipient:!campaignOwner)return {kind:'cancelled',reason:'campaign_recipient_unverified'};
    const admitted=await tx(client,async()=>{
     if(campaign.recipientRef.startsWith('legacy:')){
      const time=now(),subject=await legacyRecipient!({client,envelope:Object.freeze(structuredClone(campaign)),now:time,signal});
      if(!subject){const prior=await loadJob(client,campaign.operationId);if(prior)await cancel(client,prior,'campaign_recipient_revoked');return false;}
      if(!validLegacy(subject,campaign.recipientRef,now()))fail('dispatch_legacy_recipient_unverified');
      const payload:DispatchPayload={message:{id:campaign.operationId,kind:'reply',text:campaign.text,buttons:[],commitBarrier:'none'},campaign};
      await insertJob(client,{recipientKind:'legacy_subscription',operationId:campaign.operationId,sourceKind:'campaign',sourceId:campaign.operationId,ownerId:null,sessionId:null,sourceRevision:0,sourceOrdinal:0,controlEpoch:epoch,payload,payloadDigest:dispatchPayloadDigest(payload),recipientRef:campaign.recipientRef});return true;
     }
     const resolved=await campaignOwner!({client,envelope:Object.freeze(structuredClone(campaign)),now:now(),signal});if(!resolved){const prior=await loadJob(client,campaign.operationId);if(prior)await cancel(client,prior,'campaign_recipient_revoked');return false;}if(!id(resolved.ownerId,255)||!validInstant(resolved.expiresAt)||Date.parse(resolved.expiresAt)<=Date.parse(now()))fail('dispatch_campaign_owner_unverified');
     await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba-production-owner:'+resolved.ownerId]);
     const row=(await client.query('select session_id as "sessionId",revision from lba_production_profiles where owner_id=$1 for share',[resolved.ownerId])).rows[0];if(!row)fail('dispatch_profile_missing');
     await syncProfiles(client,resolved.ownerId);
     const payload:DispatchPayload={message:{id:campaign.operationId,kind:'reply',text:campaign.text,buttons:[],commitBarrier:'none'},campaign};
     await insertJob(client,{operationId:campaign.operationId,sourceKind:'campaign',sourceId:campaign.operationId,ownerId:resolved.ownerId,sessionId:row.sessionId,sourceRevision:Number(row.revision),sourceOrdinal:0,controlEpoch:epoch,payload,payloadDigest:dispatchPayloadDigest(payload),recipientRef:campaign.recipientRef});
     return true;
    });
    if(!admitted)return {kind:'cancelled',operationId:campaign.operationId,reason:'campaign_recipient_revoked',outcome:notSent('campaign_recipient_revoked')};
   }
   await hydrate(client,signal,campaign?.operationId);
   const selected=await tx(client,async()=>{
    const rows=await client.query(`select ${JOB_COLUMNS.split(',').map(c=>c.trim().startsWith('queue_seq')?'j.'+c:'j.'+c).join(',')} from lba_production_telegram_dispatch_jobs j join lba_production_telegram_chat_state c on c.bot_id=j.bot_id and c.chat_key=j.chat_key where j.bot_id=$1 and j.control_epoch=$2 and j.state in ('pending','retry_wait') and (j.not_before is null or j.not_before<=$3) and c.reachability<>'forbidden' and (c.next_send_at is null or c.next_send_at<=$3) and not exists(select 1 from lba_production_telegram_dispatch_jobs h where h.bot_id=j.bot_id and (h.owner_id=j.owner_id or h.chat_key=j.chat_key) and h.queue_seq<j.queue_seq and h.state in ('pending','prepared','dispatching','retry_wait','unknown','held') and not(h.source_kind='campaign' and j.source_kind='profile' and j.source_revision<=h.source_revision)) and (j.source_kind<>'campaign' or not exists(select 1 from lba_production_profile_outbox prior where prior.owner_id=j.owner_id and prior.session_id=j.session_id and prior.control_epoch=j.control_epoch and prior.revision<=j.source_revision and prior.status in ('pending','dispatching','unknown'))) ${campaign?"and j.source_kind='campaign' and j.operation_id=$4":"and j.source_kind='profile'"} order by c.last_dispatch_at nulls first,j.queue_seq limit 1`,[DISPATCH_BOT_ID,epoch,now(),...(campaign?[campaign.operationId]:[])]);
    return rows.rows.length?jobRow(rows.rows[0]):null;
   });if(!selected)return {kind:campaign?'deferred':'idle',...(campaign?{operationId:campaign.operationId,reason:'earlier_chat_work'}:{})};
   const result=await execute(client,selected,signal);tainted=result.kind==='unknown'||result.kind==='held';return result;
  }catch(error){tainted=true;try{await client.query('rollback');}catch{}return {kind:'unavailable',reason:error instanceof DispatchError?error.code:'dispatch_unconfirmed'};}
  finally{if(locked)try{await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[dispatchBotLockKey()]);}catch{tainted=true;}try{client.release(tainted?new Error('LBA_DISPATCH_CLIENT_QUARANTINED'):undefined);}catch{}}
 }
 const dispatcher:TelegramDispatcher={dispatchNextPending:signal=>run(signal),dispatchNextCallbackAck:signal=>run(signal,undefined,true),dispatchCampaign:(envelope,signal)=>{let snapshot:CampaignEnvelope;try{snapshot=checkedCampaign(envelope);}catch{return Promise.resolve({kind:'cancelled',reason:'campaign_invalid'});}return run(signal,snapshot);},
  async recoverOperation(operationId){if(!enabled||!hashPattern.test(operationId))return null;const client=await pool.connect();try{return await tx(client,async()=>{const job=(await client.query('select state,fence,control_epoch as "controlEpoch",last_reason as "lastReason" from lba_production_telegram_dispatch_jobs where bot_id=$1 and operation_id=$2',[DISPATCH_BOT_ID,operationId])).rows[0];if(!job||Number(job.controlEpoch)!==epoch)return null;const row=(await client.query('select outcome from lba_production_telegram_dispatch_attempts where operation_id=$1 and fence=$2',[operationId,job.fence])).rows[0];return {state:job.state,fence:Number(job.fence),outcome:row?.outcome?safeOutcome(decoded(row.outcome)):job.state==='not_sent'?safeOutcome(notSent(job.lastReason)):null};});}finally{client.release();}},};
 return Object.freeze(dispatcher);
}
/** Existing campaign engine port, routed through the SAME journal/global coordinator.
 * Local busy/deferred cannot truthfully fabricate a Telegram 429; body null pauses that
 * older engine. A typed runner can handle those states before entering provider send. */
export function campaignSenderFromDispatcher(dispatcher:TelegramDispatcher):CampaignTelegramSender {
 return Object.freeze({kind:'telegram-release-campaign' as const,botId:DISPATCH_BOT_ID,async send(envelope:Readonly<CampaignEnvelope>,signal:AbortSignal){const result=await dispatcher.dispatchCampaign(envelope,signal),o=result.outcome,last=result.receipt?.attempts.at(-1);let body:unknown=null;
  if(o?.kind==='sent'&&last?.providerAccepted&&last.messageId)body={ok:true,result:{message_id:last.messageId}};
  else if(o?.kind==='rate_limited'&&last?.providerErrorCode===429)body={ok:false,error_code:429,parameters:{retry_after:o.retryAfterSeconds}};
  else if(o?.kind==='not_sent'&&last?.providerErrorCode&&last.providerErrorCode<500)body={ok:false,error_code:last.providerErrorCode};
  return {botId:DISPATCH_BOT_ID,recipientRef:envelope.recipientRef,body};}});
}
