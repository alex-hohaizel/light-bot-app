import {createHash,randomUUID} from 'node:crypto';
import {createBotState,handleBotInput,handleScheduleEvent,restoreBotState} from '../../shared/bot/engine.ts';
import type {AddressOption,BotContext,BotInput,BotMessage,BotProfile,BotState,BotAction} from '../../shared/bot/types.ts';
import type {ScheduleView,ScheduleEvent} from '../../shared/product-contract.ts';
import {validInstant,validateScheduleView,localParts,nextCalendarDate} from '../../shared/schedule-core.ts';
import {planMatchesDisplay} from '../../shared/schedule-binding.ts';
import {handleMorningBriefing,type MorningBriefingPacket} from '../../shared/morning-briefing.ts';
import {applyProfileMutation,parseProfileRequest} from '../domain/profile-service.ts';
import {selectLegacyLiveProfileInTransaction,type LegacyProfileReadPool,type LegacyProfileReadClient,type LegacyProfileReadQuery,type VerifiedLegacyPrincipal,type VerifiedSubscriberMapping} from './profile-reader.ts';

/** Additive DDL only. Import/construction never executes it or creates a control row.
 * The control row is a local gate, not proof that the old deployment's writers are fenced.
 */
export const PRODUCTION_PROFILE_SCHEMA_SQL = `
create table if not exists lba_production_control (
 id boolean primary key default true check(id=true),
 control_epoch bigint not null check(control_epoch>0 and control_epoch<=9007199254740991),
 writer_mode text not null default 'disabled' check(writer_mode in ('disabled','legacy','canonical'))
);
create table if not exists lba_production_profiles (
 owner_id varchar(255) primary key,session_id varchar(128) not null unique,
 revision bigint not null check(revision>=0 and revision<=9007199254740991),
 control_epoch bigint not null,state jsonb not null,created_at timestamptz not null,updated_at timestamptz not null
);
create table if not exists lba_production_profile_origins (
 owner_id varchar(255) primary key references lba_production_profiles(owner_id),
 source_digest char(64) not null,projection_digest char(64) not null,
 private_provenance jsonb not null,imported_at timestamptz not null,control_epoch bigint not null
);
create table if not exists lba_production_bootstrap_ledger (
 owner_id varchar(255) primary key,session_id varchar(128) not null unique,
 source_digest char(64) not null,origin_kind text not null check(origin_kind in ('legacy','verified_empty')),
 initialized_at timestamptz not null,control_epoch bigint not null
);
create table if not exists lba_production_profile_inbox (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),input_id varchar(160) not null,
 input_digest char(64) not null,receipt jsonb not null,recorded_at timestamptz not null,
 primary key(owner_id,input_id)
);
create table if not exists lba_production_profile_outbox (
 id uuid primary key,owner_id varchar(255) not null references lba_production_profiles(owner_id),
 input_id varchar(160) not null,session_id varchar(128) not null,revision bigint not null,control_epoch bigint not null,ordinal integer not null check(ordinal>=0),
 address_id text,kind text not null check(kind in ('reply','schedule','notification','error')),
 status text not null default 'pending' check(status in ('pending','dispatching','sent','unknown','cancelled','not_sent')),
 payload jsonb not null,created_at timestamptz not null,unique(owner_id,input_id,ordinal)
);
create index if not exists lba_production_profile_outbox_pending on lba_production_profile_outbox(owner_id,session_id,control_epoch,revision,ordinal,id) where status='pending';
`;

export interface ProductionProfileSnapshot {
  runtime:'production';profile:BotProfile;sessionId:string;revision:number;serverNow:string;
  catalog:AddressOption[];plans:ScheduleView[];
}
export interface ProductionProfileReceipt {
  runtime:'production';id:string;inputId:string;channel:'app'|'bot';committed:true;
  sessionId:string;previousRevision:number;sessionRevision:number;controlEpoch:number;recordedAt:string;
  delivery:'pending'|'none';outboxIds:string[];rejected:string|null;
}
export interface ProductionProfileCommit {
  snapshot:ProductionProfileSnapshot;receipt:ProductionProfileReceipt;replayed:boolean;
}
/** Provider ingress omits CAS and serializes on the current owner state. Its immutable
 * semantic input ID must be retained across unknown outcomes. App-like clients may add CAS.
 */
export interface ProductionBotRequest {
  input:BotInput;expectedSessionId?:string;expectedRevision?:number;
}
/** Server-only capability: callers cannot put a function/fence into request JSON.
 * A processor guard must lock and recheck its authority in this canonical transaction.
 */
export type ProductionBotCommitGuard=(input:{client:LegacyProfileReadQuery;principal:VerifiedLegacyPrincipal;request:ProductionBotRequest;phase:'before_bootstrap'|'before_commit'})=>Promise<boolean>|boolean;
export interface ProductionPendingMessage {
  id:string;inputId:string;sessionId:string;revision:number;controlEpoch:number;ordinal:number;addressId:string|null;
  status:'pending';message:BotMessage;schedule?:ScheduleView;
  briefing?:{id:string;serviceDate:string;packetDigest:string;partIndex:number;totalParts:number};
}
/** Trusted registry verifier result, never accepted from request JSON. The reader's
 * zero-row source digest fences this proof to the same exact owner snapshot.
 */
