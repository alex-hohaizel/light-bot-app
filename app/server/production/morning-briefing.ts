import type {ScheduleView} from '../../shared/product-contract.ts';
import type {BotState} from '../../shared/bot/types.ts';
import {handleMorningBriefing,morningBriefingWindow,type MorningBriefingPacket} from '../../shared/morning-briefing.ts';
import {resolveNotificationPolicy} from '../../shared/notification-policy.ts';
import {dayBounds,localParts,scheduleSemantics,validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
import {ProductionProfileStoreError,type createProductionProfileStore} from './profile-store.ts';
import type {LegacyProfileReadQuery,VerifiedLegacyPrincipal} from './profile-reader.ts';
import {scheduleEventDigest as digest,type createProductionScheduleEvents} from './schedule-events.ts';
import type {DispatchEligibilityRequest} from './telegram-dispatch.ts';
import type {CurrentDispatchSourceProof} from './telegram-dispatch-eligibility.ts';
import {insertMorningGeneration,morningIntentDigest,morningQualificationChain,readMorningGeneration,validMorningGeneration,type MorningGenerationRecord,type MorningPartPin} from './morning-reconciliation.ts';

/** Explicit additive migration only. No DDL/certificate seed/account bootstrap,
 * source HTTP, worker timer or Telegram transport is executed by this module. */
export const MORNING_BRIEFING_SCHEMA_SQL=`
create table if not exists lba_production_morning_briefing (
 owner_id varchar(255) not null references lba_production_profiles(owner_id),session_id varchar(128) not null,service_date date not null,
 control_epoch bigint not null,briefing_id varchar(128) not null,packet_digest char(64) not null,packet jsonb not null,receipt jsonb not null,recorded_at timestamptz not null,
 primary key(owner_id,session_id,service_date),unique(owner_id,briefing_id)
);
create table if not exists lba_production_morning_briefing_view_proof (
 owner_id varchar(255) not null,session_id varchar(128) not null,service_date date not null,address_id text not null,
 control_epoch bigint not null,certificate_id uuid not null references lba_production_schedule_certificate(id),certificate_digest char(64) not null,view_digest char(64) not null,
 primary key(owner_id,session_id,service_date,address_id),
 foreign key(owner_id,session_id,service_date) references lba_production_morning_briefing(owner_id,session_id,service_date)
);
create table if not exists lba_production_morning_briefing_outbox_proof (
 outbox_id uuid primary key references lba_production_profile_outbox(id),owner_id varchar(255) not null,session_id varchar(128) not null,service_date date not null,
 control_epoch bigint not null,briefing_id varchar(128) not null,packet_digest char(64) not null,payload_digest char(64) not null,part_index integer not null,total_parts integer not null,
 foreign key(owner_id,session_id,service_date) references lba_production_morning_briefing(owner_id,session_id,service_date)
);
`;
type Store=Pick<ReturnType<typeof createProductionProfileStore>,'commitMorningBriefing'>;
type Events=Pick<ReturnType<typeof createProductionScheduleEvents>,'qualifySchedule'>;
interface ViewProof {addressId:string;certificateId:string;certificateDigest:string;viewDigest:string;expiresAt:string}
export interface MorningBriefingReceipt {
 kind:'morning_briefing_receipt';briefingId:string;sessionId:string;sessionRevision:number;serviceDate:string;packetDigest:string;outboxIds:string[];recordedAt:string;
}
export type MorningBriefingCommitGuard=(request:{client:LegacyProfileReadQuery;state:BotState;serverNow:string;
 phase:'before_replay'|'before_persist'|'before_commit';briefing?:MorningBriefingPacket})=>Promise<boolean>|boolean;
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=512):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const int=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const epoch=(v:unknown,n:number)=>Boolean((int(v)||typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v))&&Number(v)===n);
const closed=(v:unknown,keys:string[]):v is Record<string,any>=>plain(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const fail=(reason:string):never=>{throw new ProductionProfileStoreError('PRODUCTION_MORNING_BRIEFING_'+reason);};
const occurrenceId=(state:BotState,day:string)=>'morning:'+digest({ownerId:state.ownerId,sessionId:state.sessionId,serviceDate:day});
function activeLocations(state:BotState){
 if(!Array.isArray(state.profile.locations)||state.profile.locations.length>10000)return fail('PROFILE_INVALID');
 const seen=new Set<string>();
 for(const l of state.profile.locations){if(!text(l?.address?.id)||!text(l?.address?.label)||seen.has(l.address.id))return fail('PROFILE_INVALID');seen.add(l.address.id);}
 try{return state.profile.locations.filter(l=>resolveNotificationPolicy(state.profile.preferences,l,'telegram').enabled);}catch{return fail('POLICY_INVALID');}
}
function receipt(value:unknown,state:BotState,day:string,packetDigest:string,now:string,expectedId=occurrenceId(state,day)):MorningBriefingReceipt{
 if(!closed(value,['kind','briefingId','sessionId','sessionRevision','serviceDate','packetDigest','outboxIds','recordedAt'])||value.kind!=='morning_briefing_receipt'||
  value.briefingId!==expectedId||value.sessionId!==state.sessionId||!int(value.sessionRevision)||value.serviceDate!==day||value.packetDigest!==packetDigest||
  !Array.isArray(value.outboxIds)||!value.outboxIds.length||value.outboxIds.length>100||value.outboxIds.some((id:unknown)=>!uuid(id))||new Set(value.outboxIds).size!==value.outboxIds.length||
  !validInstant(value.recordedAt)||Date.parse(value.recordedAt)>Date.parse(now))return fail('LEDGER_INVALID');
 return structuredClone(value) as MorningBriefingReceipt;
}

/** Canonical server-side aggregate recipe. Root owns policy, formatter,
 * profile/outbox writes and dispatcher; this module owns immutable occurrence
 * and proof records in that SAME transaction. Qualification is a read-only
 * root port, never a fabricated boolean acceptance from caller JSON. */
export function createProductionMorningBriefing(options:{enabled?:boolean;expectedControlEpoch:number;store:Store;events:Events}){
 if(!options||!int(options.expectedControlEpoch)||options.expectedControlEpoch<1||typeof options.store?.commitMorningBriefing!=='function'||
  typeof options.events?.qualifySchedule!=='function'||options.enabled!==undefined&&typeof options.enabled!=='boolean')return fail('INVALID_OPTIONS');
 const enabled=options.enabled===true,expected=options.expectedControlEpoch,store=options.store,events=options.events;
 async function entries(client:LegacyProfileReadQuery,state:BotState,day:string,now:string,signal:AbortSignal){
  const result:MorningBriefingPacket['entries']=[],proofs:ViewProof[]=[];
  for(const location of activeLocations(state)){
   if(signal.aborted)return fail('ABORTED');
   const base={addressId:location.address.id,label:location.address.label};
   const rows=(await client.query(`select id,record,record_digest,view_digest from lba_production_schedule_certificate
    where owner_id=$1 and session_id=$2 and control_epoch=$3 and address_id=$4 and record->'view'->>'serviceDate'=$5
    and revoked_at is null and issued_at<=$6::timestamptz and expires_at>$6::timestamptz order by issued_at desc,id desc limit 1`,
    [state.ownerId,state.sessionId,expected,location.address.id,day,now])).rows;
   if(!rows.length){result.push({...base,kind:'unavailable',reason:'not_certified'});continue;}
   const row=rows[0];let view:ScheduleView|undefined;
   try{if(uuid(row.id)&&plain(row.record)&&hash(row.record_digest)&&digest(row.record)===row.record_digest){const v=row.record.view as ScheduleView;validateScheduleView(v);
     if(v.addressId===base.addressId&&v.addressLabel===base.label&&v.serviceDate===day&&hash(row.view_digest)&&digest(v)===row.view_digest)view=structuredClone(v);}}
   catch{/* Invalid/newest certificate remains explicitly unavailable; no old fallback. */}
   if(!view){result.push({...base,kind:'unavailable',reason:'not_certified'});continue;}
   const qualified=await events.qualifySchedule({client,state:structuredClone(state),view,now,signal,certificateId:row.id});
   if(!qualified){result.push({...base,kind:'unavailable',reason:'source_unverified'});continue;}
   if(!closed(qualified,['certificateId','certificateDigest','expiresAt'])||qualified.certificateId!==row.id||qualified.certificateDigest!==row.record_digest||
    !validInstant(qualified.expiresAt)||Date.parse(qualified.expiresAt)<=Date.parse(now))return fail('QUALIFICATION_INVALID');
   result.push({...base,kind:'schedule',view});proofs.push({addressId:base.addressId,certificateId:qualified.certificateId,certificateDigest:qualified.certificateDigest,viewDigest:digest(view),expiresAt:qualified.expiresAt});
  }
  return {entries:result,proofs};
 }
 function turn(state:BotState,packet:MorningBriefingPacket,now:string){
  const result=handleMorningBriefing(state,packet,{actorId:state.ownerId,now,addresses:[],plans:[]});
  if(!plain(result)||!Array.isArray(result.messages)||result.messages.length>100||result.primarySchedule&&result.messages.length!==1||result.messages.some(m=>m.kind!=='notification'||typeof m.text!=='string'||!m.text.length||m.text.length>4096||m.buttons.length))return fail('TURN_INVALID');
  return result;
 }
 async function partPins(client:LegacyProfileReadQuery,state:BotState,packet:MorningBriefingPacket,ids:string[],formatted:ReturnType<typeof turn>){
  const result:MorningPartPin[]=[];
  for(let i=0;i<ids.length;i++){
   const rows=(await client.query('select * from lba_production_profile_outbox where id=$1 for share',[ids[i]])).rows;
   const metadata={id:packet.id,serviceDate:packet.serviceDate,packetDigest:digest(packet),partIndex:i,totalParts:ids.length};
   const payload={message:{...formatted.messages[i],id:ids[i]},...(formatted.primarySchedule?{schedule:formatted.primarySchedule}:{}),briefing:metadata};
   if(rows.length!==1||rows[0].owner_id!==state.ownerId||rows[0].session_id!==state.sessionId||Number(rows[0].control_epoch)!==expected||rows[0].input_id!=='briefing:'+packet.id||rows[0].kind!=='notification'||rows[0].ordinal!==i||digest(rows[0].payload)!==digest(payload))return fail('PERSIST_INVALID');
   result.push({outboxId:ids[i],briefingId:packet.id,packetDigest:digest(packet),payloadDigest:digest(payload),partIndex:i,totalParts:ids.length});
  }
  return result;
 }
 async function retainedBase(client:LegacyProfileReadQuery,state:BotState,row:any,now:string):Promise<MorningGenerationRecord>{
  const day=row.packet?.serviceDate,saved=receipt(row.receipt,state,day,row.packet_digest,now),packet=row.packet as MorningBriefingPacket;
  const proofs=(await client.query(`select p.address_id,p.certificate_id,p.certificate_digest,p.view_digest,p.control_epoch,c.expires_at from lba_production_morning_briefing_view_proof p join lba_production_schedule_certificate c on c.id=p.certificate_id where p.owner_id=$1 and p.session_id=$2 and p.service_date=$3 order by p.address_id for share of p,c`,[state.ownerId,state.sessionId,day])).rows;
  const parts=(await client.query('select * from lba_production_morning_briefing_outbox_proof where owner_id=$1 and session_id=$2 and service_date=$3 order by part_index for share',[state.ownerId,state.sessionId,day])).rows;
  if(parts.length!==saved.outboxIds.length||proofs.some(p=>!epoch(p.control_epoch,expected))||parts.some((p,i)=>!epoch(p.control_epoch,expected)||p.outbox_id!==saved.outboxIds[i]||p.briefing_id!==packet.id||p.packet_digest!==row.packet_digest||p.part_index!==i||p.total_parts!==parts.length))return fail('LEDGER_INVALID');
  return {kind:'lba-morning-generation/1',basis:'retained_v1_snapshot',ownerId:state.ownerId,sessionId:state.sessionId,controlEpoch:expected,serviceDate:day,generation:0,briefingId:packet.id,predecessor:null,packet:structuredClone(packet),receipt:saved,
   viewProofs:proofs.map(p=>({addressId:p.address_id,certificateId:p.certificate_id,certificateDigest:p.certificate_digest,viewDigest:p.view_digest,expiresAt:new Date(p.expires_at).toISOString()})),partProofs:parts.map(p=>({outboxId:p.outbox_id,briefingId:p.briefing_id,packetDigest:p.packet_digest,payloadDigest:p.payload_digest,partIndex:p.part_index,totalParts:p.total_parts})),
   original:{revision:saved.sessionRevision,recordedAt:saved.recordedAt,intentDigest:null,dueAt:packet.createdAt,until:new Date(Math.min(Date.parse(packet.createdAt)+600000,dayBounds(day).end)).toISOString()},recordedAt:now};
 }
 const proofDigest=(p:ViewProof[])=>digest(p.map(({expiresAt,...v})=>v).sort((a,b)=>a.addressId.localeCompare(b.addressId)));
 const semantics=(e:MorningBriefingPacket['entries'][number])=>e.kind==='schedule'?{addressId:e.addressId,label:e.label,kind:e.kind,plan:scheduleSemantics(e.view)}:e;
 async function safeOldParts(client:LegacyProfileReadQuery,state:BotState,r:MorningGenerationRecord,causes:MorningPartPin[],now:string){
  if(r.partProofs.length>100)return false;
  for(const p of [...r.partProofs].sort((a,b)=>a.outboxId.localeCompare(b.outboxId))){
   const rows=(await client.query('select * from lba_production_profile_outbox where id=$1 for update',[p.outboxId])).rows;
   if(rows.length!==1||rows[0].owner_id!==state.ownerId||rows[0].session_id!==state.sessionId||Number(rows[0].control_epoch)!==expected||rows[0].kind!=='notification'||rows[0].input_id!=='briefing:'+p.briefingId||rows[0].ordinal!==p.partIndex||digest(rows[0].payload)!==p.payloadDigest||!['pending','cancelled'].includes(rows[0].status)||rows[0].status==='cancelled'&&!causes.some(c=>digest(c)===digest(p)))return false;
   await client.query('savepoint morning_jobs');let jobs:any[]|null=null;
   try{jobs=(await client.query("select * from lba_production_telegram_dispatch_jobs where source_kind='profile' and source_id=$1 order by operation_id limit 101 for update nowait",[p.outboxId])).rows;await client.query('release savepoint morning_jobs');}
   catch(error){await client.query('rollback to savepoint morning_jobs');await client.query('release savepoint morning_jobs');if((error as {code?:string}).code!=='55P03')throw error;}
   if(!jobs||jobs.length>100||jobs.some(j=>j.owner_id!==state.ownerId||j.session_id!==state.sessionId||Number(j.control_epoch)!==expected||j.state!=='pending'||Number(j.fence)!==0||Number(j.attempts)!==0||j.payload_digest!==p.payloadDigest))return false;
   if((await client.query("select 1 from lba_production_telegram_dispatch_attempts a join lba_production_telegram_dispatch_jobs j on j.operation_id=a.operation_id where j.source_kind='profile' and j.source_id=$1 limit 1",[p.outboxId])).rows.length)return false;
  }
  return true;
 }
 async function reconcile(tx:Parameters<Parameters<Store['commitMorningBriefing']>[1]>[0],row:any,authorize:(phase:'before_replay'|'before_persist'|'before_commit')=>Promise<void>,setPacket:(p:MorningBriefingPacket)=>void){
  const {client,state,serverNow}=tx,day=row.packet.serviceDate;
  const stored=await readMorningGeneration(client,state.ownerId,state.sessionId,day,expected,serverNow),head=stored?.record??await retainedBase(client,state,row,serverNow);
  if(!validMorningGeneration(head))return fail('LEDGER_INVALID');
  const saved=receipt(head.receipt,state,day,digest(head.packet),serverNow,head.briefingId),window=morningBriefingWindow(state,day,serverNow);
  // Durable historical readback remains available after the delivery window,
  // including a late retry after lost COMMIT acknowledgement. This receipt
  // creates no work and never reopens dispatch admission or the original bound.
  if(!window||window.dueAt!==head.original.dueAt||Date.parse(serverNow)>=Date.parse(head.original.until))return {receipt:saved,replayed:true};
  const current=await entries(client,state,day,serverNow,new AbortController().signal);
  if(digest(current.entries)===digest(head.packet.entries)&&proofDigest(current.proofs)===proofDigest(head.viewProofs))return {receipt:saved,replayed:true};
  const causes=await morningQualificationChain(client,state,head.original,expected,serverNow);if(!causes)return {kind:'policy_skipped' as const};
  if(digest(current.entries.map(semantics))!==digest((head.packet as MorningBriefingPacket).entries.map(semantics))||head.packet.primaryAddressId!==state.profile.primaryAddressId)return {kind:'policy_skipped' as const};
  if(head.generation>=100)return fail('GENERATION_LIMIT');
  const id=occurrenceId(state,day)+':g:'+(head.generation+1),packet:MorningBriefingPacket={...structuredClone(head.packet),id,entries:current.entries};
  if(Buffer.byteLength(JSON.stringify(packet))>2000000||Buffer.byteLength(JSON.stringify(current.proofs))>2000000)return fail('TOO_LARGE');setPacket(packet);
  const formatted=turn(state,packet,serverNow);if(!formatted.messages.length)return {kind:'policy_skipped' as const};
  if(!await safeOldParts(client,state,head,causes,serverNow))return {kind:'policy_skipped' as const};
  await authorize('before_persist');
  // The legacy v1 packet/receipt/proofs remain untouched. A retained-v1 snapshot
  // is captured NOW, not represented as an invented historical write.
  const parentDigest=stored?.digest??await insertMorningGeneration(client,head);
  for(const p of head.partProofs){const changed=await client.query("update lba_production_profile_outbox set status='cancelled' where id=$1 and owner_id=$2 and session_id=$3 and status in ('pending','cancelled')",[p.outboxId,state.ownerId,state.sessionId]);if(changed.rowCount!==1)return fail('RECONCILIATION_CONFLICT');await client.query("update lba_production_telegram_dispatch_jobs set state='cancelled',last_reason='morning_generation_replaced',updated_at=$2 where source_kind='profile' and source_id=$1 and state='pending' and fence=0 and attempts=0",[p.outboxId,serverNow]);}
  const persisted=await tx.persistBriefingTurn({briefing:packet});if(persisted.sessionRevision!==state.revision||persisted.messagesCount!==formatted.messages.length||persisted.outboxIds.length!==formatted.messages.length||persisted.outboxIds.some(id=>!uuid(id)))return fail('PERSIST_INVALID');
  const nextReceipt:MorningBriefingReceipt={kind:'morning_briefing_receipt',briefingId:id,sessionId:state.sessionId,sessionRevision:state.revision,serviceDate:day,packetDigest:digest(packet),outboxIds:persisted.outboxIds,recordedAt:serverNow};
  const next:MorningGenerationRecord={...structuredClone(head),generation:head.generation+1,briefingId:id,predecessor:{generation:head.generation,digest:parentDigest},packet,receipt:nextReceipt,viewProofs:current.proofs,partProofs:await partPins(client,state,packet,persisted.outboxIds,formatted),recordedAt:serverNow};
  await insertMorningGeneration(client,next);await authorize('before_commit');return {receipt:nextReceipt,replayed:false};
 }
 async function verifyGeneration(request:DispatchEligibilityRequest,head:MorningGenerationRecord):Promise<CurrentDispatchSourceProof|null>{
  const {client,job,profile,now,signal}=request,m=job.payload.briefing!;if(m.id!==head.briefingId||m.serviceDate!==head.serviceDate||m.packetDigest!==digest(head.packet)||m.totalParts!==head.partProofs.length||head.partProofs[m.partIndex]?.outboxId!==job.sourceId||head.partProofs[m.partIndex]?.payloadDigest!==digest(job.payload))return null;
  const out=(await client.query('select owner_id,session_id,control_epoch,input_id,kind,status,payload,ordinal from lba_production_profile_outbox where id=$1 for share',[job.sourceId])).rows;
  if(out.length!==1||out[0].owner_id!==profile.ownerId||out[0].session_id!==profile.sessionId||Number(out[0].control_epoch)!==expected||out[0].kind!=='notification'||!['pending','dispatching'].includes(out[0].status)||out[0].input_id!=='briefing:'+m.id||out[0].ordinal!==m.partIndex||digest(out[0].payload)!==digest(job.payload))return null;
  receipt(head.receipt,profile as BotState,head.serviceDate,m.packetDigest,now,head.briefingId);
  const window=morningBriefingWindow(profile as BotState,head.serviceDate,now);if(!window||window.dueAt!==head.original.dueAt||Date.parse(now)>=Date.parse(head.original.until))return null;
  const current=await entries(client,profile as BotState,head.serviceDate,now,signal);if(digest(current.entries)!==digest(head.packet.entries)||proofDigest(current.proofs)!==proofDigest(head.viewProofs))return null;
  const formatted=turn(profile as BotState,head.packet,now);if(formatted.messages.length!==m.totalParts)return null;
  const payload={message:{...formatted.messages[m.partIndex],id:job.sourceId},...(formatted.primarySchedule?{schedule:formatted.primarySchedule}:{}),briefing:m};if(digest(payload)!==digest(job.payload))return null;
  const expires=Math.min(Date.parse(now)+1000,Date.parse(window.until),Date.parse(head.original.until),...current.proofs.map(p=>Date.parse(p.expiresAt)));if(signal.aborted||expires<=Date.parse(now))return null;
  const sourceRevision=job.payload.schedule?.source.revision??m.packetDigest,expiresAt=new Date(expires).toISOString();return {sourceRevision,expiresAt,eventProof:{kind:'morning_briefing',revision:m.packetDigest,scheduleRevisionId:job.payload.schedule?.revisionId??'briefing:'+head.briefingId,sourceRevision,serviceDate:head.serviceDate,expiresAt}};
 }
 return Object.freeze({
  async commit(principal:VerifiedLegacyPrincipal,guard?:MorningBriefingCommitGuard):Promise<{kind:'disabled'|'not_due'|'policy_skipped'}|{receipt:MorningBriefingReceipt;replayed:boolean}>{
   if(!enabled)return {kind:'disabled'};
   if(guard!==undefined&&typeof guard!=='function')return fail('INVALID_GUARD');
   return store.commitMorningBriefing(principal,async tx=>{
    const {client,state,context,serverNow}=tx,day=localParts(Date.parse(serverNow)).date;
    let packet:MorningBriefingPacket|undefined;
    const authorize=async(phase:'before_replay'|'before_persist'|'before_commit')=>{
     if(guard&&await guard({client,state:structuredClone(state),serverNow,phase,...(packet?{briefing:structuredClone(packet)}:{})})!==true)return fail('GUARD_REJECTED');
    };
    await authorize('before_replay');
    const prior=(await client.query('select * from lba_production_morning_briefing where owner_id=$1 and session_id=$2 and service_date=$3',[state.ownerId,state.sessionId,day])).rows;
    if(prior.length){const row=prior[0];if(prior.length!==1||!epoch(row.control_epoch,expected)||row.briefing_id!==occurrenceId(state,day)||!hash(row.packet_digest)||digest(row.packet)!==row.packet_digest)return fail('LEDGER_INVALID');
     return reconcile(tx,row,authorize,p=>{packet=p;});}
    const window=morningBriefingWindow(state,day,serverNow);if(!window)return {kind:'not_due' as const};
    const current=await entries(client,state,day,serverNow,new AbortController().signal);
    packet={kind:'morning_briefing',id:occurrenceId(state,day),serviceDate:day,createdAt:window.dueAt,primaryAddressId:state.profile.primaryAddressId,entries:current.entries};
    if(Buffer.byteLength(JSON.stringify(packet))>2000000||Buffer.byteLength(JSON.stringify(current.proofs))>2000000)return fail('TOO_LARGE');
    const formatted=turn(state,packet,serverNow);if(!formatted.messages.length)return {kind:'policy_skipped' as const};
    const packetDigest=digest(packet);await authorize('before_persist');
    const persisted=await tx.persistBriefingTurn({briefing:structuredClone(packet)});
    if(persisted.sessionRevision!==state.revision||!int(persisted.sessionRevision)||persisted.messagesCount!==formatted.messages.length||!Array.isArray(persisted.outboxIds)||
     persisted.outboxIds.length!==formatted.messages.length||persisted.outboxIds.some(id=>!uuid(id))||new Set(persisted.outboxIds).size!==persisted.outboxIds.length)return fail('PERSIST_INVALID');
    const committed:MorningBriefingReceipt={kind:'morning_briefing_receipt',briefingId:packet.id,sessionId:state.sessionId,sessionRevision:state.revision,
     serviceDate:day,packetDigest,outboxIds:persisted.outboxIds,recordedAt:serverNow};
    await client.query('insert into lba_production_morning_briefing(owner_id,session_id,service_date,control_epoch,briefing_id,packet_digest,packet,receipt,recorded_at) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)',
     [state.ownerId,state.sessionId,day,expected,packet.id,packetDigest,JSON.stringify(packet),JSON.stringify(committed),serverNow]);
    for(const proof of current.proofs)await client.query('insert into lba_production_morning_briefing_view_proof(owner_id,session_id,service_date,address_id,control_epoch,certificate_id,certificate_digest,view_digest) values($1,$2,$3,$4,$5,$6,$7,$8)',
     [state.ownerId,state.sessionId,day,proof.addressId,expected,proof.certificateId,proof.certificateDigest,proof.viewDigest]);
    for(let i=0;i<persisted.outboxIds.length;i++){
     const id=persisted.outboxIds[i],rows=(await client.query('select owner_id,session_id,input_id,control_epoch,kind,payload,ordinal from lba_production_profile_outbox where id=$1 for share',[id])).rows;
     if(rows.length!==1)return fail('PERSIST_INVALID');const row=rows[0],metadata={id:packet.id,serviceDate:day,packetDigest,partIndex:i,totalParts:persisted.outboxIds.length};
     const payload={message:{...formatted.messages[i],id},...(formatted.primarySchedule?{schedule:formatted.primarySchedule}:{}),briefing:metadata};
     if(row.owner_id!==state.ownerId||row.session_id!==state.sessionId||row.input_id!=='briefing:'+packet.id||!epoch(row.control_epoch,expected)||row.kind!=='notification'||row.ordinal!==i||digest(row.payload)!==digest(payload))return fail('PERSIST_INVALID');
     await client.query('insert into lba_production_morning_briefing_outbox_proof(outbox_id,owner_id,session_id,service_date,control_epoch,briefing_id,packet_digest,payload_digest,part_index,total_parts) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id,state.ownerId,state.sessionId,day,expected,packet.id,packetDigest,digest(payload),i,persisted.outboxIds.length]);
    }
    await insertMorningGeneration(client,{kind:'lba-morning-generation/1',basis:'native_generation',ownerId:state.ownerId,sessionId:state.sessionId,controlEpoch:expected,serviceDate:day,generation:0,briefingId:packet.id,predecessor:null,packet,receipt:committed,viewProofs:current.proofs,partProofs:await partPins(client,state,packet,persisted.outboxIds,formatted),original:{revision:state.revision,recordedAt:serverNow,intentDigest:morningIntentDigest(state),dueAt:window.dueAt,until:window.until},recordedAt:serverNow});
    await authorize('before_commit');return {receipt:committed,replayed:false};
   });
  },
  /** Full aggregate revalidation in the sender's existing transaction. Every
   * continuation part shares one logical occurrence, complete packet and policy.
   * No source/recipient authority is inferred merely from message text. */
  async verifyDispatch(request:DispatchEligibilityRequest):Promise<CurrentDispatchSourceProof|null>{
   if(!enabled)return null;
   try{
    const {client,job,profile,now,signal}=request,metadata=job.payload.briefing;
    if(signal.aborted||!validInstant(now)||job.sourceKind!=='profile'||job.controlEpoch!==expected||job.ownerId!==profile.ownerId||job.sessionId!==profile.sessionId||job.payload.message.kind!=='notification'||
     !uuid(job.sourceId)||!closed(metadata,['id','serviceDate','packetDigest','partIndex','totalParts'])||!int(metadata.partIndex)||!int(metadata.totalParts)||metadata.totalParts<1||metadata.totalParts>100||metadata.partIndex>=metadata.totalParts||!hash(metadata.packetDigest))return null;
    const control=(await client.query('select control_epoch,writer_mode from lba_production_control where id=true for share')).rows;
    if(control.length!==1||!epoch(control[0].control_epoch,expected)||control[0].writer_mode!=='canonical')return null;
    const generation=await readMorningGeneration(client,profile.ownerId,profile.sessionId,metadata.serviceDate,expected,now);
    if(generation&&generation.record.generation>0)return verifyGeneration(request,generation.record);
    const rows=(await client.query(`select p.*,b.packet,b.receipt,b.control_epoch as briefing_epoch,b.packet_digest as occurrence_digest,
     o.owner_id as outbox_owner,o.session_id as outbox_session,o.control_epoch as outbox_epoch,o.payload,o.input_id,o.kind,o.status,o.ordinal
     from lba_production_morning_briefing_outbox_proof p join lba_production_morning_briefing b on b.owner_id=p.owner_id and b.session_id=p.session_id and b.service_date=p.service_date
     join lba_production_profile_outbox o on o.id=p.outbox_id where p.outbox_id=$1 for share of p,b,o`,[job.sourceId])).rows;
    if(rows.length!==1)return null;const row=rows[0];
    if(row.owner_id!==profile.ownerId||row.session_id!==profile.sessionId||row.outbox_owner!==profile.ownerId||row.outbox_session!==profile.sessionId||
     [row.control_epoch,row.briefing_epoch,row.outbox_epoch].some(e=>!epoch(e,expected))||row.kind!=='notification'||!['pending','dispatching'].includes(row.status)||row.input_id!=='briefing:'+metadata.id||
     row.briefing_id!==metadata.id||row.packet_digest!==metadata.packetDigest||row.occurrence_digest!==metadata.packetDigest||row.part_index!==metadata.partIndex||row.total_parts!==metadata.totalParts||row.ordinal!==metadata.partIndex||
     row.payload_digest!==digest(job.payload)||row.payload_digest!==digest(row.payload)||digest(row.packet)!==metadata.packetDigest)return null;
    const packet=row.packet as MorningBriefingPacket;
    if(packet.id!==occurrenceId(profile as BotState,metadata.serviceDate)||packet.id!==metadata.id||packet.serviceDate!==metadata.serviceDate)return null;
    const saved=receipt(row.receipt,profile as BotState,metadata.serviceDate,metadata.packetDigest,now);if(saved.outboxIds[metadata.partIndex]!==job.sourceId||saved.outboxIds.length!==metadata.totalParts)return null;
    const window=morningBriefingWindow(profile as BotState,packet.serviceDate,now);if(!window||packet.createdAt!==window.dueAt)return null;
    const current=await entries(client,profile as BotState,packet.serviceDate,now,signal);if(digest(current.entries)!==digest(packet.entries))return null;
    const formatted=turn(profile as BotState,packet,now);if(formatted.messages.length!==metadata.totalParts)return null;
    const expectedPayload={message:{...formatted.messages[metadata.partIndex],id:job.sourceId},...(formatted.primarySchedule?{schedule:formatted.primarySchedule}:{}),briefing:metadata};
    if(digest(expectedPayload)!==digest(job.payload))return null;
    const proofs=(await client.query('select address_id,control_epoch,certificate_id,certificate_digest,view_digest from lba_production_morning_briefing_view_proof where owner_id=$1 and session_id=$2 and service_date=$3 for share',[profile.ownerId,profile.sessionId,packet.serviceDate])).rows;
    if(proofs.length!==current.proofs.length)return null;
    let expires=Math.min(Date.parse(now)+1000,Date.parse(window.until));
    for(const proof of current.proofs){const matches=proofs.filter(p=>p.address_id===proof.addressId);if(matches.length!==1||!epoch(matches[0].control_epoch,expected)||matches[0].certificate_id!==proof.certificateId||matches[0].certificate_digest!==proof.certificateDigest||matches[0].view_digest!==proof.viewDigest)return null;expires=Math.min(expires,Date.parse(proof.expiresAt));}
    if(signal.aborted||expires<=Date.parse(now))return null;
    const sourceRevision=job.payload.schedule?.source.revision??metadata.packetDigest,expiresAt=new Date(expires).toISOString();
    return {sourceRevision,expiresAt,eventProof:{kind:'morning_briefing',revision:metadata.packetDigest,scheduleRevisionId:job.payload.schedule?.revisionId??'briefing:'+packet.id,sourceRevision,serviceDate:packet.serviceDate,expiresAt}};
   }catch{return null;}
  },
 });
}
