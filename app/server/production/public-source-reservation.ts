import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

/** Internal query-only port. Callbacks are trusted server code: no network,
 * transaction control, session settings, user waits or work after return. */
export interface SourceReservationQuery {
 query(sql:string,values?:any[]):Promise<{rows:any[];rowCount:number|null;command?:string}>;
}
export interface SourceReservationClient extends SourceReservationQuery {release(destroy?:boolean):void}
export interface SourceReservationPool {connect():Promise<SourceReservationClient>}
export type SourceReservationCode='INVALID_RESERVATION_INPUT'|'RESERVATION_ABORTED'|'RESERVATION_DEADLINE'|
 'RESERVATION_CONTROL_REJECTED'|'RESERVATION_EPOCH_CONFLICT'|'RESERVATION_WORKER_HELD'|
 'RESERVATION_ORIGIN_HELD'|'RESERVATION_LOCAL_BUDGET_DEFERRED'|'RESERVATION_TOKEN_CONFLICT'|
 'RESERVATION_HOP_LIMIT'|'RESERVATION_CLOSED'|'RESERVATION_STORAGE_UNAVAILABLE'|
 'RESERVATION_CALLBACK_FAILED'|'RESERVATION_COMMIT_UNKNOWN';
export type SourceReservationFailure={state:'blocked'|'deferred'|'cancelled'|'unavailable'|'uncertain';
 code:SourceReservationCode;retryAt?:string};
export interface SourceReservationReceipt {
 readonly reservationToken:string;readonly origin:string;readonly controlEpoch:number;
 readonly reservedAt:string;readonly expectedMaxHops:number;readonly minIntervalMs:number;
 readonly operationDeadlineAt:string;
}
export interface SourceHopDescriptor {readonly origin:string}
export type SourceHopGrant={state:'granted';hop:number;grantedAt:string};
export interface SourceFinalizeOptions {
 /** A hold is durable and has no timeout/automatic recovery. */
 hold?:'origin'|'worker-and-origin';retryAfterMs?:number;
 persist?:(transaction:SourceReservationQuery,receipt:SourceReservationReceipt)=>Promise<void>;
}
export interface PublicSourceReservation {
 readonly receipt:SourceReservationReceipt;
 beforeHop(descriptor:SourceHopDescriptor,signal:AbortSignal):Promise<SourceHopGrant|SourceReservationFailure>;
 finalize(options?:SourceFinalizeOptions):Promise<{state:'finalized';held:boolean}|SourceReservationFailure>;
}
export type SourceReserveResult={state:'reserved';reservation:PublicSourceReservation}|SourceReservationFailure;
type ExpiredSourceReservation=Pick<SourceReservationReceipt,'reservationToken'|'origin'|'controlEpoch'|'reservedAt'|'expectedMaxHops'>&{finishedAt:string;grantedHops:number};
type SourceReconciliationResult={state:'recovered'|'unchanged'}|SourceReservationFailure;

type Marker={kind:'lba-public-source-reservation';version:1|2;token:string;epoch:number;origin:string;
 reservedAtMs:number;deadlineAtMs:number;maxHops:number;intervalMs:number;hops:number;nextHopAtMs:number};
class Denied extends Error {
 readonly code:SourceReservationCode;readonly state:SourceReservationFailure['state'];readonly retryAt?:string;
 constructor(code:SourceReservationCode,state:SourceReservationFailure['state']='blocked',retryAt?:string){super(code);this.code=code;this.state=state;this.retryAt=retryAt;}
}
const denied=(code:SourceReservationCode,state:SourceReservationFailure['state']='blocked',retryAt?:string):never=>{throw new Denied(code,state,retryAt);};
const failure=(error:unknown):SourceReservationFailure=>error instanceof Denied?
 {state:error.state,code:error.code,...(error.retryAt?{retryAt:error.retryAt}:{})}:
 {state:'unavailable',code:'RESERVATION_STORAGE_UNAVAILABLE'};
