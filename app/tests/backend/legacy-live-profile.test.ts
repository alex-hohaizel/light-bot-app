import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectLegacyLiveProfile, legacyLiveAddressId, type LegacyLiveProfileInput} from '../../server/production/legacy-profile.ts';
import {reminderLeadMinutes, resolveNotificationPolicy} from '../../shared/notification-policy.ts';

const owner='qa-real-schema-owner';
const timing={quietHoursEnabled:true,quietHoursStart:0,quietHoursEnd:7,morningBriefingEnabled:true,morningBriefingHour:0,minOutageDuration:25};
const address={city:'Вінниця',lookupMode:'address',street:'Вулиця прикладу',houseNumber:'12/1',queueId:'1.1'};
function input():LegacyLiveProfileInput {
  return {ownerId:owner,identity:{kind:'verified_server_principal',ownerId:owner,verified:true},settings:{userId:owner,...address,...timing,
    notificationsEnabled:false,notifyBeforeOff:0,notifyBeforeOn:15,telegramNotifications:true,telegramNotifyBeforeOff:30,telegramNotifyBeforeOn:5,
    themeMode:'elegant',hasSeenOnboarding:true},locations:[
      {id:9,userId:owner,...address,name:'Батьки',isPrimary:true,orderIndex:2,notifyEnabled:true,telegramNotify:false,notifyBeforeOff:0,notifyBeforeOn:10},
      {id:4,userId:owner,...address,houseNumber:'12А',name:'Дім',isPrimary:false,orderIndex:1,notifyEnabled:false,telegramNotify:true,notifyBeforeOff:20,notifyBeforeOn:0},
    ],subscribers:[{chatId:'101',userId:owner,...address,...timing,enabled:true,notifyBeforeOff:30,notifyBeforeOn:5}]};
}

