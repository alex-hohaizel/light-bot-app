import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withProofDatabase} from '../../../../../tools/local-runtime/disposable-proof-db.mjs';
import {createSourceIngestion,SOURCE_INGESTION_SCHEMA_SQL} from '../server/production/source-ingestion.ts';

const kharkiv='https://oblenergo.kharkiv.ua',odesa='https://www.dtek-oem.com.ua';
const source='kharkiv-official-rss',epoch=1,intervalMs=2_700_000;
const now=()=>Date.parse('2026-11-11T00:00:00Z');
const iso=ms=>new Date(ms).toISOString();

await withProofDatabase('source_recovery',55493,async pool=>{
 await pool.query('create table lba_production_control(id boolean primary key,control_epoch bigint,writer_mode text)');
 await pool.query("insert into lba_production_control values(true,1,'canonical')");
 await pool.query(SOURCE_INGESTION_SCHEMA_SQL);
 let requests=0;
 const service=createSourceIngestion({enabled:true,expectedControlEpoch:epoch,pool,now,transport:async request=>{
  requests++;
  return {url:request.url,status:503,headers:{},body:{async *[Symbol.asyncIterator](){}}};
 }});
 async function seed({hops=0,expired=true,otherRun=false,raw=false,mismatch=false,manual=false}={}){
  await pool.query('truncate lba_public_source_worker,lba_public_source_origin,lba_public_source_state,lba_public_source_run,lba_public_source_raw,lba_public_source_plan');
  requests=0;
  const dbTime=Number((await pool.query('select floor(extract(epoch from clock_timestamp())*1000) as now')).rows[0].now);
  const reservedAtMs=dbTime-(expired?90_000:1_000),token=randomUUID(),next=iso(reservedAtMs+intervalMs);
  const marker=JSON.stringify({kind:'lba-public-source-reservation',version:1,token,epoch,origin:kharkiv,reservedAtMs,
   deadlineAtMs:reservedAtMs+30_000,maxHops:1,intervalMs,hops,nextHopAtMs:reservedAtMs+(hops?intervalMs:0)});
  await pool.query('insert into lba_public_source_worker values(true,true,$1)',[manual?'lba-public-source-worker-held:v1':marker]);
  await pool.query('insert into lba_public_source_origin values($1,$2,true,$3),($4,$2,true,$5)',
   [kharkiv,next,mismatch?'other origin hold':marker,odesa,'lba-public-source-origin-held:v1']);
  await pool.query('insert into lba_public_source_state(source_id,last_attempt_at) values($1,$2)',[source,iso(reservedAtMs)]);
  await pool.query("insert into lba_public_source_run(id,source_id,control_epoch,started_at,status) values($1,$2,1,$3,'started')",[token,source,iso(reservedAtMs)]);
  if(otherRun)await pool.query("insert into lba_public_source_run(id,source_id,control_epoch,started_at,status) values($1,'yasno-kem',1,$2,'started')",[randomUUID(),iso(reservedAtMs)]);
  if(raw)await pool.query('insert into lba_public_source_raw values($1,$2,$3,$4,$5::jsonb)',[randomUUID(),token,source,iso(reservedAtMs),'{}']);
  return {token,marker,next};
 }

 const expired=await seed();
 assert.deepEqual(await service.refreshOnce('yasno-kem'),{state:'deferred',code:'SOURCE_RESERVATION_RECOVERED'});
 assert.equal(requests,0);
 const old=(await pool.query('select status,code,finished_at from lba_public_source_run where id=$1',[expired.token])).rows[0];
 assert.equal(old.status,'rejected');
 assert.equal(old.code,'SOURCE_UPDATE_UNCONFIRMED');
 assert(old.finished_at);
 assert.deepEqual((await pool.query('select uncertain,hold_reason from lba_public_source_worker')).rows,[{uncertain:false,hold_reason:null}]);
 const origins=(await pool.query('select origin,uncertain,hold_reason,next_attempt_at from lba_public_source_origin order by origin')).rows;
 assert.deepEqual(origins.map(row=>({...row,next_attempt_at:row.next_attempt_at.toISOString()})),[
  {origin:kharkiv,uncertain:false,hold_reason:null,next_attempt_at:expired.next},
  {origin:odesa,uncertain:true,hold_reason:'lba-public-source-origin-held:v1',next_attempt_at:expired.next},
 ]);
 assert.equal((await service.refreshOnce('yasno-kem')).code,'SOURCE_HTTP_REJECTED');
 assert.equal(requests,1);
 console.log('expired zero-hop reservation retired atomically; unrelated refresh resumed; provider hold and cooldown preserved');

 for(const options of [{expired:false},{hops:1},{mismatch:true},{otherRun:true},{raw:true},{manual:true}]){
  const seedRun=await seed(options);
  assert.equal((await service.refreshOnce('yasno-kem')).code,'SOURCE_WORKER_HELD',JSON.stringify(options));
  assert.equal(requests,0);
  assert.equal((await pool.query('select status from lba_public_source_run where id=$1',[seedRun.token])).rows[0].status,'started');
  assert.equal((await pool.query('select uncertain from lba_public_source_worker')).rows[0].uncertain,true);
 }
 console.log('active, issued, ambiguous, published-evidence and manual holds remain untouched');

 await seed();
 const outcomes=await Promise.all([service.refreshOnce(source),service.refreshOnce(source)]);
 assert.equal(outcomes.filter(result=>result.code==='SOURCE_RESERVATION_RECOVERED').length,1);
 assert.equal(requests,0);
 console.log('concurrent recovery has one winner and does not issue a provider request');
});