const safeInteger=(v:unknown,min:number,max:number):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
const iso=(ms:number)=>new Date(ms).toISOString();
function validOrigin(value:unknown):value is string {
 if(typeof value!=='string'||value.length>512)return false;
 try{const u=new URL(value);return u.protocol==='https:'&&u.username===''&&u.password===''&&u.origin===value&&u.hostname!=='';}catch{return false;}
}
const HOLD_ORIGIN='lba-public-source-origin-held:v1';
const HOLD_WORKER='lba-public-source-worker-held:v1';

function readMarker(encoded:unknown,epoch:number,version:Marker['version']):Marker|null {
 if(typeof encoded!=='string'||encoded.length>2048||!encoded.startsWith('{'))return null;
 let marker:Marker;
 try{marker=JSON.parse(encoded);}catch{return null;}
 if(!marker||typeof marker!=='object'||Object.keys(marker).length!==11||marker.kind!=='lba-public-source-reservation'||
    marker.version!==version||marker.epoch!==epoch||!validOrigin(marker.origin)||
    typeof marker.token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.token)||
    !safeInteger(marker.reservedAtMs,0,8_639_999_000_000_000)||!safeInteger(marker.deadlineAtMs,marker.reservedAtMs+1,marker.reservedAtMs+30_000)||
    !safeInteger(marker.maxHops,1,4)||!safeInteger(marker.intervalMs,1000,86_400_000)||!safeInteger(marker.hops,0,marker.maxHops)||
    (marker.hops===0?marker.nextHopAtMs!==marker.reservedAtMs:
      !safeInteger(marker.nextHopAtMs,marker.reservedAtMs+marker.hops*marker.intervalMs,marker.deadlineAtMs+marker.intervalMs-1))||
    (marker.maxHops-1)*marker.intervalMs>=30_000)return null;
 return marker;
}

/** Reuses the existing worker/origin/control tables. It does not create schema,
 * fetch, admit a source, authenticate callers or mint delivery.
 * Origin is a fixed trusted server-profile input, NOT an HTTP allowlist.
 * Feed reservations use the same origin row as legacy address reservations.
 * No backend-session identity or session/advisory lock is required.
 */
