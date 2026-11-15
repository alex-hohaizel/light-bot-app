import {createHash} from 'node:crypto';
import {selectLegacyLiveProfileInTransaction,type LegacyLiveProfileRead,type LegacyProfileReadClient,type LegacyProfileReadPool,type LegacyProfileReadQuery,type VerifiedLegacyPrincipal,type VerifiedSubscriberMapping} from './profile-reader.ts';

/** Only existing registry/link/subscriber ownership identifiers are read. No identity
 * inference, account/link creation, subscriber reassignment, policy read or delivery.
 */
export class LegacyIdentityLinkError extends Error {}
const fail=(code:string):never=>{throw new LegacyIdentityLinkError(code);};
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=255):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function principal(value:VerifiedLegacyPrincipal):VerifiedLegacyPrincipal{
  if(!plain(value)||Object.keys(value).sort().join(',')!=='kind,ownerId,verified'||value.kind!=='verified_server_principal'||value.verified!==true||!text(value.ownerId))return fail('LEGACY_IDENTITY_VERIFIED_PRINCIPAL_REQUIRED');
  return {kind:'verified_server_principal',ownerId:value.ownerId,verified:true};
}
function row(v:unknown,fields:readonly string[]):Record<string,unknown>{
  if(!plain(v)||Object.keys(v).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(v,k)))return fail('LEGACY_IDENTITY_INVALID_ROW');return v;
}
function count(v:unknown):number{
  if(typeof v!=='string'||!/^\d{1,6}$/.test(v))return fail('LEGACY_IDENTITY_INVALID_COUNT');const n=Number(v);if(!Number.isSafeInteger(n))return fail('LEGACY_IDENTITY_INVALID_COUNT');return n;
}
const OWN_LINKS=`select id,user_id as "ownerId",provider_id as "chatId" from linked_accounts where user_id=$1 and provider='telegram' order by id limit 101`;
const OWN_SUBSCRIBERS=`select chat_id as "chatId",user_id as "ownerId" from telegram_subscribers where user_id=$1 order by chat_id limit 10001`;
const GLOBAL_LINK_COUNTS=`select a.provider_id as "chatId",count(*)::text as "total",
 count(*) filter(where a.user_id=$1)::text as "owned",
 count(*) filter(where a.user_id is null or a.user_id<>$1)::text as "foreign",
 count(*) filter(where u.id is null)::text as "dangling"
 from linked_accounts a left join users u on u.id=a.user_id
 where a.provider='telegram' and a.provider_id=any($2::varchar[]) group by a.provider_id order by a.provider_id`;
const LINKED_SUBSCRIBERS=`select chat_id as "chatId",user_id as "ownerId" from telegram_subscribers where chat_id=any($1::varchar[]) order by chat_id`;

/** Caller owns a consistent transaction (RR for profile bootstrap/read). Every returned
 * mapping comes from an explicit globally unique linked_accounts telegram row and an
 * existing subscriber. NULL ownership is projected only, never changed in legacy SQL.
 * Same-owner non-NULL rows retain the explicit link proof without changing ownership.
 */
