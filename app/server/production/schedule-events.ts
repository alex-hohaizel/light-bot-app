import {createHash} from 'node:crypto';
import {INITIAL_LAUNCH_NOTIFICATION_POLICY as LAUNCH} from './deployed-schedule-qualification.ts';
import type {AddressBinding,ScheduleEvent,ScheduleView} from '../../shared/product-contract.ts';
import type {BotState} from '../../shared/bot/types.ts';
import {handleScheduleEvent} from '../../shared/bot/engine.ts';
import {canDeliver,dayBounds,scheduleSemantics,validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
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
interface ScheduleCertificateBase {
 ownerId:string;sessionId:string;controlEpoch:number;issuedAt:string;expiresAt:string;
 view:ScheduleView;binding:AddressBinding;
 sourceEvidence:AcceptedEvidence&{kind:'accepted_source_revision';sourceId:string;sourceRevision:string};
 renewal?:ScheduleRenewalMarker;
}
export type ScheduleCertificateRecord=ScheduleCertificateBase&({
 kind:'lba-certified-schedule/1'|'lba-certified-schedule/2';
 addressEvidence:AcceptedEvidence&{kind:'accepted_address_binding';bindingRevisionId:string;bindingDigest:string};
 parallel48hEvidence:{kind:'accepted_parallel_48h';sourceId:string;operatorId:string;namespace:string;targetId:string;startedAt:string;finishedAt:string;acceptedAt:string;evidenceRef:string};
 initialLaunchEvidence?:never;
}|{
 kind:'lba-certified-schedule/3';
 addressEvidence:AcceptedEvidence&{kind:'accepted_group_selection';bindingRevisionId:string;bindingDigest:string};
 parallel48hEvidence?:never;
 initialLaunchEvidence:{kind:'owner_approved_initial_launch';policyId:typeof LAUNCH.kind;authority:typeof LAUNCH.authority;acceptedAt:string;validUntil:string;selection:'saved_operator_group';buildingVerified:false;physicalStatus:'unknown'};
});
export interface ScheduleRenewalPredecessor {outboxId:string;eventId:string;certificateId:string;certificateDigest:string;inputDigest:string;viewDigest:string;payloadDigest:string;intentDeadline:string}
export interface ScheduleRenewalMarker {kind:'lba-pending-intent-renewal/1';profileRevision:number;controlEpoch:number;predecessors:ScheduleRenewalPredecessor[]}
/** Server-only descriptor. It is never accepted from an HTTP/bot input body. */
export interface ScheduleIntentReplacement {kind:'lba-schedule-intent-replacement/1';previousOutboxId:string;certificateId:string}
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
export function validScheduleCertificateShape(v:unknown):v is ScheduleCertificateRecord {
 const fields=['kind','ownerId','sessionId','controlEpoch','issuedAt','expiresAt','view','binding','sourceEvidence','addressEvidence','parallel48hEvidence'];
 if(!plain(v))return false;
 if(v.kind==='lba-certified-schedule/1')return closed(v,fields);
 if(v.kind==='lba-certified-schedule/3'){const launchFields=fields.filter(k=>k!=='parallel48hEvidence').concat('initialLaunchEvidence');if(!closed(v,v.renewal===undefined?launchFields:[...launchFields,'renewal']))return false;if(v.renewal===undefined)return true;}
 else if(v.kind!=='lba-certified-schedule/2'||!closed(v,[...fields,'renewal']))return false;
 const r=v.renewal;if(!closed(r,['kind','profileRevision','controlEpoch','predecessors'])||r.kind!=='lba-pending-intent-renewal/1'||!int(r.profileRevision)||!epoch(r.controlEpoch,Number(v.controlEpoch))||!Array.isArray(r.predecessors)||r.predecessors.length<1||r.predecessors.length>32)return false;
 return new Set(r.predecessors.map(p=>plain(p)?p.outboxId:null)).size===r.predecessors.length&&r.predecessors.every(p=>closed(p,['outboxId','eventId','certificateId','certificateDigest','inputDigest','viewDigest','payloadDigest','intentDeadline'])&&uuid(p.outboxId)&&uuid(p.certificateId)&&text(p.eventId,128)&&validInstant(p.intentDeadline)&&[p.certificateDigest,p.inputDigest,p.viewDigest,p.payloadDigest].every(hash));
}
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
/** A record cannot choose its own policy or assert a verified building. Runtime
 * source proof is deliberately separate and remains required at event/send time. */
export function validInitialLaunchCertificate(record:ScheduleCertificateRecord,now:string):boolean{
 try{
  if(record.kind!=='lba-certified-schedule/3'||!validScheduleCertificateShape(record)||!validInstant(now))return false;
  const {view,binding,initialLaunchEvidence:e,sourceEvidence:s,addressEvidence:a}=record,n=Date.parse(now),end=Date.parse(record.expiresAt);
  validateScheduleView(view);
  if(!closed(e,['kind','policyId','authority','acceptedAt','validUntil','selection','buildingVerified','physicalStatus'])||e.kind!=='owner_approved_initial_launch'||e.policyId!==LAUNCH.kind||e.authority!==LAUNCH.authority||e.acceptedAt!==LAUNCH.acceptedAt||e.validUntil!==LAUNCH.validUntil||e.selection!=='saved_operator_group'||e.buildingVerified!==false||e.physicalStatus!=='unknown'||
   n<Date.parse(LAUNCH.acceptedAt)||n>=Date.parse(LAUNCH.validUntil)||!validInstant(record.issuedAt)||!validInstant(record.expiresAt)||Date.parse(record.issuedAt)<Date.parse(LAUNCH.acceptedAt)||Date.parse(record.issuedAt)>n||end<=n||end>Date.parse(LAUNCH.validUntil)||end>dayBounds(view.serviceDate).end||
   !LAUNCH.sources.some(p=>p.sourceId===view.source.id&&p.operatorId===view.operatorId&&p.namespace===view.namespace)||
   view.synthetic!==false||view.deliveryEligible!==true||view.source.verifiedLevel!=='initial_launch'||view.freshness!=='current'||!['published','possible','no_planned_outages'].includes(view.status)||view.dayCoverage!=='complete'||Date.parse(view.observedAt)>n||
   binding.status!=='needs_confirmation'||!['user_selected_group','operator_group'].includes(binding.kind)||binding.verifiedAt!==null||binding.addressId!==view.addressId||binding.revisionId!==view.bindingRevisionId||binding.operatorId!==view.operatorId||binding.namespace!==view.namespace||binding.targetId!==view.targetId||
   binding.effectiveFrom!==null&&(!validInstant(binding.effectiveFrom)||Date.parse(binding.effectiveFrom)>n)||binding.effectiveUntil!==null&&(!validInstant(binding.effectiveUntil)||end>Date.parse(binding.effectiveUntil))||
   !evidence(s,'accepted_source_revision',n,end,['sourceId','sourceRevision'])||s.evidenceRef!==LAUNCH.authority+'#'+LAUNCH.kind||s.sourceId!==view.source.id||s.sourceRevision!==view.source.revision||Date.parse(s.acceptedAt)<Date.parse(view.observedAt)||Date.parse(s.acceptedAt)>Date.parse(record.issuedAt)||
   !evidence(a,'accepted_group_selection',n,end,['bindingRevisionId','bindingDigest'])||a.evidenceRef!==s.evidenceRef||a.bindingRevisionId!==binding.revisionId||a.bindingDigest!==scheduleEventDigest(binding)||Date.parse(a.acceptedAt)>Date.parse(record.issuedAt))return false;
  return true;
 }catch{return false;}
}
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
  !validScheduleCertificateShape(record)||record.ownerId!==state.ownerId||record.sessionId!==state.sessionId||record.controlEpoch!==expected||
  !validInstant(record.issuedAt)||!validInstant(record.expiresAt)||instant(row.issued_at)!==instant(record.issuedAt)||instant(row.expires_at)!==instant(record.expiresAt)||
  Date.parse(record.issuedAt)>n||Date.parse(record.expiresAt)<=n||Date.parse(record.issuedAt)>=Date.parse(record.expiresAt)||
  row.view_digest!==scheduleEventDigest(view)||!hash(row.record_digest)||scheduleEventDigest(record)!==row.record_digest||scheduleEventDigest(record.view)!==scheduleEventDigest(view)||scheduleEventDigest(record.binding)!==scheduleEventDigest(binding))return null;
 if(record.kind==='lba-certified-schedule/3')return validInitialLaunchCertificate(record,now)?{id:row.id as string,digest:row.record_digest as string,expiresAt:record.expiresAt,binding:structuredClone(binding),record:structuredClone(record)}:null;
 const end=Date.parse(record.expiresAt),s=record.sourceEvidence,a=record.addressEvidence,p=record.parallel48hEvidence;
 if(!evidence(s,'accepted_source_revision',n,end,['sourceId','sourceRevision'])||s.sourceId!==view.source.id||s.sourceRevision!==view.source.revision||
  !evidence(a,'accepted_address_binding',n,end,['bindingRevisionId','bindingDigest'])||a.bindingRevisionId!==binding.revisionId||a.bindingDigest!==scheduleEventDigest(binding)||
  !closed(p,['kind','sourceId','operatorId','namespace','targetId','startedAt','finishedAt','acceptedAt','evidenceRef'])||p.kind!=='accepted_parallel_48h'||p.sourceId!==view.source.id||
  p.operatorId!==view.operatorId||p.namespace!==view.namespace||p.targetId!==view.targetId||!text(p.evidenceRef,2048)||!validInstant(p.startedAt)||!validInstant(p.finishedAt)||!validInstant(p.acceptedAt)||
  Date.parse(p.finishedAt)-Date.parse(p.startedAt)<48*3600000||Date.parse(p.finishedAt)>Date.parse(p.acceptedAt)||Date.parse(p.acceptedAt)>Date.parse(record.issuedAt)||
  Date.parse(s.acceptedAt as string)>Date.parse(record.issuedAt)||Date.parse(s.acceptedAt as string)<Date.parse(view.observedAt)||
  Date.parse(a.acceptedAt as string)>Date.parse(record.issuedAt)||Date.parse(a.acceptedAt as string)<Date.parse(binding.verifiedAt!))return null;
 return {id:row.id as string,digest:row.record_digest as string,expiresAt:record.expiresAt as string,binding:structuredClone(binding),record:structuredClone(record)};
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

