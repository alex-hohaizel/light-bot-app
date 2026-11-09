import type {BotState} from '../../shared/bot/types.ts';
import {dayBounds,scheduleSemantics,validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
import type {LegacyProfileReadQuery} from './profile-reader.ts';
import {scheduleEventDigest as digest,validScheduleCertificateShape} from './schedule-events.ts';
import {ProductionProfileStoreError} from './profile-store.ts';

/** Explicit additive migration only. Import/construct never executes DDL. */
export const MORNING_RECONCILIATION_SCHEMA_SQL=`
create table if not exists lba_production_qualification_revision (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,
 control_epoch bigint not null check(control_epoch>0),previous_revision bigint not null check(previous_revision>=0),
 session_revision bigint not null check(session_revision=previous_revision+1),certificate_id uuid not null references lba_production_schedule_certificate(id),
 record_digest char(64) not null,record jsonb not null,recorded_at timestamptz not null,
 primary key(owner_id,session_id,session_revision),unique(owner_id,session_id,previous_revision)
);
create table if not exists lba_production_morning_generation (
 owner_id varchar(255) not null,session_id varchar(128) not null,service_date date not null,generation integer not null check(generation>=0),
 control_epoch bigint not null check(control_epoch>0),briefing_id varchar(128) not null,
 predecessor_generation integer,predecessor_digest char(64),record_digest char(64) not null,record jsonb not null,recorded_at timestamptz not null,
 primary key(owner_id,session_id,service_date,generation),unique(owner_id,briefing_id),
 unique(owner_id,session_id,service_date,predecessor_generation),
 foreign key(owner_id,session_id,service_date) references lba_production_morning_briefing(owner_id,session_id,service_date),
 check((generation=0 and predecessor_generation is null and predecessor_digest is null) or
       (generation>0 and predecessor_generation=generation-1 and predecessor_digest is not null))
);`;
export const morningPlain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
export const morningClosed=(v:unknown,keys:string[]):v is Record<string,any>=>morningPlain(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
export const morningHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const morningUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const bounded=(v:unknown,max=128):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const instant=(v:unknown)=>v instanceof Date?v.toISOString():validInstant(v)?new Date(Date.parse(v)).toISOString():null;
const fail=(s:string):never=>{throw new ProductionProfileStoreError('PRODUCTION_MORNING_RECONCILIATION_'+s);};
export interface MorningPartPin {outboxId:string;briefingId:string;packetDigest:string;payloadDigest:string;partIndex:number;totalParts:number}
export function validMorningPartPin(v:unknown):v is MorningPartPin{return morningClosed(v,['outboxId','briefingId','packetDigest','payloadDigest','partIndex','totalParts'])&&morningUuid(v.outboxId)&&bounded(v.briefingId)&&morningHash(v.packetDigest)&&morningHash(v.payloadDigest)&&integer(v.partIndex)&&integer(v.totalParts)&&v.totalParts>=1&&v.totalParts<=100&&v.partIndex<v.totalParts;}
/** Every user-facing preference, address, label, order and mapping remains in
 * this digest. Only source-qualification validity timestamps are excluded. */
export function morningIntentDigest(state:BotState):string{
 const profile=structuredClone(state.profile);
 return digest({...profile,locations:profile.locations.map(l=>{const {verifiedAt,effectiveFrom,effectiveUntil,...binding}=l.binding;return {...l,binding};})});
}
export interface MorningGenerationRecord {
 kind:'lba-morning-generation/1';basis:'native_generation'|'retained_v1_snapshot';ownerId:string;sessionId:string;controlEpoch:number;serviceDate:string;generation:number;briefingId:string;
 predecessor:{generation:number;digest:string}|null;packet:any;receipt:any;viewProofs:any[];partProofs:MorningPartPin[];
 original:{revision:number;recordedAt:string;intentDigest:string|null;dueAt:string;until:string};recordedAt:string;
}
export function validMorningGeneration(v:unknown):v is MorningGenerationRecord{
 if(!morningClosed(v,['kind','basis','ownerId','sessionId','controlEpoch','serviceDate','generation','briefingId','predecessor','packet','receipt','viewProofs','partProofs','original','recordedAt'])||v.kind!=='lba-morning-generation/1'||!['native_generation','retained_v1_snapshot'].includes(v.basis)||!bounded(v.ownerId,255)||!bounded(v.sessionId)||!integer(v.controlEpoch)||v.controlEpoch<1||!integer(v.generation)||v.generation>100||!bounded(v.briefingId)||!/^\d{4}-\d\d-\d\d$/.test(v.serviceDate)||!validInstant(v.recordedAt)||!morningPlain(v.packet)||!morningPlain(v.receipt))return false;
 if(v.generation===0?v.predecessor!==null:!morningClosed(v.predecessor,['generation','digest'])||v.predecessor.generation!==v.generation-1||!morningHash(v.predecessor.digest))return false;
 if(!morningClosed(v.original,['revision','recordedAt','intentDigest','dueAt','until'])||!integer(v.original.revision)||!validInstant(v.original.recordedAt)||v.original.intentDigest!==null&&!morningHash(v.original.intentDigest)||!validInstant(v.original.dueAt)||!validInstant(v.original.until)||Date.parse(v.original.until)<=Date.parse(v.original.dueAt)||Date.parse(v.original.until)-Date.parse(v.original.dueAt)>600000)return false;
 const base='morning:'+digest({ownerId:v.ownerId,sessionId:v.sessionId,serviceDate:v.serviceDate});
 let bounds:ReturnType<typeof dayBounds>;try{bounds=dayBounds(v.serviceDate);}catch{return false;}
 if(v.briefingId!==(v.generation===0?base:base+':g:'+v.generation)||Date.parse(v.original.dueAt)<bounds.start||Date.parse(v.original.until)>bounds.end||Date.parse(v.original.recordedAt)<Date.parse(v.original.dueAt)||Date.parse(v.original.recordedAt)>=Date.parse(v.original.until)||Date.parse(v.original.recordedAt)>Date.parse(v.recordedAt))return false;
 if(!morningClosed(v.receipt,['kind','briefingId','sessionId','sessionRevision','serviceDate','packetDigest','outboxIds','recordedAt'])||v.receipt.kind!=='morning_briefing_receipt'||v.receipt.sessionId!==v.sessionId||!integer(v.receipt.sessionRevision)||v.receipt.sessionRevision<v.original.revision||v.receipt.serviceDate!==v.serviceDate||!validInstant(v.receipt.recordedAt)||Date.parse(v.receipt.recordedAt)>Date.parse(v.recordedAt))return false;
 if(v.basis==='native_generation'&&v.original.intentDigest===null||!morningClosed(v.packet,['kind','id','serviceDate','createdAt','primaryAddressId','entries'])||v.packet.kind!=='morning_briefing'||v.packet.primaryAddressId!==null&&!bounded(v.packet.primaryAddressId,512)||!Array.isArray(v.packet.entries)||!v.packet.entries.length||v.packet.entries.length>10000||new Set(v.packet.entries.map((e:any)=>e?.addressId)).size!==v.packet.entries.length)return false;
 for(const e of v.packet.entries){
  if(!morningPlain(e)||!bounded(e.addressId,512)||!bounded(e.label,512))return false;
  if(e.kind==='schedule'){
   if(!morningClosed(e,['addressId','label','kind','view']))return false;
   try{validateScheduleView(e.view);}catch{return false;}
   if(e.view.addressId!==e.addressId||e.view.addressLabel!==e.label||e.view.serviceDate!==v.serviceDate)return false;
  }else if(!morningClosed(e,['addressId','label','kind','reason'])||e.kind!=='unavailable'||!['not_certified','source_unverified'].includes(e.reason))return false;
 }
 if(!Array.isArray(v.partProofs)||!v.partProofs.length||v.partProofs.length>100||new Set(v.partProofs.map((p:any)=>p?.outboxId)).size!==v.partProofs.length||v.partProofs.some((p:any,i:number)=>!validMorningPartPin(p)||p.briefingId!==v.briefingId||p.partIndex!==i||p.totalParts!==v.partProofs.length||p.packetDigest!==digest(v.packet)))return false;
 if(!Array.isArray(v.viewProofs)||v.viewProofs.length>10000||new Set(v.viewProofs.map((p:any)=>p?.addressId)).size!==v.viewProofs.length||v.viewProofs.some((p:any)=>!morningClosed(p,['addressId','certificateId','certificateDigest','viewDigest','expiresAt'])||!bounded(p.addressId,512)||!morningUuid(p.certificateId)||!morningHash(p.certificateDigest)||!morningHash(p.viewDigest)||!validInstant(p.expiresAt)))return false;
 const schedules=v.packet.entries.filter((e:any)=>e.kind==='schedule');
 if(schedules.length!==v.viewProofs.length||schedules.some((e:any)=>v.viewProofs.filter((p:any)=>p.addressId===e.addressId&&p.viewDigest===digest(e.view)&&Date.parse(p.expiresAt)>Date.parse(v.receipt.recordedAt)).length!==1))return false;
 return v.packet.id===v.briefingId&&v.packet.serviceDate===v.serviceDate&&v.packet.createdAt===v.original.dueAt&&v.receipt.briefingId===v.briefingId&&v.receipt.packetDigest===digest(v.packet)&&Array.isArray(v.receipt.outboxIds)&&digest(v.receipt.outboxIds)===digest(v.partProofs.map(p=>p.outboxId))&&Buffer.byteLength(JSON.stringify(v))<=6000000;
}
/** Every ancestor is checked against its ACTUAL locked row. A stored parent
 * digest alone cannot attest to bytes/epoch/time that changed after issuance.
 * Thin metadata preflight limits reads before loading at most32MiB of JSON. */
export async function readMorningGeneration(client:LegacyProfileReadQuery,owner:string,session:string,day:string,expected:number,now:string){
 if(!validInstant(now))return fail('INVALID_CLOCK');
 const select="owner_id,session_id,service_date::text as service_day,generation,control_epoch,briefing_id,predecessor_generation,predecessor_digest,record_digest,recorded_at";
 const metadata=(await client.query(`select ${select},octet_length(record::text) as record_bytes from lba_production_morning_generation where owner_id=$1 and session_id=$2 and service_date=$3 order by generation limit 102 for share`,[owner,session,day])).rows;
 if(!metadata.length)return null;if(metadata.length>101)return fail('ANCESTRY_LIMIT');
 let bytes=0,time=-Infinity;
 for(const [i,row]of metadata.entries()){
  const at=instant(row.recorded_at),size=Number(row.record_bytes);
  if(row.owner_id!==owner||row.session_id!==session||row.service_day!==day||row.generation!==i||Number(row.control_epoch)!==expected||!hashMetadata(row.record_digest)||!at||Date.parse(at)>Date.parse(now)||Date.parse(at)<time||!Number.isSafeInteger(size)||size<1)return fail('GENERATION_INVALID');
  if(i===0?row.predecessor_generation!==null||row.predecessor_digest!==null:row.predecessor_generation!==i-1||row.predecessor_digest!==metadata[i-1].record_digest)return fail('GENERATION_LINEAGE_INVALID');
  bytes+=size;if(bytes>32*1024*1024)return fail('ANCESTRY_LIMIT');time=Date.parse(at);
 }
 const rows=(await client.query(`select ${select},record from lba_production_morning_generation where owner_id=$1 and session_id=$2 and service_date=$3 order by generation limit 102 for share`,[owner,session,day])).rows;
 if(rows.length!==metadata.length)return fail('GENERATION_LINEAGE_INVALID');
 let originalDigest:string|undefined,electrical:string|undefined;
 for(const [i,row]of rows.entries()){
  const r=row.record,m=metadata[i];
  if(!validMorningGeneration(r)||digest(r)!==m.record_digest||row.record_digest!==m.record_digest||row.owner_id!==owner||row.session_id!==session||row.service_day!==day||Number(row.control_epoch)!==expected||r.controlEpoch!==expected||r.ownerId!==owner||r.sessionId!==session||r.serviceDate!==day||r.generation!==i||row.generation!==i||r.briefingId!==row.briefing_id||instant(row.recorded_at)!==instant(r.recordedAt)||instant(row.recorded_at)!==instant(m.recorded_at)||Date.parse(r.recordedAt)>Date.parse(now))return fail('GENERATION_INVALID');
  if(i===0?r.predecessor!==null||row.predecessor_generation!==null||row.predecessor_digest!==null:r.predecessor?.generation!==i-1||r.predecessor.digest!==metadata[i-1].record_digest||row.predecessor_generation!==i-1||row.predecessor_digest!==r.predecessor.digest)return fail('GENERATION_LINEAGE_INVALID');
  const invariants=digest(r.original),meaning=digest(r.packet.entries.map((e:any)=>e.kind==='schedule'?{addressId:e.addressId,label:e.label,kind:e.kind,plan:scheduleSemantics(e.view)}:e));
  if(i===0){originalDigest=invariants;electrical=meaning;}
  else if(invariants!==originalDigest||meaning!==electrical||r.packet.primaryAddressId!==rows[0].record.packet.primaryAddressId||r.basis!==rows[0].record.basis)return fail('GENERATION_LINEAGE_INVALID');
 }
 const head=rows.at(-1)!;return {record:structuredClone(head.record) as MorningGenerationRecord,digest:head.record_digest as string};
}
const hashMetadata=morningHash;

export async function insertMorningGeneration(client:LegacyProfileReadQuery,r:MorningGenerationRecord){
 if(!validMorningGeneration(r))return fail('GENERATION_INVALID');const hash=digest(r);
 await client.query(`insert into lba_production_morning_generation(owner_id,session_id,service_date,generation,control_epoch,briefing_id,predecessor_generation,predecessor_digest,record_digest,record,recorded_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,[r.ownerId,r.sessionId,r.serviceDate,r.generation,r.controlEpoch,r.briefingId,r.predecessor?.generation??null,r.predecessor?.digest??null,hash,JSON.stringify(r),r.recordedAt]);return hash;
}

/** Exact pre-cancellation evidence. No receipt, mutation or historical cause is
 * invented. Rows were pending when this same issuer transaction read them. */
export async function captureQualificationMorningParts(client:LegacyProfileReadQuery,state:BotState,addressId:string,expected:number,now:string):Promise<MorningPartPin[]>{
 const rows=(await client.query("select * from lba_production_profile_outbox where owner_id=$1 and session_id=$2 and address_id=$3 and status='pending' and kind='notification' and payload ? 'briefing' order by id limit 101 for update",[state.ownerId,state.sessionId,addressId])).rows;if(rows.length>100)return fail('PART_LIMIT');
 const pins:MorningPartPin[]=[];
 for(const row of rows){const m=row.payload?.briefing,p:MorningPartPin={outboxId:row.id,briefingId:m?.id,packetDigest:m?.packetDigest,payloadDigest:digest(row.payload),partIndex:m?.partIndex,totalParts:m?.totalParts};if(!validMorningPartPin(p)||!morningClosed(m,['id','serviceDate','packetDigest','partIndex','totalParts'])||Number(row.control_epoch)!==expected||row.input_id!=='briefing:'+p.briefingId||row.ordinal!==p.partIndex)return fail('PART_INVALID');
  const generation=await readMorningGeneration(client,state.ownerId,state.sessionId,m.serviceDate,expected,now);
  if(generation){const matches=generation.record.partProofs.filter(x=>x.outboxId===p.outboxId);if(matches.length!==1||digest(matches[0])!==digest(p))return fail('PART_INVALID');}
  else{const old=(await client.query('select p.*,b.packet_digest as base_digest,b.packet,b.receipt from lba_production_morning_briefing_outbox_proof p join lba_production_morning_briefing b on b.owner_id=p.owner_id and b.session_id=p.session_id and b.service_date=p.service_date where p.outbox_id=$1 for share of p,b',[row.id])).rows;if(old.length!==1||old[0].owner_id!==state.ownerId||old[0].session_id!==state.sessionId||Number(old[0].control_epoch)!==expected||old[0].briefing_id!==p.briefingId||old[0].packet_digest!==p.packetDigest||old[0].base_digest!==p.packetDigest||digest(old[0].packet)!==p.packetDigest||old[0].payload_digest!==p.payloadDigest||old[0].part_index!==p.partIndex||old[0].total_parts!==p.totalParts||old[0].receipt?.outboxIds?.[p.partIndex]!==row.id)return fail('PART_INVALID');}
  pins.push(p);
 }
 return pins;
}
export async function recordQualificationRevision(input:{client:LegacyProfileReadQuery;before:BotState;after:BotState;addressId:string;certificateId:string;certificateDigest:string;parts:MorningPartPin[];now:string;expected:number}){
 const {client,before,after,addressId,certificateId,certificateDigest,parts,now,expected}=input;if(after.revision===before.revision)return;
 if(after.revision!==before.revision+1||before.ownerId!==after.ownerId||before.sessionId!==after.sessionId||parts.length>100)return fail('REVISION_INVALID');
 const cancelled:MorningPartPin[]=[];for(const p of parts){const row=(await client.query('select status,payload from lba_production_profile_outbox where id=$1 and owner_id=$2 and session_id=$3 for share',[p.outboxId,before.ownerId,before.sessionId])).rows;if(row.length!==1||row[0].status!=='cancelled'||digest(row[0].payload)!==p.payloadDigest)return fail('CANCELLATION_INVALID');cancelled.push(p);}
 const record={kind:'lba-qualified-profile-transition/1',ownerId:before.ownerId,sessionId:before.sessionId,controlEpoch:expected,previousRevision:before.revision,sessionRevision:after.revision,addressId,certificateId,certificateDigest,beforeStateDigest:digest(before),afterStateDigest:digest(after),beforeIntentDigest:morningIntentDigest(before),afterIntentDigest:morningIntentDigest(after),beforeBindingDigest:digest(before.profile.locations.find(l=>l.address.id===addressId)?.binding),afterBindingDigest:digest(after.profile.locations.find(l=>l.address.id===addressId)?.binding),cancelledParts:cancelled,recordedAt:now};
 await client.query('insert into lba_production_qualification_revision values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[before.ownerId,before.sessionId,expected,before.revision,after.revision,certificateId,digest(record),JSON.stringify(record),now]);
}
export async function morningQualificationChain(client:LegacyProfileReadQuery,state:BotState,original:MorningGenerationRecord['original'],expected:number,now:string):Promise<MorningPartPin[]|null>{
 if(!validInstant(now)||Date.parse(now)<Date.parse(original.recordedAt)||state.revision<original.revision||state.revision-original.revision>256)return null;
 // The inbox contains a request digest/numeric receipt, not a historical patch.
 // Even a later no-op is held conservatively; no inference from its SHA occurs.
 if((await client.query('select 1 from lba_production_profile_inbox where owner_id=$1 and recorded_at>=$2::timestamptz limit 1',[state.ownerId,original.recordedAt])).rows.length)return null;
 const rows=(await client.query('select * from lba_production_qualification_revision where owner_id=$1 and session_id=$2 and session_revision>$3 and session_revision<=$4 order by session_revision limit 257 for share',[state.ownerId,state.sessionId,original.revision,state.revision])).rows;
 if(rows.length!==state.revision-original.revision)return null;let revision=original.revision,intent=original.intentDigest,at=Date.parse(original.recordedAt);const pins:MorningPartPin[]=[];
 for(const row of rows){const r=row.record;if(!morningClosed(r,['kind','ownerId','sessionId','controlEpoch','previousRevision','sessionRevision','addressId','certificateId','certificateDigest','beforeStateDigest','afterStateDigest','beforeIntentDigest','afterIntentDigest','beforeBindingDigest','afterBindingDigest','cancelledParts','recordedAt'])||r.kind!=='lba-qualified-profile-transition/1'||r.ownerId!==state.ownerId||r.sessionId!==state.sessionId||r.controlEpoch!==expected||Number(row.control_epoch)!==expected||r.previousRevision!==revision||r.sessionRevision!==revision+1||Number(row.previous_revision)!==revision||Number(row.session_revision)!==revision+1||row.certificate_id!==r.certificateId||!morningUuid(r.certificateId)||!bounded(r.addressId,512)||![r.certificateDigest,r.beforeStateDigest,r.afterStateDigest,r.beforeIntentDigest,r.afterIntentDigest,r.beforeBindingDigest,r.afterBindingDigest].every(morningHash)||digest(r)!==row.record_digest||!validInstant(r.recordedAt)||instant(row.recorded_at)!==r.recordedAt||Date.parse(r.recordedAt)<Date.parse(original.recordedAt)||r.beforeIntentDigest!==r.afterIntentDigest||intent!==null&&r.beforeIntentDigest!==intent||!Array.isArray(r.cancelledParts)||r.cancelledParts.length>100||!r.cancelledParts.every(validMorningPartPin))return null;
  if(Date.parse(r.recordedAt)<at||Date.parse(r.recordedAt)>Date.parse(now)||new Set(r.cancelledParts.map((p:MorningPartPin)=>p.outboxId)).size!==r.cancelledParts.length)return null;
  const cert=(await client.query('select record,record_digest,issued_at from lba_production_schedule_certificate where id=$1 and owner_id=$2 and session_id=$3 and control_epoch=$4 for share',[r.certificateId,state.ownerId,state.sessionId,expected])).rows;if(cert.length!==1||!validScheduleCertificateShape(cert[0].record)||cert[0].record_digest!==r.certificateDigest||digest(cert[0].record)!==r.certificateDigest||cert[0].record.ownerId!==state.ownerId||cert[0].record.sessionId!==state.sessionId||cert[0].record.controlEpoch!==expected||cert[0].record.view.addressId!==r.addressId||digest(cert[0].record.binding)!==r.afterBindingDigest||instant(cert[0].issued_at)!==instant(r.recordedAt))return null;
  revision++;intent=r.afterIntentDigest;at=Date.parse(r.recordedAt);pins.push(...r.cancelledParts);if(pins.length>10000)return null;
 }
 if(intent!==null&&morningIntentDigest(state)!==intent)return null;return pins;
}
