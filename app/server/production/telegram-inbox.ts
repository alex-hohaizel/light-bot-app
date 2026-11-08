import {createHash,timingSafeEqual} from 'node:crypto';
import type {BotInput} from '../../shared/bot/types.ts';
import {validInstant} from '../../shared/schedule-core.ts';

export const TELEGRAM_INBOX_BOT_ID='8577497098' as const;
export const TELEGRAM_INBOX_VERSION='lba-telegram-inbox/1' as const;
/** Explicit additive migration only. Construction/import never executes SQL. */
export const TELEGRAM_INBOX_SCHEMA_SQL=`
create table if not exists lba_production_telegram_inbox (
 bot_id varchar(32) not null,update_id bigint not null check(update_id>0 and update_id<=4503599627370495),
 payload_sha256 char(64) not null,control_epoch bigint not null check(control_epoch>0 and control_epoch<=9007199254740991),
 disposition text not null check(disposition in ('accepted','ignored')),
 event_kind text not null check(event_kind in ('message','callback','ignored')),
 ignored_reason text,private_input jsonb,received_at timestamptz not null,
 primary key(bot_id,update_id),
 check((disposition='accepted' and event_kind in ('message','callback') and private_input is not null and ignored_reason is null)
 or (disposition='ignored' and event_kind='ignored' and private_input is null and ignored_reason is not null))
);
create index if not exists lba_production_telegram_inbox_received on lba_production_telegram_inbox(bot_id,control_epoch,received_at,update_id) where disposition='accepted';
`;
export interface TelegramInboxQuery {query(sql:string,values?:any[]):Promise<{rows:any[];rowCount:number|null}>}
export interface TelegramInboxClient extends TelegramInboxQuery {release():void}
export interface TelegramInboxPool {connect():Promise<TelegramInboxClient>}
/** Verified native private-chat facts, NOT an application principal or account ownership claim. */
export interface TelegramPrivateInput {
 version:'lba-telegram-private-input/1';botId:typeof TELEGRAM_INBOX_BOT_ID;updateId:string;
 actorTelegramId:string;chatId:string;messageId:number;input:BotInput;
 callbackQueryId?:string;
}
type IgnoredReason='unsupported_update'|'unsupported_chat'|'unsupported_message_content'|'inline_callback'|'inaccessible_callback'|'unsupported_callback';
interface ParsedUpdate {updateId:string;payloadSha256:string;disposition:'accepted'|'ignored';eventKind:'message'|'callback'|'ignored';ignoredReason:IgnoredReason|null;privateInput:TelegramPrivateInput|null}
export type TelegramInboxCode='TELEGRAM_INBOX_SECRET_INVALID'|'TELEGRAM_INBOX_PAYLOAD_INVALID'|'TELEGRAM_INBOX_PAYLOAD_LIMIT'|
 'TELEGRAM_INBOX_CALLBACK_INVALID'|'TELEGRAM_INBOX_CALLBACK_BOT_MISMATCH'|'TELEGRAM_INBOX_PRIVATE_ACTOR_MISMATCH'|
 'TELEGRAM_INBOX_DISABLED'|'TELEGRAM_INBOX_CONTROL_NOT_CANONICAL'|'TELEGRAM_INBOX_CONTROL_EPOCH_CONFLICT'|
 'TELEGRAM_INBOX_STORAGE_UNAVAILABLE'|'TELEGRAM_INBOX_RECORD_INVALID'|'TELEGRAM_INBOX_UPDATE_CONFLICT'|
 'TELEGRAM_INBOX_COMMIT_UNKNOWN'|'TELEGRAM_INBOX_CLOCK_INVALID';
