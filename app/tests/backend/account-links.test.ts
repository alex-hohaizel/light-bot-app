import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createAccountLinks,ACCOUNT_LINKS_SCHEMA_SQL,readOwnerAuthEpoch,checkOwnerAuthEpoch,isDetachedAccountIdentity,accountLinkRevision} from '../../server/production/account-links.ts';
const token='123456:synthetic-not-a-real-token',now=Date.parse('2026-11-09T16:00:00Z');
const principal={kind:'verified_server_principal' as const,verified:true as const,ownerId:'qa-owner',webSessionId:'qa-private-session',authEpoch:0};
const req={id:'qa-create',expectedSessionId:'qa-canonical',expectedRevision:0};
function fixture(enabled=true){let calls=0;const service=createAccountLinks({enabled,expectedControlEpoch:7,botId:'123456',botToken:token,bindingKey:'synthetic-binding-key-'.repeat(3),now:()=>now,
 pool:{connect:async()=>{calls++;throw Error('PRIVATE_SQL_DIAGNOSTIC');}},store:{withLockedProfile:async()=>{calls++;throw Error('PRIVATE_STORE_DIAGNOSTIC');}} as any});return {service,calls:()=>calls};}
function signed(extra:Record<string,string>={}){const p=new URLSearchParams({auth_date:String(now/1000),user:JSON.stringify({id:800000001,first_name:'QA'}),...extra});
 const check=[...p.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
 p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update(check).digest('hex'));return p.toString();}
