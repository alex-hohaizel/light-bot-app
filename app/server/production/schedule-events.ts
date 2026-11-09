import {createHash} from 'node:crypto';
import type {AddressBinding,ScheduleEvent,ScheduleView} from '../../shared/product-contract.ts';
import type {BotState} from '../../shared/bot/types.ts';
import {handleScheduleEvent} from '../../shared/bot/engine.ts';
import {canDeliver,scheduleSemantics,validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
import {ProductionProfileStoreError,type createProductionProfileStore} from './profile-store.ts';
import type {LegacyProfileReadQuery,VerifiedLegacyPrincipal} from './profile-reader.ts';
import type {DispatchEligibilityRequest} from './telegram-dispatch.ts';
import type {CurrentDispatchSourceProof} from './telegram-dispatch-eligibility.ts';
import type {CurrentRawScheduleFact,CurrentRawScheduleRequest} from './runtime-source-proof.ts';
export type {CurrentRawScheduleFact} from './runtime-source-proof.ts';

/** Explicit migration only. No certificate writer, seed, startup DDL or scheduler.
 * Certificate records require a separate, reviewed source/address/48h acceptance.
 */
export const SCHEDULE_EVENTS_SCHEMA_SQL=`
create table if not exists lba_production_schedule_certificate (
 id uuid primary key,owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,
 control_epoch bigint not null check(control_epoch>0),address_id text not null,schedule_revision_id text not null,
 source_revision char(64) not null,binding_revision_id text not null,view_digest char(64) not null,record_digest char(64) not null,record jsonb not null,
 issued_at timestamptz not null,expires_at timestamptz not null,revoked_at timestamptz,
 check(expires_at>issued_at)
);
create index if not exists lba_production_schedule_certificate_view on lba_production_schedule_certificate(owner_id,session_id,address_id,view_digest) where revoked_at is null;
create table if not exists lba_production_schedule_event (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,event_id varchar(128) not null,
 control_epoch bigint not null,input_digest char(64) not null,event jsonb not null,view jsonb not null,view_digest char(64) not null,
 semantics text not null,certificate_id uuid references lba_production_schedule_certificate(id),receipt jsonb not null,recorded_at timestamptz not null,
 primary key(owner_id,session_id,event_id),unique(owner_id,event_id)
);
create table if not exists lba_production_schedule_cursor (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,scope_hash char(64) not null,
 control_epoch bigint not null,semantics text not null,revision_id text not null,event_id varchar(128) not null,
 certificate_id uuid not null references lba_production_schedule_certificate(id),updated_at timestamptz not null,
 primary key(owner_id,session_id,scope_hash)
);
create table if not exists lba_production_schedule_reminder (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,occurrence_hash char(64) not null,
 control_epoch bigint not null,event_id varchar(128) not null,recorded_at timestamptz not null,
 primary key(owner_id,session_id,occurrence_hash)
);
create table if not exists lba_production_schedule_outbox_proof (
 outbox_id uuid primary key references lba_production_profile_outbox(id),owner_id varchar(255) not null,session_id varchar(128) not null,
 event_id varchar(128) not null,control_epoch bigint not null,certificate_id uuid not null references lba_production_schedule_certificate(id),
 payload_digest char(64) not null,view_digest char(64) not null,recorded_at timestamptz not null,
 foreign key(owner_id,session_id,event_id) references lba_production_schedule_event(owner_id,session_id,event_id)
);
`;

interface AcceptedEvidence {evidenceRef:string;acceptedAt:string;validUntil:string}
export interface ScheduleCertificateRecord {
 kind:'lba-certified-schedule/1';ownerId:string;sessionId:string;controlEpoch:number;issuedAt:string;expiresAt:string;
 view:ScheduleView;binding:AddressBinding;
 sourceEvidence:AcceptedEvidence&{kind:'accepted_source_revision';sourceId:string;sourceRevision:string};
 addressEvidence:AcceptedEvidence&{kind:'accepted_address_binding';bindingRevisionId:string;bindingDigest:string};
 parallel48hEvidence:{kind:'accepted_parallel_48h';sourceId:string;operatorId:string;namespace:string;targetId:string;
  startedAt:string;finishedAt:string;acceptedAt:string;evidenceRef:string};
}
/** A trusted, read-only source port, called ONLY after the DB certificate has been
 * validated. It must lock/reproject the current immutable raw snapshot using this
 * transaction client. No provider IO, new transaction, boolean acceptance or
 * technical-display elevation belongs in this port.
 */
export interface CertifiedScheduleSourceRequest extends CurrentRawScheduleRequest {
 binding:Readonly<AddressBinding>;expectedControlEpoch:number;certificateId:string;certificateDigest:string;
}
export type CertifiedScheduleSourceVerifier=(input:CertifiedScheduleSourceRequest)=>Promise<CurrentRawScheduleFact|null>;
export interface ScheduleEventReceipt {
 kind:'schedule_event_receipt';eventId:string;sessionId:string;sessionRevision:number;scheduleRevisionId:string;
 outcome:'notification_committed'|'ignored';reason:'eligible_transition'|'uncertified'|'source_unverified'|'revision_mismatch'|'semantic_unchanged'|'reminder_already_committed'|'eligibility_or_policy';
 certificateId:string|null;outboxIds:string[];cancelledPending:number;recordedAt:string;
}
type Store=Pick<ReturnType<typeof createProductionProfileStore>,'commitScheduleEvent'>;
export type ScheduleEventCommitGuard=(request:{client:LegacyProfileReadQuery;state:BotState;serverNow:string;event:ScheduleEvent;view:ScheduleView;
 phase:'before_replay'|'before_persist'|'before_commit'})=>Promise<boolean>|boolean;
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=512):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const int=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const epoch=(v:unknown,n:number)=>Boolean((int(v)||typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v))&&Number(v)===n);
const instant=(v:unknown)=>v instanceof Date&&Number.isFinite(v.getTime())?v.toISOString():validInstant(v)?new Date(Date.parse(v)).toISOString():null;
const fail=(suffix:string):never=>{throw new ProductionProfileStoreError('PRODUCTION_SCHEDULE_EVENT_'+suffix);};
function closed(v:unknown,keys:readonly string[]):v is Record<string,unknown>{return plain(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));}
function canonical(v:unknown,depth=0):string {
 if(depth>24)return fail('INVALID');
 if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
 if(typeof v==='number'&&Number.isFinite(v))return String(v);
 if(Array.isArray(v))return '['+v.map(x=>canonical(x,depth+1)).join(',')+']';
 if(plain(v))return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(v[k],depth+1)).join(',')+'}';
 return fail('INVALID');
}
/** Same canonical hash is used by the separate operator certification process. */
export const scheduleEventDigest=(v:unknown):string=>createHash('sha256').update(canonical(v)).digest('hex');
function scope(view:ScheduleView):string{return scheduleEventDigest({addressId:view.addressId,operatorId:view.operatorId,namespace:view.namespace??null,
 targetId:view.targetId??null,bindingRevisionId:view.bindingRevisionId??null,serviceDate:view.serviceDate});}
