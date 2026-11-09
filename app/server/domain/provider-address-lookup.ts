import {types} from 'node:util';
import {normalizeAddressText} from '../../shared/address-index.ts';

interface ProviderAddressLookupBaseV2 {
 schemaVersion:'lba-address-lookup/2';id:string;expectedSessionId:string;
 expectedRevision:number;directoryId:'dtek:oem';
}
export type ProviderAddressLookupV2=ProviderAddressLookupBaseV2&(
 {operation:'localities';query:string;offset?:number}|
 {operation:'streets';query:string;offset?:number;catalogSnapshotId:string;cityKey:string}|
 {operation:'houses';query:string;offset?:number;catalogSnapshotId:string;cityKey:string;streetKey:string}|
 {operation:'resolve';catalogSnapshotId:string;houseSnapshotId:string;cityKey:string;streetKey:string;houseKey:string}
);

export class ProviderAddressLookupV2Error extends Error {
 readonly code='ADDRESS_FLOW_INVALID_INPUT';
 constructor(){super('ADDRESS_FLOW_INVALID_INPUT');this.name='ProviderAddressLookupV2Error';}
}
function invalid():never {throw new ProviderAddressLookupV2Error();}
const common=['schemaVersion','id','expectedSessionId','expectedRevision','directoryId','operation'] as const;
const controls=/[\p{Cc}\p{Cf}]/u;
function text(value:unknown,maximum:number):value is string {
 if(typeof value!=='string'||value.length===0||value.length>maximum||controls.test(value))return false;
 // Reject lone UTF-16 surrogates without coercion or replacement characters.
 for(let i=0;i<value.length;i++){
  const c=value.charCodeAt(i);
  if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}
  else if(c>=0xdc00&&c<=0xdfff)return false;
 }
 return true;
}
function literal(value:unknown,maximum:number):string {
 if(!text(value,maximum)||!value.trim())return invalid();
 return value;
}
function uuid(value:unknown):string {
 if(typeof value!=='string'||value.length!==36||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))return invalid();
 return value;
}
function query(value:unknown,minimum:number):string {
 if(!text(value,100)||normalizeAddressText(value).length<minimum)return invalid();
 return value;
}
/** Server-only pure parser. isProxy runs before any reflective operation,
 * including on revoked proxies. Descriptors are inspected without invoking
 * accessors; only own primitive data values cross into a fresh plain object.
 * This is shape validation, not authentication, catalog membership or a fetch.
 * Provider keys/query bytes are preserved. Cc/Cf controls and malformed Unicode
 * are rejected, never repaired. Legacy v1 parsing/digest is a separate contract.
 */
export function parseProviderAddressLookupV2(value:unknown):ProviderAddressLookupV2 {
 try{
  if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||
   ![Object.prototype,null].includes(Object.getPrototypeOf(value)))return invalid();
  const names=Reflect.ownKeys(value);
  if(names.length<7||names.length>11||names.some(k=>typeof k!=='string'))return invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value),record:Record<string,unknown>=Object.create(null);
  for(const name of names){
   if(typeof name!=='string')return invalid();const descriptor=descriptors[name];
   if(!descriptor||!Object.hasOwn(descriptor,'value'))return invalid();record[name]=descriptor.value;
  }
  let required:readonly string[],optional:readonly string[]=['offset'];
  switch(record.operation){
   case 'localities':required=[...common,'query'];break;
   case 'streets':required=[...common,'query','catalogSnapshotId','cityKey'];break;
   case 'houses':required=[...common,'query','catalogSnapshotId','cityKey','streetKey'];break;
   case 'resolve':required=[...common,'catalogSnapshotId','houseSnapshotId','cityKey','streetKey','houseKey'];optional=[];break;
   default:return invalid();
  }
  if(names.some(k=>typeof k!=='string'||![...required,...optional].includes(k))||required.some(k=>!Object.hasOwn(record,k)))return invalid();
  if(record.schemaVersion!=='lba-address-lookup/2'||record.directoryId!=='dtek:oem'||
   typeof record.id!=='string'||record.id.length<1||record.id.length>96||/[^A-Za-z0-9_.:-]/u.test(record.id)||
   !text(record.expectedSessionId,128)||!Number.isSafeInteger(record.expectedRevision)||(record.expectedRevision as number)<0)return invalid();
  const base:ProviderAddressLookupBaseV2={schemaVersion:'lba-address-lookup/2',id:record.id,expectedSessionId:record.expectedSessionId,
   expectedRevision:record.expectedRevision as number,directoryId:'dtek:oem'};
  let offset:{offset?:number}={};
  if(Object.hasOwn(record,'offset')){
   if(!Number.isSafeInteger(record.offset)||(record.offset as number)<0||(record.offset as number)>20_000)return invalid();
   offset={offset:record.offset as number};
  }
  switch(record.operation){
   case 'localities':return {...base,operation:'localities',query:query(record.query,2),...offset};
   case 'streets':return {...base,operation:'streets',query:query(record.query,2),...offset,
    catalogSnapshotId:uuid(record.catalogSnapshotId),cityKey:literal(record.cityKey,300)};
   case 'houses':return {...base,operation:'houses',query:query(record.query,1),...offset,
    catalogSnapshotId:uuid(record.catalogSnapshotId),cityKey:literal(record.cityKey,300),streetKey:literal(record.streetKey,300)};
   case 'resolve':return {...base,operation:'resolve',catalogSnapshotId:uuid(record.catalogSnapshotId),houseSnapshotId:uuid(record.houseSnapshotId),
    cityKey:literal(record.cityKey,300),streetKey:literal(record.streetKey,300),houseKey:literal(record.houseKey,100)};
   default:return invalid();
  }
 }catch{return invalid();}
}