export interface VerifiedEmptyAccountBootstrap {
  kind:'verified_empty_account';ownerId:string;accountState:'new'|'existing_empty';
  accountRevisionId:string;evidenceRef:string;legacySourceDigest:string;verifiedAt:string;
}
export interface ProductionProfileStoreOptions {
  pool:LegacyProfileReadPool;
  /** Default false. Trusted deployment configuration, never copied from a request. */
  enabled?:boolean;
  expectedControlEpoch:number;
  now?:()=>string;
  /** Pure/trusted local context, no user-owned catalog or fake schedules. */
  context:(input:{principal:VerifiedLegacyPrincipal;state:BotState;serverNow:string})=>Promise<Omit<BotContext,'actorId'|'now'>>|Omit<BotContext,'actorId'|'now'>;
  verifiedSubscriberMappings?:(principal:VerifiedLegacyPrincipal,client:LegacyProfileReadQuery)=>Promise<readonly VerifiedSubscriberMapping[]>|readonly VerifiedSubscriberMapping[];
  /** Must SELECT the existing authenticated account registry in this same transaction.
   * An absent/unknown account, unresolved ownership or missing proof must return null.
   */
  verifyEmptyAccount?:(input:{principal:VerifiedLegacyPrincipal;client:LegacyProfileReadQuery;legacySourceDigest:string;serverNow:string})=>Promise<VerifiedEmptyAccountBootstrap|null>|VerifiedEmptyAccountBootstrap|null;
  /** Trusted local lifecycle hooks share the canonical transaction and owner lock.
   * They may write their own scoped tables; no provider IO or implicit DDL. */
  onProfileChange?:(input:{client:LegacyProfileReadQuery;principal:VerifiedLegacyPrincipal;before:BotState;after:BotState;serverNow:string})=>Promise<void>|void;
  /** A stale settings.telegram_chat_id is not an ownership proof. This explicit
   * migration policy may retain independently owned rows while leaving that
   * reference isolated. It never selects/reassigns a subscriber from that ref. */
  unresolvedSettingsTelegramPolicy?:'deny'|'retain_owned_profile';
  handleBotActions?:(input:{client:LegacyProfileReadQuery;principal:VerifiedLegacyPrincipal;state:BotState;context:BotContext;serverNow:string;
    actions:readonly BotAction[];messages:readonly BotMessage[]})=>Promise<{handledKeys:string[];messages:BotMessage[]}>;
  /** Recheck request authority AFTER waiting for the owner lock. HTTP adapters
   * supply a trusted request context; background Bot/event guards remain separate. */
  authorizePrincipal?:(input:{client:LegacyProfileReadQuery;principal:VerifiedLegacyPrincipal})=>Promise<boolean>|boolean;
}
export class ProductionProfileStoreError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.name='ProductionProfileStoreError';this.code=code;}
}
const fail=(code:string):never=>{throw new ProductionProfileStoreError(code);};
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const bounded=(v:unknown,max=128):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const revision=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function principal(value:VerifiedLegacyPrincipal):VerifiedLegacyPrincipal {
  if(!plain(value)||Object.keys(value).sort().join(',')!=='kind,ownerId,verified'||value.kind!=='verified_server_principal'||value.verified!==true||!bounded(value.ownerId,255))return fail('PRODUCTION_VERIFIED_PRINCIPAL_REQUIRED');
  return {kind:'verified_server_principal',ownerId:value.ownerId,verified:true};
}
function closed(v:Record<string,unknown>,fields:readonly string[]){if(Object.keys(v).some(k=>!fields.includes(k)))fail('PRODUCTION_INVALID_INPUT');}
function botRequest(value:unknown):ProductionBotRequest {
  if(!plain(value))return fail('PRODUCTION_INVALID_INPUT');closed(value,['input','expectedSessionId','expectedRevision']);
  const input=value.input;if(!plain(input))return fail('PRODUCTION_INVALID_INPUT');
  if(!bounded(input.id,128)||!/^[A-Za-z0-9_.:-]+$/.test(input.id))return fail('PRODUCTION_INVALID_INPUT');
  if(input.kind==='callback'){closed(input,['id','kind','callbackId']);if(!bounded(input.callbackId,128))return fail('PRODUCTION_INVALID_INPUT');}
  else if(input.kind==='command'||input.kind==='text'){closed(input,['id','kind','text']);if(typeof input.text!=='string'||input.text.length>4096||/[\u0000\u007f]/.test(input.text))return fail('PRODUCTION_INVALID_INPUT');}
  else return fail('PRODUCTION_INVALID_INPUT');
  const hasSession=Object.hasOwn(value,'expectedSessionId'),hasRevision=Object.hasOwn(value,'expectedRevision');
  if(hasSession!==hasRevision||hasSession&&(!bounded(value.expectedSessionId)||!revision(value.expectedRevision)))return fail('PRODUCTION_INVALID_INPUT');
  return structuredClone(value) as unknown as ProductionBotRequest;
}
function decoded(value:unknown):unknown {
  if(typeof value==='string'){try{return JSON.parse(value);}catch{return fail('PRODUCTION_STORED_STATE_INVALID');}}
  return value;
}
function storedSchedule(value:unknown):ScheduleView {
  const fields=['contractVersion','revisionId','addressId','addressLabel','localityLabel','operatorId','serviceDate','bindingRevisionId','namespace','targetId','timezone','status','dayCoverage','intervals','source','publishedAt','observedAt','freshness','synthetic','deliveryEligible','previousRevisionId','previousIntervals','notice'];
  if(!plain(value)||Object.keys(value).some(k=>!fields.includes(k))||!plain(value.source)||Object.keys(value.source).some(k=>!['id','name','url','revision','accessCost','verifiedLevel'].includes(k)))return fail('PRODUCTION_OUTBOX_INVALID');
  for(const key of ['intervals','previousIntervals'])if(value[key]!==undefined){
    if(!Array.isArray(value[key])||value[key].some((i:unknown)=>!plain(i)||Object.keys(i).some(k=>!['startsAt','endsAt','startLocal','endLocal','kind'].includes(k))))return fail('PRODUCTION_OUTBOX_INVALID');
  }
  try{validateScheduleView(value as unknown as ScheduleView);}catch{return fail('PRODUCTION_OUTBOX_INVALID');}
  if(value.synthetic!==false)return fail('PRODUCTION_OUTBOX_INVALID');
  return structuredClone(value) as unknown as ScheduleView;
}
function storedMessage(value:unknown,id:string):BotMessage {
  const fields=['id','kind','text','buttons','commitBarrier','scheduleRevisionId'];
  if(!plain(value)||Object.keys(value).some(k=>!fields.includes(k))||value.id!==id||!bounded(id)||!['reply','schedule','notification','error'].includes(String(value.kind))||
    typeof value.text!=='string'||!value.text.length||value.text.length>65536||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)||
    !['none','profile'].includes(String(value.commitBarrier))||!Array.isArray(value.buttons)||value.buttons.length>100||value.scheduleRevisionId!==undefined&&!bounded(value.scheduleRevisionId))return fail('PRODUCTION_OUTBOX_INVALID');
  for(const button of value.buttons)if(!plain(button)||Object.keys(button).sort().join(',')!=='callbackId,label'||!bounded(button.label,128)||!bounded(button.callbackId,128))return fail('PRODUCTION_OUTBOX_INVALID');
  return {id,kind:value.kind as BotMessage['kind'],text:value.text,buttons:value.buttons.map(b=>({label:b.label,callbackId:b.callbackId})),commitBarrier:value.commitBarrier as BotMessage['commitBarrier'],...(value.scheduleRevisionId!==undefined?{scheduleRevisionId:value.scheduleRevisionId as string}:{})};
}
function rowState(row:any,owner:string):BotState {
  if(!row||row.ownerId!==owner||!bounded(row.sessionId)||!revision(Number(row.revision)))return fail('PRODUCTION_STORED_STATE_INVALID');
  let state:BotState;try{state=restoreBotState(decoded(row.state),owner);}catch{return fail('PRODUCTION_STORED_STATE_INVALID');}
  if(state.sessionId!==row.sessionId||state.revision!==Number(row.revision)||state.ownerId!==owner||state.profile.id!==owner||!revision(state.callbackSequence)||
    state.profile.locations.length>10000||state.processedInputIds.length>256||state.processedEventIds.length>512)return fail('PRODUCTION_STORED_STATE_INVALID');
  const ids=new Set<string>();for(const location of state.profile.locations){
    if(!bounded(location.address?.id,255)||location.binding?.addressId!==location.address.id||ids.has(location.address.id))return fail('PRODUCTION_STORED_STATE_INVALID');ids.add(location.address.id);
  }
  if(state.profile.primaryAddressId!==null&&!ids.has(state.profile.primaryAddressId))return fail('PRODUCTION_STORED_STATE_INVALID');
  if(Object.values(state.callbacks).some(c=>c.ownerId!==owner))return fail('PRODUCTION_STORED_STATE_INVALID');
  return state;
}
const SELECT_STATE=`select owner_id as "ownerId",session_id as "sessionId",revision,state from lba_production_profiles where owner_id=$1 for update`;
const SELECT_INBOX=`select input_digest as "inputDigest",receipt from lba_production_profile_inbox where owner_id=$1 and input_id=$2`;
/** One canonical state/inbox/outbox for App and Bot. No network, DB import, DDL execution,
 * delivery acknowledgement, reset route, legacy dual-write or automatic re-import exists here.
 */
