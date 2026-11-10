'use strict';
// Read-only boot observation. Importing this module never reads environment or connects.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const KIND='lba-runtime-lock-observation/1',WORK_MS=10000,TOTAL_MS=12000;
const TARGETS=['lba-update-campaign-global-v1','lba-telegram-dispatch-bot:8577497098'];
const SQL=`WITH metadata AS (
 SELECT pg_is_in_recovery() AS recovery,
 current_setting('transaction_read_only') AS transaction_ro,
 current_setting('default_transaction_read_only') AS default_ro,
 current_setting('server_version_num') AS server_version_num,
 to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
), targets(label,k) AS (
 VALUES ('campaign',hashtextextended($1,0)),('bot',hashtextextended($2,0))
), held AS (
 SELECT t.label,l.pid,l.granted,a.state,a.backend_type,a.backend_start,a.xact_start,
 l.pid=pg_backend_pid() AS current_backend
 FROM targets t LEFT JOIN pg_locks l ON l.locktype='advisory' AND l.objsubid=1
 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
 AND l.classid::bigint=((t.k>>32)&4294967295::bigint)
 AND l.objid::bigint=(t.k&4294967295::bigint)
 LEFT JOIN pg_stat_activity a ON a.pid=l.pid
)
SELECT label,count(pid)::int AS holders,count(pid) FILTER(WHERE granted)::int AS granted,
 count(pid) FILTER(WHERE NOT granted)::int AS waiting,
 array_agg(DISTINCT state) FILTER(WHERE pid IS NOT NULL) AS backend_states,
 array_agg(DISTINCT backend_type) FILTER(WHERE pid IS NOT NULL) AS backend_types,
 max(extract(epoch FROM clock_timestamp()-backend_start)) AS oldest_backend_seconds,
 max(extract(epoch FROM clock_timestamp()-xact_start)) AS oldest_transaction_seconds,
 coalesce(bool_or(current_backend AND granted),false) AS current_backend_holds,
 recovery,transaction_ro,default_ro,server_version_num,observed_at
 FROM held CROSS JOIN metadata GROUP BY label,recovery,transaction_ro,default_ro,server_version_num,observed_at
 ORDER BY label`;