test('empty, short, malformed and foreign-bot token configuration is rejected before any IO',()=>{
 let calls=0;const options={enabled:true,expectedControlEpoch:7,botId:'123456',botToken:token,bindingKey:'synthetic-binding-key-'.repeat(3),now:()=>now,pool:{connect:async()=>{calls++;throw Error('NO_IO');}},store:{withLockedProfile:async()=>{calls++;throw Error('NO_IO');}} as any};
 for(const botToken of ['', '123456:', '123456:short', '123457:'+'a'.repeat(32), '123456:'+'a'.repeat(101), '123456:'+'!'.repeat(32), '123456:'+'a'.repeat(32)+'\n'])assert.throws(()=>createAccountLinks({...options,botToken}),/ACCOUNT_CONFIGURATION/);
 assert.equal(calls,0);
});
test('disabled operations and invalid principals never reach SQL or the canonical store',async()=>{
 const f=fixture(false);await assert.rejects(f.service.createChallenge(principal,req),/ACCOUNT_DISABLED/);await assert.rejects(f.service.receiveMiniProof(signed()),/ACCOUNT_DISABLED/);assert.equal(f.calls(),0);
 for(const p of [{...principal,ownerId:''},{...principal,authEpoch:-1},{...principal,webSessionId:''},{...principal,ownerId:{privateToken:'NO'}},{...principal,extra:true}])await assert.rejects(f.service.createChallenge(p as any,req));assert.equal(f.calls(),0);
});
test('malformed, duplicate-key, wrong-purpose and tampered signed Telegram proof fail before any database lookup',async()=>{
 const f=fixture(),valid=signed({start_param:'acctlink_'+'a'.repeat(64)});
 for(const p of [null,'',valid+'&start_param=other',valid.replace('acctlink_','changed_'),signed(),signed({start_param:'normal_start'}),signed({start_param:'acctlink_'+'a'.repeat(63)}),signed({start_param:'acctlink_'+'a'.repeat(64),auth_date:String(now/1000-301)})])await assert.rejects(f.service.receiveMiniProof(p),/ACCOUNT_PROOF_INVALID/);
 assert.equal(f.calls(),0);
});
test('database/commit exceptions are converted to stable errors without exposing diagnostics',async()=>{
 const f=fixture();await assert.rejects(f.service.createChallenge(principal,req),/ACCOUNT_UNCONFIRMED/);
 await assert.rejects(f.service.receiveMiniProof(signed({start_param:'acctlink_'+'a'.repeat(64)})),/ACCOUNT_UNCONFIRMED/);
});
test('closed request fields, explicit confirmation and safe revisions are required before the canonical transaction',async()=>{
 const f=fixture();for(const r of [{...req,ownerId:'foreign'},{...req,expectedRevision:NaN},{...req,id:'bad\n'},{}])await assert.rejects(f.service.createChallenge(principal,r),/ACCOUNT_INVALID_REQUEST/);
 await assert.rejects(f.service.confirmLink(principal,{...req,challengeId:'00000000-0000-0000-0000-000000000000',confirmed:false}),/ACCOUNT_INVALID_REQUEST/);
 await assert.rejects(f.service.unlink(principal,{...req,linkId:'x',linkRevision:'a'.repeat(64),confirmed:false}),/ACCOUNT_INVALID_REQUEST/);assert.equal(f.calls(),0);
});
test('epoch boundary treats only missing rows as zero; malformed/floating/overflow epochs never authenticate',async()=>{
 const query=(rows:any[])=>({query:async()=>({rows,rowCount:rows.length})});
 assert.equal(await readOwnerAuthEpoch(query([]),'qa-owner'),0);assert.equal(await checkOwnerAuthEpoch(query([{auth_epoch:'2'}]),'qa-owner',2),true);
 for(const value of ['x',0,'0',-1,1.5,'9007199254740992',{},null])await assert.rejects(readOwnerAuthEpoch(query([{auth_epoch:value}]),'qa-owner'),/ACCOUNT_UNCONFIRMED/);
 let calls=0;assert.equal(await checkOwnerAuthEpoch({query:async()=>{calls++;throw Error('NO');}},'qa-owner',NaN),false);assert.equal(calls,0);
 assert.equal(await isDetachedAccountIdentity(query([{one:1}]),'telegram','800000001'),true);
});
test('link revision covers exact ownership/provider/subject/time and refuses nested/private scalar values',()=>{
 const link={id:'legacy-non-uuid',ownerId:'qa-owner',provider:'telegram',providerId:'800000001',createdAt:'2026-11-09T15:00:00Z'};
 const base=accountLinkRevision(link);for(const edit of [{ownerId:'foreign'},{providerId:'800000002'},{createdAt:'2026-11-09T15:00:01Z'}])assert.notEqual(accountLinkRevision({...link,...edit}),base);
 for(const edit of [{id:{privateToken:'NO'}},{providerId:false},{createdAt:'bad'}])assert.throws(()=>accountLinkRevision({...link,...edit}));
 assert(!/\b(?:alter|drop)\b/i.test(ACCOUNT_LINKS_SCHEMA_SQL));assert(ACCOUNT_LINKS_SCHEMA_SQL.includes('lba_account_detached_identity'));
});
test('recovery reads only its control/owner/receipt ledger and never invokes canonical state, context, bootstrap or a mutation',async()=>{
 const queries:string[]=[];let releases=0;
 const service=createAccountLinks({enabled:true,expectedControlEpoch:7,botId:'123456',botToken:token,bindingKey:'synthetic-binding-key-'.repeat(3),now:()=>now,
  pool:{connect:async()=>({query:async(sql:string)=>{queries.push(sql);return {rows:sql.includes('lba_production_control')?[{control_epoch:'7',writer_mode:'canonical'}]:[],rowCount:0};},release:()=>{releases++;}})},
  store:{withLockedProfile:async()=>{throw Error('MUST_NOT_LOAD_OR_BOOTSTRAP_PROFILE');}} as any});
 assert.deepEqual(await service.recoverOperation(principal,{kind:'challenge',request:req}),{kind:'recovery',state:'not_recorded'});
 assert.equal(queries[0],'begin isolation level read committed');assert.match(queries[1],/lba_production_control.*for share$/);assert.match(queries[2],/pg_advisory_xact_lock/);assert.match(queries[3],/lba_account_operation/);assert.equal(queries[4],'commit');assert.equal(releases,1);
 assert(queries.every(sql=>/^select\b/.test(sql)||['begin isolation level read committed','commit'].includes(sql)));
});
