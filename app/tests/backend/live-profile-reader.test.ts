import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readLegacyLiveProfile,type LegacyProfileReadPool,type VerifiedLegacyPrincipal,type VerifiedSubscriberMapping} from '../../server/production/profile-reader.ts';

const owner='fixture-owner-a', identity:VerifiedLegacyPrincipal={kind:'verified_server_principal',ownerId:owner,verified:true};
const now=()=> '2026-11-08T18:00:00Z';
const timing={quietHoursEnabled:false,quietHoursStart:0,quietHoursEnd:7,morningBriefingEnabled:false,morningBriefingHour:0,minOutageDuration:0};
const address={city:'Fixture locality',lookupMode:'queue',street:'Fixture street',houseNumber:'12A',queueId:'1.1'};
const settings=()=>({userId:owner,...address,...timing,notificationsEnabled:false,notifyBeforeOff:0,notifyBeforeOn:15,telegramNotifications:true,telegramNotifyBeforeOff:0,telegramNotifyBeforeOn:30,themeMode:'light',hasSeenOnboarding:true,telegramChatId:'fixture-chat-a'});
const location=(id=1,orderIndex=0)=>({id,userId:owner,name:'Fixture place '+id,...address,isPrimary:id===1,orderIndex,notifyEnabled:false,telegramNotify:true,notifyBeforeOff:0,notifyBeforeOn:0});
const subscriber=(chatId='fixture-chat-a',userId:string|null=owner)=>({chatId,userId,...address,...timing,enabled:true,notifyBeforeOff:0,notifyBeforeOn:30});
class Port {
  settings:any[]=[settings()]; locations:any[]=[location()]; subscribers:any[]=[subscriber()];
  calls:Array<{sql:string;values:any[]}>=[]; connects=0; releases=0;
  fault:((kind:string,rows:any[])=>any[])|null=null;
  pool:LegacyProfileReadPool={connect:async()=>{
    this.connects++;return {query:async(sql,values=[])=>{
      const q=sql.replace(/\s+/g,' ').trim();this.calls.push({sql:q,values:structuredClone(values)});
      const result=(kind:string,values:any[])=>{const rows=structuredClone(this.fault?this.fault(kind,values):values);return {rows,rowCount:rows.length};};
      if(['begin isolation level repeatable read read only','commit','rollback'].includes(q))return {rows:[],rowCount:null};
      assert(q.startsWith('select '),'no write, DDL, export or implicit import operation allowed');
      const ownerId=values[0];
      if(q.includes('(select count(*) from user_settings'))return result('counts',[{settings:String(this.settings.filter(r=>r.userId===ownerId).length),locations:String(this.locations.filter(r=>r.userId===ownerId).length),subscribers:String(this.subscribers.filter(r=>r.userId===ownerId).length)}]);
      if(q.includes('filter(where user_id is null)')){
        const rows=this.subscribers.filter(r=>values[1].includes(r.chatId));return result('mapping-counts',[{total:String(rows.length),unowned:String(rows.filter(r=>r.userId===null).length),owned:String(rows.filter(r=>r.userId===ownerId).length),foreign:String(rows.filter(r=>r.userId!==null&&r.userId!==ownerId).length)}]);
      }
      if(q.includes('from user_settings where user_id=$1'))return result('settings',this.settings.filter(r=>r.userId===ownerId).slice(0,2));
      if(q.includes('from user_locations where user_id=$1'))return result('locations',this.locations.filter(r=>r.userId===ownerId).slice(0,values[1]));
      if(q.includes('from telegram_subscribers where user_id=$1'))return result('subscribers',this.subscribers.filter(r=>r.userId===ownerId||r.userId===null&&values[1].includes(r.chatId)).slice(0,values[2]));
      throw Error('unrecognized fixture query');
    },release:()=>{this.releases++;}};
  }};
}
const mapping=(chatId='fixture-chat-a'):VerifiedSubscriberMapping=>({kind:'verified_telegram_owner_mapping',ownerId:owner,chatId,revisionId:'mapping-revision-1'});