export interface TelegramInboxReceipt {
 version:typeof TELEGRAM_INBOX_VERSION;phase:'ingress_committed';botId:typeof TELEGRAM_INBOX_BOT_ID;updateId:string;
 disposition:'accepted'|'ignored';ignoredReason:IgnoredReason|null;controlEpoch:number;receivedAt:string;
}
type Failure={status:'rejected'|'unavailable'|'unknown';ack:false;code:TelegramInboxCode};
export type TelegramInboxAcceptResult={status:'committed';ack:true;receipt:TelegramInboxReceipt;replayed:boolean}|Failure;
export type TelegramInboxRecoveryResult={status:'committed';ack:true;receipt:TelegramInboxReceipt}|{status:'missing';ack:false}|Failure;
export interface TelegramInbox {
 accept(header:unknown,raw:unknown):Promise<TelegramInboxAcceptResult>;
 recoverReceipt(header:unknown,raw:unknown):Promise<TelegramInboxRecoveryResult>;
}
class InboxRefusal extends Error {readonly code:TelegramInboxCode;constructor(code:TelegramInboxCode){super(code);this.code=code;}}
const fail=(code:TelegramInboxCode):never=>{throw new InboxRefusal(code);};
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const integer=(v:unknown,min=0,max=2**52-1):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const safeText=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&(empty||v.length>0)&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(v);
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
/** JSON.parse validates grammar; this additional bounded walk rejects duplicate object
 * keys before they can be silently collapsed into a different canonical payload. */
