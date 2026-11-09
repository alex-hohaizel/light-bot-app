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

type Marker={kind:'lba-public-source-reservation';version:1;token:string;epoch:number;origin:string;
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

/** Reuses the existing worker/origin/control tables. It does not create schema,
 * fetch, admit a source, authenticate callers, mint delivery or auto-unhold.
 * Origin is a fixed trusted server-profile input, NOT an HTTP allowlist.
 * All writers must be switched together after the old worker has drained.
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
   const timeout=Math.min(1000,remaining());
   await q.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$1,true)",[String(timeout)]);
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
 async function locked(q:SourceReservationQuery,origin:string){
  const worker=(await q.query('select uncertain,hold_reason from lba_public_source_worker where id=true for update')).rows;
  const origins=(await q.query('select next_attempt_at,uncertain,hold_reason from lba_public_source_origin where origin=$1 for update',[origin])).rows;
  if(worker.length!==1||origins.length!==1)denied('RESERVATION_TOKEN_CONFLICT');return {worker:worker[0],origin:origins[0]};
 }
 async function owned(q:SourceReservationQuery,origin:string,encoded:string){
  await control(q);const rows=await locked(q,origin);
  if(rows.worker.uncertain!==true||rows.origin.uncertain!==true||rows.worker.hold_reason!==encoded||rows.origin.hold_reason!==encoded)denied('RESERVATION_TOKEN_CONFLICT');
 }
 async function persist(q:SourceReservationQuery,callback:((q:SourceReservationQuery,r:SourceReservationReceipt)=>Promise<void>)|undefined,receipt:SourceReservationReceipt){
  if(callback)try{await callback(q,receipt);}catch{denied('RESERVATION_CALLBACK_FAILED','unavailable');}
 }

 return {async reserve(input:{origin:string;expectedMaxHops:number;minIntervalMs:number;strictEightPerMinute?:boolean;deadlineMs?:number;signal:AbortSignal;
  persist?:(transaction:SourceReservationQuery,receipt:SourceReservationReceipt)=>Promise<void>}):Promise<SourceReserveResult>{
  const duration=input?.deadlineMs??30_000;
  // Existing reviewed single-hop profiles include 1000/600000/2700000ms.
  // Strict 8/60 callers opt into the additional >=7500ms guard; neither limit
  // is a claim about provider quota or admission.
  if(!validOrigin(input?.origin)||!safeInteger(input?.expectedMaxHops,1,4)||!safeInteger(input?.minIntervalMs,1000,86_400_000)||
   input.strictEightPerMinute!==undefined&&typeof input.strictEightPerMinute!=='boolean'||input.strictEightPerMinute===true&&input.minIntervalMs<7500||
   !safeInteger(duration,1,30_000)||(input.expectedMaxHops-1)*input.minIntervalMs>=duration||!input.signal||typeof input.signal.addEventListener!=='function'||
   input.persist!==undefined&&typeof input.persist!=='function')return {state:'blocked',code:'INVALID_RESERVATION_INPUT'};
  input={...input};
  // Wall deadline includes connection/row-lock work and waiting; DB clock is
  // authoritative for durable eligibility. No test/env clock override exists.
  const deadline=performance.now()+duration;
  let marker:Marker,encoded:string,receipt:SourceReservationReceipt;
  try{
   ({marker,encoded,receipt}=await transaction(deadline,input.signal,async q=>{
    await control(q);
    await q.query('insert into lba_public_source_worker(id,uncertain,hold_reason) values(true,false,null) on conflict(id) do nothing');
    const workers=(await q.query('select uncertain,hold_reason from lba_public_source_worker where id=true for update')).rows;
    if(workers.length!==1||workers[0].uncertain!==false||workers[0].hold_reason!==null)denied('RESERVATION_WORKER_HELD');
    await q.query("insert into lba_public_source_origin(origin,next_attempt_at,uncertain,hold_reason) values($1,'epoch',false,null) on conflict(origin) do nothing",[input.origin]);
    const row=(await q.query('select next_attempt_at,uncertain,hold_reason from lba_public_source_origin where origin=$1 for update',[input.origin])).rows[0];
    if(!row||row.uncertain!==false||row.hold_reason!==null)denied('RESERVATION_ORIGIN_HELD');
    const now=await dbTime(q),next=new Date(row.next_attempt_at).getTime();
    if(!Number.isFinite(next))denied('RESERVATION_STORAGE_UNAVAILABLE','unavailable');
    if(next>now)denied('RESERVATION_LOCAL_BUDGET_DEFERRED','deferred',iso(next));
    const m:Marker={kind:'lba-public-source-reservation',version:1,token:randomUUID(),epoch,origin:input.origin,reservedAtMs:now,
     deadlineAtMs:now+Math.max(0,Math.floor(deadline-performance.now())),maxHops:input.expectedMaxHops,intervalMs:input.minIntervalMs,hops:0,nextHopAtMs:now};
    const text=JSON.stringify(m),r=Object.freeze({reservationToken:m.token,origin:m.origin,controlEpoch:epoch,reservedAt:iso(now),
     expectedMaxHops:m.maxHops,minIntervalMs:m.intervalMs,operationDeadlineAt:iso(m.deadlineAtMs)});
    await q.query('update lba_public_source_worker set uncertain=true,hold_reason=$1 where id=true',[text]);
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
       await owned(q,marker.origin,encoded);const now=await dbTime(q);
       if(now>=marker.deadlineAtMs)denied('RESERVATION_DEADLINE','cancelled');
       if(marker.hops>=marker.maxHops)denied('RESERVATION_HOP_LIMIT');
       // Also space confirmed permissions locally: a slow previous COMMIT must
       // not shorten the gap between HTTP permissions below the DB interval.
       const waitMs=Math.max(marker.nextHopAtMs-now,Math.ceil(lastConfirmedGrantAt+marker.intervalMs-performance.now()));
       if(waitMs>0)return {waitMs} as const;
       const next={...marker,hops:marker.hops+1,nextHopAtMs:now+marker.intervalMs},text=JSON.stringify(next);
       const worker=await q.query('update lba_public_source_worker set hold_reason=$2 where id=true and uncertain=true and hold_reason=$1',[encoded,text]);
       const origin=await q.query('update lba_public_source_origin set hold_reason=$3,next_attempt_at=greatest(next_attempt_at,$4) where origin=$1 and uncertain=true and hold_reason=$2',[marker.origin,encoded,text,iso(now+marker.intervalMs)]);
       if(worker.rowCount!==1||origin.rowCount!==1)denied('RESERVATION_TOKEN_CONFLICT');
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
      await owned(q,marker.origin,encoded);const now=await dbTime(q);
      if(now>=marker.deadlineAtMs)denied('RESERVATION_DEADLINE','cancelled');
      await persist(q,finish.persist,receipt);
      const worker=await q.query('update lba_public_source_worker set uncertain=$2,hold_reason=$3 where id=true and uncertain=true and hold_reason=$1',[encoded,finish.hold==='worker-and-origin',finish.hold==='worker-and-origin'?HOLD_WORKER:null]);
      const origin=await q.query('update lba_public_source_origin set uncertain=$3,hold_reason=$4,next_attempt_at=greatest(next_attempt_at,$5) where origin=$1 and uncertain=true and hold_reason=$2',[marker.origin,encoded,Boolean(finish.hold),finish.hold?HOLD_ORIGIN:null,iso(now+Math.max(marker.intervalMs,finish.retryAfterMs??0))]);
      if(worker.rowCount!==1||origin.rowCount!==1)denied('RESERVATION_TOKEN_CONFLICT');
     });
     return {state:'finalized',held:Boolean(finish.hold)};
    }catch(error){return failure(error);}
   })};
  if(input.signal.aborted)return {state:'cancelled',code:'RESERVATION_ABORTED'};
  return {state:'reserved',reservation};
 }};
}
