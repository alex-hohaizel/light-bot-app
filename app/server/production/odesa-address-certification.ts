import {createHash} from 'node:crypto';
import {buildOdesaStreetRowCandidate,type OdesaAjaxCapture,type OdesaAddressCandidate} from '../domain/odesa-address-adapter.ts';
import {odesaPublicAddressRequestIdentity} from '../domain/public-address-request-identity.ts';
import {dayBounds,localParts,validInstant} from '../../shared/schedule-core.ts';
import type {BotLocation,BotState} from '../../shared/bot/types.ts';
import type {LegacyProfileReadQuery} from './profile-reader.ts';

const AJAX='https://www.dtek-oem.com.ua/ua/ajax',TTL=600000;
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const closed=(v:unknown,keys:string[]):v is Record<string,any>=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const iso=(v:unknown)=>v instanceof Date?v.toISOString():v;
const epoch=(v:unknown,expected:number)=>Boolean((typeof v==='number'&&Number.isSafeInteger(v)||typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v))&&Number(v)===expected);
type CaptureRow={id:string;operation:string;request_url:string;capture:unknown;observed_at:unknown;control_epoch:unknown};
export interface OdesaCertifiedAddressFacts {
 built:{address:OdesaAddressCandidate['address'];binding:OdesaAddressCandidate['bindingChoices'][number]};
 expiry:number;selection:string;captures:OdesaAddressCandidate['proof']['captures'];mappingFingerprint:string;
}
function decoded(row:CaptureRow,expected:number,allowFixture:boolean):OdesaAjaxCapture|null{
 if(!uuid(row.id)||row.request_url!==AJAX||!epoch(row.control_epoch,expected)||!closed(row.capture,['kind','mode','reservationToken','capture']))return null;
 const envelope=row.capture,c=envelope.capture;
 if(envelope.kind!=='lba-odesa-address-capture/1'||envelope.reservationToken!==row.id||envelope.mode!=='standard_fetch_https'&&!(allowFixture&&envelope.mode==='fixture_unverified')||!plain(c)||iso(row.observed_at)!==c.observedAt||row.operation!==(c.operation==='getStreets'?'streets':c.operation==='getHomeNum'?'houses':null))return null;
 return c as OdesaAjaxCapture;
}
function eligible(location:BotLocation){return location.binding.operatorId==='dtek-oem'&&location.binding.namespace==='dtek:oem'&&location.binding.kind==='operator_group'&&['needs_confirmation','verified'].includes(location.binding.status)&&/^GPV[1-6]\.[12]$/.test(location.binding.targetId)&&/^provisional:dtek:oem:[a-f0-9]{64}$/.test(location.address.id)&&location.binding.addressId===location.address.id;}
async function captureRow(client:LegacyProfileReadQuery,id:string,lock:boolean){return (await client.query('select id,operation,request_url,capture,observed_at,control_epoch from lba_public_address_capture where id=$1'+(lock?' for share':''),[id])).rows;}
async function current(input:{client:LegacyProfileReadQuery;location:BotLocation;expectedControlEpoch:number;at:string;allowFixture:boolean;lock:boolean}){
 const {client,location,expectedControlEpoch:expected,at,allowFixture,lock}=input;
 const pointer=(await client.query('select streets_id,houses_id,group_id from lba_public_address_candidate where address_id=$1'+(lock?' for share':''),[location.address.id])).rows;
 if(pointer.length!==1||!uuid(pointer[0].streets_id)||!uuid(pointer[0].houses_id)||pointer[0].houses_id!==pointer[0].group_id||pointer[0].streets_id===pointer[0].houses_id)return null;
 // Catalog then houses is a fixed lock order, not lexical UUID order.
 const catRows=await captureRow(client,pointer[0].streets_id,lock),houseRows=await captureRow(client,pointer[0].houses_id,lock);
 if(catRows.length!==1||houseRows.length!==1)return null;
 const catalog=decoded(catRows[0] as CaptureRow,expected,allowFixture),houses=decoded(houseRows[0] as CaptureRow,expected,allowFixture);
 if(!catalog||!houses||catalog.operation!=='getStreets'||houses.operation!=='getHomeNum')return null;
 const n=Date.parse(at);
 if([catalog,houses].some(c=>!validInstant(c.observedAt)||Date.parse(c.observedAt)>n||n-Date.parse(c.observedAt)>=TTL||localParts(n).date!==localParts(Date.parse(c.observedAt)).date))return null;
 const queries=[catalog,houses].map((capture,index)=>({id:index===0?pointer[0].streets_id:pointer[0].houses_id,capture,key:odesaPublicAddressRequestIdentity({method:'POST',url:AJAX,operation:capture.operation,fields:capture.request}).requestKey})).sort((a,b)=>a.key.localeCompare(b.key));
 for(const q of queries){const rows=(await client.query('select latest_capture_id,last_attempt_at,last_failure from lba_public_address_query where request_key=$1 and request_url=$2'+(lock?' for share':''),[q.key,AJAX])).rows;
  if(rows.length!==1||rows[0].latest_capture_id!==q.id||rows[0].last_failure!==null||!validInstant(iso(rows[0].last_attempt_at))||Date.parse(iso(rows[0].last_attempt_at) as string)>n)return null;
 }
 const built=buildOdesaStreetRowCandidate({basis:'street_row/1',selection:{city:location.address.locality,street:location.address.street,house:location.address.house.literal},captures:{catalog,houses},policy:{asOf:at,maximumCaptureAgeMs:TTL}});
 if(built.address.id!==location.address.id||built.bindingChoices.length!==1||built.bindingChoices[0].targetId!==location.binding.targetId||!same({...built.address,label:location.address.label},location.address)||built.operatorNotice.groupPlanAdvisory==='operator_reports_schedule_not_applicable')return null;
 return {built,catalog,houses,catRow:catRows[0],houseRow:houseRows[0],expiry:Math.min(Date.parse(catalog.observedAt)+TTL,Date.parse(houses.observedAt)+TTL,dayBounds(localParts(n).date).end)};
}

