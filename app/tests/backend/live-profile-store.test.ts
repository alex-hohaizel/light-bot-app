import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createProductionProfileStore,PRODUCTION_PROFILE_SCHEMA_SQL,type ProductionProfileStoreOptions,type VerifiedEmptyAccountBootstrap} from '../../server/production/profile-store.ts';
import {selectLegacyLiveProfileInTransaction,type VerifiedLegacyPrincipal} from '../../server/production/profile-reader.ts';
import type {AddressOption,BotState} from '../../shared/bot/types.ts';
import type {ScheduleView} from '../../shared/product-contract.ts';

const owner='fixture-owner',identity:VerifiedLegacyPrincipal={kind:'verified_server_principal',ownerId:owner,verified:true};
const now='2026-11-08T18:00:00Z';
const address={city:'Fixture locality',lookupMode:'queue',street:'Fixture street',houseNumber:'12A',queueId:'1.1'};
const timing={quietHoursEnabled:false,quietHoursStart:0,quietHoursEnd:7,morningBriefingEnabled:false,morningBriefingHour:0,minOutageDuration:0};
const settings={userId:owner,...address,...timing,notificationsEnabled:false,notifyBeforeOff:0,notifyBeforeOn:15,telegramNotifications:false,telegramNotifyBeforeOff:0,telegramNotifyBeforeOn:30,themeMode:'light',hasSeenOnboarding:true,telegramChatId:null};
const location=(id=1)=>({id,userId:owner,name:'Fixture place '+id,...address,houseNumber:id===1?'12A':'12B',queueId:id===1?'1.1':'2.1',isPrimary:id===1,orderIndex:id,notifyEnabled:false,telegramNotify:false,notifyBeforeOff:0,notifyBeforeOn:30});
const option:AddressOption={id:'verified-option',address:{id:'verified-address',label:'Fixture verified',territoryId:'fixture-territory',locality:'Fixture locality',street:'Fixture street',house:{number:'14',literal:'14'},aliases:[]},binding:{addressId:'verified-address',operatorId:'fixture-operator',namespace:'fixture:namespace',targetId:'1.1',kind:'building',revisionId:'binding-1',status:'verified',verifiedAt:'2026-11-08T17:00:00Z',effectiveFrom:null,effectiveUntil:null},territoryLabel:'Fixture territory'};
const plan=(patch:Partial<ScheduleView>={}):ScheduleView=>({contractVersion:'lba-product/1',revisionId:'fixture-plan-1',addressId:option.address.id,addressLabel:'Fixture verified',localityLabel:'Fixture locality',operatorId:option.binding.operatorId,namespace:option.binding.namespace,targetId:option.binding.targetId,bindingRevisionId:option.binding.revisionId,serviceDate:'2026-11-08',timezone:'Europe/Kyiv',status:'no_planned_outages',dayCoverage:'complete',intervals:[],source:{id:'fixture-source',name:'Fixture source',url:'https://fixture.example/plan',revision:'fixture-source-revision',accessCost:0,verifiedLevel:'schedule'},publishedAt:'2026-11-08T17:00:00Z',observedAt:now,freshness:'current',synthetic:false,deliveryEligible:false,...patch});
type DB={profiles:Record<string,any>;origins:Record<string,any>;bootstrap:Record<string,any>;inbox:Record<string,any>;outbox:any[]};
class Port {
 data:DB={profiles:{},origins:{},bootstrap:{},inbox:{},outbox:[]};
 registry:Record<string,{id:string;createdAt:string;updatedAt:string}>={[owner]:{id:owner,createdAt:now,updatedAt:now}};
 control:any={controlEpoch:'7',writerMode:'canonical'};
 legacy={settings:[structuredClone(settings)] as any[],locations:[location(),location(2)] as any[],subscribers:[] as any[]};
 calls:Array<{sql:string;values:any[]}>=[];connects=0;releases=0;legacyReads=0;
 fail:((q:string)=>void)|null=null;commit:'normal'|'unknown_saved'|'unknown_not_saved'='normal';stateOverride:((row:any)=>any)|null=null;
 pool={connect:async()=>{this.connects++;let tx:DB|null=null;
  return {query:async(sql:string,values:any[]=[])=>{
   const q=sql.replace(/\s+/g,' ').trim();this.calls.push({sql:q,values:structuredClone(values)});this.fail?.(q);
   const result=(rows:any[],rowCount=rows.length)=>({rows:structuredClone(rows),rowCount});
   if(q==='begin isolation level repeatable read'||q==='begin isolation level read committed'){tx=structuredClone(this.data);return result([]);}
   if(q==='commit'){const mode=this.commit;this.commit='normal';if(mode!=='unknown_not_saved')this.data=tx!;tx=null;if(mode!=='normal')throw Error('PRIVATE_COMMIT_TRANSPORT');return result([]);}
   if(q==='rollback'){tx=null;return result([]);}
   assert(tx,'every store query must be in its caller-owned transaction');
   if(q.startsWith('select control_epoch'))return result(this.control?[this.control]:[]);
   if(q.startsWith('select pg_advisory_xact_lock'))return result([]);
   const db=tx,who=values[0];
   if(q.startsWith('select owner_id as')){const row=db.profiles[who];return result(row?[this.stateOverride?this.stateOverride(row):row]:[]);}
   if(q.startsWith('select source_digest'))return result(db.origins[who]?[{source_digest:db.origins[who].sourceDigest}]:[]);
   if(q.startsWith('select session_id as'))return result(db.bootstrap[who]?[{sessionId:db.bootstrap[who].sessionId}]:[]);
   if(q==='select id,created_at as "createdAt",updated_at as "updatedAt" from users where id=$1')return result(this.registry[who]?[this.registry[who]]:[]);
   if(q.startsWith('select input_digest'))return result(db.inbox[who+'|'+values[1]]?[db.inbox[who+'|'+values[1]]]:[]);
   if(q.startsWith('insert into lba_production_profiles(')){assert(!db.profiles[who]);db.profiles[who]={ownerId:who,sessionId:values[1],revision:values[2],epoch:values[3],state:JSON.parse(values[4])};return result([],1);}
   if(q.startsWith('insert into lba_production_profile_origins(')){assert(!db.origins[who]);db.origins[who]={sourceDigest:values[1],projectionDigest:values[2],private:JSON.parse(values[3])};return result([],1);}
   if(q.startsWith('insert into lba_production_bootstrap_ledger(')){assert(!db.bootstrap[who]);db.bootstrap[who]={sessionId:values[1],sourceDigest:values[2],kind:values[3],initializedAt:values[4],epoch:values[5]};return result([],1);}
   if(q.startsWith('update lba_production_profiles set')){const row=db.profiles[who];if(!row||row.sessionId!==values[1]||row.revision!==values[2])return result([],0);row.revision=values[3];row.state=JSON.parse(values[4]);row.epoch=values[5];return result([],1);}
   if(q.startsWith('insert into lba_production_profile_inbox(')){const key=who+'|'+values[1];assert(!db.inbox[key]);db.inbox[key]={inputDigest:values[2],receipt:JSON.parse(values[3])};return result([],1);}
   if(q.startsWith('insert into lba_production_profile_outbox(')){db.outbox.push({id:values[0],owner:values[1],inputId:values[2],sessionId:values[3],revision:values[4],controlEpoch:values[5],ordinal:values[6],addressId:values[7],kind:values[8],payload:JSON.parse(values[9]),createdAt:values[10],status:'pending'});return result([],1);}
   if(q.startsWith('update lba_production_profile_outbox set')){for(const o of db.outbox)if(o.owner===who&&o.status==='pending'&&o.kind==='notification'&&(values[1]===null||o.addressId===values[1]))o.status='cancelled';return result([]);}
   if(q.startsWith('select id,input_id as'))return result(db.outbox.filter(o=>o.owner===who&&o.status==='pending'&&o.controlEpoch===values[1]&&o.sessionId===db.profiles[who]?.sessionId).sort((a,b)=>a.revision-b.revision||a.ordinal-b.ordinal||a.id.localeCompare(b.id)).slice(0,values[2]));
   this.legacyReads++;
   if(q.includes('(select count(*) from user_settings'))return result([{settings:String(this.legacy.settings.filter(r=>r.userId===who).length),locations:String(this.legacy.locations.filter(r=>r.userId===who).length),subscribers:String(this.legacy.subscribers.filter(r=>r.userId===who).length)}]);
   if(q.includes('from user_settings where user_id=$1'))return result(this.legacy.settings.filter(r=>r.userId===who));
   if(q.includes('from user_locations where user_id=$1'))return result(this.legacy.locations.filter(r=>r.userId===who));
   if(q.includes('filter(where user_id is null)')){const rows=this.legacy.subscribers.filter(r=>values[1].includes(r.chatId));return result([{total:String(rows.length),unowned:String(rows.filter(r=>r.userId===null).length),owned:String(rows.filter(r=>r.userId===who).length),foreign:String(rows.filter(r=>r.userId!==null&&r.userId!==who).length)}]);}
   if(q.includes('from telegram_subscribers where user_id=$1'))return result(this.legacy.subscribers.filter(r=>r.userId===who||r.userId===null&&values[1].includes(r.chatId)));
   throw Error('unsupported fixture SQL');
  },release:()=>{this.releases++;}};
 }};
 store(patch:Partial<ProductionProfileStoreOptions>={}){return createProductionProfileStore({pool:this.pool,enabled:true,expectedControlEpoch:7,now:()=>now,context:()=>({addresses:[structuredClone(option)],plans:[]}),...patch});}
}
const app=(s:{sessionId:string;revision:number},id:string,mutation:unknown)=>({id,expectedSessionId:s.sessionId,expectedRevision:s.revision,mutation});
const emptyProof=(input:Parameters<NonNullable<ProductionProfileStoreOptions['verifyEmptyAccount']>>[0],accountState:'new'|'existing_empty'='new'):VerifiedEmptyAccountBootstrap=>({kind:'verified_empty_account',ownerId:input.principal.ownerId,accountState,accountRevisionId:'registry-revision-1',evidenceRef:'fixture-registry-proof',legacySourceDigest:input.legacySourceDigest,verifiedAt:input.serverNow});
const emptyLegacy=(p:Port)=>{p.legacy.settings=[];p.legacy.locations=[];p.legacy.subscribers=[];};

