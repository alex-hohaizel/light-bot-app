import type {AddressRecord} from './product-contract.ts';
import {dayBounds,localParts,validInstant} from './schedule-core.ts';
import {formatMinutesDuration} from './time-label.ts';

/** Public information reported for one exact provider house, never a power sensor
 * or a qualification of its group binding. No transport/raw/private fields. */
export interface OperatorHouseReport {
 scope:'provider_house_record';state:'operator_reported_window'|'not_reported'|'unverified_report';
 reportKind:'stabilization'|'emergency'|'not_reported'|'unverified';
 reportIssue:'unknown_report_type'|'conflicting_report_fields'|'missing_report_time'|'invalid_report_time'|null;
 groupPlanAdvisory:'none'|'operator_reports_schedule_not_applicable'|'house_report_unverified';
 sourceUpdatedAt:string;observedAt:string;providerDisplayEnabled:boolean;physicalPower:'unknown';
 window?:{startsAt:string;estimatedEndsAt:string;startLocal:string;estimatedEndLocal:string;
  phaseAtObservation:'before_reported_window'|'during_reported_window'|'past_estimate';endIsEstimate:true};
}
export interface AddressOperatorHouseNotice {
 kind:'operator-house-notice/1';addressId:string;operatorId:'dtek-oem';namespace:'dtek:oem';sourceId:'dtek-oem-public-ajax';
 observedAt:string;expiresAt:string;report:OperatorHouseReport;
}
const invalid=():never=>{throw Error('OPERATOR_HOUSE_NOTICE_INVALID');};
function closed(value:unknown,keys:readonly string[],required=keys):Record<string,any>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return invalid();
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(descriptors).some(k=>typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(descriptors[k],'value'))||required.some(k=>!Object.hasOwn(descriptors,k)))return invalid();
 return value as Record<string,any>;
}
function report(value:unknown):OperatorHouseReport {
 const n=closed(value,['scope','state','reportKind','reportIssue','groupPlanAdvisory','sourceUpdatedAt','observedAt','providerDisplayEnabled','physicalPower','window'],
  ['scope','state','reportKind','reportIssue','groupPlanAdvisory','sourceUpdatedAt','observedAt','providerDisplayEnabled','physicalPower']);
 if(n.scope!=='provider_house_record'||n.physicalPower!=='unknown'||typeof n.providerDisplayEnabled!=='boolean'||!validInstant(n.observedAt)||!validInstant(n.sourceUpdatedAt)||Date.parse(n.sourceUpdatedAt)>Date.parse(n.observedAt))return invalid();
 let w:OperatorHouseReport['window'];
 if(n.state==='operator_reported_window'){
  if(!['stabilization','emergency'].includes(n.reportKind)||n.reportIssue!==null||n.groupPlanAdvisory!==(n.reportKind==='emergency'?'operator_reports_schedule_not_applicable':'none'))return invalid();
  const v=closed(n.window,['startsAt','estimatedEndsAt','startLocal','estimatedEndLocal','phaseAtObservation','endIsEstimate']);
  if(!validInstant(v.startsAt)||!validInstant(v.estimatedEndsAt)||Date.parse(v.startsAt)>=Date.parse(v.estimatedEndsAt)||
   v.startLocal!==localParts(Date.parse(v.startsAt)).time||v.estimatedEndLocal!==localParts(Date.parse(v.estimatedEndsAt)).time||
   !['before_reported_window','during_reported_window','past_estimate'].includes(v.phaseAtObservation)||v.endIsEstimate!==true)return invalid();
  w={startsAt:v.startsAt,estimatedEndsAt:v.estimatedEndsAt,startLocal:v.startLocal,estimatedEndLocal:v.estimatedEndLocal,phaseAtObservation:v.phaseAtObservation,endIsEstimate:true};
 }else if(n.state==='not_reported'){
  if(n.reportKind!=='not_reported'||n.reportIssue!==null||n.groupPlanAdvisory!=='none'||Object.hasOwn(n,'window'))return invalid();
 }else if(n.state==='unverified_report'){
  if(n.reportKind!=='unverified'||!['unknown_report_type','conflicting_report_fields','missing_report_time','invalid_report_time'].includes(n.reportIssue)||n.groupPlanAdvisory!=='house_report_unverified'||Object.hasOwn(n,'window'))return invalid();
 }else return invalid();
 return {scope:'provider_house_record',state:n.state,reportKind:n.reportKind,reportIssue:n.reportIssue,groupPlanAdvisory:n.groupPlanAdvisory,
  sourceUpdatedAt:n.sourceUpdatedAt,observedAt:n.observedAt,providerDisplayEnabled:n.providerDisplayEnabled,physicalPower:'unknown',...(w?{window:w}:{})};
}
/** Closed JSON DTO. Callers must separately establish owner and source provenance. */
export function parseOperatorHouseNotice(value:unknown):AddressOperatorHouseNotice {
 try{
  const v=closed(value,['kind','addressId','operatorId','namespace','sourceId','observedAt','expiresAt','report']);
  if(v.kind!=='operator-house-notice/1'||typeof v.addressId!=='string'||!v.addressId||v.addressId.length>512||/[\u0000-\u001f\u007f]/.test(v.addressId)||
   v.operatorId!=='dtek-oem'||v.namespace!=='dtek:oem'||v.sourceId!=='dtek-oem-public-ajax'||!validInstant(v.observedAt)||!validInstant(v.expiresAt))return invalid();
  const r=report(v.report),at=Date.parse(v.observedAt),until=Date.parse(v.expiresAt);
  if(r.observedAt!==v.observedAt||until<=at||until>at+600000||until>dayBounds(localParts(at).date).end)return invalid();
  return {kind:'operator-house-notice/1',addressId:v.addressId,operatorId:'dtek-oem',namespace:'dtek:oem',sourceId:'dtek-oem-public-ajax',observedAt:v.observedAt,expiresAt:v.expiresAt,report:r};
 }catch{return invalid();}
}
export function currentOperatorHouseNotice(value:unknown,asOf:string):AddressOperatorHouseNotice|null {
 try{const v=parseOperatorHouseNotice(value),now=validInstant(asOf)?Date.parse(asOf):NaN;
  return Number.isFinite(now)&&Date.parse(v.observedAt)<=now&&now<Date.parse(v.expiresAt)?v:null;
 }catch{return null;}
}
export function createOperatorHouseNotice(addressId:string,value:unknown,expiresAt:string,asOf:string):AddressOperatorHouseNotice|null {
 try{const r=report(value);return currentOperatorHouseNotice({kind:'operator-house-notice/1',addressId,operatorId:'dtek-oem',namespace:'dtek:oem',sourceId:'dtek-oem-public-ajax',observedAt:r.observedAt,expiresAt,report:r},asOf);}catch{return null;}
}
export function operatorHouseScope(location:{address:AddressRecord;binding:{operatorId?:string;namespace?:string}}):boolean {
 return location.binding.operatorId==='dtek-oem'&&location.binding.namespace==='dtek:oem'&&location.address.territoryId==='source:dtek:oem';
}
/** Labels are private preferences; provider keys and literal house identity are exact. */
export function sameOperatorHouseAddress(a:AddressRecord,b:AddressRecord):boolean {
 return a.id===b.id&&a.territoryId===b.territoryId&&a.locality===b.locality&&a.localityId===b.localityId&&a.street===b.street&&a.streetId===b.streetId&&
  a.house.literal===b.house.literal&&a.house.number===b.house.number&&a.house.letter===b.house.letter&&a.house.building===b.house.building;
}
export function parseOperatorHouseNotices(value:unknown,locations:ReadonlyArray<{address:AddressRecord;binding:{operatorId?:string;namespace?:string}}> ):AddressOperatorHouseNotice[] {
 try{if(!Array.isArray(value)||value.length>locations.length||value.length>10000)return invalid();const seen=new Set<string>();return value.map(raw=>{
  const v=parseOperatorHouseNotice(raw),l=locations.find(l=>l.address.id===v.addressId);
  if(!l||!operatorHouseScope(l)||seen.has(v.addressId))return invalid();seen.add(v.addressId);return v;
 });}catch{return invalid();}
}
export interface OperatorHouseSummary {state:'current'|'unavailable';tone:'attention'|'neutral';title:string;detail:string;timing?:string;footnote?:string;outsideGroupPlan:boolean}
function dateTime(at:string):string {return new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at));}
/** The trusted current clock determines the phase, never phaseAtObservation. */
export function summarizeOperatorHouseNotice(value:unknown,asOf:string,suspended=false):OperatorHouseSummary {
 const v=suspended?null:currentOperatorHouseNotice(value,asOf);
 if(!v)return {state:'unavailable',tone:'neutral',title:'Повідомлення для будинку',detail:'Актуальне повідомлення оператора поки недоступне. Час відновлення невідомий.',outsideGroupPlan:false};
 const r=v.report,base={state:'current' as const,tone:'neutral' as const,title:'Повідомлення для будинку',outsideGroupPlan:r.groupPlanAdvisory==='operator_reports_schedule_not_applicable',
  footnote:`Оператор оновив: ${dateTime(r.sourceUpdatedAt)}. Отримано: ${dateTime(v.observedAt)}. Час — київський.`};
 if(!r.providerDisplayEnabled)return {...base,detail:'Оператор не показує окремий поточний орієнтир для будинку. Наявність світла не підтверджена.'};
 if(r.state==='not_reported')return {...base,detail:'Окремого повідомлення для будинку немає. Наявність світла не підтверджена.'};
 if(r.state==='unverified_report'||!r.window)return {...base,detail:'Повідомлення оператора потребує уточнення. Час відновлення невідомий.'};
 const now=Date.parse(asOf),w=r.window,end=Date.parse(w.estimatedEndsAt),start=Date.parse(w.startsAt),kind=r.reportKind==='emergency'?'аварійне':'стабілізаційне';
 if(now>=end)return {...base,tone:'attention',detail:`Попередній орієнтир відновлення (${dateTime(w.estimatedEndsAt)}) минув. Актуального часу відновлення поки немає.`};
 if(now<start)return {...base,tone:'attention',detail:`Оператор повідомляє про ${kind} відключення з ${dateTime(w.startsAt)}.`,timing:`Орієнтовне завершення — ${dateTime(w.estimatedEndsAt)}. Час може змінитися.`};
 return {...base,tone:'attention',detail:`За повідомленням оператора для будинку діє ${kind} відключення.`,
  timing:`Орієнтовне відновлення — ${dateTime(w.estimatedEndsAt)} · ще ${formatMinutesDuration(Math.ceil((end-now)/60000))}. Час може змінитися.`};
}
export function formatOperatorHouseNotice(value:unknown,asOf:string,suspended=false):string {
 const s=summarizeOperatorHouseNotice(value,asOf,suspended);
 return [s.title,s.detail,s.timing,s.outsideGroupPlan?'Повідомлення для будинку може діяти поза погодинним планом групи.':undefined,s.footnote].filter(Boolean).join('\n');
}
