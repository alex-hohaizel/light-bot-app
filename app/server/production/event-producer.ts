import {randomUUID} from 'node:crypto';
import type {ScheduleEvent,ScheduleView} from '../../shared/product-contract.ts';
import type {BotState} from '../../shared/bot/types.ts';
import {handleScheduleEvent,restoreBotState} from '../../shared/bot/engine.ts';
import {validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
import type {LegacyProfileReadPool,LegacyProfileReadQuery} from './profile-reader.ts';
import {scheduleEventDigest,type ScheduleIntentReplacement,type createProductionScheduleEvents} from './schedule-events.ts';
import type {createProductionMorningBriefing} from './morning-briefing.ts';

/** Explicit additive migration only. No constructor/startup DDL, certificate
 * writer, account bootstrap, source HTTP or bot transport exists in this module. */
export const EVENT_PRODUCER_SCHEMA_SQL=`
create table if not exists lba_production_event_producer_lease (
 id boolean primary key default true check(id=true),control_epoch bigint not null check(control_epoch>0),
 worker_id varchar(128) not null,lease_token uuid not null,fence bigint not null check(fence>0),
 expires_at timestamptz not null,cursor_owner text not null default '',cursor_session text not null default '',
 cursor_address text not null default '',cursor_day text not null default '',
 cursor_briefing_owner text not null default '',cursor_briefing_session text not null default ''
);
alter table lba_production_event_producer_lease add column if not exists cursor_briefing_owner text not null default '';
alter table lba_production_event_producer_lease add column if not exists cursor_briefing_session text not null default '';
`;
type Events=Pick<ReturnType<typeof createProductionScheduleEvents>,'commit'>;
type Morning=Pick<ReturnType<typeof createProductionMorningBriefing>,'commit'>;
interface Lease {token:string;fence:string;cursor:[string,string,string,string];briefingCursor:[string,string]}
interface Candidate {owner_id:string;session_id:string;revision:string|number;profile_epoch:string|number;state:unknown;
 id:string;record:unknown;record_digest:string;view_digest:string;address_id:string;service_day:string;issued_at:unknown}
export interface EventProducerResult {
 kind:'disabled'|'busy'|'completed'|'aborted';scanned:number;eligible:number;committed:number;ignored:number;replayed:number;skipped:number;
 cursorWrapped:boolean;morningBriefing:'unsupported_contract'|'available';
 briefingScanned:number;briefingCommitted:number;briefingReplayed:number;briefingSkipped:number;briefingCursorWrapped:boolean;
}
export interface ProductionEventProducerOptions {
 pool:LegacyProfileReadPool;events:Events;expectedControlEpoch:number;enabled?:boolean;workerId?:string;now?:()=>string;
 /** Separate once/day aggregate recipe; never masquerades as a ScheduleEvent. */
 morningBriefing?:Morning;
 /** One bounded batch; a persisted keyset cursor prevents large owners starving later owners. */
 batchSize?:number;maxEvents?:number;leaseMs?:number;
}
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=512):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const epoch=(v:unknown,n:number)=>Boolean((typeof v==='number'&&Number.isSafeInteger(v)||typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v))&&Number(v)===n);
const fail=(reason:string):never=>{throw Error('PRODUCTION_EVENT_PRODUCER_'+reason);};
const scope=(v:ScheduleView)=>scheduleEventDigest({addressId:v.addressId,operatorId:v.operatorId,namespace:v.namespace??null,
 targetId:v.targetId??null,bindingRevisionId:v.bindingRevisionId??null,serviceDate:v.serviceDate});
const occurrence=(v:ScheduleView,e:NonNullable<ScheduleEvent['reminder']>)=>scheduleEventDigest({scope:scope(v),edge:e.edge,
 startsAt:Date.parse(e.intervalStartsAt),endsAt:Date.parse(e.intervalEndsAt)});
const initial=(morning=false):EventProducerResult=>({kind:'completed',scanned:0,eligible:0,committed:0,ignored:0,replayed:0,skipped:0,cursorWrapped:false,morningBriefing:morning?'available':'unsupported_contract',
 briefingScanned:0,briefingCommitted:0,briefingReplayed:0,briefingSkipped:0,briefingCursorWrapped:false});

