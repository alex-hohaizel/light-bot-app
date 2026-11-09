import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import path from 'node:path';
import {withProofDatabase} from '../../../tools/local-runtime/disposable-proof-db.mjs';
import {createAccountLinks,ACCOUNT_LINKS_SCHEMA_SQL,readOwnerAuthEpoch,checkOwnerAuthEpoch,isDetachedAccountIdentity} from '../../server/production/account-links.ts';
import {createProductionProfileStore,PRODUCTION_PROFILE_SCHEMA_SQL} from '../../server/production/profile-store.ts';
const root=path.resolve(import.meta.dirname,'../../..'),out=path.join(root,'docs/light-bot-app/release-v8/phase4/account-links');await mkdir(path.join(out,'attempts'),{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex'),paths=['app/server/production/account-links.ts','app/tests/backend/account-links.test.ts','app/tests/backend/account-links-pg.mjs','app/server/production/profile-store.ts','app/server/production/profile-reader.ts','app/server/production/legacy-profile.ts','app/server/telegram-init-data.ts'];
const pins=()=>Promise.all(paths.map(async p=>({path:p,sha256:hash(await readFile(path.join(root,p)))})));
const before=await pins(),driverSha256=hash(await readFile(import.meta.filename)),tests=[],check=async(name,fn)=>{await fn();tests.push({name,status:'pass'});};
const owner='synthetic-store-a',who=ownerId=>({kind:'verified_server_principal',verified:true,ownerId}),token='123456:synthetic-not-real-provider-token',key='synthetic-account-binding-key-'.repeat(3);
const p={...who(owner),webSessionId:'private-original-web-session',authEpoch:0};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function signed(challenge,subject='800000001',extra={}){const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:Number(subject),first_name:'Synthetic QA'}),start_param:challenge.startParam,...extra});
 const data=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');params.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update(data).digest('hex'));return params.toString();}
