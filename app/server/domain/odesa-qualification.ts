import {createHash} from 'node:crypto';
import {parseExpressionAt} from 'acorn';
import {buildOdesaStreetRowCandidate,type OdesaAjaxCapture} from './odesa-address-adapter.ts';
import {normalizeHourMatrix} from './hour-matrix-adapter.ts';
import {normalizeOdesaPlanApi,ODESA_PLAN_API_SOURCE} from './odesa-plan-api-adapter.ts';
import {readOdesaPlanSnapshot,projectOdesaPlanSnapshot,validOdesaPlanOperatingRecord,type OdesaPlanOperatingRecord} from '../production/odesa-plan-source.ts';
import {dayBounds,localParts,nextCalendarDate,validInstant} from '../../shared/schedule-core.ts';
import type {ScheduleView} from '../../shared/product-contract.ts';

export interface OdesaQualificationPin {path:string;sha256:string}
export interface OdesaQualificationAdmission {
 sourceId:string;operatorId:string;namespace:string;reviewedAt:string;validUntil:string;medium:'observed'|'synthetic_fixture';
 addressIds:ReadonlySet<string>|null;targetIds:ReadonlySet<string>;startedAt:string;finishedAt:string;
}
type Format='odesa_typed_plan_snapshot/1'|'odesa_mirror_matrix/1'|'odesa_official_public_projection/1';
type Role='primary'|'fallback'|'control';
const API='https://www.dtek-oem.com.ua/ua/ajax',PAGE='https://www.dtek-oem.com.ua/ua/shutdowns';
const MIRROR='https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/odesa.json';
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const closed=(v:unknown,keys:string[]):v is Record<string,any>=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const fail=(code:string):never=>{throw Error('SCHEDULE_CERTIFICATION_'+code);};
const scope=(v:ScheduleView)=>({operatorId:v.operatorId,namespace:v.namespace,targetId:v.targetId,serviceDate:v.serviceDate,status:v.status,dayCoverage:v.dayCoverage,intervals:v.intervals});
const pin=(v:unknown):v is OdesaQualificationPin=>closed(v,['path','sha256'])&&text(v.path)&&hex(v.sha256);
function context(c:{addressId:string;targetId:string;serviceDate:string;observedAt:string}){
 if(!text(c.addressId)||!/^GPV[1-6]\.[12]$/.test(c.targetId)||!validInstant(c.observedAt))return fail('OBSERVATION_SCOPE_INVALID');
 dayBounds(c.serviceDate);const today=localParts(Date.parse(c.observedAt)).date;
 if(![today,nextCalendarDate(today)].includes(c.serviceDate))return fail('OBSERVATION_DAY_INVALID');
}
/** Preserve raw evidence until decoded duplicate/unsafe keys have been checked.
 * JSON.parse alone erases duplicate keys before a derived control is serialized.
 * The same no-eval Acorn walk as the typed adapters is applied to every NEW v2
 * JSON boundary. The larger node cap accommodates bounded bundle inventories. */
export function parseOdesaQualificationJson(raw:Buffer):unknown{
 if(!Buffer.isBuffer(raw)||raw.length>2_000_000)return fail('JSON_BOUNDS');
 let source:string,value:unknown;
 try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);value=JSON.parse(source);}catch{return fail('JSON_INVALID');}
 let depth=0,quoted=false,escaped=false;
 for(const c of source){if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='['||c==='{'){if(++depth>24)return fail('JSON_BOUNDS');}else if(c===']'||c==='}')depth--;}
 let ast:any;try{ast=parseExpressionAt(source,0,{ecmaVersion:2022});}catch{return fail('JSON_INVALID');}
 const pending:any[]=[ast];let nodes=0;
 while(pending.length){if(++nodes>1_000_000)return fail('JSON_BOUNDS');const node=pending.pop();if(!node||typeof node!=='object')continue;
  if(node.type==='Literal'&&(typeof node.value==='number'&&!Number.isFinite(node.value)||typeof node.value==='string'&&Buffer.from(node.value,'utf8').toString('utf8')!==node.value))return fail('JSON_INVALID');
  if(node.type==='ObjectExpression'){const names=node.properties.map((p:any)=>p.key.value);
   if(new Set(names).size!==names.length||names.some((k:unknown)=>['__proto__','constructor','prototype'].includes(String(k))))return fail('JSON_DUPLICATE_OR_UNSAFE_KEY');}
  for(const child of Object.values(node))if(Array.isArray(child))pending.push(...child);else if(child&&typeof child==='object')pending.push(child);
 }
 return value;
}
const json=parseOdesaQualificationJson;
/** Fixed parser dispatch. These are offline pure replays, never HTTP/native or
 * SQL-reservation attestations. Caller supplies only its bounded pinned reader. */
