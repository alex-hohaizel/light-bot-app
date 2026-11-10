import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createSourceIntake,type SourceIntakeResult,type CapturedPublicSourceRaw} from '../../server/production/source-intake.ts';
import {technicalDisplaySourceRegistry,historicalTechnicalDisplaySourceRegistry} from '../../server/production/source-operating-policy.ts';
import {OdesaTransportError} from '../../server/providers/odesa-public-client.ts';
import {createSourceIngestion,preferPublicSourcePlans,odesaPlanFailureScope} from '../../server/production/source-ingestion.ts';
const raw=readFileSync(new URL('./fixtures/odesa-mirror-2026-11-10.json',import.meta.url),'utf8'),now='2026-11-10T10:28:00Z';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const request=(targetId='GPV1.1',serviceDate='2026-11-10')=>({sourceId:'mirror-odesa',operatorId:'dtek-oem',namespace:'dtek:oem',targetId,serviceDate});
const reader=(body=raw)=>createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>Date.parse(now),transport:async req=>({url:req.url,status:200,headers:{'content-type':'text/plain; charset=utf-8'},body:(async function*(){yield Buffer.from(body);})()})});
type Available=Extract<SourceIntakeResult,{state:'available'}>;
async function plan(){const value=await reader().load(request());assert.equal(value.state,'available');return value as Available;}
// Pure selection inputs only: this synthetic primary is not a native API proof.
const primary=(mirror:Available):Available=>({...structuredClone(mirror),view:{...structuredClone(mirror.view),synthetic:true,source:{...mirror.view.source,id:'dtek-oem-public-plan-ajax',name:'Synthetic official API selection input',url:'https://www.dtek-oem.com.ua/ua/ajax'}},provenance:{...mirror.provenance,sourceId:'dtek-oem-public-plan-ajax'}});

test('actual10Nov Odesa relay decodes all12groups without a9Nov pin, preserves community identity and leaves missing11Nov unknown',async()=>{
 assert.equal(hash(raw),'9d0943dcd7bec5d5b9f681b27dc11f3504ddc48d4ef708badd9d0608790d46ec');
 const intake=reader();
 for(let n=1;n<=6;n++)for(const half of [1,2]){
  const r=await intake.load(request(`GPV${n}.${half}`));assert.equal(r.state,'available');if(r.state==='available'){
   assert.equal(r.view.serviceDate,'2026-11-10');assert.equal(r.view.publishedAt,'2026-11-10T04:44:00.000Z');assert.equal(r.view.freshness,'current');assert.equal(r.view.dayCoverage,'complete');assert(r.view.intervals.length>0);
   assert.equal(r.view.source.id,'mirror-odesa');assert.equal(r.provenance.operatingAdmission?.publicationBasis,'publisher_public_syndication');assert.equal(r.provenance.rawSha256,hash(raw));assert.match(r.view.notice??'',/громадського дзеркала/);assert.match(r.view.notice??'',/затримка або відмінності/);assert.equal(r.addressBindingVerified,false);assert.equal(r.deliveryEligible,false);
  }
 }
 assert.notEqual((await intake.load(request('GPV1.1','2026-11-11'))).state,'available');
 const historical=createSourceIntake({registry:historicalTechnicalDisplaySourceRegistry(true),now:()=>Date.parse('2026-11-09T10:00:00Z'),transport:async req=>({url:req.url,status:200,headers:{'content-type':'text/plain'},body:(async function*(){yield Buffer.from(raw);})()})});
 assert.notEqual((await historical.load(request())).state,'available');
 const payload=JSON.parse(raw);payload.meta.schemaVersion='9.0.0';assert.notEqual((await reader(JSON.stringify(payload)).load(request())).state,'available');
});

