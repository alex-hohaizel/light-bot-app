import {createHash} from 'node:crypto';
import {types} from 'node:util';
import type {AddressRecord,AddressBinding} from '../../shared/product-contract.ts';
import {sameOperatorHouseAddress,operatorHouseScope} from '../../shared/operator-house-notice.ts';
import {validInstant,localParts} from '../../shared/schedule-core.ts';
import type {createOdesaAddressCatalog,OperatorAddressSnapshot,OdesaCatalogSearch} from './odesa-address-catalog.ts';

type Catalog=Pick<ReturnType<typeof createOdesaAddressCatalog>,'searchLocalities'|'searchStreets'|'searchHouses'|'resolveCandidate'>;
export type PublicSavedOperatorHouse={address:AddressRecord;binding:AddressBinding};
export type OperatorAddressRefreshResult={kind:'operator-address-refresh/1';state:'available'|'skipped'|'unavailable'|'deferred'|'cancelled';code:string;
 addressBindingVerified:false;deliveryEligible:false};
type Dataset={catalogSnapshotId:string;houseSnapshotId:string;city:string;street:string;observedAt:string;expiresAt:string};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),TTL=600000;
const result=(state:OperatorAddressRefreshResult['state'],code:string):OperatorAddressRefreshResult=>({kind:'operator-address-refresh/1',state,code,addressBindingVerified:false,deliveryEligible:false});
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value')));
function literal(v:unknown,max=300):v is string{return typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)&&Buffer.from(v).toString('utf8')===v;}
function prefix(value:string):string {let n=100;if(value.length>n&&/[\uD800-\uDBFF]/.test(value[n-1]))n--;return value.slice(0,n);}
/** Inert helper for the EXISTING caller-owned cycle. No timers, owner state,
 * certificates, source admission or HTTP implementation. Normal catalog ports
 * own global durable cache/CAS, source stop flags and 8/min + 7500ms budgets.
 * Cancellation fences stages/results. The current catalog API has no external
 * AbortSignal: an already-started operation drains under its own 30s deadline.
 * This is explicitly NOT full in-flight abort propagation. */
