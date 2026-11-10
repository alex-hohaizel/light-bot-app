import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectLegacyLiveProfile,legacyLiveAddressId,type LegacyLiveProfileInput} from '../../server/production/legacy-profile.ts';
import {createBotState} from '../../shared/bot/engine.ts';
import {canDeliver} from '../../shared/schedule-core.ts';
import {createSourceIntake,SOURCE_PROFILES} from '../../server/production/source-intake.ts';
import {technicalDisplaySourceRegistry} from '../../server/production/source-operating-policy.ts';
import {createProductionScheduleCertification} from '../../server/production/schedule-certification.ts';
import {validInitialLaunchCertificate} from '../../server/production/schedule-events.ts';

const owner='synthetic-legacy-group-owner',now='2026-11-10T10:05:00.000Z',epoch=7;
const scopes=[
  {city:'Київ',sourceId:'yasno-kem',operatorId:'dtek-kem',namespace:'yasno:25/902',prefix:''},
  {city:'Вінниця',sourceId:'voe-mirror-vn-progr',operatorId:'vinnytsia-oe',namespace:'voe:vinnytsia',prefix:'GPV'},
  {city:'Одеса',sourceId:'mirror-odesa',operatorId:'dtek-oem',namespace:'dtek:oem',prefix:'GPV'},
  {city:'Харків',sourceId:'kharkiv-official-rss',operatorId:'kharkiv-oe',namespace:'kharkiv:rss',prefix:''},
];
function input(city='Вінниця',queueId:string|null='1.1'):LegacyLiveProfileInput {
 const timing={quietHoursEnabled:false,quietHoursStart:23,quietHoursEnd:7,morningBriefingEnabled:false,morningBriefingHour:8,minOutageDuration:0};
 const address={city,queueId,lookupMode:'address',street:'Синтетична вулиця',houseNumber:'12А'};
 return {ownerId:owner,identity:{kind:'verified_server_principal',ownerId:owner,verified:true},settings:{userId:owner,...address,...timing,
  notificationsEnabled:false,notifyBeforeOff:0,notifyBeforeOn:15,telegramNotifications:true,telegramNotifyBeforeOff:30,telegramNotifyBeforeOn:0,themeMode:'dark',hasSeenOnboarding:true},
  locations:[{id:2,userId:owner,...address,name:'Робота',isPrimary:false,orderIndex:9,notifyEnabled:false,telegramNotify:false,notifyBeforeOff:0,notifyBeforeOn:5},
   {id:7,userId:owner,...address,houseNumber:'14/2',name:'Дім',isPrimary:true,orderIndex:2,notifyEnabled:true,telegramNotify:true,notifyBeforeOff:20,notifyBeforeOn:0}],subscribers:[]};
}
test('exact four persisted cities retain each historical group in the current source namespace',()=>{
 for(const scope of scopes)for(let group=1;group<=6;group++)for(const half of [1,2]){
  const queue=`${group}.${half}`,source=input(scope.city,queue),before=structuredClone(source),r=projectLegacyLiveProfile(source);
  assert.deepEqual(source,before);const p=SOURCE_PROFILES.find(p=>p.sourceId===scope.sourceId)!;
  for(const l of r.profile.locations){assert.equal(l.binding.operatorId,p.operatorId);assert.equal(l.binding.namespace,p.namespace);assert.equal(l.binding.targetId,scope.prefix+queue);
   assert.equal(l.binding.kind,'user_selected_group');assert.equal(l.binding.status,'needs_confirmation');assert.equal(l.binding.verifiedAt,null);assert.equal(l.binding.effectiveFrom,null);assert.equal(l.binding.effectiveUntil,null);}
  assert.equal(r.deliveryEligible,false);assert.deepEqual(r.issues,[]);
 }
 for(const city of ['Вінниця','Одеса'])assert.equal(projectLegacyLiveProfile(input(city,'GPV2.1')).profile.locations[0].binding.targetId,'GPV2.1');
});
test('unknown, region namesakes, mixed groups and unsupported group formats remain unresolved',()=>{
 for(const city of ['Київська область','Kyiv','Киев','м. Київ','Вінницька область','Одеська область','Харківська область','Дніпро','ДНЕМ','ЦЕК','unknown','']){
  const r=projectLegacyLiveProfile(input(city));assert(r.profile.locations.every(l=>l.binding.operatorId==='legacy-operator-unresolved'));
  assert.deepEqual(r.issues,[]);
 }
 for(const city of scopes.map(s=>s.city))for(const queue of ['',null,'7.1','0.1','1.3','1.1,2.1','1.1/2.1','1','01.1',' 1.1','gpv1.1']){
  const r=projectLegacyLiveProfile(input(city,queue));assert(r.profile.locations.every(l=>l.binding.operatorId==='legacy-operator-unresolved'));
 }
 for(const city of ['Київ','Харків'])assert.equal(projectLegacyLiveProfile(input(city,'GPV1.1')).profile.locations[0].binding.operatorId,'legacy-operator-unresolved');
});
test('group bridge preserves two saved identities, raw rows, ordering, primary and all policy values',()=>{
 const source=input(),r=projectLegacyLiveProfile(source);
 assert.deepEqual(r.profile.locations.map(l=>[l.address.id,l.address.label,l.address.house.literal]),[
  [legacyLiveAddressId(owner,'user_locations',7),'Дім','14/2'],[legacyLiveAddressId(owner,'user_locations',2),'Робота','12А']]);
 assert.equal(r.profile.primaryAddressId,legacyLiveAddressId(owner,'user_locations',7));
 for(const row of source.locations)assert.deepEqual(r.provenance.find(p=>p.table==='user_locations'&&p.pk===row.id)!.raw,row);
 assert.deepEqual(r.provenance.find(p=>p.table==='user_settings')!.raw,source.settings);
 assert.equal(r.profile.legacyNotificationPolicySourceHash,r.sourceDigest);
 const unknown=structuredClone(source);unknown.locations.forEach(l=>l.city='unknown');
 const unmapped=projectLegacyLiveProfile(unknown);assert.deepEqual(r.profile.preferences,unmapped.profile.preferences);
 assert.deepEqual(r.profile.locations.map(l=>l.notificationPolicy),unmapped.profile.locations.map(l=>l.notificationPolicy));
 assert.equal(r.profile.locations[1].notifications,false);
 const restart=structuredClone(source);restart.locations.reverse();assert.deepEqual(projectLegacyLiveProfile(restart),r);
 const duplicate=structuredClone(source);duplicate.locations.push(duplicate.locations[0]);assert.throws(()=>projectLegacyLiveProfile(duplicate),/DUPLICATE_PK/);
});