test('fresh complete official API wins per target/day, deduplicates output and visibly reports a differing current relay',async()=>{
 const mirror=await plan(),official=primary(mirror),same=preferPublicSourcePlans([mirror,official]);
 assert.equal(same.length,1);assert.equal(same[0].provenance.sourceId,'dtek-oem-public-plan-ajax');
 const conflicting=structuredClone(mirror);conflicting.view.intervals=[];conflicting.view.status='no_planned_outages';
 const selected=preferPublicSourcePlans([conflicting,official]);assert.equal(selected.length,1);assert.equal(selected[0].provenance.sourceId,'dtek-oem-public-plan-ajax');assert.match(selected[0].view.notice??'',/інтервали громадського дзеркала відрізняються/);
 assert.equal(official.view.notice,mirror.view.notice);assert.notEqual(selected[0].view.notice,official.view.notice);
 const other=structuredClone(mirror);other.view.targetId='GPV2.1';assert.equal(preferPublicSourcePlans([mirror,official,other]).length,2);
});

test('relay is selected only when official target/day is unavailable, stale or unpublished; runtime catalog exposes one current source',async()=>{
 const mirror=await plan(),official=primary(mirror);
 for(const candidate of [undefined,{...official,view:{...official.view,freshness:'stale' as const,status:'stale' as const}},{...official,view:{...official.view,status:'not_published' as const,dayCoverage:'none' as const,intervals:[]}}]){
  const selected=preferPublicSourcePlans(candidate?[candidate,mirror]:[mirror]);assert.equal(selected.length,1);assert.equal(selected[0].provenance.sourceId,'mirror-odesa');assert.match(selected[0].view.notice??'',/Показано резервне джерело/);assert.equal(selected[0].view.freshness,'current');
 }
 const intake=reader();await intake.load(request());const snapshot=intake.snapshotRaw('mirror-odesa') as CapturedPublicSourceRaw;
 const rows=Array.from({length:6},(_,i)=>[1,2].map(half=>({source_id:'mirror-odesa',target_id:`GPV${i+1}.${half}`,service_date:'2026-11-10',snapshot}))).flat();
 const client={async query(sql:string){return {rows:sql.includes('from lba_production_control')?[{control_epoch:7,writer_mode:'canonical'}]:sql.includes('from lba_public_source_plan p')?rows:sql.includes('from lba_public_source_state')?[{source_id:'mirror-odesa',last_attempt_at:now,last_success_at:now,last_failure:null}]:[],rowCount:0};},release(){}};
 const service=createSourceIngestion({enabled:true,odesaPlanApiEnabled:true,expectedControlEpoch:7,pool:{async connect(){return client;}},now:()=>Date.parse(now),transport:async()=>{throw Error('cache read only');}});
 const catalog=await service.readCatalog();assert.equal(catalog.state,'available');assert.equal(catalog.groups.length,12);assert(catalog.groups.every(g=>g.sourceId==='mirror-odesa'&&g.dates.length===1&&g.dates[0].serviceDate==='2026-11-10'));assert.equal(catalog.addressBindingVerified,false);
 const bad=structuredClone(snapshot);bad.rawSha256='0'.repeat(64);assert.notEqual(intake.projectSnapshot(request(),bad).state,'available');
});


test('actual terminal guest-meta error holds only the official origin so relay refresh remains possible; unknown or pending transport stays held',()=>{
 assert.deepEqual(odesaPlanFailureScope(new OdesaTransportError('GUEST_META_INVALID')),{failure:'SOURCE_ORIGIN_REJECTED',hold:'origin'});
 assert.deepEqual(odesaPlanFailureScope(new OdesaTransportError('SOURCE_ACCESS_STOP')),{failure:'SOURCE_ORIGIN_REJECTED',hold:'origin'});
 assert.deepEqual(odesaPlanFailureScope(new OdesaTransportError('TIMEOUT')),{failure:'SOURCE_TIMEOUT',hold:'worker-and-origin'});
 assert.deepEqual(odesaPlanFailureScope(Error('unknown transport outcome')),{failure:'SOURCE_TRANSPORT_FAILED',hold:'worker-and-origin'});
});
