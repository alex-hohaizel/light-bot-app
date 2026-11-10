import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeHourMatrix} from '../../server/domain/hour-matrix-adapter.ts';
import {normalizeYasnoRaw} from '../../server/domain/yasno-adapter.ts';
import {normalizeKharkivRss} from '../../server/domain/kharkiv-adapter.ts';
import {createSourceIntake,technicalPlanSha256,type SourceIntakeRequest,type SourceHttpTransport,type TechnicalDisplayAdmission} from '../../server/production/source-intake.ts';
import {historicalTechnicalDisplaySourceRegistry as technicalDisplaySourceRegistry,TECHNICAL_SOURCE_REVIEW,ODESA_9NOV_SEMANTIC_SCOPE,HISTORICAL_SOURCE_INCIDENTS} from '../../server/production/source-operating-policy.ts';
const root=new URL('../../../docs/light-bot-app/release-v8/source-research-2026-11-09/',import.meta.url);
const read=(name:string)=>readFileSync(new URL(name,root),'utf8'),hash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const observedAt='2026-11-08T23:50:00Z',now=Date.parse(observedAt),date='2026-11-09';
const official=read('captures/odesa-official.bin'),mirror=read('captures/odesa-public-json.bin');
const request=(patch:Partial<SourceIntakeRequest>={}):SourceIntakeRequest=>({sourceId:'mirror-odesa',operatorId:'dtek-oem',namespace:'dtek:oem',targetId:'GPV1.1',serviceDate:date,...patch});
const context=(raw:string,id:string,serviceDate=date)=>({addressId:'unbound:actual-source-test',addressLabel:'Технічна група',localityLabel:'Public captured source',serviceDate,observedAt,freshness:'current' as const,synthetic:false,
 source:{id,name:'Captured public source',url:null,revision:hash(raw),accessCost:0 as const,verifiedLevel:'schedule' as const}});
const response=(raw:string):SourceHttpTransport=>async req=>({url:req.url,status:200,headers:{'content-type':'text/plain'},body:(async function*(){yield Buffer.from(raw);})()});
const load=(raw:string,patch:Partial<SourceIntakeRequest>={})=>createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>now,transport:response(raw)}).load(request(patch));
const mutate=(raw:string,change:(v:any)=>void)=>{const v=JSON.parse(raw);change(v);return JSON.stringify(v);};

