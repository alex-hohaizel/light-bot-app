import {createOperatorHouseNotice,currentOperatorHouseNotice} from '../../shared/operator-house-notice.ts';
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import type {BotState,AddressOption,BotProviderSnapshotV2,BotProviderLookupStageV2,BotProviderLookupV2,BotProviderDirectoryV2} from '../../shared/bot/types.ts';
import {dayBounds,localParts,validInstant} from '../../shared/schedule-core.ts';
import {parseProviderAddressLookupV2,type ProviderAddressLookupV2} from '../domain/provider-address-lookup.ts';
import type {createOdesaAddressCatalog,OperatorAddressSnapshot,OdesaCatalogSearch,OdesaCatalogCandidate,OdesaCatalogRejected} from './odesa-address-catalog.ts';
import {ProductionProfileStoreError,type createProductionProfileStore} from './profile-store.ts';
import type {LegacyProfileReadQuery,VerifiedLegacyPrincipal} from './profile-reader.ts';
import type {OdesaOperatorHouseNotice,OdesaAddressCandidate,OdesaCaptureProof} from '../domain/odesa-address-adapter.ts';

export type OperatorLookupState=BotProviderLookupStageV2['state'];
export type OperatorLookupSnapshot=BotProviderSnapshotV2;
export type OperatorLookupStage=BotProviderLookupStageV2;
export type OperatorHouseSelection=NonNullable<BotProviderLookupV2['selectedHouse']>;
export type OperatorProviderLookupState=BotProviderLookupV2;
export interface SharedOwnedLookupState {
 directoryId:string;optionIds:string[];optionExpiries?:Record<string,string>;catalogStatus:'ready'|'loading'|'unavailable';
 streets?:any;houses?:any;providerV2?:OperatorProviderLookupState;
}
export type OperatorAddressDirectory=BotProviderDirectoryV2;
export interface OperatorAddressProjection {providerDirectoriesV2?:OperatorAddressDirectory[];providerLookupV2?:OperatorProviderLookupState}
type Result=OdesaCatalogSearch|OdesaCatalogCandidate;
type Request=ProviderAddressLookupV2;
const directory:OperatorAddressDirectory=Object.freeze({id:'dtek:oem',namespace:'dtek:oem',operatorId:'dtek-oem',territoryId:'source:dtek:oem',label:'Одеська область',localitySelection:'required'});
const TTL=600000;
const rejectedCodes=new Set(['ADDRESS_WORKER_HELD','ADDRESS_ORIGIN_HELD','ADDRESS_BUDGET_DEFERRED','ADDRESS_CACHE_CAPACITY','ADDRESS_CLOCK_INVALID',
 'ADDRESS_CONTROL_REJECTED','ADDRESS_EPOCH_CONFLICT','ADDRESS_INVALID_REQUEST','ADDRESS_PUBLICATION_UNKNOWN','ADDRESS_SCHEMA_REJECTED',
 'ADDRESS_SELECTION_REJECTED','ADDRESS_SERVICE_DISABLED','ADDRESS_SNAPSHOT_NOT_FOUND','ADDRESS_SOURCE_UNAVAILABLE','ADDRESS_STALE_SNAPSHOT',
 'ADDRESS_FLOW_DISABLED','ADDRESS_FLOW_UNAVAILABLE','ADDRESS_FLOW_SELECTION_CHANGED']);