function occurrence(view:ScheduleView,event:ScheduleEvent):string{return scheduleEventDigest({scope:scope(view),edge:event.reminder!.edge,
 startsAt:Date.parse(event.reminder!.intervalStartsAt),endsAt:Date.parse(event.reminder!.intervalEndsAt)});}
function checkedInput(event:unknown,view:unknown):{event:ScheduleEvent;view:ScheduleView;semantics:string;digest:string;viewDigest:string}{
 if(!plain(event)||Object.keys(event).some(k=>!['id','addressId','operatorId','serviceDate','fromRevisionId','toRevisionId','kind','createdAt','reminder'].includes(k))||
  !text(event.id,128)||!/^[A-Za-z0-9_.:-]+$/.test(event.id)||!text(event.addressId)||!text(event.operatorId)||!text(event.toRevisionId)||
  event.fromRevisionId!==null&&!text(event.fromRevisionId)||!validInstant(event.createdAt)||
  !['new_plan','changed','moved','cancelled','emergency','reminder'].some(k=>k===event.kind))return fail('INVALID');
 try{validateScheduleView(view as ScheduleView);}catch{return fail('INVALID');}
 const v=view as ScheduleView,e=event as unknown as ScheduleEvent;
 if(e.addressId!==v.addressId||e.operatorId!==v.operatorId||e.serviceDate!==v.serviceDate||e.toRevisionId!==v.revisionId)return fail('SCOPE_MISMATCH');
 const statuses=e.kind==='cancelled'?['no_planned_outages']:e.kind==='emergency'?['emergency']:['moved','reminder'].includes(e.kind)?['published','possible']:['published','possible','no_planned_outages'];
 if(!statuses.includes(v.status))return fail('STATUS_MISMATCH');
 if(e.kind==='reminder'){
  if(!closed(e.reminder,['edge','intervalStartsAt','intervalEndsAt'])||!['starts','ends'].includes(e.reminder.edge as string)||!validInstant(e.reminder.intervalStartsAt)||!validInstant(e.reminder.intervalEndsAt))return fail('INVALID');
 }else if(e.reminder!==undefined)return fail('INVALID');
 const serialized=canonical({event:e,view:v});if(Buffer.byteLength(serialized)>150000)return fail('TOO_LARGE');
 return {event:structuredClone(e),view:structuredClone(v),semantics:scheduleSemantics(v),digest:scheduleEventDigest({event:e,view:v}),viewDigest:scheduleEventDigest(v)};
}
function baselineQualified(state:BotState,view:ScheduleView,now:string):boolean{
 const locations=state.profile.locations.filter(l=>l.address.id===view.addressId);if(locations.length!==1||view.addressLabel!==locations[0].address.label)return false;
 const preferences={...state.profile.preferences,optedIn:true,paused:false,notificationPolicy:undefined,quietHours:{...state.profile.preferences.quietHours,enabled:false}};
 try{return canDeliver(view,locations[0].binding,preferences,now);}catch{return false;}
}
function evidence(v:unknown,kind:string,now:number,expires:number,extra:readonly string[]):v is Record<string,unknown>{
 return closed(v,['kind','evidenceRef','acceptedAt','validUntil',...extra])&&v.kind===kind&&text(v.evidenceRef,2048)&&validInstant(v.acceptedAt)&&validInstant(v.validUntil)&&
  Date.parse(v.acceptedAt)<=now&&Date.parse(v.acceptedAt)<Date.parse(v.validUntil)&&expires<=Date.parse(v.validUntil);
}
async function certificate(client:LegacyProfileReadQuery,state:BotState,view:ScheduleView,now:string,expected:number,expectedId?:string){
 if(!baselineQualified(state,view,now)||!hash(view.source.revision))return null;
 const rows=(await client.query(`select * from lba_production_schedule_certificate where owner_id=$1 and session_id=$2 and address_id=$3 and schedule_revision_id=$4
  and view_digest=$5 and revoked_at is null and issued_at<=$6::timestamptz and expires_at>$6::timestamptz${expectedId!==undefined?' and id=$7':''} for share`,
  [state.ownerId,state.sessionId,view.addressId,view.revisionId,scheduleEventDigest(view),now,...(expectedId!==undefined?[expectedId]:[])])).rows;
 if(rows.length!==1)return null;const row=rows[0],record=row.record,n=Date.parse(now),binding=state.profile.locations.find(l=>l.address.id===view.addressId)!.binding;
 if(!uuid(row.id)||expectedId!==undefined&&row.id!==expectedId||!epoch(row.control_epoch,expected)||row.owner_id!==state.ownerId||row.session_id!==state.sessionId||
  row.address_id!==view.addressId||row.schedule_revision_id!==view.revisionId||row.binding_revision_id!==binding.revisionId||row.source_revision!==view.source.revision||row.revoked_at!==null||
  !closed(record,['kind','ownerId','sessionId','controlEpoch','issuedAt','expiresAt','view','binding','sourceEvidence','addressEvidence','parallel48hEvidence'])||
  record.kind!=='lba-certified-schedule/1'||record.ownerId!==state.ownerId||record.sessionId!==state.sessionId||record.controlEpoch!==expected||
  !validInstant(record.issuedAt)||!validInstant(record.expiresAt)||instant(row.issued_at)!==instant(record.issuedAt)||instant(row.expires_at)!==instant(record.expiresAt)||
  Date.parse(record.issuedAt)>n||Date.parse(record.expiresAt)<=n||Date.parse(record.issuedAt)>=Date.parse(record.expiresAt)||
  row.view_digest!==scheduleEventDigest(view)||!hash(row.record_digest)||scheduleEventDigest(record)!==row.record_digest||scheduleEventDigest(record.view)!==scheduleEventDigest(view)||scheduleEventDigest(record.binding)!==scheduleEventDigest(binding))return null;
 const end=Date.parse(record.expiresAt),s=record.sourceEvidence,a=record.addressEvidence,p=record.parallel48hEvidence;
 if(!evidence(s,'accepted_source_revision',n,end,['sourceId','sourceRevision'])||s.sourceId!==view.source.id||s.sourceRevision!==view.source.revision||
  !evidence(a,'accepted_address_binding',n,end,['bindingRevisionId','bindingDigest'])||a.bindingRevisionId!==binding.revisionId||a.bindingDigest!==scheduleEventDigest(binding)||
  !closed(p,['kind','sourceId','operatorId','namespace','targetId','startedAt','finishedAt','acceptedAt','evidenceRef'])||p.kind!=='accepted_parallel_48h'||p.sourceId!==view.source.id||
  p.operatorId!==view.operatorId||p.namespace!==view.namespace||p.targetId!==view.targetId||!text(p.evidenceRef,2048)||!validInstant(p.startedAt)||!validInstant(p.finishedAt)||!validInstant(p.acceptedAt)||
  Date.parse(p.finishedAt)-Date.parse(p.startedAt)<48*3600000||Date.parse(p.finishedAt)>Date.parse(p.acceptedAt)||Date.parse(p.acceptedAt)>Date.parse(record.issuedAt)||
  Date.parse(s.acceptedAt as string)>Date.parse(record.issuedAt)||Date.parse(s.acceptedAt as string)<Date.parse(view.observedAt)||
  Date.parse(a.acceptedAt as string)>Date.parse(record.issuedAt)||Date.parse(a.acceptedAt as string)<Date.parse(binding.verifiedAt!))return null;
 return {id:row.id as string,digest:row.record_digest as string,expiresAt:record.expiresAt as string,binding:structuredClone(binding)};
}
function sourceGrant(value:unknown,view:ScheduleView,now:string):value is CurrentRawScheduleFact{
 return closed(value,['kind','sourceRevision','sourceVerifiedLevel','expiresAt','addressBindingVerified','deliveryEligible'])&&value.kind==='current_raw_schedule_fact'&&
  ['catalog','schedule','address','integration'].includes(value.sourceVerifiedLevel as string)&&value.addressBindingVerified===false&&value.deliveryEligible===false&&
  value.sourceRevision===view.source.revision&&validInstant(value.expiresAt)&&Date.parse(value.expiresAt)>Date.parse(now);
}
function checkedReceipt(value:unknown,state:BotState,input:ReturnType<typeof checkedInput>,now:string):ScheduleEventReceipt{
 const reasons=['eligible_transition','uncertified','source_unverified','revision_mismatch','semantic_unchanged','reminder_already_committed','eligibility_or_policy'];
 if(!closed(value,['kind','eventId','sessionId','sessionRevision','scheduleRevisionId','outcome','reason','certificateId','outboxIds','cancelledPending','recordedAt'])||
  value.kind!=='schedule_event_receipt'||value.eventId!==input.event.id||value.sessionId!==state.sessionId||value.scheduleRevisionId!==input.view.revisionId||!int(value.sessionRevision)||
  !reasons.includes(value.reason as string)||!['notification_committed','ignored'].includes(value.outcome as string)||value.certificateId!==null&&!uuid(value.certificateId)||
  !Array.isArray(value.outboxIds)||value.outboxIds.length>100||value.outboxIds.some(id=>!uuid(id))||new Set(value.outboxIds).size!==value.outboxIds.length||
  (value.outcome==='notification_committed')!==Boolean(value.outboxIds.length)||(value.reason==='eligible_transition')!==Boolean(value.outboxIds.length)||
  !int(value.cancelledPending)||!validInstant(value.recordedAt)||Date.parse(value.recordedAt)>Date.parse(now))return fail('LEDGER_INVALID');
 return structuredClone(value) as unknown as ScheduleEventReceipt;
}

