import {createHash} from 'node:crypto';
import {parseExpressionAt} from 'acorn';
import type {ScheduleView,SourceReference} from '../../shared/product-contract.ts';
import {calendarDate,dayBounds,localParts,nextCalendarDate,validInstant} from '../../shared/schedule-core.ts';
import {normalizeHourMatrix} from './hour-matrix-adapter.ts';
import {uniqueProviderWallMinuteInstant} from './provider-wall-time.ts';

export const ODESA_PLAN_API_SOURCE='dtek-oem-public-plan-ajax' as const;
export const ODESA_PLAN_API_ADAPTER='odesa-plan-api/1' as const;
const AJAX='https://www.dtek-oem.com.ua/ua/ajax' as const;
const sha=(raw:string)=>createHash('sha256').update(raw,'utf8').digest('hex');
const groups=Object.freeze(Array.from({length:6},(_,i)=>[`GPV${i+1}.1`,`GPV${i+1}.2`]).flat());
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)));
export class OdesaPlanApiError extends Error {
 readonly code:string;
 constructor(code:string){super(code==='STALE_OR_FUTURE_CAPTURE'?'Дані плану застаріли або мають некоректний час. Оновіть їх.':'Не вдалося перевірити план оператора. Спробуйте оновити його пізніше.');this.name='OdesaPlanApiError';this.code='ODESA_PLAN_API_'+code;}
}
function fail(code:string):never{throw new OdesaPlanApiError(code);}
function closed(value:unknown,allowed:readonly string[],required=allowed):asserts value is Record<string,unknown>{
 if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))fail('UNKNOWN_SCHEMA');
}
function text(value:unknown,maximum=4096):value is string{return typeof value==='string'&&value.length>0&&value.length<=maximum&&!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);}
/** Existing IANA/core helpers resolve a unique cursor/publication wall minute;
 * ambiguous or nonexistent times never receive an invented offset. */