const STATES=new Set(['active','idle','idle in transaction','idle in transaction (aborted)','disabled','fastpath function call']);
const TYPES=new Set(['client backend','autovacuum worker','logical replication worker','background worker','walsender','walreceiver','parallel worker']);
const PG_CODES=new Set(['08000','08001','08003','08004','08006','08007','08P01','28P01','28000','42501','42P01','42703','53300','53400','55000','57014','57P01','57P02','57P03']);
const NET_CODES=new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN']);
function fixed(code){const e=new Error(code);e.observationCode=code;return e;}
function safeError(e){
 if(['OBSERVATION_CONFIGURATION','OBSERVATION_TIMEOUT','OBSERVATION_RESULT_INVALID','OBSERVATION_CLEANUP_FAILED'].includes(e?.observationCode))return e.observationCode;
 if(PG_CODES.has(e?.code))return 'POSTGRES_'+e.code;
 if(NET_CODES.has(e?.code))return e.code;
 return 'OBSERVATION_UNCONFIRMED';
}
function bounded(promise,ms){
 if(ms<=0)return Promise.reject(fixed('OBSERVATION_TIMEOUT'));
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(fixed('OBSERVATION_TIMEOUT')),ms);
  Promise.resolve(promise).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});
}
function connectionFlags(value){
 let u;try{u=new URL(value);}catch{throw fixed('OBSERVATION_CONFIGURATION');}
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.hostname)throw fixed('OBSERVATION_CONFIGURATION');
 const h=u.hostname.toLowerCase(),suffix=s=>h===s||h.endsWith('.'+s);
 return {connectionHasPoolerMarker:/(?:^|[-.])pooler(?=[-.]|$)/.test(h),recognizedProvider:{neon:suffix('neon.tech'),supabase:suffix('supabase.co')||suffix('supabase.com'),replit:suffix('replit.com')||suffix('replit.dev')||suffix('replit.app')}};
}
function count(value){if(!Number.isSafeInteger(value)||value<0||value>1000000)throw fixed('OBSERVATION_RESULT_INVALID');return value;}
function age(value){if(value===null)return null;const n=Number(value);if(!Number.isFinite(n)||n<0)throw fixed('OBSERVATION_RESULT_INVALID');return Math.min(2147483647,Math.ceil(n));}
function labels(value,allowed){if(value===null)return [];if(!Array.isArray(value)||value.length>64)throw fixed('OBSERVATION_RESULT_INVALID');return [...new Set(value.map(v=>allowed.has(v)?v:'unknown'))].sort();}
function parse(rows){
 if(!Array.isArray(rows)||rows.length!==2||rows[0]?.label!=='bot'||rows[1]?.label!=='campaign')throw fixed('OBSERVATION_RESULT_INVALID');
 const m=rows[0];
 if(typeof m.recovery!=='boolean'||m.transaction_ro!=='on'||!['on','off'].includes(m.default_ro)||!/^\d{6}$/.test(String(m.server_version_num))||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m.observed_at)||!Number.isFinite(Date.parse(m.observed_at)))throw fixed('OBSERVATION_RESULT_INVALID');
 if(rows.some(r=>['recovery','transaction_ro','default_ro','server_version_num','observed_at'].some(k=>r[k]!==m[k])))throw fixed('OBSERVATION_RESULT_INVALID');
 return {observedAt:m.observed_at,pgIsInRecovery:m.recovery,backend:{scope:'single-read-only-transaction',transactionReadOnly:true,defaultTransactionReadOnly:m.default_ro==='on',serverMajor:Math.floor(Number(m.server_version_num)/10000)},locks:rows.map(r=>{
  const holders=count(r.holders),granted=count(r.granted),waiting=count(r.waiting);
  if(granted+waiting!==holders||typeof r.current_backend_holds!=='boolean')throw fixed('OBSERVATION_RESULT_INVALID');
  return {target:r.label,holders,granted,waiting,currentBackendHolds:r.current_backend_holds,backendStates:labels(r.backend_states,STATES),backendTypes:labels(r.backend_types,TYPES),oldestBackendSeconds:age(r.oldest_backend_seconds),oldestTransactionSeconds:age(r.oldest_transaction_seconds)};
 })};
}
async function observe(){
 const started=Date.now(),workUntil=started+WORK_MS,totalUntil=started+TOTAL_MS;
 let pool,client,connecting,abandoned=false,errorCode=null,cleanupError=null;
 let result={kind:KIND,observedAt:new Date().toISOString(),success:false,pgIsInRecovery:null,connectionHasPoolerMarker:null,recognizedProvider:{neon:false,supabase:false,replit:false},backend:null,locks:[]};
 const work=(p,limit)=>bounded(p,Math.min(limit,workUntil-Date.now()));
 try{
  const url=process.env.DATABASE_URL;
  if(typeof url!=='string'||url.length===0||url.length>16384)throw fixed('OBSERVATION_CONFIGURATION');
  Object.assign(result,connectionFlags(url));
  const {Pool}=createRequire(path.join(__dirname,'../app/package.json'))('pg');
  pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:3000,query_timeout:3500,application_name:'lba-runtime-lock-observation'});
  pool.on('error',()=>{});
  connecting=pool.connect();
  Promise.resolve(connecting).then(c=>{if(abandoned)try{c.release(true);}catch{}},()=>{});
  client=await work(connecting,5500);
  await work(client.query('BEGIN READ ONLY'),3500);
  const rows=(await work(client.query(SQL,TARGETS),3500)).rows;
  Object.assign(result,parse(rows));result.success=true;
 }catch(e){errorCode=safeError(e);result.success=false;}
 finally{
  abandoned=true;
  if(client){
   // Also roll back after a failed BEGIN acknowledgement: no state-changing command is issued.
   try{await bounded(client.query('ROLLBACK'),Math.min(1000,totalUntil-Date.now()));}catch{cleanupError='OBSERVATION_CLEANUP_FAILED';}
   try{client.release(true);}catch{cleanupError='OBSERVATION_CLEANUP_FAILED';}
  }
  if(pool)try{await bounded(pool.end(),Math.min(1000,totalUntil-Date.now()));}catch{cleanupError='OBSERVATION_CLEANUP_FAILED';}
 }
 if(cleanupError){result.success=false;result.cleanupError=cleanupError;}
 if(errorCode)result.errorCode=errorCode;
 result.durationMs=Math.max(0,Date.now()-started);
 return result;
}
function verify(){return {kind:'lba-runtime-lock-observation-config/1',sha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),databaseConnected:false,environmentRead:false,targetLocks:2,readOnly:true,maximumBudgetMs:TOTAL_MS};}
async function main(args=process.argv.slice(2)){
 if(args.length===1&&args[0]==='--verify'){const r=verify();console.log(JSON.stringify(r));return r;}
 if(args.length!==0){const r={kind:KIND,success:false,errorCode:'OBSERVATION_ARGUMENTS'};console.log(JSON.stringify(r));process.exitCode=1;return r;}
 const r=await observe();console.log(JSON.stringify(r));if(!r.success)process.exitCode=1;return r;
}
module.exports={observe,verify,main};
if(require.main===module)void main();
