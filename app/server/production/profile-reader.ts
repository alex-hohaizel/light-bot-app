import {createHash} from 'node:crypto';
import {projectLegacyLiveProfile, type LegacyLiveProfileInput, type LegacyLocationDTO, type LegacyProfileProjection, type LegacySettingsDTO, type LegacySubscriberDTO} from './legacy-profile.ts';

export type VerifiedLegacyPrincipal = LegacyLiveProfileInput['identity'];
export interface VerifiedSubscriberMapping {
  kind: 'verified_telegram_owner_mapping';
  ownerId: string;
  chatId: string;
  /** Stable verified mapping revision, not a credential or per-request authentication nonce. */
  revisionId: string;
}
export interface LegacyProfileReadQuery {
  query(sql: string, values?: any[]): Promise<{rows: any[]; rowCount: number | null; command?: string}>;
}
export interface LegacyProfileReadClient extends LegacyProfileReadQuery {
  /** Forward pg's destroy flag when a transaction acknowledgement is unknown. */
  release(destroy?: Error | boolean): void;
}
export interface LegacyProfileReadPool {connect(): Promise<LegacyProfileReadClient>}
export interface LegacyProfileReadOptions {
  now?: () => string;
  verifiedSubscriberMappings?: readonly VerifiedSubscriberMapping[];
  rowLimit?: number;
}
export interface LegacyLiveProfileRead {
  version: 'lba-live-legacy-reader/1';
  status: 'ready' | 'blocked';
  projection: LegacyProfileProjection;
  /** Digest of selected original SQL DTOs and explicit mapping revisions; not authentication. */
  sourceDigest: string;
  projectionDigest: string;
  serverNow: string;
  counts: {settings: number; locations: number; directlyOwnedSubscribers: number; verifiedMappedNullSubscribers: number; selectedSubscribers: number;
    verifiedMappings: number; missingVerifiedMappings: number; unresolvedSettingsReferences: number};
  completeness: {ownerRows: 'reconciled'; selectedColumnsOnly: true; otherLegacyColumns: 'not_read_not_modified'; globalOrphans: 'not_scanned_outside_owner_scope'};
  blockers: Array<{code: string; sourceRefs: string[]}>;
}
export class LegacyProfileReadError extends Error {}
const fail = (code: string): never => {throw new LegacyProfileReadError(code);};
const plain = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v)));
function keys(v: Record<string,unknown>, allowed: readonly string[]) {if(Object.keys(v).some(k=>!allowed.includes(k))) fail('LEGACY_READER_UNEXPECTED_FIELD');}
const boundedText = (v:unknown,max:number,empty=false):v is string => typeof v==='string' && v.length<=max && (empty||Boolean(v.trim())) && !/[\u0000-\u001f\u007f]/.test(v);
const canonical = (v:unknown):string => v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const digest = (v:unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const SETTINGS_KEYS = ['userId','city','lookupMode','street','houseNumber','queueId','notificationsEnabled','notifyBeforeOff','notifyBeforeOn','telegramNotifications','telegramNotifyBeforeOff','telegramNotifyBeforeOn','quietHoursEnabled','quietHoursStart','quietHoursEnd','morningBriefingEnabled','morningBriefingHour','minOutageDuration','themeMode','hasSeenOnboarding','telegramChatId'] as const;
const LOCATION_KEYS = ['id','userId','name','city','lookupMode','street','houseNumber','queueId','isPrimary','orderIndex','notifyEnabled','telegramNotify','notifyBeforeOff','notifyBeforeOn'] as const;
const SUBSCRIBER_KEYS = ['chatId','userId','city','lookupMode','street','houseNumber','queueId','enabled','notifyBeforeOff','notifyBeforeOn','quietHoursEnabled','quietHoursStart','quietHoursEnd','morningBriefingEnabled','morningBriefingHour','minOutageDuration'] as const;
const EXACT_OWNER_COUNTS = `select
 (select count(*) from user_settings where user_id=$1)::text as "settings",
 (select count(*) from user_locations where user_id=$1)::text as "locations",
 (select count(*) from telegram_subscribers where user_id=$1)::text as "subscribers"`;
const SETTINGS_SQL = `select user_id as "userId",city,lookup_mode as "lookupMode",street,house_number as "houseNumber",queue_id as "queueId",
 notifications_enabled as "notificationsEnabled",notify_before_off as "notifyBeforeOff",notify_before_on as "notifyBeforeOn",
 telegram_notifications as "telegramNotifications",telegram_notify_before_off as "telegramNotifyBeforeOff",telegram_notify_before_on as "telegramNotifyBeforeOn",
 quiet_hours_enabled as "quietHoursEnabled",quiet_hours_start as "quietHoursStart",quiet_hours_end as "quietHoursEnd",
 morning_briefing_enabled as "morningBriefingEnabled",morning_briefing_hour as "morningBriefingHour",min_outage_duration as "minOutageDuration",
 theme_mode as "themeMode",has_seen_onboarding as "hasSeenOnboarding",telegram_chat_id as "telegramChatId"
 from user_settings where user_id=$1 limit 2`;
const LOCATIONS_SQL = `select id,user_id as "userId",name,city,lookup_mode as "lookupMode",street,house_number as "houseNumber",queue_id as "queueId",
 is_primary as "isPrimary",order_index as "orderIndex",notify_enabled as "notifyEnabled",telegram_notify as "telegramNotify",
 notify_before_off as "notifyBeforeOff",notify_before_on as "notifyBeforeOn"
 from user_locations where user_id=$1 order by order_index,id limit $2`;
const MAPPING_COUNTS_SQL = `select count(*)::text as "total",
 count(*) filter(where user_id is null)::text as "unowned",
 count(*) filter(where user_id=$1)::text as "owned",
 count(*) filter(where user_id is not null and user_id<>$1)::text as "foreign"
 from telegram_subscribers where chat_id=any($2::varchar[])`;
const SUBSCRIBERS_SQL = `select chat_id as "chatId",user_id as "userId",city,lookup_mode as "lookupMode",street,house_number as "houseNumber",queue_id as "queueId",
 enabled,notify_before_off as "notifyBeforeOff",notify_before_on as "notifyBeforeOn",quiet_hours_enabled as "quietHoursEnabled",
 quiet_hours_start as "quietHoursStart",quiet_hours_end as "quietHoursEnd",morning_briefing_enabled as "morningBriefingEnabled",
 morning_briefing_hour as "morningBriefingHour",min_outage_duration as "minOutageDuration"
 from telegram_subscribers where user_id=$1 or (user_id is null and chat_id=any($2::varchar[])) order by chat_id limit $3`;
function row(value: unknown, allowed: readonly string[]): Record<string,unknown> {
  if(!plain(value)) return fail('LEGACY_READER_INVALID_ROW');keys(value,allowed);
  if(allowed.some(k=>!Object.hasOwn(value,k))) return fail('LEGACY_READER_INCOMPLETE_ROW');return value;
}
function count(v:unknown):number {
  if(typeof v==='string'&&!/^\d{1,16}$/.test(v)) return fail('LEGACY_READER_INVALID_COUNT');
  if(typeof v!=='string'&&typeof v!=='number') return fail('LEGACY_READER_INVALID_COUNT');
  const n=Number(v);if(!Number.isSafeInteger(n)||n<0) return fail('LEGACY_READER_INVALID_COUNT');return n;
}
function principalAndOptions(identity: VerifiedLegacyPrincipal, options: LegacyProfileReadOptions) {
  if(!plain(identity)||Object.keys(identity).sort().join(',')!=='kind,ownerId,verified'||identity.kind!=='verified_server_principal'||identity.verified!==true||!boundedText(identity.ownerId,255)) return fail('LEGACY_READER_VERIFIED_PRINCIPAL_REQUIRED');
  if(!plain(options))return fail('LEGACY_READER_INVALID_OPTIONS');keys(options,['now','verifiedSubscriberMappings','rowLimit']);
  const limit=options.rowLimit??10000;if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>10000)return fail('LEGACY_READER_INVALID_LIMIT');
  if(options.now!==undefined&&typeof options.now!=='function')return fail('LEGACY_READER_INVALID_CLOCK');
  const mappings=options.verifiedSubscriberMappings??[];
  if(!Array.isArray(mappings)||mappings.length>100)return fail('LEGACY_READER_INVALID_MAPPING');
  const seen=new Set<string>();
  for(const m of mappings){
    if(!plain(m)||Object.keys(m).sort().join(',')!=='chatId,kind,ownerId,revisionId'||m.kind!=='verified_telegram_owner_mapping'||m.ownerId!==identity.ownerId||!boundedText(m.chatId,50)||!boundedText(m.revisionId,160)||seen.has(m.chatId))return fail('LEGACY_READER_INVALID_MAPPING');seen.add(m.chatId);
  }
  return {owner:identity.ownerId,limit,mappings:structuredClone([...mappings]).sort((a,b)=>a.chatId<b.chatId?-1:a.chatId>b.chatId?1:0)};
}
/** SELECT-only helper in a transaction owned by the caller. Does not BEGIN/COMMIT/ROLLBACK/release.
 * Caller must provide a consistent snapshot and any writer/owner fence needed for bootstrap.
 * Structural principal flags do not authenticate a caller.
 */
