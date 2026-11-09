import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {LegacyProfileReadQuery} from './profile-reader.ts';
import {validInstant} from '../../shared/schedule-core.ts';

export const LEGACY_CAMPAIGN_BOT_ID='8577497098' as const;
/** Private endpoint registry, not account ownership. Explicit migration only;
 * import/construction never installs DDL, reads environment or seeds recipients. */
export const LEGACY_CAMPAIGN_RECIPIENT_SCHEMA_SQL=`
create table if not exists lba_legacy_campaign_recipient (
 recipient_ref varchar(43) primary key,bot_id varchar(32) not null,chat_id varchar(50) not null,
 control_epoch bigint not null check(control_epoch>0 and control_epoch<=9007199254740991),
 subscriber_digest char(64) not null,binding_revision char(64) not null,created_at timestamptz not null,revoked_at timestamptz,
 unique(bot_id,chat_id),check(recipient_ref ~ '^legacy:[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$')
);
`;
export interface LegacyCampaignRecipientSubject {
 kind:'legacy_subscription';recipientRef:string;botId:typeof LEGACY_CAMPAIGN_BOT_ID;chatId:string;mappingRevision:string;expiresAt:string;
}
interface Request {now:string;signal:AbortSignal}
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const chat=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)<=2**52-1;
const ref=(v:unknown):v is string=>typeof v==='string'&&/^legacy:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const epoch=(v:unknown,n:number)=>Boolean((typeof v==='number'&&Number.isSafeInteger(v)||typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v))&&Number(v)===n);
const instant=(v:unknown)=>v instanceof Date&&Number.isFinite(v.getTime())?v.toISOString():validInstant(v)?new Date(Date.parse(v)).toISOString():null;
const fail=(reason:string):never=>{throw Error('LEGACY_CAMPAIGN_RECIPIENT_'+reason);};
function canonical(v:unknown,depth=0):string{
 if(depth>32)return fail('ROW_INVALID');
 if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);
 if(typeof v==='number'&&Number.isFinite(v))return String(v);
 if(Array.isArray(v))return '['+v.map(value=>canonical(value,depth+1)).join(',')+']';
 if(plain(v))return '{'+Object.keys(v).sort().map(key=>JSON.stringify(key)+':'+canonical(v[key],depth+1)).join(',')+'}';
 return fail('ROW_INVALID');
}
const sameHex=(a:unknown,b:string)=>hex(a)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
function request(value:Request,identityKey:'chatId'|'recipientRef'):boolean{return Boolean(plain(value)&&Object.keys(value).length===3&&Object.keys(value).every(k=>['now','signal',identityKey].includes(k))&&validInstant(value.now)&&value.signal&&typeof value.signal.aborted==='boolean'&&typeof value.signal.addEventListener==='function');}

/** Provided-transaction-only port. It neither begins/commits transactions nor
 * grants campaign/native authority. Root's coordinator must independently bind
 * campaign spec/phase/lease, recipient/chat locks, native intent and receipts.
 * `prepare` is an explicit operator/caller TX write; `resolve` only SELECTs.
 */