export async function replayOdesaQualificationPlan(input:{format:Format;artifact:OdesaQualificationPin;operatingRecord:OdesaQualificationPin|null;
 addressId:string;targetId:string;serviceDate:string;observedAt:string;medium:'observed'|'synthetic_fixture';read:(pin:OdesaQualificationPin)=>Promise<Buffer>}):Promise<{state:'available';plan:ReturnType<typeof scope>;publishedAt:string|null}|{state:'unavailable'|'not_published'}>{
 context(input);if(!pin(input.artifact)||input.operatingRecord!==null&&!pin(input.operatingRecord))return fail('FILE_PIN_INVALID');
 const raw=await input.read(input.artifact),c={targetId:input.targetId,addressId:input.addressId,addressLabel:input.addressId,localityLabel:'Одеська область',serviceDate:input.serviceDate,freshness:'current' as const,synthetic:input.medium==='synthetic_fixture'};
 if(input.format==='odesa_typed_plan_snapshot/1'){
  if(!input.operatingRecord)return fail('OPERATING_RECORD_REQUIRED');
  const record=json(await input.read(input.operatingRecord)) as OdesaPlanOperatingRecord;
  const {snapshot}=readOdesaPlanSnapshot(json(raw),record,input.observedAt,input.medium==='synthetic_fixture');
  if(snapshot.observedAt!==input.observedAt)return fail('OBSERVATION_FACT_MISMATCH');
  const result=normalizeOdesaPlanApi(snapshot.capture,c,{asOf:input.observedAt,maximumCaptureAgeMs:record.maxAgeMs});
  if(result.state!=='available')return {state:result.state};
  const projected=projectOdesaPlanSnapshot({sourceId:ODESA_PLAN_API_SOURCE,operatorId:'dtek-oem',namespace:'dtek:oem',targetId:input.targetId,serviceDate:input.serviceDate},snapshot,record,input.observedAt,{},input.medium==='synthetic_fixture');
  if(projected.state!=='available'||!equal(scope(result.view),scope(projected.view)))return fail('PRIMARY_REPROJECTION_MISMATCH');
  return {state:'available',plan:scope(projected.view),publishedAt:projected.view.publishedAt};
 }
 if(input.operatingRecord!==null)return fail('OPERATING_RECORD_UNEXPECTED');
 let body:string,namespace:'dtek:oem'|'dtek:oem-mirror',sourceId:string,url:string;
 if(input.format==='odesa_mirror_matrix/1'){
  json(raw);body=raw.toString('utf8');namespace='dtek:oem-mirror';sourceId='mirror-odesa';url=MIRROR;
 }else if(input.format==='odesa_official_public_projection/1'){
  const p=json(raw);
  if(!closed(p,['kind','sourceUrl','observedAt','extraction','originalArtifactSha256','originalArtifactRetained','fact','preset','extractionEvidence'])||p.kind!=='lba-odesa-public-plan-projection/1'||p.sourceUrl!==PAGE||p.observedAt!==input.observedAt||p.extraction!=='public_fact_preset_only'||p.originalArtifactRetained!==false||p.originalArtifactSha256!==null&&!hex(p.originalArtifactSha256)||!plain(p.fact)||!plain(p.preset)||!pin(p.extractionEvidence))return fail('CONTROL_PROJECTION_INVALID');
  if(!(await input.read(p.extractionEvidence)).length)return fail('CONTROL_EXTRACTION_EVIDENCE_EMPTY');
  // Only JSON values are serialized into exact assignments; never evaluate
  // arbitrary JavaScript, HTML, URLs or a caller-selected parser.
  const safe=(v:unknown)=>JSON.stringify(v).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
  body='<script>DisconSchedule.fact = '+safe(p.fact)+'; DisconSchedule.preset = '+safe(p.preset)+';</script>';
  namespace='dtek:oem';sourceId='dtek-oem-official';url=PAGE;
 }else return fail('UNSUPPORTED_SOURCE_FORMAT');
 const view=normalizeHourMatrix(body,{...c,namespace,operatorId:'dtek-oem',observedAt:input.observedAt,source:{id:sourceId,name:'Одеська область · offline qualification replay',url,revision:hash(body),accessCost:0,verifiedLevel:'schedule'}});
 return view.status==='not_published'?{state:'not_published'}:{state:'available',plan:scope(view),publishedAt:view.publishedAt};
}