/** Server-only recipe. The caller supplies an immutable event ID, never an HTTP
 * owner/body. Root's transaction port owns all profile/outbox writes. This module
 * owns the cursor, durable replay, certification and proof rows in that SAME TX.
 */
export function createProductionScheduleEvents(options:{enabled?:boolean;expectedControlEpoch:number;store:Store;verifyCurrentSource?:CertifiedScheduleSourceVerifier}){
 if(!options||!int(options.expectedControlEpoch)||options.expectedControlEpoch<1||typeof options.store?.commitScheduleEvent!=='function'||
  options.enabled!==undefined&&typeof options.enabled!=='boolean'||options.verifyCurrentSource!==undefined&&typeof options.verifyCurrentSource!=='function')return fail('INVALID_OPTIONS');
 const enabled=options.enabled===true,expected=options.expectedControlEpoch,store=options.store,verifySource=options.verifyCurrentSource;
 async function currentSource(client:LegacyProfileReadQuery,view:ScheduleView,cert:NonNullable<Awaited<ReturnType<typeof certificate>>>,now:string,signal:AbortSignal=new AbortController().signal){
  if(!verifySource)return null;
  const value=await verifySource({client,view:structuredClone(view),binding:structuredClone(cert.binding),now,expectedControlEpoch:expected,certificateId:cert.id,certificateDigest:cert.digest,signal});
  return sourceGrant(value,view,now)?value:null;
 }
 return Object.freeze({
  /** Read-only qualification port for aggregate recipes, using their existing
   * transaction and the same exact certificate/raw-source validation. */
  async qualifySchedule(input:{client:LegacyProfileReadQuery;state:BotState;view:ScheduleView;now:string;signal:AbortSignal;certificateId?:string}):Promise<{certificateId:string;certificateDigest:string;expiresAt:string}|null>{
   if(!enabled||input.signal.aborted||!validInstant(input.now)||input.certificateId!==undefined&&!uuid(input.certificateId))return null;
   try{
    validateScheduleView(input.view);const cert=await certificate(input.client,input.state,input.view,input.now,expected,input.certificateId);
    if(!cert)return null;const source=await currentSource(input.client,input.view,cert,input.now,input.signal);
    if(!source||input.signal.aborted)return null;
    return {certificateId:cert.id,certificateDigest:cert.digest,expiresAt:new Date(Math.min(Date.parse(cert.expiresAt),Date.parse(source.expiresAt))).toISOString()};
   }catch{return null;}
  },
  async commit(principal:VerifiedLegacyPrincipal,event:ScheduleEvent,view:ScheduleView,guard?:ScheduleEventCommitGuard):Promise<{kind:'disabled'}|{receipt:ScheduleEventReceipt;replayed:boolean}>{
   if(!enabled)return {kind:'disabled'};
   if(guard!==undefined&&typeof guard!=='function')return fail('INVALID_GUARD');
   const input=checkedInput(event,view);
   return store.commitScheduleEvent(principal,async tx=>{
    const {client,state,context,serverNow}=tx;if(Date.parse(input.event.createdAt)>Date.parse(serverNow))return fail('INVALID_CLOCK');
    const authorize=async(phase:'before_replay'|'before_persist'|'before_commit')=>{if(guard&&await guard({client,state:structuredClone(state),serverNow,event:structuredClone(input.event),view:structuredClone(input.view),phase})!==true)return fail('GUARD_REJECTED');};
    await authorize('before_replay');
    const prior=(await client.query('select session_id,input_digest,control_epoch,receipt from lba_production_schedule_event where owner_id=$1 and event_id=$2',
     [state.ownerId,input.event.id])).rows;
    if(prior.length){if(prior.length!==1||prior[0].session_id!==state.sessionId||prior[0].input_digest!==input.digest||!epoch(prior[0].control_epoch,expected))return fail('ID_CONFLICT');return {receipt:checkedReceipt(prior[0].receipt,state,input,serverNow),replayed:true};}
    const cert=await certificate(client,state,input.view,serverNow,expected),grant=cert?await currentSource(client,input.view,cert,serverNow):null;
    const scopeHash=scope(input.view),isReminder=input.event.kind==='reminder';
    let reason:ScheduleEventReceipt['reason']=cert?'source_unverified':'uncertified',outboxIds:string[]=[],cancelledPending=0;
    if(cert&&grant){
     const cursors=(await client.query('select semantics,revision_id,control_epoch from lba_production_schedule_cursor where owner_id=$1 and session_id=$2 and scope_hash=$3',[state.ownerId,state.sessionId,scopeHash])).rows;
     if(cursors.length>1||cursors.length===1&&(!text(cursors[0].semantics,150000)||!text(cursors[0].revision_id)||!epoch(cursors[0].control_epoch,expected)))return fail('CURSOR_INVALID');
     const cursor=cursors[0];
     const lineageMismatch=!isReminder&&(cursor?input.event.fromRevisionId!==cursor.revision_id:input.event.fromRevisionId!==null);
     const reminders=isReminder?(await client.query('select event_id,control_epoch from lba_production_schedule_reminder where owner_id=$1 and session_id=$2 and occurrence_hash=$3',[state.ownerId,state.sessionId,occurrence(input.view,input.event)])).rows:[];
     if(reminders.length>1||reminders.length===1&&!epoch(reminders[0].control_epoch,expected))return fail('CURSOR_INVALID');
     if(lineageMismatch)reason='revision_mismatch';
     else if(isReminder&&reminders.length)reason='reminder_already_committed';
     else if(!isReminder&&cursor?.semantics===input.semantics)reason='semantic_unchanged';
     else {
      // Reuse the full engine, including quiet hours, per-address policy, both
      // reminder edges, duration filters and exact one-minute/DST windows.
      const turn=handleScheduleEvent(state,input.event,input.view,context);reason='eligibility_or_policy';
      if(turn.messages.length){await authorize('before_persist');const result=await tx.persistEventTurn({event:input.event,view:input.view});
       if(!int(result.sessionRevision)||result.sessionRevision!==state.revision||!Array.isArray(result.outboxIds)||result.messagesCount!==result.outboxIds.length||result.outboxIds.length!==turn.messages.length||new Set(result.outboxIds).size!==result.outboxIds.length||result.outboxIds.some(id=>!uuid(id)))return fail('PERSIST_INVALID');
       outboxIds=result.outboxIds;reason='eligible_transition';
      }
     }
     if(!lineageMismatch&&!isReminder){
      // A new certified observation advances the baseline even while opted out,
      // paused or quiet, preventing a historical backlog on a later resume.
      const pending=(await client.query(`select o.id,e.semantics from lba_production_profile_outbox o join lba_production_schedule_outbox_proof p on p.outbox_id=o.id
       join lba_production_schedule_event e on e.owner_id=p.owner_id and e.session_id=p.session_id and e.event_id=p.event_id
       where o.owner_id=$1 and o.session_id=$2 and o.address_id=$3 and o.kind='notification' and o.status='pending' and e.view->>'serviceDate'=$4`,[state.ownerId,state.sessionId,input.view.addressId,input.view.serviceDate])).rows;
      for(const old of pending)if(old.semantics!==input.semantics){const changed=await client.query("update lba_production_profile_outbox set status='cancelled' where id=$1 and owner_id=$2 and session_id=$3 and status='pending'",[old.id,state.ownerId,state.sessionId]);cancelledPending+=changed.rowCount??0;}
      await client.query(`insert into lba_production_schedule_cursor(owner_id,session_id,scope_hash,control_epoch,semantics,revision_id,event_id,certificate_id,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict(owner_id,session_id,scope_hash) do update set control_epoch=excluded.control_epoch,semantics=excluded.semantics,revision_id=excluded.revision_id,event_id=excluded.event_id,certificate_id=excluded.certificate_id,updated_at=excluded.updated_at`,
       [state.ownerId,state.sessionId,scopeHash,expected,input.semantics,input.view.revisionId,input.event.id,cert.id,serverNow]);
     }
     if(isReminder&&outboxIds.length)await client.query('insert into lba_production_schedule_reminder(owner_id,session_id,occurrence_hash,control_epoch,event_id,recorded_at) values($1,$2,$3,$4,$5,$6)',[state.ownerId,state.sessionId,occurrence(input.view,input.event),expected,input.event.id,serverNow]);
    }
    const receipt:ScheduleEventReceipt={kind:'schedule_event_receipt',eventId:input.event.id,sessionId:state.sessionId,sessionRevision:state.revision,scheduleRevisionId:input.view.revisionId,
     outcome:outboxIds.length?'notification_committed':'ignored',reason,certificateId:cert?.id??null,outboxIds,cancelledPending,recordedAt:serverNow};
    await client.query('insert into lba_production_schedule_event(owner_id,session_id,event_id,control_epoch,input_digest,event,view,view_digest,semantics,certificate_id,receipt,recorded_at) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12)',
     [state.ownerId,state.sessionId,input.event.id,expected,input.digest,JSON.stringify(input.event),JSON.stringify(input.view),input.viewDigest,input.semantics,cert?.id??null,JSON.stringify(receipt),serverNow]);
    for(const id of outboxIds){
     const rows=(await client.query('select owner_id,session_id,input_id,control_epoch,kind,payload from lba_production_profile_outbox where id=$1 for share',[id])).rows;
     if(rows.length!==1||rows[0].owner_id!==state.ownerId||rows[0].session_id!==state.sessionId||rows[0].input_id!=='event:'+input.event.id||!epoch(rows[0].control_epoch,expected)||rows[0].kind!=='notification'||!plain(rows[0].payload)||scheduleEventDigest(rows[0].payload.schedule)!==input.viewDigest)return fail('PERSIST_INVALID');
     await client.query('insert into lba_production_schedule_outbox_proof(outbox_id,owner_id,session_id,event_id,control_epoch,certificate_id,payload_digest,view_digest,recorded_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id,state.ownerId,state.sessionId,input.event.id,expected,cert!.id,scheduleEventDigest(rows[0].payload),input.viewDigest,serverNow]);
    }
    await authorize('before_commit');return {receipt,replayed:false};
   });
  },
  /** Called at prepare, dispatch and native boundaries using the sender's TX.
   * Rechecks policy/window, immutable outbox/event/certificate and current source.
   * It returns a short grant, never invokes a transport or creates a job.
   */
  async verifyDispatch(request:DispatchEligibilityRequest):Promise<CurrentDispatchSourceProof|null>{
   if(!enabled||!verifySource)return null;
   try{
    const {client,job,profile,now,signal}=request;
    if(signal.aborted||!validInstant(now)||job.sourceKind!=='profile'||job.controlEpoch!==expected||job.ownerId!==profile.ownerId||job.sessionId!==profile.sessionId||job.payload.message.kind!=='notification'||!uuid(job.sourceId)||!job.payload.schedule)return null;
    const view=job.payload.schedule;
    const rows=(await client.query(`select p.*,e.event,e.view,e.input_digest,e.view_digest as event_view_digest,e.semantics,e.receipt,e.control_epoch as event_epoch,
     o.payload as outbox_payload,o.owner_id as outbox_owner,o.session_id as outbox_session,o.control_epoch as outbox_epoch,o.input_id,o.kind,o.status
     from lba_production_schedule_outbox_proof p join lba_production_schedule_event e on e.owner_id=p.owner_id and e.session_id=p.session_id and e.event_id=p.event_id
     join lba_production_profile_outbox o on o.id=p.outbox_id where p.outbox_id=$1 for share of p,e,o`,[job.sourceId])).rows;
    if(rows.length!==1)return null;const row=rows[0];
    if(row.owner_id!==profile.ownerId||row.session_id!==profile.sessionId||row.outbox_owner!==profile.ownerId||row.outbox_session!==profile.sessionId||
     [row.control_epoch,row.event_epoch,row.outbox_epoch].some(v=>!epoch(v,expected))||row.kind!=='notification'||!['pending','dispatching'].includes(row.status)||row.input_id!=='event:'+row.event_id||
     row.payload_digest!==scheduleEventDigest(job.payload)||row.payload_digest!==scheduleEventDigest(row.outbox_payload)||row.view_digest!==scheduleEventDigest(view)||row.event_view_digest!==row.view_digest||scheduleEventDigest(row.view)!==row.view_digest||
     !plain(row.receipt)||row.receipt.outcome!=='notification_committed'||!Array.isArray(row.receipt.outboxIds)||!row.receipt.outboxIds.includes(job.sourceId))return null;
    const input=checkedInput(row.event,row.view);if(input.digest!==row.input_digest||input.semantics!==row.semantics||input.event.id!==row.event_id)return null;
    const cert=await certificate(client,profile as BotState,view,now,expected,row.certificate_id);if(!cert)return null;
    const context={actorId:profile.ownerId,now,addresses:[],plans:[]};
    // The engine dedupe vector is intentionally ignored ONLY for read-only
    // transport admission; durable event/outbox proof above supplies identity.
    if(!handleScheduleEvent({...structuredClone(profile),processedEventIds:[]},input.event,view,context).messages.length)return null;
    if(input.event.kind==='reminder'){
     const occurrenceRows=(await client.query('select event_id,control_epoch from lba_production_schedule_reminder where owner_id=$1 and session_id=$2 and occurrence_hash=$3',[profile.ownerId,profile.sessionId,occurrence(view,input.event)])).rows;
     if(occurrenceRows.length!==1||occurrenceRows[0].event_id!==input.event.id||!epoch(occurrenceRows[0].control_epoch,expected))return null;
    }else{
     const cursors=(await client.query('select semantics,control_epoch from lba_production_schedule_cursor where owner_id=$1 and session_id=$2 and scope_hash=$3',[profile.ownerId,profile.sessionId,scope(view)])).rows;
     if(cursors.length!==1||cursors[0].semantics!==input.semantics||!epoch(cursors[0].control_epoch,expected))return null;
    }
    const source=await currentSource(client,view,cert,now,signal);if(!source||signal.aborted)return null;
    const expiresAt=new Date(Math.min(Date.parse(now)+1000,Date.parse(cert.expiresAt),Date.parse(source.expiresAt))).toISOString();
    return {sourceRevision:view.source.revision,expiresAt,eventProof:{kind:input.event.kind==='reminder'?'reminder':'schedule_event',revision:'event-proof:'+scheduleEventDigest([job.sourceId,row.input_digest,row.payload_digest,cert.digest]),
     scheduleRevisionId:view.revisionId,sourceRevision:view.source.revision,serviceDate:view.serviceDate,expiresAt}};
   }catch{return null;}
  },
 });
}