export function createProductionProfileStore(options:ProductionProfileStoreOptions){
  if(!options||!options.pool||typeof options.pool.connect!=='function'||!positive(options.expectedControlEpoch)||typeof options.context!=='function'||
    options.enabled!==undefined&&typeof options.enabled!=='boolean'||options.now!==undefined&&typeof options.now!=='function'||
    options.verifiedSubscriberMappings!==undefined&&typeof options.verifiedSubscriberMappings!=='function'||
    options.verifyEmptyAccount!==undefined&&typeof options.verifyEmptyAccount!=='function'||
    options.onProfileChange!==undefined&&typeof options.onProfileChange!=='function'||
    options.handleBotActions!==undefined&&typeof options.handleBotActions!=='function'||
    options.authorizePrincipal!==undefined&&typeof options.authorizePrincipal!=='function'||
    options.unresolvedSettingsTelegramPolicy!==undefined&&!['deny','retain_owned_profile'].includes(options.unresolvedSettingsTelegramPolicy))return fail('PRODUCTION_INVALID_STORE_OPTIONS');
  const pool=options.pool,enabled=options.enabled===true,epoch=options.expectedControlEpoch,contextPort=options.context,mappingPort=options.verifiedSubscriberMappings;
  const emptyAccountPort=options.verifyEmptyAccount;
  const clock=()=>{const value=(options.now??(()=>new Date().toISOString()))();if(!validInstant(value))return fail('PRODUCTION_CLOCK_INVALID');return value;};
  async function transaction<T>(identity:VerifiedLegacyPrincipal,work:(client:LegacyProfileReadClient,p:VerifiedLegacyPrincipal)=>Promise<T>,isolation:'repeatable read'|'read committed'=options.authorizePrincipal?'read committed':'repeatable read'):Promise<T>{
    const p=principal(identity);if(!enabled)return fail('PRODUCTION_STORE_DISABLED');
    let client:LegacyProfileReadClient;try{client=await pool.connect();}catch{return fail('PRODUCTION_TRANSACTION_UNCONFIRMED');}
    let began=false,commitStarted=false,committed=false;
    try{
      await client.query('begin isolation level '+isolation);began=true;
      const control=await client.query('select control_epoch as "controlEpoch",writer_mode as "writerMode" from lba_production_control where id=true for share');
      if(control.rows.length!==1||control.rows[0].writerMode!=='canonical')return fail('PRODUCTION_WRITER_NOT_CANONICAL');
      if(Number(control.rows[0].controlEpoch)!==epoch)return fail('PRODUCTION_CONTROL_EPOCH_CONFLICT');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba-production-owner:'+p.ownerId]);
      if(options.authorizePrincipal&&await options.authorizePrincipal({client,principal:structuredClone(p)})!==true)return fail('PRODUCTION_PRINCIPAL_REVOKED');
      const value=await work(client,p);commitStarted=true;await client.query('commit');committed=true;return value;
    }catch(error){
      if(began&&!committed)try{await client.query('rollback');}catch{/* only stable public error codes */}
      if(commitStarted)return fail('PRODUCTION_COMMIT_UNKNOWN');
      if(error instanceof ProductionProfileStoreError)throw error;
      if(error instanceof Error&&/^(?:PROFILE_|LEGACY_READER_|LEGACY_PROFILE_|LEGACY_IDENTITY_)[A-Z_]+$/.test(error.message))return fail(error.message);
      if(['40001','40P01','23505'].includes(String((error as {code?:unknown})?.code??'')))return fail('PRODUCTION_TRANSACTION_RETRY_REQUIRED');
      return fail('PRODUCTION_TRANSACTION_UNCONFIRMED');
    }finally{try{client.release();}catch{if(committed)return fail('PRODUCTION_COMMIT_UNKNOWN');}}
  }
  async function state(client:LegacyProfileReadClient,p:VerifiedLegacyPrincipal):Promise<BotState>{
    const selected=await client.query(SELECT_STATE,[p.ownerId]);
    if(selected.rows.length>1)return fail('PRODUCTION_STORED_STATE_INVALID');
    if(selected.rows.length){
      const current=rowState(selected.rows[0],p.ownerId);
      const origin=await client.query('select source_digest from lba_production_profile_origins where owner_id=$1',[p.ownerId]);
      if(origin.rows.length!==1)return fail('PRODUCTION_ORIGIN_MISSING');
      const ledger=await client.query('select session_id as "sessionId" from lba_production_bootstrap_ledger where owner_id=$1',[p.ownerId]);
      if(ledger.rows.length!==1||ledger.rows[0].sessionId!==current.sessionId)return fail('PRODUCTION_BOOTSTRAP_LEDGER_INVALID');
      return current;
    }
    // A provenance row without its canonical profile is corruption, never permission to re-import.
    const ledger=await client.query('select session_id as "sessionId" from lba_production_bootstrap_ledger where owner_id=$1',[p.ownerId]);
    if(ledger.rows.length)return fail('PRODUCTION_REBOOTSTRAP_FORBIDDEN');
    const previous=await client.query('select source_digest from lba_production_profile_origins where owner_id=$1',[p.ownerId]);
    if(previous.rows.length)return fail('PRODUCTION_REBOOTSTRAP_FORBIDDEN');
    const mappings=structuredClone(mappingPort?await mappingPort(structuredClone(p),client):[]);
    const legacy=await selectLegacyLiveProfileInTransaction(client,p,{now:clock,verifiedSubscriberMappings:mappings});
    const retainOwned=options.unresolvedSettingsTelegramPolicy==='retain_owned_profile'&&legacy.completeness.ownerRows==='reconciled'&&
      legacy.counts.missingVerifiedMappings===0&&legacy.counts.unresolvedSettingsReferences===1&&legacy.blockers.length===1&&
      legacy.blockers[0].code==='LEGACY_READER_SETTINGS_TELEGRAM_MAPPING_UNVERIFIED'&&
      legacy.blockers[0].sourceRefs.length===1&&legacy.blockers[0].sourceRefs[0]==='user_settings.telegram_chat_id';
    if((legacy.status!=='ready'||legacy.blockers.length)&&!retainOwned||legacy.projection.issues.length)return fail('PRODUCTION_BOOTSTRAP_BLOCKED');
    let emptyProof:VerifiedEmptyAccountBootstrap|null=null;
    if(legacy.counts.settings+legacy.counts.locations+legacy.counts.selectedSubscribers===0){
      if(!emptyAccountPort)return fail('PRODUCTION_BOOTSTRAP_EMPTY_UNCONFIRMED');
      const candidate=await emptyAccountPort({principal:structuredClone(p),client,legacySourceDigest:legacy.sourceDigest,serverNow:legacy.serverNow});
      if(candidate===null)return fail('PRODUCTION_BOOTSTRAP_EMPTY_UNCONFIRMED');
      const fields=['kind','ownerId','accountState','accountRevisionId','evidenceRef','legacySourceDigest','verifiedAt'];
      const checkedNow=clock();
      if(!plain(candidate)||Object.keys(candidate).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(candidate,k))||
        candidate.kind!=='verified_empty_account'||candidate.ownerId!==p.ownerId||!['new','existing_empty'].includes(String(candidate.accountState))||
        !bounded(candidate.accountRevisionId,160)||!bounded(candidate.evidenceRef,255)||candidate.legacySourceDigest!==legacy.sourceDigest||!validInstant(candidate.verifiedAt)||
        Date.parse(candidate.verifiedAt)>Date.parse(checkedNow)||Date.parse(checkedNow)-Date.parse(candidate.verifiedAt)>300000)return fail('PRODUCTION_EMPTY_ACCOUNT_PROOF_INVALID');
      emptyProof=structuredClone(candidate) as unknown as VerifiedEmptyAccountBootstrap;
    }
    const initial=createBotState({ownerId:p.ownerId,sessionId:randomUUID(),profile:legacy.projection.profile});
    await client.query(`insert into lba_production_profiles(owner_id,session_id,revision,control_epoch,state,created_at,updated_at) values($1,$2,$3,$4,$5::jsonb,$6,$6)`,
      [p.ownerId,initial.sessionId,initial.revision,epoch,JSON.stringify(initial),legacy.serverNow]);
    await client.query(`insert into lba_production_profile_origins(owner_id,source_digest,projection_digest,private_provenance,imported_at,control_epoch) values($1,$2,$3,$4::jsonb,$5,$6)`,
      [p.ownerId,legacy.sourceDigest,legacy.projectionDigest,JSON.stringify({version:legacy.version,provenance:legacy.projection.provenance,counts:legacy.counts,completeness:legacy.completeness,blockers:legacy.blockers,verifiedSubscriberMappings:mappings,...(retainOwned?{unresolvedTelegramReference:{resolution:'retain_owned_rows_reference_unverified',subscriberOwnershipGranted:false}}:{}),...(emptyProof?{emptyAccountProof:emptyProof}:{})}),legacy.serverNow,epoch]);
    await client.query(`insert into lba_production_bootstrap_ledger(owner_id,session_id,source_digest,origin_kind,initialized_at,control_epoch) values($1,$2,$3,$4,$5,$6)`,
      [p.ownerId,initial.sessionId,legacy.sourceDigest,emptyProof?'verified_empty':'legacy',legacy.serverNow,epoch]);
    return initial;
  }
  async function context(p:VerifiedLegacyPrincipal,current:BotState,now:string):Promise<BotContext>{
    const raw=await contextPort({principal:structuredClone(p),state:structuredClone(current),serverNow:now});
    if(!plain(raw)||!Array.isArray(raw.addresses)||!Array.isArray(raw.plans)||raw.addresses.length>10000||raw.plans.length>20000)return fail('PRODUCTION_CONTEXT_INVALID');
    const copy=structuredClone(raw),optionIds=new Set<string>();
    for(const option of copy.addresses){if(!bounded(option.id)||optionIds.has(option.id)||!bounded(option.address?.id,255)||option.binding?.addressId!==option.address.id||!bounded(option.binding.revisionId)|| (option as AddressOption&{synthetic?:boolean}).synthetic===true)return fail('PRODUCTION_CATALOG_INVALID');optionIds.add(option.id);}
    const plans=copy.plans.flatMap(view=>{
      try{validateScheduleView(view);}catch{return [];}
      const location=current.profile.locations.find(l=>l.address.id===view.addressId),binding=location?.binding;
      const unconfirmed=binding?.status==='needs_confirmation';
      const exact=Boolean(binding&&view.synthetic===false&&view.source.accessCost===0&&planMatchesDisplay(view,binding,now));
      const qualifier=binding?.kind==='user_selected_group'?'План обраної вручну групи. Прив’язку будинку ще потрібно підтвердити.':
        'Це план групи, яку довідник указав для обраного будинку. Відповідність будинку ще потребує перевірки.';
      return exact?[unconfirmed?{...view,deliveryEligible:false,notice:[...new Set([view.notice,qualifier].filter(Boolean))].join('\n')}:view]:[];
    });
    return {...copy,actorId:p.ownerId,now,plans};
  }
  const snapshot=(current:BotState,ctx:BotContext):ProductionProfileSnapshot=>({runtime:'production',profile:structuredClone(current.profile),sessionId:current.sessionId,revision:current.revision,serverNow:ctx.now,catalog:structuredClone(ctx.addresses),plans:structuredClone(ctx.plans)});
  async function replay(client:LegacyProfileReadClient,owner:string,inputId:string,inputDigest:string):Promise<ProductionProfileReceipt|null>{
    const previous=await client.query(SELECT_INBOX,[owner,inputId]);if(previous.rows.length>1)return fail('PRODUCTION_STORED_RECEIPT_INVALID');if(!previous.rows.length)return null;
    if(previous.rows[0].inputDigest!==inputDigest)return fail('PRODUCTION_INPUT_ID_CONFLICT');
    const raw=decoded(previous.rows[0].receipt);
    const allowed=['runtime','id','inputId','channel','committed','sessionId','previousRevision','sessionRevision','controlEpoch','recordedAt','delivery','outboxIds','rejected'];
    if(!plain(raw)||Object.keys(raw).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(raw,k)))return fail('PRODUCTION_STORED_RECEIPT_INVALID');
    const receipt=raw as unknown as ProductionProfileReceipt;
    if(receipt.runtime!=='production'||!bounded(receipt.id)||receipt.inputId!==inputId||!['app','bot'].includes(receipt.channel)||!inputId.startsWith(receipt.channel+':')||
      receipt.committed!==true||!bounded(receipt.sessionId)||!revision(receipt.previousRevision)||!revision(receipt.sessionRevision)||!positive(receipt.controlEpoch)||!validInstant(receipt.recordedAt)||
      !['pending','none'].includes(receipt.delivery)||!Array.isArray(receipt.outboxIds)||receipt.outboxIds.length>100||receipt.outboxIds.some(id=>!bounded(id))||
      (receipt.rejected!==null&&!bounded(receipt.rejected))||receipt.delivery==='none'&&receipt.outboxIds.length||receipt.delivery==='pending'&&!receipt.outboxIds.length)return fail('PRODUCTION_STORED_RECEIPT_INVALID');
    return structuredClone(receipt);
  }
  async function persist(client:LegacyProfileReadClient,p:VerifiedLegacyPrincipal,before:BotState,after:BotState,inputId:string,inputDigest:string,channel:'app'|'bot',now:string,messages:BotMessage[],cancelled:Array<string|null>,rejected:string|null,plans:ScheduleView[]=[]):Promise<ProductionProfileReceipt>{
    if(after.ownerId!==p.ownerId||after.profile.id!==p.ownerId||after.sessionId!==before.sessionId||!revision(after.revision)||after.revision<before.revision||after.revision>before.revision+1)return fail('PRODUCTION_ENGINE_STATE_INVALID');
    await options.onProfileChange?.({client,principal:structuredClone(p),before:structuredClone(before),after:structuredClone(after),serverNow:now});
    const updated=await client.query(`update lba_production_profiles set revision=$4,state=$5::jsonb,control_epoch=$6,updated_at=$7 where owner_id=$1 and session_id=$2 and revision=$3`,[p.ownerId,before.sessionId,before.revision,after.revision,JSON.stringify(after),epoch,now]);
    if(updated.rowCount!==1)return fail('PRODUCTION_PROFILE_REVISION_CONFLICT');
    for(const addressId of cancelled)await client.query(`update lba_production_profile_outbox set status='cancelled' where owner_id=$1 and status='pending' and kind='notification' and ($2::text is null or address_id=$2)`,[p.ownerId,addressId]);
    const outboxIds:string[]=[];
    for(let i=0;i<messages.length;i++){
      const id=randomUUID(),message={...messages[i],id};outboxIds.push(id);
      const linked=message.scheduleRevisionId?plans.filter(view=>view.revisionId===message.scheduleRevisionId&&view.addressId===after.currentAddressId):[];
      if(message.scheduleRevisionId&&linked.length!==1)return fail('PRODUCTION_MESSAGE_SCHEDULE_MISMATCH');
      const schedule=linked[0]?{...linked[0],addressLabel:after.profile.locations.find(l=>l.address.id===linked[0].addressId)?.address.label??linked[0].addressLabel}:undefined;
      await client.query(`insert into lba_production_profile_outbox(id,owner_id,input_id,session_id,revision,control_epoch,ordinal,address_id,kind,payload,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [id,p.ownerId,inputId,after.sessionId,after.revision,epoch,i,after.currentAddressId,message.kind,JSON.stringify({message,...(schedule?{schedule}:{})}),now]);
    }
    const receipt:ProductionProfileReceipt={runtime:'production',id:randomUUID(),inputId,channel,committed:true,sessionId:after.sessionId,previousRevision:before.revision,sessionRevision:after.revision,controlEpoch:epoch,recordedAt:now,delivery:outboxIds.length?'pending':'none',outboxIds,rejected};
    await client.query('insert into lba_production_profile_inbox(owner_id,input_id,input_digest,receipt,recorded_at) values($1,$2,$3,$4::jsonb,$5)',[p.ownerId,inputId,inputDigest,JSON.stringify(receipt),now]);return receipt;
  }
  async function commitBot(identity:VerifiedLegacyPrincipal,value:unknown,guard?:ProductionBotCommitGuard,preparedState?:{sessionId:string;revision:number;selectionChanged?:true}):Promise<ProductionProfileCommit>{
    principal(identity);const request=botRequest(value),inputId='bot:'+request.input.id,inputDigest=digest({channel:'bot',request});
    return transaction(identity,async(client,p)=>{
      const oldReceipt=await replay(client,p.ownerId,inputId,inputDigest);
      if(!oldReceipt&&guard&&await guard({client,principal:structuredClone(p),request:structuredClone(request),phase:'before_bootstrap'})!==true)return fail('PRODUCTION_BOT_GUARD_REJECTED');
      const current=await state(client,p),now=clock(),ctx=await context(p,current,now);
      if(oldReceipt)return {snapshot:snapshot(current,ctx),receipt:oldReceipt,replayed:true};
      if(request.expectedSessionId!==undefined&&(request.expectedSessionId!==current.sessionId||request.expectedRevision!==current.revision))return fail('PRODUCTION_PROFILE_REVISION_CONFLICT');
      const input=request.input,command=input.kind==='callback'?current.callbacks[input.callbackId]?.action:undefined;
      const reset=(text:string)=>text.trim().split(/\s+/)[0].toLowerCase().split('@')[0]==='/reset';
      if(input.kind!=='callback'&&reset(input.text)||command?.kind==='confirm_reset'||command?.kind==='command'&&reset(command.value))return fail('PRODUCTION_RESET_NOT_AUTHORIZED');
      const preparationChanged=preparedState&&(preparedState.selectionChanged===true||preparedState.sessionId!==current.sessionId||preparedState.revision!==current.revision);
      const turn:ReturnType<typeof handleBotInput>=preparationChanged?{
        state:{...structuredClone(current),revision:current.revision+1,processedInputIds:[...current.processedInputIds,input.id].slice(-256)},
        messages:[{id:input.id+':changed',kind:'error',text:'Дані або вибір адреси змінилися під час пошуку. Цю дію не виконано. Відкрийте /start і повторіть вибір адреси.',buttons:[],commitBarrier:'none'}],
        actions:[],requiresCommit:true,rejected:'invalid_state',
      }:handleBotInput(current,input,ctx);
      const extra=turn.actions.filter(action=>!['persist_profile','cancel_pending_delivery'].includes(action.type));
      if(extra.length){
        if(!options.handleBotActions)return fail('PRODUCTION_EFFECT_HANDLER_REQUIRED');
        const handled=await options.handleBotActions({client,principal:structuredClone(p),state:structuredClone(current),context:structuredClone(ctx),serverNow:now,actions:structuredClone(extra),messages:structuredClone(turn.messages)});
        if(!plain(handled)||Object.keys(handled).sort().join(',')!=='handledKeys,messages'||!Array.isArray(handled.handledKeys)||
          new Set(handled.handledKeys).size!==extra.length||handled.handledKeys.length!==extra.length||
          extra.some(a=>!handled.handledKeys.includes(a.idempotencyKey))||!Array.isArray(handled.messages)||handled.messages.length>100)return fail('PRODUCTION_EFFECT_HANDLER_INVALID');
        turn.messages=handled.messages.map((m,i)=>{const id='action:'+input.id+':'+i;return storedMessage({...m,id},id);});
      }
      const cancelled=turn.actions.filter(a=>a.type==='cancel_pending_delivery').map(a=>a.addressId??null);
      const receipt=await persist(client,p,current,turn.state,inputId,inputDigest,'bot',now,turn.messages,cancelled,turn.rejected??null,ctx.plans);
      const result=snapshot(turn.state,await context(p,turn.state,now));
      if(guard&&await guard({client,principal:structuredClone(p),request:structuredClone(request),phase:'before_commit'})!==true)return fail('PRODUCTION_BOT_GUARD_REJECTED');
      return {snapshot:result,receipt,replayed:false};
    });
  }
  return Object.freeze({
    /** Server-only daily aggregate. The immutable occurrence/proof ledger is
     * committed by the recipe in this transaction; profiles are never created
     * or mutated merely because a background worker scanned an owner. */
    async commitMorningBriefing<T>(identity:VerifiedLegacyPrincipal,operation:(input:{client:LegacyProfileReadQuery;state:BotState;context:BotContext;serverNow:string;
      persistBriefingTurn:(input:{briefing:MorningBriefingPacket})=>Promise<{sessionRevision:number;outboxIds:string[];messagesCount:number}>})=>Promise<T>):Promise<T>{
      if(typeof operation!=='function')return fail('PRODUCTION_INVALID_INPUT');
      return transaction(identity,async(client,p)=>{
        const present=await client.query('select owner_id from lba_production_profiles where owner_id=$1 for update',[p.ownerId]);
        if(present.rows.length!==1||present.rows[0].owner_id!==p.ownerId)return fail('PRODUCTION_MORNING_BRIEFING_PROFILE_MISSING');
        const current=await state(client,p),now=clock(),ctx=await context(p,current,now);let active=true,used=false,pending:Promise<unknown>|undefined;
        const persistBriefingTurn=({briefing}:{briefing:MorningBriefingPacket})=>{
          if(!active||used)throw new ProductionProfileStoreError('PRODUCTION_MORNING_BRIEFING_PERSIST_REUSED');used=true;
          const work=async()=>{
            const turn=handleMorningBriefing(current,structuredClone(briefing),ctx),outboxIds:string[]=[],packetDigest=digest(briefing);
            for(let ordinal=0;ordinal<turn.messages.length;ordinal++){
              const id=randomUUID(),message=storedMessage({...turn.messages[ordinal],id},id),schedule=turn.primarySchedule?storedSchedule(turn.primarySchedule):undefined;
              const metadata={id:briefing.id,serviceDate:briefing.serviceDate,packetDigest,partIndex:ordinal,totalParts:turn.messages.length};
              if(message.kind!=='notification'||message.buttons.length||schedule&&turn.messages.length!==1)return fail('PRODUCTION_MORNING_BRIEFING_INVALID');
              await client.query(`insert into lba_production_profile_outbox(id,owner_id,input_id,session_id,revision,control_epoch,ordinal,address_id,kind,payload,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,'notification',$9::jsonb,$10)`,
                [id,p.ownerId,'briefing:'+briefing.id,current.sessionId,current.revision,epoch,ordinal,schedule?.addressId??null,JSON.stringify({message,...(schedule?{schedule}:{}),briefing:metadata}),now]);
              outboxIds.push(id);
            }
            return {sessionRevision:current.revision,outboxIds,messagesCount:outboxIds.length};
          };const result=work();pending=result;return result;
        };
        try{const result=await operation({client,state:structuredClone(current),context:structuredClone(ctx),serverNow:now,persistBriefingTurn});if(pending)await pending;return result;}
        finally{active=false;}
      },'read committed');
    },
    /** Internal event recipe. The event service owns its certification/cursor
     * ledger in this SAME transaction. It cannot supply a replacement profile
     * or claim that a simulated action itself authorizes a Telegram send. */
    async commitScheduleEvent<T>(identity:VerifiedLegacyPrincipal,operation:(input:{client:LegacyProfileReadQuery;state:BotState;context:BotContext;serverNow:string;
      persistEventTurn:(input:{event:ScheduleEvent;view:ScheduleView})=>Promise<{sessionRevision:number;outboxIds:string[];messagesCount:number}>})=>Promise<T>):Promise<T>{
      if(typeof operation!=='function')return fail('PRODUCTION_INVALID_INPUT');
      return transaction(identity,async(client,p)=>{
        const present=await client.query('select owner_id from lba_production_profiles where owner_id=$1 for update',[p.ownerId]);
        if(present.rows.length!==1||present.rows[0].owner_id!==p.ownerId)return fail('PRODUCTION_EVENT_PROFILE_MISSING');
        const current=await state(client,p),now=clock(),ctx=await context(p,current,now);let used=false,active=true,pending:Promise<unknown>|undefined;
        const persistEventTurn=({event,view}:{event:ScheduleEvent;view:ScheduleView})=>{
          if(!active||used)throw new ProductionProfileStoreError('PRODUCTION_EVENT_PERSIST_REUSED');used=true;
          const work=async()=>{
            if(!plain(event)||Object.keys(event).some(k=>!['id','addressId','operatorId','serviceDate','fromRevisionId','toRevisionId','kind','createdAt','reminder'].includes(k))||!bounded(event.id,128)||!/^[A-Za-z0-9_.:-]+$/.test(event.id)||
              !bounded(event.addressId,512)||!bounded(event.operatorId,512)||!validInstant(event.createdAt)||Date.parse(event.createdAt)>Date.parse(now)||
              event.fromRevisionId!==null&&!bounded(event.fromRevisionId,512)||!bounded(event.toRevisionId,512))return fail('PRODUCTION_EVENT_INVALID');
            if(event.reminder!==undefined&&(!plain(event.reminder)||Object.keys(event.reminder).sort().join(',')!=='edge,intervalEndsAt,intervalStartsAt'||!['starts','ends'].includes(event.reminder.edge)||!validInstant(event.reminder.intervalStartsAt)||!validInstant(event.reminder.intervalEndsAt)))return fail('PRODUCTION_EVENT_INVALID');
            const checked=storedSchedule(view),turn=handleScheduleEvent(current,structuredClone(event),checked,ctx);
            if(turn.messages.some(m=>m.kind!=='notification'||m.scheduleRevisionId!==checked.revisionId)||turn.actions.some(a=>!['enqueue_simulated_delivery','cancel_pending_delivery'].includes(a.type)||a.addressId!==checked.addressId||a.eventId!==event.id))return fail('PRODUCTION_EVENT_INVALID');
            if(!turn.messages.length)return {sessionRevision:current.revision,outboxIds:[],messagesCount:0};
            const location=current.profile.locations.find(l=>l.address.id===checked.addressId);if(!location)return fail('PRODUCTION_EVENT_INVALID');
            // Preserve navigation, profile and callback revisions. A background
            // alert only advances its event dedupe vector.
            if(digest({...turn.state,processedEventIds:current.processedEventIds})!==digest(current))return fail('PRODUCTION_EVENT_INVALID');
            await options.onProfileChange?.({client,principal:structuredClone(p),before:structuredClone(current),after:structuredClone(turn.state),serverNow:now});
            const changed=await client.query('update lba_production_profiles set state=$4::jsonb,updated_at=$5 where owner_id=$1 and session_id=$2 and revision=$3',[p.ownerId,current.sessionId,current.revision,JSON.stringify(turn.state),now]);
            if(changed.rowCount!==1)return fail('PRODUCTION_PROFILE_REVISION_CONFLICT');
            if(turn.actions.some(a=>a.type==='cancel_pending_delivery'))await client.query("update lba_production_profile_outbox set status='cancelled' where owner_id=$1 and session_id=$2 and address_id=$3 and kind='notification' and status='pending'",[p.ownerId,current.sessionId,checked.addressId]);
            const outboxIds:string[]=[],schedule={...checked,addressLabel:location.address.label};
            for(let ordinal=0;ordinal<turn.messages.length;ordinal++){
              const id=randomUUID(),message=storedMessage({...turn.messages[ordinal],id},id);outboxIds.push(id);
              await client.query(`insert into lba_production_profile_outbox(id,owner_id,input_id,session_id,revision,control_epoch,ordinal,address_id,kind,payload,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,'notification',$9::jsonb,$10)`,
                [id,p.ownerId,'event:'+event.id,current.sessionId,current.revision,epoch,ordinal,checked.addressId,JSON.stringify({message,schedule}),now]);
            }
            return {sessionRevision:current.revision,outboxIds,messagesCount:outboxIds.length};
          };const result=work();pending=result;return result;
        };
        try{const result=await operation({client,state:structuredClone(current),context:structuredClone(ctx),serverNow:now,persistEventTurn});
          if(pending)await pending;return result;
        }finally{active=false;}
      },'read committed');
    },
    /** Server-only composition port for tools with their own idempotency ledger.
     * State is cloned; callbacks cannot silently persist a second profile writer. */
    async withLockedProfile<T>(identity:VerifiedLegacyPrincipal,expected:{sessionId:string;revision:number}|undefined,operation:(input:{client:LegacyProfileReadQuery;state:BotState;context:BotContext;serverNow:string})=>Promise<T>,coordination?:{isolation:'read committed'}):Promise<T>{
      if(typeof operation!=='function'||expected!==undefined&&(!plain(expected)||Object.keys(expected).sort().join(',')!=='revision,sessionId'||!bounded(expected.sessionId)||!revision(expected.revision)))return fail('PRODUCTION_INVALID_INPUT');
      if(coordination!==undefined&&(!plain(coordination)||Object.keys(coordination).join(',')!=='isolation'||coordination.isolation!=='read committed'))return fail('PRODUCTION_INVALID_INPUT');
      return transaction(identity,async(client,p)=>{
        const current=await state(client,p),serverNow=clock();
        if(expected&&(expected.sessionId!==current.sessionId||expected.revision!==current.revision))return fail('PRODUCTION_PROFILE_REVISION_CONFLICT');
        return operation({client,state:structuredClone(current),context:await context(p,current,serverNow),serverNow});
      },coordination?.isolation??(options.authorizePrincipal?'read committed':'repeatable read'));
    },
    /** Authenticated exact-input readback after an ambiguous commit. No context/network,
     * bootstrap, input execution or delivery occurs. A null result is a confirmed ledger miss.
     */
    async recoverReceipt(identity:VerifiedLegacyPrincipal,value:{channel:'app'|'bot';request:unknown}):Promise<ProductionProfileReceipt|null>{
      principal(identity);if(!plain(value))return fail('PRODUCTION_INVALID_INPUT');closed(value,['channel','request']);
      let request:unknown,inputId:string;
      if(value.channel==='app'){
        try{const parsed=parseProfileRequest(value.request);request=parsed;inputId='app:'+parsed.id;}catch{return fail('PRODUCTION_INVALID_INPUT');}
      }else if(value.channel==='bot'){const parsed=botRequest(value.request);request=parsed;inputId='bot:'+parsed.input.id;}
      else return fail('PRODUCTION_INVALID_INPUT');
      const inputDigest=digest({channel:value.channel,request});
      // READ COMMITTED is deliberate: control SELECT precedes waiting for the owner
      // lock. A fresh statement snapshot afterwards must see the preceding commit.
      return transaction(identity,(client,p)=>replay(client,p.ownerId,inputId,inputDigest),'read committed');
    },
    async snapshot(identity:VerifiedLegacyPrincipal):Promise<ProductionProfileSnapshot>{return transaction(identity,async(client,p)=>{const current=await state(client,p);return snapshot(current,await context(p,current,clock()));});},
    async commitProfileMutation(identity:VerifiedLegacyPrincipal,value:unknown):Promise<ProductionProfileCommit>{
      principal(identity);let request;try{request=parseProfileRequest(value);}catch{return fail('PRODUCTION_INVALID_INPUT');}
      const inputId='app:'+request.id,inputDigest=digest({channel:'app',request});
      return transaction(identity,async(client,p)=>{
        const oldReceipt=await replay(client,p.ownerId,inputId,inputDigest),current=await state(client,p),now=clock(),ctx=await context(p,current,now);
        if(oldReceipt)return {snapshot:snapshot(current,ctx),receipt:oldReceipt,replayed:true};
        const result=applyProfileMutation(current,request,ctx.addresses);
        const receipt=await persist(client,p,current,result.state,inputId,inputDigest,'app',now,[],result.cancelledAddresses,null);
        return {snapshot:snapshot(result.state,await context(p,result.state,now)),receipt,replayed:false};
      });
    },
    async commitBotInput(identity:VerifiedLegacyPrincipal,value:unknown):Promise<ProductionProfileCommit>{
      return commitBot(identity,value);
    },
    async commitGuardedBotInput(identity:VerifiedLegacyPrincipal,value:unknown,guard:ProductionBotCommitGuard,preparedState?:{sessionId:string;revision:number;selectionChanged?:true}):Promise<ProductionProfileCommit>{
      if(typeof guard!=='function')return fail('PRODUCTION_BOT_GUARD_REQUIRED');
      if(preparedState!==undefined&&(!plain(preparedState)||Object.keys(preparedState).some(k=>!['revision','sessionId','selectionChanged'].includes(k))||!bounded(preparedState.sessionId)||!revision(preparedState.revision)||preparedState.selectionChanged!==undefined&&preparedState.selectionChanged!==true))return fail('PRODUCTION_INVALID_INPUT');
      return commitBot(identity,value,guard,preparedState);
    },
    /** Read only after the committing method returns. No automatic send/mark-delivered path. */
    async pendingOutbox(identity:VerifiedLegacyPrincipal,limit=50):Promise<ProductionPendingMessage[]>{
      if(!Number.isSafeInteger(limit)||limit<1||limit>100)return fail('PRODUCTION_INVALID_INPUT');
      return transaction(identity,async(client,p)=>{
        const rows=await client.query(`select id,input_id as "inputId",session_id as "sessionId",revision,control_epoch as "controlEpoch",ordinal,address_id as "addressId",payload from lba_production_profile_outbox where owner_id=$1 and status='pending' and control_epoch=$2 and session_id=(select session_id from lba_production_profiles where owner_id=$1) order by revision,ordinal,id limit $3`,[p.ownerId,epoch,limit]);
        return rows.rows.map(r=>{
          const payload=decoded(r.payload);
          if(!plain(payload)||Object.keys(payload).some(k=>!['message','schedule','briefing'].includes(k))||Number(r.controlEpoch)!==epoch)return fail('PRODUCTION_OUTBOX_INVALID');
          const message=storedMessage(payload.message,r.id),schedule=payload.schedule!==undefined?storedSchedule(payload.schedule):undefined;
          if(Boolean(message.scheduleRevisionId)!==Boolean(schedule)||schedule&&(message.scheduleRevisionId!==schedule.revisionId||schedule.addressId!==r.addressId))return fail('PRODUCTION_OUTBOX_INVALID');
          let briefing:ProductionPendingMessage['briefing'];
          if(payload.briefing!==undefined){
            const b=payload.briefing;
            if(!plain(b)||Object.keys(b).sort().join(',')!=='id,packetDigest,partIndex,serviceDate,totalParts'||!bounded(b.id,128)||typeof b.serviceDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(b.serviceDate)||typeof b.packetDigest!=='string'||!(/^[a-f0-9]{64}$/).test(b.packetDigest)||typeof b.partIndex!=='number'||!Number.isInteger(b.partIndex)||b.partIndex<0||typeof b.totalParts!=='number'||!Number.isInteger(b.totalParts)||b.totalParts<1||b.totalParts>100||b.partIndex>=b.totalParts||message.kind!=='notification'||message.buttons.length||b.partIndex!==r.ordinal||r.inputId!=='briefing:'+b.id)return fail('PRODUCTION_OUTBOX_INVALID');
            briefing={id:b.id,serviceDate:b.serviceDate,packetDigest:b.packetDigest,partIndex:b.partIndex,totalParts:b.totalParts};
          }
          return {id:r.id,inputId:r.inputId,sessionId:r.sessionId,revision:Number(r.revision),controlEpoch:epoch,ordinal:r.ordinal,addressId:r.addressId,status:'pending' as const,message,...(schedule?{schedule}:{}),...(briefing?{briefing:structuredClone(briefing)}:{})};
        });
      });
    },
  });
}