export function createLegacyCampaignRecipients(options:{enabled?:boolean;expectedBotId:typeof LEGACY_CAMPAIGN_BOT_ID;expectedControlEpoch:number;bindingKey:string|Uint8Array}){
 if(!options||options.expectedBotId!==LEGACY_CAMPAIGN_BOT_ID||!Number.isSafeInteger(options.expectedControlEpoch)||options.expectedControlEpoch<1||
  options.enabled!==undefined&&typeof options.enabled!=='boolean'||typeof options.bindingKey!=='string'&&!(options.bindingKey instanceof Uint8Array))return fail('INVALID_OPTIONS');
 const key=Buffer.from(options.bindingKey),enabled=options.enabled===true,expected=options.expectedControlEpoch;
 if(key.length<32||key.length>4096)return fail('INVALID_OPTIONS');
 const hmac=(value:unknown)=>createHmac('sha256',key).update(canonical(value)).digest('hex');
 const revision=(value:{recipientRef:string;chatId:string;subscriberDigest:string;createdAt:string})=>hmac({kind:'legacy-campaign-recipient/2',botId:LEGACY_CAMPAIGN_BOT_ID,controlEpoch:expected,...value});
 async function lock(client:LegacyProfileReadQuery,id:string):Promise<string|null>{
  // No authoritative control/subscriber/link/settings/registry read precedes
  // this existing identity lock. txid also detects accidental autocommit use.
  const rows=(await client.query('select pg_advisory_xact_lock(hashtextextended($1,0)),txid_current()::text as transaction_id',['lba:identity:telegram:'+id])).rows;
  return rows.length===1&&typeof rows[0].transaction_id==='string'&&/^[1-9]\d{0,19}$/.test(rows[0].transaction_id)?rows[0].transaction_id:null;
 }
 async function sameTransaction(client:LegacyProfileReadQuery,transactionId:string,signal:AbortSignal):Promise<boolean>{
  if(signal.aborted)return false;
  const rows=(await client.query('select txid_current()::text as transaction_id')).rows;
  return !signal.aborted&&rows.length===1&&rows[0].transaction_id===transactionId;
 }
 async function eligible(client:LegacyProfileReadQuery,id:string,signal:AbortSignal):Promise<string|null>{
  if(signal.aborted)return null;
  const control=(await client.query('select control_epoch,writer_mode from lba_production_control where id=true for share')).rows;
  if(control.length!==1||!epoch(control[0].control_epoch,expected)||control[0].writer_mode!=='canonical'||signal.aborted)return null;
  // PostgreSQL produces the whole-row JSONB TEXT. Never parse/re-serialize it:
  // JSONB numeric/BIGINT values beyond 2^53 must retain every original digit.
  // Critical eligibility fields are separately typed SQL projections from that
  // same locked row. Tracking-only changes still require reviewed refresh.
  const rows=(await client.query(`select s.chat_id as subscriber_chat_id,s.user_id as subscriber_owner_id,s.enabled as subscriber_enabled,
   to_jsonb(s)::text as subscriber_raw from telegram_subscribers s where chat_id=$1 for share`,[id])).rows;
  if(rows.length!==1||rows[0].subscriber_chat_id!==id||rows[0].subscriber_enabled!==true||rows[0].subscriber_owner_id!==null||
   typeof rows[0].subscriber_raw!=='string'||!rows[0].subscriber_raw.length||Buffer.byteLength(rows[0].subscriber_raw)>262144||signal.aborted)return null;
  const links=(await client.query("select 1 from linked_accounts where provider='telegram' and btrim(provider_id::text)=$1 limit 1 for share",[id])).rows;
  if(links.length||signal.aborted)return null;
  // ANY reference denies; it never becomes a claim about whose account it is.
  const settings=(await client.query('select 1 from user_settings where btrim(telegram_chat_id::text)=$1 limit 1 for share',[id])).rows;
  if(settings.length||signal.aborted)return null;
  return hmac({kind:'whole-current-telegram-subscriber/2',rawPostgresJSONB:rows[0].subscriber_raw});
 }
 function subject(row:unknown,id:string,subscriberDigest:string,now:string):LegacyCampaignRecipientSubject|null{
  if(!plain(row)||!ref(row.recipient_ref)||row.bot_id!==LEGACY_CAMPAIGN_BOT_ID||row.chat_id!==id||!epoch(row.control_epoch,expected)||row.revoked_at!==null||
   !sameHex(row.subscriber_digest,subscriberDigest))return null;
  const createdAt=instant(row.created_at);if(!createdAt||Date.parse(createdAt)>Date.parse(now))return null;
  const binding=revision({recipientRef:row.recipient_ref,chatId:id,subscriberDigest,createdAt});if(!sameHex(row.binding_revision,binding))return null;
  return Object.freeze({kind:'legacy_subscription',recipientRef:row.recipient_ref,botId:LEGACY_CAMPAIGN_BOT_ID,chatId:id,mappingRevision:'legacy-mapping:'+binding,expiresAt:new Date(Date.parse(now)+1000).toISOString()});
 }
 return Object.freeze({
  async prepare(client:LegacyProfileReadQuery,input:Request&{chatId:string}):Promise<LegacyCampaignRecipientSubject|null>{
   if(!enabled)return null;
   if(!client||typeof client.query!=='function'||!request(input,'chatId')||!chat(input.chatId)||input.signal.aborted)return null;
   try{
    const transactionId=await lock(client,input.chatId);if(!transactionId)return null;
    const subscriberDigest=await eligible(client,input.chatId,input.signal);if(!subscriberDigest)return null;
    const rows=(await client.query('select * from lba_legacy_campaign_recipient where bot_id=$1 and chat_id=$2 for update',[LEGACY_CAMPAIGN_BOT_ID,input.chatId])).rows;
    if(rows.length>1||!await sameTransaction(client,transactionId,input.signal))return null;
    if(rows.length)return subject(rows[0],input.chatId,subscriberDigest,input.now);
    const recipientRef='legacy:'+randomUUID(),createdAt=new Date(Date.parse(input.now)).toISOString();
    const binding=revision({recipientRef,chatId:input.chatId,subscriberDigest,createdAt});
    const inserted=(await client.query(`insert into lba_legacy_campaign_recipient(recipient_ref,bot_id,chat_id,control_epoch,subscriber_digest,binding_revision,created_at,revoked_at)
     values($1,$2,$3,$4,$5,$6,$7,null) on conflict(bot_id,chat_id) do nothing returning *`,[recipientRef,LEGACY_CAMPAIGN_BOT_ID,input.chatId,expected,subscriberDigest,binding,createdAt])).rows;
    if(!inserted.length)return null;
    // A failure after INSERT is unconfirmed, never a quiet null that a caller
    // could commit as if nothing happened. The caller must roll back its TX.
    if(inserted.length!==1||!await sameTransaction(client,transactionId,input.signal))return fail('PREPARE_UNCONFIRMED');
    return subject(inserted[0],input.chatId,subscriberDigest,input.now)??fail('PREPARE_UNCONFIRMED');
   }catch{return fail('PREPARE_UNCONFIRMED');}
  },
  async resolve(client:LegacyProfileReadQuery,input:Request&{recipientRef:string}):Promise<LegacyCampaignRecipientSubject|null>{
   if(!enabled)return null;
   if(!client||typeof client.query!=='function'||!request(input,'recipientRef')||!ref(input.recipientRef)||input.signal.aborted)return null;
   try{
    // The sole permitted pre-lock read is a non-authoritative private ref hint.
    const hint=(await client.query('select chat_id from lba_legacy_campaign_recipient where recipient_ref=$1 and bot_id=$2',[input.recipientRef,LEGACY_CAMPAIGN_BOT_ID])).rows;
    if(hint.length!==1||!chat(hint[0].chat_id)||input.signal.aborted)return null;
    const id=hint[0].chat_id,transactionId=await lock(client,id);if(!transactionId)return null;
    const subscriberDigest=await eligible(client,id,input.signal);if(!subscriberDigest)return null;
    const rows=(await client.query('select * from lba_legacy_campaign_recipient where recipient_ref=$1 and bot_id=$2 and chat_id=$3 for share',[input.recipientRef,LEGACY_CAMPAIGN_BOT_ID,id])).rows;
    if(rows.length!==1||!await sameTransaction(client,transactionId,input.signal))return null;
    return subject(rows[0],id,subscriberDigest,input.now);
   }catch{return null;}
  },
 });
}
