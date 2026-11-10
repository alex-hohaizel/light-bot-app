import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dayBounds} from '../../shared/schedule-core.ts';
import {createSourceIntake,SOURCE_PROFILES,type SourceIntakeRequest,type SourceHttpTransport,type TechnicalDisplayAdmission} from '../../server/production/source-intake.ts';
import {technicalDisplaySourceRegistry,odesaPlanApiOperatingRecord,historicalOdesaPlanApiOperatingRecord,OWNER_APPROVED_INITIAL_LAUNCH} from '../../server/production/source-operating-policy.ts';
import {validOdesaPlanOperatingRecord} from '../../server/production/odesa-plan-source.ts';
import {normalizeOdesaPlanApi,type OdesaPlanApiCapture} from '../../server/domain/odesa-plan-api-adapter.ts';
import {createSourceIngestion} from '../../server/production/source-ingestion.ts';
const now='2026-11-10T10:05:00Z',time=Date.parse(now),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const read=(file:string)=>readFileSync(new URL('./fixtures/'+file,import.meta.url),'utf8');
const vn=read('vinnytsia-mirror-2026-11-10.json'),kh=read('kharkiv-rss-2026-11-10.xml');
const request=(sourceId='voe-mirror-vn-progr',serviceDate='2026-11-10',targetId='GPV1.1'):SourceIntakeRequest=>{const p=SOURCE_PROFILES.find(p=>p.sourceId===sourceId)!;return {sourceId,operatorId:p.operatorId,namespace:p.namespace,targetId,serviceDate};};
const transport=(raw:string,type='text/plain'):SourceHttpTransport=>async req=>({url:req.url,status:200,headers:{'content-type':type},body:(async function*(){yield Buffer.from(raw);})()});
const reader=(raw=vn,type='text/plain',clock=time)=>createSourceIntake({registry:technicalDisplaySourceRegistry(true),transport:transport(raw,type),now:()=>clock});
const mutate=(raw:string,change:(v:any)=>void)=>{const v=JSON.parse(raw);change(v);return JSON.stringify(v);};

test('owner initial-launch operating policy is explicit, finite30days, inert by default and preserves unverified claims',()=>{
 assert(technicalDisplaySourceRegistry().every(e=>e.state==='blocked'));assert.equal(odesaPlanApiOperatingRecord(),null);
 assert.equal(Date.parse(OWNER_APPROVED_INITIAL_LAUNCH.validUntil)-Date.parse(OWNER_APPROVED_INITIAL_LAUNCH.reviewedAt),30*86400000);
 const entries=technicalDisplaySourceRegistry(true);
 assert.deepEqual(entries.filter(e=>e.state!=='blocked').map(e=>e.sourceId).sort(),['kharkiv-official-rss','mirror-odesa','voe-mirror-vn-progr','yasno-kem']);
 for(const sourceId of ['voe-mirror-olnet93','dtek-oem-official'])assert.equal(entries.find(e=>e.sourceId===sourceId)?.state,'blocked');
 for(const sourceId of ['voe-mirror-vn-progr','kharkiv-official-rss']){
  const e=entries.find(e=>e.sourceId===sourceId) as TechnicalDisplayAdmission;
  assert.equal(e.recurringScope?.authority,OWNER_APPROVED_INITIAL_LAUNCH.kind);assert.equal(e.publicationScope,undefined);
  assert.equal(e.parallel48hAccepted,false);assert.equal(e.addressBindingVerified,false);assert.equal(e.deliveryEligible,false);assert.equal(e.independentFallbackVerified,false);
  assert.equal(e.formalPrimaryDataLicense,'not_observed');assert.equal(e.providerQuota,'not_published_in_reviewed_sources');assert(e.rate.minIntervalMs>=300000);
 }
 const vin=entries.find(e=>e.sourceId==='voe-mirror-vn-progr') as TechnicalDisplayAdmission;
 assert.equal(vin.publicationBasis.kind,'publisher_public_syndication');assert.match(vin.publicationBasis.evidence,/bezsvitla/);
});

test('actual10Nov approved VN group is current while tomorrow all-yes stays explicitly unpublished',async()=>{
 const intake=reader(),today=await intake.load(request());assert.equal(today.state,'available');
 if(today.state==='available'){
  assert.equal(today.view.serviceDate,'2026-11-10');assert.equal(today.view.status,'published');assert.equal(today.view.freshness,'current');assert(today.view.intervals.length>0);
  assert.equal(today.provenance.rawSha256,hash(vn));assert.equal(today.view.source.id,'voe-mirror-vn-progr');assert.equal(today.view.source.verifiedLevel,'schedule');assert.equal(today.addressBindingVerified,false);
  assert.match(today.view.notice??'',/bezsvitla/);assert.match(today.view.notice??'',/відмінності/);
 }
 const tomorrow=await intake.load(request('voe-mirror-vn-progr','2026-11-11'));assert.equal(tomorrow.state,'available');
 if(tomorrow.state==='available'){assert.equal(tomorrow.view.status,'not_published');assert.equal(tomorrow.view.dayCoverage,'none');assert.equal(tomorrow.view.freshness,'unknown');assert.deepEqual(tomorrow.view.intervals,[]);assert.equal(tomorrow.deliveryEligible,false);}
});