test('default disabled, invalid principals and owner fields deny before pool access; control missing/legacy/disabled/epoch deny before owner/bootstrap',async()=>{
 const p=new Port();await assert.rejects(p.store({enabled:undefined}).snapshot(identity),/STORE_DISABLED/);assert.equal(p.connects,0);
 for(const bad of [{...identity,verified:false},{...identity,ownerId:''},{...identity,ownerId:'bad\nowner'},{...identity,ownerId:owner,extra:true}])await assert.rejects(p.store().snapshot(bad as any),/VERIFIED_PRINCIPAL/);
 await assert.rejects(p.store().commitBotInput(identity,{ownerId:'foreign',input:{id:'b1',kind:'command',text:'/start'}}),/INVALID_INPUT/);
 await assert.rejects(p.store().commitProfileMutation(identity,{ownerId:'foreign'}),/INVALID_INPUT/);assert.equal(p.connects,0);
 for(const control of [null,{controlEpoch:7,writerMode:'disabled'},{controlEpoch:7,writerMode:'legacy'},{controlEpoch:8,writerMode:'canonical'}]){
  const q=new Port();q.control=control;await assert.rejects(q.store().snapshot(identity),/WRITER_NOT_CANONICAL|CONTROL_EPOCH/);assert.equal(q.legacyReads,0);assert(!q.calls.some(c=>c.sql.startsWith('select pg_advisory')));assert.equal(q.calls.at(-1)?.sql,'rollback');
 }
});
test('first bootstrap is exact, private, once only and never mutates legacy rows; all paths use control before owner lock',async()=>{
 const p=new Port(),store=p.store(),before=structuredClone(p.legacy),first=await store.snapshot(identity),reads=p.legacyReads;
 assert.equal(first.runtime,'production');assert.equal(first.profile.locations.length,2);assert.equal(first.profile.locations[0].binding.status,'needs_confirmation');assert.equal(first.profile.preferences.notificationPolicy?.channels.telegram.beforeOffMinutes,0);
 assert.equal(p.calls[1].sql.endsWith('for share'),true);assert(p.calls[2].sql.startsWith('select pg_advisory'));assert(p.data.origins[owner].private.provenance.length===3);assert(!JSON.stringify(first).includes('private_provenance'));assert(!('provenance'in first));
 p.legacy.locations[0].name='Externally changed fixture';const second=await store.snapshot(identity);assert.equal(p.legacyReads,reads);assert.equal(second.sessionId,first.sessionId);assert.equal(second.profile.locations[0].address.label,'Fixture place 1');
 p.legacy=before;assert.deepEqual(p.legacy,before);assert(p.calls.every(q=>!/^\s*(?:insert into|update|delete from) (?:user_settings|user_locations|telegram_subscribers)\b/.test(q.sql)));
});
test('blocked/incomplete/orphan/empty or conflicting bootstrap never creates canonical state; origin prevents automatic rebootstrap',async()=>{
 for(const alter of [(p:Port)=>{p.legacy.settings[0].telegramChatId='unverified-chat';},(p:Port)=>{p.legacy.settings=[];p.legacy.locations=[];},(p:Port)=>{p.legacy.settings[0].street='Other physical fixture';}]){
  const p=new Port();alter(p);await assert.rejects(p.store().snapshot(identity),/BOOTSTRAP_BLOCKED|BOOTSTRAP_EMPTY/);assert.deepEqual(p.data.profiles,{});assert.deepEqual(p.data.origins,{});
 }
 const p=new Port(),store=p.store();await store.snapshot(identity);delete p.data.profiles[owner];await assert.rejects(store.snapshot(identity),/REBOOTSTRAP_FORBIDDEN/);
});
test('App mutations use shared contracts for rename/order/primary/pause/preferences/delete/add/replace, retaining legacy originals',async()=>{
 const p=new Port(),store=p.store(),legacy=structuredClone(p.legacy);let s=await store.snapshot(identity),id=0;
 const mutate=async(m:unknown)=>{const r=await store.commitProfileMutation(identity,app(s,'a'+(++id),m));s=r.snapshot;assert.equal(r.replayed,false);assert.equal(r.receipt.delivery,'none');return r;};
 const a=s.profile.locations[0].address.id,b=s.profile.locations[1].address.id;
 await mutate({kind:'rename',addressId:a,label:'Локальна мітка'});assert.equal(s.profile.locations[0].address.label,'Локальна мітка');
 await mutate({kind:'move',addressId:b,direction:'up'});assert.equal(s.profile.locations[0].address.id,b);
 await mutate({kind:'primary',addressId:b});assert.equal(s.profile.primaryAddressId,b);
 await mutate({kind:'location',addressId:a,paused:true});assert.equal(s.profile.locations.find(l=>l.address.id===a)?.paused,true);
 await mutate({kind:'preferences',patch:{paused:true,remindBeforeMinutes:0}});assert.equal(s.profile.preferences.paused,true);assert.equal(s.profile.preferences.remindBeforeMinutes,0);
 await mutate({kind:'replace',addressId:a,optionId:option.id,bindingRevisionId:option.binding.revisionId,label:'Перевірена',confirmed:true});assert(s.profile.locations.some(l=>l.address.id===option.address.id));
 await mutate({kind:'delete',addressId:option.address.id,confirmed:true});assert(!s.profile.locations.some(l=>l.address.id===option.address.id));
 await mutate({kind:'add',optionId:option.id,bindingRevisionId:option.binding.revisionId,label:'Додана',confirmed:true});assert(s.profile.locations.some(l=>l.address.id===option.address.id));
 assert.deepEqual(p.legacy,legacy);assert.equal(Object.keys(p.data.inbox).length,8);assert.equal(s.revision,8);
});
test('session/revision CAS and durable replay reject changed semantic payload, revision and foreign owner without reapplying',async()=>{
 const p=new Port(),store=p.store(),s=await store.snapshot(identity),a=s.profile.locations[0].address.id;
 const request=app(s,'once',{kind:'rename',addressId:a,label:'Once'}),first=await store.commitProfileMutation(identity,request);
 const replayed=await store.commitProfileMutation(identity,request);assert.equal(replayed.replayed,true);assert.deepEqual(replayed.receipt,first.receipt);assert.equal(replayed.snapshot.revision,1);
 for(const changed of [{...request,expectedRevision:1},{...request,mutation:{kind:'rename',addressId:a,label:'Different'}}])await assert.rejects(store.commitProfileMutation(identity,changed),/INPUT_ID_CONFLICT/);
 await assert.rejects(store.commitProfileMutation(identity,{...request,id:'stale'}),/PROFILE_REVISION_CONFLICT/);
 await assert.rejects(store.commitProfileMutation(identity,{...request,id:'foreign-session',expectedSessionId:'other-session'}),/PROFILE_REVISION_CONFLICT/);
 const foreign={...identity,ownerId:'foreign-owner'};await assert.rejects(store.commitProfileMutation(foreign,request),/BOOTSTRAP_EMPTY/);assert.equal(p.data.profiles[owner].revision,1);assert(!p.data.profiles['foreign-owner']);
});
test('Bot provider inputs serialize current shared state, dedupe independent of moving clock/context, and stale callbacks cannot repeat mutation',async()=>{
 const p=new Port();let clock=now,calls=0;const store=p.store({now:()=>clock,context:()=>{calls++;return {addresses:[option],plans:[]};}}),s=await store.snapshot(identity);
 const request={input:{id:'provider-update-1',kind:'command',text:'/addresses'}};
 const first=await store.commitBotInput(identity,request);assert.equal(first.snapshot.revision,1);assert.equal(first.receipt.delivery,'pending');assert(first.receipt.outboxIds.length>0);
 const pending=await store.pendingOutbox(identity),button=pending[0].message.buttons.find(b=>b.label.includes('Fixture place 1'))!;assert(button);
 clock='2026-11-08T18:01:00Z';const duplicate=await store.commitBotInput(identity,request);assert.equal(duplicate.replayed,true);assert.equal(duplicate.snapshot.revision,1);assert.deepEqual(duplicate.receipt,first.receipt);
 await assert.rejects(store.commitBotInput(identity,{input:{...request.input,text:'/menu'}}),/INPUT_ID_CONFLICT/);
 await store.commitProfileMutation(identity,app(first.snapshot,'rename-after-menu',{kind:'rename',addressId:s.profile.locations[0].address.id,label:'Renamed after menu'}));
 const stale=await store.commitBotInput(identity,{input:{id:'provider-update-2',kind:'callback',callbackId:button.callbackId}});assert.equal(stale.receipt.rejected,'stale_callback');assert.equal(stale.snapshot.profile.locations[0].address.label,'Renamed after menu');
 assert.equal(p.data.outbox.length,first.receipt.outboxIds.length+stale.receipt.outboxIds.length);assert(calls>0);
});
test('optional Bot CAS is strict but trusted provider input needs no client revision; explicit invalid envelope fails before connecting',async()=>{
 const p=new Port(),store=p.store(),s=await store.snapshot(identity),before=p.connects;
 await assert.rejects(store.commitBotInput(identity,{input:{id:'bad-envelope',kind:'command',text:'/start'},expectedRevision:0}),/INVALID_INPUT/);assert.equal(p.connects,before);
 await assert.rejects(store.commitBotInput(identity,{input:{id:'bad-cas',kind:'command',text:'/start'},expectedSessionId:s.sessionId,expectedRevision:9}),/PROFILE_REVISION_CONFLICT/);
 const r=await store.commitBotInput(identity,{input:{id:'good-cas',kind:'command',text:'/start'},expectedSessionId:s.sessionId,expectedRevision:0});assert.equal(r.snapshot.revision,1);
});
test('reset and unsupported effect intents fail closed before any canned success message, state or inbox is committed',async()=>{
 const p=new Port(),store=p.store(),s=await store.snapshot(identity),original=structuredClone(p.data);
 for(const input of [{id:'reset-command',kind:'command',text:'/reset@fixture_bot'},{id:'reset-text',kind:'text',text:'/reset'}])await assert.rejects(store.commitBotInput(identity,{input}),/RESET_NOT_AUTHORIZED/);
 for(const [id,action] of [['reset-callback',{kind:'confirm_reset'}],['reset-command-callback',{kind:'command',value:'/reset'}]] as const){
  p.data.profiles[owner].state.callbacks[id]={ownerId:owner,stateRevision:0,expiresAt:'2026-11-09T00:00:00Z',consumed:false,action};
  await assert.rejects(store.commitBotInput(identity,{input:{id:'update-'+id,kind:'callback',callbackId:id}}),/RESET_NOT_AUTHORIZED/);
 }
 for(const text of ['/app','/share','/start link_opaque'])await assert.rejects(store.commitBotInput(identity,{input:{id:'effect-'+text.length,kind:'command',text}}),/EFFECT_HANDLER_REQUIRED/);
 assert.equal(p.data.profiles[owner].revision,s.revision);assert.deepEqual(p.data.inbox,original.inbox);assert.deepEqual(p.data.outbox,original.outbox);
});
test('unknown commit is recovered with the same input ID without duplicate state/outbox, even when context is unavailable',async()=>{
 for(const mode of ['unknown_saved','unknown_not_saved'] as const){
  const p=new Port();let contextDown=false;const store=p.store({context:()=>{if(contextDown)throw Error('PRIVATE_CONTEXT');return {addresses:[option],plans:[]};}}),s=await store.snapshot(identity);
  const request={input:{id:'ambiguous-provider-input',kind:'command',text:'/addresses'}};p.commit=mode;
  await assert.rejects(store.commitBotInput(identity,request),/COMMIT_UNKNOWN/);contextDown=true;
  const receipt=await store.recoverReceipt(identity,{channel:'bot',request});assert.equal(Boolean(receipt),mode==='unknown_saved');
  const lastBegin=p.calls.findLast(c=>c.sql.startsWith('begin '));assert.equal(lastBegin?.sql,'begin isolation level read committed');
  if(receipt)assert.equal(receipt.sessionRevision,1);contextDown=false;
  const retried=await store.commitBotInput(identity,request);assert.equal(retried.replayed,mode==='unknown_saved');assert.equal(retried.snapshot.revision,1);assert.equal(Object.keys(p.data.inbox).length,1);assert.equal(p.data.outbox.length,retried.receipt.outboxIds.length);assert.equal(retried.snapshot.sessionId,s.sessionId);
 }
});
test('failure between state and receipt rolls back state/outbox/inbox atomically; retryable SQL errors expose safe codes',async()=>{
 const p=new Port(),store=p.store(),s=await store.snapshot(identity),before=structuredClone(p.data);
 p.fail=q=>{if(q.startsWith('insert into lba_production_profile_inbox'))throw Error('PRIVATE_SQL_DETAIL');};
 await assert.rejects(store.commitBotInput(identity,{input:{id:'atomic-failure',kind:'command',text:'/addresses'}}),e=>e instanceof Error&&e.message==='PRODUCTION_TRANSACTION_UNCONFIRMED');assert.deepEqual(p.data,before);assert.equal(p.calls.at(-1)?.sql,'rollback');
 for(const code of ['40001','40P01','23505']){p.fail=q=>{if(q.startsWith('select owner_id'))throw Object.assign(Error('PRIVATE'),{code});};await assert.rejects(store.snapshot(identity),/TRANSACTION_RETRY_REQUIRED/);}assert.equal(p.data.profiles[owner].revision,s.revision);
});
test('row owner/session/revision corruption fails before engine; existing origin missing is not silently repaired',async()=>{
 for(const change of [(r:any)=>({...r,ownerId:'foreign'}),(r:any)=>({...r,sessionId:'foreign-session'}),(r:any)=>({...r,revision:9}),(r:any)=>({...r,state:{...r.state,ownerId:'foreign'}})]){
  const p=new Port(),store=p.store();await store.snapshot(identity);p.stateOverride=change;await assert.rejects(store.commitBotInput(identity,{input:{id:'corrupt',kind:'command',text:'/start'}}),/STORED_STATE_INVALID/);assert.equal(Object.keys(p.data.inbox).length,0);
 }
 const p=new Port(),store=p.store();await store.snapshot(identity);delete p.data.origins[owner];await assert.rejects(store.snapshot(identity),/ORIGIN_MISSING/);
});
test('context cannot inject foreign, synthetic, mismatched or unbound plans; exact verified plan is linked in durable message payload',async()=>{
 const p=new Port();let plans:ScheduleView[]=[];const store=p.store({context:()=>({addresses:[option],plans})});let s=await store.snapshot(identity);
 plans=[plan({addressId:s.profile.locations[0].address.id})];assert.deepEqual((await store.snapshot(identity)).plans,[]);
 s=(await store.commitProfileMutation(identity,app(s,'add-verified',{kind:'add',optionId:option.id,bindingRevisionId:option.binding.revisionId,label:'Verified fixture',confirmed:true}))).snapshot;
 s=(await store.commitProfileMutation(identity,app(s,'primary-verified',{kind:'primary',addressId:option.address.id}))).snapshot;
 plans=[plan({synthetic:true}),plan({operatorId:'foreign'}),plan({namespace:'foreign'}),plan({targetId:'2.1'}),plan({bindingRevisionId:'old'}),plan({addressId:'foreign-address'}),plan()];
 assert.equal((await store.snapshot(identity)).plans.length,1);
 const r=await store.commitBotInput(identity,{input:{id:'real-schedule-view',kind:'command',text:'/start'}}),pending=await store.pendingOutbox(identity);
 const message=pending.find(o=>o.message.kind==='schedule');assert(message?.schedule);assert.equal(message.schedule.synthetic,false);assert.equal(message.schedule.bindingRevisionId,option.binding.revisionId);assert.equal(message.schedule.addressLabel,'Verified fixture');assert.equal(r.receipt.delivery,'pending');assert(p.data.outbox.every(o=>o.status==='pending'));
});
test('pending cancellation affects only same-owner pending notification, never another owner, reply or already dispatched message',async()=>{
 const p=new Port(),store=p.store(),s=await store.snapshot(identity),a=s.profile.locations[0].address.id;
 p.data.outbox.push(...[['one',owner,'notification','pending'],['foreign','foreign','notification','pending'],['reply',owner,'reply','pending'],['sent',owner,'notification','sent']].map(([id,who,kind,status])=>({id,owner:who,kind,status,addressId:a})));
 await store.commitProfileMutation(identity,app(s,'pause',{kind:'location',addressId:a,paused:true}));
 assert.deepEqual(p.data.outbox.map(o=>o.status),['cancelled','pending','pending','sent']);
});
test('deleting the last address preserves the canonical empty profile and never repeats legacy import',async()=>{
 const p=new Port(),store=p.store();let s=await store.snapshot(identity);const reads=p.legacyReads;
 for(const location of [...s.profile.locations])s=(await store.commitProfileMutation(identity,app(s,'delete-'+s.revision,{kind:'delete',addressId:location.address.id,confirmed:true}))).snapshot;
 assert.equal(s.profile.locations.length,0);p.legacy.locations.push(location(99));const final=await store.snapshot(identity);
 assert.equal(final.sessionId,s.sessionId);assert.equal(final.profile.locations.length,0);assert.equal(p.legacyReads,reads);assert(p.data.origins[owner]);
});
test('App unknown commit readback replays once; receipts with unexpected private fields or mismatched channel are rejected',async()=>{
 const p=new Port(),store=p.store(),s=await store.snapshot(identity),request=app(s,'app-ambiguous',{kind:'rename',addressId:s.profile.locations[0].address.id,label:'Durable app label'});
 p.commit='unknown_saved';await assert.rejects(store.commitProfileMutation(identity,request),/COMMIT_UNKNOWN/);
 const receipt=await store.recoverReceipt(identity,{channel:'app',request});assert(receipt);const retried=await store.commitProfileMutation(identity,request);assert.equal(retried.replayed,true);assert.equal(retried.snapshot.revision,1);
 const key=owner+'|app:'+request.id,original=structuredClone(p.data.inbox[key].receipt);
 for(const bad of [{...original,privateToken:'MUST_NOT_RETURN'},{...original,channel:'bot'}]){p.data.inbox[key].receipt=bad;await assert.rejects(store.recoverReceipt(identity,{channel:'app',request}),e=>e instanceof Error&&e.message==='PRODUCTION_STORED_RECEIPT_INVALID');}
});
test('a control epoch change fences the old store and old pending messages; unknown outbox payload fields cannot override the DTO',async()=>{
 const p=new Port(),old=p.store();await old.snapshot(identity);await old.commitBotInput(identity,{input:{id:'epoch-seven',kind:'command',text:'/addresses'}});
 assert((await old.pendingOutbox(identity)).length>0);p.control.controlEpoch='8';await assert.rejects(old.pendingOutbox(identity),/CONTROL_EPOCH_CONFLICT/);
 const current=p.store({expectedControlEpoch:8});assert.deepEqual(await current.pendingOutbox(identity),[]);
 await current.commitBotInput(identity,{input:{id:'epoch-eight',kind:'command',text:'/addresses'}});const pending=await current.pendingOutbox(identity);assert(pending.length>0);assert(pending.every(o=>o.controlEpoch===8));
 const row=p.data.outbox.find(o=>o.controlEpoch===8)!;row.payload.privateToken='MUST_NOT_RETURN';await assert.rejects(current.pendingOutbox(identity),e=>e instanceof Error&&e.message==='PRODUCTION_OUTBOX_INVALID');
});
test('same-clock multi-message Bot turns retain revision/ordinal order within the current owner session',async()=>{
 const p=new Port(),store=p.store();await store.snapshot(identity);
 const first=await store.commitBotInput(identity,{input:{id:'ordered-turn-one',kind:'command',text:'/notifications_off'}}),second=await store.commitBotInput(identity,{input:{id:'ordered-turn-two',kind:'command',text:'/notifications_off'}});
 assert(first.receipt.outboxIds.length>1);assert(second.receipt.outboxIds.length>1);
 p.data.outbox.reverse();p.data.outbox.push({...p.data.outbox[0],id:'wrong-session-message',sessionId:'foreign-session',payload:{message:{...p.data.outbox[0].payload.message,id:'wrong-session-message'}}});
 const pending=await store.pendingOutbox(identity);assert.deepEqual(pending.map(o=>o.id),[...first.receipt.outboxIds,...second.receipt.outboxIds]);
 const query=p.calls.findLast(c=>c.sql.startsWith('select id,input_id as'))!.sql;assert(query.includes('order by revision,ordinal,id'));assert(query.includes('session_id=(select session_id from lba_production_profiles where owner_id=$1)'));
});
test('an explicitly selected manual technical group can display its exact current plan without certifying building binding or delivery',async()=>{
 const p=new Port();let patch:Partial<ScheduleView>={};
 const group={id:'manual-fixture-group',label:'Група 1.1',locality:'Fixture locality',territoryLabel:'Fixture territory',operatorId:'fixture-operator',namespace:'fixture:namespace',targetId:'1.1',revisionId:'manual-binding-1'};
 const store=p.store({context:({state})=>{const manual=state.profile.locations.find(l=>l.binding.revisionId===group.revisionId);return {addresses:[option],manualGroups:[group],plans:manual?[plan({addressId:manual.address.id,addressLabel:manual.address.label,bindingRevisionId:group.revisionId,...patch})]:[]};}});
 await store.snapshot(identity);await store.commitBotInput(identity,{input:{id:'manual-menu',kind:'command',text:'/queue'}});
 const button=(await store.pendingOutbox(identity)).flatMap(o=>o.message.buttons).find(b=>b.label.includes('1.1'))!;assert(button);
 const picked=await store.commitBotInput(identity,{input:{id:'manual-pick',kind:'callback',callbackId:button.callbackId}}),manual=picked.snapshot.profile.locations.find(l=>l.binding.revisionId===group.revisionId)!;
 assert.equal(manual.binding.kind,'user_selected_group');assert.equal(manual.binding.status,'needs_confirmation');assert.equal(manual.notifications,false);assert.equal(picked.snapshot.plans.length,1);assert.equal(picked.snapshot.plans[0].deliveryEligible,false);
 await store.commitBotInput(identity,{input:{id:'manual-plan-display',kind:'command',text:'/start'}});
 const shown=(await store.pendingOutbox(identity)).find(o=>o.inputId==='bot:manual-plan-display'&&o.message.kind==='schedule');assert(shown?.schedule);assert.equal(shown.schedule.deliveryEligible,false);assert.match(shown.schedule.notice??'',/вручну/);
 const variants:Partial<ScheduleView>[]=[{operatorId:'foreign'},{namespace:'foreign'},{targetId:'2.1'},{bindingRevisionId:'wrong'},{synthetic:true},{deliveryEligible:true},{freshness:'stale'},{serviceDate:'2026-11-10'},{observedAt:'2026-11-09T00:00:00Z'}];
 for(patch of variants)assert.deepEqual((await store.snapshot(identity)).plans,[]);
 patch={};p.data.profiles[owner].state.profile.locations.find((l:any)=>l.address.id===manual.address.id).binding.kind='building';assert.deepEqual((await store.snapshot(identity)).plans,[]);
});
test('nested message/button/schedule/source/interval fields and malformed message types cannot escape the stored outbox DTO',async()=>{
 const p=new Port(),view=plan({status:'published',intervals:[{startsAt:'2026-11-08T07:00:00Z',endsAt:'2026-11-08T08:00:00Z',startLocal:'09:00',endLocal:'10:00',kind:'planned_outage'}]}),store=p.store({context:()=>({addresses:[option],plans:[view]})});let s=await store.snapshot(identity);
 s=(await store.commitProfileMutation(identity,app(s,'strict-add',{kind:'add',optionId:option.id,bindingRevisionId:option.binding.revisionId,label:'Verified fixture',confirmed:true}))).snapshot;
 await store.commitProfileMutation(identity,app(s,'strict-primary',{kind:'primary',addressId:option.address.id}));await store.commitBotInput(identity,{input:{id:'strict-schedule',kind:'command',text:'/start'}});
 const row=p.data.outbox.find(o=>o.kind==='schedule')!,original=structuredClone(row.payload);assert(original.message.buttons.length>0);
 for(const corrupt of [(v:any)=>{v.message.privateToken='MUST_NOT_RETURN';},(v:any)=>{v.message.buttons[0].privateToken='MUST_NOT_RETURN';},(v:any)=>{v.message.text={privateToken:'MUST_NOT_RETURN'};},(v:any)=>{v.message.commitBarrier='unknown';},(v:any)=>{v.schedule.privateToken='MUST_NOT_RETURN';},(v:any)=>{v.schedule.source.privateToken='MUST_NOT_RETURN';},(v:any)=>{v.schedule.intervals[0].privateToken='MUST_NOT_RETURN';}]){
  row.payload=structuredClone(original);corrupt(row.payload);await assert.rejects(store.pendingOutbox(identity),e=>e instanceof Error&&e.message==='PRODUCTION_OUTBOX_INVALID');
 }
 row.payload=original;assert((await store.pendingOutbox(identity)).some(o=>o.id===row.id));
});
test('trusted existing account registry verifies an exact empty owner once, with durable private proof and bootstrap ledger',async()=>{
 for(const accountState of ['new','existing_empty'] as const){
  const p=new Port();emptyLegacy(p);let calls=0;
  const store=p.store({verifyEmptyAccount:async input=>{calls++;const found=await input.client.query('select id,created_at as "createdAt",updated_at as "updatedAt" from users where id=$1',[input.principal.ownerId]);if(found.rows.length!==1||found.rows[0].id!==input.principal.ownerId)return null;return {...emptyProof(input,accountState),accountRevisionId:createHash('sha256').update(JSON.stringify(found.rows[0])).digest('hex')};}});
  const first=await store.snapshot(identity);assert.equal(first.profile.locations.length,0);assert.equal(first.profile.id,owner);assert.equal(first.profile.preferences.optedIn,false);assert.equal(calls,1);
  const stored=p.data.origins[owner].private.emptyAccountProof;assert.equal(stored.accountState,accountState);assert.equal(stored.ownerId,owner);assert.equal(stored.legacySourceDigest,p.data.origins[owner].sourceDigest);assert.equal(p.data.bootstrap[owner].kind,'verified_empty');assert.equal(p.data.bootstrap[owner].sessionId,first.sessionId);assert(!JSON.stringify(first).includes('fixture-registry-proof'));
  const second=await store.snapshot(identity);assert.equal(second.sessionId,first.sessionId);assert.equal(calls,1);
 }
});
test('empty account default/null/unknown owner/proof-forgery are denied without canonical data; request cannot supply trusted proof',async()=>{
 const unknown=new Port();emptyLegacy(unknown);delete unknown.registry[owner];let queried=0;
 const missing=unknown.store({verifyEmptyAccount:async input=>{queried++;const found=await input.client.query('select id,created_at as "createdAt",updated_at as "updatedAt" from users where id=$1',[input.principal.ownerId]);return found.rows.length?emptyProof(input):null;}});
 await assert.rejects(missing.snapshot(identity),/EMPTY_UNCONFIRMED/);assert.equal(queried,1);assert.deepEqual(unknown.data.profiles,{});assert.deepEqual(unknown.data.bootstrap,{});
 for(const change of [()=>null,(proof:any)=>({...proof,ownerId:'foreign-owner'}),(proof:any)=>({...proof,legacySourceDigest:'0'.repeat(64)}),(proof:any)=>({...proof,accountRevisionId:''}),(proof:any)=>({...proof,evidenceRef:''}),(proof:any)=>({...proof,verifiedAt:'2026-11-08T18:00:01Z'}),(proof:any)=>({...proof,verifiedAt:'2026-11-08T17:54:59Z'}),(proof:any)=>({...proof,privateToken:'MUST_NOT_PERSIST'})]){
  const p=new Port();emptyLegacy(p);await assert.rejects(p.store({verifyEmptyAccount:input=>change(emptyProof(input)) as any}).snapshot(identity),/EMPTY_UNCONFIRMED|EMPTY_ACCOUNT_PROOF_INVALID/);assert.deepEqual(p.data.profiles,{});assert.deepEqual(p.data.origins,{});assert.deepEqual(p.data.bootstrap,{});
 }
 const p=new Port();emptyLegacy(p);const store=p.store();await assert.rejects(store.commitBotInput(identity,{input:{id:'forged-empty-proof',kind:'command',text:'/start'},emptyAccountProof:{ownerId:owner}}),/INVALID_INPUT/);assert.equal(p.connects,0);
});
test('trusted empty port is never a fallback for incomplete, malformed, conflicting or nonempty legacy, or an existing canonical empty state',async()=>{
 for(const alter of [(p:Port)=>{p.legacy.settings[0].telegramChatId='unverified-chat';},(p:Port)=>{p.legacy.settings[0].street='Different legacy carrier';},(p:Port)=>{p.legacy.locations[0].telegramNotify='invalid';}]){
  const p=new Port();alter(p);let calls=0;await assert.rejects(p.store({verifyEmptyAccount:input=>{calls++;return emptyProof(input);}}).snapshot(identity),/BOOTSTRAP_BLOCKED|LEGACY_PROFILE_INVALID_FLAG/);assert.equal(calls,0);assert.deepEqual(p.data.bootstrap,{});
 }
 const p=new Port();let calls=0;const store=p.store({verifyEmptyAccount:input=>{calls++;return emptyProof(input);}});let s=await store.snapshot(identity);assert.equal(calls,0);
 for(const l of [...s.profile.locations])s=(await store.commitProfileMutation(identity,app(s,'delete-verified-empty-'+s.revision,{kind:'delete',addressId:l.address.id,confirmed:true}))).snapshot;
 emptyLegacy(p);assert.equal((await store.snapshot(identity)).profile.locations.length,0);assert.equal(calls,0);assert.equal(p.data.bootstrap[owner].kind,'legacy');
});
test('durable bootstrap ledger prevents rebootstrap after origin/profile loss and bootstrap failure rolls all new rows back',async()=>{
 const p=new Port();emptyLegacy(p);let calls=0;const store=p.store({verifyEmptyAccount:input=>{calls++;return emptyProof(input);}});const first=await store.snapshot(identity);
 delete p.data.origins[owner];await assert.rejects(store.snapshot(identity),/ORIGIN_MISSING/);delete p.data.profiles[owner];await assert.rejects(store.snapshot(identity),/REBOOTSTRAP_FORBIDDEN/);assert.equal(calls,1);assert.equal(p.data.bootstrap[owner].sessionId,first.sessionId);
 const q=new Port();emptyLegacy(q);q.fail=sql=>{if(sql.startsWith('insert into lba_production_bootstrap_ledger'))throw Error('PRIVATE_BOOTSTRAP_LEDGER_FAILURE');};
 await assert.rejects(q.store({verifyEmptyAccount:input=>emptyProof(input)}).snapshot(identity),/TRANSACTION_UNCONFIRMED/);assert.deepEqual(q.data.profiles,{});assert.deepEqual(q.data.origins,{});assert.deepEqual(q.data.bootstrap,{});
});
test('SELECT-only legacy helper owns no transaction boundary, while schema/import/construction have no runtime side effects',async()=>{
 const p=new Port(),client=await p.pool.connect();await client.query('begin isolation level repeatable read');const before=p.calls.length;
 const value=await selectLegacyLiveProfileInTransaction(client,identity,{now:()=>now});assert.equal(value.status,'ready');assert(p.calls.slice(before).every(c=>c.sql.startsWith('select ')));assert.equal(p.releases,0);await client.query('rollback');client.release();
 const q=new Port();q.store();assert.equal(q.connects,0);assert(!/\b(?:drop|truncate|delete|update|insert)\b/i.test(PRODUCTION_PROFILE_SCHEMA_SQL));assert(PRODUCTION_PROFILE_SCHEMA_SQL.includes("default 'disabled'"));
 const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',"await import('./server/production/profile-store.ts');console.log('STORE_IMPORT_PASS')"],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{PATH:process.env.PATH,TZ:'UTC'},encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert(child.stdout.includes('STORE_IMPORT_PASS'));
});
test('server-only guarded Bot entrypoint requires a function and literal true before bootstrap; request JSON cannot supply it',async()=>{
 const p=new Port(),store=p.store(),input={input:{id:'guarded-first',kind:'command',text:'/menu'}};
 await assert.rejects(store.commitGuardedBotInput(identity,input,undefined as any),/BOT_GUARD_REQUIRED/);assert.equal(p.connects,0);
 for(const result of [false,undefined,{allowed:true}])await assert.rejects(store.commitGuardedBotInput(identity,input,(()=>result) as any),/BOT_GUARD_REJECTED/);
 assert.deepEqual(p.data.profiles,{});assert.equal(p.legacyReads,0);
 await assert.rejects(store.commitBotInput(identity,{...input,guard:{allowed:true}}),/INVALID_INPUT/);
});
test('guard is rechecked after async context; expired authority rolls state, receipt and pending messages back together',async()=>{
 const p=new Port();let calls=0,expired=false,release!:()=>void,entered!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const store=p.store({context:async()=>{calls++;if(calls===2){entered();await gate;expired=true;}return {addresses:[option],plans:[]};}});
 const phases:string[]=[];const pending=store.commitGuardedBotInput(identity,{input:{id:'guard-async-expiry',kind:'command',text:'/addresses'}},({phase})=>{phases.push(phase);return !expired;});
 await reached;assert.deepEqual(p.data.profiles,{});release();await assert.rejects(pending,/BOT_GUARD_REJECTED/);assert.deepEqual(phases,['before_bootstrap','before_commit']);assert.deepEqual(p.data.profiles,{});assert.deepEqual(p.data.inbox,{});assert.deepEqual(p.data.outbox,[]);assert.equal(p.calls.at(-1)?.sql,'rollback');
});
test('a confirmed guarded Bot replay retains the old semantic receipt and skips new authority guard execution',async()=>{
 const p=new Port(),store=p.store(),input={input:{id:'guard-replay',kind:'command',text:'/addresses'}},phases:string[]=[];
 const first=await store.commitGuardedBotInput(identity,input,({phase})=>{phases.push(phase);return true;});assert.deepEqual(phases,['before_bootstrap','before_commit']);
 const again=await store.commitGuardedBotInput(identity,input,()=>{throw Error('must not authorize historical commit again');});assert.equal(again.replayed,true);assert.deepEqual(again.receipt,first.receipt);assert.equal(again.snapshot.revision,1);assert.equal(p.data.outbox.length,first.receipt.outboxIds.length);
});