test('actual9Nov official and mirror comparison pins all12 normalized target plans and288 cells; no source identity or certification promotion',()=>{
 const comparison=JSON.parse(read('odesa-comparison-2026-11-09.json'));
 assert.equal(hash(read('odesa-comparison-2026-11-09.json')),ODESA_9NOV_SEMANTIC_SCOPE.comparisonSha256);
 assert.equal(hash(official),ODESA_9NOV_SEMANTIC_SCOPE.officialRawSha256);assert.equal(hash(mirror),ODESA_9NOV_SEMANTIC_SCOPE.mirrorRawSha256);
 assert.equal(comparison.cellsCompared,288);assert.equal(comparison.cellDifferences,0);assert.deepEqual(comparison.targetPlanSha256s,ODESA_9NOV_SEMANTIC_SCOPE.targetPlanSha256s);
 for(const targetId of Object.keys(ODESA_9NOV_SEMANTIC_SCOPE.targetPlanSha256s)){
  const a=normalizeHourMatrix(official,{...context(official,'dtek-oem-official'),namespace:'dtek:oem',operatorId:'dtek-oem',targetId});
  const b=normalizeHourMatrix(mirror,{...context(mirror,'mirror-odesa'),namespace:'dtek:oem-mirror',operatorId:'dtek-oem',targetId});
  assert.equal(technicalPlanSha256(a),ODESA_9NOV_SEMANTIC_SCOPE.targetPlanSha256s[targetId as keyof typeof ODESA_9NOV_SEMANTIC_SCOPE.targetPlanSha256s]);
  assert.equal(technicalPlanSha256(a),technicalPlanSha256(b));assert.deepEqual(a.intervals,b.intervals);
  assert.equal(a.source.id,'dtek-oem-official');assert.equal(b.source.id,'mirror-odesa');assert.equal(b.deliveryEligible,false);
 }
 const view=normalizeHourMatrix(official,{...context(official,'dtek-oem-official'),namespace:'dtek:oem',operatorId:'dtek-oem',targetId:'GPV1.1'});
 assert.deepEqual(view.intervals.map(i=>[i.startLocal,i.endLocal]),[['09:30','13:30'],['20:00','24:00']]);
});
test('mirror9Nov matched plan is technically readable; collector metadata refresh cannot fabricate a plan change',async()=>{
 for(const raw of [mirror,mutate(mirror,v=>{v.lastUpdated='2026-11-08T23:45:00Z';v.lastUpdateStatus.at='2026-11-08T23:45:00Z';v.lastUpdateStatus.attempt++;})]){
  const r=await load(raw);assert.equal(r.state,'available');if(r.state==='available'){
   assert.equal(r.view.source.id,'mirror-odesa');assert.equal(r.provenance.rawSha256,hash(raw));assert.equal(r.view.status,'published');assert.equal(r.view.serviceDate,date);
   assert.equal(r.addressBindingVerified,false);assert.equal(r.deliveryEligible,false);assert.equal(r.provenance.operatingAdmission?.publicationBasis,'publisher_public_syndication');
  }
 }
 const entry=technicalDisplaySourceRegistry(true).find(r=>r.sourceId==='mirror-odesa') as TechnicalDisplayAdmission;
 assert.equal(entry.parallel48hAccepted,false);assert.equal(entry.independentFallbackVerified,false);assert.equal(entry.reviewedAt,'2026-11-08T23:38:41.462Z');
 const kem=technicalDisplaySourceRegistry(true).find(r=>r.sourceId==='yasno-kem') as TechnicalDisplayAdmission;assert.equal(kem.reviewedAt,TECHNICAL_SOURCE_REVIEW.reviewedAt);assert.match(kem.revisionId,/2026-11-08/);
});
test('9Nov readmission never admits changed target semantics, missing target, historical8Nov conflict or another date/DSO',async()=>{
 for(const targetId of Object.keys(ODESA_9NOV_SEMANTIC_SCOPE.targetPlanSha256s)){
  const raw=mutate(mirror,v=>{const row=v.fact.data[String(v.fact.today)][targetId];row['1']=row['1']==='yes'?'no':'yes';});
  const r=await load(raw,{targetId});assert.equal(r.state,'unavailable');assert.equal(r.code,'SOURCE_SCHEMA_REJECTED');
 }
 for(const raw of [mutate(mirror,v=>{delete v.fact.data[String(v.fact.today)]['GPV1.1'];}),mutate(mirror,v=>{v.fact.data[String(v.fact.today)]['GPV1.1']['1']='unknown';})])assert.notEqual((await load(raw)).state,'available');
 const historical=readFileSync(new URL('../../../docs/light-bot-app/release-v8/source-research-2026-11-08/root/captures/odesa-mirror-comparison.bin',import.meta.url),'utf8');
 assert.equal(hash(historical),HISTORICAL_SOURCE_INCIDENTS['mirror-odesa'].mirrorRawSha256);assert.equal(HISTORICAL_SOURCE_INCIDENTS['mirror-odesa'].cellDifferences,9);
 assert.notEqual((await load(historical,{serviceDate:'2026-11-08'})).state,'available');assert.notEqual((await load(mirror,{serviceDate:'2026-11-10'})).state,'available');
 const wrong=await load(mirror,{operatorId:'vinnytsia-oe'});assert.equal(wrong.state,'blocked');
 const noScope=technicalDisplaySourceRegistry(true).filter(r=>r.sourceId==='mirror-odesa').map(r=>{const copy=structuredClone(r) as any;delete copy.semanticScope;return copy;});
 assert.throws(()=>createSourceIntake({registry:noScope,now:()=>now,transport:response(mirror)}),/INVALID_TECHNICAL_SOURCE_SCOPE/);
});
test('failed changed-plan refresh retains the previously matched electrical plan only as stale; directOEM remains blocked by current robots',async()=>{
 let clock=now,raw=mirror,calls=0;const reader=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>clock,transport:async req=>{calls++;return response(raw)(req);}});
 assert.equal((await reader.load(request())).state,'available');clock+=1200001;raw=mutate(mirror,v=>{v.fact.data[String(v.fact.today)]['GPV1.1']['1']='no';});
 const r=await reader.load(request());assert.equal(r.state,'available');if(r.state==='available'){assert.equal(r.cache,'stale');assert.equal(r.view.status,'stale');assert.equal(r.refreshFailure,'SOURCE_SCHEMA_REJECTED');assert.equal(r.provenance.rawSha256,hash(mirror));}
 const robots=read('captures/odesa-robots-current.bin');assert.match(robots,/User-agent:\s*\*\s+Disallow:\s*\//);
 const direct=await reader.load(request({sourceId:'dtek-oem-official'}));assert.equal(direct.state,'blocked');assert.equal(calls,2);
 assert(technicalDisplaySourceRegistry().every(r=>r.state==='blocked'));
});
test('actual9Nov VN preserves currentOFF intervals and10Nov all-yes remains unpublished without pretending primary accuracy',()=>{
 const raw=read('captures/vinnytsia-public-json.bin');
 const ctx={...context(raw,'voe-mirror-vn-progr'),namespace:'voe:vn-progr' as const,operatorId:'vinnytsia-oe',targetId:'GPV1.1'};
 const today=normalizeHourMatrix(raw,ctx);assert.deepEqual(today.intervals.map(i=>[i.startLocal,i.endLocal]),[['10:00','12:00'],['16:00','18:00'],['22:00','24:00']]);assert.match(today.notice??'',/не підтверджені/);
 const tomorrow=normalizeHourMatrix(raw,{...ctx,serviceDate:'2026-11-10'});assert.equal(tomorrow.status,'not_published');assert.equal(tomorrow.dayCoverage,'none');assert.equal(tomorrow.freshness,'unknown');assert.deepEqual(tomorrow.intervals,[]);assert.equal(tomorrow.deliveryEligible,false);
});
test('actual9Nov KEM sixtygroup plan/tomorrowWaiting and both Dnipro DSOs emergency remain distinct',()=>{
 const raw=read('captures/yasno-kem.bin'),payload=JSON.parse(raw);assert.equal(Object.keys(payload).length,60);
 const ctx={...context(raw,'yasno-kem'),namespace:'yasno:25/902' as const,operatorId:'dtek-kem',targetId:'1.1'};
 assert.deepEqual(normalizeYasnoRaw(raw,'today',ctx).intervals.map(i=>[i.startLocal,i.endLocal]),[['05:30','11:30'],['14:00','21:30']]);
 assert.equal(normalizeYasnoRaw(raw,'tomorrow',{...ctx,serviceDate:'2026-11-10'}).status,'not_published');
 for(const [id,namespace,operatorId] of [['yasno-dnem','yasno:3/301','dtek-dnem'],['yasno-cek','yasno:3/303','cek']] as const){const body=read('captures/'+id+'.bin');const view=normalizeYasnoRaw(body,'today',{...context(body,id),namespace,operatorId,targetId:'1.1'});assert.equal(view.status,'emergency');assert.equal(view.dayCoverage,'none');assert.deepEqual(view.intervals,[]);}
});
test('actual9Nov KH dated plan is selected past pinned2025 item, while current emergency applicability stays explicitly unknown',()=>{
 const raw=read('captures/kharkiv-rss.bin'),view=normalizeKharkivRss(raw,{...context(raw,'kharkiv-official-rss'),namespace:'kharkiv:rss',operatorId:'kharkiv-oe',targetId:'1.1'});
 assert.deepEqual(view.intervals.map(i=>[i.startLocal,i.endLocal]),[['01:00','04:30'],['06:00','15:00'],['18:30','24:00']]);
 const entry=technicalDisplaySourceRegistry(true).find(r=>r.sourceId==='kharkiv-official-rss');assert.equal(entry?.state,'technical_display');if(entry?.state==='technical_display'){assert.equal(entry.publicationScope?.serviceDate,'2026-11-09');assert.equal(entry.deliveryEligible,false);assert.match(view.notice??'',/Поточний аварійний стан групи не підтверджено/);}
});