test('current VN cannot refresh stale data by changing collector metadata and rejects unknown schema, wrong scope or finite-policy expiry',async()=>{
 for(const body of [mutate(vn,v=>{v.meta.schemaVersion='9.0.0';}),mutate(vn,v=>{delete v.meta;}),mutate(vn,v=>{v.fact.data[String(v.fact.today)]['GPV6.2']['24']='unknown';}),mutate(vn,v=>{v.regionId='odesa';})]){
  const r=await reader(body).load(request());assert.equal(r.state,'unavailable');if(r.state!=='available')assert.equal(r.code,'SOURCE_SCHEMA_REJECTED');
 }
 const old=mutate(vn,v=>{v.fact.update='09.11.2026 10:00';v.lastUpdated=Math.floor(time/1000);});
 const stale=await reader(old).load(request());assert.equal(stale.state,'unavailable');if(stale.state!=='available')assert.equal(stale.code,'SOURCE_UPDATE_UNCONFIRMED');
 for(const date of ['2026-11-09','2026-11-12'])assert.notEqual((await reader().load(request('voe-mirror-vn-progr',date))).state,'available');
 let gets=0;const expired=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>Date.parse(OWNER_APPROVED_INITIAL_LAUNCH.validUntil),transport:async()=>{gets++;throw Error('expired');}});
 const r=await expired.load(request());assert.equal(r.state,'blocked');if(r.state!=='available')assert.equal(r.code,'SOURCE_ADMISSION_EXPIRED');assert.equal(gets,0);
});

test('actual new10Nov official KH publication parses all12groups with manual-group and emergency-unknown caveats',async()=>{
 const intake=reader(kh,'application/rss+xml');
 for(let n=1;n<=6;n++)for(const half of [1,2]){
  const r=await intake.load(request('kharkiv-official-rss','2026-11-10',`${n}.${half}`));assert.equal(r.state,'available');
  if(r.state==='available'){
   assert.equal(r.view.publishedAt,'2026-11-09T18:08:12.000Z');assert.equal(r.view.source.url,'https://oblenergo.kharkiv.ua/uk/node/13883463');assert.equal(r.view.freshness,'current');assert.equal(r.view.source.id,'kharkiv-official-rss');
   assert.match(r.view.notice??'',/Групу обрано вручну/);assert.match(r.view.notice??'',/Поточний аварійний стан групи не підтверджено/);assert.equal(r.addressBindingVerified,false);assert.equal(r.deliveryEligible,false);
  }
 }
 const future=await intake.load(request('kharkiv-official-rss','2026-11-11','1.1'));assert.notEqual(future.state,'available');
 const damaged=kh.replace('1.1 00:00-01:30','1.1 25:00-01:30');assert.notEqual((await reader(damaged,'application/rss+xml').load(request('kharkiv-official-rss','2026-11-10','1.1'))).state,'available');
 const wrongDate=kh.replace(/у вівторок, 10 листопада/g,'у понеділок, 9 листопада');assert.notEqual((await reader(wrongDate,'application/rss+xml').load(request('kharkiv-official-rss','2026-11-10','1.1'))).state,'available');
});

test('recurring KH accepts next dated publication without a forever raw/date pin and retains an explicit current emergency overlay caveat',async()=>{
 // Synthetic mutation proves tomorrow schema handling; it is not an observed11Nov publication.
 const tomorrow=kh.replace('У Харківській області 10 листопада діятимуть погодинні відключення','У Харківській області 11 листопада діятимуть погодинні відключення').replace('у вівторок, 10 листопада','у середу, 11 листопада');
 const next=await reader(tomorrow,'application/rss+xml').load(request('kharkiv-official-rss','2026-11-11','1.1'));assert.equal(next.state,'available');
 const bulletin='<item><title>Аварійні відключення10листопада</title><link>https://oblenergo.kharkiv.ua/uk/node/13889999</link><pubDate>Tue, 10 Nov 2026 09:00:00 +0000</pubDate><description><![CDATA[У Харківській області 10 листопада застосовуються аварійні відключення.]]></description></item>';
 const body=kh.replace('</channel>',bulletin+'</channel>');const r=await reader(body,'application/rss+xml').load(request('kharkiv-official-rss','2026-11-10','1.1'));assert.equal(r.state,'available');
 if(r.state==='available'){assert.equal(r.view.status,'published');assert(r.view.intervals.length>0);assert.match(r.view.notice??'',/ОСР опублікував повідомлення про аварійні обмеження/);assert.match(r.view.notice??'',/вплив на обрану групу.*не підтверджено/);assert.equal(r.view.deliveryEligible,false);}
 const withdrawn=kh.replace('Години відсутності електропостачання','Графіки скасовано. Години відсутності електропостачання');assert.notEqual((await reader(withdrawn,'application/rss+xml').load(request('kharkiv-official-rss','2026-11-10','1.1'))).state,'available');
});

