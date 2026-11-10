import {formatOperatorHouseNotice,currentOperatorHouseNotice,operatorHouseScope} from '../operator-house-notice.ts';
import type { AddressRecord, ScheduleEvent, ScheduleView } from '../product-contract.ts';
import { canDeliver, validInstant,localParts,dayBounds } from '../schedule-core.ts';
import { normalizeHouse,normalizeAddressText,parseStreetName,streetMatchesQuery,localityMatchesQuery,houseMatchesQuery,houseLookalikeSuggestion,placeNameMatchesQuery } from '../address-index.ts';
import { addressLocalityKey,addressStreetKey,addressOptionFingerprint,confirmedAddressBinding } from '../address-selection.ts';
import { MAX_PROFILE_ADDRESSES, ADDRESS_PAGE_SIZE } from '../profile-constraints.ts';
import {formatMinutesDuration} from '../time-label.ts';
import { BOT_COPY, COPY, NOTIFICATION_COPY, formatNotification, formatNotificationSettings, formatScheduleText } from './copy.ts';
import { defaultNotificationPolicy, parseNotificationPolicy, parseLocationNotificationPolicy, resolveNotificationPolicy,
  reminderLeadMinutes, reminderDurationEligible, syncLegacyPolicyChanges, type NotificationChannel, type ReminderEdge } from '../notification-policy.ts';
import type { AddressDraft, AddressOption, BotAction, BotContext, BotInput, BotLocation,
  BotMessage, BotProfile, BotStage, BotState, BotTurn, CallbackAction,BotProviderDraftV2,BotProviderSnapshotV2 } from './types.ts';
export type * from './types.ts';
export { COPY, formatNotification, formatScheduleText } from './copy.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const textKey = (value: string) => value.trim().toLocaleLowerCase('uk-UA').replace(/[’`]/g, "'").replace(/\s+/g, ' ');
const streetKey = (value: string) => parseStreetName(value).key;
export { normalizeHouse } from '../address-index.ts';
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const localityKey = (option: AddressOption) => addressLocalityKey(option.address);

export function createBotState(options: { ownerId?: string; sessionId?: string; profile?: BotProfile } = {}): BotState {
  const ownerId = options.ownerId || 'lba-review-user';
  if (options.profile && options.profile.id !== ownerId) throw new Error('BOT_PROFILE_OWNER_MISMATCH');
  const profile: BotProfile = options.profile ? clone(options.profile) : {
    id: ownerId, locations: [], primaryAddressId: null,
    preferences: { optedIn: false, paused: false, reminders: false, remindBeforeMinutes: 30,
      quietHours: { enabled: false, start: '22:00', end: '08:00', timezone: 'Europe/Kyiv' },
      morningBriefing: { enabled: false, time: '07:30' }, minimumOutageMinutes: 0 },
  };
  return { schemaVersion: 'lba-bot/1', ownerId, sessionId: options.sessionId || 'local-review', revision: 0,
    callbackSequence: 0, profile, stage: 'home', currentAddressId: profile.primaryAddressId, draft: null,
    callbacks: {}, processedInputIds: [], processedEventIds: [] };
}

export function restoreBotState(value: unknown, ownerId: string): BotState {
  const state = value as BotState;
  if (!state || state.schemaVersion !== 'lba-bot/1' || state.ownerId !== ownerId || state.profile?.id !== ownerId ||
      !Array.isArray(state.profile.locations) || !Array.isArray(state.processedInputIds) ||
      !Array.isArray(state.processedEventIds) || !state.callbacks || !Number.isInteger(state.revision) ||
      !state.profile.preferences || typeof state.sessionId !== 'string') throw new Error('BOT_STATE_INVALID');
  return clone(state);
}

function rejected(state: BotState, inputId: string, reason: NonNullable<BotTurn['rejected']>, text: string): BotTurn {
  return { state, messages: [{ id: `${inputId}:rejected`, kind: 'error', text, buttons: [], commitBarrier: 'none' }],
    actions: [], requiresCommit: false, rejected: reason };
}

const v2Uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const v2Canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(v2Canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+v2Canonical((v as Record<string,unknown>)[k])).join(',')+'}';
function v2Text(v:unknown,max=300):v is string {
 if(typeof v!=='string'||!v.trim()||v.length>max||/[\p{Cc}\p{Cf}]/u.test(v))return false;
 for(let i=0;i<v.length;i++){const c=v.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=v.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;
}
/** Persisted drafts are checked before use; old numeric v1 fields are separate. */
export function readProviderV2Draft(value:unknown):BotProviderDraftV2|null {
 try{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
  const fields=Object.getOwnPropertyDescriptors(value),allowed=['directoryId','localityQuery','catalogSnapshotId','cityKey','streetQuery','streetKey','houseQuery','houseSnapshotId','houseKey'];
  if(Reflect.ownKeys(value).some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(fields[k],'value'))||fields.directoryId?.value!=='dtek:oem')return null;
  const draft=Object.fromEntries(Object.entries(fields).map(([k,d])=>[k,d.value])) as unknown as BotProviderDraftV2;
  for(const name of allowed.slice(1)){if(!Object.hasOwn(draft,name))continue;const v=(draft as any)[name];if(name.endsWith('SnapshotId')?!v2Uuid(v):!v2Text(v,name.endsWith('Query')||name==='houseKey'?100:300))return null;}
  if(Boolean(draft.catalogSnapshotId)!==Boolean(draft.cityKey)||draft.streetKey&&!draft.cityKey||draft.streetQuery&&!draft.cityKey||draft.houseQuery&&!draft.streetKey||
   Boolean(draft.houseSnapshotId)!==Boolean(draft.houseKey)||draft.houseKey&&!draft.streetKey)return null;
  return draft;
 }catch{return null;}
}
type V2Tuple=[string,string]|[string,string,string]|[string,string,string,string,string]|[string,string,string,string,string,string,string]|[string,string|null,string|null,string|null,string]|
 ['localities'|'streets'|'houses',string,string,string|null,string|null,string,number,number];
export function readProviderV2Tuple(kind:string,value:unknown):V2Tuple|null {
 try{
  if(typeof value!=='string'||value.length>35000)return null;const t:unknown=JSON.parse(value);if(!Array.isArray(t))return null;
  if(kind==='provider_v2_city')return t.length===2&&v2Uuid(t[0])&&v2Text(t[1])?t as [string,string]:null;
  if(kind==='provider_v2_street')return t.length===3&&v2Uuid(t[0])&&v2Text(t[1])&&v2Text(t[2])?t as [string,string,string]:null;
  if(kind==='provider_v2_retry')return t.length===5&&['localities','streets','houses'].includes(t[0])&&v2Text(t[4],100)&&
   (t[0]==='localities'?t[1]===null&&t[2]===null&&t[3]===null:v2Uuid(t[1])&&v2Text(t[2])&&(t[0]==='streets'?t[3]===null:v2Text(t[3])))?t as V2Tuple:null;
  if(['provider_v2_house','provider_v2_unknown_group','provider_v2_group'].includes(kind)){
   const length=kind==='provider_v2_group'?7:5;
   return t.length===length&&v2Uuid(t[0])&&v2Uuid(t[1])&&v2Text(t[2])&&v2Text(t[3])&&v2Text(t[4],100)&&
    (length===5||v2Text(t[5],512)&&v2Text(t[6],32768))?t as V2Tuple:null;
  }
  if(!['provider_v2_page','provider_v2_batch'].includes(kind)||t.length!==8||!['localities','streets','houses'].includes(t[0])||!v2Uuid(t[1])||!v2Uuid(t[2])||!v2Text(t[5],100)||
   !Number.isSafeInteger(t[6])||t[6]<0||t[6]>20000||!Number.isSafeInteger(t[7])||t[7]<0||t[7]>(kind==='provider_v2_page'?9:20000))return null;
  if(t[0]==='localities'?(t[1]!==t[2]||t[3]!==null||t[4]!==null):!v2Text(t[3])||t[0]==='streets'&&t[4]!==null||t[0]==='houses'&&!v2Text(t[4]))return null;
  if(kind==='provider_v2_batch'&&Math.abs(t[7]-t[6])!==30)return null;return t as V2Tuple;
 }catch{return null;}
}
/** Same current-page/lineage gate for engine callbacks and server preflight. */
export function providerV2SnapshotForState(state:BotState,context:Pick<BotContext,'now'|'providerDirectoriesV2'|'providerLookupV2'>,level:BotProviderSnapshotV2['level']):BotProviderSnapshotV2|null {
 try{
  const d=readProviderV2Draft(state.draft?.providerV2),p=context.providerLookupV2;
  if(!d||p?.directoryId!=='dtek:oem'||!validInstant(context.now)||!Array.isArray(context.providerDirectoriesV2)||context.providerDirectoriesV2.filter(v=>v?.id==='dtek:oem').length!==1||context.providerDirectoriesV2.filter(v=>v?.id==='dtek:oem'&&v.namespace==='dtek:oem'&&v.operatorId==='dtek-oem'&&v.territoryId==='source:dtek:oem'&&v.localitySelection==='required').length!==1)return null;
  const stage=p[level],s=stage?.snapshot,query=level==='localities'?d.localityQuery:level==='streets'?d.streetQuery:d.houseQuery;
  if(!stage||stage.state!=='available'||!v2Text(query,100)||stage.query!==query||normalizeAddressText(query).length<(level==='houses'?1:2)||
   !s||s.kind!=='lba-provider-address-snapshot/2'||s.namespace!=='dtek:oem'||s.level!==level||!v2Uuid(s.id)||!v2Uuid(s.catalogSnapshotId)||!v2Text(s.revisionId,255)||
   !validInstant(s.observedAt)||!validInstant(s.expiresAt)||Date.parse(s.observedAt)>Date.parse(context.now)||Date.parse(s.expiresAt)<=Date.parse(context.now)||Date.parse(s.expiresAt)<=Date.parse(s.observedAt)||Date.parse(s.expiresAt)>Date.parse(s.observedAt)+600000||Date.parse(s.expiresAt)>dayBounds(localParts(Date.parse(s.observedAt)).date).end||
   localParts(Date.parse(s.observedAt)).date!==localParts(Date.parse(context.now)).date||!Array.isArray(s.items)||s.items.length>30||
   s.items.some(v=>!v||!v2Text(v.key,level==='houses'?100:300)||!v2Text(v.value,level==='houses'?100:300))||new Set(s.items.map(v=>v.key)).size!==s.items.length||
   !Number.isSafeInteger(s.offset)||s.offset<0||s.offset>20000||typeof s.hasMore!=='boolean'||s.hasMore&&s.items.length!==30||s.catalogCompleteness!=='unknown')return null;
  if(level==='localities')return s.id===s.catalogSnapshotId&&s.cityKey===undefined&&s.streetKey===undefined?s:null;
  const cities=providerV2SnapshotForState(state,context,'localities');
  if(!cities||cities.id!==d.catalogSnapshotId||s.catalogSnapshotId!==d.catalogSnapshotId||s.cityKey!==d.cityKey||!cities.items.some(v=>v.key===d.cityKey)||Date.parse(s.expiresAt)>Date.parse(cities.expiresAt))return null;
  if(level==='streets')return s.id===d.catalogSnapshotId&&s.streetKey===undefined?s:null;
  const streets=providerV2SnapshotForState(state,context,'streets');
  return streets&&s.streetKey===d.streetKey&&streets.items.some(v=>v.key===d.streetKey)&&Date.parse(s.expiresAt)<=Date.parse(streets.expiresAt)?s:null;
 }catch{return null;}
}
export function providerV2PageItems<T>(state:BotState,items:readonly T[]):T[] {
 const page=state.catalogPage??0;
 return Number.isSafeInteger(page)&&page>=0&&page<Math.max(1,Math.ceil(items.length/ADDRESS_PAGE_SIZE))?items.slice(page*ADDRESS_PAGE_SIZE,(page+1)*ADDRESS_PAGE_SIZE):[];
}
export function providerV2BatchAllowed(state:BotState,s:BotProviderSnapshotV2,target:number):boolean {
 const stage=s.level==='localities'?'provider_locality':s.level==='streets'?'street_choice':'house',page=state.catalogPage??0;
 return state.stage===stage&&Number.isSafeInteger(page)&&page>=0&&page<=Math.max(0,Math.ceil(s.items.length/ADDRESS_PAGE_SIZE)-1)&&Number.isSafeInteger(target)&&target>=0&&target<=20000&&
  (target===s.offset-30&&page===0||target===s.offset+30&&s.hasMore&&page===Math.max(0,Math.ceil(s.items.length/ADDRESS_PAGE_SIZE)-1));
}