/** Historical receipt validation is deliberately separate from certificate().
 * A revoked predecessor is evidence of a queued intent, NEVER send authority. */
async function sealedIntent(client:LegacyProfileReadQuery,state:BotState,id:string,expected:number,now:string,lock=false){
 const rows=(await client.query(`select o.*,row_to_json(p) as proof,row_to_json(e) as ledger,row_to_json(c) as certificate_row
  from lba_production_profile_outbox o join lba_production_schedule_outbox_proof p on p.outbox_id=o.id
  join lba_production_schedule_event e on e.owner_id=p.owner_id and e.session_id=p.session_id and e.event_id=p.event_id
  join lba_production_schedule_certificate c on c.id=p.certificate_id where o.id=$1${lock?' for update of o':''}`,[id])).rows;
 if(rows.length!==1)return null;const o=rows[0],p=o.proof,e=o.ledger,c=o.certificate_row;
 if(!plain(p)||!plain(e)||!plain(c)||o.owner_id!==state.ownerId||o.session_id!==state.sessionId||o.kind!=='notification'||!['pending','cancelled'].includes(o.status)||!plain(o.payload)||!plain(o.payload.message)||o.payload.message.kind!=='notification'||
  [o.control_epoch,p.control_epoch,e.control_epoch,c.control_epoch].some(v=>!epoch(v,expected))||[p,e,c].some(v=>v.owner_id!==state.ownerId||v.session_id!==state.sessionId)||p.outbox_id!==id||p.event_id!==e.event_id||p.certificate_id!==c.id||e.certificate_id!==c.id||o.input_id!=='event:'+e.event_id)return null;
 let input:ReturnType<typeof checkedInput>,receipt:ScheduleEventReceipt;try{input=checkedInput(e.event,e.view);receipt=checkedReceipt(e.receipt,state,input,now);}catch{return null;}
 const r=c.record,at=instant(e.recorded_at),n=Date.parse(now);
 if(!at||input.event.id!==e.event_id||input.digest!==e.input_digest||input.semantics!==e.semantics||input.viewDigest!==e.view_digest||p.view_digest!==input.viewDigest||c.view_digest!==input.viewDigest||
  p.payload_digest!==scheduleEventDigest(o.payload)||scheduleEventDigest(o.payload.schedule)!==input.viewDigest||receipt.outcome!=='notification_committed'||receipt.certificateId!==c.id||receipt.outboxIds.length!==1||receipt.outboxIds[0]!==id||receipt.recordedAt!==at||
  !validScheduleCertificateShape(r)||!hash(c.record_digest)||scheduleEventDigest(r)!==c.record_digest||scheduleEventDigest(r.view)!==input.viewDigest||r.ownerId!==state.ownerId||r.sessionId!==state.sessionId||r.controlEpoch!==expected||
  c.address_id!==input.view.addressId||c.schedule_revision_id!==input.view.revisionId||c.source_revision!==input.view.source.revision||c.binding_revision_id!==input.view.bindingRevisionId||r.binding.revisionId!==input.view.bindingRevisionId||r.binding.addressId!==input.view.addressId||
  (r.kind!=='lba-certified-schedule/3'&&(r.binding.kind!=='operator_group'||r.binding.status!=='verified'))||r.binding.operatorId!==input.view.operatorId||r.binding.namespace!==input.view.namespace||r.binding.targetId!==input.view.targetId||
  !validInstant(r.issuedAt)||!validInstant(r.expiresAt)||instant(c.issued_at)!==r.issuedAt||instant(c.expires_at)!==r.expiresAt||Date.parse(r.issuedAt)>Date.parse(at)||Date.parse(at)>=Date.parse(r.expiresAt)||
  (r.kind==='lba-certified-schedule/3'?!validInitialLaunchCertificate(r,at):(!validInstant(r.binding.verifiedAt)||Date.parse(r.binding.verifiedAt!)>Date.parse(r.issuedAt)||!validInstant(r.binding.effectiveUntil)||Date.parse(r.expiresAt)>Date.parse(r.binding.effectiveUntil!)))||
  !evidence(r.sourceEvidence,'accepted_source_revision',Date.parse(at),Date.parse(r.expiresAt),['sourceId','sourceRevision'])||r.sourceEvidence.sourceId!==input.view.source.id||r.sourceEvidence.sourceRevision!==input.view.source.revision||
  (r.kind!=='lba-certified-schedule/3'&&(!evidence(r.addressEvidence,'accepted_address_binding',Date.parse(at),Date.parse(r.expiresAt),['bindingRevisionId','bindingDigest'])||r.addressEvidence.bindingRevisionId!==r.binding.revisionId||r.addressEvidence.bindingDigest!==scheduleEventDigest(r.binding)||
  !closed(r.parallel48hEvidence,['kind','sourceId','operatorId','namespace','targetId','startedAt','finishedAt','acceptedAt','evidenceRef'])||r.parallel48hEvidence.kind!=='accepted_parallel_48h'||r.parallel48hEvidence.sourceId!==input.view.source.id||r.parallel48hEvidence.operatorId!==input.view.operatorId||r.parallel48hEvidence.namespace!==input.view.namespace||r.parallel48hEvidence.targetId!==input.view.targetId||
  !validInstant(r.parallel48hEvidence.startedAt)||!validInstant(r.parallel48hEvidence.finishedAt)||!validInstant(r.parallel48hEvidence.acceptedAt)||Date.parse(r.parallel48hEvidence.finishedAt)-Date.parse(r.parallel48hEvidence.startedAt)<48*3600000||Date.parse(r.parallel48hEvidence.finishedAt)>Date.parse(r.parallel48hEvidence.acceptedAt)||Date.parse(r.parallel48hEvidence.acceptedAt)>Date.parse(r.issuedAt))))return null;
 // Ordinary alerts have an existing service-day boundary, not a per-message
 // TTL. Certificate expiry is authority TTL, never an invented intent deadline.
 // For reminders the immutable commit minute supplies the original due window;
 // a later lead-setting change cannot extend that minute.
 const edge=input.event.reminder&&Date.parse(input.event.reminder.edge==='starts'?input.event.reminder.intervalStartsAt:input.event.reminder.intervalEndsAt);
 if(input.event.kind==='reminder'&&(typeof edge!=='number'||edge%60000!==0))return null;
 let deadline=input.event.kind==='reminder'?Math.floor(Date.parse(at)/60000)*60000+60000:dayBounds(input.view.serviceDate).end;
 if(input.event.id.startsWith('replacement:')){
  const parts=/^replacement:([a-f0-9-]{36}):([a-f0-9-]{36}):\d{10}$/.exec(input.event.id);
  const parents=parts&&r.renewal?.predecessors.filter(p=>p.outboxId===parts[1]);
  if(!parts||parts[2]!==c.id||!parents||parents.length!==1||Date.parse(parents[0].intentDeadline)>deadline)return null;
  deadline=Math.min(deadline,Date.parse(parents[0].intentDeadline));
 }
 if(n>=deadline)return null;
 const pin:ScheduleRenewalPredecessor={outboxId:id,eventId:input.event.id,certificateId:c.id as string,certificateDigest:c.record_digest as string,inputDigest:input.digest,viewDigest:input.viewDigest,payloadDigest:p.payload_digest as string,intentDeadline:new Date(deadline).toISOString()};
 return {outbox:o,certificate:c,input,pin};
}

