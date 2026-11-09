import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSourceIntake,SOURCE_PROFILES,type SourceAdmission} from '../../server/production/source-intake.ts';
const now=Date.parse('2026-11-08T18:00:00Z');
// Fixture policy only. This test cannot admit a production source.
const admission=(sourceId:string):SourceAdmission=>({sourceId,state:'admitted',revisionId:'fixture-explicit-policy',reviewedAt:'2026-11-08T17:00:00Z',validUntil:'2026-11-09T17:00:00Z',accessCost:0,costEvidence:'fixture',
 license:{systematicReuse:'allowed',evidence:'fixture'},automation:{robots:'allowed',evidence:'fixture'},rate:{allowed:true,scope:'origin',minIntervalMs:60000,evidence:'fixture'},cacheTtlMs:60000,maxAgeMs:3600000});
const raw=(name:string)=>readFileSync(new URL('../../../docs/light-bot-app/release-v8/data-current-2026-11-08/'+name,import.meta.url),'utf8');
function intake(sourceId:string,body:string,type:string){
 const profile=SOURCE_PROFILES.find(p=>p.sourceId===sourceId)!;
 return {profile,reader:createSourceIntake({registry:[admission(sourceId)],now:()=>now,transport:async()=>({url:profile.endpoint,status:200,headers:{'content-type':type},body:(async function*(){yield Buffer.from(body);})()})})};
}
test('actual8Nov GitHub JSON mirror text/plain;charset=utf8 is parsed as exact operator data, not rejected by a fictitious JSON MIME',async()=>{
 const {profile,reader}=intake('mirror-odesa',raw('odesa-mirror.txt'),'text/plain;charset=utf-8');
 const value=await reader.load({sourceId:profile.sourceId,operatorId:profile.operatorId,namespace:profile.namespace,targetId:'GPV1.1',serviceDate:'2026-11-08'});
 assert.equal(value.state,'available');if(value.state==='available'){assert.equal(value.view.source.id,'mirror-odesa');assert.equal(value.view.operatorId,'dtek-oem');assert.equal(value.view.synthetic,false);assert.equal(value.deliveryEligible,false);}
});
test('text/plain exception is limited to pinned GitHub JSON mirrors; official JSON/RSS types remain strict and HTML still fails schema',async()=>{
 const official=intake('yasno-kem',raw('yasno-kem.json'),'text/plain');
 const denied=await official.reader.load({sourceId:'yasno-kem',operatorId:'dtek-kem',namespace:'yasno:25/902',targetId:'60.1',serviceDate:'2026-11-08'});
 assert.equal(denied.state,'unavailable');if(denied.state!=='available')assert.equal(denied.code,'SOURCE_CONTENT_TYPE_REJECTED');
 const mirror=intake('mirror-odesa','<html>not a schedule</html>','text/plain');
 const invalid=await mirror.reader.load({sourceId:'mirror-odesa',operatorId:'dtek-oem',namespace:'dtek:oem',targetId:'GPV1.1',serviceDate:'2026-11-08'});
 assert.equal(invalid.state,'unavailable');if(invalid.state!=='available')assert.equal(invalid.code,'SOURCE_SCHEMA_REJECTED');
});
