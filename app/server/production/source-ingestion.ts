import {randomUUID} from 'node:crypto';
import {load as parseXml} from 'cheerio';
import {localParts,nextCalendarDate} from '../../shared/schedule-core.ts';
import {createSourceIntake,SOURCE_PROFILES,type CapturedPublicSourceRaw,type SourceHttpTransport,type SourceIntakeResult,type IntakeCode,type SourceProfile} from './source-intake.ts';
import {technicalDisplaySourceRegistry,odesaPlanApiOperatingRecord} from './source-operating-policy.ts';
import {createOdesaPlanSource,odesaCompletePlanCursor,projectOdesaPlanSnapshot,projectOdesaPlanSnapshotBatch,readOdesaPlanSnapshot,validOdesaPlanOperatingRecord,type OdesaPlanSnapshot} from './odesa-plan-source.ts';
import {ODESA_PLAN_API_SOURCE} from '../domain/odesa-plan-api-adapter.ts';
import type {LegacyProfileReadPool,LegacyProfileReadClient,LegacyProfileReadQuery} from './profile-reader.ts';
import {createPublicSourceReservationGuard,type SourceReservationFailure} from './public-source-reservation.ts';

/** Explicit additive public-only cache. Never auto-applied, seeded or started. */
export const SOURCE_INGESTION_SCHEMA_SQL = `
create table if not exists lba_public_source_worker (
 id boolean primary key check(id = true),uncertain boolean not null,hold_reason text
);
create table if not exists lba_public_source_origin (
 origin text primary key,next_attempt_at timestamptz not null,
 uncertain boolean not null,hold_reason text
);
create table if not exists lba_public_source_state (
 source_id text primary key,last_attempt_at timestamptz not null,
 last_success_at timestamptz,last_failure text
);
create table if not exists lba_public_source_run (
 id uuid primary key,source_id text not null,control_epoch bigint not null check(control_epoch>0),
 started_at timestamptz not null,finished_at timestamptz,
 status text not null check(status in ('started','published','rejected')),code text
);
create table if not exists lba_public_source_raw (
 id uuid primary key,run_id uuid not null unique references lba_public_source_run(id),
 source_id text not null,observed_at timestamptz not null,snapshot jsonb not null
);
create table if not exists lba_public_source_plan (
 source_id text not null,target_id text not null,service_date date not null,
 raw_id uuid not null references lba_public_source_raw(id),
 primary key(source_id,target_id,service_date)
);
create index if not exists lba_public_source_plan_raw on lba_public_source_plan(raw_id);
`;
export type SourceServiceCode = IntakeCode | 'SOURCE_SERVICE_DISABLED'|'SOURCE_CONTROL_REJECTED'|'SOURCE_EPOCH_CONFLICT'|
 'SOURCE_STORAGE_UNAVAILABLE'|'SOURCE_WORKER_BUSY'|'SOURCE_LOCAL_BUDGET_DEFERRED'|'SOURCE_ORIGIN_HELD'|
 'SOURCE_NOT_DUE'|'SOURCE_CATALOG_REJECTED'|'SOURCE_PUBLICATION_UNKNOWN'|'SOURCE_WORKER_HELD';
type Available = Extract<SourceIntakeResult,{state:'available'}>;
export type SourceRefreshResult = {state:'published';sourceId:string;validatedViews:number;validatedGroups:number;partial:boolean;observedAt:string;
 addressBindingVerified:false;deliveryEligible:false}|{state:'disabled'|'blocked'|'deferred'|'unavailable';code:SourceServiceCode;sourceId?:string};