/** Called inside the issuer's existing owner/profile transaction BEFORE any
 * binding cancellation or revocation. Bounded overflow fails before writes.
 * Carry-forward is permitted only from an exact prior marker at the SAME user
 * revision, so pause/resume or another user edit cannot revive cancelled work. */
export async function collectScheduleRenewalPredecessors(input:{client:LegacyProfileReadQuery;state:BotState;view:ScheduleView;now:string;expectedControlEpoch:number}):Promise<ScheduleRenewalPredecessor[]>{
 const {client,state,view,now,expectedControlEpoch:expected}=input;
 const pending=(await client.query(`select o.id from lba_production_profile_outbox o join lba_production_schedule_outbox_proof p on p.outbox_id=o.id
  join lba_production_schedule_event e on e.owner_id=p.owner_id and e.session_id=p.session_id and e.event_id=p.event_id
  where o.owner_id=$1 and o.session_id=$2 and o.address_id=$3 and o.kind='notification' and o.status='pending' and e.view->>'serviceDate'=$4
  order by o.id limit 33 for update of o`,[state.ownerId,state.sessionId,view.addressId,view.serviceDate])).rows;
 if(pending.length>32)return fail('RENEWAL_LIMIT');
 const active=(await client.query(`select record,record_digest,view_digest from lba_production_schedule_certificate where owner_id=$1 and session_id=$2 and address_id=$3 and control_epoch=$4 and revoked_at is null and record->'view'->>'serviceDate'=$5 and issued_at<=$6::timestamptz order by id limit 33 for share`,[state.ownerId,state.sessionId,view.addressId,expected,view.serviceDate,now])).rows;
 if(active.length>32)return fail('RENEWAL_LIMIT');
 const carried=new Map<string,ScheduleRenewalPredecessor>();
 for(const a of active){const r=a.record;if(validScheduleCertificateShape(r)&&hash(a.record_digest)&&scheduleEventDigest(r)===a.record_digest&&scheduleEventDigest(r.view)===a.view_digest&&r.ownerId===state.ownerId&&r.sessionId===state.sessionId&&r.controlEpoch===expected&&r.renewal?.profileRevision===state.revision&&r.renewal.controlEpoch===expected&&scope(r.view)===scope(view)&&scheduleSemantics(r.view)===scheduleSemantics(view))for(const p of r.renewal.predecessors)carried.set(p.outboxId,p);}
 const ids=[...new Set([...pending.map(r=>r.id),...carried.keys()])].sort();if(ids.length>32)return fail('RENEWAL_LIMIT');
 const result:ScheduleRenewalPredecessor[]=[];
 for(const id of ids){const old=await sealedIntent(client,state,id,expected,now,true);if(!old||scope(old.input.view)!==scope(view)||old.input.semantics!==scheduleSemantics(view))continue;
  if(old.outbox.status==='cancelled'&&(!carried.has(id)||scheduleEventDigest(carried.get(id))!==scheduleEventDigest(old.pin)))continue;
  if(old.outbox.status==='pending'&&old.certificate.revoked_at!==null&&!carried.has(id))continue;
  const successor=(await client.query("select event_id from lba_production_schedule_event where owner_id=$1 and session_id=$2 and event_id like $3 and receipt->>'outcome'='notification_committed' limit 1",[state.ownerId,state.sessionId,'replacement:'+id+':%'])).rows;
  if(!successor.length)result.push(old.pin);
 }
 return result;
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
  async commit(principal:VerifiedLegacyPrincipal,event:ScheduleEvent,view:ScheduleView,guard?:ScheduleEventCommitGuard,replacement?:ScheduleIntentReplacement):Promise<{kind:'disabled'}|{receipt:ScheduleEventReceipt;replayed:boolean}>{
   if(!enabled)return {kind:'disabled'};
   if(guard!==undefined&&typeof guard!=='function')return fail('INVALID_GUARD');
   if(replacement!==undefined&&(!closed(replacement,['kind','previousOutboxId','certificateId'])||replacement.kind!=='lba-schedule-intent-replacement/1'||!uuid(replacement.previousOutboxId)||!uuid(replacement.certificateId)||!new RegExp('^replacement:'+replacement.previousOutboxId+':'+replacement.certificateId+':\\d{10}$').test(event.id)))return fail('INVALID_REPLACEMENT');
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
     let predecessor:Awaited<ReturnType<typeof sealedIntent>>=null;
     if(replacement&&cert.id===replacement.certificateId&&cert.record.renewal?.profileRevision===state.revision&&cert.record.renewal.controlEpoch===expected){
      const marker=cert.record.renewal.predecessors.find(p=>p.outboxId===replacement.previousOutboxId);
      if(marker&&Date.parse(marker.intentDeadline)>Date.parse(serverNow)){
       const old=await sealedIntent(client,state,marker.outboxId,expected,serverNow,true);
       const successors=(await client.query("select event_id from lba_production_schedule_event where owner_id=$1 and session_id=$2 and event_id like $3 and receipt->>'outcome'='notification_committed' limit 1",[state.ownerId,state.sessionId,'replacement:'+marker.outboxId+':%'])).rows;
       if(old&&!successors.length&&scheduleEventDigest(old.pin)===scheduleEventDigest(marker)&&old.pin.certificateId!==cert.id&&old.certificate.revoked_at!==null&&scope(old.input.view)===scopeHash&&old.input.semantics===input.semantics&&old.input.event.kind===input.event.kind&&
        (isReminder?reminders.length===1&&reminders[0].event_id===old.input.event.id&&occurrence(old.input.view,old.input.event)===occurrence(input.view,input.event):cursor?.semantics===input.semantics)){
        // The dispatcher prepares before taking the owner fence. Lock existing
        // jobs without waiting/inverting its order; unknown/prepared/attempted
        // work is held, never cloned. A late enrollment is harmless: mandatory
        // owned/native admission sees the cancelled old source after this TX.
        await client.query('savepoint replacement_jobs');let jobs:Record<string,unknown>[]|null=null;
        try{jobs=(await client.query("select * from lba_production_telegram_dispatch_jobs where source_kind='profile' and source_id=$1 order by operation_id limit 33 for update nowait",[marker.outboxId])).rows;await client.query('release savepoint replacement_jobs');}
        catch(error){await client.query('rollback to savepoint replacement_jobs');await client.query('release savepoint replacement_jobs');if((error as {code?:string}).code!=='55P03')throw error;}
        if(jobs&&jobs.length<=32&&jobs.every(j=>j.owner_id===state.ownerId&&j.session_id===state.sessionId&&epoch(j.control_epoch,expected)&&j.state==='pending'&&Number(j.fence)===0&&Number(j.attempts)===0&&j.payload_digest===marker.payloadDigest)){
         const attempts=(await client.query("select 1 from lba_production_telegram_dispatch_attempts a join lba_production_telegram_dispatch_jobs j on j.operation_id=a.operation_id where j.source_kind='profile' and j.source_id=$1 limit 1",[marker.outboxId])).rows;
         if(!attempts.length)predecessor=old;
        }
       }
      }
     }
     if(lineageMismatch)reason='revision_mismatch';
     else if(replacement&&!predecessor)reason='eligibility_or_policy';
     else if(isReminder&&reminders.length&&!predecessor)reason='reminder_already_committed';
     else if(!isReminder&&cursor?.semantics===input.semantics&&!predecessor)reason='semantic_unchanged';
     else {
      // Reuse the full engine, including quiet hours, per-address policy, both
      // reminder edges, duration filters and exact one-minute/DST windows.
      const turn=handleScheduleEvent(state,input.event,input.view,context);reason='eligibility_or_policy';
      if(turn.messages.length){await authorize('before_persist');
       if(predecessor){
        const changed=await client.query("update lba_production_profile_outbox set status='cancelled' where id=$1 and owner_id=$2 and session_id=$3 and status in ('pending','cancelled')",[predecessor.pin.outboxId,state.ownerId,state.sessionId]);if(changed.rowCount!==1)return fail('REPLACEMENT_CONFLICT');
        await client.query("update lba_production_telegram_dispatch_jobs set state='cancelled',last_reason='qualified_intent_replaced',updated_at=$2 where source_kind='profile' and source_id=$1 and state='pending' and fence=0 and attempts=0",[predecessor.pin.outboxId,serverNow]);
       }
       const result=await tx.persistEventTurn({event:input.event,view:input.view});
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
     if(isReminder&&outboxIds.length){
      if(predecessor){const moved=await client.query('update lba_production_schedule_reminder set event_id=$5 where owner_id=$1 and session_id=$2 and occurrence_hash=$3 and control_epoch=$4 and event_id=$6',[state.ownerId,state.sessionId,occurrence(input.view,input.event),expected,input.event.id,predecessor.input.event.id]);if(moved.rowCount!==1)return fail('REPLACEMENT_CONFLICT');}
      else await client.query('insert into lba_production_schedule_reminder(owner_id,session_id,occurrence_hash,control_epoch,event_id,recorded_at) values($1,$2,$3,$4,$5,$6)',[state.ownerId,state.sessionId,occurrence(input.view,input.event),expected,input.event.id,serverNow]);
     }
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
