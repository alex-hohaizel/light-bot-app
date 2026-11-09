import {createHash} from 'node:crypto';
import {dayBounds,localParts,validInstant} from '../../shared/schedule-core.ts';
import {readOdesaPlanApi,normalizeOdesaPlanApi,normalizeOdesaPlanApiBatch,odesaPlanUpdateInstant,ODESA_PLAN_API_SOURCE,type OdesaPlanApiCapture,type OdesaPlanApiDataset} from '../domain/odesa-plan-api-adapter.ts';
import {createOdesaPublicClient,getOdesaInternalIntake,isNativeOdesaPublicResult,type OdesaBeforeHop,type OdesaHopDescriptor,type OdesaPublicClient,type OdesaRequestProof} from '../providers/odesa-public-client.ts';
import type {SourceIntakeRequest,SourceIntakeResult,IntakeCode} from './source-intake.ts';

export const ODESA_PLAN_ORIGIN='https://www.dtek-oem.com.ua' as const;
const HOME=ODESA_PLAN_ORIGIN+'/ua',AJAX=HOME+'/ajax';
const sha=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
function closed(v:unknown,keys:string[]):asserts v is Record<string,unknown>{if(!plain(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw Error('SOURCE_SCHEMA_REJECTED');}
const evidence=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\p{Cc}\p{Cf}]/u.test(v);
export interface OdesaPlanOperatingRecord {
 kind:'lba-odesa-plan-operating-record/1';sourceId:typeof ODESA_PLAN_API_SOURCE;state:'technical_display';revisionId:string;
 reviewedAt:string;validUntil:string;accessCost:0;costEvidence:string;
 publicationBasis:{kind:'official_public_browser_api';evidence:string};
 robots:{status:'crawler_disallow_observed';evidence:string;interpretation:'not_access_authorization'};
 formalPrimaryDataLicense:'not_observed';providerQuota:'not_published_in_reviewed_sources';
 rate:{kind:'local_operating_budget';scope:'origin';minIntervalMs:7500;evidence:string};
 cacheTtlMs:300000;maxAgeMs:7200000;
 cursorStrategy:'previous_kyiv_day_midnight_complete_matrix';
 addressBindingVerified:false;deliveryEligible:false;parallel48hAccepted:false;independentFallbackVerified:false;
}
export function validOdesaPlanOperatingRecord(a:OdesaPlanOperatingRecord,asOf:string):boolean {
 try{return a.kind==='lba-odesa-plan-operating-record/1'&&a.sourceId===ODESA_PLAN_API_SOURCE&&a.state==='technical_display'&&evidence(a.revisionId)&&validInstant(asOf)&&validInstant(a.reviewedAt)&&validInstant(a.validUntil)&&Date.parse(a.reviewedAt)<=Date.parse(asOf)&&Date.parse(asOf)<Date.parse(a.validUntil)&&a.accessCost===0&&evidence(a.costEvidence)&&a.publicationBasis.kind==='official_public_browser_api'&&evidence(a.publicationBasis.evidence)&&a.robots.status==='crawler_disallow_observed'&&a.robots.interpretation==='not_access_authorization'&&evidence(a.robots.evidence)&&a.formalPrimaryDataLicense==='not_observed'&&a.providerQuota==='not_published_in_reviewed_sources'&&a.rate.kind==='local_operating_budget'&&a.rate.scope==='origin'&&a.rate.minIntervalMs===7500&&evidence(a.rate.evidence)&&a.cacheTtlMs===300000&&a.maxAgeMs===7200000&&a.cursorStrategy==='previous_kyiv_day_midnight_complete_matrix'&&a.addressBindingVerified===false&&a.deliveryEligible===false&&a.parallel48hAccepted===false&&a.independentFallbackVerified===false;}catch{return false;}
}
/** Explicit parent bootstrap strategy, never a pretend cached/publication version.
 * A complete matrix is requested because result:false cannot prove unchanged data. */
export function odesaCompletePlanCursor(asOf:string):string {
 if(!validInstant(asOf))throw Error('SOURCE_CLOCK_INVALID');
 const today=localParts(Date.parse(asOf)).date,previous=localParts(dayBounds(today).start-1).date;
 const [year,month,day]=previous.split('-');return `${day}.${month}.${year} 00:00`;
}
export function odesaPlanRequestIdentity(cursor:string):string {
 return sha(JSON.stringify(['lba-public-plan-request/1',ODESA_PLAN_API_SOURCE,'POST',AJAX,'checkDisconUpdate',[['update',cursor]]]));
}
export interface OdesaPlanSnapshot {
 kind:'lba-odesa-plan-source-raw/1';sourceId:typeof ODESA_PLAN_API_SOURCE;admissionRevisionId:string;
 mode:'standard_fetch_https'|'fixture_unverified';reservationToken:string;controlEpoch:number;
 observedAt:string;rawSha256:string;requestKey:string;capture:OdesaPlanApiCapture;hops:OdesaRequestProof[];
}
function validateHop(h:OdesaRequestProof,index:number,cursor:string){
 closed(h,['stage','method','url','operation','publicFields','requestKey','startedAt','observedAt','responseSha256','responseBytes','responseScopeEchoed','queryBinding']);
 const expected=index===0?{stage:'guest_home',method:'GET',url:HOME,operation:'guest_home',publicFields:{}}:{stage:'plan_update',method:'POST',url:AJAX,operation:'checkDisconUpdate',publicFields:{update:cursor}};
 for(const k of ['stage','method','url','operation','publicFields'] as const)if(JSON.stringify(h[k])!==JSON.stringify(expected[k]))throw Error('SOURCE_SCOPE_MISMATCH');
 if(h.requestKey!==sha(JSON.stringify([expected.method,expected.url,expected.operation,index===0?[]:[['update',cursor]]])))throw Error('SOURCE_SCOPE_MISMATCH');
 if(!validInstant(h.startedAt)||!validInstant(h.observedAt)||Date.parse(h.startedAt)>Date.parse(h.observedAt)||!/^[a-f0-9]{64}$/.test(h.responseSha256)||!/^[a-f0-9]{64}$/.test(h.requestKey)||!Number.isSafeInteger(h.responseBytes)||h.responseBytes<1||h.responseBytes>(index===0?1000000:2000000)||h.responseScopeEchoed!==false||h.queryBinding!=='internal_request_builder')throw Error('SOURCE_SCHEMA_REJECTED');
}
export function readOdesaPlanSnapshot(raw:unknown,a:OdesaPlanOperatingRecord,asOf:string,allowFixture=false):{snapshot:OdesaPlanSnapshot;dataset:OdesaPlanApiDataset}{
 if(!validOdesaPlanOperatingRecord(a,asOf))throw Error('SOURCE_NOT_ADMITTED');
 closed(raw,['kind','sourceId','admissionRevisionId','mode','reservationToken','controlEpoch','observedAt','rawSha256','requestKey','capture','hops']);
 const s=raw as unknown as OdesaPlanSnapshot;
 if(s.kind!=='lba-odesa-plan-source-raw/1'||s.sourceId!==ODESA_PLAN_API_SOURCE||s.admissionRevisionId!==a.revisionId||s.mode!=='standard_fetch_https'&&!(allowFixture&&s.mode==='fixture_unverified')||!uuid(s.reservationToken)||!Number.isSafeInteger(s.controlEpoch)||s.controlEpoch<1||!validInstant(s.observedAt)||!Array.isArray(s.hops)||s.hops.length!==2)throw Error('SOURCE_SCHEMA_REJECTED');
 const dataset=readOdesaPlanApi(s.capture,{asOf,maximumCaptureAgeMs:a.maxAgeMs});
 if(s.observedAt!==s.capture.observedAt||s.rawSha256!==s.capture.rawSha256||s.requestKey!==odesaPlanRequestIdentity(s.capture.request.update)||Date.parse(s.observedAt)<Date.parse(a.reviewedAt))throw Error('SOURCE_SCOPE_MISMATCH');
 s.hops.forEach((hop,index)=>validateHop(hop,index,s.capture.request.update));
 if(s.hops[1].observedAt!==s.observedAt||s.hops[1].responseSha256!==s.rawSha256||s.hops[1].responseBytes!==Buffer.byteLength(s.capture.rawBody,'utf8')||Date.parse(s.hops[1].startedAt)-Date.parse(s.hops[0].startedAt)<7500||Date.parse(s.hops[0].observedAt)>Date.parse(s.hops[1].startedAt)||Date.parse(s.hops[1].observedAt)-Date.parse(s.hops[0].startedAt)>30000)throw Error('SOURCE_SCHEMA_REJECTED');
 return {snapshot:structuredClone(s),dataset};
}
export function projectOdesaPlanSnapshot(request:SourceIntakeRequest,raw:unknown,a:OdesaPlanOperatingRecord,asOf:string,flags:{stale?:boolean;refreshFailure?:IntakeCode}={},allowFixture=false):SourceIntakeResult {
 const rejected=(code:IntakeCode):SourceIntakeResult=>({state:'unavailable',sourceId:ODESA_PLAN_API_SOURCE,code,view:null,addressBindingVerified:false,deliveryEligible:false});
 try{
  if(request.sourceId!==ODESA_PLAN_API_SOURCE||request.operatorId!=='dtek-oem'||request.namespace!=='dtek:oem')return rejected('SOURCE_SCOPE_MISMATCH');
  const {snapshot:s,dataset}=readOdesaPlanSnapshot(raw,a,asOf,allowFixture);
  if(dataset.state!=='available')return rejected('SOURCE_UPDATE_UNCONFIRMED');
  const stale=flags.stale||Date.parse(asOf)-Date.parse(s.observedAt)>=a.cacheTtlMs;
  const result=normalizeOdesaPlanApi(s.capture,{targetId:request.targetId,addressId:'source-group:'+request.targetId,addressLabel:'План групи '+request.targetId.replace(/^GPV/,''),localityLabel:'Одеська область',serviceDate:request.serviceDate,freshness:stale?'stale':'current',synthetic:s.mode==='fixture_unverified'},{asOf,maximumCaptureAgeMs:a.maxAgeMs});
  if(result.state!=='available')return rejected('SOURCE_UPDATE_UNCONFIRMED');
  return {state:'available',cache:stale?'stale':'fresh',view:result.view,provenance:{sourceId:ODESA_PLAN_API_SOURCE,admissionRevisionId:a.revisionId,requestedUrl:AJAX,responseUrl:AJAX,rawSha256:s.rawSha256,rawBytes:Buffer.byteLength(s.capture.rawBody,'utf8'),observedAt:s.observedAt,publishedAt:dataset.publication.instant,transport:s.mode==='fixture_unverified'?'fixture_guest_api':'native_guest_api',operatingAdmission:{scope:'technical_group_display',publicationBasis:'official_public_browser_api',formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources'}},...(flags.refreshFailure?{refreshFailure:flags.refreshFailure}:{}),addressBindingVerified:false,deliveryEligible:false};
 }catch{return rejected('SOURCE_SCHEMA_REJECTED');}
}
/** Transaction-local batch only. The envelope is checked once and the leaf
 * validates the complete JSON dataset once per bounded batch. No global cache,
 * mutable trusted handle or weaker capture path is introduced. */
export function projectOdesaPlanSnapshotBatch(requests:readonly SourceIntakeRequest[],raw:unknown,a:OdesaPlanOperatingRecord,asOf:string,flags:{stale?:boolean;refreshFailure?:IntakeCode}={},allowFixture=false):SourceIntakeResult[]{
 const rejected=(code:IntakeCode):SourceIntakeResult=>({state:'unavailable',sourceId:ODESA_PLAN_API_SOURCE,code,view:null,addressBindingVerified:false,deliveryEligible:false});
 if(!Array.isArray(requests)||requests.length<1||requests.length>24)return [];
 try{
  if(requests.some(request=>request.sourceId!==ODESA_PLAN_API_SOURCE||request.operatorId!=='dtek-oem'||request.namespace!=='dtek:oem'))return requests.map(()=>rejected('SOURCE_SCOPE_MISMATCH'));
  const {snapshot:s,dataset}=readOdesaPlanSnapshot(raw,a,asOf,allowFixture);
  if(dataset.state!=='available')return requests.map(()=>rejected('SOURCE_UPDATE_UNCONFIRMED'));
  const stale=Boolean(flags.stale)||Date.parse(asOf)-Date.parse(s.observedAt)>=a.cacheTtlMs;
  const contexts=requests.map(request=>({targetId:request.targetId,addressId:'source-group:'+request.targetId,addressLabel:'План групи '+request.targetId.replace(/^GPV/,''),localityLabel:'Одеська область',serviceDate:request.serviceDate,freshness:stale?'stale' as const:'current' as const,synthetic:s.mode==='fixture_unverified'}));
  const results=normalizeOdesaPlanApiBatch(s.capture,contexts,{asOf,maximumCaptureAgeMs:a.maxAgeMs});
  return results.map(result=>result.state!=='available'?rejected('SOURCE_UPDATE_UNCONFIRMED'):{state:'available',cache:stale?'stale':'fresh',view:result.view,provenance:{sourceId:ODESA_PLAN_API_SOURCE,admissionRevisionId:a.revisionId,requestedUrl:AJAX,responseUrl:AJAX,rawSha256:s.rawSha256,rawBytes:Buffer.byteLength(s.capture.rawBody,'utf8'),observedAt:s.observedAt,publishedAt:dataset.publication.instant,transport:s.mode==='fixture_unverified'?'fixture_guest_api':'native_guest_api',operatingAdmission:{scope:'technical_group_display',publicationBasis:'official_public_browser_api',formalPrimaryDataLicense:'not_observed',providerQuota:'not_published_in_reviewed_sources'}},...(flags.refreshFailure?{refreshFailure:flags.refreshFailure}:{}),addressBindingVerified:false,deliveryEligible:false});
 }catch{return requests.map(()=>rejected('SOURCE_SCHEMA_REJECTED'));}
}
type Factory=(hook:OdesaBeforeHop)=>OdesaPublicClient;
function acquisition(factory:Factory,fixture:boolean){return Object.freeze({async acquire(input:{cursor:string;signal:AbortSignal;beforeHop:OdesaBeforeHop;reservationToken:string;controlEpoch:number;admission:OdesaPlanOperatingRecord;now:()=>string}):Promise<OdesaPlanSnapshot>{
 const captured={cursor:input.cursor,signal:input.signal,beforeHop:input.beforeHop,reservationToken:input.reservationToken,controlEpoch:input.controlEpoch,admission:structuredClone(input.admission),now:input.now};
 input=captured;
 if(!validOdesaPlanOperatingRecord(input.admission,input.now())||!uuid(input.reservationToken)||!Number.isSafeInteger(input.controlEpoch)||input.controlEpoch<1)throw Error('SOURCE_NOT_ADMITTED');
 odesaPlanUpdateInstant(input.cursor,input.now());let hops=0;
 const client=factory(async(descriptor,signal)=>{
  if(input.signal.aborted||signal.aborted||hops>=2)throw Error('SOURCE_ORIGIN_REJECTED');
  const expected=hops===0?{stage:'guest_home',method:'GET',url:HOME,operation:'guest_home',publicFields:{},orderedPublicFields:[]}:{stage:'plan_update',method:'POST',url:AJAX,operation:'checkDisconUpdate',publicFields:{update:input.cursor},orderedPublicFields:[['update',input.cursor]]};
  for(const key of ['stage','method','url','operation','publicFields','orderedPublicFields'] as const)if(JSON.stringify(descriptor[key])!==JSON.stringify(expected[key]))throw Error('SOURCE_ORIGIN_REJECTED');
  if(descriptor.requestKey!==sha(JSON.stringify([expected.method,expected.url,expected.operation,expected.orderedPublicFields])))throw Error('SOURCE_ORIGIN_REJECTED');
  const decision=await input.beforeHop(descriptor,signal);if(decision!==undefined)throw Error('SOURCE_ORIGIN_REJECTED');if(input.signal.aborted||signal.aborted)throw Error('SOURCE_TIMEOUT');hops++;
 });
 const result=await client.planUpdate(input.cursor,input.signal),internal=getOdesaInternalIntake(result);
 // Process-native provenance is checked before serializing. A DTO/clone cannot
 // turn a fixture into native evidence. Persisted SQL still relies on trusted storage.
 if(input.signal.aborted||hops!==2||result.kind!=='odesa-public-plan-update/1'||!internal||internal.basis!=='plan_update/1'||!internal.captures.plan||internal.mode!==(fixture?'fixture_unverified':'standard_fetch_https')||!fixture&&!isNativeOdesaPublicResult(result))throw Error('SOURCE_SCOPE_MISMATCH');
 const capture=structuredClone(internal.captures.plan),snapshot:OdesaPlanSnapshot={kind:'lba-odesa-plan-source-raw/1',sourceId:ODESA_PLAN_API_SOURCE,admissionRevisionId:input.admission.revisionId,mode:internal.mode,reservationToken:input.reservationToken,controlEpoch:input.controlEpoch,observedAt:capture.observedAt,rawSha256:capture.rawSha256,requestKey:odesaPlanRequestIdentity(input.cursor),capture,hops:structuredClone([...result.transport.requests])};
 readOdesaPlanSnapshot(snapshot,input.admission,input.now(),fixture);return snapshot;
 }});}
export const createOdesaPlanSource=()=>acquisition(hook=>createOdesaPublicClient({beforeHop:hook}),false);
/** Explicitly untrusted seam; production callers cannot inject a transport. */
export const createOdesaPlanSourceForFixtures=(factory:Factory)=>acquisition(factory,true);
