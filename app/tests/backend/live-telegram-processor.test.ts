import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createTelegramProcessor,resolveCurrentTelegramOwner,TELEGRAM_PROCESSOR_SCHEMA_SQL} from '../../server/production/telegram-processor.ts';
import {TELEGRAM_INBOX_BOT_ID} from '../../server/production/telegram-inbox.ts';
const now='2026-11-08T20:00:00Z';
const noStore={commitGuardedBotInput:async()=>{throw Error('must not call canonical');},recoverReceipt:async()=>{throw Error('must not recover');}};
function factory(pool:any,patch:any={}){return createTelegramProcessor({enabled:true,expectedBotId:TELEGRAM_INBOX_BOT_ID,expectedControlEpoch:7,pool,store:noStore,now:()=>now,...patch});}
test('construction is inert/default disabled and requires an explicit guarded canonical store, bot and epoch',async()=>{
 let connects=0;const pool={connect:async()=>{connects++;throw Error('PRIVATE');}};
 factory(pool);assert.equal(connects,0);const disabled=await factory(pool,{enabled:undefined}).processNext();assert('code'in disabled);assert.equal(disabled.code,'PROCESSOR_DISABLED');assert.equal(connects,0);
 for(const patch of [{expectedBotId:'other'},{expectedControlEpoch:0},{leaseMs:1},{maxAttempts:11},{enabled:'yes'},{store:{commitBotInput(){},recoverReceipt(){}}}])assert.throws(()=>factory(pool,patch),/INVALID_TELEGRAM_PROCESSOR_OPTIONS/);
 assert(!/\b(?:drop|truncate|delete|update|insert)\b/i.test(TELEGRAM_PROCESSOR_SCHEMA_SQL));assert(TELEGRAM_PROCESSOR_SCHEMA_SQL.includes('references lba_production_telegram_inbox'));
});
test('bad provider IDs never connect or become a different operation; storage failures use fixed nonprivate codes',async()=>{
 let connects=0;const p=factory({connect:async()=>{connects++;throw Error('PRIVATE_POOL_PASSWORD');}});
 for(const id of ['','0','-1','1.1','not-id','9'.repeat(17)])assert.deepEqual(await p.processUpdate(id),{status:'held',code:'INVALID_INBOX_WORK'});assert.equal(connects,0);
 const result=await p.processNext();assert.deepEqual(result,{status:'unavailable',code:'PROCESSOR_STORAGE_UNAVAILABLE'});assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('missing/wrong control prevents inbox/domain lookup, rolls back and releases the connection',async()=>{
 for(const control of [[],[{controlEpoch:7,writerMode:'disabled'}],[{controlEpoch:8,writerMode:'canonical'}]]){
  const calls:string[]=[];let releases=0;const p=factory({connect:async()=>({query:async(sql:string)=>{calls.push(sql);if(sql.startsWith('select control_epoch'))return {rows:control,rowCount:control.length};return {rows:[],rowCount:0};},release(){releases++;}})});
  const result=await p.processNext();assert.equal(result.status,'unavailable');assert(!calls.some(q=>q.includes('from lba_production_telegram_inbox')));assert.equal(calls.at(-1),'rollback');assert.equal(releases,1);
 }
});
test('explicit owner resolver uses only unique Telegram link and existing registry rows under SQL row locks',async()=>{
 const calls:Array<{sql:string;values:any[]}> =[];const client={query:async(sql:string,values:any[]=[])=>{calls.push({sql,values});return {rows:sql.includes('from linked_accounts')?[{id:'fixture-link',ownerId:'fixture-owner',actorId:'700001'}]:[{id:'fixture-owner'}],rowCount:1};}};
 const first=await resolveCurrentTelegramOwner(client,'700001'),again=await resolveCurrentTelegramOwner(client,'700001');assert.equal(first.status,'verified');assert.deepEqual(first,again);if(first.status==='verified')assert.match(first.revisionId,/^[a-f0-9]{64}$/);
 assert(calls.every(c=>c.sql.endsWith('for share')));assert(calls[0].sql.includes("provider='telegram' and provider_id=$1"));assert.deepEqual(calls[0].values,['700001']);assert(calls.every(c=>!c.sql.includes('username')&&!c.sql.includes('email')&&!c.sql.includes('tg_')));
});
test('missing/ambiguous/dangling owner mapping stays explicit and never creates users or chooses a first link',async()=>{
 for(const [links,users,status] of [[[],[],'missing'],[[{id:'a',ownerId:'a',actorId:'700001'},{id:'b',ownerId:'b',actorId:'700001'}],[],'ambiguous'],[[{id:'a',ownerId:'a',actorId:'700001'}],[],'dangling']] as const){
  const calls:string[]=[];const result=await resolveCurrentTelegramOwner({query:async(sql:string)=>{calls.push(sql);return {rows:sql.includes('from linked_accounts')?[...links]:[...users],rowCount:0};}},'700001');assert.equal(result.status,status);assert(calls.every(q=>q.startsWith('select ')));
 }
 let queries=0;await assert.rejects(resolveCurrentTelegramOwner({query:async()=>{queries++;return {rows:[],rowCount:0};}},'tg_700001'),/INVALID_INBOX_WORK/);assert.equal(queries,0);
});
test('ignored inbox rows are not processed or given a fake domain receipt',async()=>{
 const calls:string[]=[];const source={botId:TELEGRAM_INBOX_BOT_ID,updateId:'12',chatKey:'700001',disposition:'ignored'};
 const p=factory({connect:async()=>({query:async(sql:string)=>{calls.push(sql);return {rows:sql.startsWith('select control_epoch')?[{controlEpoch:7,writerMode:'canonical'}]:sql.includes('pg_try_advisory')?[{locked:true}]:sql.includes('from lba_production_telegram_inbox')?[source]:[],rowCount:0};},release(){}})});
 assert.deepEqual(await p.processUpdate('12'),{status:'idle'});assert(calls.every(q=>!q.startsWith('insert ')&&!q.startsWith('update ')));
});
test('malformed accepted private work is held before resolver/domain invocation, without guessing an owner',async()=>{
 const calls:string[]=[];const source={botId:TELEGRAM_INBOX_BOT_ID,updateId:'13',controlEpoch:7,chatKey:'700001',ingressSha:'a'.repeat(64),disposition:'accepted',eventKind:'message',ignoredReason:null,receivedAt:now,privateInput:{ownerId:'FORGED_OWNER'}};
 const p=factory({connect:async()=>({query:async(sql:string)=>{calls.push(sql);return {rows:sql.startsWith('select control_epoch')?[{controlEpoch:7,writerMode:'canonical'}]:sql.includes('pg_try_advisory')?[{locked:true}]:sql.includes('from lba_production_telegram_inbox')?[source]:[],rowCount:sql.startsWith('insert ')?1:0};},release(){}})},{resolveOwner:async()=>{throw Error('must not resolve malformed');}});
 const result=await p.processUpdate('13');assert.deepEqual(result,{status:'held',code:'INVALID_INBOX_WORK',updateId:'13'});assert(calls.filter(q=>q.startsWith('insert ')).every(q=>q.includes('lba_production_telegram_processing')));assert(!JSON.stringify(result).includes('FORGED'));
});
test('module import without DB/provider environment exports only explicit processor capabilities',()=>{
 const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',"const m=await import('./server/production/telegram-processor.ts');console.log(Object.keys(m).sort().join(','))"],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{PATH:process.env.PATH,TZ:'UTC'},encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'TELEGRAM_PROCESSOR_SCHEMA_SQL,TELEGRAM_PROCESSOR_VERSION,createTelegramProcessor,resolveCurrentTelegramOwner');
});
