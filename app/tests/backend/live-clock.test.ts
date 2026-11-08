import {test} from 'node:test';
import assert from 'node:assert/strict';
import {liveClock,missingLivePlan} from '../../client/src/product-review/runtime-clock.ts';
import {validateScheduleView} from '../../shared/schedule-core.ts';

test('live clock follows server instant through midnight and DST; no fixture date or manual time',()=>{
  assert.deepEqual(liveClock('2026-11-08T23:59:30+02:00',100,60100),{asOf:'2026-11-08T22:00:30.000Z',date:'2026-11-09'});
  assert.equal(liveClock('2026-10-25T03:59:30+03:00',0,60000).asOf,'2026-10-25T01:00:30.000Z');
  assert.throws(()=>liveClock('invalid',0,1));
  assert.throws(()=>liveClock('2026-11-08T14:10:00+02:00',5,4));
});
test('missing live data produces no synthetic intervals or false restoration ETA',()=>{
  const plan=missingLivePlan(undefined,'own-address','Дім','2026-11-08','2026-11-08T14:10:00+02:00','unavailable');
  validateScheduleView(plan);
  assert.equal(plan.synthetic,false);assert.equal(plan.deliveryEligible,false);assert.equal(plan.freshness,'unknown');
  assert.deepEqual(plan.intervals,[]);assert.equal(plan.source.url,null);assert.equal(plan.addressId,'own-address');
});