/** SQL-only owner delegate. Caller owns control/owner transaction and commit.
 * Current wizard state/last20 temporary IDs never revoke a saved resolve receipt.
 * Every mutable pointer is re-read under shared locks before a grant. */
export async function readOdesaAddressCertificationFacts(input:{client:LegacyProfileReadQuery;state:BotState;addressId:string;at:string;expectedControlEpoch:number;allowFixture?:boolean}):Promise<OdesaCertifiedAddressFacts|null>{
 try{
  const {client,state,addressId,at,expectedControlEpoch:expected}=input,allowFixture=input.allowFixture===true;
  const found=state.profile.locations.filter(l=>l.address.id===addressId);if(found.length!==1||!eligible(found[0])||!validInstant(at))return null;const location=found[0];
  // The owner/session/profile lock is already held by commitCertifiedBinding.
  // Select immutable historical receipts, independent of the current wizard.
  const receipts=(await client.query(`select result,recorded_at from lba_production_address_lookup_requests
   where owner_id=$1 and session_id=$2 and result->>'state'='available' and exists(
    select 1 from jsonb_array_elements(case when jsonb_typeof(result->'options')='array' then result->'options' else '[]'::jsonb end) o
    where o->'address'->>'id'=$3 and o->'binding'->>'revisionId'=$4)
   order by recorded_at desc,operation_id desc limit 2 for share`,[state.ownerId,state.sessionId,addressId,location.binding.revisionId])).rows;
  if(!receipts.length)return null;
  const selected=receipts[0].result;
  if(!closed(selected,['state','cache','snapshotId','options','operatorNotice','mappingFingerprint','candidateProof','observedAt','expiresAt','addressBindingVerified','deliveryEligible'])||selected.state!=='available'||selected.cache!=='hit'||!uuid(selected.snapshotId)||!Array.isArray(selected.options)||selected.options.length!==1||selected.addressBindingVerified!==false||selected.deliveryEligible!==false||!validInstant(selected.observedAt)||!validInstant(selected.expiresAt)||!validInstant(iso(receipts[0].recorded_at))||Date.parse(selected.observedAt)>Date.parse(iso(receipts[0].recorded_at) as string)||Date.parse(iso(receipts[0].recorded_at) as string)>=Date.parse(selected.expiresAt)||Date.parse(iso(receipts[0].recorded_at) as string)>Date.parse(at))return null;
  const option=selected.options[0],proof=selected.candidateProof;
  if(!closed(option,['id','address','binding','territoryLabel','connectionLabel'])||option.territoryLabel!=='Одеська область · ДТЕК Одеські електромережі'||option.connectionLabel!=='Група '+location.binding.targetId.replace(/^GPV/,'')||!plain(option.address)||!plain(option.binding)||option.id!==addressId+':group:'+location.binding.targetId||option.address.id!==addressId||option.binding.kind!=='operator_group'||option.binding.status!=='needs_confirmation'||option.binding.revisionId!==location.binding.revisionId||!plain(proof)||!Array.isArray(proof.captures)||proof.captures.length!==2)return null;
  const facts=await current({client,location,expectedControlEpoch:expected,at,allowFixture,lock:true});if(!facts)return null;
  if(facts.built.mappingFingerprint!==selected.mappingFingerprint||facts.built.bindingChoices[0].revisionId!==location.binding.revisionId)return null;
  // Reproduce the original receipt with immutable historical raw rows, at its
  // historical time. This does not renew their TTL or authorize current data.
  const historicalHouses=selected.snapshotId===facts.houseRow.id?[facts.houseRow]:await captureRow(client,selected.snapshotId,false);
  if(historicalHouses.length!==1)return null;
  const houses=decoded(historicalHouses[0] as CaptureRow,expected,allowFixture);if(!houses)return null;
  const catProof=proof.captures[0];if(!plain(catProof)||!validInstant(catProof.observedAt)||typeof catProof.rawSha256!=='string')return null;
  // The historical UUID was not stored. Detect ambiguity BEFORE mode/epoch
  // validation; filtering a conflicting row away would invent that identity.
  const historicalCatalog=(await client.query(`select id,operation,request_url,capture,observed_at,control_epoch from lba_public_address_capture
    where operation='streets' and request_url=$3 and observed_at=$1::timestamptz and capture->'capture'->>'rawSha256'=$2
    and capture->'capture'->>'sourceId'='dtek-oem-public-ajax' and capture->'capture'->>'operation'='getStreets'
    and capture->'capture'->>'method'='POST' and capture->'capture'->>'url'=$3 and capture->'capture'->'request'='{}'::jsonb
    order by id limit 2`,[catProof.observedAt,catProof.rawSha256,AJAX])).rows;
  if(historicalCatalog.length!==1)return null;
  const catalog=decoded(historicalCatalog[0] as CaptureRow,expected,allowFixture);if(!catalog)return null;
  const built=buildOdesaStreetRowCandidate({basis:'street_row/1',selection:{city:option.address.locality,street:option.address.street,house:option.address.house.literal},captures:{catalog,houses},policy:{asOf:selected.observedAt,maximumCaptureAgeMs:TTL}});
  const originalBinding=built.bindingChoices[0];
  if(built.bindingChoices.length!==1||built.address.id!==addressId||!same(built.proof,proof)||!same(built.address,option.address)||!same(originalBinding,option.binding)||!same(built.operatorNotice,selected.operatorNotice)||built.mappingFingerprint!==selected.mappingFingerprint||built.proof.observedAt!==selected.observedAt||Date.parse(selected.expiresAt)>Math.min(...built.proof.captures.map(c=>Date.parse(c.observedAt)+TTL),dayBounds(localParts(Date.parse(selected.observedAt)).date).end)||Date.parse(selected.expiresAt)<=Date.parse(selected.observedAt))return null;
  return {built:{address:facts.built.address,binding:facts.built.bindingChoices[0]},expiry:facts.expiry,selection:digest(selected),captures:facts.built.proof.captures,mappingFingerprint:facts.built.mappingFingerprint};
 }catch{return null;}
}

/** Outside-TX cached advice only. It grants nothing; issue rechecks the owner,
 * exact receipt and every mutable pointer in its own existing transaction. */
export async function readOdesaAddressTargetHint(input:{client:LegacyProfileReadQuery;location:BotLocation;at:string;expectedControlEpoch:number;allowFixture?:boolean}):Promise<string|null>{
 try{if(!eligible(input.location)||!validInstant(input.at))return null;const facts=await current({...input,allowFixture:input.allowFixture===true,lock:false});return facts?.built.bindingChoices[0].targetId??null;}catch{return null;}
}