export async function selectLegacyLiveProfileInTransaction(client:LegacyProfileReadQuery, identity:VerifiedLegacyPrincipal, options:LegacyProfileReadOptions={}):Promise<LegacyLiveProfileRead>{
  const {owner,limit,mappings}=principalAndOptions(identity,options);
  identity={kind:'verified_server_principal',ownerId:owner,verified:true};
  if(!client||typeof client.query!=='function')return fail('LEGACY_READER_INVALID_CLIENT');
  const now=options.now??(()=>new Date().toISOString()), refs=mappings.map(m=>m.chatId);
  try{
    const counted=await client.query(EXACT_OWNER_COUNTS,[owner]);
    if(counted.rows.length!==1)return fail('LEGACY_READER_COUNT_MISMATCH');
    const countsRow=row(counted.rows[0],['settings','locations','subscribers']);
    const owned={settings:count(countsRow.settings),locations:count(countsRow.locations),subscribers:count(countsRow.subscribers)};
    if(owned.settings>1)return fail('LEGACY_READER_COUNT_MISMATCH');
    if(owned.locations>limit||owned.subscribers>limit)return fail('LEGACY_READER_ROW_LIMIT');
    const settingsResult=await client.query(SETTINGS_SQL,[owner]);
    const settingsRows=settingsResult.rows.map(v=>row(v,SETTINGS_KEYS));
    if(settingsRows.length!==owned.settings)return fail('LEGACY_READER_COUNT_MISMATCH');
    if(settingsRows.some(v=>v.userId!==owner))return fail('LEGACY_READER_FOREIGN_OWNER');
    const settingsRaw=settingsRows[0]??null;
    if(settingsRaw&&settingsRaw.telegramChatId!==null&&!boundedText(settingsRaw.telegramChatId,50,true))return fail('LEGACY_READER_INVALID_ROW');
    const locationResult=await client.query(LOCATIONS_SQL,[owner,limit+1]);
    const locations=locationResult.rows.map(v=>row(v,LOCATION_KEYS));
    if(locations.length!==owned.locations)return fail('LEGACY_READER_COUNT_MISMATCH');
    if(locations.some(v=>v.userId!==owner))return fail('LEGACY_READER_FOREIGN_OWNER');
    let mapped={total:0,unowned:0,owned:0,foreign:0};
    if(refs.length){
      const result=await client.query(MAPPING_COUNTS_SQL,[owner,refs]);
      if(result.rows.length!==1)return fail('LEGACY_READER_COUNT_MISMATCH');const v=row(result.rows[0],['total','unowned','owned','foreign']);
      mapped={total:count(v.total),unowned:count(v.unowned),owned:count(v.owned),foreign:count(v.foreign)};
      if(mapped.total!==mapped.unowned+mapped.owned+mapped.foreign||mapped.total>refs.length)return fail('LEGACY_READER_COUNT_MISMATCH');
      if(mapped.foreign)return fail('LEGACY_READER_MAPPING_OWNER_CONFLICT');
    }
    if(owned.subscribers+mapped.unowned>limit)return fail('LEGACY_READER_ROW_LIMIT');
    const subscriberResult=await client.query(SUBSCRIBERS_SQL,[owner,refs,limit+1]);
    const originalSubscribers=subscriberResult.rows.map(v=>row(v,SUBSCRIBER_KEYS));
    if(originalSubscribers.length!==owned.subscribers+mapped.unowned)return fail('LEGACY_READER_COUNT_MISMATCH');
    let direct=0,fromVerifiedMapping=0;
    const subscribers=originalSubscribers.map(v=>{
      if(!boundedText(v.chatId,50))return fail('LEGACY_READER_INVALID_ROW');
      if(v.userId===owner){direct++;return {...v};}
      if(v.userId===null&&refs.includes(v.chatId)){fromVerifiedMapping++;return {...v,userId:owner};}
      return fail('LEGACY_READER_FOREIGN_OWNER');
    });
    if(direct!==owned.subscribers||fromVerifiedMapping!==mapped.unowned||originalSubscribers.filter(v=>refs.includes(String(v.chatId))).length!==mapped.total||originalSubscribers.filter(v=>v.userId===owner&&refs.includes(String(v.chatId))).length!==mapped.owned)return fail('LEGACY_READER_COUNT_MISMATCH');
    const blockers:LegacyLiveProfileRead['blockers']=[];
    const missing=refs.length-mapped.total;if(missing)blockers.push({code:'LEGACY_READER_VERIFIED_MAPPING_NOT_FOUND',sourceRefs:['verified_subscriber_mapping']});
    const settingsRef=typeof settingsRaw?.telegramChatId==='string'?settingsRaw.telegramChatId:'';
    const unresolved=settingsRef.trim()&&!originalSubscribers.some(v=>v.chatId===settingsRef)?1:0;
    if(unresolved)blockers.push({code:'LEGACY_READER_SETTINGS_TELEGRAM_MAPPING_UNVERIFIED',sourceRefs:['user_settings.telegram_chat_id']});
    const settingsDTO=settingsRaw?Object.fromEntries(Object.entries(settingsRaw).filter(([key])=>key!=='telegramChatId')) as unknown as LegacySettingsDTO:null;
    const projection=projectLegacyLiveProfile({ownerId:owner,identity,settings:settingsDTO,locations:locations as unknown as LegacyLocationDTO[],subscribers:subscribers as unknown as LegacySubscriberDTO[]});
    const sourceDigest=digest({version:'lba-live-legacy-reader/1',owner,settings:settingsRaw,locations:[...locations].sort((a,b)=>Number(a.id)-Number(b.id)),
      subscribers:[...originalSubscribers].sort((a,b)=>String(a.chatId)<String(b.chatId)?-1:String(a.chatId)>String(b.chatId)?1:0),mappings,blockers});
    const serverNow=now();if(typeof serverNow!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(serverNow)||!Number.isFinite(Date.parse(serverNow)))return fail('LEGACY_READER_INVALID_CLOCK');
    return {version:'lba-live-legacy-reader/1',status:blockers.length?'blocked':'ready',projection,sourceDigest,projectionDigest:projection.sourceDigest,serverNow,
      counts:{settings:owned.settings,locations:owned.locations,directlyOwnedSubscribers:direct,verifiedMappedNullSubscribers:fromVerifiedMapping,selectedSubscribers:subscribers.length,
        verifiedMappings:refs.length,missingVerifiedMappings:missing,unresolvedSettingsReferences:unresolved},
      completeness:{ownerRows:'reconciled',selectedColumnsOnly:true,otherLegacyColumns:'not_read_not_modified',globalOrphans:'not_scanned_outside_owner_scope'},blockers};
  }catch(error){
    if(error instanceof LegacyProfileReadError)throw error;
    if(error instanceof Error&&/^LEGACY_PROFILE_[A-Z_]+$/.test(error.message))return fail(error.message);
    return fail('LEGACY_READER_READ_UNCONFIRMED');
  }
}
/** Read-only snapshot for a principal already authenticated by the server. Structural flags do not authenticate callers. */
export async function readLegacyLiveProfile(pool:LegacyProfileReadPool, identity:VerifiedLegacyPrincipal, options:LegacyProfileReadOptions={}):Promise<LegacyLiveProfileRead>{
  const checked=principalAndOptions(identity,options);
  const principal:VerifiedLegacyPrincipal={kind:'verified_server_principal',ownerId:checked.owner,verified:true};
  const selectedOptions={...options,verifiedSubscriberMappings:checked.mappings};
  if(!pool||typeof pool.connect!=='function')return fail('LEGACY_READER_INVALID_POOL');
  let client:LegacyProfileReadClient;try{client=await pool.connect();}catch{return fail('LEGACY_READER_READ_UNCONFIRMED');}
  let started=false;
  try{
    await client.query('begin isolation level repeatable read read only');started=true;
    const result=await selectLegacyLiveProfileInTransaction(client,principal,selectedOptions);
    await client.query('commit');started=false;return result;
  }catch(error){
    if(started)try{await client.query('rollback');}catch{/* never expose provider or private query details */}
    if(error instanceof LegacyProfileReadError)throw error;
    return fail('LEGACY_READER_READ_UNCONFIRMED');
  }finally{try{client.release();}catch{return fail('LEGACY_READER_RELEASE_UNCONFIRMED');}}
}