/** Closed v2 Odesa bundle. The only production trust ingress remains the
 * caller's source-owned deployed pins and branded registry. */
export async function loadReviewedOdesaQualification(input:{bundle:unknown;receipt:unknown;bundleSha256:string;purpose?:'production'|'synthetic_test';
 codeDependencies:readonly string[];read:(pin:OdesaQualificationPin)=>Promise<Buffer>;digest:(value:unknown)=>string}):Promise<OdesaQualificationAdmission>{
 const b=input.bundle,r=input.receipt;
 if(!closed(b,['kind','contract','sourceId','operatorId','namespace','reviewedAt','validUntil','medium','codePins','primary','fallback','control','coverage','addresses','observations','maximumObservationGapMs','negativeFixtures'])||b.kind!=='lba-reviewed-schedule-qualification/2'||b.contract!=='dtek-oem-house-group/1'||b.sourceId!==ODESA_PLAN_API_SOURCE||b.operatorId!=='dtek-oem'||b.namespace!=='dtek:oem'||!['observed','synthetic_fixture'].includes(b.medium)||b.medium==='synthetic_fixture'&&input.purpose!=='synthetic_test'||input.purpose==='synthetic_test'&&b.medium!=='synthetic_fixture'||!validInstant(b.reviewedAt)||!validInstant(b.validUntil)||Date.parse(b.validUntil)<=Date.parse(b.reviewedAt)||!Number.isSafeInteger(b.maximumObservationGapMs)||b.maximumObservationGapMs<60000||b.maximumObservationGapMs>86400000)return fail('BUNDLE_INVALID');
 const inventory={contract:b.contract,sourceId:b.sourceId,operatorId:b.operatorId,namespace:b.namespace,codePins:b.codePins,primary:b.primary,fallback:b.fallback,control:b.control,coverage:b.coverage,addresses:b.addresses,observations:b.observations,maximumObservationGapMs:b.maximumObservationGapMs,negativeFixtures:b.negativeFixtures};
 if(!closed(r,['kind','bundleSha256','reviewer','reviewedAt','medium','inventorySha256'])||r.kind!=='lba-independent-qualification-review/2'||r.bundleSha256!==input.bundleSha256||!text(r.reviewer)||r.medium!==b.medium||r.reviewedAt!==b.reviewedAt||r.inventorySha256!==input.digest(inventory))return fail('REVIEW_RECEIPT_MISMATCH');
 if(!Array.isArray(b.codePins)||b.codePins.length!==input.codeDependencies.length||b.codePins.length>64||input.codeDependencies.some(k=>b.codePins.filter((p:any)=>p?.path===k).length!==1))return fail('CODE_INVENTORY_INCOMPLETE');
 for(const p of b.codePins)await input.read(p);
 const rawCache=new Map<string,Buffer>();
 const read=async(p:OdesaQualificationPin)=>{if(!pin(p))return fail('FILE_PIN_INVALID');const key=p.path+'\0'+p.sha256;let raw=rawCache.get(key);if(!raw){raw=await input.read(p);rawCache.set(key,raw);}return raw;};
 const value=async(p:OdesaQualificationPin)=>json(await read(p));
 const roles=['primary','fallback','control'] as const;
 for(const role of roles){const route=b[role];
  if(!closed(route,['endpoint','upstreamChain','acquisitionId','accessCost','evidence','format'])||!text(route.endpoint)||!Array.isArray(route.upstreamChain)||!route.upstreamChain.length||route.upstreamChain.length>30||route.upstreamChain.some((s:unknown)=>!text(s))||!text(route.acquisitionId)||route.accessCost!==0||!text(route.evidence))return fail('PROVENANCE_INVALID');
  const allowed=role==='primary'?route.format==='odesa_typed_plan_snapshot/1'&&route.endpoint===API:role==='fallback'?route.format==='odesa_mirror_matrix/1'&&route.endpoint===MIRROR:route.format==='odesa_typed_plan_snapshot/1'&&route.endpoint===API||route.format==='odesa_official_public_projection/1'&&route.endpoint===PAGE;
  if(!allowed)return fail('UNSUPPORTED_SOURCE_FORMAT');
 }
 if(new Set(roles.map(role=>b[role].acquisitionId)).size!==3)return fail('CONTROL_NOT_INDEPENDENTLY_ACQUIRED');
 if(!closed(b.coverage,['kind','addressIds'])||!['representative','exact_addresses'].includes(b.coverage.kind)||!Array.isArray(b.coverage.addressIds)||!b.coverage.addressIds.length||new Set(b.coverage.addressIds).size!==b.coverage.addressIds.length||b.coverage.addressIds.some((id:unknown)=>!text(id))||b.coverage.kind==='representative'&&b.coverage.addressIds.length<20||!Array.isArray(b.addresses)||b.addresses.length!==b.coverage.addressIds.length)return fail('ADDRESS_COVERAGE_INCOMPLETE');
 const targets=new Map<string,string>();
 for(const a of b.addresses){
  if(!closed(a,['addressId','selection','targetId','selectionBasis','scope','captures'])||!closed(a.selection,['cityKey','streetKey','houseKey'])||!closed(a.captures,['catalog','houses'])||a.selectionBasis!=='street_row/1'||a.scope!=='operator_house_group'||targets.has(a.addressId)||!b.coverage.addressIds.includes(a.addressId))return fail('ADDRESS_EVIDENCE_INVALID');
  const catalog=await value(a.captures.catalog) as OdesaAjaxCapture,houses=await value(a.captures.houses) as OdesaAjaxCapture;
  const built=buildOdesaStreetRowCandidate({basis:'street_row/1',selection:{city:a.selection.cityKey,street:a.selection.streetKey,house:a.selection.houseKey},captures:{catalog,houses},policy:{asOf:houses.observedAt,maximumCaptureAgeMs:86400000}});
  if(built.address.id!==a.addressId||built.bindingChoices.length!==1||built.bindingChoices[0].targetId!==a.targetId||Date.parse(houses.observedAt)>Date.parse(b.reviewedAt))return fail('ADDRESS_SCOPE_MISMATCH');
  targets.set(a.addressId,a.targetId);
 }
 if(!Array.isArray(b.observations)||!b.observations.length||b.observations.length>20000||!Array.isArray(b.negativeFixtures)||b.negativeFixtures.length<3||b.negativeFixtures.length>100)return fail('OBSERVATIONS_INVALID');
 const times=new Map<string,number[]>(),all:number[]=[];
 for(const o of b.observations){
  if(!closed(o,['addressId','targetId','serviceDate','observedAt','primary','fallback','control'])||targets.get(o.addressId)!==o.targetId||!validInstant(o.observedAt)||Date.parse(o.observedAt)>Date.parse(b.reviewedAt))return fail('OBSERVATION_SCOPE_INVALID');
  context({addressId:o.addressId,targetId:o.targetId,serviceDate:o.serviceDate,observedAt:o.observedAt});const parsed:unknown[]=[];
  for(const role of roles){const f=await value(o[role]);
   if(!closed(f,['kind','acquisitionId','observedAt','addressId','targetId','serviceDate','artifact','operatingRecord','plan'])||f.kind!=='lba-observed-plan-fact/2'||f.acquisitionId!==b[role].acquisitionId||f.observedAt!==o.observedAt||f.addressId!==o.addressId||f.targetId!==o.targetId||f.serviceDate!==o.serviceDate||!closed(f.plan,['operatorId','namespace','targetId','serviceDate','status','dayCoverage','intervals'])||f.plan.operatorId!==b.operatorId||f.plan.namespace!==b.namespace||f.plan.targetId!==o.targetId||f.plan.serviceDate!==o.serviceDate)return fail('OBSERVATION_FACT_MISMATCH');
   const replay=await replayOdesaQualificationPlan({format:b[role].format,artifact:f.artifact,operatingRecord:f.operatingRecord,...{addressId:o.addressId,targetId:o.targetId,serviceDate:o.serviceDate,observedAt:o.observedAt},medium:b.medium,read});
   if(replay.state!=='available'||!equal(replay.plan,f.plan))return fail(role==='primary'?'PRIMARY_REPROJECTION_MISMATCH':'OBSERVED_PLAN_CONFLICT');
   parsed.push({plan:replay.plan,publishedAt:replay.publishedAt});
  }
  if(parsed.some(p=>!equal(p,parsed[0])))return fail('OBSERVED_PLAN_CONFLICT');
  const t=Date.parse(o.observedAt),list=times.get(o.addressId)??[];list.push(t);times.set(o.addressId,list);all.push(t);
 }
 for(const id of targets.keys()){const t=(times.get(id)??[]).sort((a,b)=>a-b);if(t.length<3||new Set(t).size!==t.length||t.at(-1)!-t[0]<48*3600000||t.slice(1).some((n,i)=>n-t[i]>b.maximumObservationGapMs))return fail('OBSERVED_48H_INCOMPLETE');}
 for(const n of b.negativeFixtures){
  if(!closed(n,['format','artifact','operatingRecord','observedAt','serviceDate','targetId','expected'])||!closed(n.expected,['state'])||!['rejected','unavailable','not_published'].includes(n.expected.state))return fail('NEGATIVE_FIXTURE_INVALID');
  // Invalid context must never mask a parser bug in the negative raw.
  context({addressId:'negative',targetId:n.targetId,serviceDate:n.serviceDate,observedAt:n.observedAt});
  if(!['odesa_typed_plan_snapshot/1','odesa_mirror_matrix/1','odesa_official_public_projection/1'].includes(n.format))return fail('NEGATIVE_FIXTURE_INVALID');
  // Pin/operating failures are not successful negative raw-parser results.
  await read(n.artifact);
  if(n.format==='odesa_typed_plan_snapshot/1'){
   if(!n.operatingRecord||!validOdesaPlanOperatingRecord(await value(n.operatingRecord) as OdesaPlanOperatingRecord,n.observedAt))return fail('NEGATIVE_FIXTURE_INVALID');
  }else if(n.operatingRecord!==null)return fail('NEGATIVE_FIXTURE_INVALID');
  let outcome:string;
  try{outcome=(await replayOdesaQualificationPlan({format:n.format,artifact:n.artifact,operatingRecord:n.operatingRecord,targetId:n.targetId,serviceDate:n.serviceDate,observedAt:n.observedAt,addressId:'negative',medium:b.medium,read})).state;}catch{outcome='rejected';}
  if(outcome!==n.expected.state)return fail('NEGATIVE_FIXTURE_ACCEPTED');
 }
 return {sourceId:b.sourceId,operatorId:b.operatorId,namespace:b.namespace,reviewedAt:b.reviewedAt,validUntil:b.validUntil,medium:b.medium,addressIds:b.coverage.kind==='exact_addresses'?new Set(targets.keys()):null,targetIds:new Set(targets.values()),startedAt:new Date(Math.min(...all)).toISOString(),finishedAt:new Date(Math.max(...all)).toISOString()};
}
