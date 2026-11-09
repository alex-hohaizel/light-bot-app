import {createHash} from 'node:crypto';
import {validInstant} from '../../shared/schedule-core.ts';
import type {DeliveryOutcome} from '../../shared/delivery-contract.ts';
import type {DispatchClient,DispatchIdentityReadGrant,DispatchRunResult} from './telegram-dispatch.ts';
import type {TelegramAuthorizationPort,TelegramAuthorizationRequest,TelegramEffectResult,TelegramTransport} from './telegram-transport.ts';

export const CALLBACK_ACK_BOT_ID='8577497098' as const;
/** Explicit additive migration, after the inbox migration. Never executed on import. */
export const TELEGRAM_CALLBACK_ACK_SCHEMA_SQL=`
create table if not exists lba_production_telegram_callback_acks (
 bot_id varchar(32) not null,update_id bigint not null,control_epoch bigint not null,
 operation_id char(64) not null unique,ingress_sha256 char(64) not null,input_sha256 char(64) not null,
 state text not null check(state in ('pending','prepared','dispatching','retry_wait','answered','not_sent','unknown')),
 fence bigint not null default 0,attempts integer not null default 0,not_before timestamptz,
 outcome jsonb,receipt jsonb,last_reason varchar(100),received_at timestamptz not null,updated_at timestamptz not null,
 primary key(bot_id,update_id),foreign key(bot_id,update_id) references lba_production_telegram_inbox(bot_id,update_id)
);
create index if not exists lba_production_telegram_callback_ack_pending on lba_production_telegram_callback_acks(bot_id,control_epoch,update_id) where state in ('pending','prepared','dispatching','retry_wait','unknown');
create table if not exists lba_production_telegram_callback_ack_attempts (
 bot_id varchar(32) not null,update_id bigint not null,fence bigint not null,
 state text not null check(state in ('prepared','dispatching','not_dispatched','answered','rate_limited','not_sent','unknown')),
 prepared_at timestamptz not null,dispatch_marked_at timestamptz,finished_at timestamptz,outcome jsonb,receipt jsonb,
 primary key(bot_id,update_id,fence),foreign key(bot_id,update_id) references lba_production_telegram_callback_acks(bot_id,update_id)
);
`;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const exact=(v:Record<string,any>,keys:string[])=>Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const numeric=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v)&&integer(Number(v),1,2**52-1);
const instant=(v:any)=>v instanceof Date?v.toISOString():validInstant(v)?v:null;
const decoded=(v:any)=>typeof v==='string'?JSON.parse(v):v;
const fail=(code:string):never=>{throw Error(code);};
const notSent=(reason:string):DeliveryOutcome=>({kind:'not_sent',retryable:false,reason});
const unknown=(reason:string):DeliveryOutcome=>({kind:'unknown',reason});
export const callbackAckOperationId=(updateId:string)=>hash(JSON.stringify(['lba-telegram-callback-ack/1',CALLBACK_ACK_BOT_ID,updateId]));
export interface CheckedInboxCallback {updateId:string;ingressSha256:string;inputSha256:string;actorId:string;chatId:string;callbackQueryId:string;receivedAt:string}
/** Only committed inbox-native private callbacks are an ACK capability source. */
export function checkedInboxCallback(row:unknown,epoch:number):CheckedInboxCallback {
 if(!object(row)||row.botId!==CALLBACK_ACK_BOT_ID||!numeric(String(row.updateId))||Number(row.controlEpoch)!==epoch||row.disposition!=='accepted'||row.eventKind!=='callback'||row.ignoredReason!==null||typeof row.ingressSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.ingressSha256)||!instant(row.receivedAt))return fail('callback_source_invalid');
 const p=decoded(row.privateInput),updateId=String(row.updateId);
 if(!object(p)||!exact(p,['version','botId','updateId','actorTelegramId','chatId','messageId','input','callbackQueryId'])||p.version!=='lba-telegram-private-input/1'||p.botId!==CALLBACK_ACK_BOT_ID||p.updateId!==updateId||!numeric(p.actorTelegramId)||p.chatId!==p.actorTelegramId||!integer(p.messageId,1,2**52-1)||typeof p.callbackQueryId!=='string'||!p.callbackQueryId.length||p.callbackQueryId.length>256||/[^\x21-\x7e]/.test(p.callbackQueryId)||!object(p.input)||!exact(p.input,['id','kind','callbackId'])||p.input.id!==`tg:${CALLBACK_ACK_BOT_ID}:${updateId}`||p.input.kind!=='callback'||typeof p.input.callbackId!=='string'||!p.input.callbackId.length||Buffer.byteLength(p.input.callbackId)>64||/[\u0000-\u001f\u007f]/.test(p.input.callbackId))return fail('callback_source_invalid');
 return {updateId,ingressSha256:row.ingressSha256,inputSha256:hash(JSON.stringify(p)),actorId:p.actorTelegramId,chatId:p.chatId,callbackQueryId:p.callbackQueryId,receivedAt:instant(row.receivedAt)!};
}
export function checkedCallbackTransportResult(value:unknown,expected:{operationId:string;recipientRef:string;callbackQueryId:string}):TelegramEffectResult {
 const bad=():TelegramEffectResult=>({outcome:unknown('callback_provider_unverified'),receipt:{botId:CALLBACK_ACK_BOT_ID,operationId:expected.operationId,recipientRef:expected.recipientRef,completedAt:null,attempts:[]}});
 if(!object(value)||!object(value.outcome)||!object(value.receipt))return bad();const o=value.outcome,r=value.receipt;
 if(r.botId!==CALLBACK_ACK_BOT_ID||r.operationId!==expected.operationId||r.recipientRef!==expected.recipientRef||!Array.isArray(r.attempts)||r.attempts.length>1)return bad();const a=r.attempts[0];
 if(a&&(!object(a)||a.method!=='answerCallbackQuery'||typeof a.requestSha256!=='string'||!/^[a-f0-9]{64}$/.test(a.requestSha256)||typeof a.providerAccepted!=='boolean'||a.messageId!==undefined||a.providerErrorCode!==undefined&&!integer(a.providerErrorCode,400,599)))return bad();
 let outcome:DeliveryOutcome;
 if(o.kind==='sent'){if(!a||a.providerAccepted!==true||a.providerErrorCode!==undefined||!validInstant(r.completedAt)||o.receipt!==`tg-callback-${hash(expected.callbackQueryId).slice(0,24)}`)return bad();outcome={kind:'sent',receipt:o.receipt};}
 else if(o.kind==='rate_limited'){if(!a||a.providerAccepted!==false||a.providerErrorCode!==429||!integer(o.retryAfterSeconds,1,86400))return bad();outcome={kind:'rate_limited',retryAfterSeconds:o.retryAfterSeconds};}
 else if(['not_sent','unknown'].includes(o.kind)&&typeof o.reason==='string'&&/^[a-z0-9_]{1,100}$/.test(o.reason)&&(o.kind==='unknown'||o.retryable===false)&&!r.attempts.some((v:any)=>v.providerAccepted)&&!(o.kind==='not_sent'&&a&&(!integer(a.providerErrorCode,400,499)||a.providerErrorCode===429))){outcome=o.kind==='unknown'?unknown(o.reason):notSent(o.reason);}
 else return bad();
 return {outcome,receipt:{botId:CALLBACK_ACK_BOT_ID,operationId:expected.operationId,recipientRef:expected.recipientRef,completedAt:validInstant(r.completedAt)?r.completedAt:null,attempts:a?[{method:'answerCallbackQuery',requestSha256:a.requestSha256,providerAccepted:a.providerAccepted,...(a.providerErrorCode!==undefined?{providerErrorCode:a.providerErrorCode}:{})}]:[]}};
}
export interface CallbackAckPorts {
 epoch:number;now:()=>string;maxAgeMs:number;maxAttempts:number;retryMs:number;minBotIntervalMs:number;
 transaction:<T>(client:DispatchClient,work:()=>Promise<T>)=>Promise<T>;
 hold:(client:DispatchClient,reason:string,operation:string|null)=>Promise<void>;
 readGrant?:(request:{actorId:string;capabilityId:string;botId:typeof CALLBACK_ACK_BOT_ID;controlEpoch:number;operationId:string;signal:AbortSignal})=>Promise<DispatchIdentityReadGrant|null>;
 transport:(request:{authorize:TelegramAuthorizationPort;operationId:string;callbackRef:string;recipientRef:string})=>TelegramTransport;
}
const SOURCE=`i.bot_id as "botId",i.update_id as "updateId",i.control_epoch as "controlEpoch",i.payload_sha256 as "ingressSha256",i.disposition,i.event_kind as "eventKind",i.ignored_reason as "ignoredReason",i.private_input as "privateInput",i.received_at as "receivedAt"`;
/** Internal port: caller already holds the SAME bot-global session lock used by all messages/campaigns. */
export function createCallbackAckConsumer(p:CallbackAckPorts){
 const tx=p.transaction,now=p.now,bot=CALLBACK_ACK_BOT_ID;
 async function available(c:DispatchClient){return Boolean((await c.query("select to_regclass('lba_production_telegram_callback_acks') as name")).rows[0]?.name);}
 async function source(c:DispatchClient,updateId:string){const row=(await c.query(`select ${SOURCE} from lba_production_telegram_inbox i where i.bot_id=$1 and i.update_id=$2 for share`,[bot,updateId])).rows;return row.length===1?checkedInboxCallback(row[0],p.epoch):fail('callback_source_missing');}
 const fresh=(input:CheckedInboxCallback)=>{const age=Date.parse(now())-Date.parse(input.receivedAt);return age>=0&&age<p.maxAgeMs;};
 async function recoverOrphans(c:DispatchClient):Promise<boolean>{
  if(!await available(c))return false;return tx(c,async()=>{
   const old=(await c.query("select operation_id as id from lba_production_telegram_callback_acks where bot_id=$1 and (state in ('dispatching','unknown') or control_epoch<>$2 and state in ('pending','prepared','retry_wait')) order by update_id limit 1",[bot,p.epoch])).rows[0];
   if(old){await c.query("update lba_production_telegram_callback_ack_attempts set state='unknown',finished_at=$2,outcome=$3::jsonb where bot_id=$1 and state='dispatching'",[bot,now(),JSON.stringify(unknown('callback_orphan_dispatch'))]);await c.query("update lba_production_telegram_callback_acks set state='unknown',last_reason='callback_orphan_dispatch',outcome=$2::jsonb,updated_at=$3 where bot_id=$1 and state='dispatching'",[bot,JSON.stringify(unknown('callback_orphan_dispatch')),now()]);await p.hold(c,'callback_unreconciled',old.id);return true;}
   await c.query("update lba_production_telegram_callback_ack_attempts set state='not_dispatched',finished_at=$3 where bot_id=$1 and state='prepared' and exists(select 1 from lba_production_telegram_callback_acks a where a.bot_id=$1 and a.update_id=lba_production_telegram_callback_ack_attempts.update_id and a.control_epoch=$2 and a.state='prepared')",[bot,p.epoch,now()]);
   await c.query("update lba_production_telegram_callback_acks set state='pending',last_reason='callback_prepared_recovered',updated_at=$2 where bot_id=$1 and control_epoch=$3 and state='prepared'",[bot,now(),p.epoch]);return false;
  });
 }
 async function dispatchNext(c:DispatchClient,signal:AbortSignal):Promise<DispatchRunResult>{
  if(!await available(c))return {kind:'unavailable',reason:'callback_schema_missing'};
  const claimed=await tx(c,async()=>{
   const candidates=(await c.query(`select ${SOURCE} from lba_production_telegram_inbox i left join lba_production_telegram_callback_acks a on a.bot_id=i.bot_id and a.update_id=i.update_id where i.bot_id=$1 and i.control_epoch=$2 and i.disposition='accepted' and i.event_kind='callback' and (a.update_id is null or a.state in ('pending','retry_wait') and (a.not_before is null or a.not_before<=$3)) order by i.update_id limit 1`,[bot,p.epoch,now()])).rows;
   if(!candidates.length)return null;const input=checkedInboxCallback(candidates[0],p.epoch),op=callbackAckOperationId(input.updateId);
   await c.query("insert into lba_production_telegram_callback_acks(bot_id,update_id,control_epoch,operation_id,ingress_sha256,input_sha256,state,received_at,updated_at) values($1,$2,$3,$4,$5,$6,'pending',$7,$8) on conflict(bot_id,update_id) do nothing",[bot,input.updateId,p.epoch,op,input.ingressSha256,input.inputSha256,input.receivedAt,now()]);
   const row=(await c.query('select * from lba_production_telegram_callback_acks where bot_id=$1 and update_id=$2 for update',[bot,input.updateId])).rows[0];
   if(!row||row.operation_id!==op||row.ingress_sha256!==input.ingressSha256||row.input_sha256!==input.inputSha256||Number(row.control_epoch)!==p.epoch||!['pending','retry_wait'].includes(row.state))return fail('callback_journal_conflict');
   if(!fresh(input)||Number(row.attempts)>=p.maxAttempts){await c.query("update lba_production_telegram_callback_acks set state='not_sent',last_reason='callback_expired_or_attempt_limit',outcome=$3::jsonb,updated_at=$4 where bot_id=$1 and update_id=$2",[bot,input.updateId,JSON.stringify(notSent('callback_expired_or_attempt_limit')),now()]);return {terminal:true as const,operationId:op};}
   const fence=Number(row.fence)+1;if(!integer(fence,1)||!integer(Number(row.attempts),0,p.maxAttempts))return fail('callback_journal_invalid');
   await c.query("update lba_production_telegram_callback_acks set state='prepared',fence=$3,attempts=attempts+1,updated_at=$4 where bot_id=$1 and update_id=$2",[bot,input.updateId,fence,now()]);
   await c.query("insert into lba_production_telegram_callback_ack_attempts(bot_id,update_id,fence,state,prepared_at) values($1,$2,$3,'prepared',$4)",[bot,input.updateId,fence,now()]);return {terminal:false as const,input,operationId:op,fence,attempts:Number(row.attempts)+1};
  });
  if(!claimed)return {kind:'idle'};if(claimed.terminal)return {kind:'cancelled',operationId:claimed.operationId,reason:'callback_expired_or_attempt_limit'};
  const {input,operationId,fence,attempts}=claimed,recipientRef='callback:'+operationId,callbackRef='inbox:'+input.updateId,actorId='callback:'+hash(input.actorId).slice(0,40),capabilityId=`ack:${operationId}:${fence}`,readActor='service:telegram-dispatch',readCapability=`callback-read:${operationId}:${fence}`;
  let phase:'identity'|'native'|'closed'='identity',nativeInvoked=false;
  async function guarded(){const current=await source(c,input.updateId),row=(await c.query('select state,fence,input_sha256,control_epoch from lba_production_telegram_callback_acks where bot_id=$1 and update_id=$2 for update',[bot,input.updateId])).rows[0];if(signal.aborted||!fresh(current)||current.inputSha256!==input.inputSha256||current.ingressSha256!==input.ingressSha256||!row||Number(row.fence)!==fence||row.state!=='dispatching'||row.input_sha256!==input.inputSha256||Number(row.control_epoch)!==p.epoch)fail('callback_guard_rejected');return current;}
  const authorize:TelegramAuthorizationPort=async(request,abort)=>{
   if(abort.aborted||phase==='closed')return null;
   if(phase==='identity'){
    if(request.actorId!==readActor||request.capabilityId!==readCapability||request.method!=='getMe'||request.botId!==bot||request.dispatchIndex!==1||request.operationId!==undefined||!p.readGrant)return null;
    const grant=await p.readGrant({actorId:readActor,capabilityId:readCapability,botId:bot,controlEpoch:p.epoch,operationId,signal:abort});
    if(abort.aborted||!grant||grant.actorId!==readActor||grant.capabilityId!==readCapability||grant.botId!==bot||grant.controlEpoch!==p.epoch||!validInstant(grant.expiresAt)||Date.parse(grant.expiresAt)<=Date.parse(now()))return null;return {...request,expiresAt:grant.expiresAt};
   }
   if(request.actorId!==actorId||request.capabilityId!==capabilityId||request.operationId!==operationId||request.recipientRef!==recipientRef||request.callbackRef!==callbackRef||request.method!=='answerCallbackQuery'||request.botId!==bot||request.dispatchIndex!==1||request.fallbackFrom!==undefined)return null;
   const current=await guarded();if(abort.aborted||phase!=='native'||!fresh(current))return null;return {...request,expiresAt:new Date(Math.min(Date.parse(input.receivedAt)+p.maxAgeMs,Date.parse(now())+10000)).toISOString(),chatId:current.chatId,chatType:'private',bindingRevision:'inbox:'+input.ingressSha256,callbackQueryId:current.callbackQueryId};
  };
  const transport=p.transport({authorize,operationId,callbackRef,recipientRef});if(transport?.botId!==bot||typeof transport.read?.getMe!=='function'||typeof transport.effects?.answerCallbackQuery!=='function')return fail('callback_transport_invalid');
  try{
   const identity=await transport.read.getMe({actorId:readActor,capabilityId:readCapability},signal);
   if(!identity.ok||identity.value.botId!==bot||identity.value.username!=='PowerUkraineBot'){
    phase='closed';await tx(c,async()=>{const outcome=!identity.ok?identity.outcome:notSent('callback_identity_unverified'),retryAt=new Date(Date.parse(now())+(outcome.kind==='rate_limited'?outcome.retryAfterSeconds*1000:p.retryMs)).toISOString();await c.query("update lba_production_telegram_callback_ack_attempts set state='not_dispatched',finished_at=$4,outcome=$5::jsonb where bot_id=$1 and update_id=$2 and fence=$3",[bot,input.updateId,fence,now(),JSON.stringify(outcome)]);await c.query("update lba_production_telegram_callback_acks set state='retry_wait',not_before=$3,last_reason='callback_identity_unverified',updated_at=$4 where bot_id=$1 and update_id=$2",[bot,input.updateId,retryAt,now()]);await c.query('update lba_production_telegram_bot_state set next_send_at=greatest(coalesce(next_send_at,$2),$2),updated_at=$3 where bot_id=$1',[bot,retryAt,now()]);if(outcome.kind==='rate_limited')await c.query('update lba_production_telegram_bot_state set cooldown_until=greatest(coalesce(cooldown_until,$2),$2),updated_at=$3 where bot_id=$1',[bot,retryAt,now()]);if(outcome.kind==='unknown')await p.hold(c,'callback_identity_read_unknown',operationId);});return {kind:'deferred',operationId,reason:'callback_identity_unverified'};
   }
   await tx(c,async()=>{const current=await source(c,input.updateId);if(signal.aborted||!fresh(current)||current.inputSha256!==input.inputSha256)fail('callback_guard_rejected');const result=await c.query("update lba_production_telegram_callback_acks set state='dispatching',updated_at=$4 where bot_id=$1 and update_id=$2 and fence=$3 and state='prepared'",[bot,input.updateId,fence,now()]);if(result.rowCount!==1)fail('callback_fence_lost');await c.query("update lba_production_telegram_callback_ack_attempts set state='dispatching',dispatch_marked_at=$4 where bot_id=$1 and update_id=$2 and fence=$3 and state='prepared'",[bot,input.updateId,fence,now()]);});
   return await tx(c,async()=>{
    await guarded();phase='native';nativeInvoked=true;const result=checkedCallbackTransportResult(await transport.effects.answerCallbackQuery({actorId,capabilityId,operationId,recipientRef,callbackRef},{},signal),{operationId,recipientRef,callbackQueryId:input.callbackQueryId});phase='closed';
    const o=result.outcome,time=now(),retryAt=o.kind==='rate_limited'?new Date(Date.parse(time)+o.retryAfterSeconds*1000).toISOString():null,state=o.kind==='sent'?'answered':o.kind==='unknown'?'unknown':o.kind==='rate_limited'&&attempts<p.maxAttempts?'retry_wait':'not_sent';
    const updated=await c.query('update lba_production_telegram_callback_acks set state=$4,not_before=$5,outcome=$6::jsonb,receipt=$7::jsonb,last_reason=$8,updated_at=$9 where bot_id=$1 and update_id=$2 and fence=$3 and state=\'dispatching\'',[bot,input.updateId,fence,state,retryAt,JSON.stringify(o),JSON.stringify(result.receipt),o.kind,time]);if(updated.rowCount!==1)fail('callback_fence_lost');
    await c.query('update lba_production_telegram_callback_ack_attempts set state=$4,finished_at=$5,outcome=$6::jsonb,receipt=$7::jsonb where bot_id=$1 and update_id=$2 and fence=$3',[bot,input.updateId,fence,o.kind==='sent'?'answered':o.kind,time,JSON.stringify(o),JSON.stringify(result.receipt)]);
    await c.query('update lba_production_telegram_bot_state set next_send_at=$2,updated_at=$3 where bot_id=$1',[bot,new Date(Date.parse(time)+p.minBotIntervalMs).toISOString(),time]);if(retryAt)await c.query('update lba_production_telegram_bot_state set cooldown_until=greatest(coalesce(cooldown_until,$2),$2),updated_at=$3 where bot_id=$1',[bot,retryAt,time]);if(o.kind==='unknown')await p.hold(c,'callback_provider_unknown',operationId);
    return {kind:o.kind==='unknown'?'unknown':'completed',operationId,outcome:o,receipt:result.receipt};
   });
  }catch{
   phase='closed';try{const result=await tx(c,async()=>{const row=(await c.query('select state,receipt,outcome from lba_production_telegram_callback_acks where bot_id=$1 and update_id=$2 for update',[bot,input.updateId])).rows[0];if(row?.state==='answered')return {kind:'completed' as const,operationId,...checkedCallbackTransportResult({outcome:decoded(row.outcome),receipt:decoded(row.receipt)},{operationId,recipientRef,callbackQueryId:input.callbackQueryId})};const ambiguous=nativeInvoked;await c.query("update lba_production_telegram_callback_acks set state=$3,outcome=$4::jsonb,last_reason=$5,updated_at=$6 where bot_id=$1 and update_id=$2 and fence=$7",[bot,input.updateId,ambiguous?'unknown':'not_sent',JSON.stringify(ambiguous?unknown('callback_unconfirmed'):notSent('callback_guard_rejected')),ambiguous?'callback_unconfirmed':'callback_guard_rejected',now(),fence]);await c.query('update lba_production_telegram_callback_ack_attempts set state=$4,finished_at=$5,outcome=$6::jsonb where bot_id=$1 and update_id=$2 and fence=$3',[bot,input.updateId,fence,ambiguous?'unknown':'not_sent',now(),JSON.stringify(ambiguous?unknown('callback_unconfirmed'):notSent('callback_guard_rejected'))]);if(ambiguous)await p.hold(c,'callback_unconfirmed',operationId);return {kind:ambiguous?'unknown' as const:'cancelled' as const,operationId,...(ambiguous?{outcome:unknown('callback_unconfirmed')}:{reason:'callback_guard_rejected'})};});return result;}catch{return {kind:'unknown',operationId,outcome:unknown('callback_storage_unconfirmed')};}
  }finally{phase='closed';}
 }
 return Object.freeze({recoverOrphans,dispatchNext});
}
