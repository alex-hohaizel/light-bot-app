import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionScheduleEvents,scheduleEventDigest,SCHEDULE_EVENTS_SCHEMA_SQL} from '../../server/production/schedule-events.ts';
const principal={kind:'verified_server_principal' as const,verified:true as const,ownerId:'qa-events'};
function fixture(enabled?:boolean){let calls=0;const service=createProductionScheduleEvents({enabled,expectedControlEpoch:7,
 store:{commitScheduleEvent:async()=>{calls++;throw Error('PRIVATE_DATABASE_DIAGNOSTIC');}} as any});return {service,calls:()=>calls};}
test('construction/import are inert; explicit enable is required before any input or transaction work',async()=>{
 for(const enabled of [undefined,false]){const f=fixture(enabled);assert.deepEqual(await f.service.commit(null as any,null as any,null as any),{kind:'disabled'});assert.equal(await f.service.verifyDispatch(null as any),null);assert.equal(f.calls(),0);}
 assert(!/\b(?:insert|update|delete|drop|alter)\b/i.test(SCHEDULE_EVENTS_SCHEMA_SQL));
});
test('malformed/unbounded events fail before the canonical transaction and never expose nested private values',async()=>{
 const f=fixture(true);for(const e of [undefined,null,{},[],{id:{secret:'PRIVATE'}},{id:'bad\n'},{id:'x'.repeat(129)}])await assert.rejects(f.service.commit(principal,e as any,{} as any),/PRODUCTION_SCHEDULE_EVENT_INVALID/);assert.equal(f.calls(),0);
});
test('certification digest is stable for object-key order and cannot accept unsupported/prototype values',()=>{
 assert.equal(scheduleEventDigest({a:1,b:{x:2,y:3}}),scheduleEventDigest({b:{y:3,x:2},a:1}));assert.notEqual(scheduleEventDigest({a:'1'}),scheduleEventDigest({a:1}));
 for(const value of [NaN,new Date(),()=>{},Object.create({secret:'PRIVATE'})])assert.throws(()=>scheduleEventDigest(value),/PRODUCTION_SCHEDULE_EVENT_INVALID/);
});
