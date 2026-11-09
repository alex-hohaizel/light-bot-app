import {createHash} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import type {AddressBinding,ScheduleView} from '../../shared/product-contract.ts';
import type {BotState} from '../../shared/bot/types.ts';
import {restoreBotState} from '../../shared/bot/engine.ts';
import {dayBounds,localParts,nextCalendarDate,validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
import {normalizeHouse} from '../../shared/address-index.ts';
import {normalizeYasnoRaw} from '../domain/yasno-adapter.ts';
import {buildYasnoAddressCandidate,YASNO_KYIV_ADDRESS_SCOPE,type YasnoAddressCapture} from '../domain/yasno-address-adapter.ts';
import {SOURCE_PROFILES} from './source-intake.ts';
import {technicalDisplaySourceRegistry,odesaPlanApiOperatingRecord} from './source-operating-policy.ts';
import {ADDRESS_CATALOG_POLICY,type createAddressCatalog} from './address-catalog.ts';
import {createCurrentRawScheduleVerifier} from './runtime-source-proof.ts';
import {scheduleEventDigest as digest,type ScheduleCertificateRecord,type createProductionScheduleEvents,type CertifiedScheduleSourceRequest} from './schedule-events.ts';
import {ProductionProfileStoreError,type createProductionProfileStore} from './profile-store.ts';
import type {LegacyProfileReadPool,LegacyProfileReadQuery} from './profile-reader.ts';
import type {PublicTechnicalPlans} from './source-ingestion.ts';
import type {createOperatorAddressRefresh} from './operator-address-refresh.ts';
import type {DispatchEligibilityRequest} from './telegram-dispatch.ts';
import type {CurrentDispatchSourceProof} from './telegram-dispatch-eligibility.ts';

import {DEPLOYED_QUALIFICATION_PINS,type PinnedQualificationFile,type DeployedQualificationPin} from './deployed-schedule-qualification.ts';
export {DEPLOYED_QUALIFICATION_PINS,type PinnedQualificationFile,type DeployedQualificationPin} from './deployed-schedule-qualification.ts';
export const QUALIFICATION_CODE_DEPENDENCIES=Object.freeze(["app/package-lock.json","app/package.json","app/server/domain/hour-matrix-adapter.ts","app/server/domain/kharkiv-adapter.ts","app/server/domain/odesa-address-adapter.ts","app/server/domain/odesa-plan-api-adapter.ts","app/server/domain/profile-service.ts","app/server/domain/provider-address-lookup.ts","app/server/domain/provider-wall-time.ts","app/server/domain/yasno-adapter.ts","app/server/domain/yasno-address-adapter.ts","app/server/production/address-catalog-http.ts","app/server/production/address-catalog.ts","app/server/production/address-flow.ts","app/server/production/bot-address-preflight.ts","app/server/production/canonical-runtime.ts","app/server/production/legacy-campaign-recipient.ts","app/server/production/legacy-profile.ts","app/server/production/odesa-address-catalog.ts","app/server/production/odesa-plan-source.ts","app/server/production/operator-address-flow.ts","app/server/production/operator-address-refresh.ts","app/server/production/profile-reader.ts","app/server/production/profile-store.ts","app/server/production/provider-address-catalog.ts","app/server/domain/public-address-request-identity.ts","app/server/production/public-source-reservation.ts","app/server/production/runtime-context.ts","app/server/production/runtime-source-proof.ts","app/server/production/schedule-certification.ts","app/server/production/schedule-events.ts","app/server/production/source-ingestion.ts","app/server/production/source-intake.ts","app/server/production/source-operating-policy.ts","app/server/production/telegram-callback-ack.ts","app/server/production/telegram-dispatch-eligibility.ts","app/server/production/telegram-dispatch.ts","app/server/production/telegram-transport.ts","app/server/providers/odesa-public-client.ts","app/server/release/update-campaign-pg.ts","app/server/release/update-campaign.ts","app/server/runtime-policy.ts","app/shared/address-index.ts","app/shared/address-selection.ts","app/shared/bot/copy.ts","app/shared/bot/engine.ts","app/shared/bot/types.ts","app/shared/delivery-contract.ts","app/shared/morning-briefing.ts","app/shared/notification-policy.ts","app/shared/operator-house-notice.ts","app/shared/product-contract.ts","app/shared/profile-constraints.ts","app/shared/profile-mutation.ts","app/shared/schedule-binding.ts","app/shared/schedule-core.ts","app/shared/time-label.ts"]);
/** index.ts passes its actual source or bundled entry directory. Both
 * candidate/app/server and candidate/app/dist-production have the same depth.
 * This uses neither process.cwd() nor an environment/HTTP authority override. */
export function qualificationRootFromEntryDirectory(entryDirectory:string){if(!path.isAbsolute(entryDirectory))return die('ENTRY_ROOT_INVALID');return path.resolve(entryDirectory,'../..');}
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const closed=(v:unknown,keys:string[]):v is Record<string,any>=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const die=(code:string):never=>{throw new ProductionProfileStoreError('SCHEDULE_CERTIFICATION_'+code);};
const scope=(v:ScheduleView)=>({operatorId:v.operatorId,namespace:v.namespace,targetId:v.targetId,serviceDate:v.serviceDate,status:v.status,dayCoverage:v.dayCoverage,intervals:v.intervals});
const iso=(v:any)=>v instanceof Date?v.toISOString():v;
const accepted=(e:unknown,kind:string,extra:string[],issuedAt:string,expiresAt:string)=>closed(e,['kind','evidenceRef','acceptedAt','validUntil',...extra])&&e.kind===kind&&text(e.evidenceRef)&&validInstant(e.acceptedAt)&&validInstant(e.validUntil)&&Date.parse(e.acceptedAt)<=Date.parse(issuedAt)&&Date.parse(e.acceptedAt)<Date.parse(e.validUntil)&&Date.parse(expiresAt)<=Date.parse(e.validUntil);
interface Admission {bundleSha256:string;reviewSha256:string;sourceId:string;operatorId:string;namespace:string;validUntil:string;reviewedAt:string;
 addressIds:ReadonlySet<string>|null;targetIds:ReadonlySet<string>;startedAt:string;finishedAt:string;medium:'observed'|'synthetic_fixture'}
export interface LoadedQualificationRegistry {readonly medium:'observed'|'synthetic_fixture';readonly bundleCount:number}
const registries=new WeakMap<object,readonly Admission[]>();
const emptyRegistry=():LoadedQualificationRegistry=>{const r=Object.freeze({medium:'observed' as const,bundleCount:0});registries.set(r,Object.freeze([]));return r;};

/** Explicit bounded filesystem read, outside every owner/provider transaction.
 * Exact raw/fact/code bytes plus a separately deployed independent-review pin
 * are the trust boundary. JSON shape alone never proves real observation. */
export async function loadDeployedQualificationRegistry(options:{rootDirectory:string;pins?:readonly DeployedQualificationPin[];purpose?:'production'|'synthetic_test'}):Promise<LoadedQualificationRegistry>{
 if(options.pins!==undefined&&options.purpose!=='synthetic_test')return die('DEPLOYED_PINS_ONLY');
 const pins=options.pins??DEPLOYED_QUALIFICATION_PINS;if(!Array.isArray(pins)||pins.length>16)return die('REGISTRY_INVALID');
 if(!pins.length)return emptyRegistry();
 if(!path.isAbsolute(options.rootDirectory))return die('ABSOLUTE_DEPLOYED_ROOT_REQUIRED');const root=await realpath(options.rootDirectory);let total=0,files=0;
 async function read(ref:PinnedQualificationFile,limit=2_000_000){
  if(!closed(ref,['path','sha256'])||!text(ref.path)||path.isAbsolute(ref.path)||ref.path.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')||!hex(ref.sha256))return die('FILE_PIN_INVALID');
  let current=root;for(const part of ref.path.split('/')){current=path.join(current,part);if((await lstat(current)).isSymbolicLink())return die('SYMLINK_REJECTED');}
  const target=await realpath(current);if(!target.startsWith(root+path.sep))return die('FILE_OUTSIDE_ROOT');const stat=await lstat(target);
  if(!stat.isFile()||stat.size>limit||++files>30000||(total+=stat.size)>256_000_000)return die('FILE_BOUNDS');
  const raw=await readFile(target);if(sha(raw)!==ref.sha256)return die('FILE_HASH_MISMATCH');return raw;
 }
 async function json(ref:PinnedQualificationFile){const raw=await read(ref);try{return JSON.parse(raw.toString('utf8'));}catch{return die('JSON_INVALID');}}
 const admissions:Admission[]=[];let registryMedium:'observed'|'synthetic_fixture'='observed';
 for(const pin of pins){
  if(!closed(pin,['bundle','reviewReceipt']))return die('PIN_INVALID');
  const b=await json(pin.bundle),receipt=await json(pin.reviewReceipt);
  if(!closed(b,['kind','sourceId','operatorId','namespace','reviewedAt','validUntil','medium','codePins','primary','fallback','control','coverage','addresses','observations','maximumObservationGapMs','negativeFixtures'])||
   b.kind!=='lba-reviewed-schedule-qualification/1'||!['observed','synthetic_fixture'].includes(b.medium)||b.medium==='synthetic_fixture'&&options.purpose!=='synthetic_test'||options.purpose==='synthetic_test'&&b.medium!=='synthetic_fixture'||
   !validInstant(b.reviewedAt)||!validInstant(b.validUntil)||Date.parse(b.validUntil)<=Date.parse(b.reviewedAt)||!Number.isSafeInteger(b.maximumObservationGapMs)||b.maximumObservationGapMs<60000||b.maximumObservationGapMs>86400000)return die('BUNDLE_INVALID');
  const p=SOURCE_PROFILES.find(p=>p.sourceId===b.sourceId);
  // Exact supported address implementation. Other regions retain their existing
  // technical/blocked states until a reviewed address adapter exists.
  if(!p||p.automationBlocked||p.sourceId!=='yasno-kem'||p.operatorId!==b.operatorId||p.namespace!==b.namespace)return die('UNSUPPORTED_SOURCE_SCOPE');
  if(!closed(receipt,['kind','bundleSha256','reviewer','reviewedAt','medium','inventorySha256'])||receipt.kind!=='lba-independent-qualification-review/1'||receipt.bundleSha256!==pin.bundle.sha256||
   !text(receipt.reviewer)||receipt.medium!==b.medium||receipt.reviewedAt!==b.reviewedAt||receipt.inventorySha256!==digest({codePins:b.codePins,addresses:b.addresses,observations:b.observations,negativeFixtures:b.negativeFixtures,coverage:b.coverage,primary:b.primary,fallback:b.fallback,control:b.control}))return die('REVIEW_RECEIPT_MISMATCH');
  if(!Array.isArray(b.codePins)||b.codePins.length>64||QUALIFICATION_CODE_DEPENDENCIES.some(k=>b.codePins.filter((r:any)=>r.path===k).length!==1))return die('CODE_INVENTORY_INCOMPLETE');
  for(const ref of b.codePins)await read(ref);
  for(const route of [b.primary,b.fallback,b.control])if(!closed(route,['endpoint','upstreamChain','acquisitionId','accessCost','evidence'])||!text(route.endpoint)||new URL(route.endpoint).protocol!=='https:'||
   !Array.isArray(route.upstreamChain)||!route.upstreamChain.length||route.upstreamChain.some((v:unknown)=>!text(v))||!text(route.acquisitionId)||route.accessCost!==0||!text(route.evidence))return die('PROVENANCE_INVALID');
  if(b.primary.endpoint!==p.endpoint||b.control.acquisitionId===b.primary.acquisitionId||b.control.acquisitionId===b.fallback.acquisitionId)return die('CONTROL_NOT_INDEPENDENTLY_ACQUIRED');
  if(!closed(b.coverage,['kind','addressIds'])||!['representative','exact_addresses'].includes(b.coverage.kind)||!Array.isArray(b.coverage.addressIds)||!b.coverage.addressIds.length||new Set(b.coverage.addressIds).size!==b.coverage.addressIds.length||b.coverage.addressIds.some((id:unknown)=>!text(id))||
   b.coverage.kind==='representative'&&b.coverage.addressIds.length<20||!Array.isArray(b.addresses)||b.addresses.length!==b.coverage.addressIds.length)return die('ADDRESS_COVERAGE_INCOMPLETE');
  const targets=new Map<string,string>();
  for(const address of b.addresses){
   if(!closed(address,['addressId','streetId','streetValue','houseId','houseLiteral','targetId','captures'])||targets.has(address.addressId)||!b.coverage.addressIds.includes(address.addressId)||!closed(address.captures,['streets','houses','group']))return die('ADDRESS_EVIDENCE_INVALID');
   const captures={streets:await json(address.captures.streets),houses:await json(address.captures.houses),group:await json(address.captures.group)};
   const candidate=buildYasnoAddressCandidate({scope:YASNO_KYIV_ADDRESS_SCOPE,selection:{streetId:address.streetId,streetValue:address.streetValue,houseId:address.houseId,houseLiteral:address.houseLiteral},captures,
    policy:{asOf:captures.group.observedAt,maximumCaptureAgeMs:86400000}});
   if(candidate.address.id!==address.addressId||candidate.binding.targetId!==address.targetId||Date.parse(captures.group.observedAt)>Date.parse(b.reviewedAt))return die('ADDRESS_SCOPE_MISMATCH');
   targets.set(address.addressId,address.targetId);
  }
  if(!Array.isArray(b.observations)||b.observations.length>20000||!Array.isArray(b.negativeFixtures)||b.negativeFixtures.length<3||b.negativeFixtures.length>100)return die('OBSERVATIONS_INVALID');
  const times=new Map<string,number[]>(),all:number[]=[];
  for(const o of b.observations){
   if(!closed(o,['addressId','targetId','serviceDate','observedAt','primary','fallback','control'])||targets.get(o.addressId)!==o.targetId||!validInstant(o.observedAt)||Date.parse(o.observedAt)>Date.parse(b.reviewedAt))return die('OBSERVATION_SCOPE_INVALID');
   const plans:unknown[]=[];
   for(const role of ['primary','fallback','control'] as const){
    const fact=await json(o[role]);if(!closed(fact,['kind','acquisitionId','observedAt','addressId','targetId','serviceDate','raw','plan'])||fact.kind!=='lba-observed-plan-fact/1'||fact.acquisitionId!==b[role].acquisitionId||fact.observedAt!==o.observedAt||fact.addressId!==o.addressId||fact.targetId!==o.targetId||fact.serviceDate!==o.serviceDate)return die('OBSERVATION_FACT_MISMATCH');
    const raw=await read(fact.raw);if(!raw.length||!closed(fact.plan,['operatorId','namespace','targetId','serviceDate','status','dayCoverage','intervals'])||fact.plan.operatorId!==p.operatorId||fact.plan.namespace!==p.namespace||fact.plan.targetId!==o.targetId||fact.plan.serviceDate!==o.serviceDate)return die('PLAN_FACT_INVALID');
    if(role==='primary'){
     const today=localParts(Date.parse(o.observedAt)).date;
     if(![today,nextCalendarDate(today)].includes(o.serviceDate))return die('OBSERVATION_DAY_INVALID');
     const parsed=normalizeYasnoRaw(raw.toString('utf8'),o.serviceDate===today?'today':'tomorrow',{namespace:'yasno:25/902',operatorId:p.operatorId,targetId:o.targetId,addressId:o.addressId,addressLabel:o.addressId,localityLabel:'Київ',serviceDate:o.serviceDate,observedAt:o.observedAt,
      source:{id:p.sourceId,name:p.name,url:p.endpoint,revision:fact.raw.sha256,accessCost:0,verifiedLevel:'schedule'},freshness:'current',synthetic:false});
     if(digest(scope(parsed))!==digest(fact.plan))return die('PRIMARY_REPROJECTION_MISMATCH');
    }
    plans.push(fact.plan);
   }
   if(plans.some(v=>digest(v)!==digest(plans[0])))return die('OBSERVED_PLAN_CONFLICT');
   const t=Date.parse(o.observedAt),list=times.get(o.addressId)??[];list.push(t);times.set(o.addressId,list);all.push(t);
  }
  for(const id of targets.keys()){const t=(times.get(id)??[]).sort((a,b)=>a-b);if(t.length<3||new Set(t).size!==t.length||t.at(-1)!-t[0]<48*3600000||t.slice(1).some((n,i)=>n-t[i]>b.maximumObservationGapMs))return die('OBSERVED_48H_INCOMPLETE');}
  // Negative raw fixtures are actually executed against the same normalizer,
  // not accepted because a manifest says passed:true.
  for(const n of b.negativeFixtures){if(!closed(n,['raw','observedAt','serviceDate','targetId'])||!validInstant(n.observedAt))return die('NEGATIVE_FIXTURE_INVALID');const raw=await read(n.raw);let rejected=false;
   try{normalizeYasnoRaw(raw.toString('utf8'),'today',{namespace:'yasno:25/902',operatorId:p.operatorId,targetId:n.targetId,addressId:'negative',addressLabel:'negative',localityLabel:'Київ',serviceDate:n.serviceDate,observedAt:n.observedAt,source:{id:p.sourceId,name:p.name,url:p.endpoint,revision:n.raw.sha256,accessCost:0,verifiedLevel:'schedule'},freshness:'current',synthetic:false});}catch{rejected=true;}
   if(!rejected)return die('NEGATIVE_FIXTURE_ACCEPTED');
  }
  if(b.medium==='synthetic_fixture')registryMedium='synthetic_fixture';
  admissions.push(Object.freeze({bundleSha256:pin.bundle.sha256,reviewSha256:pin.reviewReceipt.sha256,sourceId:p.sourceId,operatorId:p.operatorId,namespace:p.namespace,reviewedAt:b.reviewedAt,validUntil:b.validUntil,
   addressIds:b.coverage.kind==='exact_addresses'?new Set(targets.keys()):null,targetIds:new Set(targets.values()),startedAt:new Date(Math.min(...all)).toISOString(),finishedAt:new Date(Math.max(...all)).toISOString(),medium:b.medium}));
 }
 if(new Set(admissions.map(a=>a.sourceId)).size!==admissions.length)return die('AMBIGUOUS_SOURCE_ADMISSION');
 const result=Object.freeze({medium:registryMedium,bundleCount:admissions.length});registries.set(result,Object.freeze(admissions));return result;
}

const certificateId=(v:unknown)=>{const h=digest(v);return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
const principal=(ownerId:string)=>({kind:'verified_server_principal' as const,ownerId,verified:true as const});
type Store=Pick<ReturnType<typeof createProductionProfileStore>,'commitCertifiedBinding'>;
type Events=Pick<ReturnType<typeof createProductionScheduleEvents>,'qualifySchedule'>;
type Sources={readTechnicalPlans:()=>Promise<PublicTechnicalPlans>};
type Catalog=Pick<ReturnType<typeof createAddressCatalog>,'searchStreets'|'searchHouses'|'resolveCandidate'>;

/** Production composition uses the empty deployed registry until actual reviewed
 * evidence is supplied. A branded loaded fixture registry is confined to the
 * explicit synthetic-test composition; plain JSON cannot impersonate either. */
export function createProductionScheduleCertification(options:{enabled:boolean;odesaPlanApiEnabled?:boolean;expectedControlEpoch:number;pool:LegacyProfileReadPool;store:Store;sources:Sources;catalog:Catalog;
 now?:()=>number;registry?:LoadedQualificationRegistry;execution?:'production'|'synthetic_test';batchSize?:number;
 publicAddressRefresh?:ReturnType<typeof createOperatorAddressRefresh>['refreshOneSavedAddress']}){
 let registry=options.registry??emptyRegistry();const clock=options.now??Date.now,epoch=options.expectedControlEpoch,batch=options.batchSize??20;
 const checkRegistry=(r:LoadedQualificationRegistry)=>{if(!registries.has(r)||r.medium==='synthetic_fixture'&&options.execution!=='synthetic_test')return die('REGISTRY_AUTHORITY_REQUIRED');};checkRegistry(registry);
 if(!Number.isSafeInteger(epoch)||epoch<1||!Number.isInteger(batch)||batch<1||batch>50||typeof options.enabled!=='boolean'||options.publicAddressRefresh!==undefined&&typeof options.publicAddressRefresh!=='function')return die('OPTIONS_INVALID');
 const verifyRaw=createCurrentRawScheduleVerifier({expectedControlEpoch:epoch,odesaPlanApiEnabled:options.odesaPlanApiEnabled??false});let running=false,stopped=false,cursor='',publicRefreshCycle=0,last={state:'disabled',scanned:0,issued:0,replayed:0,pending:0};
 function admission(view:ScheduleView,at:string,addressId:string){const n=Date.parse(at);return registries.get(registry)!.find(a=>a.sourceId===view.source.id&&a.operatorId===view.operatorId&&a.namespace===view.namespace&&a.targetIds.has(view.targetId!)&&(!a.addressIds||a.addressIds.has(addressId))&&Date.parse(a.reviewedAt)<=n&&n<Date.parse(a.validUntil));}
 function rawExpiry(view:ScheduleView){const operating=view.source.id==='dtek-oem-public-plan-ajax'?odesaPlanApiOperatingRecord(options.odesaPlanApiEnabled===true):technicalDisplaySourceRegistry(true).find(a=>a.sourceId===view.source.id);return operating&&operating.state!=='blocked'?Math.min(Date.parse(view.observedAt)+operating.cacheTtlMs,Date.parse(operating.validUntil)):0;}
 async function addressFacts(client:LegacyProfileReadQuery,state:BotState,addressId:string,at:string){
  const location=state.profile.locations.find(l=>l.address.id===addressId);if(!location||location.binding.kind==='user_selected_group')return null;
  const ids=/^provisional:yasno:25\/902:street:(\d+):house:(\d+)$/.exec(addressId);if(!ids)return null;
  // Ownership comes from the owner's saved exact resolve result, not the global
  // candidate or a historical label. Its immutable receipt survives cache TTL.
  const lookup=(await client.query('select generation,state from lba_production_address_lookup where owner_id=$1 and session_id=$2 for share',[state.ownerId,state.sessionId])).rows;
  if(lookup.length!==1||!Number.isSafeInteger(Number(lookup[0].generation))||Number(lookup[0].generation)<1||!lookup[0].state?.optionIds?.includes(addressId))return null;
  const selected=(await client.query(`select result from lba_production_address_lookup_requests where owner_id=$1 and session_id=$2 and result->>'state'='available' and result->'option'->'address'->>'id'=$3 order by recorded_at desc,operation_id desc limit 1 for share`,[state.ownerId,state.sessionId,addressId])).rows[0]?.result;
  if(!plain(selected)||selected.option?.address?.streetId!==location.address.streetId||selected.option?.binding?.operatorId!==location.binding.operatorId||selected.option?.binding?.namespace!==location.binding.namespace||selected.option?.binding?.kind!=='operator_group'||digest(selected.candidateProof?.scope)!==digest(YASNO_KYIV_ADDRESS_SCOPE)||
   normalizeHouse(selected.option.address.house.literal)!==normalizeHouse(location.address.house.literal)||selected.candidateProof?.providerStreetId!==Number(ids[1])||selected.candidateProof?.providerHouseId!==Number(ids[2]))return null;
  if(location.binding.status==='needs_confirmation'&&selected.option.binding.revisionId!==location.binding.revisionId)return null;
  const row=(await client.query('select streets_id,houses_id,group_id from lba_public_address_candidate where address_id=$1 for share',[addressId])).rows[0];if(!row)return null;
  const rows=(await client.query('select id,operation,request_url,capture,control_epoch from lba_public_address_capture where id=any($1::uuid[]) order by id for share',[[row.streets_id,row.houses_id,row.group_id]])).rows;
  if(rows.length!==3||rows.some(r=>Number(r.control_epoch)!==epoch))return null;
  for(const row of rows){const q=(await client.query('select latest_capture_id,last_attempt_at,last_failure from lba_public_address_query where request_key=$1 and request_url=$2 for share',[sha(row.request_url),row.request_url])).rows;
   if(q.length!==1||q[0].latest_capture_id!==row.id||q[0].last_failure!==null&&Date.parse(iso(q[0].last_attempt_at))>=Date.parse(row.capture.observedAt))return null;}
  const byId=new Map(rows.map(r=>[r.id,r])),captures={streets:byId.get(row.streets_id)?.capture,houses:byId.get(row.houses_id)?.capture,group:byId.get(row.group_id)?.capture};
  const built=buildYasnoAddressCandidate({scope:YASNO_KYIV_ADDRESS_SCOPE,selection:{streetId:Number(ids[1]),streetValue:location.address.street,houseId:Number(ids[2]),houseLiteral:location.address.house.literal},captures,
   policy:{asOf:at,maximumCaptureAgeMs:ADDRESS_CATALOG_POLICY.maximumCaptureAgeMs}});
  if(built.address.id!==addressId||built.address.streetId!==location.address.streetId)return null;
  const expiry=Math.min(...Object.values(captures).map(c=>Date.parse(c.observedAt)+ADDRESS_CATALOG_POLICY.cacheTtlMs));
  return {built,expiry,selection: digest(selected),captures:built.proof.captures};
 }
 async function refreshAddress(state:BotState,addressId:string){
  const location=state.profile.locations.find(l=>l.address.id===addressId),ids=/^provisional:yasno:25\/902:street:(\d+):house:(\d+)$/.exec(addressId);if(!location||!ids)return;
  const street=await options.catalog.searchStreets({namespace:'yasno:25/902',query:location.address.street});if(street.state!=='available'||!street.snapshot.items.some(i=>i.id===Number(ids[1])))return;
  const house=await options.catalog.searchHouses({streetSnapshotId:street.snapshot.id,streetId:Number(ids[1]),query:location.address.house.literal});if(house.state!=='available'||!house.snapshot.items.some(i=>i.id===Number(ids[2])))return;
  await options.catalog.resolveCandidate({streetSnapshotId:street.snapshot.id,houseSnapshotId:house.snapshot.id,streetId:Number(ids[1]),houseId:Number(ids[2])});
 }
 async function issue(input:{state:BotState;view:ScheduleView;signal:AbortSignal}){
  if(!options.enabled||!registry.bundleCount||stopped||input.signal.aborted)return {kind:'pending'};
  const hint=input.state,selected=hint.profile.locations.find(l=>l.address.id===input.view.addressId);if(!selected)return {kind:'pending'};
  const expected={sessionId:hint.sessionId,revision:hint.revision,addressId:selected.address.id,bindingDigest:digest(selected.binding)};
  return options.store.commitCertifiedBinding(principal(hint.ownerId),expected,async tx=>{
   if(stopped||input.signal.aborted)return {kind:'pending'};
   const location=tx.state.profile.locations.find(l=>l.address.id===selected.address.id);if(!location)return {kind:'pending'};
   const a=admission(input.view,tx.serverNow,location.address.id);if(!a||input.view.operatorId!==location.binding.operatorId||input.view.namespace!==location.binding.namespace)return {kind:'pending'};
   const facts=await addressFacts(tx.client,tx.state,location.address.id,tx.serverNow);if(!facts||facts.built.binding.targetId!==input.view.targetId||facts.built.binding.operatorId!==a.operatorId||facts.built.binding.namespace!==a.namespace)return {kind:'pending'};
   const revisionId='verified-provider:'+digest({addressId:location.address.id,operatorId:a.operatorId,namespace:a.namespace,targetId:facts.built.binding.targetId,admission:a.bundleSha256});
   const binding:AddressBinding=location.binding.status==='verified'&&location.binding.revisionId===revisionId?structuredClone(location.binding):{
    ...facts.built.binding,revisionId,status:'verified',verifiedAt:tx.serverNow,effectiveFrom:tx.serverNow,effectiveUntil:a.validUntil};
   const view:ScheduleView={...structuredClone(input.view),addressId:location.address.id,addressLabel:location.address.label,localityLabel:location.address.locality,bindingRevisionId:binding.revisionId,
    source:{...input.view.source,verifiedLevel:'integration'},deliveryEligible:true,
    ...(input.view.notice==='Технічний ключ джерела; адресна прив’язка й допуск персональних сповіщень перевіряються окремо.'?{notice:'План для цієї адреси. Час та інтервали можуть змінюватися.'}:{})};
   validateScheduleView(view);const fact=await verifyRaw({client:tx.client,view,now:tx.serverNow,signal:input.signal});
   if(!fact||fact.addressBindingVerified!==false||fact.deliveryEligible!==false||view.freshness!=='current'||!['published','possible','no_planned_outages','emergency'].includes(view.status)||view.status!=='emergency'&&view.dayCoverage!=='complete')return {kind:'pending'};
   const now=Date.parse(tx.serverNow),expires=Math.min(facts.expiry,Date.parse(a.validUntil),Date.parse(binding.effectiveUntil!),dayBounds(view.serviceDate).end,
    rawExpiry(view));
   if(expires<=now)return {kind:'pending'};
   const id=certificateId({owner:tx.state.ownerId,session:tx.state.sessionId,epoch,view:digest(view),binding:digest(binding),bundle:a.bundleSha256,addressCaptures:digest(facts.captures)});
   const existing=(await tx.client.query('select record,record_digest,view_digest,revoked_at,expires_at from lba_production_schedule_certificate where id=$1 for share',[id])).rows;
   if(existing.length){const old=existing[0];if(existing.length!==1||!plain(old.record)||digest(old.record)!==old.record_digest||old.view_digest!==digest(view)||old.record.ownerId!==tx.state.ownerId||old.record.sessionId!==tx.state.sessionId||digest(old.record.binding)!==digest(binding)||old.revoked_at!==null||Date.parse(iso(old.expires_at))<=now)return die('CERTIFICATE_REPLAY_CONFLICT');return {kind:'replayed',certificateId:id};}
   if(tx.state.revision!==expected.revision||digest(location.binding)!==expected.bindingDigest)return die('SELECTION_CHANGED');
   await tx.persistBinding(binding);
   const expiresAt=new Date(expires).toISOString(),ref='review-sha256:'+a.reviewSha256+'/bundle-sha256:'+a.bundleSha256;
   const record:ScheduleCertificateRecord={kind:'lba-certified-schedule/1',ownerId:tx.state.ownerId,sessionId:tx.state.sessionId,controlEpoch:epoch,issuedAt:tx.serverNow,expiresAt,view,binding,
    sourceEvidence:{kind:'accepted_source_revision',sourceId:view.source.id,sourceRevision:view.source.revision,acceptedAt:tx.serverNow,validUntil:expiresAt,evidenceRef:ref},
    addressEvidence:{kind:'accepted_address_binding',bindingRevisionId:binding.revisionId,bindingDigest:digest(binding),acceptedAt:tx.serverNow,validUntil:expiresAt,evidenceRef:ref+'/selection:'+facts.selection+'/captures:'+digest(facts.captures)},
    parallel48hEvidence:{kind:'accepted_parallel_48h',sourceId:view.source.id,operatorId:view.operatorId,namespace:view.namespace!,targetId:view.targetId!,startedAt:a.startedAt,finishedAt:a.finishedAt,acceptedAt:a.reviewedAt,evidenceRef:ref}};
   if(stopped||input.signal.aborted||admission(view,tx.serverNow,view.addressId)!==a)return die('ABORTED');
   await tx.client.query('update lba_production_schedule_certificate set revoked_at=$5 where owner_id=$1 and session_id=$2 and address_id=$3 and (record->\'view\'->>\'serviceDate\'=$4 or binding_revision_id<>$6) and revoked_at is null',[tx.state.ownerId,tx.state.sessionId,view.addressId,view.serviceDate,tx.serverNow,binding.revisionId]);
   await tx.client.query(`insert into lba_production_schedule_certificate(id,owner_id,session_id,control_epoch,address_id,schedule_revision_id,source_revision,binding_revision_id,view_digest,record_digest,record,issued_at,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,[id,tx.state.ownerId,tx.state.sessionId,epoch,view.addressId,view.revisionId,view.source.revision,binding.revisionId,digest(view),digest(record),JSON.stringify(record),tx.serverNow,expiresAt]);
   if(stopped||input.signal.aborted||admission(view,tx.serverNow,view.addressId)!==a)return die('ABORTED');
   return {kind:'issued',certificateId:id};
  });
 }
 let ownerOffset:{ownerId:string;index:number}|undefined;
 async function targetHint(addressId:string){
  const c=await options.pool.connect();try{const r=(await c.query('select raw.capture from lba_public_address_candidate p join lba_public_address_capture raw on raw.id=p.group_id where p.address_id=$1',[addressId])).rows;
   if(r.length!==1||typeof r[0].capture?.rawBody!=='string')return null;const v=JSON.parse(r[0].capture.rawBody);return Number.isInteger(v.group)&&v.subgroup===1?String(v.group)+'.1':null;
  }finally{c.release();}
 }
 async function runOnce({signal}:{signal:AbortSignal}){
  if(!options.enabled||!registry.bundleCount&&!options.publicAddressRefresh)return {...last,state:'disabled'};if(stopped||signal.aborted)return {...last,state:'stopped'};if(running)return {...last,state:'busy'};running=true;
  try{
   const client=await options.pool.connect();let rows:any[];try{rows=(await client.query('select owner_id,session_id,state from lba_production_profiles where control_epoch=$1 and owner_id>$2 order by owner_id limit $3',[epoch,cursor,batch])).rows;}finally{client.release();}
   if(!rows.length){cursor='';ownerOffset=undefined;return last={state:'observed',scanned:0,issued:0,replayed:0,pending:0};}
   const cycle=++publicRefreshCycle,plans=registry.bundleCount?await options.sources.readTechnicalPlans():{plans:[]};last={state:'observed',scanned:0,issued:0,replayed:0,pending:0};let visited=0;
   for(const row of rows){
    if(stopped||signal.aborted)break;let state=restoreBotState(row.state,row.owner_id);if(state.ownerId!==row.owner_id||state.sessionId!==row.session_id)return die('PROFILE_SCOPE_INVALID');
    const locations=state.profile.locations,start=ownerOffset&&ownerOffset.ownerId===row.owner_id?ownerOffset.index:0;
    for(let i=start;i<locations.length;i++){
     if(stopped||signal.aborted)return {...last,state:'stopped'};
     if(last.scanned>=100||visited++>=50){ownerOffset={ownerId:row.owner_id,index:i};return {...last};}
     const location=locations[i];
     // Public house reports are a separate read-only operation. They do not
     // require, populate or bypass the personal qualification registry. The
     // existing cycle owns one bounded tuple; no new timer or owner write.
     if(options.publicAddressRefresh)try{
      const refreshed=await options.publicAddressRefresh({address:location.address,binding:location.binding},{cycle,signal});
      if(refreshed.state==='skipped'&&refreshed.code==='OPERATOR_REFRESH_CYCLE_BOUND'){
       // Resume AT the first different public tuple next cycle. Advancing the
       // owner cursor past it would let a cached first street starve all others.
       ownerOffset={ownerId:row.owner_id,index:i};return {...last};
      }
     }catch{/* No source/certificate/profile authority is inferred from a failed refresh. */}
     if(stopped||signal.aborted)return {...last,state:'stopped'};
     if(!registries.get(registry)!.some(a=>a.operatorId===location.binding.operatorId&&a.namespace===location.binding.namespace&&(!a.addressIds||a.addressIds.has(location.address.id)))){last.pending++;continue;}
     try{
      // Public network/cache refresh is outside the canonical owner transaction.
      await refreshAddress(state,location.address.id);const target=await targetHint(location.address.id);
      const at=new Date(clock()).toISOString(),dates=[localParts(clock()).date,nextCalendarDate(localParts(clock()).date)];
      const matching=plans.plans.filter(p=>p.view.operatorId===location.binding.operatorId&&p.view.namespace===location.binding.namespace&&p.view.targetId===target&&dates.includes(p.view.serviceDate)&&admission(p.view,at,location.address.id)).slice(0,2);
      if(!matching.length){last.pending++;continue;}
      for(const p of matching){
       last.scanned++;const result=await issue({state,view:{...p.view,addressId:location.address.id},signal});
       if(result.kind==='issued'){
        last.issued++;const c=await options.pool.connect();try{const fresh=(await c.query('select state from lba_production_profiles where owner_id=$1 and session_id=$2 and control_epoch=$3',[state.ownerId,state.sessionId,epoch])).rows;if(fresh.length!==1)return die('PROFILE_CHANGED');state=restoreBotState(fresh[0].state,state.ownerId);}finally{c.release();}
       }else if(result.kind==='replayed')last.replayed++;else last.pending++;
      }
     }catch{last.pending++;}
    }
    ownerOffset=undefined;cursor=row.owner_id;
   }
   return {...last};
  }finally{running=false;}
 }
 async function readCertifiedProjection(){
  if(!options.enabled||!registry.bundleCount||stopped)return [];
  const client=await options.pool.connect();try{const at=new Date(clock()).toISOString();const rows=(await client.query(`select c.owner_id,c.session_id,c.control_epoch,c.address_id,c.schedule_revision_id,c.binding_revision_id,c.source_revision,c.record,c.record_digest,c.view_digest,c.issued_at,c.expires_at from lba_production_schedule_certificate c join lba_production_profiles p on p.owner_id=c.owner_id and p.session_id=c.session_id
   where c.control_epoch=$1 and p.control_epoch=$1 and c.revoked_at is null and c.issued_at<=$2::timestamptz and c.expires_at>$2::timestamptz order by c.issued_at desc,c.id desc limit 20001`,[epoch,at])).rows;
   if(rows.length>20000)return die('PROJECTION_LIMIT');return rows.flatMap(r=>{try{const c=r.record as ScheduleCertificateRecord;validateScheduleView(c.view);const a=admission(c.view,at,c.view.addressId),ref=a?'review-sha256:'+a.reviewSha256+'/bundle-sha256:'+a.bundleSha256:null;
    if(!closed(c,['kind','ownerId','sessionId','controlEpoch','issuedAt','expiresAt','view','binding','sourceEvidence','addressEvidence','parallel48hEvidence'])||c.kind!=='lba-certified-schedule/1'||c.controlEpoch!==epoch||Number(r.control_epoch)!==epoch||c.ownerId!==r.owner_id||c.sessionId!==r.session_id||c.view.addressId!==r.address_id||c.view.revisionId!==r.schedule_revision_id||c.binding.revisionId!==r.binding_revision_id||c.view.source.revision!==r.source_revision||
     c.view.source.verifiedLevel!=='integration'||c.view.deliveryEligible!==true||c.view.synthetic!==false||c.view.bindingRevisionId!==c.binding.revisionId||c.binding.addressId!==c.view.addressId||c.binding.status!=='verified'||c.binding.kind!=='operator_group'||c.binding.operatorId!==c.view.operatorId||c.binding.namespace!==c.view.namespace||c.binding.targetId!==c.view.targetId||!validInstant(c.binding.verifiedAt)||!validInstant(c.binding.effectiveUntil)||Date.parse(c.binding.verifiedAt)>Date.parse(at)||Date.parse(c.binding.effectiveUntil)<=Date.parse(at)||digest(c)!==r.record_digest||digest(c.view)!==r.view_digest||!a||
     !accepted(c.sourceEvidence,'accepted_source_revision',['sourceId','sourceRevision'],c.issuedAt,c.expiresAt)||!accepted(c.addressEvidence,'accepted_address_binding',['bindingRevisionId','bindingDigest'],c.issuedAt,c.expiresAt)||
     c.sourceEvidence.evidenceRef!==ref||c.parallel48hEvidence.evidenceRef!==ref||!c.addressEvidence.evidenceRef.startsWith(ref+'/selection:')||c.addressEvidence.bindingRevisionId!==c.binding.revisionId||c.addressEvidence.bindingDigest!==digest(c.binding)||
     c.sourceEvidence.sourceRevision!==c.view.source.revision||c.sourceEvidence.sourceId!==c.view.source.id||!closed(c.parallel48hEvidence,['kind','sourceId','operatorId','namespace','targetId','startedAt','finishedAt','acceptedAt','evidenceRef'])||c.parallel48hEvidence.kind!=='accepted_parallel_48h'||c.parallel48hEvidence.sourceId!==a.sourceId||c.parallel48hEvidence.operatorId!==a.operatorId||c.parallel48hEvidence.namespace!==a.namespace||c.parallel48hEvidence.targetId!==c.view.targetId||c.parallel48hEvidence.startedAt!==a.startedAt||c.parallel48hEvidence.finishedAt!==a.finishedAt||c.parallel48hEvidence.acceptedAt!==a.reviewedAt||
     iso(r.issued_at)!==c.issuedAt||iso(r.expires_at)!==c.expiresAt||!validInstant(c.issuedAt)||!validInstant(c.expiresAt)||Date.parse(c.issuedAt)>Date.parse(at)||Date.parse(c.expiresAt)<=Date.parse(at)||Date.parse(c.expiresAt)>Math.min(Date.parse(a.validUntil),Date.parse(c.binding.effectiveUntil),rawExpiry(c.view),dayBounds(c.view.serviceDate).end)||Date.parse(c.view.observedAt)>Date.parse(at)||Date.parse(c.sourceEvidence.acceptedAt)<Date.parse(c.view.observedAt)||Date.parse(c.sourceEvidence.acceptedAt)>Date.parse(c.issuedAt)||Date.parse(c.addressEvidence.acceptedAt)<Date.parse(c.binding.verifiedAt!)||Date.parse(c.addressEvidence.acceptedAt)>Date.parse(c.issuedAt))return [];return [structuredClone(c)];}catch{return [];}});
  }finally{client.release();}
 }
 async function verifyCurrentSource(request:CertifiedScheduleSourceRequest){
  const a=admission(request.view as ScheduleView,request.now,request.view.addressId);if(!options.enabled||stopped||request.expectedControlEpoch!==epoch||!a)return null;
  const rows=(await request.client.query('select record,record_digest from lba_production_schedule_certificate where id=$1 and revoked_at is null for share',[request.certificateId])).rows;
  const record=rows[0]?.record,ref='review-sha256:'+a.reviewSha256+'/bundle-sha256:'+a.bundleSha256;
  if(rows.length!==1||rows[0].record_digest!==request.certificateDigest||!plain(record)||digest(record)!==request.certificateDigest||record.sourceEvidence?.evidenceRef!==ref||record.parallel48hEvidence?.evidenceRef!==ref||
   !record.addressEvidence?.evidenceRef?.startsWith(ref+'/selection:')||Date.parse(record.expiresAt)>Date.parse(a.validUntil))return null;
  const profiles=(await request.client.query('select state from lba_production_profiles where owner_id=$1 and session_id=$2 and control_epoch=$3 for share',[record.ownerId,record.sessionId,epoch])).rows;if(profiles.length!==1)return null;
  let state:BotState;try{state=restoreBotState(profiles[0].state,record.ownerId);}catch{return null;}
  const facts=await addressFacts(request.client,state,request.view.addressId,request.now);
  if(!facts||facts.expiry<=Date.parse(request.now)||facts.built.binding.operatorId!==request.binding.operatorId||facts.built.binding.namespace!==request.binding.namespace||facts.built.binding.targetId!==request.binding.targetId)return null;
  const fact=await verifyRaw(request);return admission(request.view as ScheduleView,request.now,request.view.addressId)===a?fact:null;
 }
 return Object.freeze({runOnce,issue,readCertifiedProjection,verifyCurrentSource,stop:()=>{stopped=true;},setRegistry:(r:LoadedQualificationRegistry)=>{checkRegistry(r);registry=r;},
  health:()=>({configured:options.enabled,admittedSources:registry.bundleCount,evidenceMedium:registry.medium,state:stopped?'stopped':last.state})});
}

/** Interactive certified display is separate from notification event/outbox
 * authority. Current certificate+raw checks use the dispatcher's SAME TX. */
export function createCertifiedInteractiveScheduleProof(events:Events,expectedControlEpoch:number){return async(request:DispatchEligibilityRequest):Promise<CurrentDispatchSourceProof|null>=>{
 const {job,profile,client,now,signal}=request,view=job.payload.schedule;
 if(signal.aborted||job.sourceKind!=='profile'||job.controlEpoch!==expectedControlEpoch||job.ownerId!==profile.ownerId||job.sessionId!==profile.sessionId||job.payload.message.kind!=='schedule'||!view||view.deliveryEligible!==true)return null;
 const cert=await events.qualifySchedule({client,state:profile,view,now,signal});return cert?{sourceRevision:view.source.revision,expiresAt:cert.expiresAt}:null;
};}