test('renewed Odesa API policy is current, rate-bounded, free and expires; dated capture still rejects schema/date/digest drift',()=>{
 const a=odesaPlanApiOperatingRecord(true)!;assert(validOdesaPlanOperatingRecord(a,now));assert.equal(a.parallel48hAccepted,false);assert.equal(a.addressBindingVerified,false);assert.equal(a.independentFallbackVerified,false);assert.equal(a.rate.minIntervalMs,7500);
 assert(!validOdesaPlanOperatingRecord(a,a.validUntil));assert(!validOdesaPlanOperatingRecord(historicalOdesaPlanApiOperatingRecord(true)!,now));
 // Synthetic current-day replay of the preserved public mirror shape, with the
 // API envelope restored. This checks the parser, not a native HTTP acquisition.
 const mirror=JSON.parse(readFileSync(new URL('../../../docs/light-bot-app/release-v8/source-research-2026-11-09/captures/odesa-public-json.bin',import.meta.url),'utf8'));
 const today=String(dayBounds('2026-11-10').start/1000),old=String(mirror.fact.today);mirror.fact.data={[today]:mirror.fact.data[old]};mirror.fact.today=Number(today);mirror.fact.update='10.11.2026 11:55';mirror.preset.updateFact=mirror.fact.update;
 const raw=JSON.stringify({result:true,fact:mirror.fact,preset:mirror.preset,showTableSchedule:true,showUserGroup:true});
 const capture:OdesaPlanApiCapture={kind:'odesa-plan-api-capture/1',sourceId:'dtek-oem-public-plan-ajax',operation:'checkDisconUpdate',method:'POST',url:'https://www.dtek-oem.com.ua/ua/ajax',httpStatus:200,contentType:'application/json',observedAt:now,rawBody:raw,rawSha256:hash(raw),request:{update:'09.11.2026 00:00'}};
 const context={targetId:'GPV1.1',addressId:'unbound:odesa',addressLabel:'Група1.1',localityLabel:'Одеська область',serviceDate:'2026-11-10',freshness:'current' as const,synthetic:true},policy={asOf:now,maximumCaptureAgeMs:a.maxAgeMs};
 const result=normalizeOdesaPlanApi(capture,context,policy);assert.equal(result.state,'available');if(result.state==='available'){assert.equal(result.view.source.id,a.sourceId);assert.equal(result.view.serviceDate,'2026-11-10');assert.equal(result.view.deliveryEligible,false);}
 assert.throws(()=>normalizeOdesaPlanApi({...capture,rawSha256:'0'.repeat(64)},context,policy),/перевірити/);
 const unknown=JSON.stringify({...JSON.parse(raw),unexpected:true});assert.throws(()=>normalizeOdesaPlanApi({...capture,rawBody:unknown,rawSha256:hash(unknown)},context,policy));
 assert.throws(()=>normalizeOdesaPlanApi(capture,{...context,serviceDate:'2026-11-09'},policy));
 const historical=mutate(raw,v=>{v.fact.today=Number(old);});assert.throws(()=>normalizeOdesaPlanApi({...capture,rawBody:historical,rawSha256:hash(historical)},context,policy));
});

test('actual current VN capture reaches the runtime technical catalog through the renewed policy, without HTTP or address certification',async()=>{
 const intake=reader();await intake.load(request());const snapshot=intake.snapshotRaw('voe-mirror-vn-progr')!;
 const rows=['2026-11-10','2026-11-11'].map(service_date=>({source_id:snapshot.sourceId,target_id:'GPV1.1',service_date,snapshot}));
 let http=0,released=false;const client={async query(sql:string){return {rows:sql.includes('from lba_production_control')?[{control_epoch:7,writer_mode:'canonical'}]:sql.includes('from lba_public_source_plan p')?rows:sql.includes('from lba_public_source_state')?[{source_id:snapshot.sourceId,last_attempt_at:now,last_success_at:now,last_failure:null}]:[],rowCount:0};},release(){released=true;}};
 const service=createSourceIngestion({enabled:true,expectedControlEpoch:7,pool:{async connect(){return client;}},now:()=>time,transport:async()=>{http++;throw Error('cached');}});
 const catalog=await service.readCatalog();assert.equal(catalog.state,'available');assert.equal(catalog.groups.length,1);assert.deepEqual(catalog.groups[0].dates.map(d=>d.status),['published','not_published']);assert.equal(catalog.addressBindingVerified,false);assert.equal(catalog.deliveryEligible,false);assert.equal(http,0);assert(released);
});
