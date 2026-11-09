import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,copyFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {build as esbuild} from '../app/node_modules/esbuild/lib/main.js';
import {withProofDatabase} from './local-runtime/disposable-proof-db.mjs';
import {CANONICAL_SCHEMA_SQL,CANONICAL_SCHEMA_SHA256,CANONICAL_REQUIRED_RELATIONS} from '../app/server/production/canonical-schema.ts';
import {createBotState} from '../app/shared/bot/engine.ts';
import {dayBounds,localParts,nextCalendarDate} from '../app/shared/schedule-core.ts';
import {normalizeYasnoRaw} from '../app/server/domain/yasno-adapter.ts';
import {buildYasnoAddressCandidate,YASNO_KYIV_ADDRESS_SCOPE} from '../app/server/domain/yasno-address-adapter.ts';
import {scheduleEventDigest as digest,createProductionScheduleEvents} from '../app/server/production/schedule-events.ts';
import {createProductionProfileStore} from '../app/server/production/profile-store.ts';
import {createRuntimeDataContext} from '../app/server/production/runtime-context.ts';
import {createSourceIngestion} from '../app/server/production/source-ingestion.ts';
import {createAddressCatalog} from '../app/server/production/address-catalog.ts';
import {SOURCE_PROFILES} from '../app/server/production/source-intake.ts';
import {createProductionEventProducer} from '../app/server/production/event-producer.ts';
import {createProductionMorningBriefing} from '../app/server/production/morning-briefing.ts';
import {createTelegramDispatcher} from '../app/server/production/telegram-dispatch.ts';
import {createSqlTelegramDispatchEligibility} from '../app/server/production/telegram-dispatch-eligibility.ts';
import {createTelegramTransport} from '../app/server/production/telegram-transport.ts';
import {createCanonicalRuntime} from '../app/server/production/canonical-runtime.ts';
import {productionRuntimePolicy} from '../app/server/runtime-policy.ts';
import {createRuntimeSourceProof} from '../app/server/production/runtime-source-proof.ts';
import {QUALIFICATION_CODE_DEPENDENCIES,DEPLOYED_QUALIFICATION_PINS,loadDeployedQualificationRegistry,createProductionScheduleCertification,createCertifiedInteractiveScheduleProof} from '../app/server/production/schedule-certification.ts';

