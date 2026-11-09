import {createHash} from 'node:crypto';
import type {BotContext,BotState,AddressOption,ManualGroup} from '../../shared/bot/types.ts';
import type {ScheduleView} from '../../shared/product-contract.ts';
import {localParts,nextCalendarDate,validInstant} from '../../shared/schedule-core.ts';
import type {createSourceIngestion,PublicTechnicalPlans} from './source-ingestion.ts';
import type {createAddressCatalog,AddressCandidatesSnapshot} from './address-catalog.ts';
import {SOURCE_PROFILES} from './source-intake.ts';
import type {VerifiedLegacyPrincipal} from './profile-reader.ts';
import {scheduleEventDigest,type ScheduleCertificateRecord} from './schedule-events.ts';

const cities:Record<string,string>={kyiv:'Київ',vinnytsia:'Вінниця',odesa:'Одеса',kharkiv:'Харків',dnipropetrovsk:'Дніпропетровська область'};
const key=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Ports={sources:Pick<ReturnType<typeof createSourceIngestion>,'readTechnicalPlans'>;catalog:Pick<ReturnType<typeof createAddressCatalog>,'readCandidates'>;
 now:()=>number;operatorLabels:Readonly<Record<string,string>>;ownedOptionIds?:(owner:string,session:string)=>ReadonlySet<string>;
 certifiedProjection?:()=>Promise<ScheduleCertificateRecord[]>};
/** All database/provider work happens in refresh(), outside an owner transaction.
 * forProfile() reads one immutable memory generation only, avoiding pool deadlocks
 * and mixing a plan/address revision halfway through a canonical operation. */
export function createRuntimeDataContext(ports:Ports){
 let generation:{plans:PublicTechnicalPlans;catalog:AddressCandidatesSnapshot;certificates:ScheduleCertificateRecord[];at:number}|null=null,busy:Promise<void>|null=null,again=false;
 async function refresh(force=false){
  if(busy){if(force)again=true;return busy;}
  busy=(async()=>{do{again=false;const [plans,catalog,certificates]=await Promise.all([ports.sources.readTechnicalPlans(),ports.catalog.readCandidates(),ports.certifiedProjection?.()??Promise.resolve([])]);
   generation={plans:structuredClone(plans),catalog:structuredClone(catalog),certificates:structuredClone(certificates),at:ports.now()};}while(again);})().finally(()=>{busy=null;});return busy;
 }
 function forProfile({principal,state,serverNow}:{principal:VerifiedLegacyPrincipal;state:BotState;serverNow:string}):Omit<BotContext,'actorId'|'now'>{
  if(principal.ownerId!==state.ownerId||!validInstant(serverNow))throw Error('RUNTIME_CONTEXT_SCOPE_INVALID');
  const current=generation,now=Date.parse(serverNow),today=localParts(now).date,dates=[today,nextCalendarDate(today)];
  const memoryFresh=Boolean(current&&now>=current.at&&now-current.at<=30000);
  const owned=ports.ownedOptionIds?.(principal.ownerId,state.sessionId)??new Set<string>();
  const allowed=new Set([...state.profile.locations.map(l=>l.address.id),...(state.draft?.optionId?[state.draft.optionId]:[])]);
  const freshIds=new Set((current?.catalog.observations??[]).filter(o=>o.state==='current'&&validInstant(o.expiresAt)&&Date.parse(o.expiresAt)>now&&validInstant(o.observedAt)&&Date.parse(o.observedAt)<=now&&localParts(Date.parse(o.observedAt)).date===today).map(o=>o.addressId));
  const addresses:AddressOption[]=memoryFresh&&current?.catalog.state==='available'?current.catalog.options.filter(o=>freshIds.has(o.address.id)&&(allowed.has(o.address.id)||allowed.has(o.id)||owned.has(o.id))).map(o=>structuredClone(o)):[];
  const technical=current?.plans.plans??[],plans:ScheduleView[]=[];
  for(const location of state.profile.locations)for(const candidate of technical){
   const v=candidate.view,b=location.binding;
   if(!dates.includes(v.serviceDate)||v.operatorId!==b.operatorId||v.namespace!==b.namespace||v.targetId!==b.targetId)continue;
   const stale=!memoryFresh||v.freshness!=='current';
   const shown={...structuredClone(v),addressId:location.address.id,addressLabel:location.address.label,localityLabel:location.address.locality,
    bindingRevisionId:b.revisionId,...(stale?{status:'stale' as const,freshness:'stale' as const}:{}),deliveryEligible:false};
   const currentAddress=freshIds.has(location.address.id)&&current?.catalog.options.some(o=>o.address.id===location.address.id&&o.binding.operatorId===b.operatorId&&o.binding.namespace===b.namespace&&o.binding.targetId===b.targetId);
   const changedAddress=freshIds.has(location.address.id)&&current?.catalog.options.some(o=>o.address.id===location.address.id&&(o.binding.operatorId!==b.operatorId||o.binding.namespace!==b.namespace||o.binding.targetId!==b.targetId));
   const certified=memoryFresh&&!stale&&currentAddress?(current?.certificates??[]).filter(c=>c.ownerId===principal.ownerId&&c.sessionId===state.sessionId&&c.view.addressId===location.address.id&&c.view.addressLabel===location.address.label&&c.view.localityLabel===location.address.locality&&c.view.serviceDate===v.serviceDate&&
    validInstant(c.issuedAt)&&validInstant(c.expiresAt)&&Date.parse(c.issuedAt)<=now&&now<Date.parse(c.expiresAt)&&scheduleEventDigest(c.binding)===scheduleEventDigest(b)&&
    c.view.source.revision===v.source.revision&&c.view.revisionId===v.revisionId&&c.view.observedAt===v.observedAt&&c.view.status===v.status&&c.view.dayCoverage===v.dayCoverage&&
    c.view.operatorId===v.operatorId&&c.view.namespace===v.namespace&&c.view.targetId===v.targetId&&scheduleEventDigest(c.view.intervals)===scheduleEventDigest(v.intervals)):[];
   plans.push(changedAddress?{...shown,status:'needs_confirmation',dayCoverage:'none',intervals:[],freshness:'unknown',deliveryEligible:false,notice:'Оператор змінив прив’язку цього будинку. Перевіряємо новий графік.'}:certified.length===1?{...structuredClone(certified[0].view),addressLabel:location.address.label,localityLabel:location.address.locality}:shown);
  }
  const groups=new Map<string,ManualGroup>();
  for(const p of technical){const v=p.view,profile=SOURCE_PROFILES.find(s=>s.sourceId===p.provenance.sourceId);
   if(!profile||!dates.includes(v.serviceDate))continue;
   const scope=[v.operatorId,v.namespace,v.targetId],id='group:'+key(scope);if(groups.has(id))continue;
   groups.set(id,{id,label:String(v.targetId).replace(/^GPV/,''),locality:cities[profile.region]??profile.region,territoryLabel:ports.operatorLabels[v.operatorId]??profile.name,
    operatorId:v.operatorId,namespace:v.namespace!,targetId:v.targetId!,revisionId:'manual-group:'+key(scope)});
  }
  const currentCatalog=Boolean(memoryFresh&&current?.catalog.state==='available'&&freshIds.size);
  return {addresses,plans,manualGroups:[...groups.values()],operatorLabels:ports.operatorLabels,addressCatalogStatus:currentCatalog?'ready':'unavailable',maxAddresses:20};
 }
 return Object.freeze({refresh,forProfile});
}
