import {createSourceIntake,SOURCE_PROFILES,type CapturedPublicSourceRaw,type IntakeCode} from './source-intake.ts';
import {technicalDisplaySourceRegistry,odesaPlanApiOperatingRecord} from './source-operating-policy.ts';
import {projectOdesaPlanSnapshot,type OdesaPlanSnapshot} from './odesa-plan-source.ts';
import {ODESA_PLAN_API_SOURCE} from '../domain/odesa-plan-api-adapter.ts';
import {localParts,nextCalendarDate,validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
import {planMatchesDisplay} from '../../shared/schedule-binding.ts';
import type {ScheduleView} from '../../shared/product-contract.ts';
import type {DispatchEligibilityRequest} from './telegram-dispatch.ts';
import type {CurrentDispatchSourceProof} from './telegram-dispatch-eligibility.ts';
import type {LegacyProfileReadQuery} from './profile-reader.ts';

const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const epoch=(v:unknown,expected:number)=>Boolean((typeof v==='number'&&Number.isSafeInteger(v)||typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v))&&Number(v)===expected);
const time=(v:unknown):number|null=>v instanceof Date&&Number.isFinite(v.getTime())?v.getTime():validInstant(v)?Date.parse(v):null;
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const intakeCodes=new Set<string>(['SOURCE_UPDATE_UNCONFIRMED','UNKNOWN_SOURCE','INVALID_REQUEST','SOURCE_SCOPE_MISMATCH','SOURCE_NOT_ADMITTED','SOURCE_ADMISSION_EXPIRED','SOURCE_CLOCK_INVALID','SOURCE_BUSY','SOURCE_RATE_LIMITED','SOURCE_RATE_LIMIT_UNVERIFIED','SOURCE_TIMEOUT','SOURCE_TRANSPORT_FAILED','SOURCE_HTTP_REJECTED','SOURCE_ORIGIN_REJECTED','SOURCE_BODY_LIMIT','SOURCE_CONTENT_TYPE_REJECTED','SOURCE_UTF8_REJECTED','SOURCE_ENCODING_REJECTED','SOURCE_SCHEMA_REJECTED']);
/** Compare source semantics, allowing only the canonical ownership/label binding
 * rewrite and an explicitly WORSE stale label. No certificate is inferred.
 */
function sameRawPlan(shown:ScheduleView,source:ScheduleView):boolean{
 const keys=['contractVersion','revisionId','operatorId','namespace','targetId','serviceDate','timezone','dayCoverage','intervals','previousIntervals','publishedAt','observedAt'] as const;
 const {verifiedLevel:_shown,...shownSource}=shown.source,{verifiedLevel:_source,...rawSource}=source.source;
 if(keys.some(k=>canonical(shown[k]??null)!==canonical(source[k]??null))||canonical(shownSource)!==canonical(rawSource))return false;
 if(shown.freshness==='stale')return shown.status==='stale';
 return shown.freshness==='current'&&source.freshness==='current'&&shown.status===source.status;
}

export interface CurrentRawScheduleRequest {client:LegacyProfileReadQuery;view:Readonly<ScheduleView>;now:string;signal:AbortSignal}
export interface CurrentRawScheduleFact {
 kind:'current_raw_schedule_fact';sourceRevision:string;sourceVerifiedLevel:ScheduleView['source']['verifiedLevel'];expiresAt:string;
 addressBindingVerified:false;deliveryEligible:false;
}
/** SQL-only source facts. Reprojects the current immutable raw snapshot and
 * reports its ACTUAL verification level. Ownership/labels/binding and delivery
 * authority are outside this port. Source verifiedLevel is the sole source
 * attribution field that may differ after an independently accepted DB cert.
 * The fact itself never authorizes either a notification or a personal binding.
 * Caller owns the transaction; this port never creates/releases one or uses IO.
 */