const obj=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const fail=(code:'ADDRESS_FLOW_INVALID_INPUT'|'ADDRESS_FLOW_STORAGE_UNAVAILABLE'|'ADDRESS_FLOW_UNAVAILABLE'|'ADDRESS_FLOW_INPUT_ID_CONFLICT'|'ADDRESS_FLOW_SELECTION_CHANGED'):never=>{throw new ProductionProfileStoreError(code);};
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const clone=<T>(v:T):T=>structuredClone(v);
const empty=():SharedOwnedLookupState=>({directoryId:'dtek:oem',optionIds:[],catalogStatus:'ready'});
function closed(value:unknown,allowed:readonly string[],required=allowed):asserts value is Record<string,any>{
 if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail('ADDRESS_FLOW_UNAVAILABLE');
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(descriptors[k],'value'))||required.some(k=>!Object.hasOwn(descriptors,k)))return fail('ADDRESS_FLOW_UNAVAILABLE');
}
function stamp(v:unknown):number {if(!validInstant(v))return fail('ADDRESS_FLOW_SELECTION_CHANGED');return Date.parse(v);}
function expiry(observed:unknown,expires:unknown,now:string,parents:number[]=[]):string {
 const time=stamp(now),at=stamp(observed),until=stamp(expires);
 if(at>time||time-at>=TTL||until<=time||until<=at||localParts(at).date!==localParts(time).date)return fail('ADDRESS_FLOW_SELECTION_CHANGED');
 const end=Math.min(until,at+TTL,dayBounds(localParts(at).date).end,...parents);
 if(end<=time)return fail('ADDRESS_FLOW_SELECTION_CHANGED');return new Date(end).toISOString();
}
function savedState(value:unknown):SharedOwnedLookupState {
 if(!obj(value)||typeof value.directoryId!=='string'||!Array.isArray(value.optionIds)||value.optionIds.length>20||
  value.optionIds.some((v:unknown)=>typeof v!=='string')||!['ready','loading','unavailable'].includes(value.catalogStatus))return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');
 return clone(value) as SharedOwnedLookupState;
}
function currentStage(stage:OperatorLookupStage|undefined,level:OperatorAddressSnapshot['level'],now:string):OperatorLookupSnapshot {
 const s=stage?.snapshot;
 if(stage?.state!=='available'||!s||s.kind!=='lba-provider-address-snapshot/2'||s.namespace!=='dtek:oem'||s.level!==level||
  !uuid(s.id)||!uuid(s.catalogSnapshotId)||!Array.isArray(s.items))return fail('ADDRESS_FLOW_SELECTION_CHANGED');
 expiry(s.observedAt,s.expiresAt,now);return s;
}
function parents(saved:SharedOwnedLookupState,r:Request,now:string):OperatorLookupSnapshot[] {
 if(r.operation==='localities')return [];
 const p=saved.providerV2;
 if(saved.directoryId!=='dtek:oem'||p?.directoryId!=='dtek:oem')return fail('ADDRESS_FLOW_SELECTION_CHANGED');
 const localities=currentStage(p.localities,'localities',now);
 if(localities.id!==r.catalogSnapshotId||localities.catalogSnapshotId!==r.catalogSnapshotId||!localities.items.some(v=>v.key===r.cityKey))return fail('ADDRESS_FLOW_SELECTION_CHANGED');
 if(r.operation==='streets')return [localities];
 const streets=currentStage(p.streets,'streets',now);
 if(streets.id!==r.catalogSnapshotId||streets.catalogSnapshotId!==r.catalogSnapshotId||streets.cityKey!==r.cityKey||!streets.items.some(v=>v.key===r.streetKey))return fail('ADDRESS_FLOW_SELECTION_CHANGED');
 if(r.operation==='houses')return [localities,streets];
 const houses=currentStage(p.houses,'houses',now);
 if(houses.id!==r.houseSnapshotId||houses.catalogSnapshotId!==r.catalogSnapshotId||houses.cityKey!==r.cityKey||houses.streetKey!==r.streetKey||!houses.items.some(v=>v.key===r.houseKey))return fail('ADDRESS_FLOW_SELECTION_CHANGED');
 return [localities,streets,houses];
}
function snapshot(value:OperatorAddressSnapshot,r:Exclude<Request,{operation:'resolve'}>,now:string,parent:OperatorLookupSnapshot[]):OperatorLookupSnapshot {
 const s=value;
 closed(s,['kind','id','revisionId','namespace','level','catalogSnapshotId','cityKey','streetKey','observedAt','expiresAt','items','offset','hasMore','catalogCompleteness'],
  ['kind','id','revisionId','namespace','level','catalogSnapshotId','observedAt','expiresAt','items','offset','hasMore','catalogCompleteness']);
 if(!obj(s)||s.kind!=='lba-provider-address-snapshot/2'||s.namespace!=='dtek:oem'||s.level!==r.operation||!uuid(s.id)||!uuid(s.catalogSnapshotId)||
  typeof s.revisionId!=='string'||!s.revisionId||s.catalogCompleteness!=='unknown'||!Number.isSafeInteger(s.offset)||s.offset!==(r.offset??0)||typeof s.hasMore!=='boolean'||
  !Array.isArray(s.items)||s.items.length>30||s.items.some(v=>!obj(v)||typeof v.key!=='string'||!v.key.trim()||typeof v.value!=='string'||!v.value.trim())||new Set(s.items.map(v=>v.key)).size!==s.items.length)return fail('ADDRESS_FLOW_UNAVAILABLE');
 if(r.operation==='localities'?(s.catalogSnapshotId!==s.id||s.cityKey!==undefined||s.streetKey!==undefined):
  s.catalogSnapshotId!==r.catalogSnapshotId||s.cityKey!==r.cityKey||r.operation==='streets'&&(s.id!==r.catalogSnapshotId||s.streetKey!==undefined)||r.operation==='houses'&&s.streetKey!==r.streetKey)return fail('ADDRESS_FLOW_UNAVAILABLE');
 for(const item of s.items)closed(item,['key','value']);
 const expiresAt=expiry(s.observedAt,s.expiresAt,now,parent.map(v=>stamp(v.expiresAt)));
 return {kind:s.kind,id:s.id,revisionId:s.revisionId,namespace:s.namespace,level:s.level,catalogSnapshotId:s.catalogSnapshotId,
  ...(s.cityKey!==undefined?{cityKey:s.cityKey}:{}),...(s.streetKey!==undefined?{streetKey:s.streetKey}:{}),observedAt:s.observedAt,expiresAt,
  items:s.items.map(v=>({key:v.key,value:v.value})),offset:s.offset,hasMore:s.hasMore,catalogCompleteness:'unknown'};
}
function addressOption(v:unknown,r:Extract<Request,{operation:'resolve'}>,strict=true):AddressOption {
 if(!obj(v)||typeof v.id!=='string'||!v.id||!obj(v.address)||!obj(v.binding)||typeof v.territoryLabel!=='string')return fail('ADDRESS_FLOW_UNAVAILABLE');
 const a=v.address,b=v.binding;
 if(strict){
  closed(v,['id','address','binding','territoryLabel','connectionLabel'],['id','address','binding','territoryLabel']);
  closed(a,['id','label','territoryId','locality','localityId','localityAliases','street','streetId','house','aliases','placeNames','objectKind'],['id','label','territoryId','locality','street','house','aliases']);
  closed(a.house,['number','literal','letter','building'],['number','literal']);
  closed(b,['addressId','operatorId','namespace','targetId','kind','revisionId','status','verifiedAt','effectiveFrom','effectiveUntil']);
 }
 if(typeof a.id!=='string'||!a.id||a.territoryId!=='source:dtek:oem'||a.locality!==r.cityKey||a.street!==r.streetKey||!obj(a.house)||a.house.literal!==r.houseKey||
  typeof a.house.number!=='string'||typeof a.label!=='string'||!Array.isArray(a.aliases)||a.aliases.some((s:unknown)=>typeof s!=='string')||
  b.addressId!==a.id||b.operatorId!=='dtek-oem'||b.namespace!=='dtek:oem'||typeof b.targetId!=='string'||!/^GPV[1-6]\.[12]$/.test(b.targetId)||
  b.kind!=='operator_group'||!['ambiguous','needs_confirmation'].includes(b.status)||typeof b.revisionId!=='string'||!b.revisionId||
  b.verifiedAt!==null||b.effectiveFrom!==null||b.effectiveUntil!==null)return fail('ADDRESS_FLOW_UNAVAILABLE');
 if(['localityId','streetId'].some(k=>Object.hasOwn(a,k)&&typeof a[k]!=='string')||['letter','building'].some(k=>Object.hasOwn(a.house,k)&&typeof a.house[k]!=='string')||
  ['localityAliases','placeNames'].some(k=>Object.hasOwn(a,k)&&(!Array.isArray(a[k])||a[k].some((s:unknown)=>typeof s!=='string')))||
  Object.hasOwn(a,'objectKind')&&!['residential','commercial','public','other'].includes(a.objectKind)||Object.hasOwn(v,'connectionLabel')&&typeof v.connectionLabel!=='string')return fail('ADDRESS_FLOW_UNAVAILABLE');
 // Explicit projection prevents incidental internal/source fields from leaking.
 return {id:v.id,address:{id:a.id,label:a.label,territoryId:a.territoryId,locality:a.locality,street:a.street,
  house:{number:a.house.number,literal:a.house.literal,...(typeof a.house.letter==='string'?{letter:a.house.letter}:{}),...(typeof a.house.building==='string'?{building:a.house.building}:{})},
  aliases:[...a.aliases],...(typeof a.localityId==='string'?{localityId:a.localityId}:{}),...(typeof a.streetId==='string'?{streetId:a.streetId}:{}),
  ...(Array.isArray(a.localityAliases)&&a.localityAliases.every((s:unknown)=>typeof s==='string')?{localityAliases:[...a.localityAliases]}:{}),
  ...(Array.isArray(a.placeNames)&&a.placeNames.every((s:unknown)=>typeof s==='string')?{placeNames:[...a.placeNames]}:{}),
  ...(['residential','commercial','public','other'].includes(a.objectKind)?{objectKind:a.objectKind}:{})},
  binding:{addressId:b.addressId,operatorId:b.operatorId,namespace:b.namespace,targetId:b.targetId,kind:b.kind,revisionId:b.revisionId,status:b.status,
   verifiedAt:null,effectiveFrom:null,effectiveUntil:null},territoryLabel:v.territoryLabel,...(typeof v.connectionLabel==='string'?{connectionLabel:v.connectionLabel}:{})};
}
function notice(value:unknown):OdesaOperatorHouseNotice {
 closed(value,['scope','state','reportKind','reportIssue','groupPlanAdvisory','sourceUpdatedAt','observedAt','providerDisplayEnabled','physicalPower','window'],
  ['scope','state','reportKind','reportIssue','groupPlanAdvisory','sourceUpdatedAt','observedAt','providerDisplayEnabled','physicalPower']);
 const n=value;
 if(n.scope!=='provider_house_record'||!['operator_reported_window','not_reported','unverified_report'].includes(n.state)||!['stabilization','emergency','not_reported','unverified'].includes(n.reportKind)||
  ![null,'unknown_report_type','conflicting_report_fields','missing_report_time','invalid_report_time'].includes(n.reportIssue)||!['none','operator_reports_schedule_not_applicable','house_report_unverified'].includes(n.groupPlanAdvisory)||
  !validInstant(n.sourceUpdatedAt)||!validInstant(n.observedAt)||typeof n.providerDisplayEnabled!=='boolean'||n.physicalPower!=='unknown')return fail('ADDRESS_FLOW_UNAVAILABLE');
 if(Object.hasOwn(n,'window')){closed(n.window,['startsAt','estimatedEndsAt','startLocal','estimatedEndLocal','phaseAtObservation','endIsEstimate']);const w=n.window;
  if(!validInstant(w.startsAt)||!validInstant(w.estimatedEndsAt)||typeof w.startLocal!=='string'||typeof w.estimatedEndLocal!=='string'||
   !['before_reported_window','during_reported_window','past_estimate'].includes(w.phaseAtObservation)||w.endIsEstimate!==true)return fail('ADDRESS_FLOW_UNAVAILABLE');}
 return clone(n) as OdesaOperatorHouseNotice;
}
function candidateProof(value:unknown,r:Extract<Request,{operation:'resolve'}>):OdesaAddressCandidate['proof'] {
 closed(value,['kind','adapterVersion','mappingAdapterVersion','selectionBasis','houseGroupEvidence','verdict','scope','captures','observedAt','connectionId','physicalConnectionCount','municipalAddressId','providerEffectiveRevision','aliasesVerified','catalogCompleteness','identifierMeaning','rightsForSystematicReuse','independentlyConfirmed','deliveryEligible']);
 const p=value;closed(p.scope,['operatorId','namespace']);
 if(p.kind!=='odesa-address-proof/3'||p.adapterVersion!=='odesa-house-report/3'||p.mappingAdapterVersion!=='odesa-address-mapping/1'||p.selectionBasis!=='street_row/1'||p.houseGroupEvidence!=='same_captured_street_row'||
  p.verdict!=='source_reported_binding_candidate'||p.scope.operatorId!=='dtek-oem'||p.scope.namespace!=='dtek:oem'||!validInstant(p.observedAt)||
  !Array.isArray(p.captures)||p.captures.length!==2||p.connectionId!==null||p.physicalConnectionCount!==null||p.municipalAddressId!==null||p.providerEffectiveRevision!==null||
  p.aliasesVerified!==false||p.catalogCompleteness!=='unknown'||p.identifierMeaning!=='hash of exact opaque provider labels; not a municipal ID or rename equivalence'||p.rightsForSystematicReuse!=='unknown'||p.independentlyConfirmed!==false||p.deliveryEligible!==false)return fail('ADDRESS_FLOW_UNAVAILABLE');
 const captures:OdesaCaptureProof[]=p.captures.map((c:unknown,index:number)=>{
  closed(c,['sourceId','operation','requestUrl','request','observedAt','rawSha256','queryProvenance','requestScopeEchoedBySource','transportAuthenticatedByAdapter']);
  if(c.sourceId!=='dtek-oem-public-ajax'||c.operation!==(index===0?'getStreets':'getHomeNum')||c.requestUrl!=='https://www.dtek-oem.com.ua/ua/ajax'||!validInstant(c.observedAt)||
   typeof c.rawSha256!=='string'||!/^[a-f0-9]{64}$/.test(c.rawSha256)||c.queryProvenance!=='collector_supplied_not_authenticated_by_adapter'||c.requestScopeEchoedBySource!==false||c.transportAuthenticatedByAdapter!==false)return fail('ADDRESS_FLOW_UNAVAILABLE');
  closed(c.request,index===0?[]:['city','street','house_num','updateFact']);
  if(index===1&&(c.request.city!==r.cityKey||c.request.street!==r.streetKey||c.request.house_num!==''||c.request.updateFact!==''))return fail('ADDRESS_FLOW_UNAVAILABLE');
  return {sourceId:'dtek-oem-public-ajax',operation:index===0?'getStreets':'getHomeNum',requestUrl:'https://www.dtek-oem.com.ua/ua/ajax',
   request:index===0?{}:{city:r.cityKey,street:r.streetKey,house_num:'',updateFact:''},observedAt:c.observedAt,rawSha256:c.rawSha256,
   queryProvenance:'collector_supplied_not_authenticated_by_adapter',requestScopeEchoedBySource:false,transportAuthenticatedByAdapter:false};
 });
 return {kind:'odesa-address-proof/3',adapterVersion:'odesa-house-report/3',mappingAdapterVersion:'odesa-address-mapping/1',selectionBasis:'street_row/1',houseGroupEvidence:'same_captured_street_row',
  verdict:'source_reported_binding_candidate',scope:{operatorId:'dtek-oem',namespace:'dtek:oem'},captures,observedAt:p.observedAt,connectionId:null,physicalConnectionCount:null,municipalAddressId:null,
  providerEffectiveRevision:null,aliasesVerified:false,catalogCompleteness:'unknown',identifierMeaning:'hash of exact opaque provider labels; not a municipal ID or rename equivalence',rightsForSystematicReuse:'unknown',independentlyConfirmed:false,deliveryEligible:false};
}
function normalized(result:Result,r:Request,saved:SharedOwnedLookupState,now:string):Result {
 if(result.state!=='available'){
  closed(result,['state','code','retryAt'],['state','code']);
  if(!['disabled','unavailable','deferred','stale'].includes(result.state)||!rejectedCodes.has(result.code))return {state:'unavailable',code:'ADDRESS_FLOW_UNAVAILABLE'};
  return {state:result.state,code:result.code,...(result.retryAt&&validInstant(result.retryAt)&&Date.parse(result.retryAt)>stamp(now)?{retryAt:result.retryAt}:{})};
 }
 const parent=parents(saved,r,now);
 if(r.operation!=='resolve'){
  closed(result,['state','cache','snapshot']);
  if(!('snapshot'in result)||!['hit','miss'].includes(result.cache))return fail('ADDRESS_FLOW_UNAVAILABLE');
  return {state:'available',cache:result.cache,snapshot:snapshot(result.snapshot,r,now,parent)};
 }
 closed(result,['state','cache','snapshotId','options','operatorNotice','mappingFingerprint','candidateProof','observedAt','expiresAt','addressBindingVerified','deliveryEligible']);
 if(!('options'in result)||result.snapshotId!==r.houseSnapshotId||result.cache!=='hit'||result.addressBindingVerified!==false||result.deliveryEligible!==false||
  !Array.isArray(result.options)||!result.options.length||typeof result.mappingFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(result.mappingFingerprint))return fail('ADDRESS_FLOW_UNAVAILABLE');
 const options=result.options.map(v=>addressOption(v,r));
 if(new Set(options.map(v=>v.id)).size!==options.length||new Set(options.map(v=>v.binding.targetId)).size!==options.length||
  options.some(v=>canonical(v.address)!==canonical(options[0].address)||v.binding.revisionId!=='odesa-address-mapping:'+result.mappingFingerprint))return fail('ADDRESS_FLOW_UNAVAILABLE');
 if(stamp(result.observedAt)!==stamp(parent[2].observedAt))return fail('ADDRESS_FLOW_UNAVAILABLE');
 const operatorNotice=notice(result.operatorNotice),proof=candidateProof(result.candidateProof,r);
 if(stamp(operatorNotice.observedAt)!==stamp(result.observedAt)||stamp(proof.observedAt)!==stamp(result.observedAt)||
  stamp(proof.captures[0].observedAt)!==stamp(parent[0].observedAt)||stamp(proof.captures[1].observedAt)!==stamp(parent[2].observedAt))return fail('ADDRESS_FLOW_UNAVAILABLE');
 return {state:'available',cache:'hit',snapshotId:result.snapshotId,options,operatorNotice,mappingFingerprint:result.mappingFingerprint,
  candidateProof:proof,observedAt:result.observedAt,expiresAt:expiry(result.observedAt,result.expiresAt,now,parent.map(v=>stamp(v.expiresAt))),addressBindingVerified:false,deliveryEligible:false};
}
function selection(r:Extract<Request,{operation:'resolve'}>,state:OperatorHouseSelection['state'],observedAt:string,expiresAt:string):OperatorHouseSelection {
 return {state,catalogSnapshotId:r.catalogSnapshotId,houseSnapshotId:r.houseSnapshotId,cityKey:r.cityKey,streetKey:r.streetKey,houseKey:r.houseKey,options:[],observedAt,expiresAt};
}
function loading(saved:SharedOwnedLookupState,r:Request):SharedOwnedLookupState {
 const next=clone(saved);next.directoryId='dtek:oem';next.catalogStatus='loading';
 if(r.operation==='localities'){
  delete next.streets;delete next.houses;next.providerV2={directoryId:'dtek:oem',localities:{state:'loading',query:r.query}};
 }else{
  const p=next.providerV2!;
  if(r.operation==='streets'){p.streets={state:'loading',query:r.query};delete p.houses;delete p.selectedHouse;}
  else if(r.operation==='houses'){p.houses={state:'loading',query:r.query};delete p.selectedHouse;}
  else {delete p.selectedHouse;if(p.houses?.snapshot)p.houses.snapshot.items=p.houses.snapshot.items.map(v=>({key:v.key,value:v.value}));}
 }
 return next;
}