export function createPublicSourceReservationGuard(options:{pool:SourceReservationPool;expectedControlEpoch:number}) {
 if(!options?.pool||typeof options.pool.connect!=='function'||!safeInteger(options.expectedControlEpoch,1,Number.MAX_SAFE_INTEGER))throw Error('INVALID_RESERVATION_INPUT');
 const pool=options.pool,epoch=options.expectedControlEpoch;

 async function transaction<T>(deadline:number,signal:AbortSignal|undefined,body:(q:SourceReservationQuery)=>Promise<T>):Promise<T> {
  let client:SourceReservationClient|undefined,tx=false,commitStarted=false,closed=false,destroy=false;
  function remaining(){const n=Math.floor(deadline-performance.now());if(signal?.aborted)denied('RESERVATION_ABORTED','cancelled');if(n<=0)denied('RESERVATION_DEADLINE','cancelled');return n;}
  // A late connect/query is never reused. pg release(true) closes only this
  // borrowed connection; idle-in-transaction timeout also bounds server locks.
  async function bounded<V>(operation:Promise<V>):Promise<V>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const abort=()=>{};let onAbort=abort;
   try{return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>reject(new Denied('RESERVATION_DEADLINE','cancelled')),remaining());
    if(signal){onAbort=()=>reject(new Denied('RESERVATION_ABORTED','cancelled'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}
   })]);}catch(error){destroy=true;throw error;}finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  }
  const q:SourceReservationQuery={query:async(sql,values)=>{
   if(closed)denied('RESERVATION_CLOSED');remaining();return bounded(client!.query(sql,values));
  }};
  try{
   remaining();const connecting=pool.connect();
   try{client=await bounded(connecting);}catch(error){void connecting.then(c=>c.release(true),()=>{});throw error;}
   await q.query('begin');tx=true;
   const available=remaining();
   await q.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$2,true)",
    [String(Math.min(1000,available)),String(Math.min(5000,available))]);
   const result=await bounded(body(q));remaining();
   // A callback must not turn a caught SQL failure into a successful reserve.
   // PostgreSQL can answer COMMIT with command=ROLLBACK for an aborted TX.
   if(destroy)denied('RESERVATION_STORAGE_UNAVAILABLE','unavailable');
   commitStarted=true;const committed=await bounded(client.query('commit'));
   if(committed.command!=='COMMIT')denied('RESERVATION_COMMIT_UNKNOWN','uncertain');
   tx=false;return result;
  }catch(error){
   if(commitStarted){destroy=true;throw new Denied('RESERVATION_COMMIT_UNKNOWN','uncertain');}
   if(tx&&!destroy){try{await bounded(client!.query('rollback'));tx=false;}catch{destroy=true;}}
   throw error;
  }finally{closed=true;if(client)client.release(destroy||tx);}
 }
 async function control(q:SourceReservationQuery){
  const rows=(await q.query('select control_epoch,writer_mode from lba_production_control where id=true for share')).rows;
  if(rows.length!==1||rows[0].writer_mode!=='canonical')denied('RESERVATION_CONTROL_REJECTED');
  const value=rows[0].control_epoch;
  if(!((typeof value==='number'&&Number.isSafeInteger(value))||(typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)))||Number(value)!==epoch)denied('RESERVATION_EPOCH_CONFLICT');
 }
 async function dbTime(q:SourceReservationQuery):Promise<number>{
  const value=(await q.query('select floor(extract(epoch from clock_timestamp())*1000)::bigint as reservation_now_ms')).rows[0]?.reservation_now_ms;
  const ms=typeof value==='string'&&/^\d{1,16}$/.test(value)?Number(value):value;
  if(!safeInteger(ms,0,8_639_999_000_000_000))denied('RESERVATION_STORAGE_UNAVAILABLE','unavailable');return ms;
 }
 async function workerRow(q:SourceReservationQuery,lock:'share'|'update'){
  const rows=(await q.query('select uncertain,hold_reason from lba_public_source_worker where id=true for '+lock)).rows;
  if(rows.length!==1)denied('RESERVATION_TOKEN_CONFLICT');
  return rows[0];
 }
 async function originRow(q:SourceReservationQuery,origin:string){
  return (await q.query('select next_attempt_at,uncertain,hold_reason from lba_public_source_origin where origin=$1 for update',[origin])).rows[0];
 }
 function workerAllows(row:{uncertain:boolean;hold_reason:string|null},origin:string,version:Marker['version']){
  if(row.uncertain===false&&row.hold_reason===null)return true;
  if(version!==2||row.uncertain!==true)return false;
  const legacy=readMarker(row.hold_reason,epoch,1);
  return legacy!==null&&legacy.origin!==origin;
 }
 async function owned(q:SourceReservationQuery,marker:Marker,encoded:string){
  await control(q);
  const worker=await workerRow(q,marker.version===1?'update':'share'),origin=await originRow(q,marker.origin);
  const workerOwned=marker.version===1?worker.uncertain===true&&worker.hold_reason===encoded:workerAllows(worker,marker.origin,marker.version);
  if(!workerOwned||origin?.uncertain!==true||origin.hold_reason!==encoded)denied('RESERVATION_TOKEN_CONFLICT');
 }
 async function persist(q:SourceReservationQuery,callback:((q:SourceReservationQuery,r:SourceReservationReceipt)=>Promise<void>)|undefined,receipt:SourceReservationReceipt){
  if(callback)try{await callback(q,receipt);}catch{denied('RESERVATION_CALLBACK_FAILED','unavailable');}
 }

 /** Retire only an exact feed run after its lease ends. An interrupted
  * single public GET also waits for the durable provider cooldown. */
 async function reconcileExpiredSourceRun(origin:string|undefined,retire:(q:SourceReservationQuery,run:ExpiredSourceReservation)=>Promise<boolean>):Promise<SourceReconciliationResult>{
  if(typeof retire!=='function')return {state:'blocked',code:'INVALID_RESERVATION_INPUT'};
  try{return await transaction(performance.now()+5_000,undefined,async q=>{
   await control(q);
   const worker=await workerRow(q,origin===undefined?'update':'share');
   if(origin!==undefined&&!workerAllows(worker,origin,2))return {state:'unchanged'};
   const legacy=origin===undefined&&worker.uncertain===true?readMarker(worker.hold_reason,epoch,1):null;
   const lockedOrigin=origin??legacy?.origin;
   if(lockedOrigin===undefined)return {state:'unchanged'};
   const row=await originRow(q,lockedOrigin),encoded=row?.hold_reason;
   const marker=legacy??readMarker(encoded,epoch,2);
   const next=new Date(row?.next_attempt_at).getTime();
   if(!marker||marker.origin!==lockedOrigin||row?.uncertain!==true||
      (origin===undefined&&(!legacy||encoded!==worker.hold_reason))||
      !Number.isFinite(next)||next<marker.reservedAtMs+marker.maxHops*marker.intervalMs)return {state:'unchanged'};
   const now=await dbTime(q);
   if(now<marker.deadlineAtMs||marker.hops>0&&(marker.maxHops!==1||next<marker.nextHopAtMs||now<next))return {state:'unchanged'};
   const run={reservationToken:marker.token,origin:marker.origin,controlEpoch:epoch,reservedAt:iso(marker.reservedAtMs),
    expectedMaxHops:marker.maxHops,grantedHops:marker.hops,finishedAt:iso(now)};
   if(!await retire(q,run))return {state:'unchanged'};
   if(legacy){
    const releaseWorker=await q.query('update lba_public_source_worker set uncertain=false,hold_reason=null where id=true and uncertain=true and hold_reason=$1',[encoded]);
    if(releaseWorker.rowCount!==1)denied('RESERVATION_TOKEN_CONFLICT');
   }
   const releaseOrigin=await q.query('update lba_public_source_origin set uncertain=false,hold_reason=null where origin=$1 and uncertain=true and hold_reason=$2',[marker.origin,encoded]);
   if(releaseOrigin.rowCount!==1)denied('RESERVATION_TOKEN_CONFLICT');
   return {state:'recovered'};
  });}catch(error){return failure(error);}
 }

 return {reconcileExpiredSourceRun,async reserve(input:{origin:string;scope?:'origin';expectedMaxHops:number;minIntervalMs:number;strictEightPerMinute?:boolean;deadlineMs?:number;signal:AbortSignal;
  persist?:(transaction:SourceReservationQuery,receipt:SourceReservationReceipt)=>Promise<void>}):Promise<SourceReserveResult>{
  const duration=input?.deadlineMs??30_000;
  // Existing reviewed single-hop profiles include 1000/600000/2700000ms.
  // Strict 8/60 callers opt into the additional >=7500ms guard; neither limit
  // is a claim about provider quota or admission.
  if(!validOrigin(input?.origin)||input.scope!==undefined&&input.scope!=='origin'||!safeInteger(input?.expectedMaxHops,1,4)||!safeInteger(input?.minIntervalMs,1000,86_400_000)||
   input.strictEightPerMinute!==undefined&&typeof input.strictEightPerMinute!=='boolean'||input.strictEightPerMinute===true&&input.minIntervalMs<7500||
   !safeInteger(duration,1,30_000)||(input.expectedMaxHops-1)*input.minIntervalMs>=duration||!input.signal||typeof input.signal.addEventListener!=='function'||
   input.persist!==undefined&&typeof input.persist!=='function')return {state:'blocked',code:'INVALID_RESERVATION_INPUT'};
  input={...input};
  const version:Marker['version']=input.scope==='origin'?2:1;
  // Wall deadline includes connection/row-lock work and waiting; DB clock is
  // authoritative for durable eligibility. No test/env clock override exists.
  const deadline=performance.now()+duration;
  let marker:Marker,encoded:string,receipt:SourceReservationReceipt;
  try{
   ({marker,encoded,receipt}=await transaction(deadline,input.signal,async q=>{
    await control(q);
    await q.query('insert into lba_public_source_worker(id,uncertain,hold_reason) values(true,false,null) on conflict(id) do nothing');
    const worker=await workerRow(q,version===1?'update':'share');
    if(!workerAllows(worker,input.origin,version))denied('RESERVATION_WORKER_HELD');
    await q.query("insert into lba_public_source_origin(origin,next_attempt_at,uncertain,hold_reason) values($1,'epoch',false,null) on conflict(origin) do nothing",[input.origin]);
    const row=await originRow(q,input.origin);
    if(!row||row.uncertain!==false||row.hold_reason!==null)denied('RESERVATION_ORIGIN_HELD');
    const now=await dbTime(q),next=new Date(row.next_attempt_at).getTime();
    if(!Number.isFinite(next))denied('RESERVATION_STORAGE_UNAVAILABLE','unavailable');
    if(next>now)denied('RESERVATION_LOCAL_BUDGET_DEFERRED','deferred',iso(next));
    const remaining=Math.floor(deadline-performance.now());
    if(remaining<1)denied('RESERVATION_DEADLINE','cancelled');
    const m:Marker={kind:'lba-public-source-reservation',version,token:randomUUID(),epoch,origin:input.origin,reservedAtMs:now,
     deadlineAtMs:now+remaining,maxHops:input.expectedMaxHops,intervalMs:input.minIntervalMs,hops:0,nextHopAtMs:now};
    const text=JSON.stringify(m),r=Object.freeze({reservationToken:m.token,origin:m.origin,controlEpoch:epoch,reservedAt:iso(now),
     expectedMaxHops:m.maxHops,minIntervalMs:m.intervalMs,operationDeadlineAt:iso(m.deadlineAtMs)});
    if(version===1)await q.query('update lba_public_source_worker set uncertain=true,hold_reason=$1 where id=true',[text]);
    await q.query('update lba_public_source_origin set uncertain=true,hold_reason=$2,next_attempt_at=$3 where origin=$1',[m.origin,text,iso(now+m.maxHops*m.intervalMs)]);
    await persist(q,input.persist,r);return {marker:m,encoded:text,receipt:r};
   }));
  }catch(error){return failure(error);}
  let closed=false,lastConfirmedGrantAt=-Infinity,tail:Promise<void>=Promise.resolve();
  // Serializes even simultaneous beforeHop/finalize calls on this capability.
  const serial=<T>(run:()=>Promise<T>):Promise<T>=>{const work=tail.then(run);tail=work.then(()=>{},()=>{});return work;};
  const wait=async(ms:number,signal:AbortSignal)=>{
   if(signal.aborted)denied('RESERVATION_ABORTED','cancelled');
   const remaining=Math.floor(deadline-performance.now());if(ms>=remaining)denied('RESERVATION_DEADLINE','cancelled');
   await new Promise<void>((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(new Denied('RESERVATION_ABORTED','cancelled'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);
    signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
   });
  };
  const reservation:PublicSourceReservation={receipt,
   beforeHop:(descriptor,signal)=>serial(async()=>{
    if(closed)return {state:'blocked',code:'RESERVATION_CLOSED'};
    if(!descriptor||descriptor.origin!==marker.origin||!signal||typeof signal.addEventListener!=='function')return {state:'blocked',code:'INVALID_RESERVATION_INPUT'};
    try{
     for(;;){
      const step=await transaction<{waitMs:number}|{next:Marker;text:string;now:number}>(deadline,signal,async q=>{
       await owned(q,marker,encoded);const now=await dbTime(q);
       if(now>=marker.deadlineAtMs)denied('RESERVATION_DEADLINE','cancelled');
       if(marker.hops>=marker.maxHops)denied('RESERVATION_HOP_LIMIT');
       // Also space confirmed permissions locally: a slow previous COMMIT must
       // not shorten the gap between HTTP permissions below the DB interval.
       const waitMs=Math.max(marker.nextHopAtMs-now,Math.ceil(lastConfirmedGrantAt+marker.intervalMs-performance.now()));
       if(waitMs>0)return {waitMs} as const;
       const next={...marker,hops:marker.hops+1,nextHopAtMs:now+marker.intervalMs},text=JSON.stringify(next);
       if(version===1){
        const worker=await q.query('update lba_public_source_worker set hold_reason=$2 where id=true and uncertain=true and hold_reason=$1',[encoded,text]);
        if(worker.rowCount!==1)denied('RESERVATION_TOKEN_CONFLICT');
       }
       const origin=await q.query('update lba_public_source_origin set hold_reason=$3,next_attempt_at=greatest(next_attempt_at,$4) where origin=$1 and uncertain=true and hold_reason=$2',[marker.origin,encoded,text,iso(now+marker.intervalMs)]);
       if(origin.rowCount!==1)denied('RESERVATION_TOKEN_CONFLICT');
       return {next,text,now} as const;
      });
      if('waitMs' in step){await wait(step.waitMs,signal);continue;}
      marker=step.next;encoded=step.text;
      if(signal.aborted)denied('RESERVATION_ABORTED','cancelled');
      if(performance.now()>=deadline)denied('RESERVATION_DEADLINE','cancelled');
      lastConfirmedGrantAt=performance.now();
      return {state:'granted',hop:marker.hops,grantedAt:iso(step.now)};
     }
    }catch(error){closed=true;return failure(error);}
   }),
   finalize:(finish={})=>serial(async()=>{
    if(closed)return {state:'blocked',code:'RESERVATION_CLOSED'};
    if(!finish||finish.hold!==undefined&&!['origin','worker-and-origin'].includes(finish.hold)||finish.retryAfterMs!==undefined&&!safeInteger(finish.retryAfterMs,0,86_400_000)||finish.persist!==undefined&&typeof finish.persist!=='function')return {state:'blocked',code:'INVALID_RESERVATION_INPUT'};
    finish={...finish};
    closed=true;
    try{
     await transaction(deadline,undefined,async q=>{
      await owned(q,marker,encoded);const now=await dbTime(q);
      if(now>=marker.deadlineAtMs)denied('RESERVATION_DEADLINE','cancelled');
      await persist(q,finish.persist,receipt);
      if(version===1){
       const worker=await q.query('update lba_public_source_worker set uncertain=$2,hold_reason=$3 where id=true and uncertain=true and hold_reason=$1',[encoded,finish.hold==='worker-and-origin',finish.hold==='worker-and-origin'?HOLD_WORKER:null]);
       if(worker.rowCount!==1)denied('RESERVATION_TOKEN_CONFLICT');
      }
      const origin=await q.query('update lba_public_source_origin set uncertain=$3,hold_reason=$4,next_attempt_at=greatest(next_attempt_at,$5) where origin=$1 and uncertain=true and hold_reason=$2',[marker.origin,encoded,Boolean(finish.hold),finish.hold?HOLD_ORIGIN:null,iso(now+Math.max(marker.intervalMs,finish.retryAfterMs??0))]);
      if(origin.rowCount!==1)denied('RESERVATION_TOKEN_CONFLICT');
     });
     return {state:'finalized',held:Boolean(finish.hold)};
    }catch(error){return failure(error);}
   })};
  if(input.signal.aborted)return {state:'cancelled',code:'RESERVATION_ABORTED'};
  return {state:'reserved',reservation};
 }};
}