const out='docs/certification';let fixture=out+'/synthetic-bundle';await mkdir(fixture,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex'),pin=async path=>({path,sha256:sha(await readFile(path))});
const sourceFiles=['app/server/production/schedule-certification.ts','app/server/production/deployed-schedule-qualification.ts','app/server/production/profile-store.ts','app/server/production/canonical-runtime.ts','app/server/production/runtime-context.ts','app/server/index.ts'],before=await Promise.all(sourceFiles.map(pin));
const profile=SOURCE_PROFILES.find(p=>p.sourceId==='yasno-kem'),bot='8577497098',epoch=7,base=Date.parse('2026-11-09T08:00:00Z');let time=base,mode='good',sendMode='sent',sendCount=0,nativeCalls=[];
const now=()=>new Date(time).toISOString(),signal=()=>new AbortController().signal,who={kind:'verified_server_principal',ownerId:'synthetic-certificate-owner',verified:true};
const addressPrefix='https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/';
const addressUrl=(operation,params={})=>{const u=new URL(addressPrefix+operation);u.searchParams.set('regionId','25');u.searchParams.set('dsoId','902');for(const[k,v]of Object.entries(params))u.searchParams.set(k,String(v));return u.href;};
const selection={streetId:985,streetValue:'вул. Тестова',houseId:17,houseLiteral:'1'};
const capture=(operation,body,at)=>({sourceId:'yasno-public-address-v2',method:'GET',url:addressUrl(operation,operation==='streets'?{query:selection.streetValue}:operation==='houses'?{streetId:985,query:'1'}:{streetId:985,houseId:17}),httpStatus:200,contentType:'application/json',observedAt:at,rawBody:JSON.stringify(body),rawSha256:sha(JSON.stringify(body))});
function captures(at){return {streets:capture('streets',[{id:985,value:selection.streetValue}],new Date(at-3000).toISOString()),houses:capture('houses',[{id:17,value:'1'}],new Date(at-2000).toISOString()),group:capture('group',{group:1,subgroup:1},new Date(at-1000).toISOString())};}
const addressId='provisional:yasno:25/902:street:985:house:17';
function body(at,changed=false){const date=localParts(at).date;const day=d=>({date:d+'T00:00:00+02:00',status:'ScheduleApplies',slots:[{start:0,end:changed?780:720,type:'NotPlanned'},{start:changed?780:720,end:840,type:'Definite'},{start:840,end:1440,type:'NotPlanned'}]});return JSON.stringify({'1.1':{updatedOn:new Date(at-1000).toISOString(),today:day(date),tomorrow:day(nextCalendarDate(date))}});}
const semantic=v=>({operatorId:v.operatorId,namespace:v.namespace,targetId:v.targetId,serviceDate:v.serviceDate,status:v.status,dayCoverage:v.dayCoverage,intervals:v.intervals});
async function jsonFile(name,value){const p=fixture+'/'+name;await writeFile(p,JSON.stringify(value));return pin(p);}
async function rawFile(name,value){const p=fixture+'/'+name;await writeFile(p,value);return pin(p);}
async function makeBundle(edit={},name='synthetic-bundle'){
 fixture=out+'/'+name;await mkdir(fixture,{recursive:true});
 const codePins=await Promise.all(QUALIFICATION_CODE_DEPENDENCIES.map(pin)),cap=captures(base-3600000),capRefs={};for(const k of Object.keys(cap))capRefs[k]=await jsonFile('address-'+k+'.json',cap[k]);
 const primary={endpoint:profile.endpoint,upstreamChain:['operator:dtek-kem','yasno-public-feed'],acquisitionId:'synthetic-primary-http',accessCost:0,evidence:'Synthetic transport fixture; never a real source qualification'};
 // Sharing the DSO upstream does not disqualify a free fallback transport.
 const fallback={...primary,endpoint:'https://fixture.invalid/fallback',acquisitionId:'synthetic-fallback-http'},control={...primary,endpoint:'https://fixture.invalid/operator-control',acquisitionId:'synthetic-independent-control'};
 const observations=[];
 for(let i=0;i<=8;i++){const at=base-49*3600000+i*6*3600000,observedAt=new Date(at).toISOString(),serviceDate=localParts(at).date,raw=body(at),rawRef=await rawFile('plan-'+i+'.json',raw);
  const view=normalizeYasnoRaw(raw,'today',{namespace:'yasno:25/902',operatorId:profile.operatorId,targetId:'1.1',addressId,addressLabel:'Synthetic',localityLabel:'Київ',serviceDate,observedAt,source:{id:profile.sourceId,name:profile.name,url:profile.endpoint,revision:rawRef.sha256,accessCost:0,verifiedLevel:'schedule'},freshness:'current',synthetic:false});
  const row={addressId,targetId:'1.1',serviceDate,observedAt};for(const role of ['primary','fallback','control'])row[role]=await jsonFile('observation-'+i+'-'+role+'.json',{kind:'lba-observed-plan-fact/1',acquisitionId:{primary,fallback,control}[role].acquisitionId,observedAt,addressId,targetId:'1.1',serviceDate,raw:rawRef,plan:semantic(view)});observations.push(row);
 }
 const negativeFixtures=[];for(const[i,raw]of ['{}','null','{"1.1":{"today":{}}}'].entries())negativeFixtures.push({raw:await rawFile('negative-'+i+'.json',raw),observedAt:now(),serviceDate:localParts(time).date,targetId:'1.1'});
 const b={kind:'lba-reviewed-schedule-qualification/1',sourceId:profile.sourceId,operatorId:profile.operatorId,namespace:profile.namespace,reviewedAt:new Date(base-3600000).toISOString(),validUntil:new Date(base+86400000).toISOString(),medium:'synthetic_fixture',codePins,primary,fallback,control,coverage:{kind:'exact_addresses',addressIds:[addressId]},addresses:[{addressId,...selection,targetId:'1.1',captures:capRefs}],observations,maximumObservationGapMs:6*3600000,negativeFixtures,...edit};
 const bundle=await jsonFile('bundle.json',b),receipt=await jsonFile('review.json',{kind:'lba-independent-qualification-review/1',bundleSha256:bundle.sha256,reviewer:'synthetic-fixture-review-boundary-only',reviewedAt:b.reviewedAt,medium:b.medium,inventorySha256:digest({codePins:b.codePins,addresses:b.addresses,observations:b.observations,negativeFixtures:b.negativeFixtures,coverage:b.coverage,primary:b.primary,fallback:b.fallback,control:b.control})});return {bundle,reviewReceipt:receipt};
}
const tests=[];const check=async(name,fn)=>{await fn();tests.push({name,status:'pass'});console.log('PASS '+name);};
let clusterTarget;
try{await withProofDatabase('certification_next',55466,async(pool,target)=>{
 clusterTarget=target;await pool.query('create table users(id varchar(255) primary key);create table linked_accounts(id text primary key,user_id varchar(255) references users(id),provider text,provider_id text);create table user_settings(user_id text primary key,telegram_chat_id text);create table telegram_subscribers(chat_id text primary key,user_id text,enabled boolean);create table user_locations(id integer primary key,user_id text)');
 await pool.query(CANONICAL_SCHEMA_SQL);await pool.query("insert into lba_production_control values(true,7,'canonical')");
 const transport=async request=>({url:request.url,status:200,headers:{'content-type':'application/json'},body:(async function*(){yield Buffer.from(body(time,mode==='changed'));})()});
 let sources=createSourceIngestion({enabled:true,expectedControlEpoch:epoch,pool,transport,now:()=>time});
 let catalog=createAddressCatalog({enabled:true,expectedControlEpoch:epoch,pool,transport:async()=>{throw Error('SYNTHETIC_CATALOG_HTTP_NOT_USED_IN_SLICE');},now:()=>time});
 let service,data,events;
 const store=createProductionProfileStore({enabled:true,expectedControlEpoch:epoch,pool,now,context:input=>data?data.forProfile(input):{addresses:[],plans:[]}});
 async function seed(age=0){
  const state=createBotState({ownerId:who.ownerId,sessionId:randomUUID()});state.profile.preferences.optedIn=true;state.profile.preferences.paused=false;state.profile.preferences.quietHours.enabled=false;delete state.profile.preferences.notificationPolicy;
  const cap=captures(time-age),built=buildYasnoAddressCandidate({scope:YASNO_KYIV_ADDRESS_SCOPE,selection,captures:cap,policy:{asOf:now(),maximumCaptureAgeMs:600000}}),option={id:built.address.id,address:{...built.address,label:'Мій дім'},binding:built.binding,territoryLabel:'Київ'};
  state.profile.locations=[{address:option.address,binding:built.binding,notifications:true,paused:false}];state.profile.primaryAddressId=addressId;state.currentAddressId=addressId;
  await pool.query('insert into users values($1)',[who.ownerId]);await pool.query("insert into linked_accounts values('synthetic-link',$1,'telegram','700001')",[who.ownerId]);await pool.query("insert into telegram_subscribers values('700001',$1,true)",[who.ownerId]);
  await pool.query('insert into lba_production_profiles values($1,$2,0,7,$3,$4,$4)',[who.ownerId,state.sessionId,JSON.stringify(state),now()]);const h='a'.repeat(64);await pool.query("insert into lba_production_profile_origins values($1,$2,$2,'{}',$3,7)",[who.ownerId,h,now()]);await pool.query("insert into lba_production_bootstrap_ledger values($1,$2,$3,'legacy',$4,7)",[who.ownerId,state.sessionId,h,now()]);
  const ids={};for(const[k,v]of Object.entries(cap)){ids[k]=randomUUID();await pool.query('insert into lba_public_address_capture values($1,$2,$3,$4,$5,7)',[ids[k],k,v.url,JSON.stringify(v),v.observedAt]);await pool.query('insert into lba_public_address_query values($1,$2,$3,null,$4)',[sha(v.url),v.url,v.observedAt,ids[k]]);}
  await pool.query('insert into lba_public_address_candidate values($1,$2,$3,$4)',[addressId,ids.streets,ids.houses,ids.group]);
  const result={state:'available',option,candidateProof:built.proof,snapshotId:ids.group,observedAt:cap.group.observedAt,expiresAt:new Date(time+599000).toISOString()};
  await pool.query("insert into lba_production_address_lookup values($1,$2,'synthetic-resolve',$3,1,$4,$5)",[who.ownerId,state.sessionId,h,JSON.stringify({directoryId:'yasno:25/902',optionIds:[addressId],catalogStatus:'ready'}),now()]);
  await pool.query("insert into lba_production_address_lookup_requests values($1,$2,'synthetic-resolve',$3,$4,$5)",[who.ownerId,state.sessionId,h,JSON.stringify(result),now()]);
  return state;
 }
 const fixturePin=await makeBundle(),registry=await loadDeployedQualificationRegistry({rootDirectory:process.cwd(),pins:[fixturePin],purpose:'synthetic_test'});
 const state=await seed();const refreshed=await sources.refreshOnce('yasno-kem');assert.equal(refreshed.state,'published',JSON.stringify(refreshed));
 service=createProductionScheduleCertification({enabled:true,expectedControlEpoch:epoch,pool,store,sources,catalog,now:()=>time,registry,execution:'synthetic_test'});
 events=createProductionScheduleEvents({enabled:true,expectedControlEpoch:epoch,store,verifyCurrentSource:r=>service.verifyCurrentSource(r)});
 data=createRuntimeDataContext({sources,catalog,now:()=>time,operatorLabels:{[profile.operatorId]:profile.name},certifiedProjection:()=>service.readCertifiedProjection()});
 const native=async(url,request)=>{const method=url.split('/').at(-1),b=request.body?JSON.parse(Buffer.from(request.body).toString()):null;nativeCalls.push({method});if(method!=='getMe'){sendCount++;if(sendMode==='unknown')throw Error('SYNTHETIC_NATIVE_UNKNOWN');}
  const payload=method==='getMe'?{ok:true,result:{id:Number(bot),is_bot:true,username:'PowerUkraineBot',first_name:'Synthetic QA'}}:{ok:true,result:{message_id:100+sendCount,chat:{id:Number(b.chat_id),type:'private'},from:{id:Number(bot),is_bot:true}}};return {url,status:200,headers:{get:k=>k==='content-type'?'application/json':null},body:(async function*(){yield Buffer.from(JSON.stringify(payload));})()};};
 const interactive=createCertifiedInteractiveScheduleProof(events,epoch),rawInteractive=createRuntimeSourceProof({expectedControlEpoch:epoch});
 const eligibility=createSqlTelegramDispatchEligibility({expectedBotId:bot,expectedControlEpoch:epoch,verifySource:r=>r.job.payload.message.kind==='notification'?events.verifyDispatch(r):r.job.payload.schedule?.deliveryEligible?interactive(r):rawInteractive(r)});
 const dispatcher=createTelegramDispatcher({enabled:true,expectedBotId:bot,expectedControlEpoch:epoch,pool,workerId:'synthetic-certification-dispatch',now,...eligibility,identityReadGrant:async r=>({...r,expiresAt:new Date(time+1000).toISOString()}),createTransport:({authorize})=>createTelegramTransport({expectedBotId:bot,token:bot+':ClearlySyntheticCertificateToken',authorize,now:()=>time,fetch:native}),limits:{minBotIntervalMs:0,minChatIntervalMs:0}});
 await pool.query('insert into lba_production_telegram_bot_state(bot_id,updated_at) values($1,$2)',[bot,now()]);
 await check('representative actual own-PG slice: reviewed synthetic artifacts → canonical binding → certificate → projection → interactive proof → event producer → shared dispatcher',async()=>{
  assert.equal(DEPLOYED_QUALIFICATION_PINS.length,0);assert.equal((await loadDeployedQualificationRegistry({rootDirectory:'/path/not/read'})).bundleCount,0);
  const technical=(await sources.readTechnicalPlans()).plans.find(p=>p.view.serviceDate===localParts(time).date).view;
  const issued=await service.issue({state,view:{...technical,addressId},signal:signal()});assert.equal(issued.kind,'issued');assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate')).rows[0].n,1);
  const current=(await pool.query('select state from lba_production_profiles where owner_id=$1',[who.ownerId])).rows[0].state;assert.equal(current.revision,1);assert.equal(current.profile.locations[0].binding.status,'verified');assert.deepEqual(current.profile.preferences,state.profile.preferences);assert.deepEqual(current.profile.locations[0].address,state.profile.locations[0].address);
  await data.refresh();const snapshot=await store.snapshot(who),view=snapshot.plans.find(v=>v.serviceDate===localParts(time).date);assert.equal(view.deliveryEligible,true);assert.equal(view.source.verifiedLevel,'integration');assert.equal(view.notice,'План для цієї адреси. Час та інтервали можуть змінюватися.');
  const client=await pool.connect();try{await client.query('begin');assert(await events.qualifySchedule({client,state:current,view,now:now(),signal:signal()}));await client.query('commit');}finally{client.release();}
  const turn=await store.commitBotInput(who,{input:{id:'synthetic-schedule',kind:'command',text:'/schedule'}});assert.equal(turn.receipt.delivery,'pending');assert.equal((await dispatcher.dispatchNextPending(signal())).kind,'completed');assert.equal(sendCount,1);
  const producer=createProductionEventProducer({enabled:true,expectedControlEpoch:epoch,pool,events,now});const produced=await producer.runOnce({signal:signal()});assert.equal(produced.committed,1);assert.equal((await dispatcher.dispatchNextPending(signal())).kind,'completed');assert.equal(sendCount,2);await producer.stop();
  const row=(await pool.query('select record from lba_production_schedule_certificate')).rows[0].record;assert.equal(row.sourceEvidence.acceptedAt,now());assert(Date.parse(row.sourceEvidence.acceptedAt)>=Date.parse(view.observedAt));assert.equal(row.parallel48hEvidence.finishedAt,row.parallel48hEvidence.acceptedAt);
 });
 async function reset(age=0){
  time=base;mode='good';sendMode='sent';sendCount=0;nativeCalls=[];
  await pool.query('truncate users,linked_accounts,telegram_subscribers,user_settings,user_locations,lba_production_profiles,lba_production_bootstrap_ledger,lba_production_telegram_bot_state,lba_production_telegram_chat_state,lba_production_telegram_dispatch_jobs,lba_public_source_worker,lba_public_source_origin,lba_public_source_state,lba_public_source_run,lba_public_address_capture,lba_public_address_query,lba_public_address_candidate,lba_production_event_producer_lease restart identity cascade');
  await pool.query("update lba_production_control set control_epoch=7,writer_mode='canonical'");
  sources=createSourceIngestion({enabled:true,expectedControlEpoch:epoch,pool,transport,now:()=>time});catalog=createAddressCatalog({enabled:true,expectedControlEpoch:epoch,pool,transport:async()=>{throw Error('SYNTHETIC_CATALOG_HTTP_NOT_USED_IN_SLICE');},now:()=>time});
  const state=await seed(age);const result=await sources.refreshOnce('yasno-kem');assert.equal(result.state,'published',JSON.stringify(result));
  service=createProductionScheduleCertification({enabled:true,expectedControlEpoch:epoch,pool,store,sources,catalog,now:()=>time,registry,execution:'synthetic_test'});
  events=createProductionScheduleEvents({enabled:true,expectedControlEpoch:epoch,store,verifyCurrentSource:r=>service.verifyCurrentSource(r)});
  data=createRuntimeDataContext({sources,catalog,now:()=>time,operatorLabels:{[profile.operatorId]:profile.name},certifiedProjection:()=>service.readCertifiedProjection()});
  await pool.query('insert into lba_production_telegram_bot_state(bot_id,updated_at) values($1,$2)',[bot,now()]);
  return {state,view:{...(await sources.readTechnicalPlans()).plans.find(p=>p.view.serviceDate===localParts(time).date).view,addressId}};
 }
 async function qualified(age=0){const f=await reset(age);const result=await service.issue({...f,signal:signal()});assert.equal(result.kind,'issued');await data.refresh();const state=(await pool.query('select state from lba_production_profiles where owner_id=$1',[who.ownerId])).rows[0].state;const view=(await store.snapshot(who)).plans.find(v=>v.serviceDate===localParts(time).date);return {state,view,id:result.certificateId};}
 async function qualify(f){const c=await pool.connect();try{await c.query('begin');const q=await events.qualifySchedule({client:c,state:f.state,view:f.view,now:now(),signal:signal()});await c.query('commit');return q;}finally{c.release();}}
 await check('authority stays empty in production; arbitrary pins, observed relabel and forged registries are rejected; disabled service has zero effects',async()=>{
  await assert.rejects(loadDeployedQualificationRegistry({rootDirectory:process.cwd(),pins:[fixturePin]}),/DEPLOYED_PINS_ONLY/);
  const relabel=await makeBundle({medium:'observed'},'relabel-fixture');await assert.rejects(loadDeployedQualificationRegistry({rootDirectory:process.cwd(),pins:[relabel],purpose:'synthetic_test'}),/BUNDLE_INVALID/);
  assert.throws(()=>createProductionScheduleCertification({enabled:true,expectedControlEpoch:epoch,pool,store,sources,catalog,registry:{medium:'observed',bundleCount:1}}),/REGISTRY_AUTHORITY_REQUIRED/);
  assert.throws(()=>createProductionScheduleCertification({enabled:true,expectedControlEpoch:epoch,pool,store,sources,catalog,registry}),/REGISTRY_AUTHORITY_REQUIRED/);
  let effects=0;const disabled=createProductionScheduleCertification({enabled:false,expectedControlEpoch:epoch,pool:{connect:async()=>{effects++;throw Error('NO');}},store,sources,catalog,registry,execution:'synthetic_test'});
  await disabled.runOnce({signal:signal()});await disabled.issue({state,view:{},signal:signal()});await disabled.readCertifiedProjection();assert.equal(effects,0);
 });
 await check('bundle loader actually rejects changed KH parser, hour-matrix parser and dependency-lock bytes under unchanged review pins',async()=>{
  const proofRoot=await mkdtemp(path.resolve(out,'pin-negative-')),b=JSON.parse(await readFile(fixturePin.bundle.path)),refs=new Map();
  const walk=v=>{if(!v||typeof v!=='object')return;if(typeof v.path==='string'&&typeof v.sha256==='string')refs.set(v.path,v);for(const x of Object.values(v))walk(x);};walk(b);walk(fixturePin);
  for(const name of refs.keys()){const dest=path.join(proofRoot,name);await mkdir(path.dirname(dest),{recursive:true});await copyFile(name,dest);}
  for(const name of ['app/server/domain/kharkiv-adapter.ts','app/server/domain/hour-matrix-adapter.ts','app/package-lock.json']){const dest=path.join(proofRoot,name),bytes=await readFile(dest);await writeFile(dest,Buffer.concat([bytes,Buffer.from('\n')]));await assert.rejects(loadDeployedQualificationRegistry({rootDirectory:proofRoot,pins:[fixturePin],purpose:'synthetic_test'}),/FILE_HASH_MISMATCH/);await writeFile(dest,bytes);}
 });
 await check('missing 48h, observation gaps, incomplete representative coverage, paid route and duplicate control acquisition cannot qualify',async()=>{
  const original=JSON.parse(await readFile(fixturePin.bundle.path));
  for(const [name,patch]of [['short',{observations:original.observations.slice(0,-1)}],['gap',{maximumObservationGapMs:3600000}],['coverage',{coverage:{kind:'representative',addressIds:[addressId]}}],['paid',{fallback:{...original.fallback,accessCost:1}}],['control',{control:{...original.control,acquisitionId:original.primary.acquisitionId}}]]){
   const p=await makeBundle(patch,'negative-'+name);await assert.rejects(loadDeployedQualificationRegistry({rootDirectory:process.cwd(),pins:[p],purpose:'synthetic_test'}));
  }
 });
 await check('two concurrent issuers serialize on canonical owner; one certificate and one binding revision, exact restart replay',async()=>{
  const f=await reset(),results=await Promise.all([service.issue({...f,signal:signal()}),service.issue({...f,signal:signal()})]);assert.deepEqual(results.map(x=>x.kind).sort(),['issued','replayed']);assert.equal((await pool.query('select revision from lba_production_profiles')).rows[0].revision,'1');assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate where revoked_at is null')).rows[0].n,1);
  assert.equal((await service.issue({...f,signal:signal()})).kind,'replayed');
 });
 await check('rollback after canonical binding persistence also rolls back certificate, cancellations and revision',async()=>{
  const f=await reset(),badPool={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(...args)=>{if(String(args[0]).startsWith('insert into lba_production_schedule_certificate'))throw Error('SYNTHETIC_INSERT_FAILURE');return c.query(...args);}};}};
  const badStore=createProductionProfileStore({enabled:true,expectedControlEpoch:epoch,pool:badPool,now,context:()=>({addresses:[],plans:[]})}),issuer=createProductionScheduleCertification({enabled:true,expectedControlEpoch:epoch,pool,store:badStore,sources,catalog,registry,execution:'synthetic_test',now:()=>time});
  await assert.rejects(issuer.issue({...f,signal:signal()}));assert.equal((await pool.query('select revision from lba_production_profiles')).rows[0].revision,'0');assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate')).rows[0].n,0);
 });
 await check('lost actual COMMIT acknowledgement is read back without a second certificate or binding revision',async()=>{
  const f=await reset();let lost=false;const unknownPool={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(...args)=>{const r=await c.query(...args);if(String(args[0])==='commit'&&!lost){lost=true;throw Error('SYNTHETIC_COMMIT_ACK_LOST');}return r;}};}};
  const unknownStore=createProductionProfileStore({enabled:true,expectedControlEpoch:epoch,pool:unknownPool,now,context:()=>({addresses:[],plans:[]})}),issuer=createProductionScheduleCertification({enabled:true,expectedControlEpoch:epoch,pool,store:unknownStore,sources,catalog,registry,execution:'synthetic_test',now:()=>time});
  await assert.rejects(issuer.issue({...f,signal:signal()}),/PRODUCTION_COMMIT_UNKNOWN/);assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate')).rows[0].n,1);assert.equal((await service.issue({...f,signal:signal()})).kind,'replayed');assert.equal((await pool.query('select revision from lba_production_profiles')).rows[0].revision,'1');
 });
 await check('address TTL expires inside the30s context generation; expired proof cannot project or qualify',async()=>{
  const f=await qualified(590000);assert.equal(f.view.deliveryEligible,true);const cert=(await pool.query('select record from lba_production_schedule_certificate')).rows[0].record;assert.equal(Date.parse(cert.expiresAt)-base,7000);time+=8000;assert.equal((await store.snapshot(who)).plans.find(v=>v.serviceDate===localParts(time).date).deliveryEligible,false);assert.equal(await qualify(f),null);assert.equal((await service.readCertifiedProjection()).length,0);
 });
 await check('new current address group contradicts old certificate immediately at qualification and in context, before issuer runs',async()=>{
  const f=await qualified(),old=(await pool.query("select c.* from lba_public_address_capture c join lba_public_address_candidate p on p.group_id=c.id where p.address_id=$1",[addressId])).rows[0],capture={...old.capture,rawBody:'{"group":2,"subgroup":1}',rawSha256:sha('{"group":2,"subgroup":1}')},id=randomUUID();
  await pool.query('insert into lba_public_address_capture values($1,$2,$3,$4,$5,7)',[id,'group',old.request_url,JSON.stringify(capture),capture.observedAt]);await pool.query('update lba_public_address_query set latest_capture_id=$2 where request_url=$1',[old.request_url,id]);await pool.query('update lba_public_address_candidate set group_id=$2 where address_id=$1',[addressId,id]);
  assert.equal(await qualify(f),null);await data.refresh();const shown=(await store.snapshot(who)).plans.find(v=>v.serviceDate===localParts(time).date);assert.equal(shown.deliveryEligible,false);assert.equal(shown.status,'needs_confirmation');assert.equal(shown.intervals.length,0);
 });
 await check('current address lookup failure, revoked cert and empty registry each deny exact interactive and notification qualification',async()=>{
  let f=await qualified();await pool.query("update lba_public_address_query set last_failure='ADDRESS_HTTP_REJECTED',last_attempt_at=$1",[now()]);assert.equal(await qualify(f),null);
  f=await qualified();await pool.query('update lba_production_schedule_certificate set revoked_at=$1',[now()]);assert.equal(await qualify(f),null);await assert.rejects(service.issue({state:f.state,view:{...f.view,deliveryEligible:false,source:{...f.view.source,verifiedLevel:'schedule'}},signal:signal()}),/CERTIFICATE_REPLAY_CONFLICT/);
  f=await qualified();service.setRegistry(await loadDeployedQualificationRegistry({rootDirectory:'/not/read'}));assert.equal(await qualify(f),null);assert.equal((await service.readCertifiedProjection()).length,0);
 });
 await check('owner selection, session, epoch and DSO mismatches never bootstrap or issue a certificate',async()=>{
  for(const kind of ['selection','session','epoch','operator']){const f=await reset();if(kind==='selection')await pool.query('delete from lba_production_address_lookup_requests');if(kind==='session')f.state.sessionId='foreign';if(kind==='epoch')await pool.query('update lba_production_control set control_epoch=8');if(kind==='operator'){f.state.profile.locations[0].binding.operatorId='other-dso';await pool.query('update lba_production_profiles set state=$2 where owner_id=$1',[who.ownerId,JSON.stringify(f.state)]);}
   try{assert.notEqual((await service.issue({...f,signal:signal()})).kind,'issued');}catch{}assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate')).rows[0].n,0);
  }
 });
 await check('new eligible raw revision qualifies automatically and revokes the previous view without manual approval',async()=>{
  const f=await qualified();time+=300001;mode='changed';assert.equal((await sources.refreshOnce('yasno-kem')).state,'published');const current=(await pool.query('select state from lba_production_profiles')).rows[0].state,technical={...(await sources.readTechnicalPlans()).plans.find(p=>p.view.serviceDate===localParts(time).date).view,addressId,notice:'Оператор попереджає: можливі зміни через аварійні роботи.'};assert.equal((await service.issue({state:current,view:technical,signal:signal()})).kind,'issued');assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate where revoked_at is null')).rows[0].n,1);assert.equal(await qualify(f),null);assert.equal((await pool.query('select record from lba_production_schedule_certificate where revoked_at is null')).rows[0].record.view.notice,technical.notice);assert.equal((await pool.query('select revision from lba_production_profiles')).rows[0].revision,'1');
 });
 await check('rename between cached certificate and context never emits the old label; issuer preserves edits and recertifies current exact label',async()=>{
  const f=await qualified(),result=await store.commitProfileMutation(who,{id:'synthetic-rename',expectedSessionId:f.state.sessionId,expectedRevision:f.state.revision,mutation:{kind:'rename',addressId,label:'Новий дім'}});assert.equal(result.snapshot.profile.locations[0].address.label,'Новий дім');
  assert.equal((await store.snapshot(who)).plans.find(v=>v.serviceDate===localParts(time).date).deliveryEligible,false);const current=(await pool.query('select state from lba_production_profiles')).rows[0].state;assert.equal(await events.qualifySchedule({client:pool,state:current,view:f.view,now:now(),signal:signal()}),null);
  const producer=createProductionEventProducer({enabled:true,expectedControlEpoch:epoch,pool,events,now});assert.equal((await producer.runOnce({signal:signal()})).committed,0);await producer.stop();
  const raw={...(await sources.readTechnicalPlans()).plans.find(p=>p.view.serviceDate===localParts(time).date).view,addressId};assert.equal((await service.issue({state:current,view:raw,signal:signal()})).kind,'issued');await data.refresh();const view=(await store.snapshot(who)).plans.find(v=>v.serviceDate===localParts(time).date);assert.equal(view.addressLabel,'Новий дім');assert.equal(view.deliveryEligible,true);assert.deepEqual((await pool.query('select state from lba_production_profiles')).rows[0].state.profile.preferences,f.state.profile.preferences);
 });
 await check('cross-owner certificate borrowing and manual group upgrade are denied without changing either profile',async()=>{
  const f=await qualified(),other=createBotState({ownerId:'synthetic-other-owner',sessionId:randomUUID()});other.profile.locations=structuredClone(f.state.profile.locations);other.profile.primaryAddressId=addressId;other.currentAddressId=addressId;await pool.query('insert into lba_production_profiles values($1,$2,0,7,$3,$4,$4)',[other.ownerId,other.sessionId,JSON.stringify(other),now()]);const h='b'.repeat(64);await pool.query("insert into lba_production_profile_origins values($1,$2,$2,'{}',$3,7)",[other.ownerId,h,now()]);await pool.query("insert into lba_production_bootstrap_ledger values($1,$2,$3,'legacy',$4,7)",[other.ownerId,other.sessionId,h,now()]);assert.equal(await events.qualifySchedule({client:pool,state:other,view:f.view,now:now(),signal:signal()}),null);assert.notEqual((await service.issue({state:other,view:f.view,signal:signal()})).kind,'issued');assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate')).rows[0].n,1);
  const a=await reset();a.state.profile.locations[0].binding.kind='user_selected_group';await pool.query('update lba_production_profiles set state=$2 where owner_id=$1',[who.ownerId,JSON.stringify(a.state)]);assert.notEqual((await service.issue({...a,signal:signal()})).kind,'issued');assert.equal((await pool.query('select revision from lba_production_profiles')).rows[0].revision,'0');
 });
 await check('notification opt-out survives binding certification and suppresses autonomous messages; native unknown stays globally held across subsequent dispatch',async()=>{
  const f=await reset();f.state.profile.preferences.optedIn=false;f.state.profile.preferences.paused=true;await pool.query('update lba_production_profiles set state=$2 where owner_id=$1',[who.ownerId,JSON.stringify(f.state)]);assert.equal((await service.issue({...f,signal:signal()})).kind,'issued');await data.refresh();const producer=createProductionEventProducer({enabled:true,expectedControlEpoch:epoch,pool,events,now});assert.equal((await producer.runOnce({signal:signal()})).committed,0);assert.equal(sendCount,0);const after=(await pool.query('select state from lba_production_profiles')).rows[0].state;assert.equal(after.profile.preferences.optedIn,false);assert.equal(after.profile.preferences.paused,true);await producer.stop();
  const q=await qualified();await store.commitBotInput(who,{input:{id:'synthetic-unknown',kind:'command',text:'/schedule'}});sendMode='unknown';const result=await dispatcher.dispatchNextPending(signal());assert.equal(result.kind,'unknown');const calls=nativeCalls.length;assert.equal((await dispatcher.dispatchNextPending(signal())).kind,'held');assert.equal(nativeCalls.length,calls);
 });
 await check('worker rereads canonical revision after first binding and certifies both service days in one bounded pass',async()=>{
  await reset();const issuer=createProductionScheduleCertification({enabled:true,expectedControlEpoch:epoch,pool,store,sources,catalog:{...catalog,searchStreets:async()=>({state:'unavailable',code:'ADDRESS_STORAGE_UNAVAILABLE'})},registry,execution:'synthetic_test',now:()=>time});const result=await issuer.runOnce({signal:signal()});assert.equal(result.issued,2);assert.equal(result.pending,0);assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate where revoked_at is null')).rows[0].n,2);
 });
 await check('actual canonical prepare/start/stop owns the certificate worker; fixture registry enables code closure while empty real registry projects no certified data',async()=>{
  await reset();let fetches=0;const policy=productionRuntimePolicy({NODE_ENV:'production',DATABASE_URL:'postgres://synthetic:pass@fixture.invalid/database',SESSION_SECRET:'synthetic-session-'.repeat(4),JWT_SECRET:'synthetic-jwt-'.repeat(4),TELEGRAM_BOT_TOKEN:bot+':ClearlySyntheticCertificateToken',TELEGRAM_WEBHOOK_SECRET:'synthetic-webhook',LBA_PRODUCT_PROFILE_MODE:'active',LBA_CANONICAL_CONTROL_EPOCH:'7',LBA_SOURCE_INGESTION:'enabled',LBA_AUTH_REPLAY_GUARD:'enabled'});
  const fetchPort=async(url,request)=>{fetches++;const r=new Response(body(time),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;};
  const runtime=createCanonicalRuntime({pool,policy,token:bot+':ClearlySyntheticCertificateToken',origin:'https://power-ukraine.net',fetch:fetchPort,now:()=>time,certification:{rootDirectory:process.cwd(),registry,execution:'synthetic_test'}});assert.equal(fetches,0);await runtime.prepare();runtime.start();
  const until=Date.now()+8000;while(Date.now()<until){if((await pool.query('select count(*)::int n from lba_production_schedule_certificate')).rows[0].n===2)break;await new Promise(r=>setTimeout(r,50));}
  assert.equal((await pool.query('select count(*)::int n from lba_production_schedule_certificate')).rows[0].n,2);await runtime.stop();const nativeBefore=nativeCalls.length;assert.equal(runtime.health().scheduleCertification.admittedSources,1);assert.equal(runtime.health().scheduleCertification.evidenceMedium,'synthetic_fixture');assert.equal(runtime.health().notificationsReady,false);assert.equal(nativeCalls.length,nativeBefore);
  const plain=createCanonicalRuntime({pool,policy,token:bot+':ClearlySyntheticCertificateToken',origin:'https://power-ukraine.net',fetch:fetchPort,now:()=>time,certification:{rootDirectory:process.cwd()}});await plain.prepare();assert.equal(plain.health().scheduleCertification.admittedSources,0);assert.equal((await plain.store.snapshot(who)).plans.some(v=>v.deliveryEligible),false);await plain.stop();
 });
 await check('actual compiled CJS entry resolves the same deployed bundle from app, candidate and foreign workspace cwd',async()=>{
  const directory=path.resolve('app/dist-qualification-proof');await mkdir(directory,{recursive:true});const entry=path.join(directory,'entry.ts'),compiled=path.join(directory,'index.cjs');
  await writeFile(entry,`import {qualificationRootFromEntryDirectory,loadDeployedQualificationRegistry} from '../server/production/schedule-certification.ts';const root=qualificationRootFromEntryDirectory(__dirname);loadDeployedQualificationRegistry({rootDirectory:root,pins:${JSON.stringify([fixturePin])},purpose:'synthetic_test'}).then(r=>console.log(JSON.stringify({root,medium:r.medium,count:r.bundleCount})));`);
  await esbuild({entryPoints:[entry],outfile:compiled,bundle:true,platform:'node',target:'node20',format:'cjs',packages:'external',logLevel:'silent'});
  for(const cwd of [process.cwd(),path.resolve('app'),path.resolve('../../../..')]){const result=spawnSync(process.execPath,[compiled],{cwd,encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout.trim());assert.equal(data.root,process.cwd());assert.equal(data.count,1);assert.equal(data.medium,'synthetic_fixture');}
 });

});
const after=await Promise.all(sourceFiles.map(pin));assert.deepEqual(after,before);await writeFile(out+'/author-pg.json',JSON.stringify({actor:'/root/production_campaign_worker',tests,passed:tests.length,sourceBefore:before,sourceAfter:after,sourceDrift:false,driver:await pin('tools/lba_certificate_pg.mjs'),canonicalSchemaSha256:CANONICAL_SCHEMA_SHA256,tables:CANONICAL_REQUIRED_RELATIONS.length,actualPostgres:true,target:clusterTarget,syntheticEvidenceReviewBoundary:true,actualIndependentAcceptance:false,actualSourceAdmissionCount:DEPLOYED_QUALIFICATION_PINS.length,syntheticNativeTransport:true,realProviderRequests:0,productionEffects:0,clusterStopped:true},null,2)+'\n');
}catch(error){await writeFile(out+'/author-failure.json',JSON.stringify({tests,error:String(error?.message),stack:error?.stack},null,2)+'\n');throw error;}
