import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionMorningBriefing,MORNING_BRIEFING_SCHEMA_SQL} from '../../server/production/morning-briefing.ts';
test('morning service constructor/import and disabled entry points never touch SQL, certificates or transport',async()=>{
 let calls=0;const options={expectedControlEpoch:7,store:{commitMorningBriefing:async()=>{calls++;throw Error('PRIVATE_DIAGNOSTIC');}},events:{qualifySchedule:async()=>{calls++;throw Error('PRIVATE_DIAGNOSTIC');}}};
 for(const enabled of [undefined,false]){const service=createProductionMorningBriefing({...options,enabled});assert.equal(calls,0);assert.deepEqual(await service.commit(null as any),{kind:'disabled'});assert.equal(await service.verifyDispatch(null as any),null);assert.equal(calls,0);}
 assert(!/\b(?:insert|update|delete|drop|alter)\b/i.test(MORNING_BRIEFING_SCHEMA_SQL));
});
test('morning recipe requires exact trusted server ports and positive epoch',()=>{
 for(const options of [null,{}, {expectedControlEpoch:0,store:{commitMorningBriefing(){}},events:{qualifySchedule(){}}}, {expectedControlEpoch:7,store:{},events:{}}])
  assert.throws(()=>createProductionMorningBriefing(options as any),/PRODUCTION_MORNING_BRIEFING_INVALID_OPTIONS/);
});