export function odesaPlanUpdateInstant(value:unknown,asOf:string):string {
 if(typeof value!=='string'||!validInstant(asOf))return fail('INVALID_UPDATE_CURSOR');
 const m=/^(\d{2})\.(\d{2})\.(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
 if(!m)return fail('INVALID_UPDATE_CURSOR');
 let instant:string;try{instant=uniqueProviderWallMinuteInstant(calendarDate(`${m[3]}-${m[2]}-${m[1]}`),Number(m[4])*60+Number(m[5]));}catch{return fail('INVALID_UPDATE_CURSOR');}
 if(Date.parse(instant)>Date.parse(asOf))return fail('FUTURE_UPDATE_CURSOR');return instant;
}
function uniqueJson(raw:unknown):unknown{
 if(typeof raw!=='string'||!raw||Buffer.byteLength(raw,'utf8')>2_000_000||Buffer.from(raw,'utf8').toString('utf8')!==raw)fail('RAW_BODY_LIMIT');
 let depth=0,quoted=false,escaped=false;
 for(const c of raw){if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='['||c==='{'){if(++depth>24)fail('JSON_DEPTH_LIMIT');}else if(c===']'||c==='}')depth--;}
 let parsed:unknown,ast:any;try{parsed=JSON.parse(raw);ast=parseExpressionAt(raw,0,{ecmaVersion:2022});}catch{return fail('INVALID_JSON');}
 const pending=[ast];let count=0;
 while(pending.length){if(++count>100_000)fail('JSON_COMPLEXITY_LIMIT');const node=pending.pop();if(!node||typeof node!=='object')continue;
  if(node.type==='ObjectExpression'){const names=node.properties.map((p:any)=>p.key.value);if(new Set(names).size!==names.length||names.some((key:unknown)=>['__proto__','constructor','prototype'].includes(String(key))))fail('DUPLICATE_OR_UNSAFE_KEY');}
  for(const child of Object.values(node))if(Array.isArray(child))pending.push(...child);else if(child&&typeof child==='object')pending.push(child);
 }return parsed;
}
export interface OdesaPlanApiCapture {
 kind:'odesa-plan-api-capture/1';sourceId:typeof ODESA_PLAN_API_SOURCE;operation:'checkDisconUpdate';
 method:'POST';url:typeof AJAX;httpStatus:200;contentType:string;
 observedAt:string;rawBody:string;rawSha256:string;request:{update:string};
}
export interface OdesaPlanApiPolicy {asOf:string;maximumCaptureAgeMs:number}
export interface OdesaPlanApiProof {
 kind:'odesa-plan-api-proof/1';adapterVersion:typeof ODESA_PLAN_API_ADAPTER;sourceId:typeof ODESA_PLAN_API_SOURCE;
 operation:'checkDisconUpdate';method:'POST';requestUrl:typeof AJAX;request:{update:string};observedAt:string;rawSha256:string;
 queryProvenance:'collector_supplied_not_authenticated_by_adapter';requestScopeEchoedBySource:false;transportAuthenticatedByAdapter:false;
 publicationProvenance:'fact.update_only';sourceAdmission:false;deliveryEligible:false;
}
type Common={kind:'odesa-plan-api-dataset/1';sourceId:typeof ODESA_PLAN_API_SOURCE;proof:OdesaPlanApiProof;sourceAdmission:false;deliveryEligible:false};
export type OdesaPlanApiDataset=Common&(
 {state:'unavailable';reason:'not_changed_or_rejected';scheduleIncluded:false;freshness:'unknown';publication:null;sourceDate:null;dates:readonly [];groupIds:readonly []}|
 {state:'available';scheduleIncluded:true;publication:{literal:string;instant:string;timezone:'Europe/Kyiv'};sourceDate:string;dates:readonly string[];groupIds:readonly string[];display:{showTableSchedule:boolean;showUserGroup:boolean}}
);
function validateCapture(capture:OdesaPlanApiCapture,policy:OdesaPlanApiPolicy){
 closed(policy,['asOf','maximumCaptureAgeMs']);
 if(!validInstant(policy.asOf)||!Number.isSafeInteger(policy.maximumCaptureAgeMs)||policy.maximumCaptureAgeMs<1||policy.maximumCaptureAgeMs>86_400_000)fail('INVALID_POLICY');
 closed(capture,['kind','sourceId','operation','method','url','httpStatus','contentType','observedAt','rawBody','rawSha256','request']);
 if(capture.kind!=='odesa-plan-api-capture/1'||capture.sourceId!==ODESA_PLAN_API_SOURCE||capture.operation!=='checkDisconUpdate'||capture.method!=='POST'||capture.url!==AJAX||capture.httpStatus!==200||typeof capture.contentType!=='string'||!/^application\/json(?:\s*;|$)/i.test(capture.contentType))fail('CAPTURE_SCOPE_MISMATCH');
 if(!validInstant(capture.observedAt))fail('INVALID_OBSERVED_AT');
 const age=Date.parse(policy.asOf)-Date.parse(capture.observedAt);
 if(age<0||age>policy.maximumCaptureAgeMs||localParts(Date.parse(policy.asOf)).date!==localParts(Date.parse(capture.observedAt)).date)fail('STALE_OR_FUTURE_CAPTURE');
 closed(capture.request,['update']);odesaPlanUpdateInstant(capture.request.update,capture.observedAt);
 if(typeof capture.rawBody!=='string'||Buffer.byteLength(capture.rawBody,'utf8')>2_000_000)fail('RAW_BODY_LIMIT');
 if(typeof capture.rawSha256!=='string'||!/^[a-f0-9]{64}$/.test(capture.rawSha256)||typeof capture.rawBody!=='string'||sha(capture.rawBody)!==capture.rawSha256)fail('RAW_HASH_MISMATCH');
 const payload=uniqueJson(capture.rawBody);
 const proof:OdesaPlanApiProof={kind:'odesa-plan-api-proof/1',adapterVersion:ODESA_PLAN_API_ADAPTER,sourceId:ODESA_PLAN_API_SOURCE,operation:'checkDisconUpdate',method:'POST',requestUrl:AJAX,request:{update:capture.request.update},observedAt:capture.observedAt,rawSha256:capture.rawSha256,queryProvenance:'collector_supplied_not_authenticated_by_adapter',requestScopeEchoedBySource:false,transportAuthenticatedByAdapter:false,publicationProvenance:'fact.update_only',sourceAdmission:false,deliveryEligible:false};
 return {payload,proof};
}
const source=(capture:OdesaPlanApiCapture):SourceReference=>({id:ODESA_PLAN_API_SOURCE,name:'ДТЕК Одеські електромережі · публічний JSON-план',url:AJAX,revision:capture.rawSha256,accessCost:0,verifiedLevel:'catalog'});
function normalize(capture:OdesaPlanApiCapture,context:OdesaPlanApiContext):ScheduleView{
 return normalizeHourMatrix(capture.rawBody,{...context,namespace:'dtek:oem-api',operatorId:'dtek-oem',observedAt:capture.observedAt,source:source(capture)});
}
/** Strict pure replay. Byte identity and caller-supplied HTTP metadata never
 * authenticate a capture. The native transport has a separate process handle. */