export function createCurrentRawScheduleVerifier(options:{expectedControlEpoch:number;grantTtlMs?:number;odesaPlanApiEnabled?:boolean}){
 const expected=options?.expectedControlEpoch,ttl=options?.grantTtlMs??1000;
 if(options.odesaPlanApiEnabled!==undefined&&typeof options.odesaPlanApiEnabled!=='boolean'||!Number.isSafeInteger(expected)||expected<1||!Number.isInteger(ttl)||ttl<1||ttl>5000)throw Error('INVALID_RUNTIME_SOURCE_PROOF_OPTIONS');
 return async(request:CurrentRawScheduleRequest):Promise<CurrentRawScheduleFact|null>=>{
  try{
   if(!request||request.signal.aborted||!validInstant(request.now))return null;
   const shown=request.view,now=Date.parse(request.now),today=localParts(now).date;
   if(!shown||shown.synthetic!==false||![today,nextCalendarDate(today)].includes(shown.serviceDate)||
    typeof shown.source?.revision!=='string'||! /^[a-f0-9]{64}$/.test(shown.source.revision))return null;
   validateScheduleView(shown as ScheduleView);
   const profile=SOURCE_PROFILES.find(p=>p.sourceId===shown.source.id),registry=technicalDisplaySourceRegistry(true),admission=profile?.sourceId===ODESA_PLAN_API_SOURCE?odesaPlanApiOperatingRecord(options.odesaPlanApiEnabled===true):registry.find(r=>r.sourceId===profile?.sourceId);
   if(!profile||profile.automationBlocked||!admission||admission.state==='blocked'||profile.operatorId!==shown.operatorId||profile.namespace!==shown.namespace||
    now<Date.parse(admission.reviewedAt)||now>=Date.parse(admission.validUntil))return null;
   const control=(await request.client.query('select control_epoch,writer_mode from lba_production_control where id=true')).rows;
   if(control.length!==1||control[0].writer_mode!=='canonical'||!epoch(control[0].control_epoch,expected))return null;
   // Explicit row-lock order matches successful source publication: plan pointer
   // first, then its immutable raw/run, then state. Never acquire an owner lock.
   const plans=(await request.client.query(`select source_id,target_id,service_date::text,raw_id from lba_public_source_plan
    where source_id=$1 and target_id=$2 and service_date=$3::date for share`,[profile.sourceId,shown.targetId,shown.serviceDate])).rows;
   if(plans.length!==1||plans[0].source_id!==profile.sourceId||plans[0].target_id!==shown.targetId||plans[0].service_date!==shown.serviceDate||!uuid(plans[0].raw_id))return null;
   const raws=(await request.client.query('select source_id,run_id,observed_at,snapshot from lba_public_source_raw where id=$1 for share',[plans[0].raw_id])).rows;
   if(raws.length!==1||raws[0].source_id!==profile.sourceId||!uuid(raws[0].run_id)||!plain(raws[0].snapshot))return null;
   const snapshot=raws[0].snapshot as unknown as CapturedPublicSourceRaw|OdesaPlanSnapshot,observed=time(snapshot.observedAt);
   if(profile.sourceId===ODESA_PLAN_API_SOURCE&&((snapshot as OdesaPlanSnapshot).reservationToken!==raws[0].run_id||(snapshot as OdesaPlanSnapshot).controlEpoch!==expected))return null;
   if(observed===null||time(raws[0].observed_at)!==observed||observed>now||snapshot.rawSha256!==shown.source.revision)return null;
   const runs=(await request.client.query('select source_id,control_epoch,status,started_at,finished_at from lba_public_source_run where id=$1 for share',[raws[0].run_id])).rows;
   if(runs.length!==1||runs[0].source_id!==profile.sourceId||runs[0].status!=='published'||!epoch(runs[0].control_epoch,expected))return null;
   const started=time(runs[0].started_at),finished=time(runs[0].finished_at);
   if(started===null||finished===null||started>observed||observed>finished||finished>now)return null;
   const states=(await request.client.query('select last_attempt_at,last_success_at,last_failure from lba_public_source_state where source_id=$1 for share',[profile.sourceId])).rows;
   if(states.length!==1)return null;
   const attempted=time(states[0].last_attempt_at),succeeded=time(states[0].last_success_at),failure=states[0].last_failure;
   if(attempted===null||succeeded===null||attempted>now||succeeded>now||succeeded<observed||failure!==null&&(typeof failure!=='string'||!intakeCodes.has(failure)))return null;
   const failedAfter=failure!==null&&attempted>=observed,superseded=succeeded>observed;
   const stale=failedAfter||superseded||now-observed>=admission.cacheTtlMs;
   const intake=createSourceIntake({registry,now:()=>now,transport:async()=>{throw Error('RUNTIME_SOURCE_PROOF_HTTP_FORBIDDEN');}});
   const sourceRequest={sourceId:profile.sourceId,operatorId:profile.operatorId,namespace:profile.namespace,targetId:shown.targetId!,serviceDate:shown.serviceDate},flags={stale,...(failedAfter?{refreshFailure:failure as IntakeCode}:{})};
   const apiAdmission=profile.sourceId===ODESA_PLAN_API_SOURCE?odesaPlanApiOperatingRecord(options.odesaPlanApiEnabled===true):null;
   const result=apiAdmission?projectOdesaPlanSnapshot(sourceRequest,snapshot,apiAdmission,request.now,flags):intake.projectSnapshot(sourceRequest,snapshot as CapturedPublicSourceRaw,flags);
   if(request.signal.aborted||result.state!=='available'||result.provenance.rawSha256!==shown.source.revision||!sameRawPlan(shown as ScheduleView,result.view))return null;
   return {kind:'current_raw_schedule_fact',sourceRevision:result.provenance.rawSha256,sourceVerifiedLevel:result.view.source.verifiedLevel,
    expiresAt:new Date(Math.min(now+ttl,Date.parse(admission.validUntil),shown.freshness==='current'?observed+admission.cacheTtlMs:Infinity)).toISOString(),addressBindingVerified:false,deliveryEligible:false};
  }catch{return null;}
 };
}

/** Stable interactive verifySource port. Qualified group display is not a
 * notification. Exact raw verification level remains mandatory here; an event
 * grant can only come from the separate certified event/outbox repository.
 */
export function createRuntimeSourceProof(options:{expectedControlEpoch:number;grantTtlMs?:number;odesaPlanApiEnabled?:boolean}){
 const verify=createCurrentRawScheduleVerifier(options),expected=options.expectedControlEpoch;
 return async(request:DispatchEligibilityRequest):Promise<CurrentDispatchSourceProof|null>=>{
  try{
   if(!request||request.signal.aborted||!validInstant(request.now)||request.job.sourceKind!=='profile'||request.job.payload.message.kind!=='schedule'||
    request.job.controlEpoch!==expected||request.job.ownerId!==request.profile.ownerId||request.job.sessionId!==request.profile.sessionId)return null;
   const shown=request.job.payload.schedule;
   if(!shown||shown.deliveryEligible!==false)return null;
   const locations=request.profile.profile.locations.filter(l=>l.address.id===shown.addressId);
   if(locations.length!==1||!planMatchesDisplay(shown,locations[0].binding,request.now))return null;
   const fact=await verify({client:request.client,view:shown,now:request.now,signal:request.signal});
   if(!fact||shown.source.verifiedLevel!==fact.sourceVerifiedLevel)return null;
   return {sourceRevision:fact.sourceRevision,expiresAt:fact.expiresAt};
  }catch{return null;}
 };
}