test('canonical owned SQL rows preserve exact owner, stable PK IDs, labels, primary and order without mutation',()=>{
  const source=input(),before=structuredClone(source),result=projectLegacyLiveProfile(source);
  assert.deepEqual(source,before); assert.equal(result.profile.id,owner);
  assert.deepEqual(result.profile.locations.map(row=>row.address.label),['Дім','Батьки']);
  assert.equal(result.profile.primaryAddressId,legacyLiveAddressId(owner,'user_locations',9));
  assert.equal(result.profile.locations[0].address.house.literal,'12А');
  assert.equal(result.provenance.length,4); assert(result.provenance.every(row=>/^[a-f0-9]{64}$/.test(row.digest)));
  assert.equal(result.deliveryEligible,false);
});
test('global and address policies preserve independent channels, edges and explicit0; hours become minutes once',()=>{
  const {profile}=projectLegacyLiveProfile(input()),home=profile.locations[0],parents=profile.locations[1];
  assert.equal(profile.preferences.minimumOutageMinutes,1500);
  assert.equal(profile.preferences.quietHours.start,'00:00');assert.equal(profile.preferences.morningBriefing.time,'00:00');
  assert.equal(profile.preferences.notificationPolicy!.channels.push.enabled,false);
  assert.equal(profile.preferences.notificationPolicy!.channels.push.beforeOffMinutes,0);
  assert.equal(profile.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes,5);
  assert.equal(reminderLeadMinutes(profile.preferences,home,'telegram','starts'),20);
  assert.equal(reminderLeadMinutes(profile.preferences,home,'telegram','ends'),0);
  assert.equal(resolveNotificationPolicy(profile.preferences,parents,'telegram').enabled,false);
  assert.equal(resolveNotificationPolicy(profile.preferences,parents,'push').enabled,false);
});
test('all bindings require confirmation: no operator/address verification or delivery grant is inferred from consent',()=>{
  const result=projectLegacyLiveProfile(input());assert.equal(result.profile.preferences.optedIn,true);
  for(const row of result.profile.locations){assert.equal(row.binding.status,'needs_confirmation');assert.equal(row.binding.verifiedAt,null);
    assert.equal(row.binding.kind,'user_selected_group');assert.equal(row.binding.operatorId,'legacy-operator-unresolved');}
  assert.equal(result.deliveryEligible,false);
});
test('row ordering, JSON restart and irrelevant metadata do not change projection; rename changes source digest, not address ID',()=>{
  const source=input(),first=projectLegacyLiveProfile(source); source.locations=[...source.locations].reverse();
  assert.deepEqual(projectLegacyLiveProfile(JSON.parse(JSON.stringify(source))),first);
  const renamed=input();renamed.locations[0].name='Рідні';const after=projectLegacyLiveProfile(renamed);
  assert.equal(after.profile.primaryAddressId,first.profile.primaryAddressId);assert.notEqual(after.sourceDigest,first.sourceDigest);
  const metadata=input();Object.assign(metadata.locations[0],{createdAt:new Date(),lastNotifKey:'kept-only-in-legacy-SQL',shareId:'not-a-publication'});
  assert.deepEqual(projectLegacyLiveProfile(metadata),first);
});
test('zero or one source location never invents primary; multiple explicit primary is rejected',()=>{
  const zero=input();zero.locations=[];zero.settings=null;zero.subscribers=[];
  assert.equal(projectLegacyLiveProfile(zero).profile.primaryAddressId,null);assert.deepEqual(projectLegacyLiveProfile(zero).profile.locations,[]);
  const one=input();one.locations=[one.locations[1]];
  assert.equal(projectLegacyLiveProfile(one).profile.primaryAddressId,null);
  const bad=input();bad.locations.forEach(row=>row.isPrimary=true);
  assert.throws(()=>projectLegacyLiveProfile(bad),/LEGACY_PROFILE_AMBIGUOUS_PRIMARY/);
});
test('foreign owners, orphans, guessed tg prefixes and unverified principal cannot be adopted',()=>{
  for(const table of ['settings','locations','subscribers'] as const){const bad=input();
    if(table==='settings')bad.settings!.userId='foreign';else bad[table][0].userId='foreign';
    assert.throws(()=>projectLegacyLiveProfile(bad),/LEGACY_PROFILE_FOREIGN_OWNER/);}
  const orphan=input();orphan.subscribers[0].userId=null;assert.throws(()=>projectLegacyLiveProfile(orphan),/FOREIGN_OWNER/);
  const unverified=input();Object.assign(unverified.identity,{verified:false});assert.throws(()=>projectLegacyLiveProfile(unverified),/VERIFIED_IDENTITY_REQUIRED/);
  const foreign=input();foreign.identity.ownerId='tg_101';assert.throws(()=>projectLegacyLiveProfile(foreign),/VERIFIED_IDENTITY_REQUIRED/);
  assert.notEqual(legacyLiveAddressId(owner,'user_locations',9),legacyLiveAddressId('other','user_locations',9));
});
test('duplicate source PK is refused even with identical data, without silently merging accounts or endpoint addresses',()=>{
  const duplicate=input();duplicate.locations=[...duplicate.locations,structuredClone(duplicate.locations[0])];assert.throws(()=>projectLegacyLiveProfile(duplicate),/DUPLICATE_PK/);
  const chats=input();chats.subscribers=[...chats.subscribers,structuredClone(chats.subscribers[0])];assert.throws(()=>projectLegacyLiveProfile(chats),/DUPLICATE_PK/);
});
test('settings/subscriber contradictions close Telegram and retain source values; Push stays independent',()=>{
  for(const patch of [{enabled:false},{notifyBeforeOn:99},{quietHoursStart:22}]){
    const source=input();source.settings!.notificationsEnabled=true;Object.assign(source.subscribers[0],patch);
    const result=projectLegacyLiveProfile(source);assert.equal(result.profile.preferences.optedIn,false);
    assert.equal(result.profile.preferences.notificationPolicy!.channels.push.enabled,true);assert(result.issues.length>0);
    const raw=result.provenance.find(row=>row.table==='telegram_subscribers')!.raw;
    for(const [key,value] of Object.entries(patch))assert.equal(raw[key],value);
  }
});
test('positive per-address override remains available when global leads0, but global opt-out cannot be bypassed',()=>{
  const source=input();source.settings!.telegramNotifyBeforeOff=0;source.settings!.telegramNotifyBeforeOn=0;
  source.subscribers[0].notifyBeforeOff=0;source.subscribers[0].notifyBeforeOn=0;
  const {profile}=projectLegacyLiveProfile(source);assert.equal(profile.preferences.reminders,true);
  assert.equal(reminderLeadMinutes(profile.preferences,profile.locations[0],'telegram','starts'),20);
  source.settings!.telegramNotifications=false;const off=projectLegacyLiveProfile(source).profile;
  assert.equal(reminderLeadMinutes(off.preferences,off.locations[0],'telegram','starts'),0);
});
test('settings-only carrier preserves separate edge policies; subscriber-only never invents Push or a Telegram account link',()=>{
  const settings=input();settings.locations=[];const first=projectLegacyLiveProfile(settings);
  assert.equal(first.addressCarrier,'user_settings');assert.equal(first.profile.locations.length,1);
  assert.equal(first.profile.locations[0].notificationPolicy!.channels.push.beforeOffMinutes,0);
  assert.equal(first.profile.locations[0].notificationPolicy!.channels.telegram.beforeOffMinutes,30);
  const subscriber=input();subscriber.locations=[];subscriber.settings=null;
  const second=projectLegacyLiveProfile(subscriber);assert.equal(second.addressCarrier,'telegram_subscribers');
  assert.equal(second.profile.id,owner);assert.equal(second.profile.preferences.notificationPolicy!.channels.push.enabled,false);
  assert.equal(second.profile.locations[0].notificationPolicy!.channels.push.beforeOnMinutes,0);
});
test('incomplete address is retained without default-city invention; differing noncanonical carrier remains explicit provenance',()=>{
  const source=input();source.locations[0].city=null;source.locations[0].houseNumber=null;
  const result=projectLegacyLiveProfile(source);const unknown=result.profile.locations.find(row=>row.address.label==='Батьки')!;
  assert.equal(unknown.address.locality,'');assert.equal(unknown.address.house.literal,'');assert.equal(unknown.binding.status,'needs_confirmation');
  const other=input();other.settings!.houseNumber='999';const projected=projectLegacyLiveProfile(other);
  assert.equal(projected.profile.locations.length,2);assert(projected.issues.some(row=>row.code==='legacy_address_carriers_differ'));
  assert.equal(projected.provenance.find(row=>row.table==='user_settings')!.raw.houseNumber,'999');
});
test('malformed and unsupported policies fail closed, and no credential is archived or accepted',()=>{
  for(const [field,value] of [['notifyBeforeOff',null],['notifyBeforeOn',-1],['notifyBeforeOn',1441],['notificationsEnabled','false']]){
    const source=input();Object.assign(source.settings!,{[field as string]:value});assert.throws(()=>projectLegacyLiveProfile(source));}
  const unknown=input();Object.assign(unknown.settings!,{notificationsFuture:true});assert.throws(()=>projectLegacyLiveProfile(unknown),/UNMAPPED_POLICY/);
  const secret=input();Object.assign(secret.subscribers[0],{sessionToken:'own-inert-test-value'});assert.throws(()=>projectLegacyLiveProfile(secret),/CREDENTIAL_FIELD/);
  const source=input();source.settings!.quietHoursEnd=0;const result=projectLegacyLiveProfile(source);
  assert.equal(result.profile.preferences.quietHours.enabled,false);assert.equal(result.profile.preferences.quietHours.end,'00:00');
  assert(result.issues.some(row=>row.code==='legacy_equal_quiet_bounds_preserved'));
});
test('null settings and two owned endpoints use deterministic common-policy reconciliation',()=>{
  const source=input();source.settings=null;source.locations=[];source.subscribers=[...source.subscribers,{...source.subscribers[0],chatId:'202',houseNumber:'15',notifyBeforeOn:7}];
  const first=projectLegacyLiveProfile(source);source.subscribers=[...source.subscribers].reverse();assert.deepEqual(projectLegacyLiveProfile(source),first);
  assert.equal(first.profile.locations.length,2);assert.equal(first.profile.primaryAddressId,null);assert.equal(first.profile.preferences.optedIn,false);
  assert(first.issues.some(row=>row.code==='legacy_endpoint_thresholds_disagree'));
});