let report;
try{await withProofDatabase('account_link_resume',55481,async(pool,target)=>{
 await pool.query(await readFile(path.join(root,'tools/local-runtime/profile-proof-fixture.sql'),'utf8'));
 await pool.query(`create table users(id varchar(255) primary key,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
 create table linked_accounts(id varchar(255) primary key,user_id varchar(255) not null references users(id),provider text not null,provider_id text not null,display_name text,created_at timestamptz not null default now(),unique(provider,provider_id));
 insert into users(id) values('synthetic-store-a'),('synthetic-store-b'),('tg_800000099');
 insert into linked_accounts(id,user_id,provider,provider_id) values('qa-replit-a','synthetic-store-a','replit','qa-replit-subject-a'),('qa-telegram-b','synthetic-store-b','telegram','800000002');`);
 await pool.query(PRODUCTION_PROFILE_SCHEMA_SQL);await pool.query("insert into lba_production_control values(true,7,'canonical')");await pool.query(ACCOUNT_LINKS_SCHEMA_SQL);
 const createStore=(port=pool)=>createProductionProfileStore({pool:port,enabled:true,expectedControlEpoch:7,context:()=>({addresses:[],plans:[]})});
 const store=createStore(),service=(s=store,patch={})=>createAccountLinks({enabled:true,expectedControlEpoch:7,pool,store:s,botId:'123456',botToken:token,bindingKey:key,now:()=>Date.now(),...patch});
 const accounts=service();let snapshot=await store.snapshot(who(owner));const profileBefore=hash(JSON.stringify((await pool.query('select state from lba_production_profiles where owner_id=$1',[owner])).rows));
 const legacy=async()=>hash(JSON.stringify(await Promise.all(['users','user_settings','user_locations','telegram_subscribers'].map(async t=>({table:t,rows:(await pool.query('select * from '+t+' order by 1')).rows}))))),legacyBefore=await legacy();
 const req=(id,extra={})=>({id,expectedSessionId:snapshot.sessionId,expectedRevision:snapshot.revision,...extra});
 let challenge,confirm,linked;
 await check('challenge is bound to original owner/session/CAS, retry is stable and durable receipts contain no raw nonce/session/initData',async()=>{
  challenge=await accounts.createChallenge(p,req('create-main'));assert.equal(challenge.miniAppUrl,null);assert.deepEqual(await accounts.createChallenge(p,req('create-main')),challenge);
  const stored=JSON.stringify((await pool.query('select * from lba_account_link_challenge union all select * from lba_account_link_challenge where false')).rows);
  const ledger=JSON.stringify((await pool.query('select result from lba_account_operation')).rows);
  assert(!stored.includes(p.webSessionId));assert(!stored.includes(challenge.startParam.slice(9)));assert(!ledger.includes(challenge.startParam));
  await assert.rejects(accounts.createChallenge(p,{...req('create-main'),expectedRevision:1}),/ACCOUNT_OPERATION_CONFLICT/);
 });
 await check('tampering, missing/foreign-purpose start param and expired signed proof fail without creating users or links',async()=>{
  for(const value of [signed(challenge).replace('acctlink_','wrong___'),signed(challenge,'800000001',{start_param:'other-purpose'}),signed(challenge,'800000001',{auth_date:String(Math.floor(Date.now()/1000)-301)})])await assert.rejects(accounts.receiveMiniProof(value),/ACCOUNT_PROOF_INVALID/);
  assert.equal((await pool.query('select count(*)::int n from users')).rows[0].n,3);
 });
 await check('valid challenge-bound Mini App proof is durable but cannot itself authenticate, create an account or insert a link',async()=>{
  assert.deepEqual(await accounts.receiveMiniProof(signed(challenge)),{kind:'proof',state:'ready_for_confirmation'});
  assert.equal((await pool.query("select count(*)::int n from linked_accounts where provider_id='800000001'")).rows[0].n,0);
  const status=await accounts.inspectChallenge(p,challenge.challengeId);assert.equal(status.state,'ready_for_confirmation');assert.equal(status.accountLabel,'Telegram ••••0001');
  assert(!JSON.stringify(status).includes('800000001'));
 });
 await check('another web session/owner, stale CAS and missing explicit confirmation cannot finish the link',async()=>{
  confirm=req('confirm-main',{challengeId:challenge.challengeId,confirmed:true});
  await assert.rejects(accounts.inspectChallenge({...p,webSessionId:'foreign-session'},challenge.challengeId),/ACCOUNT_CHALLENGE_CONFLICT/);
  await assert.rejects(accounts.confirmLink({...p,webSessionId:'foreign-session'},confirm),/ACCOUNT_CHALLENGE_CONFLICT/);
  await assert.rejects(accounts.confirmLink({...p,ownerId:'synthetic-store-b'},confirm),/ACCOUNT_PROFILE_CHANGED|ACCOUNT_CHALLENGE_CONFLICT/);
  await assert.rejects(accounts.confirmLink(p,{...confirm,expectedRevision:999}),/ACCOUNT_PROFILE_CHANGED/);
  await assert.rejects(accounts.confirmLink(p,{...confirm,confirmed:false}),/ACCOUNT_INVALID_REQUEST/);
 });
 await check('explicit confirmation inserts exactly one unbound identity and replays the exact receipt without profile/data migration',async()=>{
  linked=await accounts.confirmLink(p,confirm);assert.equal(linked.kind,'linked');assert.equal(linked.reauthenticate,false);assert.deepEqual(await accounts.confirmLink(p,confirm),linked);
  assert.equal((await pool.query("select count(*)::int n from linked_accounts where provider='telegram' and provider_id='800000001' and user_id=$1",[owner])).rows[0].n,1);
  assert.equal(hash(JSON.stringify((await pool.query('select state from lba_production_profiles where owner_id=$1',[owner])).rows)),profileBefore);
  assert.equal(await legacy(),legacyBefore);
 });
 await check('foreign explicit ownership and convention-only historical orphan never merge, move or recreate identities',async()=>{
  for(const subject of ['800000002','800000099']){const c=await accounts.createChallenge(p,req('foreign-'+subject));await assert.rejects(accounts.receiveMiniProof(signed(c,subject)),/ACCOUNT_RECONCILIATION_REQUIRED/);}
  assert.equal((await pool.query("select user_id from linked_accounts where provider='telegram' and provider_id='800000002'")).rows[0].user_id,'synthetic-store-b');assert.equal(await legacy(),legacyBefore);
 });
 await check('saved and unsaved commit ambiguity recover by the exact original input without creating a second logical operation',async()=>{
  for(const saved of [true,false]){
   let armed=true;const wrapped={connect:async()=>{const c=await pool.connect();return {query:async(sql,v)=>{if(armed&&sql==='commit'){armed=false;await c.query(saved?'commit':'rollback');throw Error('SYNTHETIC_ACK_LOST');}return c.query(sql,v);},release:()=>c.release()};}};
   const uncertain=service(createStore(wrapped)),r=req('unknown-'+saved);
   await assert.rejects(uncertain.createChallenge(p,r),/ACCOUNT_COMMIT_UNKNOWN/);
   const recovered=await accounts.recoverOperation(p,{kind:'challenge',request:r});assert.equal(recovered.state,saved?'recorded':'not_recorded');
   const current=await accounts.createChallenge(p,r);if(saved)assert.deepEqual(current,recovered.result);
   assert.equal((await pool.query('select count(*)::int n from lba_account_operation where owner_id=$1 and operation_id=$2',[owner,r.id])).rows[0].n,1);
  }
 });
 await check('receipt recovery waits for a late original COMMIT using a fresh statement snapshot and never needs profile/bootstrap/context',async()=>{
  const held=deferred(),release=deferred(),waiting=deferred();let armed=true;
  const delayedPool={connect:async()=>{const c=await pool.connect();return{query:async(sql,v)=>{if(armed&&sql==='commit'){armed=false;held.resolve();await release.promise;}return c.query(sql,v);},release:()=>c.release()};}};
  const queries=[],recoveryPool={connect:async()=>{const c=await pool.connect();return{query:async(sql,v)=>{queries.push(sql);if(sql.includes('pg_advisory_xact_lock'))waiting.resolve();return c.query(sql,v);},release:()=>c.release()};}};
  const pending=req('late-recovery'),write=service(createStore(delayedPool)).createChallenge(p,pending);await held.promise;
  const recovery=service({withLockedProfile:async()=>{throw Error('RECOVERY_MUST_NOT_BOOTSTRAP');}},{pool:recoveryPool}).recoverOperation(p,{kind:'challenge',request:pending});
  await waiting.promise;release.resolve();const committed=await write,recovered=await recovery;
  assert.equal(recovered.state,'recorded');assert.deepEqual(recovered.result,committed);
  assert.equal(queries[0],'begin isolation level read committed');assert(queries[1].endsWith('for share'));assert(queries[2].includes('pg_advisory_xact_lock'));
  assert(queries.every(sql=>/^select\b/i.test(sql)||['begin isolation level read committed','commit'].includes(sql)));
  await pool.query("update lba_account_link_challenge set state='cancelled' where id=$1",[committed.challengeId]);
 });
 let unlink;
 await check('unlink requires a current exact link revision plus a fresh verified alternative login in the same original session',async()=>{
  const list=await accounts.listAccounts(p),row=list.links.find(l=>l.id===linked.linkId);assert(row);unlink=req('unlink-main',{linkId:row.id,linkRevision:row.linkRevision,confirmed:true});
  await assert.rejects(accounts.unlink(p,unlink),/ACCOUNT_LAST_LOGIN_REQUIRED/);
  await assert.rejects(accounts.unlink(p,{...unlink,linkRevision:'0'.repeat(64)}),/ACCOUNT_LINK_CONFLICT/);
  await assert.rejects(accounts.recordVerifiedLogin(p,{receiptId:'wrong-subject',provider:'replit',providerId:'foreign',verifiedAt:new Date(Date.now()-100).toISOString(),validUntil:new Date(Date.now()+60000).toISOString()}),/ACCOUNT_LOGIN_PROOF_UNCONFIRMED/);
  await accounts.recordVerifiedLogin({...p,webSessionId:'other-session'},{receiptId:'other-session-auth',provider:'replit',providerId:'qa-replit-subject-a',verifiedAt:new Date(Date.now()-100).toISOString(),validUntil:new Date(Date.now()+60000).toISOString()});
  await assert.rejects(accounts.unlink(p,unlink),/ACCOUNT_LAST_LOGIN_REQUIRED/);
 });
 await check('server-verified alternative proof permits one unlink and atomically revokes all older credential epochs without modifying settings/subscriptions',async()=>{
  await accounts.recordVerifiedLogin(p,{receiptId:'actual-fixture-verified-replit-auth',provider:'replit',providerId:'qa-replit-subject-a',verifiedAt:new Date(Date.now()-100).toISOString(),validUntil:new Date(Date.now()+60000).toISOString()});
  const held=deferred(),release=deferred(),waiting=deferred();let armed=true;
  const delayedPool={connect:async()=>{const c=await pool.connect();return{query:async(sql,v)=>{if(armed&&sql==='commit'){armed=false;held.resolve();await release.promise;}return c.query(sql,v);},release:()=>c.release()};}};
  const observingPool={connect:async()=>{const c=await pool.connect();return{query:async(sql,v)=>{if(sql.includes('pg_advisory_xact_lock'))waiting.resolve();return c.query(sql,v);},release:()=>c.release()};}};
  const write=service(createStore(delayedPool)).unlink(p,unlink);await held.promise;
  const stale=service(createStore(observingPool)).createChallenge(p,req('old-epoch-waiting-for-unlink'));await waiting.promise;release.resolve();
  const r=await write;await assert.rejects(stale,/ACCOUNT_SESSION_REVOKED/);
  assert.equal((await pool.query('select count(*)::int n from lba_account_operation where operation_id=$1',['old-epoch-waiting-for-unlink'])).rows[0].n,0);
  assert.equal(r.kind,'unlinked');assert.equal(r.authEpoch,1);assert.equal(r.reauthenticate,true);
  assert.equal(await readOwnerAuthEpoch(pool,owner),1);assert.equal(await checkOwnerAuthEpoch(pool,owner,0),false);assert.equal(await checkOwnerAuthEpoch(pool,owner,1),true);
  assert.equal(await isDetachedAccountIdentity(pool,'telegram','800000001'),true);assert.equal(await isDetachedAccountIdentity(pool,'telegram','800000002'),false);
  assert.equal((await pool.query('select count(*)::int n from linked_accounts where id=$1',[linked.linkId])).rows[0].n,0);assert.equal(await legacy(),legacyBefore);
  await assert.rejects(accounts.createChallenge(p,req('revoked-session')),/ACCOUNT_SESSION_REVOKED/);
 });
 await check('revoked original credentials retain exact immutable readback; stale different sessions and conflicting inputs remain denied',async()=>{
  const r=await accounts.recoverOperation(p,{kind:'unlink',request:unlink});assert.equal(r.state,'recorded');assert.equal(r.result.authEpoch,1);
  await assert.rejects(accounts.recoverOperation({...p,webSessionId:'foreign'},{kind:'unlink',request:unlink}),/ACCOUNT_OPERATION_CONFLICT/);
  await assert.rejects(accounts.recoverOperation(p,{kind:'unlink',request:{...unlink,linkId:'other'}}),/ACCOUNT_OPERATION_CONFLICT/);
  const missing=await accounts.recoverOperation(p,{kind:'unlink',request:{...unlink,id:'never-recorded'}});assert.equal(missing.state,'not_recorded');
  const before=(await pool.query('select count(*)::int n from lba_account_operation')).rows[0].n;assert.equal((await accounts.recoverOperation(p,{kind:'unlink',request:unlink})).state,'recorded');assert.equal((await pool.query('select count(*)::int n from lba_account_operation')).rows[0].n,before);
 });
 await check('fresh current owner can read exact link/unlink outcomes after a new login without inheriting a challenge or invoking profile state',async()=>{
  const queries=[],observed={connect:async()=>{const c=await pool.connect();return{query:(sql,v)=>{queries.push(sql);return c.query(sql,v);},release:()=>c.release()};}};
  const readOnly=service({withLockedProfile:async()=>{throw Error('RECOVERY_MUST_NOT_BOOTSTRAP_OR_LOAD_CONTEXT');}},{pool:observed});
  const fresh={...p,authEpoch:1,webSessionId:'fresh-verified-current-owner-session'};
  const tables=['lba_account_operation','lba_account_link_challenge','lba_account_verified_login','lba_owner_auth_epoch','lba_account_detached_identity','linked_accounts','lba_production_profiles','lba_production_profile_origins','lba_production_bootstrap_ledger'];
  const contents=async()=>hash(JSON.stringify(await Promise.all(tables.map(async table=>({table,rows:(await pool.query('select * from '+table+' order by 1')).rows}))))),before=await contents();
  const original=await readOnly.recoverOperation(p,{kind:'unlink',request:unlink}),recovered=await readOnly.recoverOperation(fresh,{kind:'unlink',request:unlink});assert.deepEqual(recovered,original);assert.equal(recovered.result.kind,'unlinked');
  assert.deepEqual(await readOnly.recoverOperation(fresh,{kind:'link',request:confirm}),{kind:'recovery',state:'recorded',result:linked});
  await assert.rejects(readOnly.recoverOperation({...p,webSessionId:'unverified-stale-epoch-new-session'},{kind:'unlink',request:unlink}),/ACCOUNT_OPERATION_CONFLICT/);
  await assert.rejects(readOnly.recoverOperation(fresh,{kind:'unlink',request:{...unlink,linkId:'foreign-link'}}),/ACCOUNT_OPERATION_CONFLICT/);
  await assert.rejects(readOnly.recoverOperation(fresh,{kind:'challenge',request:req(unlink.id)}),/ACCOUNT_OPERATION_CONFLICT/);
  await assert.rejects(readOnly.recoverOperation(fresh,{kind:'challenge',request:req('create-main')}),/ACCOUNT_ORIGINAL_SESSION_REQUIRED/);
  assert.deepEqual(await readOnly.recoverOperation({...fresh,ownerId:'synthetic-store-b',authEpoch:0},{kind:'unlink',request:unlink}),{kind:'recovery',state:'not_recorded'}); // A miss is scoped only to this authenticated owner.
  assert.equal(await contents(),before);assert(queries.every(sql=>/^select\b/i.test(sql)||['begin isolation level read committed','commit','rollback'].includes(sql)));
 });
 await check('fresh-owner fallback refuses malformed or uncorrelated stored mutation DTOs without returning private fields',async()=>{
  const fresh={...p,authEpoch:1,webSessionId:'fresh-current-login-for-corruption-test'},input={kind:'unlink',request:unlink};
  const saved=(await pool.query('select result from lba_account_operation where owner_id=$1 and operation_id=$2',[owner,unlink.id])).rows[0].result;
  try{for(const result of [{...saved,privateProof:{value:'MUST_NOT_ESCAPE'}},{...saved,operationId:'another-operation'},{...saved,kind:'linked',reauthenticate:false},{...saved,authEpoch:{private:'MUST_NOT_ESCAPE'}}]){
   await pool.query('update lba_account_operation set result=$3::jsonb where owner_id=$1 and operation_id=$2',[owner,unlink.id,JSON.stringify(result)]);
   await assert.rejects(accounts.recoverOperation(fresh,input),/ACCOUNT_UNCONFIRMED/);
  }}finally{await pool.query('update lba_account_operation set result=$3::jsonb where owner_id=$1 and operation_id=$2',[owner,unlink.id,JSON.stringify(saved)]);}
 });
 await check('disabled service/epoch mismatch and operator legacy mode cannot authorize account work',async()=>{
  const fresh={...p,authEpoch:1};await assert.rejects(service(store,{enabled:false}).createChallenge(fresh,req('disabled')),/ACCOUNT_DISABLED/);
  await assert.rejects(service(store,{expectedControlEpoch:8}).createChallenge(fresh,req('wrong-epoch')),/ACCOUNT_DISABLED/);
  const readback={kind:'unlink',request:unlink};await assert.rejects(service(store,{enabled:false}).recoverOperation(p,readback),/ACCOUNT_DISABLED/);
  await assert.rejects(service(store,{expectedControlEpoch:8}).recoverOperation(p,readback),/ACCOUNT_DISABLED/);
  await pool.query("update lba_production_control set writer_mode='legacy'");await assert.rejects(accounts.createChallenge(fresh,req('legacy-mode')),/ACCOUNT_UNCONFIRMED/);await assert.rejects(accounts.recoverOperation(p,readback),/ACCOUNT_DISABLED/);await pool.query("update lba_production_control set writer_mode='canonical'");
 });
 report={author:'/root/account_core_resume',actualPostgreSQL:true,syntheticOnly:true,target,tests,sourceBefore:before,sourceAfter:await pins(),driverSha256,realProviderRequests:0,telegramSends:0,productionWrites:0,
  limits:'Actual canonical store/SQL account writes exercised on synthetic loopback DB. Provider HMAC fixtures are synthetic; recordVerifiedLogin hook is trusted injected evidence, not actual OIDC/MiniApp configuration. External epoch enforcement/UI/provider delivery remain root integration gates.'};
 });assert.deepEqual(report.sourceBefore,report.sourceAfter,'SOURCE_DRIFT');await writeFile(path.join(out,'actual-pg.json'),JSON.stringify({...report,clusterStopped:true},null,2)+'\n');console.log(JSON.stringify({passed:tests.length,sourceDrift:0,clusterStopped:true,providerRequests:0,productionWrites:0}));}
catch(e){await writeFile(path.join(out,'attempts',Date.now()+'.json'),JSON.stringify({tests,error:e.message,sourceBefore:before,sourceAfter:await pins(),productionWrites:0},null,2)+'\n');throw e;}
