import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionEventProducer,EVENT_PRODUCER_SCHEMA_SQL} from '../../server/production/event-producer.ts';
test('event producer construction and disabled run are inert; no certificate seed or startup DDL',async()=>{
 let calls=0;const options={pool:{connect:async()=>{calls++;throw Error('PRIVATE_DATABASE_DIAGNOSTIC');}},events:{commit:async()=>{calls++;throw Error('PRIVATE_DATABASE_DIAGNOSTIC');}},expectedControlEpoch:7};
 for(const enabled of [undefined,false]){const p=createProductionEventProducer({...options,enabled});assert.equal(calls,0);
  const result=await p.runOnce();assert.equal(result.kind,'disabled');assert.equal(result.eligible,0);assert.equal(result.morningBriefing,'unsupported_contract');await p.stop();assert.equal(calls,0);}
 assert(!/\b(?:insert|update|delete|drop)\b/i.test(EVENT_PRODUCER_SCHEMA_SQL));
 const upgrades=EVENT_PRODUCER_SCHEMA_SQL.split('\n').filter(line=>/^alter /i.test(line));assert.equal(upgrades.length,2);assert(upgrades.every(line=>/^alter table lba_production_event_producer_lease add column if not exists cursor_briefing_(?:owner|session) text not null default '';$/i.test(line)));
});
test('producer rejects unbounded batch/event/lease options and invalid epoch before any IO',()=>{
 const options={pool:{connect:async()=>{throw Error('MUST_NOT_CONNECT');}},events:{commit:async()=>{throw Error('MUST_NOT_COMMIT');}},expectedControlEpoch:7};
 for(const extra of [{expectedControlEpoch:0},{batchSize:0},{batchSize:201},{maxEvents:1001},{leaseMs:999},{leaseMs:60001},{workerId:'bad\nworker'},{morningBriefing:{}}])
  assert.throws(()=>createProductionEventProducer({...options,...extra}),/PRODUCTION_EVENT_PRODUCER_INVALID_OPTIONS/);
});
test('optional morning capability is reported accurately while disabled construction stays inert',async()=>{
 let calls=0;const p=createProductionEventProducer({expectedControlEpoch:7,pool:{connect:async()=>{calls++;throw Error('MUST_NOT_CONNECT');}},events:{commit:async()=>{calls++;throw Error('MUST_NOT_COMMIT');}},morningBriefing:{commit:async()=>{calls++;throw Error('MUST_NOT_COMMIT');}}});
 const result=await p.runOnce();assert.equal(result.kind,'disabled');assert.equal(result.morningBriefing,'available');assert.equal(result.briefingScanned,0);assert.equal(calls,0);await p.stop();
});
