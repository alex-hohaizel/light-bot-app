import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectVerifiedLegacySubscriberMappings,readOwnedLegacyProfile} from '../../server/production/legacy-identity-links.ts';
import {createProductionProfileStore} from '../../server/production/profile-store.ts';
import type {VerifiedLegacyPrincipal} from '../../server/production/profile-reader.ts';
const owner='fixture-owner-a',other='fixture-owner-b',now='2026-11-08T18:00:00Z';
const principal:VerifiedLegacyPrincipal={kind:'verified_server_principal',ownerId:owner,verified:true};
const timing={quietHoursEnabled:false,quietHoursStart:0,quietHoursEnd:7,morningBriefingEnabled:false,morningBriefingHour:0,minOutageDuration:0};
const address={city:'Fixture locality',lookupMode:'queue',street:'Fixture street',houseNumber:'12A',queueId:'1.1'};
const subscriber=(chatId='10101',userId:string|null=null,enabled=true)=>({chatId,userId,...address,...timing,enabled,notifyBeforeOff:0,notifyBeforeOn:0});
class Port {
 users=[owner,other];links:any[]=[{id:'fixture-link-a',ownerId:owner,provider:'telegram',chatId:'10101'}];subscribers:any[]=[subscriber()];settings:any[]=[];locations:any[]=[];
 canonical:any={profiles:{},origins:{},ledger:{}};calls:Array<{sql:string;values:any[];client:number}>=[];connects=0;releases=0;
 fault:((kind:string,rows:any[])=>any[])|null=null;
 pool={connect:async()=>{const id=++this.connects;let tx:any;
  return {query:async(sql:string,values:any[]=[])=>{
   const q=sql.replace(/\s+/g,' ').trim();this.calls.push({sql:q,values:structuredClone(values),client:id});const result=(kind:string,rows:any[],rowCount=rows.length)=>({rows:structuredClone(this.fault?this.fault(kind,rows):rows),rowCount});
   if(q.startsWith('begin isolation level ')){tx=structuredClone(this.canonical);return result('begin',[]);}
   if(q==='commit'){this.canonical=tx;return result('commit',[]);}if(q==='rollback')return result('rollback',[]);
   const who=values[0];
   if(q==='select id from users where id=$1 limit 2')return result('user',this.users.filter(u=>u===who).map(id=>({id})));
   if(q.includes("from linked_accounts where user_id=$1 and provider='telegram'"))return result('links',this.links.filter(l=>l.ownerId===who&&l.provider==='telegram').map(({id,ownerId,chatId})=>({id,ownerId,chatId})).slice(0,101));
   if(q==='select chat_id as "chatId",user_id as "ownerId" from telegram_subscribers where user_id=$1 order by chat_id limit 10001')return result('direct',this.subscribers.filter(s=>s.userId===who).map(s=>({chatId:s.chatId,ownerId:s.userId})).slice(0,10001));
   if(q.includes('from linked_accounts a left join users u')){const rows=[];for(const chatId of values[1]){const selected=this.links.filter(l=>l.provider==='telegram'&&l.chatId===chatId);if(selected.length)rows.push({chatId,total:String(selected.length),owned:String(selected.filter(l=>l.ownerId===who).length),foreign:String(selected.filter(l=>l.ownerId!==who).length),dangling:String(selected.filter(l=>!this.users.includes(l.ownerId)).length)});}return result('global',rows);}
   if(q==='select chat_id as "chatId",user_id as "ownerId" from telegram_subscribers where chat_id=any($1::varchar[]) order by chat_id')return result('candidates',this.subscribers.filter(s=>values[0].includes(s.chatId)).map(s=>({chatId:s.chatId,ownerId:s.userId})));
   if(q.includes('(select count(*) from user_settings'))return result('reader-counts',[{settings:String(this.settings.filter(r=>r.userId===who).length),locations:String(this.locations.filter(r=>r.userId===who).length),subscribers:String(this.subscribers.filter(r=>r.userId===who).length)}]);
   if(q.includes('from user_settings where user_id=$1'))return result('reader-settings',this.settings.filter(r=>r.userId===who));
   if(q.includes('from user_locations where user_id=$1'))return result('reader-locations',this.locations.filter(r=>r.userId===who));
   if(q.includes('filter(where user_id is null)')){const rows=this.subscribers.filter(s=>values[1].includes(s.chatId));return result('reader-mapping-counts',[{total:String(rows.length),unowned:String(rows.filter(r=>r.userId===null).length),owned:String(rows.filter(r=>r.userId===who).length),foreign:String(rows.filter(r=>r.userId!==null&&r.userId!==who).length)}]);}
   if(q.includes('from telegram_subscribers where user_id=$1'))return result('reader-subscribers',this.subscribers.filter(s=>s.userId===who||s.userId===null&&values[1].includes(s.chatId)));
   if(q.startsWith('select control_epoch'))return result('control',[{controlEpoch:'3',writerMode:'canonical'}]);if(q.startsWith('select pg_advisory'))return result('lock',[]);
   if(q.startsWith('select owner_id as'))return result('profile',tx.profiles[who]?[tx.profiles[who]]:[]);
   if(q.startsWith('select source_digest'))return result('origin',tx.origins[who]?[{source_digest:tx.origins[who].sourceDigest}]:[]);
   if(q.startsWith('select session_id as'))return result('ledger',tx.ledger[who]?[{sessionId:tx.ledger[who].sessionId}]:[]);
   if(q.startsWith('insert into lba_production_profiles(')){tx.profiles[who]={ownerId:who,sessionId:values[1],revision:values[2],state:JSON.parse(values[4])};return result('insert-profile',[],1);}
   if(q.startsWith('insert into lba_production_profile_origins(')){tx.origins[who]={sourceDigest:values[1],private:JSON.parse(values[3])};return result('insert-origin',[],1);}
   if(q.startsWith('insert into lba_production_bootstrap_ledger(')){tx.ledger[who]={sessionId:values[1]};return result('insert-ledger',[],1);}
   throw Error('PRIVATE_QUERY_FAILURE');
  },release:()=>{this.releases++;}};
 }};
 async helper(p=principal){const client=await this.pool.connect();try{return await selectVerifiedLegacySubscriberMappings(client,p);}finally{client.release();}}
}