test('binding revision ignores label/order/primary/channel/leads and settings appearance while provenance still changes',()=>{
  const variants:Array<[LegacyLiveProfileInput,(source:LegacyLiveProfileInput)=>void]>=[
    [input(),source=>{source.locations[0].name='Рідні';}],
    [input(),source=>{source.locations[0].orderIndex=-1;}],
    [input(),source=>{source.locations[0].isPrimary=false;source.locations[1].isPrimary=true;}],
    [input(),source=>{source.locations[0].telegramNotify=true;source.locations[0].notifyEnabled=false;}],
    [input(),source=>{source.locations[0].notifyBeforeOff=7;source.locations[0].notifyBeforeOn=0;}],
  ];
  const settings=input();settings.locations=[];
  variants.push([settings,source=>{source.settings!.themeMode='dark';source.settings!.hasSeenOnboarding=false;source.settings!.telegramNotifications=false;source.settings!.notifyBeforeOn=0;}]);
  const subscriber=input();subscriber.locations=[];subscriber.settings=null;
  variants.push([subscriber,source=>{source.subscribers[0].enabled=false;source.subscribers[0].quietHoursStart=22;source.subscribers[0].notifyBeforeOff=0;}]);
  for(const [source,edit] of variants){
    const before=projectLegacyLiveProfile(source);edit(source);const after=projectLegacyLiveProfile(source);
    assert.notEqual(after.sourceDigest,before.sourceDigest);
    for(const old of before.profile.locations){const current=after.profile.locations.find(row=>row.address.id===old.address.id)!;
      assert.equal(current.binding.revisionId,old.binding.revisionId);assert.deepEqual(current.binding,old.binding);}
  }
});

test('binding revision changes for each physical/source-group field while the saved PK address ID remains stable',()=>{
  for(const [field,value] of [['city','Київ'],['lookupMode','queue'],['street','Інша вулиця'],['houseNumber','15'],['queueId','2.1']] as const){
    const source=input(),before=projectLegacyLiveProfile(source),id=legacyLiveAddressId(owner,'user_locations',9);
    source.locations[0][field]=value;const after=projectLegacyLiveProfile(source);
    assert.equal(after.profile.locations.find(row=>row.address.id===id)!.address.id,id);
    assert.notEqual(after.profile.locations.find(row=>row.address.id===id)!.binding.revisionId,before.profile.locations.find(row=>row.address.id===id)!.binding.revisionId);
    assert.notEqual(after.sourceDigest,before.sourceDigest);
  }
});