/** Composition only: existing owner transaction/lookup tables and the root's
 * shared memory bridge remain authoritative. No own map, DDL, HTTP, background
 * job, controller, profile mutation, migration, send or source admission. */
export function createOperatorAddressFlow(options:{enabled?:boolean;store:Pick<ReturnType<typeof createProductionProfileStore>,'withLockedProfile'>;
 catalog:ReturnType<typeof createOdesaAddressCatalog>;now:()=>string;refreshPublicContext:()=>Promise<void>;
 bridge:{get(owner:string,session:string):SharedOwnedLookupState|undefined;set(owner:string,session:string,state:SharedOwnedLookupState,generation:number):void}}){
 if(!options?.store||typeof options.store.withLockedProfile!=='function'||!options.catalog||typeof options.now!=='function'||typeof options.refreshPublicContext!=='function'||
  !options.bridge||typeof options.bridge.get!=='function'||typeof options.bridge.set!=='function'||options.enabled!==undefined&&typeof options.enabled!=='boolean')fail('ADDRESS_FLOW_INVALID_INPUT');
 options={...options,bridge:{...options.bridge}};
 async function row(q:LegacyProfileReadQuery,owner:string,session:string){
  const rows=(await q.query('select operation_id as "operationId",input_digest as "inputDigest",generation,state from lba_production_address_lookup where owner_id=$1 and session_id=$2 for update',[owner,session])).rows;
  if(rows.length>1||rows[0]&&(!Number.isSafeInteger(Number(rows[0].generation))||Number(rows[0].generation)<1))fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');return rows[0];
 }
 async function requestRow(q:LegacyProfileReadQuery,owner:string,session:string,id:string){
  const rows=(await q.query('select input_digest as "inputDigest",result from lba_production_address_lookup_requests where owner_id=$1 and session_id=$2 and operation_id=$3',[owner,session,id])).rows;
  if(rows.length>1)fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');return rows[0];
 }
 async function publish(owner:string,session:string,saved:SharedOwnedLookupState,generation:number,r:Request,result:Result){
  try{options.bridge.set(owner,session,clone(saved),generation);if(r.operation==='resolve'&&result.state==='available')await options.refreshPublicContext();}
  catch{return fail('ADDRESS_FLOW_UNAVAILABLE');}
 }
 async function performLookup(identity:VerifiedLegacyPrincipal,raw:unknown):Promise<Result>{
  if(options.enabled!==true)return {state:'disabled',code:'ADDRESS_FLOW_DISABLED'};
  let r:Request;try{r=parseProviderAddressLookupV2(raw);}catch{return fail('ADDRESS_FLOW_INVALID_INPUT');}
  const digest=createHash('sha256').update(canonical(r)).digest('hex'),scope={sessionId:r.expectedSessionId,revision:r.expectedRevision};
  const reservation=await options.store.withLockedProfile(identity,scope,async({client,state,serverNow})=>{
   const old=await row(client,identity.ownerId,state.sessionId),saved=old?savedState(old.state):empty(),receipt=await requestRow(client,identity.ownerId,state.sessionId,r.id);
   if(receipt&&receipt.inputDigest!==digest||old?.operationId===r.id&&old.inputDigest!==digest)return fail('ADDRESS_FLOW_INPUT_ID_CONFLICT');
   if(receipt&&old?.operationId!==r.id)return fail('ADDRESS_FLOW_SELECTION_CHANGED');
   if(receipt?.result){
    if(!obj(receipt.result)||receipt.result.state!=='available')return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');
    const result=normalized(receipt.result as Result,r,saved,serverNow);return {generation:Number(old.generation),saved,replay:result};
   }
   parents(saved,r,serverNow);
   const generation=Number(old?.generation??0)+1;
   if(!Number.isSafeInteger(generation)||generation<1)return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');
   if(!receipt)await client.query('insert into lba_production_address_lookup_requests(owner_id,session_id,operation_id,input_digest,result,recorded_at) values($1,$2,$3,$4,null,$5)',[identity.ownerId,state.sessionId,r.id,digest,serverNow]);
   const next=loading(saved,r);
   await client.query(`insert into lba_production_address_lookup(owner_id,session_id,operation_id,input_digest,generation,state,updated_at) values($1,$2,$3,$4,$5,$6::jsonb,$7)
    on conflict(owner_id,session_id) do update set operation_id=excluded.operation_id,input_digest=excluded.input_digest,generation=excluded.generation,state=excluded.state,updated_at=excluded.updated_at`,[identity.ownerId,state.sessionId,r.id,digest,generation,JSON.stringify(next),serverNow]);
   return {generation,saved:next,replay:null};
  },{isolation:'read committed'});
  if(reservation.replay){await publish(identity.ownerId,r.expectedSessionId,reservation.saved,reservation.generation,r,reservation.replay);return clone(reservation.replay);}
  let output:Result;
  try{
   if(r.operation==='localities')output=await options.catalog.searchLocalities({query:r.query,...(r.offset!==undefined?{offset:r.offset}:{})});
   else if(r.operation==='streets')output=await options.catalog.searchStreets({catalogSnapshotId:r.catalogSnapshotId,cityKey:r.cityKey,query:r.query,...(r.offset!==undefined?{offset:r.offset}:{})});
   else if(r.operation==='houses')output=await options.catalog.searchHouses({catalogSnapshotId:r.catalogSnapshotId,cityKey:r.cityKey,streetKey:r.streetKey,query:r.query,...(r.offset!==undefined?{offset:r.offset}:{})});
   else output=await options.catalog.resolveCandidate({catalogSnapshotId:r.catalogSnapshotId,houseSnapshotId:r.houseSnapshotId,cityKey:r.cityKey,streetKey:r.streetKey,houseKey:r.houseKey});
  }catch{output={state:'unavailable',code:'ADDRESS_FLOW_UNAVAILABLE'};}
  const committed=await options.store.withLockedProfile(identity,scope,async({client,state,serverNow})=>{
   const current=await row(client,identity.ownerId,state.sessionId);
   if(!current||current.operationId!==r.id||current.inputDigest!==digest||Number(current.generation)!==reservation.generation)return fail('ADDRESS_FLOW_SELECTION_CHANGED');
   const saved=savedState(current.state),receipt=await requestRow(client,identity.ownerId,state.sessionId,r.id);
   if(!receipt||receipt.inputDigest!==digest)return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');
   if(receipt.result){if(!obj(receipt.result)||receipt.result.state!=='available')return fail('ADDRESS_FLOW_STORAGE_UNAVAILABLE');return {saved,generation:Number(current.generation),result:normalized(receipt.result as Result,r,saved,serverNow)};}
   let result:Result;try{result=normalized(output,r,saved,serverNow);}catch(error){result=error instanceof ProductionProfileStoreError&&error.code==='ADDRESS_FLOW_SELECTION_CHANGED'?{state:'stale',code:'ADDRESS_FLOW_SELECTION_CHANGED'}:{state:'unavailable',code:'ADDRESS_FLOW_UNAVAILABLE'};}
   saved.catalogStatus=result.state==='available'?'ready':'unavailable';const p=saved.providerV2!;
   if(r.operation!=='resolve')p[r.operation]={state:result.state,query:r.query,...(result.state==='available'&&'snapshot'in result?{snapshot:result.snapshot}:result.state!=='available'?{code:result.code,...(result.retryAt?{retryAt:result.retryAt}:{})}:{})};
   else if(result.state==='available'&&'options'in result){
    const operatorHouseNotice=createOperatorHouseNotice(result.options[0].address.id,result.operatorNotice,result.expiresAt,serverNow);
    p.selectedHouse={...selection(r,'available',result.observedAt,result.expiresAt),options:clone(result.options),...(operatorHouseNotice?{operatorHouseNotice}:{})};
    p.houses!.snapshot!.items=p.houses!.snapshot!.items.map(v=>v.key===r.houseKey?{key:v.key,value:v.value,optionIds:result.options.map(o=>o.id)}:v);
    saved.optionIds=[...new Set([...saved.optionIds,...result.options.map(v=>v.id)])].slice(-20);
    saved.optionExpiries=Object.fromEntries(saved.optionIds.map(id=>[id,result.options.some(v=>v.id===id)?result.expiresAt:saved.optionExpiries?.[id]??'1970-01-01T00:00:00.000Z']));
   }
   await client.query('update lba_production_address_lookup set state=$3::jsonb,updated_at=$4 where owner_id=$1 and session_id=$2',[identity.ownerId,state.sessionId,JSON.stringify(saved),serverNow]);
   if(result.state==='available')await client.query('update lba_production_address_lookup_requests set result=$4::jsonb where owner_id=$1 and session_id=$2 and operation_id=$3',[identity.ownerId,state.sessionId,r.id,JSON.stringify(result)]);
   return {saved,generation:Number(current.generation),result};
  },{isolation:'read committed'});
  await publish(identity.ownerId,r.expectedSessionId,committed.saved,committed.generation,r,committed.result);return clone(committed.result);
 }
 async function lookup(identity:VerifiedLegacyPrincipal,raw:unknown):Promise<Result>{
  try{return await performLookup(identity,raw);}catch(error){
   if(error instanceof ProductionProfileStoreError)throw error;return fail('ADDRESS_FLOW_UNAVAILABLE');
  }
 }
 function forProfile(owner:string,state:BotState,now:string):OperatorAddressProjection {
  if(options.enabled!==true||state.ownerId!==owner)return {};
  const base:OperatorAddressProjection={providerDirectoriesV2:[{...directory}]};
  try{
   const saved=options.bridge.get(owner,state.sessionId);if(saved?.directoryId!=='dtek:oem'||saved.providerV2?.directoryId!=='dtek:oem')return base;
   const p:OperatorProviderLookupState={directoryId:'dtek:oem'};
   for(const level of ['localities','streets','houses'] as const){
    const stage=saved.providerV2[level];if(!stage)continue;
    const projected:OperatorLookupStage={state:stage.state,query:stage.query,...(stage.code?{code:stage.code}:{}),...(stage.retryAt?{retryAt:stage.retryAt}:{})};
    if(stage.snapshot){const s=stage.snapshot;let stale=false;try{expiry(s.observedAt,s.expiresAt,now);}catch{stale=true;}
     projected.snapshot={kind:s.kind,id:s.id,revisionId:s.revisionId,namespace:s.namespace,level:s.level,catalogSnapshotId:s.catalogSnapshotId,
      ...(s.cityKey!==undefined?{cityKey:s.cityKey}:{}),...(s.streetKey!==undefined?{streetKey:s.streetKey}:{}),observedAt:s.observedAt,expiresAt:s.expiresAt,
      items:stale?[]:s.items.map(v=>({key:v.key,value:v.value,...(v.optionIds?{optionIds:[...v.optionIds]}:{})})),offset:s.offset,hasMore:s.hasMore,catalogCompleteness:s.catalogCompleteness};
     if(stale)projected.state='stale';
    }p[level]=projected;
   }
   const selected=saved.providerV2.selectedHouse;
   if(selected){
    let stale=selected.state==='stale';if(selected.state==='available')try{expiry(selected.observedAt,selected.expiresAt,now);}catch{stale=true;}
    const r={catalogSnapshotId:selected.catalogSnapshotId,houseSnapshotId:selected.houseSnapshotId,cityKey:selected.cityKey,streetKey:selected.streetKey,houseKey:selected.houseKey} as Extract<Request,{operation:'resolve'}>;
    const shownOptions=stale?[]:selected.options.map(v=>addressOption(v,r,false));
    const shownNotice=!stale&&selected.operatorHouseNotice?currentOperatorHouseNotice(selected.operatorHouseNotice,now):null;
    p.selectedHouse={...selection(r,stale?'stale':selected.state,selected.observedAt,selected.expiresAt),options:shownOptions,
     ...(shownNotice&&shownOptions.length&&shownOptions.every(o=>o.address.id===shownNotice.addressId)&&shownNotice.observedAt===selected.observedAt&&Date.parse(shownNotice.expiresAt)<=Date.parse(selected.expiresAt)?{operatorHouseNotice:shownNotice}:{})};
   }return {...base,providerLookupV2:p};
  }catch{return base;}
 }
 return Object.freeze({lookup,forProfile});
}