export async function selectVerifiedLegacySubscriberMappings(client:LegacyProfileReadQuery,identity:VerifiedLegacyPrincipal):Promise<VerifiedSubscriberMapping[]>{
  const p=principal(identity);if(!client||typeof client.query!=='function')return fail('LEGACY_IDENTITY_INVALID_CLIENT');
  try{
    const user=await client.query('select id from users where id=$1 limit 2',[p.ownerId]);
    if(user.rows.length!==1||row(user.rows[0],['id']).id!==p.ownerId)return fail('LEGACY_IDENTITY_OWNER_NOT_FOUND');
    const links=await client.query(OWN_LINKS,[p.ownerId]);if(links.rows.length>100)return fail('LEGACY_IDENTITY_ROW_LIMIT');
    const byChat=new Map<string,{id:string;ownerId:string;chatId:string}>(),ids=new Set<string>();
    for(const value of links.rows){
      const v=row(value,['id','ownerId','chatId']);
      if(!text(v.id)||v.ownerId!==p.ownerId||!text(v.chatId,50)||!/^[1-9]\d{0,15}$/.test(v.chatId))return fail('LEGACY_IDENTITY_INVALID_LINK');
      if(ids.has(v.id)||byChat.has(v.chatId))return fail('LEGACY_IDENTITY_LINK_CONFLICT');ids.add(v.id);byChat.set(v.chatId,{id:v.id,ownerId:p.ownerId,chatId:v.chatId});
    }
    const direct=await client.query(OWN_SUBSCRIBERS,[p.ownerId]);if(direct.rows.length>10000)return fail('LEGACY_IDENTITY_ROW_LIMIT');
    const directChats=new Set<string>();
    for(const value of direct.rows){const v=row(value,['chatId','ownerId']);if(!text(v.chatId,50)||v.ownerId!==p.ownerId||directChats.has(v.chatId))return fail('LEGACY_IDENTITY_SUBSCRIBER_CONFLICT');directChats.add(v.chatId);}
    const refs=[...new Set([...byChat.keys(),...directChats])].sort(),global=new Map<string,{chatId:string;total:number;owned:number;foreign:number;dangling:number}>();
    if(refs.length){
      const selected=await client.query(GLOBAL_LINK_COUNTS,[p.ownerId,refs]);
      for(const value of selected.rows){
        const v=row(value,['chatId','total','owned','foreign','dangling']);if(!text(v.chatId,50)||!refs.includes(v.chatId)||global.has(v.chatId))return fail('LEGACY_IDENTITY_INVALID_ROW');
        const item={chatId:v.chatId,total:count(v.total),owned:count(v.owned),foreign:count(v.foreign),dangling:count(v.dangling)};
        if(item.total!==1||item.owned!==1||item.foreign!==0||item.dangling!==0)return fail('LEGACY_IDENTITY_LINK_CONFLICT');global.set(v.chatId,item);
      }
    }
    for(const chat of byChat.keys())if(!global.has(chat))return fail('LEGACY_IDENTITY_LINK_CONFLICT');
    if(!byChat.size)return [];
    const candidates=await client.query(LINKED_SUBSCRIBERS,[[...byChat.keys()].sort()]);
    if(candidates.rows.length>byChat.size)return fail('LEGACY_IDENTITY_SUBSCRIBER_CONFLICT');
    const seen=new Set<string>(),mappings:VerifiedSubscriberMapping[]=[];
    for(const value of candidates.rows){
      const v=row(value,['chatId','ownerId']);if(!text(v.chatId,50)||!byChat.has(v.chatId)||seen.has(v.chatId))return fail('LEGACY_IDENTITY_SUBSCRIBER_CONFLICT');seen.add(v.chatId);
      if(v.ownerId!==null&&v.ownerId!==p.ownerId)return fail('LEGACY_IDENTITY_SUBSCRIBER_CONFLICT');
      if(v.ownerId===p.ownerId&&!directChats.has(v.chatId)||v.ownerId===null&&directChats.has(v.chatId))return fail('LEGACY_IDENTITY_SUBSCRIBER_CONFLICT');
      mappings.push({kind:'verified_telegram_owner_mapping',ownerId:p.ownerId,chatId:v.chatId,revisionId:'linked:'+digest({version:'lba-legacy-identity-links/1',owner:p.ownerId,link:byChat.get(v.chatId),global:global.get(v.chatId),subscriberOwner:v.ownerId})});
    }
    return mappings.sort((a,b)=>a.chatId<b.chatId?-1:a.chatId>b.chatId?1:0);
  }catch(error){if(error instanceof LegacyIdentityLinkError)throw error;return fail('LEGACY_IDENTITY_READ_UNCONFIRMED');}
}

export interface OwnedLegacyProfileReadOptions{now?:()=>string;rowLimit?:number}
/** Read-only public service boundary: identity mapping and policy projection use the
 * SAME RR snapshot/client. The unchanged default reader never gains inferred mappings.
 */
export async function readOwnedLegacyProfile(pool:LegacyProfileReadPool,identity:VerifiedLegacyPrincipal,options:OwnedLegacyProfileReadOptions={}):Promise<LegacyLiveProfileRead>{
  const p=principal(identity);
  if(!plain(options)||Object.keys(options).some(k=>!['now','rowLimit'].includes(k))||options.now!==undefined&&typeof options.now!=='function'||options.rowLimit!==undefined&&(typeof options.rowLimit!=='number'||!Number.isSafeInteger(options.rowLimit)||options.rowLimit<1||options.rowLimit>10000))return fail('LEGACY_IDENTITY_INVALID_OPTIONS');
  if(!pool||typeof pool.connect!=='function')return fail('LEGACY_IDENTITY_INVALID_POOL');
  const selectedOptions={...options};let client:LegacyProfileReadClient;try{client=await pool.connect();}catch{return fail('LEGACY_IDENTITY_READ_UNCONFIRMED');}
  let started=false;
  try{
    await client.query('begin isolation level repeatable read read only');started=true;
    const mappings=await selectVerifiedLegacySubscriberMappings(client,p);
    const value=await selectLegacyLiveProfileInTransaction(client,p,{...selectedOptions,verifiedSubscriberMappings:mappings});
    await client.query('commit');started=false;return value;
  }catch(error){
    if(started)try{await client.query('rollback');}catch{/* no private driver error text */}
    if(error instanceof LegacyIdentityLinkError)throw error;
    if(error instanceof Error&&/^LEGACY_(?:READER|PROFILE)_[A-Z_]+$/.test(error.message))return fail(error.message);
    return fail('LEGACY_IDENTITY_READ_UNCONFIRMED');
  }finally{try{client.release();}catch{return fail('LEGACY_IDENTITY_RELEASE_UNCONFIRMED');}}
}