/** Server-only canonical observation adapter. Constructor is inert. The event
 * service remains the only writer of event/cursor/outbox state, and its pure bot
 * engine remains the only notification/reminder policy implementation.
 *
 * An optional separate aggregate port covers morning briefings. Its own
 * canonical-only keyset includes owners with no schedule certificates at all.
 */
export function createProductionEventProducer(options:ProductionEventProducerOptions){
 const batch=options?.batchSize??50,maxEvents=options?.maxEvents??100,leaseMs=options?.leaseMs??30000;
 const expected=options?.expectedControlEpoch,worker=options?.workerId??'events:'+randomUUID();
 if(!options||typeof options.pool?.connect!=='function'||typeof options.events?.commit!=='function'||!integer(expected,1,Number.MAX_SAFE_INTEGER)||
  options.enabled!==undefined&&typeof options.enabled!=='boolean'||options.now!==undefined&&typeof options.now!=='function'||!text(worker,128)||
  options.morningBriefing!==undefined&&typeof options.morningBriefing?.commit!=='function'||
  !integer(batch,1,200)||!integer(maxEvents,1,1000)||!integer(leaseMs,1000,60000))return fail('INVALID_OPTIONS');
 const enabled=options.enabled===true,pool=options.pool,events=options.events,morning=options.morningBriefing;
 const clock=()=>{const now=(options.now??(()=>new Date().toISOString()))();return validInstant(now)?now:fail('INVALID_CLOCK');};
 let running:Promise<EventProducerResult>|undefined,timer:ReturnType<typeof setTimeout>|undefined,started=false,stopped=false;
 const lifecycleAbort=new AbortController();
 async function query<T>(operation:(client:LegacyProfileReadQuery)=>Promise<T>):Promise<T>{
  const client=await pool.connect();try{return await operation(client);}finally{client.release();}
 }
 async function controlled(client:LegacyProfileReadQuery){
  const rows=(await client.query('select control_epoch,writer_mode from lba_production_control where id=true for share')).rows;
  if(rows.length!==1||!epoch(rows[0].control_epoch,expected)||rows[0].writer_mode!=='canonical')return fail('CONTROL_REVOKED');
 }
 async function transaction<T>(operation:(client:LegacyProfileReadQuery)=>Promise<T>):Promise<T>{return query(async client=>{
  try{await client.query('begin');await controlled(client);const result=await operation(client);await client.query('commit');return result;}
  catch(error){await client.query('rollback').catch(()=>{});throw error;}
 });}
 async function acquire():Promise<Lease|null>{return transaction(async client=>{
  const token=randomUUID();
  // SKIP LOCKED is essential: an event transaction holds this row FOR SHARE.
  // A second worker reports busy immediately even if that lease expired while
  // the first transaction is finishing its final guard and rollback.
  const selected=(await client.query('select *,expires_at>clock_timestamp() as active from lba_production_event_producer_lease where id=true for update skip locked')).rows;
  if(selected.length>1)return fail('LEASE_INVALID');
  if(selected[0]?.active===true)return null;
  let rows;
  if(selected.length)rows=(await client.query(`update lba_production_event_producer_lease set control_epoch=$1,worker_id=$2,lease_token=$3,
   fence=fence+1,expires_at=clock_timestamp()+$4::double precision*interval '1 millisecond' where id=true and expires_at<=clock_timestamp() returning *`,[expected,worker,token,leaseMs])).rows;
  else {
   // An existing row was skipped because a canonical transaction owns it.
   if((await client.query('select id from lba_production_event_producer_lease where id=true')).rows.length)return null;
   rows=(await client.query(`insert into lba_production_event_producer_lease(id,control_epoch,worker_id,lease_token,fence,expires_at)
    values(true,$1,$2,$3,1,clock_timestamp()+$4::double precision*interval '1 millisecond') on conflict(id) do nothing returning *`,[expected,worker,token,leaseMs])).rows;
  }
  if(!rows.length)return null;const row=rows[0];
  if(rows.length!==1||!epoch(row.control_epoch,expected)||!/^[1-9]\d{0,18}$/.test(String(row.fence))||
   ![row.cursor_owner,row.cursor_session,row.cursor_address,row.cursor_day,row.cursor_briefing_owner,row.cursor_briefing_session].every(v=>typeof v==='string'))return fail('LEASE_INVALID');
  return {token,fence:String(row.fence),cursor:[row.cursor_owner,row.cursor_session,row.cursor_address,row.cursor_day],briefingCursor:[row.cursor_briefing_owner,row.cursor_briefing_session]};
 });}
 async function renew(lease:Lease,cursor?:Lease['cursor'],briefingCursor?:Lease['briefingCursor']){return transaction(async client=>{
  const changed=await client.query(`update lba_production_event_producer_lease set expires_at=clock_timestamp()+$5::double precision*interval '1 millisecond',
   cursor_owner=coalesce($6,cursor_owner),cursor_session=coalesce($7,cursor_session),cursor_address=coalesce($8,cursor_address),cursor_day=coalesce($9,cursor_day),
   cursor_briefing_owner=coalesce($10,cursor_briefing_owner),cursor_briefing_session=coalesce($11,cursor_briefing_session)
   where id=true and control_epoch=$1 and worker_id=$2 and lease_token=$3 and fence=$4 and expires_at>clock_timestamp()`,
   [expected,worker,lease.token,lease.fence,leaseMs,...(cursor??[null,null,null,null]),...(briefingCursor??[null,null])]);
  if(changed.rowCount!==1)return fail('LEASE_LOST');
 });}
 function guardFor(lease:Lease,profile:{ownerId:string;sessionId:string},signal:AbortSignal){
  return async(input:{client:LegacyProfileReadQuery;state:BotState;serverNow:string})=>{
   if(signal.aborted||lifecycleAbort.signal.aborted||input.state.ownerId!==profile.ownerId||input.state.sessionId!==profile.sessionId)return false;
   const rows=(await input.client.query(`select control_epoch from lba_production_event_producer_lease where id=true and control_epoch=$1 and worker_id=$2
    and lease_token=$3 and fence=$4 and expires_at>clock_timestamp() for share`,[expected,worker,lease.token,lease.fence])).rows;
   return rows.length===1&&epoch(rows[0].control_epoch,expected);
  };
 }
 async function briefings(lease:Lease,report:EventProducerResult,signal:AbortSignal){
  if(!morning)return;if(signal.aborted||lifecycleAbort.signal.aborted){report.kind='aborted';return;}
  const rows=await transaction(async client=>(await client.query(`select owner_id,session_id from lba_production_profiles
   where control_epoch=$1 and (owner_id,session_id)>($2,$3) order by owner_id,session_id limit $4`,[expected,...lease.briefingCursor,Math.min(batch,maxEvents)])).rows);
  for(const row of rows){
   if(signal.aborted||lifecycleAbort.signal.aborted){report.kind='aborted';return;}
   if(!text(row.owner_id,255)||!text(row.session_id,128))return fail('PROFILE_INVALID');
   await renew(lease);report.briefingScanned++;
   const result=await morning.commit({kind:'verified_server_principal',verified:true,ownerId:row.owner_id},guardFor(lease,{ownerId:row.owner_id,sessionId:row.session_id},signal));
   if('receipt' in result){if(result.replayed)report.briefingReplayed++;else report.briefingCommitted++;}
   else if(result.kind==='disabled')return fail('MORNING_SERVICE_DISABLED');
   else report.briefingSkipped++;
   await renew(lease,undefined,[row.owner_id,row.session_id]);
  }
  if(!rows.length){await renew(lease,undefined,['','']);report.briefingCursorWrapped=true;}
 }
 async function candidates(lease:Lease):Promise<Candidate[]>{return transaction(async client=>{
  // No legacy table, account discovery or bootstrap path is involved. Only the
  // newest active observation for each canonical owner/session/address/day is
  // considered; an invalid newest cert never falls back to older accepted data.
  return (await client.query(`select * from (
   select p.owner_id,p.session_id,p.revision,p.control_epoch as profile_epoch,p.state,c.id,c.record,c.record_digest,c.view_digest,c.address_id,
    c.record->'view'->>'serviceDate' as service_day,c.issued_at,
    row_number() over(partition by p.owner_id,p.session_id,c.address_id,c.record->'view'->>'serviceDate' order by c.issued_at desc,c.id desc) as rank
   from lba_production_profiles p join lba_production_schedule_certificate c on c.owner_id=p.owner_id and c.session_id=p.session_id
   where p.control_epoch=$1 and c.control_epoch=$1 and c.revoked_at is null and c.issued_at<=$2::timestamptz and c.expires_at>$2::timestamptz
   ) q where rank=1 and (owner_id,session_id,address_id,service_day)>($3,$4,$5,$6)
   order by owner_id,session_id,address_id,service_day limit $7`,[expected,clock(),...lease.cursor,batch])).rows as Candidate[];
 });}
 function candidate(row:Candidate):{state:BotState;view:ScheduleView;issuedAt:string}|null{
  try{
   if(!text(row.owner_id,255)||!text(row.session_id,128)||!epoch(row.profile_epoch,expected)||!plain(row.record)||!hash(row.record_digest)||
    scheduleEventDigest(row.record)!==row.record_digest)return null;
   const state=restoreBotState(row.state,row.owner_id),view=structuredClone(row.record.view) as ScheduleView;
   validateScheduleView(view);
   const issuedAt=row.issued_at instanceof Date?row.issued_at.toISOString():row.issued_at;
   if(!validInstant(issuedAt)||state.sessionId!==row.session_id||!/^\d{1,16}$/.test(String(row.revision))||Number(row.revision)!==state.revision||
    !hash(row.view_digest)||scheduleEventDigest(view)!==row.view_digest||view.addressId!==row.address_id||view.serviceDate!==row.service_day||
    row.record.ownerId!==row.owner_id||row.record.sessionId!==row.session_id||row.record.controlEpoch!==expected||
    !['published','possible','no_planned_outages','emergency'].includes(view.status))return null;
   const locations=state.profile.locations.filter(l=>l.address.id===view.addressId);
   if(locations.length!==1||locations[0].address.label!==view.addressLabel||scheduleEventDigest(locations[0].binding)!==scheduleEventDigest(row.record.binding))return null;
   return {state,view,issuedAt};
  }catch{return null;}
 }
 async function nextId(client:LegacyProfileReadQuery,state:BotState,key:unknown){
  const prefix='producer:'+scheduleEventDigest({owner:state.ownerId,session:state.sessionId,key})+':';
  const rows=(await client.query(`select event_id from lba_production_schedule_event where owner_id=$1 and session_id=$2 and event_id like $3 order by event_id desc limit 1`,[state.ownerId,state.sessionId,prefix+'%'])).rows;
  let attempt=0;if(rows.length){const suffix=rows[0].event_id.slice(prefix.length);if(!/^\d{10}$/.test(suffix))return fail('ATTEMPT_INVALID');attempt=Number(suffix)+1;}
  if(attempt>9999999999)return fail('ATTEMPT_LIMIT');return prefix+String(attempt).padStart(10,'0');
 }
 async function replacementId(client:LegacyProfileReadQuery,state:BotState,r:ScheduleIntentReplacement){
  const prefix='replacement:'+r.previousOutboxId+':'+r.certificateId+':';
  const rows=(await client.query('select event_id from lba_production_schedule_event where owner_id=$1 and session_id=$2 and event_id like $3 order by event_id desc limit 1',[state.ownerId,state.sessionId,prefix+'%'])).rows;
  let n=0;if(rows.length){const suffix=String(rows[0].event_id).slice(prefix.length);if(!/^\d{10}$/.test(suffix))return fail('ATTEMPT_INVALID');n=Number(suffix)+1;}
  if(n>9999999999)return fail('ATTEMPT_LIMIT');return prefix+String(n).padStart(10,'0');
 }
 async function produce(lease:Lease,row:Candidate,report:EventProducerResult,signal:AbortSignal){
  const checked=candidate(row);if(!checked){report.skipped++;return;}
  const {state,view,issuedAt}=checked,scopeHash=scope(view),now=clock();
  const cursor=await query(async client=>{
   const rows=(await client.query('select event_id,revision_id,semantics,certificate_id,control_epoch from lba_production_schedule_cursor where owner_id=$1 and session_id=$2 and scope_hash=$3',[state.ownerId,state.sessionId,scopeHash])).rows;
   if(rows.length>1||rows.length===1&&(!epoch(rows[0].control_epoch,expected)||!text(rows[0].event_id,128)||!text(rows[0].revision_id)||typeof rows[0].semantics!=='string'))return fail('CURSOR_INVALID');return rows[0];
  });
  const base={addressId:view.addressId,operatorId:view.operatorId,serviceDate:view.serviceDate,fromRevisionId:cursor?.revision_id??null,toRevisionId:view.revisionId,createdAt:issuedAt};
  const jobs:Array<{event:Omit<ScheduleEvent,'id'>;key:unknown;reminder:boolean;replacement?:ScheduleIntentReplacement}>=[];
  // Only the issuer's closed, revision-bound renewal marker can propose an
  // already sealed intent. Advisory reads are revalidated atomically by events.
  const renewal=plain(row.record)&&plain(row.record.renewal)?row.record.renewal:null;
  if(renewal?.profileRevision===state.revision&&renewal.controlEpoch===expected&&Array.isArray(renewal.predecessors)&&renewal.predecessors.length<=32){
   for(const pin of renewal.predecessors){
    if(!plain(pin)||!validInstant(pin.intentDeadline)||Date.parse(pin.intentDeadline)<=Date.parse(now)||typeof pin.outboxId!=='string')continue;
    const previous=await query(async client=>(await client.query(`select e.event,o.status from lba_production_profile_outbox o join lba_production_schedule_outbox_proof p on p.outbox_id=o.id
     join lba_production_schedule_event e on e.owner_id=p.owner_id and e.session_id=p.session_id and e.event_id=p.event_id
     where o.id=$1 and o.owner_id=$2 and o.session_id=$3 and o.status in ('pending','cancelled')
     and not exists(select 1 from lba_production_schedule_event s where s.owner_id=o.owner_id and s.session_id=o.session_id and s.event_id like $4 and s.receipt->>'outcome'='notification_committed')
     and not exists(select 1 from lba_production_telegram_dispatch_jobs j where j.source_kind='profile' and j.source_id=o.id::text and (j.state<>'pending' or j.fence<>0 or j.attempts<>0 or exists(select 1 from lba_production_telegram_dispatch_attempts a where a.operation_id=j.operation_id)))`,[pin.outboxId,state.ownerId,state.sessionId,'replacement:'+pin.outboxId+':%'])).rows);
    if(previous.length!==1||!plain(previous[0].event))continue;
    const old=previous[0].event as unknown as ScheduleEvent;
    const event:ScheduleEvent={...base,id:'producer:replacement-probe',kind:old.kind,...(old.reminder?{reminder:structuredClone(old.reminder)}:{})};
    if(!handleScheduleEvent(state,event,view,{actorId:state.ownerId,now,addresses:[],plans:[]}).messages.length)continue;
    const replacement:ScheduleIntentReplacement={kind:'lba-schedule-intent-replacement/1',previousOutboxId:pin.outboxId,certificateId:row.id};
    jobs.push({event,key:{kind:'replacement',old:pin.outboxId,certificate:row.id},reminder:old.kind==='reminder',replacement});
   }
  }
  if(cursor?.certificate_id!==row.id&&!jobs.some(j=>!j.reminder)){
   const kind:ScheduleEvent['kind']=view.status==='emergency'?'emergency':view.status==='no_planned_outages'?'cancelled':cursor?'changed':'new_plan';
   jobs.push({event:{...base,kind},key:{kind:'observation',scope:scopeHash,predecessor:cursor?.event_id??null,certificate:row.record_digest,view:row.view_digest},reminder:false});
  }
  for(const interval of view.intervals){for(const edge of ['starts','ends'] as const){
   const reminder={edge,intervalStartsAt:interval.startsAt,intervalEndsAt:interval.endsAt};
   const event:ScheduleEvent={...base,id:'producer:due-probe',kind:'reminder',createdAt:now,reminder};
   // Use the existing engine for exact one-minute/quiet/duration/DST policy.
   // Crucially, not-due/expired reminders never enter the immutable event ledger.
   if(!handleScheduleEvent(state,event,view,{actorId:state.ownerId,now,addresses:[],plans:[]}).messages.length)continue;
   const seen=await query(async client=>(await client.query('select event_id,control_epoch from lba_production_schedule_reminder where owner_id=$1 and session_id=$2 and occurrence_hash=$3',[state.ownerId,state.sessionId,occurrence(view,reminder)])).rows);
   if(seen.length){if(seen.length!==1||!epoch(seen[0].control_epoch,expected))return fail('REMINDER_CURSOR_INVALID');continue;}
   jobs.push({event:{...event,createdAt:issuedAt},key:{kind:'reminder',occurrence:occurrence(view,reminder)},reminder:true});
  }}
  if(!jobs.length){report.skipped++;return;}
  for(const job of jobs){
   if(signal.aborted||lifecycleAbort.signal.aborted)return;
   if(report.committed+report.ignored+report.replayed>=maxEvents)return;
   await renew(lease);
   const id=await query(client=>job.replacement?replacementId(client,state,job.replacement):nextId(client,state,job.key)),event={...job.event,id} as ScheduleEvent;
   // Guard executes inside the service's canonical transaction and holds the
   // lease row FOR SHARE through event/outbox commit. Expired/replaced workers,
   // changed sessions and aborted runs cannot commit a late notification.
   const guard=guardFor(lease,state,signal);
   const result=await events.commit({kind:'verified_server_principal',verified:true,ownerId:state.ownerId},event,view,guard,job.replacement);
   if('receipt' in result){if(result.replayed)report.replayed++;else if(result.receipt.outcome==='notification_committed'){report.committed++;report.eligible++;}else report.ignored++;}
   else return fail('EVENT_SERVICE_DISABLED');
  }
 }
 async function execute(signal:AbortSignal):Promise<EventProducerResult>{
  const report=initial(Boolean(morning));if(!enabled)return {...report,kind:'disabled'};
  if(stopped||signal.aborted||lifecycleAbort.signal.aborted)return {...report,kind:'aborted'};
  const lease=await acquire();if(!lease)return {...report,kind:'busy'};
  try{
   const rows=await candidates(lease);
   for(const row of rows){
    if(signal.aborted||lifecycleAbort.signal.aborted){report.kind='aborted';break;}
    if(report.committed+report.ignored+report.replayed>=maxEvents)break;
    report.scanned++;await produce(lease,row,report,signal);
    await renew(lease,[row.owner_id,row.session_id,row.address_id,row.service_day]);
   }
   if(!rows.length){await renew(lease,['','','','']);report.cursorWrapped=true;}
   await briefings(lease,report,signal);
   return report;
  }finally{
   // A stale worker cannot release its successor's lease. Release is not a
   // certificate/profile/event write and never enables production by itself.
   await query(client=>client.query(`update lba_production_event_producer_lease set expires_at=clock_timestamp() where id=true and control_epoch=$1 and worker_id=$2 and lease_token=$3 and fence=$4`,[expected,worker,lease.token,lease.fence])).catch(()=>{});
  }
 }
 function runOnce(input:{signal?:AbortSignal}={}):Promise<EventProducerResult>{
  if(running)return Promise.resolve({...initial(Boolean(morning)),kind:'busy'});
  const signal=input.signal??new AbortController().signal;
  running=execute(signal).finally(()=>{running=undefined;});return running;
 }
 function start(input:{intervalMs?:number}={}){
  const interval=input.intervalMs??1000;if(!integer(interval,100,60000)||started||stopped)return fail('LIFECYCLE_INVALID');started=true;
  const tick=()=>{if(stopped)return;void runOnce().catch(()=>{}).finally(()=>{if(!stopped)timer=setTimeout(tick,interval);});};tick();
 }
 async function stop(){stopped=true;lifecycleAbort.abort();if(timer)clearTimeout(timer);if(running)await Promise.allSettled([running]);}
 return Object.freeze({runOnce,start,stop});
}