export interface PublicTechnicalPlans {
 state:'available'|'disabled'|'unavailable';plans:Available[];
 observations:Array<{sourceId:string;state:'cached'|'unavailable'|'blocked';code?:SourceServiceCode;lastAttemptAt:string|null;lastSuccessAt:string|null}>;
 code?:SourceServiceCode;addressBindingVerified:false;deliveryEligible:false;parallel48hAccepted:false;
}
export interface PublicTechnicalCatalog {
 state:PublicTechnicalPlans['state'];code?:SourceServiceCode;
 groups:Array<{sourceId:string;region:string;operatorId:string;namespace:string;targetId:string;
  dates:Array<{serviceDate:string;status:Available['view']['status'];freshness:Available['view']['freshness']}>}>;
 addressBindingVerified:false;deliveryEligible:false;
}
class SourceServiceFailure extends Error {readonly code:SourceServiceCode;constructor(code:SourceServiceCode){super(code);this.code=code;}}
const fail=(code:SourceServiceCode):never=>{throw new SourceServiceFailure(code);};
const int=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=8_640_000_000_000_000;
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const INTAKE_CODES=new Set<IntakeCode>(['SOURCE_UPDATE_UNCONFIRMED','UNKNOWN_SOURCE','INVALID_REQUEST','SOURCE_SCOPE_MISMATCH','SOURCE_NOT_ADMITTED','SOURCE_ADMISSION_EXPIRED','SOURCE_CLOCK_INVALID','SOURCE_BUSY','SOURCE_RATE_LIMITED','SOURCE_RATE_LIMIT_UNVERIFIED','SOURCE_TIMEOUT','SOURCE_TRANSPORT_FAILED','SOURCE_HTTP_REJECTED','SOURCE_ORIGIN_REJECTED','SOURCE_BODY_LIMIT','SOURCE_CONTENT_TYPE_REJECTED','SOURCE_UTF8_REJECTED','SOURCE_ENCODING_REJECTED','SOURCE_SCHEMA_REJECTED']);
const safeCode=(v:unknown):IntakeCode|undefined=>typeof v==='string'&&INTAKE_CODES.has(v as IntakeCode)?v as IntakeCode:undefined;

/** Candidate discovery supplies no semantics. Every discovered group/date is
 * subsequently accepted or rejected by the existing strict source normalizer. */
export function discoverPublicSourceGroups(profile:SourceProfile,raw:string):string[]{
 let ids:string[]=[];
 if(profile.parser==='yasno'){
  const value:unknown=JSON.parse(raw);if(!record(value))return fail('SOURCE_CATALOG_REJECTED');
  ids=Object.keys(value).filter(k=>/^\d+\.\d+$/.test(k));
 }else if(profile.parser==='hour_matrix'){
  const value:unknown=JSON.parse(raw);
  if(!record(value)||!record(value.fact)||!record(value.fact.data))return fail('SOURCE_CATALOG_REJECTED');
  for(const day of Object.values(value.fact.data))if(record(day))ids.push(...Object.keys(day).filter(k=>/^GPV[1-6]\.[12]$/.test(k)));
 }else if(profile.parser==='odesa_plan_api')return fail('SOURCE_CATALOG_REJECTED');
 else{
  const $=parseXml(raw,{xml:true});
  $('item description').each((_i,node)=>{
   const body=parseXml($(node).text());body('script,style').remove();body('br').replaceWith('\n');body('p,div').append('\n');
   for(const match of body.root().text().matchAll(/(?:^|\n)\s*([1-6]\.[12])\s+\d{2}:\d{2}/g))ids.push(match[1]);
  });
 }
 ids=[...new Set(ids)].sort();
 if(!ids.length||ids.length>256)return fail('SOURCE_CATALOG_REJECTED');
 return ids;
}

/** Only public technical data. No owners, user locations, account inference,
 * default HTTP, environment, background loop, provider delivery or import IO. */
export interface SourceIngestionOptions {enabled?:boolean;odesaPlanApiEnabled?:boolean;expectedControlEpoch:number;pool:LegacyProfileReadPool;
 transport:SourceHttpTransport;now:()=>number;timeoutMs?:number}
