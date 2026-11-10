import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createBotState,handleScheduleEvent} from '../../shared/bot/engine.ts';
import {manualGroupOption} from '../../shared/manual-group.ts';
import {canDeliver} from '../../shared/schedule-core.ts';
import {createSourceIntake,SOURCE_PROFILES} from '../../server/production/source-intake.ts';
import {technicalDisplaySourceRegistry} from '../../server/production/source-operating-policy.ts';
import {createRuntimeDataContext} from '../../server/production/runtime-context.ts';
import {createProductionScheduleCertification} from '../../server/production/schedule-certification.ts';
import {createProductionScheduleEvents,scheduleEventDigest,validInitialLaunchCertificate,validScheduleCertificateShape} from '../../server/production/schedule-events.ts';
import {DEPLOYED_QUALIFICATION_PINS,INITIAL_LAUNCH_NOTIFICATION_POLICY as POLICY} from '../../server/production/deployed-schedule-qualification.ts';
const now='2026-11-10T10:05:00.000Z',at=Date.parse(now),epoch=7;
const signal=new AbortController().signal;
/** SQL oracle over an actual preserved public body. It makes no native DB,
 * source HTTP or Telegram call and proves no deployed/runtime observation. */
async function fixture(enabled=true){
 const p=SOURCE_PROFILES.find(p=>p.sourceId==='voe-mirror-vn-progr')!;
 const raw=readFileSync(new URL('./fixtures/vinnytsia-mirror-2026-11-10.json',import.meta.url),'utf8');
 const intake=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>at,transport:async r=>({url:r.url,status:200,headers:{'content-type':'text/plain'},body:(async function*(){yield Buffer.from(raw);})()})});
 const result=await intake.load({sourceId:p.sourceId,operatorId:p.operatorId,namespace:p.namespace,targetId:'GPV1.1',serviceDate:'2026-11-10'});assert.equal(result.state,'available');if(result.state!=='available')throw Error('fixture');
 const snapshot=intake.snapshotRaw(p.sourceId)!;
 const state=createBotState({ownerId:'launch-owner',sessionId:'launch-session'});
 const group={id:'group:fixture',label:'1.1',locality:'Вінниця',territoryLabel:'Вінницька область',operatorId:p.operatorId,namespace:p.namespace,targetId:'GPV1.1',revisionId:'manual-group:fixture'};
 state.profile.locations.push({...manualGroupOption(group),notifications:true,paused:false});state.profile.primaryAddressId=state.profile.locations[0].address.id;state.profile.preferences.optedIn=true;state.profile.preferences.reminders=true;
 const view={...result.view,addressId:state.profile.primaryAddressId};
 const records:any[]=[];let rawValid=true,mutateSelection=false,bindingWrites=0;
 const rawId='11111111-1111-4111-a111-111111111111',runId='22222222-2222-4222-a222-222222222222';
 const client={async query(sql:string,values:any[]=[]):Promise<any>{
  let rows:any[]=[];
  if(sql.includes('from lba_production_control'))rows=[{control_epoch:rawValid?epoch:epoch+1,writer_mode:'canonical'}];
  else if(sql.includes('from lba_public_source_plan'))rows=[{source_id:p.sourceId,target_id:view.targetId,service_date:view.serviceDate,raw_id:rawId}];
  else if(sql.includes('from lba_public_source_raw'))rows=[{source_id:p.sourceId,run_id:runId,observed_at:now,snapshot}];
  else if(sql.includes('from lba_public_source_run'))rows=[{source_id:p.sourceId,control_epoch:epoch,status:'published',started_at:now,finished_at:now}];
  else if(sql.includes('from lba_public_source_state'))rows=[{last_attempt_at:now,last_success_at:now,last_failure:null}];
  else if(sql.startsWith('insert into lba_production_schedule_certificate')){const record=JSON.parse(values[10]);records.push({id:values[0],owner_id:state.ownerId,session_id:state.sessionId,control_epoch:epoch,address_id:record.view.addressId,schedule_revision_id:record.view.revisionId,source_revision:record.view.source.revision,binding_revision_id:record.binding.revisionId,view_digest:values[8],record_digest:values[9],record,issued_at:values[11],expires_at:values[12],revoked_at:null});}
  else if(sql.includes('from lba_production_schedule_certificate'))rows=sql.includes('where id=$1')?records.filter(r=>r.id===values[0]):records;
  else if(sql.includes('from lba_production_profiles'))rows=[{owner_id:state.ownerId,session_id:state.sessionId,state}];
  else if(sql.startsWith('update lba_production_schedule_certificate')){}
  else if(!sql.includes('lba_production_profile_outbox'))throw Error('Unhandled SQL: '+sql);
  return {rows,rowCount:rows.length};
 },release(){}};
 const service=createProductionScheduleCertification({enabled:true,initialLaunchNotifications:enabled,expectedControlEpoch:epoch,now:()=>at,pool:{connect:async()=>client},store:{commitCertifiedBinding:async(_p:any,_expected:any,operation:any)=>{const current=structuredClone(state);if(mutateSelection)current.revision++;return operation({client,state:current,serverNow:now,persistBinding:async()=>{bindingWrites++;throw Error('MUST_KEEP_SELECTED_GROUP');}});}} as any,sources:{readTechnicalPlans:async()=>({state:'available',plans:[{view,provenance:{sourceId:p.sourceId}}]})} as any,catalog:{} as any});
 const events=createProductionScheduleEvents({enabled:true,expectedControlEpoch:epoch,store:{commitScheduleEvent:async()=>{throw Error('not used');}} as any,verifyCurrentSource:service.verifyCurrentSource});
 return {state,view,service,events,records,client,bindingWrites:()=>bindingWrites,setRawValid:(v:boolean)=>rawValid=v,setSelectionChanged:()=>mutateSelection=true};
}
test('explicit launch grant issues from exact current raw without 48h or building promotion; raw and owner scope still bind event qualification',async()=>{
 const f=await fixture();assert.deepEqual(DEPLOYED_QUALIFICATION_PINS,[]);
 assert.equal((await f.service.issue({state:f.state,view:f.view,signal})).kind,'issued');assert.equal(f.records.length,1);
 const c=f.records[0].record;assert.equal(c.kind,'lba-certified-schedule/3');assert.equal(c.parallel48hEvidence,undefined);assert.equal(c.view.source.verifiedLevel,'initial_launch');assert.equal(c.binding.status,'needs_confirmation');assert.equal(c.binding.kind,'user_selected_group');assert.equal(c.binding.verifiedAt,null);assert.equal(c.addressEvidence.kind,'accepted_group_selection');assert.equal(c.initialLaunchEvidence.buildingVerified,false);assert.equal(f.bindingWrites(),0);assert.match(c.view.notice,/будинку.*не перевірені/);assert.match(c.view.notice,/дзеркал/i);
 assert(validScheduleCertificateShape(c));assert(validInitialLaunchCertificate(c,now));assert(canDeliver(c.view,c.binding,f.state.profile.preferences,now));
 assert(await f.events.qualifySchedule({client:f.client,state:f.state,view:c.view,now,signal}));
 assert.equal((await f.service.readCertifiedProjection()).length,1);
 assert.equal(f.service.health().admittedSources,0);assert.equal(f.service.health().initialLaunchNotifications,true);assert.equal(f.service.health().launchPolicyCurrent,true);
 assert.equal((await f.service.issue({state:f.state,view:f.view,signal})).kind,'replayed');assert.equal(f.records.length,1);
 f.setRawValid(false);assert.equal(await f.events.qualifySchedule({client:f.client,state:f.state,view:c.view,now,signal}),null);
 f.setRawValid(true);const foreign=structuredClone(f.state);foreign.sessionId='foreign';assert.equal(await f.events.qualifySchedule({client:f.client,state:foreign,view:c.view,now,signal}),null);
});
test('default launch remains closed; stale/synthetic/unpublished/conflict/no-day and changed selection never create grants',async()=>{
 const off=await fixture(false);assert.equal((await off.service.issue({state:off.state,view:off.view,signal})).kind,'pending');assert.equal(off.records.length,0);
 for(const patch of [{freshness:'stale',status:'stale'},{synthetic:true},{status:'not_published',intervals:[],dayCoverage:'none'},{status:'conflict'},{status:'no_planned_outages',intervals:[],dayCoverage:'complete'},{serviceDate:'2026-11-11',status:'no_planned_outages',intervals:[],dayCoverage:'complete'},{dayCoverage:'partial'},{serviceDate:'2026-11-09'},{operatorId:'foreign'}]){const f=await fixture();assert.equal((await f.service.issue({state:f.state,view:{...f.view,...patch} as any,signal})).kind,'pending');assert.equal(f.records.length,0);}
 const f=await fixture();f.setSelectionChanged();await assert.rejects(f.service.issue({state:f.state,view:f.view,signal}),/SELECTION_CHANGED/);assert.equal(f.records.length,0);
});
test('JSON cannot upgrade launch to sealed48h, change code policy, replace group or claim building verification',async()=>{
 const f=await fixture();await f.service.issue({state:f.state,view:f.view,signal});const c=f.records[0].record;
 for(const change of [(v:any)=>v.initialLaunchEvidence.authority='attacker',(v:any)=>v.initialLaunchEvidence.buildingVerified=true,(v:any)=>v.initialLaunchEvidence.validUntil='2099-01-01T00:00:00Z',(v:any)=>v.binding.status='verified',(v:any)=>v.view.source.verifiedLevel='integration',(v:any)=>v.binding.targetId='GPV6.2',(v:any)=>v.parallel48hEvidence={kind:'accepted_parallel_48h'},(v:any)=>v.kind='lba-certified-schedule/1']){const value=structuredClone(c);change(value);assert.equal(validInitialLaunchCertificate(value,now),false);}
 assert.equal(validInitialLaunchCertificate(c,POLICY.validUntil),false);
});
test('launch delivery retains opt-out, pause and quiet-hours gates and bot event deduplication',async()=>{
 const f=await fixture();await f.service.issue({state:f.state,view:f.view,signal});const {view,binding}=f.records[0].record;
 for(const patch of [{optedIn:false},{paused:true},{quietHours:{enabled:true,start:'00:00',end:'23:59',timezone:'Europe/Kyiv'}}])assert.equal(canDeliver(view,binding,{...f.state.profile.preferences,...patch} as any,now),false);
 const event={id:'launch-event',addressId:view.addressId,operatorId:view.operatorId,serviceDate:view.serviceDate,fromRevisionId:null,toRevisionId:view.revisionId,kind:'new_plan' as const,createdAt:now};
 const first=handleScheduleEvent(f.state,event,view,{actorId:f.state.ownerId,now,addresses:[],plans:[view],operatorLabels:{}});assert.equal(first.messages.length,1);
 const second=handleScheduleEvent(first.state,event,view,{actorId:f.state.ownerId,now,addresses:[],plans:[view],operatorLabels:{}});assert.equal(second.messages.length,0);
 assert.equal(scheduleEventDigest(binding),scheduleEventDigest(f.state.profile.locations[0].binding));
});

test('existing certification scan and runtime context expose admitted saved group without inventing a house catalog',async()=>{
 const f=await fixture();const result=await f.service.runOnce({signal});assert.equal(result.issued,1);assert.equal(f.bindingWrites(),0);
 const context=createRuntimeDataContext({now:()=>at,operatorLabels:{},sources:{readTechnicalPlans:async()=>({state:'available',plans:[{view:f.view,provenance:{sourceId:f.view.source.id}}]})} as any,catalog:{readCandidates:async()=>({state:'unavailable',options:[],observations:[]})} as any,certifiedProjection:f.service.readCertifiedProjection});
 await context.refresh();const shown=context.forProfile({principal:{kind:'verified_server_principal',ownerId:f.state.ownerId,verified:true},state:f.state,serverNow:now});
 assert.equal(shown.plans.length,1);assert.equal(shown.plans[0].source.verifiedLevel,'initial_launch');assert.equal(shown.plans[0].deliveryEligible,true);assert.equal(shown.addressCatalogStatus,'unavailable');
 assert.equal(f.state.profile.locations[0].binding.status,'needs_confirmation');assert.equal(shown.manualGroups?.length,1);
});