function read(capture:OdesaPlanApiCapture,policy:OdesaPlanApiPolicy):OdesaPlanApiDataset{
 const {payload,proof}=validateCapture(capture,policy);
 closed(payload,['result','fact','preset','showTableSchedule','showUserGroup'],['result']);
 if(typeof payload.result!=='boolean')fail('INVALID_RESULT_FLAG');
 for(const key of ['showTableSchedule','showUserGroup'])if(Object.hasOwn(payload,key)&&typeof payload[key]!=='boolean')fail('INVALID_DISPLAY_FLAG');
 const common:Common={kind:'odesa-plan-api-dataset/1',sourceId:ODESA_PLAN_API_SOURCE,proof,sourceAdmission:false,deliveryEligible:false};
 const unavailable=():OdesaPlanApiDataset=>({...common,state:'unavailable',reason:'not_changed_or_rejected',scheduleIncluded:false,freshness:'unknown',publication:null,sourceDate:null,dates:[],groupIds:[]});
 if(!payload.result||payload.fact===undefined||payload.fact===null||payload.preset===undefined||payload.preset===null)return unavailable();
 closed(payload.fact,['data','update','today'],[]);closed(payload.preset,['days','days_mini','sch_names','time_zone','time_type','data','updateFact'],[]);
 const fact=payload.fact,preset=payload.preset;
 const missing=(value:unknown)=>value===undefined||value===null||object(value)&&Object.keys(value).length===0||Array.isArray(value)&&value.length===0;
 if(missing(fact.data)||missing(preset.data))return unavailable();
 closed(payload,['result','fact','preset','showTableSchedule','showUserGroup']);
 closed(fact,['data','update','today']);closed(preset,['days','days_mini','sch_names','time_zone','time_type','data','updateFact']);
 if(!object(fact.data))fail('INVALID_FACT_DATA');
 if(!Number.isSafeInteger(fact.today)||Number(fact.today)<0)fail('INVALID_SOURCE_DATE');
 const epoch=Number(fact.today)*1000,sourceDate=localParts(epoch).date;
 if(dayBounds(sourceDate).start!==epoch||sourceDate!==localParts(Date.parse(capture.observedAt)).date)fail('SOURCE_DATE_MISMATCH');
 const publishedAt=odesaPlanUpdateInstant(fact.update,capture.observedAt),cursor=odesaPlanUpdateInstant(capture.request.update,capture.observedAt);
 if(Date.parse(publishedAt)<Date.parse(cursor))fail('PUBLICATION_BEFORE_CURSOR');
 if(preset.updateFact!==fact.update)fail('PUBLICATION_VERSION_MISMATCH');
 const dates=Object.keys(fact.data).map(key=>{
  if(!/^\d{10}$/.test(key))return fail('INVALID_DATE_KEY');const n=Number(key)*1000,date=localParts(n).date;
  if(dayBounds(date).start!==n||![sourceDate,nextCalendarDate(sourceDate)].includes(date))return fail('SOURCE_DATE_SCOPE_DRIFT');return date;
 }).sort();
 if(!dates.includes(sourceDate)||dates.length>2)fail('CURRENT_DAY_MISSING');
 // Weekly presets are validated as protocol data, never used to fill absent
 // dated facts or to manufacture a publication/observation time.
 const days=Array.from({length:7},(_,i)=>String(i+1));
 closed(preset.days,days);closed(preset.days_mini,days);closed(preset.sch_names,groups);closed(preset.data,groups);
 if([...Object.values(preset.days),...Object.values(preset.days_mini),...Object.values(preset.sch_names)].some(v=>!text(v,100)))fail('INVALID_PRESET_LABEL');
 if(!object(preset.time_type))fail('UNKNOWN_LEGEND');
 const legend=Object.keys(preset.time_type),hours=Array.from({length:24},(_,i)=>String(i+1));
 for(const group of groups){closed(preset.data[group],days);for(const day of days){const table=(preset.data[group] as Record<string,unknown>)[day];closed(table,hours);if(Object.values(table).some(v=>typeof v!=='string'||!legend.includes(v)))fail('UNKNOWN_PRESET_HOUR_ENUM');}}
 try{
  for(const serviceDate of dates)for(const targetId of groups)normalize(capture,{targetId,addressId:'source-group:'+targetId,addressLabel:'План групи '+targetId.replace('GPV',''),localityLabel:'Одеська область',serviceDate,freshness:'unknown',synthetic:false});
 }catch(error){if(error instanceof OdesaPlanApiError)throw error;fail('MATRIX_REJECTED');}
 return {...common,state:'available',scheduleIncluded:true,publication:{literal:fact.update as string,instant:publishedAt,timezone:'Europe/Kyiv'},sourceDate,dates,groupIds:[...groups],display:{showTableSchedule:payload.showTableSchedule as boolean,showUserGroup:payload.showUserGroup as boolean}};
}
export function readOdesaPlanApi(capture:OdesaPlanApiCapture,policy:OdesaPlanApiPolicy):OdesaPlanApiDataset{
 try{return read(capture,policy);}catch(error){if(error instanceof OdesaPlanApiError)throw error;return fail('SCHEMA_OR_TIME_REJECTED');}
}
export interface OdesaPlanApiContext {
 targetId:string;addressId:string;addressLabel:string;localityLabel:string;serviceDate:string;freshness:'current'|'stale'|'unknown';synthetic:boolean;
}
export type OdesaPlanApiViewResult={state:'available';view:ScheduleView;proof:OdesaPlanApiProof;sourceAdmission:false;deliveryEligible:false}|
 {state:'unavailable'|'not_published';reason:'not_changed_or_rejected'|'date_not_published';freshness:'unknown';view:null;proof:OdesaPlanApiProof;sourceAdmission:false;deliveryEligible:false};
