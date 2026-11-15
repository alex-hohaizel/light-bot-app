import {createHash} from 'node:crypto';
import type {BotLocation, BotProfile} from '../../shared/bot/types.ts';
import {NOTIFICATION_POLICY_VERSION, parseLocationNotificationPolicy, parseNotificationPolicy} from '../../shared/notification-policy.ts';

/** DTOs contain persisted legacy columns, not login credentials or identity claims. */
export interface LegacyTimingDTO {
  quietHoursEnabled: boolean; quietHoursStart: number; quietHoursEnd: number;
  morningBriefingEnabled: boolean; morningBriefingHour: number; minOutageDuration: number;
}
export interface LegacyAddressDTO {
  city: string | null; lookupMode: string | null; street: string | null;
  houseNumber: string | null; queueId: string | null;
}
export interface LegacySettingsDTO extends LegacyTimingDTO, LegacyAddressDTO {
  userId: string;
  notificationsEnabled: boolean; notifyBeforeOff: number; notifyBeforeOn: number;
  telegramNotifications: boolean; telegramNotifyBeforeOff: number; telegramNotifyBeforeOn: number;
  themeMode?: string; hasSeenOnboarding?: boolean;
}
export interface LegacyLocationDTO extends LegacyAddressDTO {
  id: number; userId: string; name: string; isPrimary: boolean; orderIndex: number;
  notifyEnabled: boolean; telegramNotify: boolean; notifyBeforeOff: number; notifyBeforeOn: number;
}
export interface LegacySubscriberDTO extends LegacyTimingDTO, LegacyAddressDTO {
  chatId: string; userId: string | null; enabled: boolean; notifyBeforeOff: number; notifyBeforeOn: number;
}
export interface LegacyLiveProfileInput {
  ownerId: string;
  /** Supplied ONLY by the trusted server auth adapter, never copied from request JSON. */
  identity: {kind: 'verified_server_principal'; ownerId: string; verified: true};
  settings: LegacySettingsDTO | null;
  locations: readonly LegacyLocationDTO[];
  subscribers: readonly LegacySubscriberDTO[];
}
type Table = 'user_settings' | 'user_locations' | 'telegram_subscribers';
type Scalar = string | number | boolean | null;
export interface LegacyProfileProvenance {
  table: Table; pk: string | number; ownerId: string; digest: string;
  /** Minimal mapped columns only. No credentials, chat text, shared tokens or sessions. */
  raw: Record<string, Scalar>; addressId: string | null;
}
export interface LegacyProfileProjection {
  version: 'lba-live-legacy-profile/1'; profile: BotProfile; sourceDigest: string;
  addressCarrier: Table | null;
  provenance: LegacyProfileProvenance[];
  issues: {code: string; sourceRefs: string[]}[];
  /** Preserved consent never authorizes delivery before real binding/source admission. */
  deliveryEligible: false;
}
const fail = (code: string): never => {throw new Error(code);};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('LEGACY_PROFILE_INVALID_ROW');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => /secret|token|password|session|credential|authorization|cookie|initData/i.test(key)))
    return fail('LEGACY_PROFILE_CREDENTIAL_FIELD');
  return row;
}
function text(value: unknown, max: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (!allowEmpty && !value.trim()))
    return fail('LEGACY_PROFILE_INVALID_TEXT');
  return value;
}
function flag(value: unknown): boolean {if (typeof value !== 'boolean') return fail('LEGACY_PROFILE_INVALID_FLAG'); return value;}
function integer(value: unknown, max: number, min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) return fail('LEGACY_PROFILE_INVALID_INTEGER');
  return Number(value);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const hour = (value: number): string => String(value).padStart(2, '0') + ':00';