export function handleBotInput(previous: BotState, input: BotInput, context: BotContext): BotTurn {
  if (!previous || previous.schemaVersion !== 'lba-bot/1' || previous.profile?.id !== previous.ownerId) {
    return rejected(previous, input.id, 'invalid_state', BOT_COPY.engineText001);
  }
  if (context.actorId !== previous.ownerId) return rejected(previous, input.id, 'foreign_actor', COPY.foreignButton);
  if (!validInstant(context.now)) return rejected(previous, input.id, 'invalid_clock', COPY.unavailableAction);
  if (!input.id || input.id.length > 128) return rejected(previous, input.id || 'invalid', 'invalid_state', COPY.unavailableAction);
  if (!['command', 'text', 'callback'].includes(input.kind) ||
      (input.kind === 'callback' ? typeof input.callbackId !== 'string' : typeof input.text !== 'string')) {
    return rejected(previous, input.id, 'invalid_state', COPY.unavailableAction);
  }
  if(input.kind!=='callback'&&input.text.length>4096)return rejected(previous,input.id,'invalid_state','Повідомлення завелике. Введіть коротку назву, номер або скористайтеся кнопками. Чернетку збережено.');
  if (previous.processedInputIds.includes(input.id)) return { state: previous, messages: [], actions: [], requiresCommit: false, duplicate: true };
  if(previous.draft&&Object.hasOwn(previous.draft,'providerV2')&&!readProviderV2Draft(previous.draft.providerV2))return rejected(previous,input.id,'invalid_state','Чернетка пошуку пошкоджена. Відкрийте застосунок або зверніться до підтримки; збережені адреси не змінено.');

  let callback: CallbackAction | null = null;
  let callbackFailure: BotTurn['rejected'];
  let callbackFailureText = '';
  const invalidCallback = (reason: BotTurn['rejected'], text: string) => { callbackFailure = reason; callbackFailureText = text; };
  if (input.kind === 'callback') {
    const record = previous.callbacks[input.callbackId];
    if (!record) invalidCallback('unknown_callback', COPY.unknownButton);
    else if (record.ownerId !== context.actorId) return rejected(previous, input.id, 'foreign_actor', COPY.foreignButton);
    else if (record.consumed || record.stateRevision !== previous.revision) invalidCallback('stale_callback', COPY.staleButton);
    else if (!validInstant(record.expiresAt) || Date.parse(record.expiresAt) <= Date.parse(context.now)) invalidCallback('expired_callback', COPY.expiredButton);
    else if(!record.action||typeof record.action!=='object'||Array.isArray(record.action)||typeof record.action.kind!=='string')invalidCallback('unknown_callback',COPY.unknownButton);
    else callback = record.action;
  }
  const state = clone(previous);
  state.revision++;
  state.processedInputIds = [...state.processedInputIds, input.id].slice(-256);
  if (input.kind === 'callback' && callback) state.callbacks[input.callbackId].consumed = true;
  const messages: BotMessage[] = [];
  const actions: BotAction[] = [];
  let profileChanged = false;
  const action = (type: BotAction['type'], rest: Partial<BotAction> = {}) => {
    actions.push({ type, idempotencyKey: `${state.ownerId}:${input.id}:${type}:${actions.length}`, simulationOnly: true, ...rest });
  };
  const button = (label: string, next: CallbackAction) => {
    const token = `b${(++state.callbackSequence).toString(36)}_${state.sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)}`;
    state.callbacks[token] = { ownerId: state.ownerId, stateRevision: state.revision,
      expiresAt: new Date(Date.parse(context.now) + Math.min(Math.max(context.callbackTtlSeconds || 900, 1), 86400) * 1000).toISOString(), action: next, consumed: false };
    return { label, callbackId: token };
  };
  const commandButton = (label: string, value: string) => button(label, { kind: 'command', value });
  const message = (text: string, buttons: BotMessage['buttons'] = [], kind: BotMessage['kind'] = 'reply', view?: ScheduleView) => {
    const result: BotMessage = { id: `${input.id}:${messages.length}`, text, buttons, kind, commitBarrier: 'none' };
    if (view) result.scheduleRevisionId = view.revisionId;
    messages.push(result);
  };
  const mutate = () => { state.profile = syncLegacyPolicyChanges(previous.profile, state.profile); profileChanged = true; };
  const location = () => state.profile.locations.find(l => l.address.id === state.currentAddressId);
  const hasTypedPolicy = () => Boolean(state.profile.preferences.notificationPolicy || state.profile.locations.some(item => item.notificationPolicy));
  const navigation = () => [commandButton('Мій план', '/start'), commandButton('Меню', '/menu')];
  const addressLimit = Number.isInteger(context.maxAddresses) && context.maxAddresses! >= 0 ? Math.min(context.maxAddresses!, MAX_PROFILE_ADDRESSES) : MAX_PROFILE_ADDRESSES;
  const addressWizardStages: BotStage[] = ['locality', 'provider_locality','street', 'street_choice', 'house', 'connection', 'address_confirm'];
  const leadStages: BotStage[] = ['reminder_off_time', 'reminder_on_time', 'push_off_time', 'push_on_time'];
  const wizardNav = () => [commandButton(BOT_COPY.engineText005, '/back'), commandButton(BOT_COPY.engineText006, '/cancel')];
  const providerText=(v:unknown,max=200):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
  const providerId=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
  const directories=()=>(Array.isArray(context.providerDirectory)&&context.providerDirectory.length<=64?context.providerDirectory:[]).filter(d=>d&&d.namespace==='yasno:25/902'&&d.operatorId==='dtek-kem'&&
    [d.id,d.localityId,d.locality,d.territoryId,d.territoryLabel].every(v=>providerText(v))&&
    context.providerDirectory!.filter(other=>other?.id===d.id).length===1&&
    context.providerDirectory!.filter(other=>other?.namespace===d.namespace&&other?.territoryId===d.territoryId&&other?.localityId===d.localityId).length===1);
  const providerDirectory=()=>directories().find(d=>d.id===state.draft?.providerDirectoryId);
  const isV2=()=>Boolean(state.draft?.providerV2);
  const directoriesV2=()=>Array.isArray(context.providerDirectoriesV2)?context.providerDirectoriesV2.filter(d=>d&&d.id==='dtek:oem'&&d.namespace==='dtek:oem'&&d.operatorId==='dtek-oem'&&d.territoryId==='source:dtek:oem'&&d.localitySelection==='required'&&v2Text(d.label)&&context.providerDirectoriesV2!.filter(x=>x?.id===d.id).length===1):[];
  const catalogUnavailable=()=>!isV2()&&!providerDirectory()&&(context.addressCatalogStatus==='loading'||context.addressCatalogStatus==='unavailable');
  const addAddressNavigation = () => [
    ...(state.draft?.operation === 'add' ? [commandButton('Обрати групу графіка вручну', '/queue')] : []),
    ...wizardNav(),
  ];
  const showCatalogUnavailable=(allowGroupChoice = false)=>message(context.addressCatalogStatus==='loading'
    ?'Оновлюємо довідник адрес. Зачекайте трохи й повторіть вибір. Чернетку збережено; нову адресу ще не додано.'
    :'Тимчасово не вдалося отримати довідник адрес. Це не означає, що вашого будинку немає. Чернетку збережено — повторіть вибір пізніше.',allowGroupChoice ? addAddressNavigation() : wizardNav());
  const draftStage = (stage: BotStage) => { state.stage = stage; if (state.draft) state.draft.resumeStage = stage; };
  const scopedOptions = () => context.addresses.filter(o => !state.draft?.locality ||
    (o.address.territoryId === state.draft.territoryId && (state.draft.localityId
      ? o.address.localityId===state.draft.localityId
      : [o.address.locality,...(o.address.localityAliases??[])].some(name=>localityMatchesQuery(name,state.draft!.locality!)))));
  const streetOptions = () => isV2()?v2Options():scopedOptions().filter(o => state.draft?.streetIdentity
    ? addressStreetKey(o.address)===state.draft.streetIdentity
    : streetMatchesQuery(o.address.street,state.draft?.street||'','exact'));
  const operatorLabel=(option:AddressOption)=>context.operatorLabels?.[option.binding.operatorId]||option.binding.operatorId;
  const providerFresh=(expiresAt:unknown)=>validInstant(expiresAt)&&Date.parse(expiresAt)>Date.parse(context.now);
  const providerHouseContext=()=>{
    const d=providerDirectory(),h=context.providerHouses,s=context.providerStreets;
    return d&&h&&s&&s.directoryId===d.id&&s.state==='available'&&s.snapshotId===h.streetSnapshotId&&providerFresh(s.expiresAt)&&
      Array.isArray(s.items)&&s.items.length<=1000&&s.items.filter(r=>r?.id===h.streetId&&r.value===h.streetValue).length===1&&
      h.directoryId===d.id&&h.streetId===state.draft?.providerStreetId&&h.streetSnapshotId===state.draft?.providerStreetSnapshotId&&
      h.state==='available'&&providerText(h.houseSnapshotId,128)&&providerFresh(h.expiresAt)&&Array.isArray(h.items)&&h.items.length<=1000&&
      providerText(h.query,100)&&providerText(h.streetValue)&&h.streetValue===state.draft?.street&&
      h.items.every(r=>r&&providerId(r.id)&&providerText(r.value,100))&&new Set(h.items.map(r=>r.id)).size===h.items.length?h:null;
  };
  const providerOptionMatches=(option:AddressOption)=>{
    if(isV2())return v2Options().some(o=>o.id===option.id&&addressOptionFingerprint(o)===addressOptionFingerprint(option));
    const d=providerDirectory(),h=providerHouseContext();
    if(!state.draft?.providerDirectoryId)return true;
    return Boolean(d&&h&&state.draft.providerHouseSnapshotId===h.houseSnapshotId&&
      option.binding.operatorId===d.operatorId&&option.binding.namespace===d.namespace&&
      option.address.territoryId===d.territoryId&&option.address.localityId===d.localityId&&
      option.address.streetId===`source:${d.namespace}:street:${h.streetId}`&&
      h.items.filter(r=>r.optionId===option.id&&houseMatchesQuery(r.value,state.draft?.house||'')&&houseMatchesQuery(option.address.house.literal,r.value)).length===1);
  };
  const draftMatches=(option:AddressOption)=>isV2()?providerOptionMatches(option):Boolean(state.draft&&scopedOptions().some(o=>o.id===option.id)&&
    streetOptions().some(o=>o.id===option.id)&&houseMatchesQuery(option.address.house.literal,state.draft.house||'')&&providerOptionMatches(option));
  const confirmOption = (option: AddressOption) => {
    if (!state.draft) return;
    if(catalogUnavailable()){showCatalogUnavailable();return;}
    if(!draftMatches(option)){message(COPY.noHouse,wizardNav());return;}
    state.draft.optionId = option.id;
    state.draft.bindingRevision = option.binding.revisionId;
    state.draft.selectionFingerprint=addressOptionFingerprint(option);
    draftStage('address_confirm');
    const a = option.address;
    const providerSelection=Boolean(state.draft.providerDirectoryId||state.draft.providerV2);
    const selection=context.providerLookupV2?.selectedHouse;
    const selectedNotice=context.operatorHouseNotices!==undefined?context.operatorHouseNotices.find(n=>n.addressId===a.id):selection?.operatorHouseNotice;
    const eligibleHouse=isV2()&&selection?.state==='available'&&selection.options.some(o=>o.id===option.id&&addressOptionFingerprint(o)===addressOptionFingerprint(option));
    const ephemeral=eligibleHouse&&(context.operatorHouseNotices!==undefined||selectedNotice&&selectedNotice.addressId===a.id&&selectedNotice.observedAt===selection!.observedAt&&
      Date.parse(selectedNotice.expiresAt)<=Date.parse(selection!.expiresAt)&&currentOperatorHouseNotice(selectedNotice,context.now))
      ?`\n\n${formatOperatorHouseNotice(selectedNotice,context.now)}`:'';
    message(`${COPY.confirm}\n\n${a.locality}, ${a.street}, ${a.house.literal}${providerSelection?'':`\n${option.territoryLabel}`}\nОператор: ${operatorLabel(option)}${option.connectionLabel ? `\n${option.connectionLabel}` : ''}${a.placeNames?.length?`\n${a.placeNames.join(' · ')}`:''}\n${option.binding.status === 'verified' ? BOT_COPY.engineText007 : providerSelection?'Довідник указав групу для цього будинку. Відповідність ще потребує перевірки.':BOT_COPY.engineText008}${ephemeral}`, [button(BOT_COPY.engineText009, { kind: 'confirm_address' }), ...wizardNav()]);
  };
  const pageButtons = (scope: 'addresses' | 'locality' | 'street' | 'manual_group' | 'connection' | 'provider_street' | 'provider_house', page: number, count: number) => [
    ...(page > 0 ? [button('Попередні', { kind: 'page', scope, value: page - 1 })] : []),
    ...((page + 1) * ADDRESS_PAGE_SIZE < count ? [button('Наступні', { kind: 'page', scope, value: page + 1 })] : []),
  ];
  const boundedPage = (page: number | undefined, count: number) => Math.max(0, Math.min(Number.isInteger(page) ? page! : 0, Math.max(0, Math.ceil(count / ADDRESS_PAGE_SIZE) - 1)));
  const providerRepair=(kind:'street'|'house',status?:string)=>message(status==='loading'
    ?'Пошук ще триває. Зачекайте трохи й повторіть запит; чернетку збережено.'
    :status==='deferred'?'Пошук поки призупинено. Повторіть запит трохи пізніше; чернетку збережено.'
    :status==='stale'?'Дані пошуку застаріли. Поверніться до вибору вулиці й повторіть пошук. Збережені адреси не змінено.'
    :`Не вдалося отримати ${kind==='street'?'вулиці':'будинки'} з довідника. Це не означає, що адреси немає. Повторіть запит або поверніться до попереднього кроку.`,wizardNav());
  const providerButtonLabel=(value:string,index:number)=>`${index+1} · ${value.length>88?value.slice(0,87)+'…':value}`;
  const duplicateProviderKeys=(items:Array<{id:number;value:string}>,key:(value:string)=>string)=>{
    const counts=new Map<string,number>();for(const item of items){const value=key(item.value);counts.set(value,(counts.get(value)||0)+1);}
    return new Set([...counts].filter(([,count])=>count>1).map(([value])=>value));
  };
  const renderProviderStreets=()=>{
    const d=providerDirectory(),s=context.providerStreets;draftStage('street_choice');
    if(!d||!s||s.directoryId!==d.id||s.state!=='available'||!providerText(s.snapshotId,128)||!providerFresh(s.expiresAt)||
      !Array.isArray(s.items)||s.items.length>1000||s.items.some(r=>!r||!providerId(r.id)||!providerText(r.value))||new Set(s.items.map(r=>r.id)).size!==s.items.length){providerRepair('street',s?.state==='available'?'stale':s?.state);return;}
    try{if(normalizeAddressText(s.query)!==normalizeAddressText(state.draft?.streetQuery||'')){providerRepair('street');return;}}catch{providerRepair('street');return;}
    const choices=s.items.filter(r=>streetMatchesQuery(r.value,state.draft?.streetQuery||''));
    const duplicates=duplicateProviderKeys(choices,streetKey);
    const distinct=choices.filter(r=>!duplicates.has(streetKey(r.value))),page=boundedPage(state.catalogPage,distinct.length);state.catalogPage=page;
    const shown=distinct.slice(page*ADDRESS_PAGE_SIZE,(page+1)*ADDRESS_PAGE_SIZE);
    message(shown.length?`Оберіть вулицю з довідника.\n${shown.map((r,i)=>`${page*ADDRESS_PAGE_SIZE+i+1}. ${r.value}`).join('\n')}${distinct.length>ADDRESS_PAGE_SIZE?`\nСторінка ${page+1} з ${Math.ceil(distinct.length/ADDRESS_PAGE_SIZE)}.`:''}`
      :'Довідник не повернув вулиці за цим запитом. Перевірте назву або введіть її без скорочення. Це не означає, що вулиці не існує.',
      [...shown.map((r,i)=>button(providerButtonLabel(r.value,page*ADDRESS_PAGE_SIZE+i),{kind:'provider_street',value:JSON.stringify([s.snapshotId,r.id])})),...pageButtons('provider_street',page,distinct.length),...wizardNav()]);
    if(duplicates.size)message('У довіднику є однакові назви з різними записами, але бракує району чи інших ознак, щоб їх розрізнити. Уточніть вулицю в оператора — випадковий запис не обираємо.',wizardNav());
  };
  const renderProviderHouses=(expectedQuery?:string)=>{
    const h=providerHouseContext();draftStage('house');
    if(!h){providerRepair('house',context.providerHouses?.state==='available'?'stale':context.providerHouses?.state);return;}
    try{if(expectedQuery!==undefined&&normalizeHouse(h.query)!==normalizeHouse(expectedQuery)){providerRepair('house');return;}}catch{providerRepair('house');return;}
    const duplicates=duplicateProviderKeys(h.items,normalizeHouse);
    const distinct=h.items.filter(r=>!duplicates.has(normalizeHouse(r.value))),page=boundedPage(state.catalogPage,distinct.length);state.catalogPage=page;
    const shown=distinct.slice(page*ADDRESS_PAGE_SIZE,(page+1)*ADDRESS_PAGE_SIZE);
    message(shown.length?`${state.draft?.street||h.streetValue}\nОберіть точний будинок. Літера, дріб і корпус мають значення.\n${shown.map((r,i)=>`${page*ADDRESS_PAGE_SIZE+i+1}. ${r.value}`).join('\n')}${distinct.length>ADDRESS_PAGE_SIZE?`\nСторінка ${page+1} з ${Math.ceil(distinct.length/ADDRESS_PAGE_SIZE)}.`:''}`
      :'За цим запитом довідник не повернув будинків. Перевірте номер, українську літеру й корпус. Сусідній будинок не підставляємо.',
      [...shown.map((r,i)=>button(providerButtonLabel(r.value,page*ADDRESS_PAGE_SIZE+i),{kind:'provider_house',value:JSON.stringify([h.streetSnapshotId,h.houseSnapshotId,h.streetId,r.id])})),...pageButtons('provider_house',page,distinct.length),...wizardNav()]);
    if(duplicates.size)message('Для однакового номера довідник повернув різні записи без пояснення підключень. Уточніть дані в оператора; випадковий варіант не зберігаємо.',wizardNav());
  };
  const v2Snapshot=(level:BotProviderSnapshotV2['level'])=>providerV2SnapshotForState(state,context,level);
  const v2HouseTuple=()=>{const d=state.draft?.providerV2;return d?.catalogSnapshotId&&d.houseSnapshotId&&d.cityKey&&d.streetKey&&d.houseKey?[d.catalogSnapshotId,d.houseSnapshotId,d.cityKey,d.streetKey,d.houseKey]:null;};
  const clearV2Confirmation=()=>{if(state.draft)for(const key of ['optionId','bindingRevision','selectionFingerprint'] as const)delete state.draft[key];};
  const v2Options=():AddressOption[]=>{
    try{
      const d=state.draft?.providerV2,h=v2Snapshot('houses'),selected=context.providerLookupV2?.selectedHouse;
      if(!d||!h||!selected||selected.state!=='available'||!providerFresh(selected.expiresAt)||!validInstant(selected.observedAt)||Date.parse(selected.observedAt)>Date.parse(context.now)||
        selected.catalogSnapshotId!==d.catalogSnapshotId||selected.houseSnapshotId!==d.houseSnapshotId||selected.houseSnapshotId!==h.id||selected.cityKey!==d.cityKey||selected.streetKey!==d.streetKey||selected.houseKey!==d.houseKey||
        Date.parse(selected.expiresAt)>Date.parse(h.expiresAt)||!Array.isArray(selected.options)||!selected.options.length||selected.options.length>20)return [];
      const row=h.items.find(v=>v.key===d.houseKey),ids=selected.options.map(v=>v.id);
      if(!row||!Array.isArray(row.optionIds)||new Set(ids).size!==ids.length||row.optionIds.length!==ids.length||row.optionIds.some(id=>!ids.includes(id))||new Set(selected.options.map(v=>v.binding.targetId)).size!==ids.length)return [];
      const options=selected.options.map(option=>{
        if(!option||option.binding.operatorId!=='dtek-oem'||option.binding.namespace!=='dtek:oem'||option.binding.addressId!==option.address.id||option.binding.kind!=='operator_group'||
          !['ambiguous','needs_confirmation'].includes(option.binding.status)||!/^GPV[1-6]\.[12]$/.test(option.binding.targetId)||option.address.territoryId!=='source:dtek:oem'||
          option.address.locality!==d.cityKey||option.address.street!==d.streetKey||option.address.house.literal!==d.houseKey)return null;
        const actual=context.addresses.filter(v=>v.id===option.id);
        return actual.length===1&&addressOptionFingerprint(actual[0])===addressOptionFingerprint(option)&&v2Canonical(actual[0])===v2Canonical(option)?actual[0]:null;
      });
      if(options.some(v=>!v)||options.some(v=>v!.address.id!==options[0]!.address.id||v2Canonical(v!.address)!==v2Canonical(options[0]!.address)))return [];
      return options as AddressOption[];
    }catch{return [];}
  };
  const v2RetryValue=(level:BotProviderSnapshotV2['level'])=>{
    const d=state.draft?.providerV2,query=level==='localities'?d?.localityQuery:level==='streets'?d?.streetQuery:d?.houseQuery;
    return query?JSON.stringify([level,level==='localities'?null:d?.catalogSnapshotId??null,level==='localities'?null:d?.cityKey??null,level==='houses'?d?.streetKey??null:null,query]):null;
  };
  const v2Repair=(level:BotProviderSnapshotV2['level'])=>{
    draftStage(level==='localities'?'provider_locality':level==='streets'?'street_choice':'house');clearV2Confirmation();
    const d=state.draft?.providerV2;
    if(d){for(const key of level==='localities'?['catalogSnapshotId','cityKey','streetQuery','streetKey','houseQuery','houseSnapshotId','houseKey'] as const:level==='streets'?['streetKey','houseQuery','houseSnapshotId','houseKey'] as const:['houseSnapshotId','houseKey'] as const)delete d[key];}
    const stage=context.providerLookupV2?.[level],retry=v2RetryValue(level),at=stage?.retryAt;
    const when=validInstant(at)&&Date.parse(at)>Date.parse(context.now)?` Наступна спроба — після ${new Date(at).toLocaleTimeString('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit'})}.`:'';
    message(stage?.state==='stale'?'Дані пошуку застаріли. Поверніться до попереднього кроку та повторіть пошук. Збережені адреси не змінено.'
      :stage?.state==='deferred'?`Пошук тимчасово недоступний.${when} Запит збережено.`
      :stage?.state==='loading'?'Пошук ще триває. Запит збережено — повторіть спробу трохи пізніше.'
      :'Не вдалося отримати список від оператора. Це не означає, що адреси немає. Запит збережено.',
      [...(retry?[button('Повторити пошук',{kind:'provider_v2_retry',value:retry})]:[]),...wizardNav()]);
  };
  const v2PageTuple=(s:BotProviderSnapshotV2,query:string,target:number)=>JSON.stringify([s.level,s.id,s.catalogSnapshotId,s.cityKey??null,s.streetKey??null,query,s.offset,target]);
  const renderV2=(level:BotProviderSnapshotV2['level'])=>{
    draftStage(level==='localities'?'provider_locality':level==='streets'?'street_choice':'house');
    const d=state.draft?.providerV2,query=level==='localities'?d?.localityQuery:level==='streets'?d?.streetQuery:d?.houseQuery;
    if(!query){message(level==='localities'?'Введіть назву населеного пункту в Одеській області.':level==='streets'?'Введіть назву вулиці. Якщо стара назва не знаходиться, спробуйте теперішню.':'Введіть номер будинку разом із літерою або корпусом, якщо вони є.',wizardNav());return;}
    const s=v2Snapshot(level);if(!s){v2Repair(level);return;}
    const page=boundedPage(state.catalogPage,s.items.length);state.catalogPage=page;const shown=s.items.slice(page*ADDRESS_PAGE_SIZE,(page+1)*ADDRESS_PAGE_SIZE);
    const prefix=level==='localities'?'Оберіть населений пункт.':level==='streets'?`${d?.cityKey}\nОберіть вулицю.`:`${d?.cityKey}, ${d?.streetKey}\nОберіть точний будинок. Літера, дріб і корпус мають значення.`;
    const choices=shown.map((row,index)=>button(providerButtonLabel(row.value,s.offset+page*ADDRESS_PAGE_SIZE+index),{kind:level==='localities'?'provider_v2_city':level==='streets'?'provider_v2_street':'provider_v2_house',
      value:JSON.stringify(level==='localities'?[s.id,row.key]:level==='streets'?[s.catalogSnapshotId,s.cityKey,row.key]:[s.catalogSnapshotId,s.id,s.cityKey,s.streetKey,row.key])}));
    const pager:BotMessage['buttons']=[];
    if(page>0)pager.push(button('Попередні',{kind:'provider_v2_page',value:v2PageTuple(s,query,page-1)}));
    else if(s.offset>=30)pager.push(button('Попередні',{kind:'provider_v2_batch',value:v2PageTuple(s,query,s.offset-30)}));
    if((page+1)*ADDRESS_PAGE_SIZE<s.items.length)pager.push(button('Наступні',{kind:'provider_v2_page',value:v2PageTuple(s,query,page+1)}));
    else if(s.hasMore&&s.offset+30<=20000)pager.push(button('Наступні',{kind:'provider_v2_batch',value:v2PageTuple(s,query,s.offset+30)}));
    message(shown.length?`${prefix}\n${shown.map((row,index)=>`${s.offset+page*ADDRESS_PAGE_SIZE+index+1}. ${row.value}`).join('\n')}`
      :'За цим запитом оператор не повернув записів. Перевірте назву або номер і спробуйте без скорочень. Відсутність у списку не означає, що адреси не існує.',[...choices,...pager,...wizardNav()]);
  };
  const chooseV2House=()=>{
    const options=v2Options();if(!state.draft||!options.length){v2Repair('houses');return;}
    state.draft.localityId=options[0].address.localityId;state.draft.streetIdentity=addressStreetKey(options[0].address);
    state.catalogPage=0;if(options.length===1)confirmOption(options[0]);else renderConnections();
  };
  const renderHome = (welcome = false) => {
    state.stage = 'home';
    if (state.profile.locations.length) showSchedule();
    else message(COPY.welcome, [commandButton(BOT_COPY.engineText014, '/add'), commandButton(BOT_COPY.engineText015, '/help')]);
    if (state.draft) message('Незавершену адресу збережено як чернетку. Можна продовжити з того самого кроку.', [commandButton(BOT_COPY.engineText016, '/draft'), commandButton('Відкинути чернетку', '/discard_draft')]);
    if (welcome && context.migration?.status === 'needs_confirmation') message(BOT_COPY.engineText018, [commandButton(BOT_COPY.engineText019, '/addresses')]);
  };
  const renderMenu = () => {
    state.stage = 'menu';
    message('Меню. Оберіть потрібний розділ.', [commandButton('Адреси', '/addresses'), commandButton('Сповіщення', '/settings'), commandButton('Додаткові можливості', '/tools'), commandButton('Допомога', '/help'), commandButton('Мій план', '/start')]);
  };
  const renderAddresses = () => {
    state.stage = 'addresses';
    const count = state.profile.locations.length, page = boundedPage(state.addressPage, count); state.addressPage = page;
    message(count ? `${BOT_COPY.engineText020}\nСторінка ${page + 1} з ${Math.ceil(count / ADDRESS_PAGE_SIZE)}.` : COPY.noAddresses,
      [...state.profile.locations.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(l => button(`${l.address.id === state.profile.primaryAddressId ? BOT_COPY.engineText021 : ''}${l.address.label}${l.paused ? BOT_COPY.engineText022 : ''}`, { kind: 'location', value: l.address.id })),
        ...pageButtons('addresses', page, count), ...(count < addressLimit ? [commandButton(BOT_COPY.engineText023, '/add')] : []), commandButton('Назад', '/menu')]);
  };
  const houseNoticeText=(l:BotLocation)=>context.operatorHouseNotices!==undefined&&operatorHouseScope(l)?formatOperatorHouseNotice(context.operatorHouseNotices.find(n=>n.addressId===l.address.id),context.now):'';
  const locationSummary = (l: BotLocation) => BOT_COPY.engineText031(l.address.label, l.address.locality, l.address.street, l.address.house.literal ? ', ' + l.address.house.literal : '', l.binding.kind === 'user_selected_group' ? BOT_COPY.engineText025 : l.binding.status === 'verified' ? BOT_COPY.engineText026 : BOT_COPY.engineText027, l.paused ? BOT_COPY.engineText028 : l.notifications ? BOT_COPY.engineText029 : BOT_COPY.engineText030) + `\nPush для адреси: ${l.notificationPolicy?.channels.push.enabled ? 'увімкнено' : 'вимкнено'}.\nЗагальна згода, пауза й перевірка адреси діють окремо.`;
  const renderLocation = (stage: BotStage = 'location') => {
    const l = location(); if (!l) { renderAddresses(); return; }
    state.stage = stage;
    const back = commandButton('Назад', '/back');
    let buttons: BotMessage['buttons'];
    if (stage === 'location_manage') buttons = [button(BOT_COPY.engineText033, { kind: 'location_action', value: 'rename' }), button(BOT_COPY.engineText034, { kind: 'location_action', value: 'edit' }), commandButton('Основна адреса й порядок', '/location_order'), button(BOT_COPY.engineText042, { kind: 'location_action', value: 'delete' }), back];
    else if (stage === 'location_order') {
      const index = state.profile.locations.indexOf(l);
      buttons = [...(l.address.id !== state.profile.primaryAddressId ? [button(BOT_COPY.engineText035, { kind: 'location_action', value: 'primary' })] : []), ...(index > 0 ? [button(BOT_COPY.engineText036, { kind: 'location_action', value: 'up' })] : []), ...(index < state.profile.locations.length - 1 ? [button(BOT_COPY.engineText037, { kind: 'location_action', value: 'down' })] : []), back];
    } else if (stage === 'location_notifications') buttons = [commandButton('Telegram для адреси', '/location_telegram'), commandButton('Push для адреси', '/location_push'), button(l.paused ? BOT_COPY.engineText038 : BOT_COPY.engineText039, { kind: 'location_action', value: 'pause' }), back];
    else if (stage === 'location_telegram' || stage === 'location_push') {
      const push = stage === 'location_push';
      buttons = [push ? commandButton(l.notificationPolicy?.channels.push.enabled ? 'Вимкнути push для адреси' : 'Увімкнути push для адреси', l.notificationPolicy?.channels.push.enabled ? '/address_push_off' : '/address_push_on') : button(l.notifications ? COPY.addressNotificationsOff : COPY.addressNotificationsOn, { kind: 'location_action', value: 'notifications' }), commandButton(push ? NOTIFICATION_COPY.addressPushBeforeOff : NOTIFICATION_COPY.addressBeforeOff, push ? '/address_push_before_off' : '/address_before_off'), commandButton(push ? NOTIFICATION_COPY.addressPushBeforeOn : NOTIFICATION_COPY.addressBeforeOn, push ? '/address_push_before_on' : '/address_before_on'), back];
    } else if (stage === 'location_tools') buttons = [button(BOT_COPY.engineText040, { kind: 'location_action', value: 'share' }), button(BOT_COPY.engineText041, { kind: 'location_action', value: 'report' }), commandButton('Порівняти адреси', '/compare'), commandButton('Історія', '/history'), back];
    else buttons = [commandButton(BOT_COPY.engineText032, '/schedule'), commandButton('Керування адресою', '/location_manage'), commandButton('Сповіщення адреси', '/location_notifications'), commandButton('Інші дії з адресою', '/location_tools'), back];
    let summary = locationSummary(l);
    const house=stage==='location'?houseNoticeText(l):'';if(house)summary+=`\n\n${house}`;
    if (stage === 'location_telegram' || stage === 'location_push') {
      try {
        const channel = stage === 'location_push' ? 'push' : 'telegram', policy = resolveNotificationPolicy(state.profile.preferences, l, channel);
        const raw = l.notificationPolicy?.channels[channel];
        const lead = (field: 'beforeOffMinutes' | 'beforeOnMinutes') => `${policy[field] === 0 ? 'вимкнено' : formatMinutesDuration(policy[field])}${raw?.[field] === undefined ? ' · як у каналі' : ' · для цієї адреси'}`;
        summary += `\n\n${channel === 'push' ? 'Push' : 'Telegram'} · ${l.address.label}\nПеред вимкненням: ${lead('beforeOffMinutes')}\nПеред плановим відновленням: ${lead('beforeOnMinutes')}\nЧас не вмикає канал. Загальна згода та пауза діють окремо.`;
      } catch { summary += `\n${NOTIFICATION_COPY.invalid}`; }
    }
    message(summary, buttons);
  };
  const renderSettings = (stage: BotStage = 'settings') => {
    state.stage = stage; const prefs = state.profile.preferences;
    let policy;
    try { policy = prefs.notificationPolicy ? parseNotificationPolicy(prefs.notificationPolicy) : defaultNotificationPolicy(prefs); }
    catch { message(NOTIFICATION_COPY.invalid, navigation()); return; }
    const back = commandButton('Назад', '/back');
    const buttons = stage === 'telegram' || stage === 'push' ? (() => {
      const push = stage === 'push', channel = push ? policy.channels.push : policy.channels.telegram;
      return [commandButton(push ? (channel.enabled ? NOTIFICATION_COPY.pushOffButton : NOTIFICATION_COPY.pushOnButton) : (prefs.optedIn ? NOTIFICATION_COPY.telegramOffButton : NOTIFICATION_COPY.telegramOnButton), push ? (channel.enabled ? '/push_off' : '/push_on') : (prefs.optedIn ? '/notifications_off' : '/notifications_on')),
        commandButton(channel.remindersEnabled ? (push ? NOTIFICATION_COPY.pushRemindersOff : NOTIFICATION_COPY.telegramRemindersOff) : (push ? NOTIFICATION_COPY.pushRemindersOn : NOTIFICATION_COPY.telegramRemindersOn), `/${push ? 'push' : 'telegram'}_reminders_${channel.remindersEnabled ? 'off' : 'on'}`), commandButton(push ? NOTIFICATION_COPY.pushBeforeOff : NOTIFICATION_COPY.beforeOff, push ? '/push_before_off' : '/before_off'), commandButton(push ? NOTIFICATION_COPY.pushBeforeOn : NOTIFICATION_COPY.beforeOn, push ? '/push_before_on' : '/before_on'), back];
    })() : stage === 'timing' ? [commandButton(BOT_COPY.engineText057, '/quiet'), commandButton(BOT_COPY.engineText058, '/briefing'), commandButton(BOT_COPY.engineText059, '/minimum'), commandButton('Спільний час Telegram', '/reminders'), back] : [commandButton('Telegram', '/telegram'), commandButton('Push', '/push'), commandButton('Час і розклад повідомлень', '/timing'), commandButton(prefs.paused ? BOT_COPY.engineText052 : BOT_COPY.engineText053, prefs.paused ? '/resume' : '/pause'), back];
    message(formatNotificationSettings(prefs, policy), buttons);
  };
  const renderTools = (stage: BotStage = 'tools') => {
    state.stage = stage;
    const buttons = stage === 'account' ? [commandButton(COPY.openApp, '/app'), commandButton('Відновлення старого профілю', '/migration'), commandButton('Скинути профіль', '/reset'), commandButton('Про сервіс', '/about')] : [commandButton('Порівняти адреси', '/compare'), commandButton('Історія змін', '/history'), commandButton('Тижневий огляд', '/digest'), commandButton('Профіль і доступ', '/account')];
    message(stage === 'account' ? 'Профіль і доступ. Старі посилання перевіряє захищений адаптер; акаунти не об’єднуються автоматично.' : 'Додаткові можливості. Для кожної дії показуємо її фактичний стан.', [...buttons, commandButton('Назад', '/back')]);
  };
  const beginAddress = (edit = false) => {
    const existing = edit ? location() : null;
    if (!edit && state.profile.locations.length >= addressLimit) {
      message(BOT_COPY.engineText062(addressLimit), [commandButton(BOT_COPY.engineText063, '/addresses')]); return;
    }
    state.draft = { operation: edit ? 'edit' : 'add', originalAddressId: existing?.address.id,
      label: existing?.address.label, resumeStage: 'locality' };
    state.catalogPage = 0;
    renderWizard('locality');
  };
  const renderStreetMatches = () => {
    if(isV2()){renderV2('streets');return;}
    if(providerDirectory()){renderProviderStreets();return;}
    if(catalogUnavailable()){showCatalogUnavailable();return;}
    const seen = new Set<string>();
    const query=state.draft?.streetQuery||'';
    const matches = scopedOptions().filter(o => [o.address.street, ...o.address.aliases].some(name => streetMatchesQuery(name,query)))
      .filter(o => { const key=addressStreetKey(o.address);if (seen.has(key)) return false; seen.add(key); return true; });
    const streetLabel=(o:AddressOption)=>`${o.address.street}${matches.some(other=>other.id!==o.id&&other.address.street===o.address.street)?` · ${operatorLabel(o)}`:''}`;
    const ambiguousStreetLabels=new Set(matches.filter((o,i,all)=>all.some((other,j)=>j!==i&&streetLabel(other)===streetLabel(o))).map(streetLabel));
    const placeSeen=new Set<string>();
    const placeName=(o:AddressOption)=>o.address.placeNames!.find(name=>placeNameMatchesQuery(name,query))!;
    const placeLabel=(o:AddressOption)=>`${placeName(o)} · ${o.address.street}, ${o.address.house.literal}`;
    const places=scopedOptions().filter(o=>o.address.placeNames?.some(name=>placeNameMatchesQuery(name,query))).filter(o=>{
      const key=JSON.stringify([addressStreetKey(o.address),normalizeHouse(o.address.house.literal),normalizeAddressText(placeName(o))]);
      if(placeSeen.has(key))return false;placeSeen.add(key);return true;
    });
    const ambiguousPlaceLabels=new Set(places.filter((o,i,all)=>all.some((other,j)=>j!==i&&placeLabel(other)===placeLabel(o))).map(placeLabel));
    const all=[...matches.filter(o=>!ambiguousStreetLabels.has(streetLabel(o))).map(option=>({option,place:false})),...places.filter(o=>!ambiguousPlaceLabels.has(placeLabel(o))).map(option=>({option,place:true}))];
    draftStage('street_choice'); const page = boundedPage(state.catalogPage, all.length); state.catalogPage = page;
    message(all.length ? `${BOT_COPY.engineText128}${all.length > ADDRESS_PAGE_SIZE ? `\nСторінка ${page + 1} з ${Math.ceil(all.length / ADDRESS_PAGE_SIZE)}.` : ''}` : `${COPY.noStreet}\nСпочатку введіть лише назву вулиці або відомого об’єкта. Номер будинку оберемо наступним кроком.`,
      [...all.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(({option:o,place}) => button(place?placeLabel(o):streetLabel(o), { kind:place?'place':'street', value: o.id })), ...pageButtons('street', page, all.length), ...wizardNav()]);
    if(ambiguousStreetLabels.size||ambiguousPlaceLabels.size)message('У довіднику є різні адреси з однаковими підписами. Без району або інших точних ознак їх не можна розрізнити. Уточніть адресу в оператора; випадковий збіг не обираємо.',wizardNav());
  };
  const renderConnections = () => {
    if(isV2()){
      draftStage('connection');const options=v2Options(),tuple=v2HouseTuple();
      if(!options.length||!tuple){v2Repair('houses');return;}
      const page=boundedPage(state.catalogPage,options.length);state.catalogPage=page;
      message('Оператор указав кілька груп для цього будинку. Оберіть свою групу. Якщо не впевнені, не обирайте навмання.',
        [...options.slice(page*ADDRESS_PAGE_SIZE,(page+1)*ADDRESS_PAGE_SIZE).map(o=>button(o.connectionLabel||`Група ${o.binding.targetId.replace(/^GPV/,'')}`,{kind:'provider_v2_group',value:JSON.stringify([...tuple,o.id,addressOptionFingerprint(o)])})),
         ...pageButtons('connection',page,options.length),button('Не знаю свою групу',{kind:'provider_v2_unknown_group',value:JSON.stringify(tuple)}),...wizardNav()]);return;
    }
    if(catalogUnavailable()){showCatalogUnavailable();return;}
    const matches = streetOptions().filter(o => houseMatchesQuery(o.address.house.literal,state.draft?.house || ''));
    draftStage('connection'); const page = boundedPage(state.catalogPage, matches.length); state.catalogPage = page;
    const labels=matches.map(o=>`${operatorLabel(o)}${o.connectionLabel?` · ${o.connectionLabel}`:''}`);
    if(new Set(labels).size!==labels.length){message(`${COPY.connection}\nУ довіднику бракує ознак, щоб розрізнити ці підключення. Уточніть їх у свого оператора; випадковий варіант не зберігаємо.`,wizardNav());return;}
    const severalOperators=new Set(matches.map(o=>o.binding.operatorId)).size>1;
    message(COPY.connection, [...matches.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(o => button(severalOperators?`${operatorLabel(o)}${o.connectionLabel?` · ${o.connectionLabel}`:''}`:o.connectionLabel||operatorLabel(o), { kind: 'connection', value: o.id })), ...pageButtons('connection', page, matches.length), ...wizardNav()]);
  };
  const renderWizard = (stage = state.draft?.resumeStage || 'locality') => {
    if (!state.draft) { renderHome(); return; }
    draftStage(stage);
    if(stage==='provider_locality'&&isV2()){renderV2('localities');return;}
    if(catalogUnavailable()&&!(stage==='locality'&&(directories().length||directoriesV2().length))){showCatalogUnavailable(stage==='locality');return;}
    if (stage === 'locality') {
      const seen = new Set<string>();
      const choices = context.addresses.filter(o=>!state.draft?.localityQuery||[o.address.locality,...(o.address.localityAliases??[])].some(name=>localityMatchesQuery(name,state.draft!.localityQuery!,'contains')))
        .filter(o=>!directories().some(d=>d.territoryId===o.address.territoryId&&d.localityId===o.address.localityId))
        .filter(o=>!directoriesV2().some(d=>d.territoryId===o.address.territoryId&&d.namespace===o.binding.namespace&&d.operatorId===o.binding.operatorId))
        .filter(o => { const key = localityKey(o); if (seen.has(key)) return false; seen.add(key); return true; });
      const localityLabel=(o:AddressOption)=>`${o.address.locality} · ${o.territoryLabel}`;
      const ambiguous=new Set(choices.filter((o,i,all)=>all.some((other,j)=>j!==i&&localityLabel(other)===localityLabel(o))).map(localityLabel));
      const distinct=choices.filter(o=>!ambiguous.has(localityLabel(o)));
      const providerChoices=directories().filter(d=>!state.draft?.localityQuery||localityMatchesQuery(d.locality,state.draft.localityQuery,'contains'))
        .map(d=>({label:`${d.locality} · ${context.operatorLabels?.[d.operatorId]||d.territoryLabel} · пошук адреси`,value:'provider:'+d.id,v2:false}));
      const providerChoicesV2=directoriesV2().filter(d=>!state.draft?.localityQuery||localityMatchesQuery(d.label,state.draft.localityQuery,'contains')||['одеса','одеська область'].some(name=>name.startsWith(normalizeAddressText(state.draft!.localityQuery!)))).map(d=>({label:`${d.label} · пошук адреси`,value:d.id,v2:true}));
      const all=[...providerChoices,...providerChoicesV2,...distinct.map(o=>({label:localityLabel(o),value:localityKey(o),v2:false}))];
      const page = boundedPage(state.catalogPage, all.length); state.catalogPage = page;
      const empty=context.addressCatalogStatus==='loading'?'Оновлюємо довідник адрес. Спробуйте трохи пізніше; чернетку збережено.':context.addressCatalogStatus==='unavailable'?'Не вдалося отримати довідник адрес. Це не означає, що вашої адреси немає. Спробуйте пізніше або відкрийте допомогу.':state.draft.localityQuery?'Не знайшли такого населеного пункту в доступному довіднику. Перевірте назву або введіть її без скорочення.':BOT_COPY.engineText064;
      message(all.length ? `${COPY.locality}\nМожна також ввести назву текстом.${all.length > ADDRESS_PAGE_SIZE ? `\nСторінка ${page + 1} з ${Math.ceil(all.length / ADDRESS_PAGE_SIZE)}.` : ''}` : empty, [...all.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(o => button(o.label, { kind:o.v2?'provider_v2_directory':'locality', value:o.value })), ...pageButtons('locality', page,all.length), ...addAddressNavigation()]);
      if(ambiguous.size)message('Є населені пункти з однаковою назвою, а в довіднику бракує району чи громади, щоб їх розрізнити. Уточніть повну адресу в оператора. За самою назвою графік не підставляємо.',wizardNav());
    } else if (stage === 'street_choice') renderStreetMatches();
    else if (stage === 'street') message(providerDirectory()||isV2()?'Введіть назву вулиці. Якщо за старою назвою нічого немає, спробуйте теперішню.':COPY.street, wizardNav());
    else if (stage === 'connection') renderConnections();
    else if (stage === 'house') {
      if(isV2())renderV2('houses');
      else if(providerDirectory()&&context.providerHouses&&state.draft.house)renderProviderHouses();
      else message(`${state.draft.street || ''}\n${COPY.house}`, wizardNav());
    }
    else if (stage === 'address_confirm') {
      const option = context.addresses.find(o => o.id === state.draft?.optionId);
      if (option) confirmOption(option); else { draftStage('house'); message(COPY.noHouse, wizardNav()); }
    } else renderHome();
  };
  const showSchedule = () => {
    if (!state.profile.locations.length) { renderAddresses(); return; }
    const l = location() || state.profile.locations.find(item => item.address.id === state.profile.primaryAddressId) || state.profile.locations[0];
    state.currentAddressId = l.address.id; state.stage = 'home';
    const buttons = [commandButton('Інша адреса', '/addresses'), commandButton('Нагадування', '/location_telegram'), commandButton('Меню', '/menu')];
    const plan = context.plans.find(plan => plan.addressId === l.address.id);
    const notices = `${state.profile.preferences.paused ? BOT_COPY.engineText017 : ''}${l.binding.status !== 'verified' ? '\n\nПрив’язка адреси потребує підтвердження.' : ''}`;
    const house=houseNoticeText(l);
    if (!plan) { message(`${l.address.label}\n${house?`${house}\n\n`:''}${COPY.noPlan}${notices}`, buttons); return; }
    const view: ScheduleView = { ...plan, addressLabel: l.address.label };
    message((house?`${house}\n\nПогодинний план групи\n`:'')+formatScheduleText(view) + notices, buttons, 'schedule', view);
  };
  const parentStage = (): BotStage => {
    if (leadStages.includes(state.stage)) return state.returnStage || (typeof state.policyAddressId === 'string' ? (state.stage.startsWith('push') ? 'location_push' : 'location_telegram') : state.stage.startsWith('push') ? 'push' : 'telegram');
    const parents: Partial<Record<BotStage, BotStage>> = { addresses: 'menu', settings: 'menu', telegram: 'settings', push: 'settings', timing: 'settings', tools: 'menu', account: 'tools', help: 'menu', location: 'addresses', location_manage: 'location', location_order: 'location_manage', location_notifications: 'location', location_telegram: 'location_notifications', location_push: 'location_notifications', location_tools: 'location', rename: 'location_manage', delete_confirm: 'location_manage', report: 'location_tools', reminder_time: 'timing', minimum_duration: 'timing', quiet_hours: 'timing', briefing_time: 'timing', manual_group: 'help', reset_confirm: 'account' };
    return parents[state.stage] || 'home';
  };
  const renderStage = (stage: BotStage) => {
    if (stage === 'home') renderHome();
    else if (stage === 'menu') renderMenu();
    else if (stage === 'addresses') renderAddresses();
    else if (['settings', 'telegram', 'push', 'timing'].includes(stage)) renderSettings(stage);
    else if (['location', 'location_manage', 'location_order', 'location_notifications', 'location_telegram', 'location_push', 'location_tools'].includes(stage)) renderLocation(stage);
    else if (stage === 'tools' || stage === 'account') renderTools(stage);
    else if (addressWizardStages.includes(stage)) renderWizard(stage);
    else if (leadStages.includes(stage)) {
      const target = typeof state.policyAddressId === 'string' ? state.profile.locations.find(l => l.address.id === state.policyAddressId) : undefined;
      if (state.policyAddressId === undefined || (state.policyAddressId !== null && !target)) { state.policyAddressId = null; message(NOTIFICATION_COPY.missingAddress); renderHome(); }
      else { state.stage = stage; message(NOTIFICATION_COPY.edgePrompt(stage.startsWith('push') ? 'push' : 'telegram', stage.endsWith('off_time') ? 'starts' : 'ends', target?.address.label), wizardNav()); }
    } else {
      const prompts: Partial<Record<BotStage, string>> = { rename: BOT_COPY.engineText112, reminder_time: BOT_COPY.engineText077, quiet_hours: BOT_COPY.engineText079, briefing_time: BOT_COPY.engineText081, minimum_duration: BOT_COPY.engineText083 };
      if (prompts[stage]) { state.stage = stage; message(prompts[stage]!, wizardNav()); }
      else handleCommand(stage === 'help' ? '/help' : stage === 'manual_group' ? '/queue' : stage === 'report' ? '/report' : stage === 'delete_confirm' ? '/location_manage' : stage === 'reset_confirm' ? '/account' : '/start');
    }
  };
  const handleCommand = (raw: string) => {
    const [head, ...args] = raw.trim().split(/\s+/); const cmd = head.toLowerCase().split('@')[0];
    const leadCommands: Record<string, [BotStage, NotificationChannel, ReminderEdge, boolean]> = {
      '/before_off': ['reminder_off_time', 'telegram', 'starts', false], '/before_on': ['reminder_on_time', 'telegram', 'ends', false],
      '/push_before_off': ['push_off_time', 'push', 'starts', false], '/push_before_on': ['push_on_time', 'push', 'ends', false],
      '/address_before_off': ['reminder_off_time', 'telegram', 'starts', true], '/address_before_on': ['reminder_on_time', 'telegram', 'ends', true],
      '/address_push_before_off': ['push_off_time', 'push', 'starts', true], '/address_push_before_on': ['push_on_time', 'push', 'ends', true],
    };
    if (leadCommands[cmd]) {
      const [stage, channel, edge, local] = leadCommands[cmd], target = local ? location() : undefined;
      if (local && !target) { message(NOTIFICATION_COPY.missingAddress, navigation()); return; }
      state.stage = stage; state.policyAddressId = target?.address.id ?? null;
      state.returnStage = local ? (channel === 'push' ? 'location_push' : 'location_telegram') : channel;
      message(NOTIFICATION_COPY.edgePrompt(channel, edge, target?.address.label), wizardNav()); return;
    }
    if (['/push_on', '/push_off', '/push_reminders_on', '/push_reminders_off', '/telegram_reminders_on', '/telegram_reminders_off'].includes(cmd)) {
      const prefs = state.profile.preferences;
      const policy = prefs.notificationPolicy ? parseNotificationPolicy(prefs.notificationPolicy) : defaultNotificationPolicy(prefs);
      const channel = cmd.startsWith('/telegram') ? 'telegram' : 'push';
      if (cmd.includes('reminders')) policy.channels[channel].remindersEnabled = cmd.endsWith('_on');
      else policy.channels[channel].enabled = cmd.endsWith('_on');
      prefs.notificationPolicy = policy; mutate(); message(NOTIFICATION_COPY.saved); renderSettings(channel); return;
    }
    if (cmd === '/address_push_on' || cmd === '/address_push_off') {
      const target = location();
      if (!target) { message(NOTIFICATION_COPY.missingAddress, navigation()); return; }
      target.notificationPolicy = target.notificationPolicy ? parseLocationNotificationPolicy(target.notificationPolicy) : {
        version: 'lba-notification-policy/1', channels: { telegram: { enabled: target.notifications }, push: { enabled: false } },
      };
      target.notificationPolicy.channels.push.enabled = cmd.endsWith('_on');
      mutate(); message(NOTIFICATION_COPY.localSaved); renderLocation('location_push'); return;
    }
    if (cmd === '/start' && args.length && /^(link_|weblogin_|addr_)/.test(args[0])) {
      action('resolve_legacy_link', { value: args[0].split('_')[0], reason: 'Resolve opaque legacy payload in trusted auth adapter; never auto-merge accounts.' });
      message(BOT_COPY.engineText069, [commandButton(BOT_COPY.engineText070, '/start')]); return;
    }
    switch (cmd) {
      case '/start': renderHome(true); break;
      case '/menu': renderMenu(); break;
      case '/tools': renderTools(); break;
      case '/account': renderTools('account'); break;
      case '/telegram': case '/push': case '/timing': renderSettings(cmd.slice(1) as BotStage); break;
      case '/location_manage': case '/location_order': case '/location_notifications': case '/location_telegram': case '/location_push': case '/location_tools': renderLocation(cmd.slice(1) as BotStage); break;
      case '/help': state.stage = 'help'; message(COPY.help, [commandButton('Обрати чергу вручну', '/queue'), commandButton('Про сервіс', '/about'), commandButton('Профіль і доступ', '/account'), commandButton('Назад', '/back')]); break;
      case '/about': message(COPY.about, navigation()); break;
      case '/app': action('open_app', { value: 'home' }); message(COPY.appIntent, navigation()); break;
      case '/digest': case '/history': action('open_app', { value: 'history' }); message(COPY.historyUnavailable, navigation()); break;
      case '/schedule': case '/now': case '/full': showSchedule(); break;
      case '/addresses': renderAddresses(); break;
      case '/add': beginAddress(); break;
      case '/settings': renderSettings(); break;
      case '/discard_draft': state.draft = null; message('Чернетку адреси відкинуто. Збережені адреси залишилися без змін.'); renderHome(); break;
      case '/draft': if (state.draft) renderWizard(); else message(BOT_COPY.engineText071, navigation()); break;
      case '/cancel': {
        const parent = parentStage();
        if (addressWizardStages.includes(state.stage)) { message('Додавання або зміну адреси зупинено. Чернетку збережено для продовження.'); renderHome(); }
        else { state.policyAddressId = null; message(COPY.cancelled); renderStage(parent); }
        break;
      }
      case '/back': {
        if (state.draft && addressWizardStages.includes(state.stage)) {
          if(isV2()){
            const d=state.draft.providerV2!;clearV2Confirmation();state.catalogPage=0;
            if(state.stage==='provider_locality'){
              for(const k of ['providerV2','locality','localityId','territoryId','street','streetIdentity','streetQuery','house'] as const)delete state.draft[k];renderWizard('locality');
            }else if(state.stage==='street'){
              state.draft.providerV2={directoryId:'dtek:oem',...(d.localityQuery?{localityQuery:d.localityQuery}:{})};
              for(const k of ['locality','localityId','street','streetIdentity','house'] as const)delete state.draft[k];renderWizard('provider_locality');
            }else if(state.stage==='house'||state.stage==='street_choice'){
              for(const k of ['streetKey','houseQuery','houseSnapshotId','houseKey'] as const)delete d[k];
              for(const k of ['street','streetIdentity','house'] as const)delete state.draft[k];renderWizard('street');
            }else{
              delete d.houseSnapshotId;delete d.houseKey;delete state.draft.house;renderWizard('house');
            }break;
          }
          const earlier: Partial<Record<BotStage, BotStage>> = { address_confirm: 'house', connection: 'house', house: 'street', street_choice: 'street', street: 'locality' };
          if (earlier[state.stage]) renderWizard(earlier[state.stage]); else renderHome();
        } else { const parent = parentStage(); state.policyAddressId = null; renderStage(parent); }
        break;
      }
      case '/pause': case '/stop': state.profile.preferences.paused = true; mutate(); action('cancel_pending_delivery', { reason: 'profile_paused' }); message(COPY.paused, [commandButton(BOT_COPY.engineText072, '/resume'), commandButton(BOT_COPY.engineText073, '/schedule')]); break;
      case '/resume': state.profile.preferences.paused = false; mutate(); message(state.profile.preferences.optedIn ? COPY.resumed : BOT_COPY.engineText074, navigation()); break;
      case '/notifications_off': state.profile.preferences.optedIn = false; mutate(); action('cancel_pending_delivery', { reason: 'opt_out' }); message(NOTIFICATION_COPY.telegramOff); renderSettings('telegram'); break;
      case '/notifications_on': {
        const verified = state.profile.locations.filter(l => l.binding.status === 'verified' && l.binding.kind !== 'user_selected_group');
        if (!verified.length && !state.profile.preferences.notificationPolicy) message(COPY.needVerified, [commandButton(BOT_COPY.engineText075, '/addresses')]);
        else { state.profile.preferences.optedIn = true; mutate(); message(COPY.globalNotificationsEnabled); renderSettings('telegram'); }
        break;
      }
      case '/reminders': state.policyAddressId = null; state.stage = 'reminder_time'; message(BOT_COPY.engineText077, wizardNav()); break;
      case '/quiet': state.stage = 'quiet_hours'; message(BOT_COPY.engineText079, wizardNav()); break;
      case '/briefing': state.stage = 'briefing_time'; message(BOT_COPY.engineText081, wizardNav()); break;
      case '/minimum': state.stage = 'minimum_duration'; message(BOT_COPY.engineText083, wizardNav()); break;
      case '/queue': {
        state.stage = 'manual_group'; const groups = context.manualGroups || [], page = boundedPage(state.catalogPage, groups.length); state.catalogPage = page;
        const groupText = groups.length ? BOT_COPY.engineText085 : 'Зараз немає доступних груп графіка. Спробуйте пізніше.';
        message(`${groupText}${groups.length > ADDRESS_PAGE_SIZE ? `\nСторінка ${page + 1} з ${Math.ceil(groups.length / ADDRESS_PAGE_SIZE)}.` : ''}`, [...groups.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(g => button(`${g.locality} · ${g.label}`, { kind: 'manual_group', value: g.id })), ...pageButtons('manual_group', page, groups.length), commandButton(BOT_COPY.engineText086, state.draft?.operation==='add'?'/draft':'/add'), commandButton('Назад', '/back')]); break;
      }
      case '/share': { const l = location(); if (l) { action('prepare_share', { addressId: l.address.id }); message(BOT_COPY.engineText088, navigation()); } else renderAddresses(); break; }
      case '/compare': action('open_app', { value: 'compare' }); message(BOT_COPY.engineText089, navigation()); break;
      case '/report': { if (!location()) renderAddresses(); else { state.stage = 'report'; message(BOT_COPY.engineText090, [button(BOT_COPY.engineText091, { kind: 'power_report', value: 'on' }), button(BOT_COPY.engineText092, { kind: 'power_report', value: 'off' }), commandButton(BOT_COPY.engineText093, '/back')]); } break; }
      case '/migration': {
        const status = context.migration?.status;
        message(status === 'complete' ? BOT_COPY.engineText094 : status === 'in_progress' ? BOT_COPY.engineText095 : status === 'failed' ? BOT_COPY.engineText096 : BOT_COPY.engineText097, [commandButton(BOT_COPY.engineText098, '/addresses')]); break;
      }
      case '/reset': state.stage = 'reset_confirm'; message(BOT_COPY.engineText099, [button(BOT_COPY.engineText100, { kind: 'confirm_reset' }), commandButton(BOT_COPY.engineText101, '/start')]); break;
      default: message(BOT_COPY.engineText102, navigation());
    }
  };

  if (callbackFailure) {
    message(callbackFailureText, [], 'error');
    renderStage(state.stage);
  } else if (callback) {
    const catalogAction=['locality','street','provider_street','provider_house','place','house_suggestion','connection','confirm_address'].includes(callback.kind)||callback.kind==='page'&&['locality','street','connection','provider_street','provider_house'].includes(callback.scope);
    const providerLocalityNavigation=directories().length+directoriesV2().length>0&&(callback.kind==='locality'&&callback.value.startsWith('provider:')||callback.kind==='page'&&callback.scope==='locality');
    if(catalogAction&&catalogUnavailable()&&!providerLocalityNavigation)showCatalogUnavailable();
    else
    switch (callback.kind) {
      case 'command': handleCommand(callback.value); break;
      case 'page': {
        if (callback.scope === 'addresses') { state.addressPage = callback.value; renderAddresses(); }
        else { state.catalogPage = callback.value; if (callback.scope === 'manual_group') handleCommand('/queue'); else if(callback.scope==='provider_street')renderProviderStreets();else if(callback.scope==='provider_house')renderProviderHouses();else if (callback.scope === 'street') renderStreetMatches(); else if (callback.scope === 'connection') renderConnections(); else renderWizard('locality'); }
        break;
      }
      case 'provider_v2_directory':{
        if(!state.draft||callback.value!=='dtek:oem'||!directoriesV2().length){message(COPY.unavailableAction,wizardNav());break;}
        for(const k of ['locality','localityId','street','streetIdentity','streetQuery','house','providerDirectoryId','providerStreetId','providerStreetSnapshotId','providerHouseSnapshotId'] as const)delete state.draft[k];
        clearV2Confirmation();state.draft.territoryId='source:dtek:oem';state.draft.providerV2={directoryId:'dtek:oem'};state.catalogPage=0;renderWizard('provider_locality');break;
      }
      case 'provider_v2_city':{
        const t=readProviderV2Tuple(callback.kind,callback.value),s=v2Snapshot('localities'),d=state.draft?.providerV2;
        if(state.stage!=='provider_locality'||!d||!s||!t||t.length!==2||t[0]!==s.id||!providerV2PageItems(state,s.items).some(v=>v.key===t[1])){v2Repair('localities');break;}
        state.draft!.providerV2={directoryId:'dtek:oem',localityQuery:d.localityQuery,catalogSnapshotId:s.id,cityKey:t[1] as string};
        state.draft!.locality=t[1] as string;state.draft!.territoryId='source:dtek:oem';
        for(const k of ['localityId','street','streetIdentity','house'] as const)delete state.draft![k];clearV2Confirmation();state.catalogPage=0;renderWizard('street');break;
      }
      case 'provider_v2_street':{
        const t=readProviderV2Tuple(callback.kind,callback.value),s=v2Snapshot('streets'),d=state.draft?.providerV2;
        if(state.stage!=='street_choice'||!d||!s||!t||t.length!==3||t[0]!==s.catalogSnapshotId||t[1]!==s.cityKey||!providerV2PageItems(state,s.items).some(v=>v.key===t[2])){v2Repair('streets');break;}
        d.streetKey=t[2] as string;for(const k of ['houseQuery','houseSnapshotId','houseKey'] as const)delete d[k];
        state.draft!.street=d.streetKey;delete state.draft!.streetIdentity;delete state.draft!.house;clearV2Confirmation();state.catalogPage=0;renderWizard('house');break;
      }
      case 'provider_v2_house':{
        const t=readProviderV2Tuple(callback.kind,callback.value),s=v2Snapshot('houses'),d=state.draft?.providerV2;
        if(state.stage!=='house'||!d||!s||!t||t.length!==5||t[0]!==s.catalogSnapshotId||t[1]!==s.id||t[2]!==s.cityKey||t[3]!==s.streetKey||!providerV2PageItems(state,s.items).some(v=>v.key===t[4])){v2Repair('houses');break;}
        d.houseSnapshotId=s.id;d.houseKey=t[4] as string;state.draft!.house=d.houseKey;clearV2Confirmation();chooseV2House();break;
      }
      case 'provider_v2_group':case 'provider_v2_unknown_group':{
        const t=readProviderV2Tuple(callback.kind,callback.value),house=v2HouseTuple(),options=v2Options();
        if(state.stage!=='connection'||!t||!house||!house.every((v,i)=>v===t[i])||!options.length){v2Repair('houses');break;}
        if(callback.kind==='provider_v2_unknown_group'){
          clearV2Confirmation();draftStage('connection');message('Не обираємо групу навмання. Уточніть її у вашого оператора. Адресу ще не збережено, а чинні адреси та сповіщення не змінено.',[commandButton('Повернутися до груп','/draft'),...wizardNav()]);break;
        }
        const option=providerV2PageItems(state,options).find(o=>o.id===t[5]&&addressOptionFingerprint(o)===t[6]);if(option)confirmOption(option);else v2Repair('houses');break;
      }
      case 'provider_v2_page':case 'provider_v2_batch':{
        const t=readProviderV2Tuple(callback.kind,callback.value);if(!t||t.length!==8){message(COPY.unavailableAction,wizardNav());break;}
        const level=t[0] as BotProviderSnapshotV2['level'],s=v2Snapshot(level),query=state.draft?.providerV2?.[level==='localities'?'localityQuery':level==='streets'?'streetQuery':'houseQuery'];
        const stage=level==='localities'?'provider_locality':level==='streets'?'street_choice':'house';
        const matches=Boolean(state.stage===stage&&s&&query===t[5]&&(s.cityKey??null)===t[3]&&(s.streetKey??null)===t[4]&&(level==='localities'||s.catalogSnapshotId===t[2]));
        if(!matches||!s||callback.kind==='provider_v2_page'&&(s.id!==t[1]||s.offset!==t[6]||Math.abs((t[7] as number)-(state.catalogPage??0))!==1||(t[7] as number)*ADDRESS_PAGE_SIZE>=Math.max(1,s.items.length))||callback.kind==='provider_v2_batch'&&(s.offset!==t[7]||(t[7] as number)>(t[6] as number)&&(state.catalogPage??0)!==9||(t[7] as number)<(t[6] as number)&&(state.catalogPage??0)!==0)){v2Repair(level);break;}
        state.catalogPage=callback.kind==='provider_v2_page'?t[7] as number:(t[7] as number)<(t[6] as number)?Math.max(0,Math.ceil(s.items.length/ADDRESS_PAGE_SIZE)-1):0;renderV2(level);break;
      }
      case 'provider_v2_retry':{
        const t=readProviderV2Tuple(callback.kind,callback.value),d=state.draft?.providerV2;
        if(!t||!d||t.length!==5){message(COPY.unavailableAction,wizardNav());break;}const level=t[0] as BotProviderSnapshotV2['level'];
        const expectedStage=level==='localities'?'provider_locality':level==='streets'?'street_choice':'house';
        if(state.stage!==expectedStage||t[4]!==d[level==='localities'?'localityQuery':level==='streets'?'streetQuery':'houseQuery']||level!=='localities'&&(t[1]!==d.catalogSnapshotId||t[2]!==d.cityKey)||level==='houses'&&t[3]!==d.streetKey){v2Repair(level);break;}
        clearV2Confirmation();state.catalogPage=0;renderV2(level);break;
      }
      case 'locality': {
        if(callback.value.startsWith('provider:')){
          const d=directories().find(d=>'provider:'+d.id===callback.value);
          if(!d||!state.draft){message(COPY.unavailableAction,wizardNav());break;}
          state.draft.locality=d.locality;state.draft.localityId=d.localityId;state.draft.territoryId=d.territoryId;state.draft.providerDirectoryId=d.id;
          delete state.draft.providerV2;
          for(const key of ['street','streetIdentity','streetQuery','house','optionId','bindingRevision','selectionFingerprint','providerStreetId','providerStreetSnapshotId','providerHouseSnapshotId'] as const)delete state.draft[key];
          state.catalogPage=0;renderWizard('street');break;
        }
        const option = context.addresses.find(o => localityKey(o) === callback.value);
        if (!option || !state.draft) { message(COPY.unavailableAction, wizardNav()); break; }
        state.draft.locality = option.address.locality; state.draft.territoryId = option.address.territoryId;
        state.draft.localityId=option.address.localityId;
        delete state.draft.providerV2;
        for(const key of ['street','streetIdentity','streetQuery','house','optionId','bindingRevision','selectionFingerprint','providerDirectoryId','providerStreetId','providerStreetSnapshotId','providerHouseSnapshotId'] as const)delete state.draft[key];
        state.catalogPage = 0;
        renderWizard('street'); break;
      }
      case 'provider_street':{
        const d=providerDirectory(),s=context.providerStreets;let tuple:unknown;
        try{tuple=providerText(callback.value,512)?JSON.parse(callback.value):null;}catch{tuple=null;}
        if(!d||!state.draft||!s||s.directoryId!==d.id||s.state!=='available'||!providerFresh(s.expiresAt)||!providerText(s.snapshotId,128)||!providerText(s.query,100)||
          !Array.isArray(tuple)||tuple.length!==2||tuple[0]!==s.snapshotId||!providerId(tuple[1])||!Array.isArray(s.items)||s.items.length>1000||
          s.items.some(r=>!r||!providerId(r.id)||!providerText(r.value))||new Set(s.items.map(r=>r.id)).size!==s.items.length){providerRepair('street',s?.state==='available'?'stale':s?.state);break;}
        const row=s.items.find(r=>r.id===tuple[1]);
        if(!row||s.items.filter(r=>streetKey(r.value)===streetKey(row.value)).length!==1||normalizeAddressText(s.query)!==normalizeAddressText(state.draft.streetQuery||'')||!streetMatchesQuery(row.value,state.draft.streetQuery||'')){providerRepair('street');break;}
        state.draft.street=row.value;state.draft.providerStreetId=row.id;state.draft.providerStreetSnapshotId=s.snapshotId;
        state.draft.streetIdentity=JSON.stringify([JSON.stringify([d.territoryId,['id',d.localityId]]),['id',`source:${d.namespace}:street:${row.id}`]]);
        for(const key of ['house','optionId','bindingRevision','selectionFingerprint','providerHouseSnapshotId'] as const)delete state.draft[key];
        state.catalogPage=0;draftStage('house');message(`${row.value}\n${COPY.house}`,wizardNav());break;
      }
      case 'provider_house':{
        const h=providerHouseContext();let tuple:unknown;
        try{tuple=providerText(callback.value,512)?JSON.parse(callback.value):null;}catch{tuple=null;}
        if(!state.draft||!h||!Array.isArray(tuple)||tuple.length!==4||tuple[0]!==h.streetSnapshotId||tuple[1]!==h.houseSnapshotId||tuple[2]!==h.streetId||!providerId(tuple[3])){providerRepair('house',context.providerHouses?.state==='available'?'stale':context.providerHouses?.state);break;}
        const row=h.items.find(r=>r.id===tuple[3]);
        if(!row||h.items.filter(r=>normalizeHouse(r.value)===normalizeHouse(row.value)).length!==1){providerRepair('house');break;}
        state.draft.house=row.value;state.draft.providerHouseSnapshotId=h.houseSnapshotId;
        const options=context.addresses.filter(o=>o.id===row.optionId&&providerOptionMatches(o));
        if(options.length===1)confirmOption(options[0]);else providerRepair('house');break;
      }
      case 'street': {
        if (!state.draft) { renderHome(); break; }
        const option = scopedOptions().find(o => o.id === callback.value);
        if (!option) { message(COPY.noStreet, wizardNav()); break; }
        state.draft.street = option.address.street;state.draft.streetIdentity=addressStreetKey(option.address);
        for(const key of ['house','optionId','bindingRevision','selectionFingerprint'] as const)delete state.draft[key];state.catalogPage = 0;
        draftStage('house');
        const alias = state.draft.streetQuery && streetKey(state.draft.streetQuery) !== streetKey(option.address.street);
        message(`${alias ? BOT_COPY.engineText103(option.address.street) : ''}${COPY.house}`, wizardNav()); break;
      }
      case 'place': {
        const option=scopedOptions().find(o=>o.id===callback.value&&o.address.placeNames?.some(name=>placeNameMatchesQuery(name,state.draft?.streetQuery||'')));
        if(!state.draft||!option){message(COPY.noStreet,wizardNav());break;}
        state.draft.street=option.address.street;state.draft.streetIdentity=addressStreetKey(option.address);state.draft.house=option.address.house.literal;
        const supplies=streetOptions().filter(o=>houseMatchesQuery(o.address.house.literal,state.draft!.house!));
        if(supplies.length>1){state.catalogPage=0;renderConnections();}else confirmOption(option);
        break;
      }
      case 'house_suggestion': {
        const option=streetOptions().find(o=>o.id===callback.value&&houseLookalikeSuggestion(o.address.house.literal,state.draft?.house||''));
        if(!state.draft||!option){message(COPY.noHouse,wizardNav());break;}
        state.draft.house=option.address.house.literal;
        const supplies=streetOptions().filter(o=>houseMatchesQuery(o.address.house.literal,state.draft!.house!));
        if(supplies.length>1){state.catalogPage=0;renderConnections();}else confirmOption(option);
        break;
      }
      case 'connection': { const option = streetOptions().find(o => o.id === callback.value&&draftMatches(o)); if (option) confirmOption(option); else message(COPY.noHouse, wizardNav()); break; }
      case 'confirm_address': {
        const draft = state.draft;
        const option = context.addresses.find(o => o.id === draft?.optionId);
        if (!draft || !option || isV2()&&state.stage!=='address_confirm'||!draftMatches(option) || draft.bindingRevision !== option.binding.revisionId || draft.selectionFingerprint!==addressOptionFingerprint(option)) { message('Дані адреси змінилися. Перевірте будинок, оператора й підключення та підтвердьте вибір ще раз.', wizardNav()); if(isV2())clearV2Confirmation();if (state.draft) draftStage('house'); break; }
        const duplicate = state.profile.locations.find(l => l.address.id === option.address.id && l.address.id !== draft.originalAddressId);
        if (duplicate) { state.currentAddressId = duplicate.address.id; state.draft = null; message(BOT_COPY.engineText105); renderLocation(); break; }
        if (draft.operation === 'add' && state.profile.locations.length >= addressLimit) { message(BOT_COPY.engineText062(addressLimit)); renderAddresses(); break; }
        const address: AddressRecord = { ...clone(option.address), label: draft.label || (state.profile.locations.length ? BOT_COPY.engineText106(state.profile.locations.length + 1) : BOT_COPY.engineText107) };
        const next: BotLocation = { address, binding: confirmedAddressBinding(option.binding), notifications: false, paused: false };
        if (draft.operation === 'edit') {
          const index = state.profile.locations.findIndex(l => l.address.id === draft.originalAddressId);
          if (index < 0) { message(COPY.unavailableAction, navigation()); break; }
          const wasPrimary = state.profile.primaryAddressId === draft.originalAddressId;
          const old=state.profile.locations[index];
          const sameBinding=old.address.id===address.id&&option.binding.status==='verified'&&['building','connection','operator_group'].includes(option.binding.kind)&&
            (['addressId','operatorId','namespace','targetId','kind','revisionId','status','verifiedAt','effectiveFrom','effectiveUntil'] as const).every(key=>old.binding[key]===option.binding[key]);
          next.paused=old.paused;next.notifications=sameBinding?old.notifications:false;
          if(old.notificationPolicy){next.notificationPolicy=parseLocationNotificationPolicy(old.notificationPolicy);if(!sameBinding)for(const channel of ['telegram','push'] as const)next.notificationPolicy.channels[channel].enabled=false;}
          state.profile.locations[index] = next;
          if (wasPrimary) state.profile.primaryAddressId = address.id;
          action('cancel_pending_delivery', { addressId: draft.originalAddressId, reason: 'binding_changed' });
        } else state.profile.locations.push(next);
        state.currentAddressId = address.id;
        if (!state.profile.primaryAddressId) state.profile.primaryAddressId = address.id;
        state.draft = null; mutate();
        if (next.binding.status === 'verified' && next.binding.kind !== 'user_selected_group') {
          state.stage = 'subscription'; message(COPY.saved, [button(BOT_COPY.engineText108, { kind: 'subscription', value: 'on' }), button(BOT_COPY.engineText109, { kind: 'subscription', value: 'off' })]);
        } else { message(draft.providerDirectoryId||draft.providerV2?'Адресу збережено. Можна переглянути план обраної групи. Відповідність будинку ще потребує перевірки; автоматичні сповіщення вимкнені.':COPY.savedUnverified, navigation()); state.stage = 'home'; }
        break;
      }
      case 'subscription': {
        const l = location();
        if (callback.value === 'on' && l && l.binding.status === 'verified' && l.binding.kind !== 'user_selected_group') {
          l.notifications = true;
          if (!hasTypedPolicy()) state.profile.preferences.optedIn = true;
          mutate(); message(NOTIFICATION_COPY.localSaved, navigation());
        } else { if (l) { l.notifications = false; mutate(); } message(callback.value === 'on' ? COPY.needVerified : BOT_COPY.engineText111, navigation()); }
        state.stage = 'home'; break;
      }
      case 'location': state.currentAddressId = callback.value; renderLocation(); break;
      case 'location_action': {
        const l = location(); if (!l) { renderAddresses(); break; }
        if (callback.value === 'rename') { state.stage = 'rename'; message(BOT_COPY.engineText112, wizardNav()); }
        else if (callback.value === 'edit') beginAddress(true);
        else if (callback.value === 'primary') { state.profile.primaryAddressId = l.address.id; mutate(); message(BOT_COPY.engineText114); renderLocation('location_order'); }
        else if (callback.value === 'up' || callback.value === 'down') {
          const index = state.profile.locations.indexOf(l), nextIndex = index + (callback.value === 'up' ? -1 : 1);
          if (nextIndex >= 0 && nextIndex < state.profile.locations.length) { [state.profile.locations[index], state.profile.locations[nextIndex]] = [state.profile.locations[nextIndex], state.profile.locations[index]]; mutate(); }
          renderLocation('location_order');
        } else if (callback.value === 'pause') { l.paused = !l.paused; mutate(); if (l.paused) action('cancel_pending_delivery', { addressId: l.address.id, reason: 'address_paused' }); message(l.paused ? BOT_COPY.engineText115 : BOT_COPY.engineText116); renderLocation('location_notifications'); }
        else if (callback.value === 'notifications') {
          if (!hasTypedPolicy() && !l.notifications && (l.binding.status !== 'verified' || l.binding.kind === 'user_selected_group')) message(COPY.needVerified);
          else {
            l.notifications = !l.notifications;
            if (l.notifications && !hasTypedPolicy()) state.profile.preferences.optedIn = true;
            if (!l.notifications) action('cancel_pending_delivery', { addressId: l.address.id, reason: 'address_opt_out' });
            mutate(); message(NOTIFICATION_COPY.localSaved);
          }
          renderLocation('location_telegram');
        }
        else if (callback.value === 'delete') { state.stage = 'delete_confirm'; message(BOT_COPY.engineText117(l.address.label), [button(BOT_COPY.engineText118, { kind: 'confirm_delete' }), commandButton(BOT_COPY.engineText119, '/back'), commandButton('Скасувати', '/cancel')]); }
        else if (callback.value === 'share') handleCommand('/share');
        else handleCommand('/report');
        break;
      }
      case 'confirm_delete': {
        const id = state.currentAddressId;
        if (!id || !location()) { renderAddresses(); break; }
        state.profile.locations = state.profile.locations.filter(l => l.address.id !== id);
        if (state.profile.primaryAddressId === id) state.profile.primaryAddressId = state.profile.locations[0]?.address.id || null;
        state.currentAddressId = state.profile.primaryAddressId;
        action('cancel_pending_delivery', { addressId: id, reason: 'address_deleted' }); mutate();
        message(BOT_COPY.engineText120); renderAddresses(); break;
      }
      case 'manual_group': {
        const group = context.manualGroups?.find(g => g.id === callback.value);
        if (!group) { message(COPY.unavailableAction, navigation()); break; }
        const id = `manual:${encodeURIComponent(JSON.stringify([group.operatorId, group.namespace, group.targetId]))}`;
        if (!state.profile.locations.some(l => l.address.id === id)) {
          if (state.profile.locations.length >= addressLimit) { message(BOT_COPY.engineText121, navigation()); break; }
          state.profile.locations.push({ address: { id, label: BOT_COPY.engineText122(group.label), territoryId: group.namespace,
            locality: group.locality, street: '', house: { number: '', literal: '' }, aliases: [] },
          binding: { addressId: id, operatorId: group.operatorId, namespace: group.namespace, targetId: group.targetId,
            kind: 'user_selected_group', revisionId: group.revisionId, status: 'needs_confirmation', verifiedAt: null, effectiveFrom: null, effectiveUntil: null }, notifications: false, paused: false });
          if (!state.profile.primaryAddressId) state.profile.primaryAddressId = id;
          mutate();
        }
        state.currentAddressId = id; state.stage = 'home';
        message(BOT_COPY.engineText123, navigation()); break;
      }
      case 'confirm_reset': state.profile = createBotState({ ownerId: state.ownerId }).profile; state.currentAddressId = null; state.draft = null; mutate(); action('cancel_pending_delivery', { reason: 'profile_reset' }); message(BOT_COPY.engineText124, [commandButton(BOT_COPY.engineText125, '/add')]); state.stage = 'home'; break;
      case 'power_report': {
        const l = location(); if (!l) { renderAddresses(); break; }
        action('record_power_report', { addressId: l.address.id, value: callback.value });
        message(BOT_COPY.engineText126, navigation()); state.stage = 'home'; break;
      }
    }
  } else {
    const text = input.kind === 'callback' ? '' : input.text.trim();
    const typedNavigation: Record<string, string> = { 'назад': '/back', 'скасувати': '/cancel' };
    if (typedNavigation[textKey(text)]) handleCommand(typedNavigation[textKey(text)]);
    else if (text.startsWith('/')) handleCommand(text);
    else if(addressWizardStages.includes(state.stage)&&catalogUnavailable()&&!(state.stage==='locality'&&(directories().length||directoriesV2().length)))showCatalogUnavailable();
    else if(textKey(text)===BOT_COPY.engineText141&&state.draft&&state.profile.preferences.paused) message(BOT_COPY.engineText142,[commandButton(BOT_COPY.engineText143,'/draft'),commandButton(BOT_COPY.engineText144,'/resume')]);
    else if(isV2()&&state.draft&&addressWizardStages.includes(state.stage)){
      const d=state.draft.providerV2!,rawText=input.kind==='text'?input.text:text;
      if(state.stage==='connection'){renderConnections();}
      else if(state.stage==='address_confirm'){message('Перевірте адресу й групу та натисніть «Зберегти адресу». Для виправлення оберіть «Назад».');renderWizard('address_confirm');}
      else if(!v2Text(rawText,100)||normalizeAddressText(rawText).length<(state.stage==='house'?1:2))message(state.stage==='house'?'Введіть короткий номер будинку, за потреби — з літерою або корпусом.':'Введіть щонайменше дві літери назви без зайвих символів.',wizardNav());
      else if(state.stage==='provider_locality'){
        state.draft.providerV2={directoryId:'dtek:oem',localityQuery:rawText};
        for(const k of ['locality','localityId','street','streetIdentity','house'] as const)delete state.draft[k];clearV2Confirmation();state.catalogPage=0;renderV2('localities');
      }else if(state.stage==='street'||state.stage==='street_choice'){
        d.streetQuery=rawText;for(const k of ['streetKey','houseQuery','houseSnapshotId','houseKey'] as const)delete d[k];
        for(const k of ['street','streetIdentity','house'] as const)delete state.draft[k];clearV2Confirmation();state.catalogPage=0;renderV2('streets');
      }else if(state.stage==='house'){
        d.houseQuery=rawText;delete d.houseSnapshotId;delete d.houseKey;delete state.draft.house;clearV2Confirmation();state.catalogPage=0;renderV2('houses');
      }
    }
    else if (addressWizardStages.includes(state.stage)&&state.draft&&(()=>{try{normalizeAddressText(text);return false;}catch{return true;}})()) {
      message('Не вдалося прочитати назву або номер. Введіть короткий звичайний текст без зайвих символів. Чернетку збережено.',wizardNav());
    }
    else if(state.stage==='locality'){
      if(!state.draft)renderHome();else{state.draft.localityQuery=text;state.catalogPage=0;renderWizard('locality');}
    }
    else if (state.stage === 'street' || state.stage === 'street_choice') {
      if (!state.draft) renderHome();
      else if (parseStreetName(text).name.length < 2) message(BOT_COPY.engineText127, wizardNav());
      else {
        state.draft.streetQuery = text;
        if(providerDirectory())for(const key of ['street','streetIdentity','house','optionId','bindingRevision','selectionFingerprint','providerStreetId','providerStreetSnapshotId','providerHouseSnapshotId'] as const)delete state.draft[key];
        state.catalogPage = 0; renderStreetMatches();
      }
    } else if (state.stage === 'house' || state.stage === 'connection') {
      if (!state.draft) renderHome();
      else {
        state.draft.house = text;
        if(providerDirectory()){
          for(const key of ['optionId','bindingRevision','selectionFingerprint','providerHouseSnapshotId'] as const)delete state.draft[key];
          const h=providerHouseContext();
          let confirmedProviderHouse=false;
          if(h&&normalizeHouse(h.query)===normalizeHouse(text)){
            state.draft.providerHouseSnapshotId=h.houseSnapshotId;
            const rows=h.items.filter(r=>houseMatchesQuery(r.value,text));
            const options=rows.length===1?context.addresses.filter(o=>o.id===rows[0].optionId&&providerOptionMatches(o)):[];
            if(options.length===1){confirmOption(options[0]);confirmedProviderHouse=true;}
          }
          if(!confirmedProviderHouse){state.catalogPage=0;renderProviderHouses(text);}
        }else{
        const matches = streetOptions().filter(o => houseMatchesQuery(o.address.house.literal,text));
        if (matches.length === 1) confirmOption(matches[0]);
        else if (matches.length > 1) { state.catalogPage = 0; renderConnections(); }
        else {
          const suggestions=streetOptions().filter(o=>houseLookalikeSuggestion(o.address.house.literal,text));
          const unique=suggestions.filter((o,i,all)=>all.findIndex(other=>other.address.house.literal===o.address.house.literal)===i).slice(0,ADDRESS_PAGE_SIZE);
          message(unique.length?'Можливо, у номері використано схожі латинські й українські літери. Оберіть потрібний запис і перевірте адресу перед збереженням.':COPY.noHouse,
            [...unique.map(o=>button(`${o.address.house.literal} · ${o.address.street}`,{kind:'house_suggestion',value:o.id})),...wizardNav()]);
        }
        }
      }
    } else if(state.stage==='address_confirm'){
      message('Щоб зберегти адресу, перевірте її та натисніть «Зберегти адресу». Для виправлення будинку оберіть «Назад».');
      renderWizard('address_confirm');
    } else if (state.stage === 'rename') {
      const l = location();
      if (!l) renderAddresses();
      else if (!text || text.length > 60 || /[\u0000-\u001f]/.test(text)) message(BOT_COPY.engineText130, wizardNav());
      else { l.address.label = text; mutate(); message(BOT_COPY.engineText132); renderLocation('location_manage'); }
    } else if (['reminder_off_time', 'reminder_on_time', 'push_off_time', 'push_on_time'].includes(state.stage)) {
      const channel: NotificationChannel = state.stage.startsWith('push') ? 'push' : 'telegram';
      const field = state.stage.endsWith('off_time') ? 'beforeOffMinutes' : 'beforeOnMinutes';
      const local = typeof state.policyAddressId === 'string';
      const target = local ? state.profile.locations.find(item => item.address.id === state.policyAddressId) : undefined;
      const inherit = textKey(text) === 'як у каналі';
      if ((state.policyAddressId !== null && !local) || (local && !target)) { state.policyAddressId = null; message(NOTIFICATION_COPY.missingAddress, navigation()); state.stage = 'home'; }
      else if (!(local && inherit) && (!/^\d{1,4}$/.test(text) || Number(text) > 1440)) message(NOTIFICATION_COPY.invalidLead, wizardNav());
      else {
        if (target) {
          target.notificationPolicy = target.notificationPolicy ? parseLocationNotificationPolicy(target.notificationPolicy) : {
            version: 'lba-notification-policy/1', channels: { telegram: { enabled: target.notifications }, push: { enabled: false } },
          };
          if (inherit) delete target.notificationPolicy.channels[channel][field];
          else target.notificationPolicy.channels[channel][field] = Number(text);
        } else {
          const prefs = state.profile.preferences;
          prefs.notificationPolicy = prefs.notificationPolicy ? parseNotificationPolicy(prefs.notificationPolicy) : defaultNotificationPolicy(prefs);
          prefs.notificationPolicy.channels[channel][field] = Number(text);
        }
        const parent = parentStage(); mutate(); state.policyAddressId = null; message(target ? NOTIFICATION_COPY.localSaved : NOTIFICATION_COPY.saved);
        if (target) state.currentAddressId = target.address.id; renderStage(parent);
      }
    } else if (['reminder_time', 'minimum_duration'].includes(state.stage)) {
      const maximum = state.stage === 'minimum_duration' ? 86400 : 1440;
      if (!/^\d{1,5}$/.test(text) || Number(text) > maximum) message(`Введіть ціле число від 0 до ${maximum} хвилин.`, wizardNav());
      else {
        const value = Number(text), prefs = state.profile.preferences;
        if (state.stage === 'reminder_time') {
          prefs.reminders = value > 0; prefs.remindBeforeMinutes = value;
          if (prefs.notificationPolicy) {
            prefs.notificationPolicy = parseNotificationPolicy(prefs.notificationPolicy);
            Object.assign(prefs.notificationPolicy.channels.telegram, { remindersEnabled: value > 0, beforeOffMinutes: value, beforeOnMinutes: value });
          }
        } else prefs.minimumOutageMinutes = value;
        mutate(); renderSettings('timing');
      }
    } else if (state.stage === 'quiet_hours') {
      if (textKey(text) === BOT_COPY.engineText135) { state.profile.preferences.quietHours.enabled = false; mutate(); renderSettings('timing'); }
      else {
        const range = text.replace(/\s/g, '').split(/[–—-]/);
        if (range.length !== 2 || !range.every(validTime) || range[0] === range[1]) message(BOT_COPY.engineText136, wizardNav());
        else { state.profile.preferences.quietHours = { enabled: true, start: range[0], end: range[1], timezone: 'Europe/Kyiv' }; mutate(); renderSettings('timing'); }
      }
    } else if (state.stage === 'briefing_time') {
      if (textKey(text) === BOT_COPY.engineText138) { state.profile.preferences.morningBriefing.enabled = false; mutate(); renderSettings('timing'); }
      else if (!validTime(text)) message(BOT_COPY.engineText139, wizardNav());
      else { state.profile.preferences.morningBriefing = { enabled: true, time: text }; mutate(); renderSettings('timing'); }
    } else {
      const shortcuts: Record<string, string> = { 'графік': '/schedule', 'адреси': '/addresses', 'налаштування': '/settings', 'допомога': '/help', 'пауза': '/pause', 'назад': '/back', 'скасувати': '/cancel' };
      if (textKey(text) === BOT_COPY.engineText141 && state.draft && state.profile.preferences.paused) message(BOT_COPY.engineText142, [commandButton(BOT_COPY.engineText143, '/draft'), commandButton(BOT_COPY.engineText144, '/resume')]);
      else if (textKey(text) === BOT_COPY.engineText145) handleCommand(state.draft ? '/draft' : '/resume');
      else handleCommand(shortcuts[textKey(text)] || '/unknown');
    }
  }

  if (profileChanged) {
    actions.push({ type: 'persist_profile', idempotencyKey: `${state.ownerId}:${input.id}:profile`, simulationOnly: true });
    for (const item of messages) item.commitBarrier = 'profile';
  }
  const callbackKeys = Object.keys(state.callbacks);
  for (const key of callbackKeys.slice(0, Math.max(0, callbackKeys.length - 128))) delete state.callbacks[key];
  return { state, messages, actions, requiresCommit: true, ...(callbackFailure ? { rejected: callbackFailure } : {}) };
}