function checkedPlanContext(context:OdesaPlanApiContext):void {
 closed(context,['targetId','addressId','addressLabel','localityLabel','serviceDate','freshness','synthetic']);
 if(!groups.includes(context.targetId)||!text(context.addressId)||!text(context.addressLabel)||!text(context.localityLabel)||!['current','stale','unknown'].includes(context.freshness)||typeof context.synthetic!=='boolean')fail('INVALID_CONTEXT');
 try{calendarDate(context.serviceDate);}catch{return fail('INVALID_CONTEXT');}
}
function projectPlanContext(capture:OdesaPlanApiCapture,context:OdesaPlanApiContext,dataset:OdesaPlanApiDataset):OdesaPlanApiViewResult {
 const common={view:null,proof:dataset.proof,sourceAdmission:false,deliveryEligible:false,freshness:'unknown'} as const;
 if(dataset.state==='unavailable')return {...common,state:'unavailable',reason:'not_changed_or_rejected'};
 if(![dataset.sourceDate,nextCalendarDate(dataset.sourceDate)].includes(context.serviceDate))fail('SERVICE_DATE_NOT_IN_SOURCE_SCOPE');
 if(!dataset.dates.includes(context.serviceDate))return {...common,state:'not_published',reason:'date_not_published'};
 try{return {state:'available',view:normalize(capture,context),proof:dataset.proof,sourceAdmission:false,deliveryEligible:false};}catch{return fail('MATRIX_REJECTED');}
}
export function normalizeOdesaPlanApi(capture:OdesaPlanApiCapture,context:OdesaPlanApiContext,policy:OdesaPlanApiPolicy):OdesaPlanApiViewResult{
 checkedPlanContext(context);
 return projectPlanContext(capture,context,readOdesaPlanApi(capture,policy));
}
/** One strict full capture read per bounded batch. Contexts remain closed and
 * unique by exact target/date; no caller-supplied proof or global cache exists. */
export function normalizeOdesaPlanApiBatch(capture:OdesaPlanApiCapture,contexts:readonly OdesaPlanApiContext[],policy:OdesaPlanApiPolicy):OdesaPlanApiViewResult[]{
 if(!Array.isArray(contexts)||contexts.length<1||contexts.length>24||Object.keys(contexts).length!==contexts.length)fail('INVALID_BATCH_CONTEXTS');
 const keys=new Set<string>();
 for(const context of contexts){checkedPlanContext(context);const key=JSON.stringify([context.targetId,context.serviceDate]);if(keys.has(key))fail('DUPLICATE_BATCH_TARGET_DATE');keys.add(key);}
 const dataset=readOdesaPlanApi(capture,policy);
 return contexts.map(context=>{const result=projectPlanContext(capture,context,dataset);return {...result,proof:structuredClone(result.proof)};});
}