const addressFields = ['city', 'lookupMode', 'street', 'houseNumber', 'queueId'] as const;
const timingFields = ['quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd', 'morningBriefingEnabled', 'morningBriefingHour', 'minOutageDuration'] as const;
function address(row: Record<string, unknown>): Record<string, Scalar> {
  return Object.fromEntries(addressFields.map(key => [key, row[key] === null ? null : text(row[key], key === 'street' ? 255 : key === 'city' ? 100 : key === 'houseNumber' ? 50 : 10)]));
}
function timing(row: Record<string, unknown>): Record<string, Scalar> {
  return {quietHoursEnabled: flag(row.quietHoursEnabled), quietHoursStart: integer(row.quietHoursStart, 23), quietHoursEnd: integer(row.quietHoursEnd, 23),
    morningBriefingEnabled: flag(row.morningBriefingEnabled), morningBriefingHour: integer(row.morningBriefingHour, 23),
    minOutageDuration: integer(row.minOutageDuration, 1440)};
}
function knownPolicy(row: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(row).some(key => /^(?:notif|telegramNotif|quietHours|morningBriefing|minOutage|paused|blocked)/i.test(key) && !fields.includes(key)))
    fail('LEGACY_PROFILE_UNMAPPED_POLICY');
}
function hasAddress(row: Record<string, Scalar>): boolean {
  return ['street', 'houseNumber', 'queueId'].some(key => typeof row[key] === 'string' && (row[key] as string).trim().length > 0);
}
/** Stable across SQL row ordering, labels, policy edits and process restarts. */
export function legacyLiveAddressId(ownerId: string, table: Table, pk: string | number): string {
  text(ownerId, 255, false);
  if (!['user_settings','user_locations','telegram_subscribers'].includes(table)) return fail('LEGACY_PROFILE_INVALID_TABLE');
  if (table === 'user_locations') integer(pk, Number.MAX_SAFE_INTEGER, 1); else text(pk, 255, false);
  return 'legacy:' + digest([ownerId, table, pk]).slice(0, 32);
}

/** Pure initial projection of OWNED real-schema DTOs. Never imports the synthetic planner, SQL or auth graph.
 * Legacy SQL remains canonical. This is not a repeat-import writer or proof of identity/binding validity.
 */
