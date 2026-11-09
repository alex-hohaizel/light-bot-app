import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createSourceIngestion,discoverPublicSourceGroups,SOURCE_INGESTION_SCHEMA_SQL} from '../../server/production/source-ingestion.ts';
import {createSourceIntake,SOURCE_PROFILES,type SourceHttpTransport} from '../../server/production/source-intake.ts';
import {technicalDisplaySourceRegistry} from '../../server/production/source-operating-policy.ts';
const dir=new URL('../../../docs/light-bot-app/release-v8/data-current-2026-11-08/',import.meta.url);
const now=()=>Date.parse('2026-11-08T19:40:00Z');
const body=(raw:string)=>({async *[Symbol.asyncIterator](){yield Buffer.from(raw);}});
const raw=()=>readFile(new URL('yasno-kem.json',dir),'utf8');
const profile=SOURCE_PROFILES.find(p=>p.sourceId==='yasno-kem')!;
const request={sourceId:profile.sourceId,operatorId:profile.operatorId,namespace:profile.namespace,targetId:'1.1',serviceDate:'2026-11-08'};
test('service construction/default disabled and unknown/direct/obsolete sources cannot query DB or HTTP',async()=>{
 let db=0,http=0;const pool={async connect(){db++;throw Error('not expected');}},transport:SourceHttpTransport=async()=>{http++;throw Error('not expected');};
 const service=createSourceIngestion({pool,transport,now,expectedControlEpoch:7});
 assert.equal((await service.refreshOnce()).state,'disabled');assert.equal((await service.readTechnicalPlans()).state,'disabled');assert.equal((await service.readCatalog()).state,'disabled');
 const enabled=createSourceIngestion({pool,transport,now,expectedControlEpoch:7,enabled:true});
 for(const id of ['dtek-oem-official','voe-mirror-vn-progr','voe-mirror-olnet93','yasno-dnem','yasno-cek','kharkiv-official-rss','https://evil.test']){const r=await enabled.refreshOnce(id);assert(r.state!=='published');assert.equal(r.code,'SOURCE_NOT_ADMITTED');}
 assert.equal(db,0);assert.equal(http,0);assert(!/user_settings|user_locations|telegram_subscribers|linked_accounts|users\b/i.test(SOURCE_INGESTION_SCHEMA_SQL));
});
test('9Nov mirror readmission is not retroactive at8Nov clock: validcontrol boundary rejects expired admission before any HTTP or reservation',async()=>{
 const queries:string[]=[];let db=0,http=0,released=false;
 const client={async query(sql:string){queries.push(sql);return {rows:sql.includes('pg_try_advisory_lock')?[{locked:true}]:sql.includes('from lba_production_control')?[{control_epoch:7,writer_mode:'canonical'}]:[],rowCount:0};},release(){released=true;}};
 const service=createSourceIngestion({enabled:true,expectedControlEpoch:7,now,pool:{async connect(){db++;return client;}},transport:async()=>{http++;throw Error('NO_RETROACTIVE_GET');}});
 const result=await service.refreshOnce('mirror-odesa');assert(result.state!=='published');assert.equal(result.code,'SOURCE_ADMISSION_EXPIRED');assert.equal(db,1);assert.equal(http,0);assert(released);
 assert(queries.some(sql=>sql.includes('from lba_production_control')));assert(queries.includes('rollback'));assert(!queries.some(sql=>sql.startsWith('insert into lba_public_source_run')));
});
test('service requires explicit epoch, bounded transport and clock, and creates no ambient clients',()=>{
 const base={pool:{async connect(){throw Error('no');}},transport:async()=>{throw Error('no');},now,expectedControlEpoch:7};
 for(const epoch of [0,-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>createSourceIngestion({...base,expectedControlEpoch:epoch}));
 assert.throws(()=>createSourceIngestion({...base,timeoutMs:30001}));assert.throws(()=>createSourceIngestion({...base,transport:null as any}));
});
test('missing control fails closed and rolls back/releases without reading cache or making HTTP',async()=>{
 const calls:string[]=[];let released=false;
 const client={async query(sql:string){calls.push(sql);return {rows:sql.includes('pg_try_advisory_lock')?[{locked:true}]:[],rowCount:0};},release(){released=true;}};
 const service=createSourceIngestion({enabled:true,expectedControlEpoch:7,pool:{async connect(){return client;}},transport:async()=>{throw Error('no');},now});
 const r=await service.refreshOnce('yasno-kem');assert(r.state!=='published');assert.equal(r.code,'SOURCE_CONTROL_REJECTED');assert(calls.includes('rollback'));assert(released);assert(!calls.some(s=>s.includes('lba_public_source_state')));
});
test('HTTP-validated captured raw is copied and exact hashed, while projection is strict and causes no second GET',async()=>{
 const text=await raw();let gets=0,time=now();
 const intake=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>time,transport:async r=>{gets++;return {url:r.url,status:200,headers:{'content-type':'application/json'},body:body(text)};}});
 assert.equal((await intake.load(request)).state,'available');const captured=intake.snapshotRaw('yasno-kem')!;
 assert.equal(captured.semanticValidation,'pending');assert.equal(captured.rawSha256,createHash('sha256').update(text).digest('hex'));
 const future=intake.projectSnapshot({...request,serviceDate:'2026-11-09'},captured);assert.equal(future.state,'available');if(future.state==='available'){assert.equal(future.view.status,'not_published');assert.equal(future.view.intervals.length,0);}
 captured.raw='mutated';assert.notEqual(intake.snapshotRaw('yasno-kem')!.raw,'mutated');assert.equal(gets,1);
 time+=1000;const reused=intake.projectSnapshot(request,intake.snapshotRaw('yasno-kem')!);if(reused.state==='available')assert.equal(reused.provenance.observedAt,new Date(now()).toISOString());
});
test('raw snapshot cannot change source, admission, endpoint, hash, bytes, time or add private fields',async()=>{
 const text=await raw(),intake=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now,transport:async r=>({url:r.url,status:200,headers:{'content-type':'application/json'},body:body(text)})});
 await intake.load(request);const snapshot=intake.snapshotRaw('yasno-kem')!;
 for(const patch of [{sourceId:'yasno-cek'},{admissionRevisionId:'other'},{responseUrl:'https://evil.test'},{requestedUrl:'https://evil.test'},{rawSha256:'0'.repeat(64)},{rawBytes:1},{observedAt:'2027-01-01T00:00:00Z'},{observedAt:'2026-11-08T18:00:00Z'},{privateToken:'leak'},{semanticValidation:'accepted'}]){
  const value=intake.projectSnapshot(request,{...snapshot,...patch} as any);assert.notEqual(value.state,'available');assert(!JSON.stringify(value).includes('privateToken'));
 }
 for(const flags of [{refreshFailure:{privateToken:'no'}},{refreshFailure:'PRIVATE_SECRET'},{stale:'false'},{privateToken:'no'}]){
  const value=intake.projectSnapshot(request,snapshot,flags as any);assert.notEqual(value.state,'available');assert(!JSON.stringify(value).includes('privateToken'));
 }
});
test('HTTP capture stays pending when initial semantics fail; another strict day can be independently projected',async()=>{
 const payload=JSON.parse(await raw());
 payload['1.1'].today.slots[0].type='unknown_provider_enum';
 const text=JSON.stringify(payload),p=profile;let gets=0;
 const intake=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now,transport:async r=>{gets++;return {url:r.url,status:200,headers:{'content-type':'application/json'},body:body(text)};}});
 const req={...request};
 const today=await intake.load(req),capture=intake.snapshotRaw(p.sourceId)!;assert(capture);assert.equal(capture.semanticValidation,'pending');
 // One corrupted today enum cannot prevent independent strict tomorrow parsing.
 assert.equal(today.state,'unavailable');const tomorrow=intake.projectSnapshot({...req,serviceDate:'2026-11-09'},capture);
 assert.equal(tomorrow.state,'available');if(tomorrow.state==='available')assert.equal(tomorrow.view.status,'not_published');assert.equal(gets,1);
});
test('quarantined Vinnytsia mirror cannot regain display from a fresh-looking old cache or another day',async()=>{
 const p=SOURCE_PROFILES.find(p=>p.sourceId==='voe-mirror-vn-progr')!,text=await readFile(new URL('voe-mirror-vn-progr.txt',dir),'utf8');let http=0;
 const intake=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now,transport:async()=>{http++;throw Error('QUARANTINED_SOURCE_GET');}});
 const captured={sourceId:p.sourceId,admissionRevisionId:'technical-display/2026-11-08/'+p.sourceId,requestedUrl:p.endpoint,responseUrl:p.endpoint,raw:text,rawSha256:createHash('sha256').update(text).digest('hex'),rawBytes:Buffer.byteLength(text),observedAt:new Date(now()).toISOString(),semanticValidation:'pending' as const};
 for(const serviceDate of ['2026-11-08','2026-11-09']){
  const req={sourceId:p.sourceId,operatorId:p.operatorId,namespace:p.namespace,targetId:'GPV1.1',serviceDate};
  for(const result of [await intake.load(req),intake.projectSnapshot(req,captured)]){assert.equal(result.state,'blocked');if(result.state==='blocked')assert.equal(result.code,'SOURCE_NOT_ADMITTED');assert.equal(result.view,null);assert.equal(result.deliveryEligible,false);}
 }
 assert.equal(http,0);
});
test('group discovery reads actual keys/text only and all candidates still require strict date parsing',async()=>{
 for(const [id,file,count] of [['yasno-kem','yasno-kem.json',60],['voe-mirror-vn-progr','voe-mirror-vn-progr.txt',12],['mirror-odesa','odesa-mirror.txt',12],['kharkiv-official-rss','kharkiv-rss.txt',12]] as const){
  assert.equal(discoverPublicSourceGroups(SOURCE_PROFILES.find(p=>p.sourceId===id)!,await readFile(new URL(file,dir),'utf8')).length,count);
 }
 assert.deepEqual(discoverPublicSourceGroups(profile,'{"2.1":{}}'),['2.1']);assert.throws(()=>discoverPublicSourceGroups(profile,'{}'));
});
test('cache snapshots are rechecked against current admission and date without HTTP or renewed observation',async()=>{
 let time=now();const text=await raw(),intake=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>time,transport:async r=>({url:r.url,status:200,headers:{'content-type':'application/json'},body:body(text)})});
 await intake.load(request);const capture=intake.snapshotRaw(profile.sourceId)!;
 time+=7200001;const stale=intake.projectSnapshot(request,capture);assert.equal(stale.state,'available');if(stale.state==='available'){assert.equal(stale.view.freshness,'stale');assert.equal(stale.view.observedAt,capture.observedAt);}
 time=Date.parse('2026-12-08T19:25:59Z');assert.equal(intake.projectSnapshot(request,capture).state,'blocked');
});