/** Local SQL oracle using existing public body bytes; no DB/network/sends. */
async function launchFixture(optedIn=true){
 const source=input();source.settings!.telegramNotifications=optedIn;
 const projection=projectLegacyLiveProfile(source),state=createBotState({ownerId:owner,sessionId:'synthetic-legacy-bridge-session'});state.profile=projection.profile;
 const location=state.profile.locations[0],p=SOURCE_PROFILES.find(p=>p.sourceId==='voe-mirror-vn-progr')!;
 const raw=readFileSync(new URL('./fixtures/vinnytsia-mirror-2026-11-10.json',import.meta.url),'utf8');
 const intake=createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>Date.parse(now),transport:async r=>({url:r.url,status:200,headers:{'content-type':'text/plain'},body:(async function*(){yield Buffer.from(raw);})()})});
 const result=await intake.load({sourceId:p.sourceId,operatorId:location.binding.operatorId,namespace:location.binding.namespace,targetId:location.binding.targetId,serviceDate:'2026-11-10'});
 assert.equal(result.state,'available');if(result.state!=='available')throw Error('public fixture unavailable');
 const view={...result.view,addressId:location.address.id},snapshot=intake.snapshotRaw(p.sourceId)!;
 const rawId='11111111-1111-4111-a111-111111111111',runId='22222222-2222-4222-a222-222222222222',records:any[]=[];
 const client={async query(sql:string,values:any[]=[]):Promise<any>{let rows:any[]=[];
  if(sql.includes('from lba_production_control'))rows=[{control_epoch:epoch,writer_mode:'canonical'}];
  else if(sql.includes('from lba_public_source_plan'))rows=[{source_id:p.sourceId,target_id:view.targetId,service_date:view.serviceDate,raw_id:rawId}];
  else if(sql.includes('from lba_public_source_raw'))rows=[{source_id:p.sourceId,run_id:runId,observed_at:now,snapshot}];
  else if(sql.includes('from lba_public_source_run'))rows=[{source_id:p.sourceId,control_epoch:epoch,status:'published',started_at:now,finished_at:now}];
  else if(sql.includes('from lba_public_source_state'))rows=[{last_attempt_at:now,last_success_at:now,last_failure:null}];
  else if(sql.startsWith('insert into lba_production_schedule_certificate'))records.push(JSON.parse(values[10]));
  else if(sql.includes('from lba_production_schedule_certificate'))rows=[];
  else if(!sql.startsWith('update lba_production_schedule_certificate')&&!sql.includes('lba_production_profile_outbox'))throw Error('unexpected SQL: '+sql);
  return {rows,rowCount:rows.length};},release(){}};
 const service=createProductionScheduleCertification({enabled:true,initialLaunchNotifications:true,expectedControlEpoch:epoch,now:()=>Date.parse(now),pool:{connect:async()=>client},
  store:{commitCertifiedBinding:async(_p:any,_expected:any,operation:any)=>operation({client,state:structuredClone(state),serverNow:now,persistBinding:async()=>{throw Error('MUST_KEEP_LEGACY_GROUP');}})} as any,
  sources:{} as any,catalog:{} as any});
 return {source,projection,state,view,service,records};
}
test('saved legacy group matches current public technical plan and receives only initial-launch group authority',async()=>{
 const f=await launchFixture(),before=structuredClone(f.state),binding=f.state.profile.locations[0].binding;
 assert.equal(f.view.operatorId,binding.operatorId);assert.equal(f.view.namespace,binding.namespace);assert.equal(f.view.targetId,binding.targetId);
 assert.equal((await f.service.issue({state:f.state,view:f.view,signal:new AbortController().signal})).kind,'issued');
 const c=f.records[0];assert(validInitialLaunchCertificate(c,now));assert.equal(c.kind,'lba-certified-schedule/3');assert.deepEqual(c.binding,binding);
 assert.equal(c.parallel48hEvidence,undefined);assert.equal(c.initialLaunchEvidence.buildingVerified,false);assert.equal(c.initialLaunchEvidence.physicalStatus,'unknown');
 assert.equal(c.addressEvidence.kind,'accepted_group_selection');assert.equal(c.view.source.verifiedLevel,'initial_launch');assert(canDeliver(c.view,c.binding,f.state.profile.preferences,now));
 assert.deepEqual(f.state,before);assert.equal(f.projection.deliveryEligible,false);
 const off=await launchFixture(false);await off.service.issue({state:off.state,view:off.view,signal:new AbortController().signal});
 assert.equal(off.state.profile.preferences.optedIn,false);assert.equal(canDeliver(off.records[0].view,off.records[0].binding,off.state.profile.preferences,now),false);
});