test('explicit unique owned Telegram links map NULL subscribers with stable private revision, never mutate ownership or infer by names',async()=>{
 const p=new Port(),before=structuredClone(p.subscribers),proof=await p.helper();assert.equal(proof.length,1);assert.deepEqual(Object.keys(proof[0]).sort(),['chatId','kind','ownerId','revisionId']);assert.equal(proof[0].chatId,'10101');assert.equal(proof[0].ownerId,owner);assert.match(proof[0].revisionId,/^linked:[a-f0-9]{64}$/);assert.deepEqual(p.subscribers,before);
 const again=await p.helper();assert.deepEqual(again,proof);p.subscribers[0].enabled=false;p.subscribers[0].notifyBeforeOff=15;assert.deepEqual(await p.helper(),proof);p.links[0].id='new-explicit-link-row';assert.notEqual((await p.helper())[0].revisionId,proof[0].revisionId);
 assert(p.calls.every(c=>c.sql.startsWith('select ')));assert(p.calls.every(c=>!c.sql.includes('username')&&!c.sql.includes('email')&&!c.sql.includes('tg_')));
});
test('read wrapper uses one RR READ ONLY client for mapping and complete reader, preserving enabled/disabled/zero/global policies',async()=>{
 const p=new Port();p.links.push({id:'fixture-link-b',ownerId:owner,provider:'telegram',chatId:'20202'});p.subscribers.push(subscriber('20202',null,false));const before=structuredClone(p.subscribers);
 const read=await readOwnedLegacyProfile(p.pool,principal,{now:()=>now});assert.equal(p.connects,1);assert.equal(p.releases,1);assert.equal(p.calls[0].sql,'begin isolation level repeatable read read only');assert.equal(p.calls.at(-1)?.sql,'commit');assert(p.calls.every(c=>c.client===1));
 assert.equal(read.counts.selectedSubscribers,2);assert.equal(read.counts.verifiedMappedNullSubscribers,2);assert.equal(read.counts.directlyOwnedSubscribers,0);assert.equal(read.counts.verifiedMappings,2);assert.equal(read.projection.profile.preferences.optedIn,false);
 const rows=read.projection.provenance.filter(r=>r.table==='telegram_subscribers');assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.raw.enabled),[true,false]);assert(rows.every(r=>r.raw.notifyBeforeOff===0&&r.raw.quietHoursStart===0&&r.raw.minOutageDuration===0));assert(read.projection.issues.some(i=>i.code==='legacy_consent_disagrees'));assert.deepEqual(p.subscribers,before);assert(!('mappings'in read));
});
test('same-owner non-NULL subscriptions retain link proof and directly owned subscriptions remain preserved without links',async()=>{
 const p=new Port();p.subscribers[0].userId=owner;p.subscribers.push(subscriber('30303',owner,false));
 const read=await readOwnedLegacyProfile(p.pool,principal,{now:()=>now});assert.equal(read.counts.directlyOwnedSubscribers,2);assert.equal(read.counts.verifiedMappedNullSubscribers,0);assert.equal(read.counts.verifiedMappings,1);assert.equal(read.counts.selectedSubscribers,2);assert(p.subscribers.every(s=>s.userId===owner));
});
test('unknown owner and unverified/foreign-shaped principal fail before identity reads; tg-prefix with no explicit link grants no mapping',async()=>{
 const p=new Port();for(const value of [{...principal,verified:false},{...principal,ownerId:''},{...principal,ownerId:'bad\nowner'},{...principal,extra:true}])await assert.rejects(readOwnedLegacyProfile(p.pool,value as any),/VERIFIED_PRINCIPAL/);assert.equal(p.connects,0);
 p.users=p.users.filter(u=>u!==owner);await assert.rejects(readOwnedLegacyProfile(p.pool,principal),/OWNER_NOT_FOUND/);assert.equal(p.calls.at(-1)?.sql,'rollback');
 const q=new Port();q.links=[];q.users.push('tg_10101');const proof=await q.helper({...principal,ownerId:'tg_10101'});assert.deepEqual(proof,[]);assert(!q.calls.some(c=>c.sql.includes('where chat_id=any')));
});
test('duplicate/foreign/dangling linked identity and foreign subscriber ownership fail closed without reading policy DTOs',async()=>{
 for(const alter of [(p:Port)=>p.links.push({...p.links[0],id:'duplicate-own'}),(p:Port)=>p.links.push({...p.links[0],id:'foreign-link',ownerId:other}),(p:Port)=>p.links.push({...p.links[0],id:'dangling-link',ownerId:'missing-owner'}),(p:Port)=>{p.subscribers[0].userId=other;}]){
  const p=new Port();alter(p);await assert.rejects(readOwnedLegacyProfile(p.pool,principal),/LINK_CONFLICT|SUBSCRIBER_CONFLICT/);assert.equal(p.calls.at(-1)?.sql,'rollback');assert(!p.calls.some(c=>c.sql.includes('(select count(*) from user_settings')));
 }
});
test('a directly owned subscriber cannot be read under one owner when its explicit identity link belongs to another',async()=>{
 const p=new Port();p.links[0].ownerId=other;p.subscribers[0].userId=owner;await assert.rejects(p.helper(),/LINK_CONFLICT/);
});
test('distinct globally unique owned links are all retained; unrelated provider/foreign link refs cannot expand scope',async()=>{
 const p=new Port();p.links.push({id:'fixture-link-b',ownerId:owner,provider:'telegram',chatId:'20202'},{id:'foreign-subscriber-link',ownerId:other,provider:'telegram',chatId:'30303'},{id:'other-provider',ownerId:other,provider:'google',chatId:'10101'});p.subscribers.push(subscriber('20202'),subscriber('30303',null,false));
 const mapped=await p.helper();assert.deepEqual(mapped.map(m=>m.chatId),['10101','20202']);const global=p.calls.find(c=>c.sql.includes('from linked_accounts a left join'))!;assert.deepEqual(global.values,[owner,['10101','20202']]);
 const read=await readOwnedLegacyProfile(p.pool,principal,{now:()=>now});assert.equal(read.counts.selectedSubscribers,2);assert(!read.projection.provenance.some(r=>r.pk==='30303'));
});
test('an account link without a bot subscription never invents a subscriber or causes a false missing-mapping claim',async()=>{
 const p=new Port();p.subscribers=[];const read=await readOwnedLegacyProfile(p.pool,principal,{now:()=>now});assert.equal(read.counts.verifiedMappings,0);assert.equal(read.counts.selectedSubscribers,0);assert.equal(read.counts.missingVerifiedMappings,0);
});
test('invalid/unknown SQL fields, duplicate candidates and resource limits fail closed; SQL private errors remain redacted',async()=>{
 for(const [kind,change] of [['links',(rows:any[])=>rows.map(r=>({...r,privateToken:'MUST_NOT_EXPOSE'}))],['candidates',(rows:any[])=>[...rows,...rows]],['global',(rows:any[])=>rows.map(r=>({...r,total:'2'}))]] as const){const p=new Port();p.fault=(k,rows)=>k===kind?change(rows):rows;await assert.rejects(readOwnedLegacyProfile(p.pool,principal),e=>e instanceof Error&&!e.message.includes('MUST_NOT_EXPOSE')&&/^LEGACY_IDENTITY_/.test(e.message));}
 const many=new Port();many.links=Array.from({length:101},(_,i)=>({id:'link-'+i,ownerId:owner,provider:'telegram',chatId:String(10000+i)}));await assert.rejects(many.helper(),/ROW_LIMIT/);
 const p=new Port();p.fault=k=>{throw Error('PRIVATE_CONNECTION_DETAIL');};await assert.rejects(readOwnedLegacyProfile(p.pool,principal),e=>e instanceof Error&&e.message==='LEGACY_IDENTITY_READ_UNCONFIRMED');
 const q=new Port();await assert.rejects(readOwnedLegacyProfile(q.pool,principal,{verifiedSubscriberMappings:[]} as any),/INVALID_OPTIONS/);assert.equal(q.connects,0);
});
test('canonical bootstrap invokes trusted mapping on its own transaction and stores proofs only in private origins',async()=>{
 const p=new Port(),original=structuredClone(p.subscribers);let usedClient=0;
 const store=createProductionProfileStore({pool:p.pool,enabled:true,expectedControlEpoch:3,now:()=>now,context:()=>({addresses:[],plans:[]}),verifiedSubscriberMappings:async(identity,client)=>{usedClient=p.connects;return selectVerifiedLegacySubscriberMappings(client,identity);}});
 const snapshot=await store.snapshot(principal);assert.equal(snapshot.profile.locations.length,1);assert.equal(usedClient,1);assert(p.calls.every(c=>c.client===1));assert.equal(p.canonical.origins[owner].private.verifiedSubscriberMappings.length,1);assert.equal(p.canonical.origins[owner].private.verifiedSubscriberMappings[0].chatId,'10101');assert(!JSON.stringify(snapshot).includes('linked:'));assert.deepEqual(p.subscribers,original);
 const maps=p.canonical.origins[owner].private.verifiedSubscriberMappings;await store.snapshot(principal);assert.deepEqual(p.canonical.origins[owner].private.verifiedSubscriberMappings,maps);
});
test('mapping callback cannot mutate the store principal or later change the proof retained with sourceDigest',async()=>{
 const p=new Port();let returned:any[]=[],originalRevision='';
 p.fault=(kind,rows)=>{if(kind==='reader-counts'&&returned.length){returned[0].ownerId=other;returned[0].revisionId='tampered-after-return';}return rows;};
 const store=createProductionProfileStore({pool:p.pool,enabled:true,expectedControlEpoch:3,now:()=>now,context:()=>({addresses:[],plans:[]}),verifiedSubscriberMappings:async(identity,client)=>{returned=await selectVerifiedLegacySubscriberMappings(client,identity);originalRevision=returned[0].revisionId;identity.ownerId=other;return returned;}});
 const value=await store.snapshot(principal);assert.equal(value.profile.id,owner);assert.equal(principal.ownerId,owner);assert.equal(p.canonical.origins[owner].private.verifiedSubscriberMappings[0].ownerId,owner);assert.equal(p.canonical.origins[owner].private.verifiedSubscriberMappings[0].revisionId,originalRevision);assert(!p.canonical.profiles[other]);
});
test('module import is inert without database/environment and never exports a mutation path',()=>{
 const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',"const m=await import('./server/production/legacy-identity-links.ts');console.log(Object.keys(m).sort().join(','))"],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{PATH:process.env.PATH,TZ:'UTC'},encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'LegacyIdentityLinkError,readOwnedLegacyProfile,selectVerifiedLegacySubscriberMappings');
});