function rejectDuplicateKeys(raw:string):void {
 let i=0,nodes=0;
 const space=()=>{while(/\s/.test(raw[i]??'')&&i<raw.length)i++;};
 const string=()=>{const start=i++;while(i<raw.length){if(raw[i]==='\\'){i+=2;continue;}if(raw[i++]==='"')return JSON.parse(raw.slice(start,i));}return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');};
 const value=(depth:number):void=>{
  if(depth>16||++nodes>20_000)return fail('TELEGRAM_INBOX_PAYLOAD_LIMIT');space();
  if(raw[i]==='{'){
   i++;space();const seen=new Set<string>();if(raw[i]==='}'){i++;return;}
   while(i<raw.length){space();const key=string();if(seen.has(key)||['__proto__','prototype','constructor'].includes(key))return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');seen.add(key);space();i++;value(depth+1);space();if(raw[i++]==='}')return;}
  }else if(raw[i]==='['){i++;space();if(raw[i]===']'){i++;return;}while(i<raw.length){value(depth+1);space();if(raw[i++]===']')return;}}
  else if(raw[i]==='"'){string();}
  else{while(i<raw.length&&!/[\s,}\]]/.test(raw[i]))i++;}
 };
 value(0);
}
function parsedNative(raw:unknown,maxBytes:number):{payload:Record<string,any>;payloadSha256:string}{
 let bytes:Uint8Array;
 if(typeof raw==='string'){if(/[\ud800-\udfff]/u.test(raw))return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');if(Buffer.byteLength(raw,'utf8')>maxBytes)return fail('TELEGRAM_INBOX_PAYLOAD_LIMIT');bytes=Buffer.from(raw);}
 else if(raw instanceof Uint8Array){if(raw.byteLength>maxBytes)return fail('TELEGRAM_INBOX_PAYLOAD_LIMIT');bytes=Uint8Array.from(raw);}
 else return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');
 if(!bytes.byteLength)return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');
 let value:unknown,text:string;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(text);}catch{return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');}
 rejectDuplicateKeys(text);
 const inspect=(v:any):void=>{if(typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v))||typeof v==='string'&&/[\ud800-\udfff]/u.test(v))return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');if(v&&typeof v==='object')for(const item of Object.values(v))inspect(item);};
 inspect(value);
 if(!plain(value)||!integer(value.update_id,1))return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');
 return {payload:value,payloadSha256:sha(canonical(value))};
}
function normalize(raw:unknown,maxBytes:number):ParsedUpdate {
 const {payload,payloadSha256}=parsedNative(raw,maxBytes),updateId=String(payload.update_id),keys=Object.keys(payload).filter(k=>k!=='update_id');
 if(keys.length!==1)return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');
 const ignored=(reason:IgnoredReason):ParsedUpdate=>({updateId,payloadSha256,disposition:'ignored',eventKind:'ignored',ignoredReason:reason,privateInput:null});
 const ownedActor=(from:unknown,chat:unknown):string=>{
  if(!plain(from)||!integer(from.id,1)||from.is_bot!==false||String(from.id)===TELEGRAM_INBOX_BOT_ID||!plain(chat)||chat.type!=='private'||!integer(chat.id,1)||chat.id!==from.id)return fail('TELEGRAM_INBOX_PRIVATE_ACTOR_MISMATCH');
  return String(from.id);
 };
 const trusted=(kind:'message'|'callback',actor:string,messageId:number,input:BotInput,callbackQueryId?:string):ParsedUpdate=>({updateId,payloadSha256,disposition:'accepted',eventKind:kind,ignoredReason:null,
  privateInput:{version:'lba-telegram-private-input/1',botId:TELEGRAM_INBOX_BOT_ID,updateId,actorTelegramId:actor,chatId:actor,messageId,input,...(callbackQueryId?{callbackQueryId}:{})}});
 const inputId=`tg:${TELEGRAM_INBOX_BOT_ID}:${updateId}`;
 if(keys[0]==='message'){
  const message=payload.message;if(!plain(message)||!plain(message.chat))return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');
  if(message.chat.type!=='private')return ignored('unsupported_chat');
  if(message.text===undefined)return ignored('unsupported_message_content');
  const actor=ownedActor(message.from,message.chat);
  if(!integer(message.message_id,1)||!integer(message.date,1)||!safeText(message.text,4096))return fail('TELEGRAM_INBOX_PAYLOAD_INVALID');
  return trusted('message',actor,message.message_id,{id:inputId,kind:message.text.trimStart().startsWith('/')?'command':'text',text:message.text});
 }
 if(keys[0]==='callback_query'){
  const cb=payload.callback_query;if(!plain(cb))return fail('TELEGRAM_INBOX_CALLBACK_INVALID');
  if(cb.inline_message_id!==undefined){if(cb.message!==undefined)return fail('TELEGRAM_INBOX_CALLBACK_INVALID');return ignored('inline_callback');}
  if(!plain(cb.message)||!plain(cb.message.chat))return fail('TELEGRAM_INBOX_CALLBACK_INVALID');
  if(cb.message.chat.type!=='private')return ignored('unsupported_chat');
  if(cb.message.date===0)return ignored('inaccessible_callback');
  const actor=ownedActor(cb.from,cb.message.chat);
  if(!plain(cb.message.from)||!integer(cb.message.from.id,1)||String(cb.message.from.id)!==TELEGRAM_INBOX_BOT_ID||cb.message.from.is_bot!==true)return fail('TELEGRAM_INBOX_CALLBACK_BOT_MISMATCH');
  if(cb.data===undefined&&cb.game_short_name!==undefined)return ignored('unsupported_callback');
  if(cb.game_short_name!==undefined||!safeText(cb.id,256)||/[^\x21-\x7e]/.test(cb.id)||!safeText(cb.data,64)||Buffer.byteLength(cb.data,'utf8')>64||
   !integer(cb.message.message_id,1)||!integer(cb.message.date,1)||!safeText(cb.chat_instance,256))return fail('TELEGRAM_INBOX_CALLBACK_INVALID');
  return trusted('callback',actor,cb.message.message_id,{id:inputId,kind:'callback',callbackId:cb.data},cb.id);
 }
 return ignored('unsupported_update');
}
const SELECT_RECEIPT=`select bot_id as "botId",update_id as "updateId",payload_sha256 as "payloadSha256",control_epoch as "controlEpoch",disposition,event_kind as "eventKind",ignored_reason as "ignoredReason",private_input as "privateInput",received_at as "receivedAt" from lba_production_telegram_inbox where bot_id=$1 and update_id=$2 for share`;
const ignoredReasons=['unsupported_update','unsupported_chat','unsupported_message_content','inline_callback','inaccessible_callback','unsupported_callback'];
function receipt(row:any,input:ParsedUpdate,epoch:number):TelegramInboxReceipt {
 const receivedAt=row?.receivedAt instanceof Date?row.receivedAt.toISOString():row?.receivedAt;
 if(!plain(row)||row.botId!==TELEGRAM_INBOX_BOT_ID||String(row.updateId)!==input.updateId||!Number.isSafeInteger(Number(row.updateId))||!integer(Number(row.controlEpoch),1,Number.MAX_SAFE_INTEGER)||
  !/^[a-f0-9]{64}$/.test(row.payloadSha256)||!['accepted','ignored'].includes(row.disposition)||!validInstant(receivedAt)||
  row.disposition==='accepted'&&(!['message','callback'].includes(row.eventKind)||row.ignoredReason!==null)||
  row.disposition==='ignored'&&(row.eventKind!=='ignored'||!ignoredReasons.includes(row.ignoredReason)))return fail('TELEGRAM_INBOX_RECORD_INVALID');
 if(row.payloadSha256!==input.payloadSha256)return fail('TELEGRAM_INBOX_UPDATE_CONFLICT');
 if(Number(row.controlEpoch)!==epoch)return fail('TELEGRAM_INBOX_CONTROL_EPOCH_CONFLICT');
 if(row.disposition!==input.disposition||row.eventKind!==input.eventKind||row.ignoredReason!==input.ignoredReason)return fail('TELEGRAM_INBOX_RECORD_INVALID');
 if(canonical(row.privateInput)!==canonical(input.privateInput))return fail('TELEGRAM_INBOX_RECORD_INVALID');
 return {version:TELEGRAM_INBOX_VERSION,phase:'ingress_committed',botId:TELEGRAM_INBOX_BOT_ID,updateId:input.updateId,disposition:row.disposition,ignoredReason:row.ignoredReason,controlEpoch:Number(row.controlEpoch),receivedAt};
}
function safeFailure(error:unknown,commitStarted=false):Failure {
 if(commitStarted)return {status:'unknown',ack:false,code:'TELEGRAM_INBOX_COMMIT_UNKNOWN'};
 const code=error instanceof InboxRefusal?error.code:'TELEGRAM_INBOX_STORAGE_UNAVAILABLE';
 return {status:code==='TELEGRAM_INBOX_STORAGE_UNAVAILABLE'?'unavailable':'rejected',ack:false,code};
}
export function createTelegramInbox(options:{
 enabled?:boolean;expectedBotId:typeof TELEGRAM_INBOX_BOT_ID;expectedControlEpoch:number;secret:string;pool:TelegramInboxPool;now:()=>string;maxBytes?:number;
}):TelegramInbox {
 if(!options||options.expectedBotId!==TELEGRAM_INBOX_BOT_ID||!integer(options.expectedControlEpoch,1,Number.MAX_SAFE_INTEGER)||typeof options.secret!=='string'||!/^[-_A-Za-z0-9]{1,256}$/.test(options.secret)||
  !options.pool||typeof options.pool.connect!=='function'||typeof options.now!=='function'||options.enabled!==undefined&&typeof options.enabled!=='boolean'||!integer(options.maxBytes??262144,1,262144))throw new Error('INVALID_TELEGRAM_INBOX_OPTIONS');
 const enabled=options.enabled===true,epoch=options.expectedControlEpoch,pool=options.pool,clockPort=options.now,maxBytes=options.maxBytes??262144,
  secretDigest=createHash('sha256').update(options.secret).digest();
 let lastTime=-Infinity;
 const clock=()=>{const now=clockPort();if(!validInstant(now)||Date.parse(now)<lastTime)return fail('TELEGRAM_INBOX_CLOCK_INVALID');lastTime=Date.parse(now);return now;};
 const preflight=(header:unknown,raw:unknown):ParsedUpdate=>{
  const valid=typeof header==='string'&&/^[-_A-Za-z0-9]{1,256}$/.test(header),candidate=typeof header==='string'&&header.length<=1024?header:'';
  const matches=timingSafeEqual(secretDigest,createHash('sha256').update(candidate).digest());
  if(!matches||!valid)return fail('TELEGRAM_INBOX_SECRET_INVALID');
  if(!enabled)return fail('TELEGRAM_INBOX_DISABLED');
  const parsed=normalize(raw,maxBytes);clock();return parsed;
 };
 async function transaction<T>(input:ParsedUpdate,work:(client:TelegramInboxClient)=>Promise<T>):Promise<T|Failure>{
  let client:TelegramInboxClient;
  try{client=await pool.connect();}catch{return safeFailure(null);}
  let began=false,commitStarted=false,committed=false,result:T|Failure;
  try{
   await client.query('begin isolation level read committed');began=true;
   const control=await client.query('select control_epoch as "controlEpoch",writer_mode as "writerMode" from lba_production_control where id=true for share');
   if(control.rows.length!==1||control.rows[0].writerMode!=='canonical')return fail('TELEGRAM_INBOX_CONTROL_NOT_CANONICAL');
   if(Number(control.rows[0].controlEpoch)!==epoch)return fail('TELEGRAM_INBOX_CONTROL_EPOCH_CONFLICT');
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`lba-telegram-inbox:${TELEGRAM_INBOX_BOT_ID}:${input.updateId}`]);
   result=await work(client);commitStarted=true;await client.query('commit');committed=true;
  }catch(error){if(began&&!committed)try{await client.query('rollback');}catch{}result=safeFailure(error,commitStarted);}
  try{client.release();}catch{return safeFailure(null,committed||commitStarted);}
  return result!;
 }
 return Object.freeze({
  async accept(header:unknown,raw:unknown):Promise<TelegramInboxAcceptResult>{
   let input:ParsedUpdate;try{input=preflight(header,raw);}catch(error){return safeFailure(error);}
   return transaction(input,async client=>{
    const previous=await client.query(SELECT_RECEIPT,[TELEGRAM_INBOX_BOT_ID,input.updateId]);
    if(previous.rows.length>1)return fail('TELEGRAM_INBOX_RECORD_INVALID');
    if(previous.rows.length)return {status:'committed' as const,ack:true as const,receipt:receipt(previous.rows[0],input,epoch),replayed:true};
    const receivedAt=clock();
    const inserted=await client.query(`insert into lba_production_telegram_inbox(bot_id,update_id,payload_sha256,control_epoch,disposition,event_kind,ignored_reason,private_input,received_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) on conflict(bot_id,update_id) do nothing`,
     [TELEGRAM_INBOX_BOT_ID,input.updateId,input.payloadSha256,epoch,input.disposition,input.eventKind,input.ignoredReason,input.privateInput?JSON.stringify(input.privateInput):null,receivedAt]);
    const row=await client.query(SELECT_RECEIPT,[TELEGRAM_INBOX_BOT_ID,input.updateId]);if(row.rows.length!==1)return fail('TELEGRAM_INBOX_RECORD_INVALID');
    return {status:'committed' as const,ack:true as const,receipt:receipt(row.rows[0],input,epoch),replayed:inserted.rowCount===0};
   });
  },
  async recoverReceipt(header:unknown,raw:unknown):Promise<TelegramInboxRecoveryResult>{
   let input:ParsedUpdate;try{input=preflight(header,raw);}catch(error){return safeFailure(error);}
   return transaction(input,async client=>{
    const rows=await client.query(SELECT_RECEIPT,[TELEGRAM_INBOX_BOT_ID,input.updateId]);if(rows.rows.length>1)return fail('TELEGRAM_INBOX_RECORD_INVALID');
    return rows.rows.length?{status:'committed' as const,ack:true as const,receipt:receipt(rows.rows[0],input,epoch)}:{status:'missing' as const,ack:false as const};
   });
  },
 });
}
