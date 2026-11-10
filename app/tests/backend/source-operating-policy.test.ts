import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSourceIntake,type TechnicalDisplayAdmission} from '../../server/production/source-intake.ts';
import {historicalTechnicalDisplaySourceRegistry as technicalDisplaySourceRegistry,TECHNICAL_SOURCE_REVIEW} from '../../server/production/source-operating-policy.ts';
const now=Date.parse(TECHNICAL_SOURCE_REVIEW.reviewedAt)+1000;
const raw=readFileSync(new URL('../../../docs/light-bot-app/release-v8/data-current-2026-11-08/yasno-kem.json',import.meta.url));
test('technical operating decision stays disabled by default and never invents provider rights/quota or personal delivery',()=>{
 assert(technicalDisplaySourceRegistry().every(r=>r.state==='blocked'));
 const enabled=technicalDisplaySourceRegistry(true),active=enabled.filter(r=>r.state==='technical_display');assert.deepEqual(active.map(r=>r.sourceId).sort(),['kharkiv-official-rss','mirror-odesa','yasno-kem']);
 for(const entry of active){assert.equal(entry.formalPrimaryDataLicense,'not_observed');assert.equal(entry.providerQuota,'not_published_in_reviewed_sources');assert.equal(entry.deliveryEligible,false);assert.equal(entry.parallel48hAccepted,false);}
 const mirror=enabled.find(r=>r.sourceId==='mirror-odesa');assert(mirror?.state==='technical_display');assert.equal(mirror.semanticScope?.serviceDate,'2026-11-09');assert.equal(Object.keys(mirror.semanticScope!.targetPlanSha256s).length,12);
 for(const id of ['dtek-oem-official','voe-mirror-vn-progr','voe-mirror-olnet93','yasno-dnem','yasno-cek'])assert.equal(enabled.find(r=>r.sourceId===id)?.state,'blocked');
});
test('official anonymous API can yield dated technical plan with honest unreadable robots and operating provenance; still no binding or delivery',async()=>{
 let calls=0;const reader=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>now,transport:async req=>{calls++;return {url:req.url,status:200,headers:{'content-type':'application/json'},body:(async function*(){yield raw;})()};}});
 const value=await reader.load({sourceId:'yasno-kem',operatorId:'dtek-kem',namespace:'yasno:25/902',targetId:'60.1',serviceDate:'2026-11-08'});
 assert.equal(calls,1);assert.equal(value.state,'available');if(value.state==='available'){
  assert.equal(value.view.synthetic,false);assert.equal(value.view.source.verifiedLevel,'schedule');assert.equal(value.addressBindingVerified,false);assert.equal(value.deliveryEligible,false);
  assert.equal(value.provenance.operatingAdmission?.scope,'technical_group_display');assert.equal(value.provenance.operatingAdmission?.formalPrimaryDataLicense,'not_observed');
 }
});
test('operational admission cannot falsely assert cert/parallel observation, change basis, or bypass known direct automation prohibition',async()=>{
 const entry=technicalDisplaySourceRegistry(true).find(r=>r.sourceId==='yasno-kem') as TechnicalDisplayAdmission;
 for(const patch of [{deliveryEligible:true},{parallel48hAccepted:true},{formalPrimaryDataLicense:'MIT'},{providerQuota:60},{robots:{status:'allowed',evidence:'invented'}}]){
  assert.throws(()=>createSourceIntake({registry:[{...entry,...patch} as any],now:()=>now,transport:async()=>{throw Error('not reached');}}),/INVALID_TECHNICAL/);
 }
 const spoof={...entry,sourceId:'dtek-oem-official',publicationBasis:{kind:'publisher_public_syndication',evidence:'fixture'},robots:{status:'not_checked',evidence:'fixture'}} as TechnicalDisplayAdmission;
 let calls=0;const reader=createSourceIntake({registry:[spoof],now:()=>now,transport:async()=>{calls++;throw Error('must not fetch');}});
 const result=await reader.load({sourceId:'dtek-oem-official',operatorId:'dtek-oem',namespace:'dtek:oem',targetId:'GPV1.1',serviceDate:'2026-11-08'});
 assert.equal(result.state,'blocked');assert.equal(calls,0);
});