/** Trusted adapter entry: never accept schedule events from a user's callback body. */
export function handleScheduleEvent(previous: BotState, event: ScheduleEvent, view: ScheduleView, context: BotContext): BotTurn {
  if (context.actorId !== previous.ownerId) return rejected(previous, event.id, 'foreign_actor', COPY.foreignButton);
  if (!validInstant(context.now)) return rejected(previous, event.id, 'invalid_clock', COPY.unavailableAction);
  const validKinds = ['new_plan', 'changed', 'moved', 'cancelled', 'emergency', 'reminder'];
  const validEvent = typeof event.id === 'string' && Boolean(event.id) && validKinds.includes(event.kind) &&
    validInstant(event.createdAt) && Date.parse(event.createdAt) <= Date.parse(context.now);
  const matchingStatus = event.kind === 'emergency' ? view.status === 'emergency' :
    event.kind === 'cancelled' ? view.status === 'no_planned_outages' :
    event.kind === 'moved' ? ['published', 'possible'].includes(view.status) :
    event.kind === 'reminder' ? ['published', 'possible'].includes(view.status) :
    ['published', 'possible', 'no_planned_outages'].includes(view.status);
  if (!validEvent || !matchingStatus) return { state: previous, messages: [], actions: [], requiresCommit: false };
  if (previous.processedEventIds.includes(event.id)) return { state: previous, messages: [], actions: [], requiresCommit: false, duplicate: true };
  const l = previous.profile.locations.find(item => item.address.id === event.addressId);
  // An adapter or provider fault must close this gate, not manufacture a notification.
  let deliverable = false;
  try { deliverable = Boolean(l && resolveNotificationPolicy(previous.profile.preferences, l, 'telegram').enabled && canDeliver(view, l.binding, previous.profile.preferences, context.now)); } catch { /* invalid provider contract */ }
  const reminder = event.reminder;
  const leadMinutes = l && reminder ? reminderLeadMinutes(previous.profile.preferences, l, 'telegram', reminder.edge) : 0;
  const reminderAllowed = event.kind !== 'reminder' || (
    Number.isInteger(leadMinutes) && leadMinutes >= 1 && leadMinutes <= 1440 && reminder &&
    ['starts', 'ends'].includes(reminder.edge) && validInstant(reminder.intervalStartsAt) && validInstant(reminder.intervalEndsAt) && view.intervals.some(interval => {
      if (Date.parse(interval.startsAt) !== Date.parse(reminder.intervalStartsAt) || Date.parse(interval.endsAt) !== Date.parse(reminder.intervalEndsAt)) return false;
      const edge = Date.parse(reminder.edge === 'starts' ? interval.startsAt : interval.endsAt);
      const due = edge - leadMinutes * 60000, now = Date.parse(context.now);
      return now >= due && now < due + 60000 &&
        reminderDurationEligible(previous.profile.preferences, reminder.edge, (Date.parse(interval.endsAt) - Date.parse(interval.startsAt)) / 60000);
    }));
  if (!l || !l.notifications || l.paused || event.addressId !== view.addressId || event.operatorId !== view.operatorId ||
      event.serviceDate !== view.serviceDate || event.toRevisionId !== view.revisionId ||
      !deliverable || !reminderAllowed) {
    return { state: previous, messages: [], actions: [], requiresCommit: false };
  }
  const state = clone(previous);
  state.processedEventIds = [...state.processedEventIds, event.id].slice(-512);
  const displayView: ScheduleView = { ...view, addressLabel: l.address.label };
  const message: BotMessage = { id: `event:${event.id}`, kind: 'notification', text: formatNotification(event.kind, displayView, reminder?.edge),
    buttons: [], commitBarrier: 'profile', scheduleRevisionId: view.revisionId };
  const actions: BotAction[] = [];
  if (event.kind === 'emergency') actions.push({ type: 'cancel_pending_delivery', idempotencyKey: `event:${event.id}:${state.ownerId}:cancel-planned`, addressId: view.addressId, eventId: event.id, reason: 'emergency_mode', simulationOnly: true });
  actions.push({ type: 'enqueue_simulated_delivery', idempotencyKey: `event:${event.id}:${state.ownerId}`, addressId: view.addressId, eventId: event.id, simulationOnly: true });
  return { state, messages: [message], actions, requiresCommit: true };
}