export function projectLegacyLiveProfile(input: LegacyLiveProfileInput): LegacyProfileProjection {
  object(input);
  const owner = text(input.ownerId, 255, false), identity = object(input.identity);
  if (identity.kind !== 'verified_server_principal' || identity.verified !== true || identity.ownerId !== owner)
    return fail('LEGACY_PROFILE_VERIFIED_IDENTITY_REQUIRED');
  if (!Array.isArray(input.locations) || !Array.isArray(input.subscribers) || input.locations.length > 10000 || input.subscribers.length > 10000)
    return fail('LEGACY_PROFILE_ROW_LIMIT');
  const provenance: LegacyProfileProvenance[] = [], issues: LegacyProfileProjection['issues'] = [];
  const issue = (code: string, refs: string[]) => {issues.push({code, sourceRefs: refs.sort()});};
  const scoped = (row: Record<string, unknown>) => {if (row.userId !== owner) fail('LEGACY_PROFILE_FOREIGN_OWNER');};
  function add(table: Table, pk: string | number, raw: Record<string, Scalar>) {
    const entry: LegacyProfileProvenance = {table, pk, ownerId: owner, digest: digest(raw), raw, addressId: null};
    provenance.push(entry); return entry;
  }
  const settings = input.settings === null ? null : (() => {
    const row = object(input.settings); scoped(row);
    knownPolicy(row,[...timingFields,'notificationsEnabled','notifyBeforeOff','notifyBeforeOn','telegramNotifications','telegramNotifyBeforeOff','telegramNotifyBeforeOn']);
    const raw: Record<string, Scalar> = {userId: owner, ...address(row), ...timing(row),
      notificationsEnabled: flag(row.notificationsEnabled), notifyBeforeOff: integer(row.notifyBeforeOff,1440), notifyBeforeOn: integer(row.notifyBeforeOn,1440),
      telegramNotifications: flag(row.telegramNotifications), telegramNotifyBeforeOff: integer(row.telegramNotifyBeforeOff,1440), telegramNotifyBeforeOn: integer(row.telegramNotifyBeforeOn,1440)};
    if (row.themeMode !== undefined) raw.themeMode = text(row.themeMode,20);
    if (row.hasSeenOnboarding !== undefined) raw.hasSeenOnboarding = flag(row.hasSeenOnboarding);
    return add('user_settings',owner,raw);
  })();
  const ids = new Set<number>(), chats = new Set<string>();
  const locations = input.locations.map(value => {
    const row = object(value); scoped(row); const pk = integer(row.id,Number.MAX_SAFE_INTEGER,1);
    knownPolicy(row,['notifyEnabled','telegramNotify','notifyBeforeOff','notifyBeforeOn']);
    if (ids.has(pk)) fail('LEGACY_PROFILE_DUPLICATE_PK'); ids.add(pk);
    return add('user_locations',pk,{id:pk,userId:owner,...address(row),name:text(row.name,100),isPrimary:flag(row.isPrimary),
      orderIndex:integer(row.orderIndex,2147483647,-2147483648),notifyEnabled:flag(row.notifyEnabled),telegramNotify:flag(row.telegramNotify),
      notifyBeforeOff:integer(row.notifyBeforeOff,1440),notifyBeforeOn:integer(row.notifyBeforeOn,1440)});
  }).sort((a,b) => Number(a.raw.orderIndex)-Number(b.raw.orderIndex) || Number(a.pk)-Number(b.pk));
  if (locations.filter(row => row.raw.isPrimary).length > 1) fail('LEGACY_PROFILE_AMBIGUOUS_PRIMARY');
  const subscribers = input.subscribers.map(value => {
    const row = object(value); scoped(row); const pk = text(row.chatId,50,false);
    knownPolicy(row,[...timingFields,'notifyBeforeOff','notifyBeforeOn']);
    if (chats.has(pk)) fail('LEGACY_PROFILE_DUPLICATE_PK'); chats.add(pk);
    return add('telegram_subscribers',pk,{chatId:pk,userId:owner,...address(row),...timing(row),enabled:flag(row.enabled),
      notifyBeforeOff:integer(row.notifyBeforeOff,1440),notifyBeforeOn:integer(row.notifyBeforeOn,1440)});
  }).sort((a,b) => String(a.pk)<String(b.pk)?-1:String(a.pk)>String(b.pk)?1:0);
  // These are explicit column semantics, matching legacy-policy-adapter without a synthetic migration wrapper.
  const primary = settings ?? subscribers[0];
  const source = primary?.raw;
  const tgOff = Number(source?.[settings?'telegramNotifyBeforeOff':'notifyBeforeOff'] ?? 0);
  const tgOn = Number(source?.[settings?'telegramNotifyBeforeOn':'notifyBeforeOn'] ?? 0);
  const pushOff = Number(settings?.raw.notifyBeforeOff ?? 0), pushOn = Number(settings?.raw.notifyBeforeOn ?? 0);
  const consent = [...(settings?[Boolean(settings.raw.telegramNotifications)]:[]),...subscribers.map(row=>Boolean(row.raw.enabled))];
  let tgEnabled = consent.length > 0 && consent.every(Boolean);
  if (new Set(consent).size>1) issue('legacy_consent_disagrees',['user_settings.telegramNotifications','telegram_subscribers.enabled']);
  if (subscribers.some(row=>row.raw.notifyBeforeOff!==tgOff || row.raw.notifyBeforeOn!==tgOn)) {
    tgEnabled=false; issue('legacy_endpoint_thresholds_disagree',['telegram_subscribers.notifyBeforeOff','telegram_subscribers.notifyBeforeOn']);
  }
  if (source && subscribers.some(row=>timingFields.some(field=>row.raw[field]!==source[field]))) {
    tgEnabled=false; issue('legacy_global_rules_disagree',timingFields.map(field=>'telegram_subscribers.'+field));
  }
  const carriers = locations.length ? locations : settings && hasAddress(settings.raw) ? [settings] : subscribers.filter(row=>hasAddress(row.raw));
  const carrier = carriers[0]?.table ?? null;
  const addressKey=(row:LegacyProfileProvenance) => digest(['city','street','houseNumber','queueId'].map(field=>row.raw[field]??''));
  const carrierRows=new Set(carriers), carrierKeys=new Set(carriers.map(addressKey));
  const otherAddresses=provenance.filter(row=>!carrierRows.has(row)&&hasAddress(row.raw)&&!carrierKeys.has(addressKey(row)));
  if (otherAddresses.length) issue('legacy_address_carriers_differ',otherAddresses.map(row=>row.table+':'+row.pk));
  const resultLocations: BotLocation[] = carriers.map(row=>{
    const id=legacyLiveAddressId(owner,row.table,row.pk); row.addressId=id;
    const raw=row.raw, localTelegram=Boolean(raw[row.table==='user_locations'?'telegramNotify':row.table==='user_settings'?'telegramNotifications':'enabled']);
    const localPush=row.table==='user_locations'?Boolean(raw.notifyEnabled):row.table==='user_settings'?Boolean(raw.notificationsEnabled):false;
    const city=String(raw.city??''), house=String(raw.houseNumber??''), queue=String(raw.queueId??'');
    const operatorId='legacy-operator-unresolved', namespace='legacy:'+city, targetId=queue||'legacy-unresolved:'+id;
    // A label, ordering or consent edit is a profile revision, never a rebind.
    // Keep raw address/group fields and source identity separate from row/CAS provenance.
    const bindingRevision=digest({ownerId:owner,table:row.table,pk:row.pk,
      ...Object.fromEntries(addressFields.map(field=>[field,raw[field]])),operatorId,namespace,targetId});
    return {address:{id,label:row.table==='user_locations'?String(raw.name):'Дім',territoryId:'legacy-unresolved:'+digest(city).slice(0,16),locality:city,
      street:String(raw.street??''),house:{number:house,literal:house},aliases:[]},
      binding:{addressId:id,operatorId,namespace,targetId,
        kind:'user_selected_group',revisionId:'legacy:'+bindingRevision,status:'needs_confirmation',verifiedAt:null,effectiveFrom:null,effectiveUntil:null},
      notifications:localTelegram,paused:false,notificationPolicy:parseLocationNotificationPolicy({version:NOTIFICATION_POLICY_VERSION,channels:{
        telegram:{enabled:localTelegram,beforeOffMinutes:Number(raw[row.table==='user_settings'?'telegramNotifyBeforeOff':'notifyBeforeOff']),beforeOnMinutes:Number(raw[row.table==='user_settings'?'telegramNotifyBeforeOn':'notifyBeforeOn'])},
        push:{enabled:localPush,beforeOffMinutes:row.table==='telegram_subscribers'?0:Number(raw.notifyBeforeOff),beforeOnMinutes:row.table==='telegram_subscribers'?0:Number(raw.notifyBeforeOn)},
      }})};
  });
  const quietStart=Number(source?.quietHoursStart??23), quietEnd=Number(source?.quietHoursEnd??7);
  const policy=parseNotificationPolicy({version:NOTIFICATION_POLICY_VERSION,channels:{
    telegram:{enabled:tgEnabled,remindersEnabled:tgOff>0||tgOn>0||resultLocations.some(row=>(row.notificationPolicy!.channels.telegram.beforeOffMinutes??0)>0||(row.notificationPolicy!.channels.telegram.beforeOnMinutes??0)>0),beforeOffMinutes:tgOff,beforeOnMinutes:tgOn},
    push:{enabled:settings?.raw.notificationsEnabled===true,remindersEnabled:pushOff>0||pushOn>0||resultLocations.some(row=>(row.notificationPolicy!.channels.push.beforeOffMinutes??0)>0||(row.notificationPolicy!.channels.push.beforeOnMinutes??0)>0),beforeOffMinutes:pushOff,beforeOnMinutes:pushOn},
  }});
  if (source?.quietHoursEnabled && quietStart===quietEnd) issue('legacy_equal_quiet_bounds_preserved',['quietHoursStart','quietHoursEnd']);
  const primaryAddressId=locations.length ? locations.find(row=>row.raw.isPrimary)?.addressId??null : resultLocations.length===1?resultLocations[0].address.id:null;
  const sourceDigest=digest(provenance.map(row=>({table:row.table,pk:row.pk,digest:row.digest})).sort((a,b)=>canonical(a)<canonical(b)?-1:canonical(a)>canonical(b)?1:0));
  const profile: BotProfile={id:owner,locations:resultLocations,primaryAddressId,legacyNotificationPolicySourceHash:sourceDigest,preferences:{
    optedIn:tgEnabled,paused:false,reminders:policy.channels.telegram.remindersEnabled,remindBeforeMinutes:tgOff,notificationPolicy:policy,
    quietHours:{enabled:source?.quietHoursEnabled===true&&quietStart!==quietEnd,start:hour(quietStart),end:hour(quietEnd),timezone:'Europe/Kyiv'},
    morningBriefing:{enabled:source?.morningBriefingEnabled===true,time:hour(Number(source?.morningBriefingHour??7))},minimumOutageMinutes:Number(source?.minOutageDuration??0)*60,
  }};
  provenance.sort((a,b)=>a.table<b.table?-1:a.table>b.table?1:String(a.pk)<String(b.pk)?-1:String(a.pk)>String(b.pk)?1:0);
  return {version:'lba-live-legacy-profile/1',profile,sourceDigest,addressCarrier:carrier,provenance,issues,deliveryEligible:false};
}
