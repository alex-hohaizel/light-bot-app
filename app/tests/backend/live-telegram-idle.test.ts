import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramDispatcher,DISPATCH_BOT_ID,type DispatchClient} from '../../server/production/telegram-dispatch.ts';

const at='2026-11-10T12:00:00.000Z';
const schema={callbackAcks:'lba_production_telegram_callback_acks',callbackAttempts:'lba_production_telegram_callback_ack_attempts',inbox:'lba_production_telegram_inbox'};
function fixture(query:(sql:string,values?:any[])=>Promise<{rows:any[];rowCount:number|null}>){
 let released=0,native=0;const sql:string[]=[];
 const client:DispatchClient={async query(text,values){sql.push(text);return query(text,values);},release(){released++;}};
 const forbidden=()=>{native++;throw Error('NATIVE_NOT_ALLOWED');};
 const dispatcher=createTelegramDispatcher({enabled:true,expectedBotId:DISPATCH_BOT_ID,expectedControlEpoch:1,workerId:'idle-fixture',pool:{connect:async()=>client},now:()=>at,
  resolveEligibility:async()=>({eligible:false,reason:'unlinked'}),createTransport:forbidden,createCallbackTransport:forbidden,callbacks:{enabled:true}});
 return {dispatcher,sql,counts:()=>({released,native})};
}
const rows=(values:any[])=>({rows:values,rowCount:values.length});
test('proven-empty delivery and callback ticks never take the shared lock or mutate anything',async()=>{
 const f=fixture(async sql=>{if(sql.includes('as "callbackAcks"'))return rows([schema]);if(sql.includes('as "needsWork"'))return rows([{needsWork:false}]);throw Error('UNEXPECTED_COORDINATOR_WORK');});
 for(const run of [()=>f.dispatcher.dispatchNextPending(new AbortController().signal),()=>f.dispatcher.dispatchNextCallbackAck(new AbortController().signal)])assert.deepEqual(await run(),{kind:'idle'});
 assert.equal(f.sql.length,4);assert(f.sql.every(sql=>/^select\b/.test(sql)));assert(!f.sql.some(sql=>/advisory|\b(?:update|insert|delete)\b/i.test(sql)));assert.deepEqual(f.counts(),{released:2,native:0});
});
test('positive, unavailable and unrecognized no-work hints all retain the existing busy coordinator result',async()=>{
 for(const hint of ['positive','invalid','throw']){
  const f=fixture(async sql=>{if(sql.includes('as "callbackAcks"'))return rows([schema]);if(sql.includes('as "needsWork"')){if(hint==='throw')throw Error('OPTIONAL_READ_UNAVAILABLE');return rows([{needsWork:hint==='positive'?true:null}]);}if(sql.includes('pg_try_advisory_lock'))return rows([{locked:false}]);throw Error('UNEXPECTED_SQL');});
  assert.deepEqual(await f.dispatcher.dispatchNextPending(new AbortController().signal),{kind:'busy'});assert(f.sql.some(sql=>sql.includes('pg_try_advisory_lock')));assert.equal(f.counts().native,0);
 }
});
test('work arriving after an empty snapshot is observed on the next tick instead of being cached away',async()=>{
 let queued=false;
 const f=fixture(async sql=>{if(sql.includes('as "callbackAcks"'))return rows([schema]);if(sql.includes('as "needsWork"'))return rows([{needsWork:queued}]);if(sql.includes('pg_try_advisory_lock'))return rows([{locked:false}]);throw Error('UNEXPECTED_SQL');});
 assert.deepEqual(await f.dispatcher.dispatchNextCallbackAck(new AbortController().signal),{kind:'idle'});queued=true;
 assert.deepEqual(await f.dispatcher.dispatchNextCallbackAck(new AbortController().signal),{kind:'busy'});assert.equal(f.sql.filter(sql=>sql.includes('as "needsWork"')).length,2);assert.equal(f.counts().native,0);
});
test('a detected orphan still runs the original unknown/hold recovery before any provider access',async()=>{
 const f=fixture(async sql=>{
  if(sql.includes('as "callbackAcks"'))return rows([schema]);if(sql.includes('as "needsWork"'))return rows([{needsWork:true}]);
  if(sql.includes('pg_try_advisory_lock'))return rows([{locked:true}]);if(sql.startsWith('begin')||sql==='commit'||sql==='rollback')return rows([]);
  if(sql.includes('writer_mode as "writerMode"'))return rows([{controlEpoch:'1',writerMode:'canonical'}]);
  if(sql.includes('operation_id as id,source_kind as kind'))return rows([{id:'a'.repeat(64),kind:'profile',source:'synthetic-outbox',owner:'fixture-owner',fence:1}]);
  if(sql.startsWith('update ')||sql.includes('pg_advisory_unlock'))return rows([]);throw Error('UNEXPECTED_SQL');
 });
 assert.deepEqual(await f.dispatcher.dispatchNextPending(new AbortController().signal),{kind:'held',reason:'orphan_dispatch'});
 assert(f.sql.some(sql=>sql.includes("set state='unknown'")));assert(f.sql.some(sql=>sql.includes('set hold_reason=$2')));assert.equal(f.counts().native,0);
});
test('optional callback storage may be absent for idle profile delivery without turning missing callback storage into idle ACK success',async()=>{
 const f=fixture(async sql=>{if(sql.includes('as "callbackAcks"'))return rows([{callbackAcks:null,callbackAttempts:null,inbox:null}]);if(sql.includes('as "needsWork"'))return rows([{needsWork:false}]);if(sql.includes('pg_try_advisory_lock'))return rows([{locked:false}]);throw Error('UNEXPECTED_SQL');});
 assert.deepEqual(await f.dispatcher.dispatchNextPending(new AbortController().signal),{kind:'idle'});
 assert.deepEqual(await f.dispatcher.dispatchNextCallbackAck(new AbortController().signal),{kind:'busy'});assert.equal(f.sql.filter(sql=>sql.includes('as "needsWork"')).length,1);assert.equal(f.counts().native,0);
});