export function createOperatorAddressRefresh(options:{operator?:Catalog;now:()=>number}){
 let cycle=-1,tuple:string|null=null,scanned=0,busy=0;const datasets=new Map<string,Dataset>(),cycleAcquisitions=new Map<string,Promise<Dataset|null>>();
 const clock=()=>{const n=options.now();if(!Number.isSafeInteger(n)||n<0)throw Error('clock');return n;};
 function current(d:Dataset,now:number){return validInstant(d.observedAt)&&validInstant(d.expiresAt)&&Date.parse(d.observedAt)<=now&&now<Date.parse(d.expiresAt)&&now-Date.parse(d.observedAt)<TTL&&localParts(now).date===localParts(Date.parse(d.observedAt)).date;}
 function alive(signal:AbortSignal,token:number){return !signal.aborted&&token===cycle;}
 function snapshot(v:OdesaCatalogSearch,level:OperatorAddressSnapshot['level'],at:number):OperatorAddressSnapshot|null{
  if(v.state!=='available')return null;const s=v.snapshot;
  if(s?.kind!=='lba-provider-address-snapshot/2'||s.level!==level||s.namespace!=='dtek:oem'||!literal(s.id)||!literal(s.catalogSnapshotId)||!Array.isArray(s.items)||s.items.length>30||
   s.items.some(i=>!plain(i)||!literal(i.key)||!literal(i.value))||!validInstant(s.observedAt)||!validInstant(s.expiresAt)||Date.parse(s.observedAt)>at||at>=Date.parse(s.expiresAt)||Date.parse(s.expiresAt)>Date.parse(s.observedAt)+TTL)return null;
  return s;
 }
 async function findExact(search:(offset:number)=>Promise<OdesaCatalogSearch>,key:string,level:OperatorAddressSnapshot['level'],signal:AbortSignal,token:number){
  let first:OperatorAddressSnapshot|null=null,count=0;
  for(let offset=0;offset<100;offset+=30){
   if(!alive(signal,token))return null;const raw=await search(offset);if(!alive(signal,token))return null;
   const s=snapshot(raw,level,clock());if(!s||s.offset!==offset)return null;
   if(first&&(s.id!==first.id||s.catalogSnapshotId!==first.catalogSnapshotId||s.observedAt!==first.observedAt||s.expiresAt!==first.expiresAt||s.cityKey!==first.cityKey||s.streetKey!==first.streetKey))return null;
   first??=s;const remaining=100-count,rows=s.items.slice(0,remaining);count+=rows.length;
   if(rows.filter(v=>v.key===key).length===1)return s;
   if(count>=100||!s.hasMore||!s.items.length)return null;
  }return null;
 }
 async function dataset(location:PublicSavedOperatorHouse,signal:AbortSignal,token:number):Promise<Dataset|null>{
  const c=options.operator!,city=location.address.locality,street=location.address.street;
  const localities=await findExact(offset=>c.searchLocalities({query:prefix(city),offset}),city,'localities',signal,token);
  if(!localities||localities.id!==localities.catalogSnapshotId||!alive(signal,token))return null;
  const streets=await findExact(offset=>c.searchStreets({catalogSnapshotId:localities.id,cityKey:city,query:prefix(street),offset}),street,'streets',signal,token);
  if(!streets||streets.catalogSnapshotId!==localities.id||streets.cityKey!==city||!alive(signal,token))return null;
  // Houses are a full-street immutable dataset in the catalog. Exact raw row
  // validation remains inside resolveCandidate; no positional/prefix substitute.
  const raw=await c.searchHouses({catalogSnapshotId:localities.id,cityKey:city,streetKey:street,query:location.address.house.literal});
  if(!alive(signal,token))return null;const houses=snapshot(raw,'houses',clock());
  if(!houses||houses.catalogSnapshotId!==localities.id||houses.cityKey!==city||houses.streetKey!==street)return null;
  return {catalogSnapshotId:localities.id,houseSnapshotId:houses.id,city,street,observedAt:houses.observedAt,
   expiresAt:new Date(Math.min(Date.parse(localities.expiresAt),Date.parse(streets.expiresAt),Date.parse(houses.expiresAt))).toISOString()};
 }
 async function refreshOneSavedAddress(value:PublicSavedOperatorHouse,input:{cycle:number;signal:AbortSignal}):Promise<OperatorAddressRefreshResult>{
  try{
   if(!plain(input)||Reflect.ownKeys(input).some(k=>!['cycle','signal'].includes(String(k)))||!Number.isSafeInteger(input.cycle)||input.cycle<0||!(input.signal instanceof AbortSignal))return result('skipped','OPERATOR_REFRESH_INVALID_INPUT');
   if(!options.operator)return result('skipped','OPERATOR_REFRESH_DISABLED');if(input.signal.aborted)return result('cancelled','OPERATOR_REFRESH_CANCELLED');
   if(input.cycle<cycle)return result('skipped','OPERATOR_REFRESH_OLD_CYCLE');if(input.cycle>cycle){if(busy)return result('skipped','OPERATOR_REFRESH_DRAINING');cycle=input.cycle;tuple=null;scanned=0;cycleAcquisitions.clear();}
   if(++scanned>100)return result('skipped','OPERATOR_REFRESH_SCAN_BOUND');
   if(!plain(value)||Reflect.ownKeys(value).some(k=>!['address','binding'].includes(String(k)))||!plain(value.address)||!plain(value.binding)||!plain(value.address.house)||!operatorHouseScope(value))return result('skipped','OPERATOR_REFRESH_SCOPE_INVALID');
   const a=structuredClone(value.address),b=structuredClone(value.binding),city=a.locality,street=a.street,house=a.house.literal;
   if(!literal(city)||!literal(street)||!literal(house,100)||a.house.number!==house||b.addressId!==a.id||a.id!=='provisional:dtek:oem:'+hash(JSON.stringify([city,street,house]))||
    a.localityId!=='source:dtek:oem:locality:'+hash(city)||a.streetId!=='source:dtek:oem:street:'+hash(JSON.stringify([city,street])))return result('skipped','OPERATOR_REFRESH_IDENTITY_INVALID');
   const key=JSON.stringify([city,street]);if(tuple!==null&&tuple!==key)return result('skipped','OPERATOR_REFRESH_CYCLE_BOUND');tuple=key;
   const token=cycle;let d=datasets.get(key);if(d&&!current(d,clock())){datasets.delete(key);d=undefined;}
   busy++;
   try{
    // A failed/null/rejected acquisition also consumes this tuple's cycle
    // attempt. Retain the settled promise until an explicit newer cycle;
    // otherwise sequential owners could repeat slow catalog port work.
    if(!d){let work=cycleAcquisitions.get(key);if(!work){work=dataset({address:a,binding:b},input.signal,token);cycleAcquisitions.set(key,work);}d=await work??undefined;
     if(d&&current(d,clock())){if(datasets.size>=100&&!datasets.has(key))datasets.delete(datasets.keys().next().value!);datasets.set(key,d);}else d=undefined;}
    if(!alive(input.signal,token))return result('cancelled','OPERATOR_REFRESH_CANCELLED');if(!d)return result('unavailable','OPERATOR_REFRESH_DATA_UNAVAILABLE');
    const candidate=await options.operator.resolveCandidate({catalogSnapshotId:d.catalogSnapshotId,houseSnapshotId:d.houseSnapshotId,cityKey:city,streetKey:street,houseKey:house});
    if(!alive(input.signal,token))return result('cancelled','OPERATOR_REFRESH_CANCELLED');
    if(candidate.state!=='available'){datasets.delete(key);return result(candidate.state==='deferred'?'deferred':'unavailable','OPERATOR_REFRESH_SOURCE_UNAVAILABLE');}
    if(!candidate.options.length||candidate.options.some(o=>!sameOperatorHouseAddress(a,o.address)||o.binding.addressId!==a.id||o.binding.operatorId!=='dtek-oem'||o.binding.namespace!=='dtek:oem')||candidate.addressBindingVerified!==false||candidate.deliveryEligible!==false||
     !validInstant(candidate.observedAt)||!validInstant(candidate.expiresAt)||Date.parse(candidate.observedAt)>clock()||Date.parse(candidate.expiresAt)<=clock())return result('unavailable','OPERATOR_REFRESH_RESULT_INVALID');
    return result('available','OPERATOR_REFRESH_CURRENT_CANDIDATE');
   }finally{busy--;}
  }catch{return result('unavailable','OPERATOR_REFRESH_UNAVAILABLE');}
 }
 return Object.freeze({refreshOneSavedAddress});
}
