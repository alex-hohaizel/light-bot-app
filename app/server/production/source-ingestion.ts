import {randomUUID} from 'node:crypto';
import {load as parseXml} from 'cheerio';
import {localParts,nextCalendarDate} from '../../shared/schedule-core.ts';
import {createSourceIntake,SOURCE_PROFILES,type CapturedPublicSourceRaw,type SourceHttpTransport,type SourceIntakeResult,type IntakeCode,type SourceProfile} from './source-intake.ts';
import {technicalDisplaySourceRegistry} from './source-operating-policy.ts';
import type {LegacyProfileReadPool,LegacyProfileReadClient} from './profile-reader.ts';

/** Explicit additive public-only cache. Never auto-applied, seeded or started. */
export const SOURCE_INGESTION_SCHEMA_SQL = `
create table if not exists lba_public_source_worker (
 id boolean primary key check(id),uncertain boolean not null,hold_reason text
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
const INTAKE_CODES=new Set<IntakeCode>(['UNKNOWN_SOURCE','INVALID_REQUEST','SOURCE_SCOPE_MISMATCH','SOURCE_NOT_ADMITTED','SOURCE_ADMISSION_EXPIRED','SOURCE_CLOCK_INVALID','SOURCE_BUSY','SOURCE_RATE_LIMITED','SOURCE_RATE_LIMIT_UNVERIFIED','SOURCE_TIMEOUT','SOURCE_TRANSPORT_FAILED','SOURCE_HTTP_REJECTED','SOURCE_ORIGIN_REJECTED','SOURCE_BODY_LIMIT','SOURCE_CONTENT_TYPE_REJECTED','SOURCE_UTF8_REJECTED','SOURCE_ENCODING_REJECTED','SOURCE_SCHEMA_REJECTED']);
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
 }else{
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
export function createSourceIngestion(options:{enabled?:boolean;expectedControlEpoch:number;pool:LegacyProfileReadPool;
 transport:SourceHttpTransport;now:()=>number;timeoutMs?:number}){
 if(!options.pool||typeof options.pool.connect!=='function'||typeof options.transport!=='function'||typeof options.now!=='function'||
  !Number.isSafeInteger(options.expectedControlEpoch)||options.expectedControlEpoch<1||options.enabled!==undefined&&typeof options.enabled!=='boolean')throw Error('INVALID_SOURCE_SERVICE_OPTIONS');
 options={...options};
 const registry=technicalDisplaySourceRegistry(true),allowed=registry.filter(e=>e.state!=='blocked'),profiles=SOURCE_PROFILES.filter(p=>allowed.some(e=>e.sourceId===p.sourceId));
 const entry=(id:string)=>allowed.find(e=>e.sourceId===id)!;
 const origin=(p:SourceProfile)=>new URL(p.endpoint).origin;
 const interval=(p:SourceProfile)=>Math.max(...profiles.filter(x=>origin(x)===origin(p)).map(x=>entry(x.sourceId).rate.minIntervalMs));
 // Validate intake options even when the service is disabled. It remains inert.
 const freshIntake=(transport:SourceHttpTransport=options.transport)=>createSourceIntake({registry,transport,now:clock,limits:{maxConcurrent:1,timeoutMs:options.timeoutMs??8000}});
 let lastClock=-Infinity;
 function clock(){const n=options.now();if(!int(n)||n<lastClock)return fail('SOURCE_CLOCK_INVALID');lastClock=n;return n;}
 freshIntake();
 async function control(c:LegacyProfileReadClient,lock:boolean){
  const rows=(await c.query('select control_epoch,writer_mode from lba_production_control where id=true'+(lock?' for share':''))).rows;
  if(rows.length!==1||rows[0].writer_mode!=='canonical')return fail('SOURCE_CONTROL_REJECTED');
  const epoch=rows[0].control_epoch;
  if(!(typeof epoch==='number'&&Number.isSafeInteger(epoch)||typeof epoch==='string'&&/^[1-9]\d{0,15}$/.test(epoch))||Number(epoch)!==options.expectedControlEpoch)return fail('SOURCE_EPOCH_CONFLICT');
 }
 function admitted(p:SourceProfile,time:number){const a=entry(p.sourceId);return time>=Date.parse(a.reviewedAt)&&time<Date.parse(a.validUntil);}
 const request=(p:SourceProfile,targetId:string,serviceDate:string)=>({sourceId:p.sourceId,operatorId:p.operatorId,namespace:p.namespace,targetId,serviceDate});
 const unavailable=(error:unknown,sourceId?:string):SourceRefreshResult=>({state:'unavailable',code:error instanceof SourceServiceFailure?error.code:'SOURCE_STORAGE_UNAVAILABLE',...(sourceId?{sourceId}:{})});

 async function refreshOnce(sourceId?:string):Promise<SourceRefreshResult>{
  if(options.enabled!==true)return {state:'disabled',code:'SOURCE_SERVICE_DISABLED'};
  if(sourceId!==undefined&&(typeof sourceId!=='string'||!profiles.some(p=>p.sourceId===sourceId)))return {state:'blocked',code:'SOURCE_NOT_ADMITTED'};
  let c:LegacyProfileReadClient|undefined,locked=false,tx=false,p:SourceProfile|undefined;
  try{
   const time=clock();c=await options.pool.connect();
   const lock=(await c.query("select pg_try_advisory_lock(hashtextextended('lba-public-source-worker',0)) as locked")).rows[0];
   if(lock?.locked!==true)return {state:'deferred',code:'SOURCE_WORKER_BUSY'};locked=true;
   await c.query('begin isolation level read committed');tx=true;await control(c,true);
   const worker=(await c.query('select uncertain from lba_public_source_worker where id=true')).rows[0];
   if(worker&&typeof worker.uncertain!=='boolean')return fail('SOURCE_STORAGE_UNAVAILABLE');
   if(worker?.uncertain===true){await c.query('commit');tx=false;return {state:'deferred',code:'SOURCE_WORKER_HELD'};}
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
    const s=states.find(r=>r.source_id===x.sourceId);
    if(s&&time-new Date(s.last_attempt_at).getTime()<entry(x.sourceId).cacheTtlMs)return false;
    return true;
   });
   if(!p){await c.query('commit');tx=false;return {state:'deferred',code:deferred,...(sourceId?{sourceId}:{})};}
   const chosen=p,startedAt=new Date(time).toISOString(),runId=randomUUID();
   // Reserve BEFORE HTTP. A crash/unknown commit leaves uncertain=true and cannot
   // create another request until explicit operational reconciliation.
   await c.query('insert into lba_public_source_worker(id,uncertain,hold_reason) values(true,true,null) on conflict(id) do update set uncertain=true,hold_reason=null');
   await c.query(`insert into lba_public_source_origin(origin,next_attempt_at,uncertain,hold_reason) values($1,$2,true,null)
    on conflict(origin) do update set next_attempt_at=excluded.next_attempt_at,uncertain=true,hold_reason=null`,[origin(p),new Date(time+interval(p)).toISOString()]);
   await c.query(`insert into lba_public_source_state(source_id,last_attempt_at) values($1,$2) on conflict(source_id) do update set last_attempt_at=excluded.last_attempt_at`,[p.sourceId,startedAt]);
   await c.query(`insert into lba_public_source_run(id,source_id,control_epoch,started_at,status) values($1,$2,$3,$4,'started')`,[runId,p.sourceId,options.expectedControlEpoch,startedAt]);
   try{await c.query('commit');tx=false;}catch{return fail('SOURCE_PUBLICATION_UNKNOWN');}
   // No control row/owner/profile transaction is held during the bounded GET.
   let status:number|undefined,retry:string|undefined;
   const intake=freshIntake(async req=>{const response=await options.transport(req);status=response.status;retry=Object.entries(response.headers).find(([k])=>k.toLowerCase()==='retry-after')?.[1];return response;});
   const today=localParts(clock()).date,tomorrow=nextCalendarDate(today),seed=p.parser==='hour_matrix'?'GPV1.1':'1.1';
   const bootstrap=await intake.load(request(p,seed,today)),capture=intake.snapshotRaw(p.sourceId);
   const finished=clock(),valid:Available[]=[];let failure:IntakeCode|undefined=bootstrap.state==='available'?undefined:bootstrap.code;
   if(capture){
    try{for(const target of discoverPublicSourceGroups(p,capture.raw))for(const date of [today,tomorrow]){
     const result=intake.projectSnapshot(request(p,target,date),capture);
     if(result.state==='available')valid.push(result);else failure=result.code;
    }}catch{failure='SOURCE_SCHEMA_REJECTED';}
   }
   // A day with no item is unavailable, never fabricated as future power-on.
   const published=valid.length>0&&capture!==null;
   await c.query('begin isolation level read committed');tx=true;await control(c,true);
   const row=(await c.query('select uncertain from lba_public_source_origin where origin=$1 for update',[origin(chosen)])).rows[0];
   if(row?.uncertain!==true)return fail('SOURCE_PUBLICATION_UNKNOWN');
   const retryMs=typeof retry==='string'&&/^[1-9]\d{0,4}$/.test(retry)&&Number(retry)<=86400?Number(retry)*1000:null;
   const hold=status===403?'SOURCE_HTTP_REJECTED':status===429&&retryMs===null?'SOURCE_RATE_LIMIT_UNVERIFIED':failure==='SOURCE_TIMEOUT'?'SOURCE_TIMEOUT':failure==='SOURCE_ORIGIN_REJECTED'?'SOURCE_ORIGIN_REJECTED':null;
   await c.query('update lba_public_source_origin set uncertain=$2,hold_reason=$3,next_attempt_at=greatest(next_attempt_at,$4::timestamptz) where origin=$1',
    [origin(chosen),hold!==null,hold,new Date(finished+(status===429&&retryMs!==null?retryMs:0)).toISOString()]);
   await c.query('update lba_public_source_worker set uncertain=$1,hold_reason=$2 where id=true',[failure==='SOURCE_TIMEOUT',failure==='SOURCE_TIMEOUT'?'SOURCE_TIMEOUT':null]);
   if(published){
    const rawId=randomUUID();
    await c.query('insert into lba_public_source_raw(id,run_id,source_id,observed_at,snapshot) values($1,$2,$3,$4,$5::jsonb)',[rawId,runId,chosen.sourceId,capture.observedAt,JSON.stringify(capture)]);
    for(const v of valid)await c.query(`insert into lba_public_source_plan(source_id,target_id,service_date,raw_id) values($1,$2,$3,$4)
     on conflict(source_id,target_id,service_date) do update set raw_id=excluded.raw_id`,[chosen.sourceId,v.view.targetId,v.view.serviceDate,rawId]);
    await c.query('update lba_public_source_state set last_success_at=$2,last_failure=$3 where source_id=$1',[chosen.sourceId,capture.observedAt,failure??null]);
    // Bounded retained plan horizon; no private/legacy table is involved.
    await c.query('delete from lba_public_source_plan where source_id=$1 and service_date<$2::date',[chosen.sourceId,today]);
    await c.query('delete from lba_public_source_raw r where r.source_id=$1 and not exists(select 1 from lba_public_source_plan p where p.raw_id=r.id)',[chosen.sourceId]);
   }else await c.query('update lba_public_source_state set last_failure=$2 where source_id=$1',[chosen.sourceId,failure??'SOURCE_SCHEMA_REJECTED']);
   await c.query('update lba_public_source_run set finished_at=$2,status=$3,code=$4 where id=$1',[runId,new Date(finished).toISOString(),published?'published':'rejected',failure??null]);
   try{await c.query('commit');tx=false;}catch{return fail('SOURCE_PUBLICATION_UNKNOWN');}
   if(!published)return {state:'unavailable',sourceId:chosen.sourceId,code:failure??'SOURCE_SCHEMA_REJECTED'};
   return {state:'published',sourceId:chosen.sourceId,validatedViews:valid.length,validatedGroups:new Set(valid.map(v=>v.view.targetId)).size,partial:failure!==undefined,
    observedAt:capture.observedAt,addressBindingVerified:false,deliveryEligible:false};
  }catch(error){return unavailable(error,p?.sourceId);}
  finally{if(c){if(tx)await c.query('rollback').catch(()=>{});if(locked)await c.query("select pg_advisory_unlock(hashtextextended('lba-public-source-worker',0))").catch(()=>{});c.release();}}
 }

 async function readTechnicalPlans():Promise<PublicTechnicalPlans>{
  const empty={plans:[] as Available[],observations:[] as PublicTechnicalPlans['observations'],addressBindingVerified:false as const,deliveryEligible:false as const,parallel48hAccepted:false as const};
  if(options.enabled!==true)return {state:'disabled',code:'SOURCE_SERVICE_DISABLED',...empty};
  let c:LegacyProfileReadClient|undefined,tx=false;
  try{
   const time=clock();c=await options.pool.connect();await c.query('begin isolation level repeatable read read only');tx=true;await control(c,false);
   const rows=(await c.query(`select p.source_id,p.target_id,p.service_date::text,r.snapshot from lba_public_source_plan p join lba_public_source_raw r on r.id=p.raw_id order by p.source_id,p.target_id,p.service_date limit 2049`)).rows;
   if(rows.length>2048)return fail('SOURCE_CATALOG_REJECTED');
   const states=(await c.query('select source_id,last_attempt_at,last_success_at,last_failure from lba_public_source_state')).rows;
   const plans:Available[]=[],observations:PublicTechnicalPlans['observations']=[],intake=freshIntake(),today=localParts(time).date;
   for(const p of profiles){
    const s=states.find(r=>r.source_id===p.sourceId),good=admitted(p,time),failure=safeCode(s?.last_failure);
    for(const row of rows.filter(r=>r.source_id===p.sourceId)){
     // Old dated plans remain technical history, never current-day schedules.
     if(![today,nextCalendarDate(today)].includes(row.service_date))continue;
     const snapshot=row.snapshot as CapturedPublicSourceRaw;
     const failedAfterObservation=Boolean(failure)&&snapshot&&Date.parse(snapshot.observedAt)<new Date(s.last_attempt_at).getTime();
     const stale=Boolean(failedAfterObservation)||!snapshot||time-Date.parse(snapshot.observedAt)>entry(p.sourceId).cacheTtlMs;
     const result=intake.projectSnapshot(request(p,row.target_id,row.service_date),snapshot,{stale,...(failure&&failedAfterObservation?{refreshFailure:failure}:{})});
     if(result.state==='available')plans.push(result);
    }
    const instant=(v:unknown)=>v instanceof Date&&!Number.isNaN(v.getTime())?v.toISOString():typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
    observations.push({sourceId:p.sourceId,state:good?plans.some(v=>v.provenance.sourceId===p.sourceId)?'cached':'unavailable':'blocked',
     ...(!good?{code:'SOURCE_ADMISSION_EXPIRED' as const}:failure?{code:failure}:{}),lastAttemptAt:instant(s?.last_attempt_at),lastSuccessAt:instant(s?.last_success_at)});
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