export const createSourceIngestion=(options:SourceIngestionOptions)=>createSourceService(options,createOdesaPlanSource(),false);
/** Untrusted local proof seam. Persisted fixture snapshots never pass the native reader. */
export const createSourceIngestionForFixtures=(options:SourceIngestionOptions,planSource:ReturnType<typeof createOdesaPlanSource>)=>createSourceService(options,planSource,true);
function createSourceService(options:SourceIngestionOptions,planSource:ReturnType<typeof createOdesaPlanSource>,fixtureMode:boolean){
 if(!options.pool||typeof options.pool.connect!=='function'||typeof options.transport!=='function'||typeof options.now!=='function'||
  options.odesaPlanApiEnabled!==undefined&&typeof options.odesaPlanApiEnabled!=='boolean'||!Number.isSafeInteger(options.expectedControlEpoch)||options.expectedControlEpoch<1||options.enabled!==undefined&&typeof options.enabled!=='boolean')throw Error('INVALID_SOURCE_SERVICE_OPTIONS');
 options={...options};
 const reservations=createPublicSourceReservationGuard({pool:options.pool,expectedControlEpoch:options.expectedControlEpoch});
 const registry=technicalDisplaySourceRegistry(true),planAdmission=odesaPlanApiOperatingRecord(options.odesaPlanApiEnabled===true);
 const allowed=[...registry.filter(e=>e.state!=='blocked'),...(planAdmission?[planAdmission]:[])],profiles=SOURCE_PROFILES.filter(p=>allowed.some(e=>e.sourceId===p.sourceId));
 const entry=(id:string)=>allowed.find(e=>e.sourceId===id)!;
 const origin=(p:SourceProfile)=>new URL(p.endpoint).origin;
 const interval=(p:SourceProfile)=>Math.max(...profiles.filter(x=>origin(x)===origin(p)).map(x=>entry(x.sourceId).rate.minIntervalMs));
 // Validate intake options even when the service is disabled. It remains inert.
 const freshIntake=(transport:SourceHttpTransport=options.transport)=>createSourceIntake({registry,transport,now:clock,limits:{maxConcurrent:1,timeoutMs:options.timeoutMs??8000}});
 let lastClock=-Infinity;
 function clock(){const n=options.now();if(!int(n)||n<lastClock)return fail('SOURCE_CLOCK_INVALID');lastClock=n;return n;}
 freshIntake();
 async function control(c:LegacyProfileReadQuery,lock:boolean){
  const rows=(await c.query('select control_epoch,writer_mode from lba_production_control where id=true'+(lock?' for share':''))).rows;
  if(rows.length!==1||rows[0].writer_mode!=='canonical')return fail('SOURCE_CONTROL_REJECTED');
  const epoch=rows[0].control_epoch;
  if(!(typeof epoch==='number'&&Number.isSafeInteger(epoch)||typeof epoch==='string'&&/^[1-9]\d{0,15}$/.test(epoch))||Number(epoch)!==options.expectedControlEpoch)return fail('SOURCE_EPOCH_CONFLICT');
 }
 function admitted(p:SourceProfile,time:number){const a=entry(p.sourceId);return p.sourceId===ODESA_PLAN_API_SOURCE?Boolean(planAdmission&&validOdesaPlanOperatingRecord(planAdmission,new Date(time).toISOString())):time>=Date.parse(a.reviewedAt)&&time<Date.parse(a.validUntil);}
 const request=(p:SourceProfile,targetId:string,serviceDate:string)=>({sourceId:p.sourceId,operatorId:p.operatorId,namespace:p.namespace,targetId,serviceDate});
 const unavailable=(error:unknown,sourceId?:string):SourceRefreshResult=>({state:'unavailable',code:error instanceof SourceServiceFailure?error.code:'SOURCE_STORAGE_UNAVAILABLE',...(sourceId?{sourceId}:{})});

 function reservationRejected(result:SourceReservationFailure,sourceId?:string):SourceRefreshResult{
  const code:SourceServiceCode=result.code==='RESERVATION_CONTROL_REJECTED'?'SOURCE_CONTROL_REJECTED':result.code==='RESERVATION_EPOCH_CONFLICT'?'SOURCE_EPOCH_CONFLICT':
   result.code==='RESERVATION_WORKER_HELD'?'SOURCE_WORKER_HELD':result.code==='RESERVATION_ORIGIN_HELD'?'SOURCE_ORIGIN_HELD':
   result.code==='RESERVATION_LOCAL_BUDGET_DEFERRED'?'SOURCE_LOCAL_BUDGET_DEFERRED':
   ['RESERVATION_COMMIT_UNKNOWN','RESERVATION_TOKEN_CONFLICT','RESERVATION_CLOSED','RESERVATION_DEADLINE','RESERVATION_ABORTED'].includes(result.code)?'SOURCE_PUBLICATION_UNKNOWN':'SOURCE_STORAGE_UNAVAILABLE';
  return {state:['SOURCE_WORKER_HELD','SOURCE_ORIGIN_HELD','SOURCE_LOCAL_BUDGET_DEFERRED'].includes(code)?'deferred':'unavailable',code,...(sourceId?{sourceId}:{})};
 }
 async function refreshOnce(sourceId?:string):Promise<SourceRefreshResult>{
  if(options.enabled!==true)return {state:'disabled',code:'SOURCE_SERVICE_DISABLED'};
  if(sourceId!==undefined&&(typeof sourceId!=='string'||!profiles.some(p=>p.sourceId===sourceId)))return {state:'blocked',code:'SOURCE_NOT_ADMITTED'};
  let p:SourceProfile|undefined;
  try{
   const time=clock(),c=await options.pool.connect();let tx=false;
   try{
    await c.query('begin isolation level repeatable read read only');tx=true;await control(c,false);
    const states=(await c.query('select source_id,last_attempt_at from lba_public_source_state')).rows;
    const origins=(await c.query('select origin,next_attempt_at,uncertain,hold_reason from lba_public_source_origin')).rows;
    if(states.some(s=>typeof s.source_id!=='string'||!Number.isFinite(new Date(s.last_attempt_at).getTime()))||
     origins.some(o=>typeof o.origin!=='string'||typeof o.uncertain!=='boolean'||!Number.isFinite(new Date(o.next_attempt_at).getTime())||o.hold_reason!==null&&typeof o.hold_reason!=='string'))return fail('SOURCE_STORAGE_UNAVAILABLE');
    const due=profiles.filter(x=>sourceId===undefined||x.sourceId===sourceId).filter(x=>admitted(x,time)).sort((a,b)=>{
     const stamp=(id:string)=>{const r=states.find(s=>s.source_id===id);return r?new Date(r.last_attempt_at).getTime():0;};return stamp(a.sourceId)-stamp(b.sourceId)||a.sourceId.localeCompare(b.sourceId);
    });
    if(!due.length)return fail('SOURCE_ADMISSION_EXPIRED');
    let deferred:SourceServiceCode='SOURCE_NOT_DUE';
    p=due.find(x=>{
     const o=origins.find(r=>r.origin===origin(x));
     if(o?.uncertain===true||o?.hold_reason){deferred='SOURCE_ORIGIN_HELD';return false;}
     if(o&&new Date(o.next_attempt_at).getTime()>time){deferred='SOURCE_LOCAL_BUDGET_DEFERRED';return false;}
     const s=states.find(r=>r.source_id===x.sourceId);return !s||time-new Date(s.last_attempt_at).getTime()>=entry(x.sourceId).cacheTtlMs;
    });
    await c.query('commit');tx=false;
    if(!p)return {state:'deferred',code:deferred,...(sourceId?{sourceId}:{})};
   }finally{if(tx)await c.query('rollback').catch(()=>{});c.release();}
   const chosen=p,abort=new AbortController();let runId='',reserveFailure:SourceServiceCode|undefined;
   const reserved=await reservations.reserve({origin:origin(chosen),expectedMaxHops:chosen.sourceId===ODESA_PLAN_API_SOURCE?2:1,minIntervalMs:interval(chosen),...(chosen.sourceId===ODESA_PLAN_API_SOURCE?{strictEightPerMinute:true}:{}),deadlineMs:30000,signal:abort.signal,
    persist:async(q,receipt)=>{
     // Recheck source cadence after acquiring the shared worker/origin rows.
     // No session identity, advisory lock, provider IO or user wait in this TX.
     if(!admitted(chosen,clock())){reserveFailure='SOURCE_ADMISSION_EXPIRED';throw Error(reserveFailure);}
     const rows=(await q.query('select last_attempt_at from lba_public_source_state where source_id=$1 for update',[chosen.sourceId])).rows;
     if(rows.length>1||rows[0]&&!Number.isFinite(new Date(rows[0].last_attempt_at).getTime())){reserveFailure='SOURCE_STORAGE_UNAVAILABLE';throw Error(reserveFailure);}
     if(rows[0]&&Date.parse(receipt.reservedAt)-new Date(rows[0].last_attempt_at).getTime()<entry(chosen.sourceId).cacheTtlMs){reserveFailure='SOURCE_NOT_DUE';throw Error(reserveFailure);}
     runId=receipt.reservationToken;
     await q.query(`insert into lba_public_source_state(source_id,last_attempt_at) values($1,$2) on conflict(source_id) do update set last_attempt_at=excluded.last_attempt_at`,[chosen.sourceId,receipt.reservedAt]);
     await q.query(`insert into lba_public_source_run(id,source_id,control_epoch,started_at,status) values($1,$2,$3,$4,'started')`,[runId,chosen.sourceId,options.expectedControlEpoch,receipt.reservedAt]);
    }});
   if(reserved.state!=='reserved')return reserveFailure?{state:reserveFailure==='SOURCE_NOT_DUE'?'deferred':'unavailable',code:reserveFailure,sourceId:chosen.sourceId}:reservationRejected(reserved,chosen.sourceId);
   if(chosen.sourceId===ODESA_PLAN_API_SOURCE)return refreshOdesaPlan(chosen,reserved.reservation,abort,runId);
   let status:number|undefined,retry:string|undefined;
   const intake=freshIntake(async req=>{
    const permission=await reserved.reservation.beforeHop({origin:origin(chosen)},abort.signal);
    if(permission.state!=='granted')throw Error('SOURCE_DURABLE_PERMISSION_DENIED');
    const response=await options.transport(req);status=response.status;retry=Object.entries(response.headers).find(([k])=>k.toLowerCase()==='retry-after')?.[1];return response;
   });
   const today=localParts(clock()).date,tomorrow=nextCalendarDate(today),seed=chosen.parser==='hour_matrix'?'GPV1.1':'1.1';
   const bootstrap=await intake.load(request(chosen,seed,today)),capture=intake.snapshotRaw(chosen.sourceId);
   const finished=clock(),valid:Available[]=[];let failure:IntakeCode|undefined=bootstrap.state==='available'?undefined:bootstrap.code;
   if(capture){
    try{for(const target of discoverPublicSourceGroups(chosen,capture.raw))for(const date of [today,tomorrow]){
     const result=intake.projectSnapshot(request(chosen,target,date),capture);
     if(result.state==='available')valid.push(result);else failure=result.code;
    }}catch{failure='SOURCE_SCHEMA_REJECTED';}
   }
   const published=valid.length>0&&capture!==null;
   const retryMs=typeof retry==='string'&&/^[1-9]\d{0,4}$/.test(retry)&&Number(retry)<=86400?Number(retry)*1000:null;
   const hold=status===403||status===429&&retryMs===null||failure==='SOURCE_ORIGIN_REJECTED';
   const committed=await reserved.reservation.finalize({
    ...(failure==='SOURCE_TIMEOUT'?{hold:'worker-and-origin' as const}:hold?{hold:'origin' as const}:{}),
    ...(status===429&&retryMs!==null?{retryAfterMs:retryMs}:{}),
    persist:async q=>{
     if(published){
      const rawId=randomUUID();
      await q.query('insert into lba_public_source_raw(id,run_id,source_id,observed_at,snapshot) values($1,$2,$3,$4,$5::jsonb)',[rawId,runId,chosen.sourceId,capture.observedAt,JSON.stringify(capture)]);
      for(const v of valid)await q.query(`insert into lba_public_source_plan(source_id,target_id,service_date,raw_id) values($1,$2,$3,$4)
       on conflict(source_id,target_id,service_date) do update set raw_id=excluded.raw_id`,[chosen.sourceId,v.view.targetId,v.view.serviceDate,rawId]);
      await q.query('update lba_public_source_state set last_success_at=$2,last_failure=$3 where source_id=$1',[chosen.sourceId,capture.observedAt,failure??null]);
      await q.query('delete from lba_public_source_plan where source_id=$1 and service_date<$2::date',[chosen.sourceId,today]);
      await q.query('delete from lba_public_source_raw r where r.source_id=$1 and not exists(select 1 from lba_public_source_plan p where p.raw_id=r.id)',[chosen.sourceId]);
     }else await q.query('update lba_public_source_state set last_failure=$2 where source_id=$1',[chosen.sourceId,failure??'SOURCE_SCHEMA_REJECTED']);
     await q.query('update lba_public_source_run set finished_at=$2,status=$3,code=$4 where id=$1',[runId,new Date(finished).toISOString(),published?'published':'rejected',failure??null]);
    }});
   if(committed.state!=='finalized')return reservationRejected(committed,chosen.sourceId);
   if(!published)return {state:'unavailable',sourceId:chosen.sourceId,code:failure??'SOURCE_SCHEMA_REJECTED'};
   return {state:'published',sourceId:chosen.sourceId,validatedViews:valid.length,validatedGroups:new Set(valid.map(v=>v.view.targetId)).size,partial:failure!==undefined,
    observedAt:capture.observedAt,addressBindingVerified:false,deliveryEligible:false};
  }catch(error){return unavailable(error,p?.sourceId);}
 }

 async function refreshOdesaPlan(chosen:SourceProfile,reservation:Extract<Awaited<ReturnType<typeof reservations.reserve>>,{state:'reserved'}>['reservation'],abort:AbortController,runId:string):Promise<SourceRefreshResult>{
  if(!planAdmission)return {state:'blocked',sourceId:chosen.sourceId,code:'SOURCE_NOT_ADMITTED'};
  let capture:OdesaPlanSnapshot|null=null,valid:Available[]=[],failure:IntakeCode|undefined,hold:'origin'|'worker-and-origin'|undefined;
  const today=localParts(clock()).date;
  try{
   capture=await planSource.acquire({cursor:odesaCompletePlanCursor(new Date(clock()).toISOString()),signal:abort.signal,reservationToken:runId,controlEpoch:options.expectedControlEpoch,admission:planAdmission,now:()=>new Date(clock()).toISOString(),beforeHop:async(_descriptor,signal)=>{
    const permission=await reservation.beforeHop({origin:origin(chosen)},signal);if(permission.state!=='granted')throw Error('SOURCE_DURABLE_PERMISSION_DENIED');
   }});
   if(capture.reservationToken!==runId||capture.controlEpoch!==options.expectedControlEpoch||capture.mode!==(fixtureMode?'fixture_unverified':'standard_fetch_https'))throw Error('SOURCE_SCOPE_MISMATCH');
   const {dataset}=readOdesaPlanSnapshot(capture,planAdmission,new Date(clock()).toISOString(),fixtureMode);
   if(dataset.state!=='available')failure='SOURCE_UPDATE_UNCONFIRMED';
   else{
    for(const target of dataset.groupIds)for(const date of dataset.dates){
     const projected=projectOdesaPlanSnapshot(request(chosen,target,date),capture,planAdmission,new Date(clock()).toISOString(),{},fixtureMode);
     if(projected.state!=='available')throw Error('SOURCE_SCHEMA_REJECTED');valid.push(projected);
    }
    if(valid.length!==dataset.groupIds.length*dataset.dates.length)throw Error('SOURCE_SCHEMA_REJECTED');
   }
  }catch(error){
   valid=[];const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
   failure=code==='ODESA_TRANSPORT_SOURCE_ACCESS_STOP'?'SOURCE_ORIGIN_REJECTED':/TIMEOUT|CANCEL|CLOSED|BUDGET_HOOK|DEADLINE/.test(code)?'SOURCE_TIMEOUT':code.startsWith('ODESA_PLAN_API_')?'SOURCE_SCHEMA_REJECTED':'SOURCE_TRANSPORT_FAILED';
   hold=failure==='SOURCE_ORIGIN_REJECTED'?'origin':failure==='SOURCE_SCHEMA_REJECTED'?undefined:'worker-and-origin';
  }
  const published=valid.length>0&&capture!==null,finished=new Date(clock()).toISOString();
  const committed=await reservation.finalize({...(hold?{hold}:{}),persist:async q=>{
   if(published&&capture){
    // This authoritative complete payload replaces every dated pointer for the
    // source. A missing tomorrow must not retain yesterday's fabricated future.
    await q.query('delete from lba_public_source_plan where source_id=$1',[chosen.sourceId]);
    await q.query('delete from lba_public_source_raw r where r.source_id=$1 and not exists(select 1 from lba_public_source_plan p where p.raw_id=r.id)',[chosen.sourceId]);
    const encoded=JSON.stringify(capture),usage=(await q.query('select count(*)::int as count,coalesce(sum(octet_length(snapshot::text)),0)::text as bytes from lba_public_source_raw')).rows;
    const size=(await q.query('select octet_length($1::jsonb::text)::int as bytes',[encoded])).rows;
    if(usage.length!==1||size.length!==1||!/^\d+$/.test(String(usage[0].count))||!/^\d+$/.test(String(usage[0].bytes))||!/^\d+$/.test(String(size[0].bytes))||Number(usage[0].count)>=2048||Number(usage[0].bytes)+Number(size[0].bytes)>67108864)throw Error('SOURCE_RAW_CAPACITY');
    const rawId=randomUUID();await q.query('insert into lba_public_source_raw(id,run_id,source_id,observed_at,snapshot) values($1,$2,$3,$4,$5::jsonb)',[rawId,runId,chosen.sourceId,capture.observedAt,encoded]);
    for(const v of valid)await q.query('insert into lba_public_source_plan(source_id,target_id,service_date,raw_id) values($1,$2,$3,$4)',[chosen.sourceId,v.view.targetId,v.view.serviceDate,rawId]);
    await q.query('update lba_public_source_state set last_success_at=$2,last_failure=null where source_id=$1',[chosen.sourceId,capture.observedAt]);
   }else await q.query('update lba_public_source_state set last_failure=$2 where source_id=$1',[chosen.sourceId,failure??'SOURCE_UPDATE_UNCONFIRMED']);
   await q.query('update lba_public_source_run set finished_at=$2,status=$3,code=$4 where id=$1',[runId,finished,published?'published':'rejected',failure??null]);
   await q.query("delete from lba_public_source_run r where source_id=$1 and status<>'started' and started_at<$2::date and not exists(select 1 from lba_public_source_raw p where p.run_id=r.id)",[chosen.sourceId,today]);
  }});
  if(committed.state!=='finalized')return reservationRejected(committed,chosen.sourceId);
  if(!published||!capture)return {state:'unavailable',sourceId:chosen.sourceId,code:failure??'SOURCE_UPDATE_UNCONFIRMED'};
  return {state:'published',sourceId:chosen.sourceId,validatedViews:valid.length,validatedGroups:new Set(valid.map(v=>v.view.targetId)).size,partial:false,observedAt:capture.observedAt,addressBindingVerified:false,deliveryEligible:false};
 }

 async function readTechnicalPlans():Promise<PublicTechnicalPlans>{
  const empty={plans:[] as Available[],observations:[] as PublicTechnicalPlans['observations'],addressBindingVerified:false as const,deliveryEligible:false as const,parallel48hAccepted:false as const};
  if(options.enabled!==true)return {state:'disabled',code:'SOURCE_SERVICE_DISABLED',...empty};
  let c:LegacyProfileReadClient|undefined,tx=false;
  try{
   const time=clock();c=await options.pool.connect();await c.query('begin isolation level repeatable read read only');tx=true;await control(c,false);
   const rows=(await c.query(`select p.source_id,p.target_id,p.service_date::text,r.snapshot,r.id as raw_id,r.source_id as raw_source_id,r.run_id,r.observed_at as raw_observed_at,g.source_id as run_source_id,g.control_epoch as run_control_epoch,g.status as run_status,g.started_at as run_started_at,g.finished_at as run_finished_at from lba_public_source_plan p join lba_public_source_raw r on r.id=p.raw_id join lba_public_source_run g on g.id=r.run_id order by p.source_id,p.target_id,p.service_date limit 2049`)).rows;
   if(rows.length>2048)return fail('SOURCE_CATALOG_REJECTED');
   const states=(await c.query('select source_id,last_attempt_at,last_success_at,last_failure from lba_public_source_state')).rows;
   const plans:Available[]=[],observations:PublicTechnicalPlans['observations']=[],intake=freshIntake(),today=localParts(time).date;
   for(const p of profiles){
    const s=states.find(r=>r.source_id===p.sourceId),good=admitted(p,time),failure=safeCode(s?.last_failure);
    const stamp=(v:unknown)=>v===null||v===undefined?NaN:new Date(v as any).getTime();
    const invalidApiState=p.sourceId===ODESA_PLAN_API_SOURCE&&(!s||!Number.isFinite(stamp(s.last_attempt_at))||!Number.isFinite(stamp(s.last_success_at))||stamp(s.last_attempt_at)>time||stamp(s.last_success_at)>time||s.last_failure!==null&&!failure);
    const apiGroups=new Map<string,Map<string,SourceIntakeResult>>();
    for(const row of rows.filter(r=>r.source_id===p.sourceId)){
     // Old dated plans remain technical history, never current-day schedules.
     if(![today,nextCalendarDate(today)].includes(row.service_date))continue;
     const snapshot=row.snapshot as CapturedPublicSourceRaw|OdesaPlanSnapshot;
     const failedAfterObservation=Boolean(failure)&&snapshot&&Date.parse(snapshot.observedAt)<new Date(s.last_attempt_at).getTime();
     const stale=Boolean(failedAfterObservation)||!snapshot||time-Date.parse(snapshot.observedAt)>entry(p.sourceId).cacheTtlMs||p.sourceId===ODESA_PLAN_API_SOURCE&&new Date(s?.last_success_at).getTime()>Date.parse(snapshot?.observedAt);
     const flags={stale,...(failure&&failedAfterObservation?{refreshFailure:failure}:{})};
     let result:SourceIntakeResult|undefined;
     if(p.sourceId===ODESA_PLAN_API_SOURCE&&planAdmission){
      // One immutable SQL raw row per transaction-local batch. PostgreSQL's RR
      // snapshot and raw_id, rather than a caller-selected hash cache key, bind
      // all joined pointers to exactly these bytes. No cross-request cache.
      if(invalidApiState||typeof row.raw_id!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(row.raw_id)||row.raw_source_id!==p.sourceId)continue;
      const api=snapshot as OdesaPlanSnapshot,observed=stamp(api?.observedAt),started=stamp(row.run_started_at),finished=stamp(row.run_finished_at);
      const epochMatches=(v:unknown)=>Boolean((typeof v==='number'&&Number.isSafeInteger(v)||typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v))&&Number(v)===options.expectedControlEpoch);
      if(!api||api.controlEpoch!==options.expectedControlEpoch||api.reservationToken!==row.run_id||row.run_source_id!==p.sourceId||row.run_status!=='published'||!epochMatches(row.run_control_epoch)||
       !Number.isFinite(observed)||stamp(row.raw_observed_at)!==observed||!Number.isFinite(started)||!Number.isFinite(finished)||started>observed||observed>finished||finished>time||stamp(s.last_success_at)<observed||stamp(s.last_attempt_at)<started)continue;
      let batch=apiGroups.get(row.raw_id);
      if(!batch){
       const siblings=rows.filter(r=>r.source_id===p.sourceId&&r.raw_id===row.raw_id&&r.raw_source_id===p.sourceId&&[today,nextCalendarDate(today)].includes(r.service_date));
       const requests=siblings.map(r=>request(p,r.target_id,r.service_date)),results=projectOdesaPlanSnapshotBatch(requests,snapshot,planAdmission,new Date(time).toISOString(),flags,fixtureMode);
       batch=new Map(siblings.map((r,i)=>[JSON.stringify([r.target_id,r.service_date]),results[i]]).filter((v):v is [string,SourceIntakeResult]=>v[1]!==undefined));apiGroups.set(row.raw_id,batch);
      }
      result=batch.get(JSON.stringify([row.target_id,row.service_date]));
     }else result=intake.projectSnapshot(request(p,row.target_id,row.service_date),snapshot as CapturedPublicSourceRaw,flags);
     if(result?.state==='available')plans.push(result);
    }
    const instant=(v:unknown)=>v instanceof Date&&!Number.isNaN(v.getTime())?v.toISOString():typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
    observations.push({sourceId:p.sourceId,state:good?plans.some(v=>v.provenance.sourceId===p.sourceId)?'cached':'unavailable':'blocked',
     ...(!good?{code:'SOURCE_ADMISSION_EXPIRED' as const}:invalidApiState?{code:'SOURCE_STORAGE_UNAVAILABLE' as const}:failure?{code:failure}:{}),lastAttemptAt:instant(s?.last_attempt_at),lastSuccessAt:instant(s?.last_success_at)});
   }
   for(const p of SOURCE_PROFILES.filter(p=>!profiles.some(x=>x.sourceId===p.sourceId)))observations.push({sourceId:p.sourceId,state:'blocked',code:'SOURCE_NOT_ADMITTED',lastAttemptAt:null,lastSuccessAt:null});
   await c.query('commit');tx=false;return {state:'available',...empty,plans,observations};
  }catch(error){return {state:'unavailable',...empty,code:error instanceof SourceServiceFailure?error.code:'SOURCE_STORAGE_UNAVAILABLE'};}
  finally{if(c){if(tx)await c.query('rollback').catch(()=>{});c.release();}}
 }
 async function readCatalog():Promise<PublicTechnicalCatalog>{
  const result=await readTechnicalPlans(),groups:PublicTechnicalCatalog['groups']=[];
  for(const plan of result.plans){const v=plan.view,p=SOURCE_PROFILES.find(p=>p.sourceId===plan.provenance.sourceId)!;
   if(typeof v.targetId!=='string')continue;
   let group=groups.find(g=>g.sourceId===p.sourceId&&g.targetId===v.targetId);
   if(!group){group={sourceId:p.sourceId,region:p.region,operatorId:p.operatorId,namespace:p.namespace,targetId:v.targetId,dates:[]};groups.push(group);}
   group.dates.push({serviceDate:v.serviceDate,status:v.status,freshness:v.freshness});
  }
  return {state:result.state,...(result.code?{code:result.code}:{}),groups,addressBindingVerified:false,deliveryEligible:false};
 }
 return Object.freeze({refreshOnce,readTechnicalPlans,readCatalog});
}