test('read-only repeatable snapshot reconciles exact owner rows with explicit column SQL and current server clock',async()=>{
 const p=new Port();p.locations.push({...location(9),userId:'foreign-owner'});p.subscribers.push(subscriber('foreign-chat','foreign-owner'));
 const value=await readLegacyLiveProfile(p.pool,identity,{now});
 assert.equal(p.calls[0].sql,'begin isolation level repeatable read read only');assert.equal(p.calls.at(-1)?.sql,'commit');assert.equal(p.releases,1);
 assert.equal(value.status,'ready');assert.equal(value.serverNow,now());assert.equal(value.counts.locations,1);assert.equal(value.counts.selectedSubscribers,1);
 assert.equal(value.projection.profile.id,owner);assert.equal(value.projection.deliveryEligible,false);assert.equal(value.projection.profile.locations[0].notificationPolicy?.channels.telegram.beforeOffMinutes,0);
 assert.match(value.sourceDigest,/^[a-f0-9]{64}$/);assert(!('plans'in value));assert(!('catalog'in value));
 assert(p.calls.filter(x=>x.sql.startsWith('select')).every(x=>x.values[0]===owner));
 assert(p.calls.every(x=>!x.sql.includes('select *')&&!/\b(username|email|password|session|token|last_notif_key|share_id)\b/.test(x.sql)));
 assert.equal(value.completeness.globalOrphans,'not_scanned_outside_owner_scope');
});
test('unverified or foreign-scope principal/mapping inputs do not open the pool or query',async()=>{
 for(const principal of [{...identity,verified:false},{...identity,kind:'caller_claim'},{...identity,ownerId:''},{...identity,ownerId:'bad\nowner'},{...identity,extra:'forged'}]){
  const p=new Port();await assert.rejects(readLegacyLiveProfile(p.pool,principal as any,{now}),/PRINCIPAL_REQUIRED/);assert.equal(p.connects,0);assert.equal(p.calls.length,0);
 }
 for(const options of [{now,ownerId:'foreign'},{now,verifiedSubscriberMappings:[{...mapping(),ownerId:'foreign'}]},{now,verifiedSubscriberMappings:[mapping(),mapping()]},{now,rowLimit:10001}]){
  const p=new Port();await assert.rejects(readLegacyLiveProfile(p.pool,identity,options as any));assert.equal(p.connects,0);
 }
});
test('unexpected fields and foreign returned rows fail closed, rollback and do not expose row values',async()=>{
 for(const kind of ['settings','locations','subscribers'])for(const change of [(r:any)=>({...r,userId:'foreign-owner'}),(r:any)=>({...r,password:'DO_NOT_EXPOSE'}),(r:any)=>({...r,unknownPolicy:'DO_NOT_EXPOSE'})]){
  const p=new Port();p.fault=(type,rows)=>type===kind?rows.map(change):rows;
  await assert.rejects(readLegacyLiveProfile(p.pool,identity,{now}),e=>e instanceof Error&&!e.message.includes('DO_NOT_EXPOSE')&&/LEGACY_READER_(FOREIGN_OWNER|UNEXPECTED_FIELD)/.test(e.message));
  assert.equal(p.calls.at(-1)?.sql,'rollback');assert.equal(p.releases,1);assert(!p.calls.some(q=>q.sql==='commit'));
 }
});
test('counts and resource bounds cannot silently truncate a profile',async()=>{
 const p=new Port();p.locations.push(location(2));await assert.rejects(readLegacyLiveProfile(p.pool,identity,{now,rowLimit:1}),/ROW_LIMIT/);assert.equal(p.calls.filter(q=>q.sql.includes('order by order_index')).length,0);
 const q=new Port();q.fault=(kind,rows)=>kind==='locations'?[]:rows;await assert.rejects(readLegacyLiveProfile(q.pool,identity,{now}),/COUNT_MISMATCH/);assert.equal(q.calls.at(-1)?.sql,'rollback');
 const big=new Port();big.fault=(kind,rows)=>kind==='counts'?[{settings:'1',locations:'10001',subscribers:'1'}]:rows;await assert.rejects(readLegacyLiveProfile(big.pool,identity,{now}),/ROW_LIMIT/);
});
test('source digest is stable across SQL ordering/time but changes for persisted profile or verified mapping revisions',async()=>{
 const p=new Port();p.locations.push(location(2,2));p.subscribers.push(subscriber('fixture-chat-b'));const first=await readLegacyLiveProfile(p.pool,identity,{now});
 p.locations.reverse();p.subscribers.reverse();const second=await readLegacyLiveProfile(p.pool,identity,{now:()=> '2026-11-08T19:00:00Z'});assert.equal(first.sourceDigest,second.sourceDigest);assert.equal(first.projectionDigest,second.projectionDigest);
 p.locations[0].notifyBeforeOn=15;const changed=await readLegacyLiveProfile(p.pool,identity,{now});assert.notEqual(changed.sourceDigest,first.sourceDigest);
 const m=new Port();m.subscribers[0].userId=null;const a=await readLegacyLiveProfile(m.pool,identity,{now,verifiedSubscriberMappings:[mapping()]});const b=await readLegacyLiveProfile(m.pool,identity,{now,verifiedSubscriberMappings:[{...mapping(),revisionId:'mapping-revision-2'}]});assert.notEqual(a.sourceDigest,b.sourceDigest);assert.equal(a.projectionDigest,b.projectionDigest);
});
test('an unverified settings chat reference does not grant lookup of an orphan/null subscriber',async()=>{
 const p=new Port();p.subscribers[0].userId=null;const result=await readLegacyLiveProfile(p.pool,identity,{now});
 assert.equal(result.status,'blocked');assert.equal(result.counts.unresolvedSettingsReferences,1);assert.equal(result.counts.selectedSubscribers,0);assert.equal(result.counts.directlyOwnedSubscribers,0);
 assert(result.blockers.some(b=>b.code==='LEGACY_READER_SETTINGS_TELEGRAM_MAPPING_UNVERIFIED'));
 assert(p.calls.every(q=>!q.values.some(value=>value==='fixture-chat-a'||Array.isArray(value)&&value.includes('fixture-chat-a'))));assert.equal(p.subscribers[0].userId,null);
});
test('only an explicit verified mapping can project a null-owner subscriber; original ownership remains unchanged',async()=>{
 const p=new Port();p.subscribers[0].userId=null;const result=await readLegacyLiveProfile(p.pool,identity,{now,verifiedSubscriberMappings:[mapping()]});
 assert.equal(result.status,'ready');assert.equal(result.counts.verifiedMappedNullSubscribers,1);assert.equal(result.counts.directlyOwnedSubscribers,0);assert.equal(result.counts.selectedSubscribers,1);assert.equal(p.subscribers[0].userId,null);
 assert.equal(result.projection.provenance.find(r=>r.table==='telegram_subscribers')?.ownerId,owner);assert(p.calls.some(q=>q.sql.includes('user_id is null and chat_id=any($2::varchar[])')));
});
test('a mapped foreign owner is classified by aggregate and blocks before reading that subscriber DTO',async()=>{
 const p=new Port();p.subscribers[0].userId='foreign-owner';await assert.rejects(readLegacyLiveProfile(p.pool,identity,{now,verifiedSubscriberMappings:[mapping()]}),/MAPPING_OWNER_CONFLICT/);
 assert.equal(p.calls.at(-1)?.sql,'rollback');assert(!p.calls.some(q=>q.sql.startsWith('select chat_id as')));
});
test('missing verified mappings are blocked explicitly rather than discarded as a complete subscriber set',async()=>{
 const p=new Port();p.settings[0].telegramChatId='';p.subscribers=[];const result=await readLegacyLiveProfile(p.pool,identity,{now,verifiedSubscriberMappings:[mapping()]});
 assert.equal(result.status,'blocked');assert.equal(result.counts.missingVerifiedMappings,1);assert(result.blockers.some(b=>b.code==='LEGACY_READER_VERIFIED_MAPPING_NOT_FOUND'));
});
test('query, connection and clock failures return safe codes and rollback/release without private error text',async()=>{
 const p=new Port();p.fault=(kind,rows)=>{if(kind==='locations')throw Error('PRIVATE_SQL_CONTEXT');return rows;};await assert.rejects(readLegacyLiveProfile(p.pool,identity,{now}),e=>e instanceof Error&&e.message==='LEGACY_READER_READ_UNCONFIRMED');assert.equal(p.calls.at(-1)?.sql,'rollback');assert.equal(p.releases,1);
 await assert.rejects(readLegacyLiveProfile({connect:async()=>{throw Error('PRIVATE_CONNECTION_STRING');}},identity,{now}),e=>e instanceof Error&&e.message==='LEGACY_READER_READ_UNCONFIRMED');
 const c=new Port();await assert.rejects(readLegacyLiveProfile(c.pool,identity,{now:()=> 'invalid'}),/INVALID_CLOCK/);assert.equal(c.calls.at(-1)?.sql,'rollback');assert.equal(c.releases,1);
});
test('reader import without environment or DB has no pool/schema/runtime effects',()=>{
 const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',"await import('./server/production/profile-reader.ts');console.log('READER_IMPORT_PASS')"],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{PATH:process.env.PATH,TZ:'UTC'},encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert(child.stdout.includes('READER_IMPORT_PASS'));
});


test('verified mapping aggregate must reconcile with the actual selected subscriber references',async()=>{
 const p=new Port();p.settings[0].telegramChatId='';p.subscribers[0].chatId='different-owned-chat';
 p.fault=(kind,rows)=>kind==='mapping-counts'?[{total:'1',owned:'1',unowned:'0',foreign:'0'}]:rows;
 await assert.rejects(readLegacyLiveProfile(p.pool,identity,{now,verifiedSubscriberMappings:[mapping()]}),/COUNT_MISMATCH/);assert.equal(p.calls.at(-1)?.sql,'rollback');
});
