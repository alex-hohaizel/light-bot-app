import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotState, handleBotInput } from '../../shared/bot/engine.ts';
import { parseProfileRequest, applyProfileMutation } from '../../server/domain/profile-service.ts';
import { REVIEW_ADDRESSES, returningReviewProfile, reviewBotContext } from '../../server/domain/review-context.ts';
import type { ProfileMutation } from '../../shared/profile-mutation.ts';
import { reviewProfilePlans } from '../../server/domain/review-context.ts';

const owner = 'lba-synthetic-profile-test';
test('reorder preserves exact identity, consent and primary; foreign, stale and invalid directions fail', () => {
  const state = apply(initial(), {kind:'add',optionId:'option-0',bindingRevisionId:'fixture-binding-1',label:'Батьки',confirmed:true}).state;
  const before = structuredClone(state), moved = apply(state,{kind:'move',addressId:'fixture-address-0',direction:'up'});
  assert.deepEqual(moved.state.profile.locations.map(item=>item.address.id),['fixture-address-0','fixture-address-1']);
  assert.deepEqual(moved.state.profile.locations,[before.profile.locations[1],before.profile.locations[0]]);
  assert.equal(moved.state.profile.primaryAddressId,before.profile.primaryAddressId);
  assert.deepEqual(moved.state.draft,before.draft);assert.deepEqual(moved.cancelledAddresses,[]);assert.deepEqual(state,before);
  assert.throws(()=>apply(state,{kind:'move',addressId:'foreign',direction:'up'}),/ADDRESS_NOT_FOUND/);
  assert.throws(()=>parseProfileRequest({id:'bad',expectedSessionId:state.sessionId,expectedRevision:state.revision,mutation:{kind:'move',addressId:'fixture-address-0',direction:'sideways'}}),/INVALID_PROFILE_INPUT/);
  assert.throws(()=>applyProfileMutation(moved.state,{id:'stale',expectedSessionId:state.sessionId,expectedRevision:state.revision,mutation:{kind:'move',addressId:'fixture-address-0',direction:'down'}},REVIEW_ADDRESSES),/REVISION_CONFLICT/);
  assert.deepEqual(apply(moved.state,{kind:'move',addressId:'fixture-address-0',direction:'up'}).state.profile,moved.state.profile);
});
test('plans match each saved binding and differ between buildings; mismatched binding cannot borrow a plan',()=>{
  const state=apply(initial(),{kind:'add',optionId:'option-0',bindingRevisionId:'fixture-binding-1',label:'Батьки',confirmed:true}).state;
  const plans=reviewProfilePlans(state.profile);assert.equal(plans.length,2);
  for(const plan of plans){const saved=state.profile.locations.find(item=>item.address.id===plan.addressId)!;
    assert.equal(plan.namespace,saved.binding.namespace);assert.equal(plan.targetId,saved.binding.targetId);assert.equal(plan.bindingRevisionId,saved.binding.revisionId);
    assert.equal(plan.addressLabel,saved.address.label);assert.equal(plan.deliveryEligible,false);assert.equal(plan.synthetic,true);}
  assert.notDeepEqual(plans[0].intervals,plans[1].intervals);
  state.profile.locations[0].binding.targetId='different-building';assert.deepEqual(reviewProfilePlans(state.profile).map(plan=>plan.addressId),['fixture-address-0']);
});
function initial() { return createBotState({ ownerId: owner, sessionId: 'profile-session', profile: returningReviewProfile(owner) }); }
function apply(state: ReturnType<typeof initial>, mutation: ProfileMutation) {
  return applyProfileMutation(state, parseProfileRequest({ id: 'test-1', expectedSessionId: state.sessionId, expectedRevision: state.revision, mutation }), REVIEW_ADDRESSES);
}
test('request boundary rejects injected owner/binding, unknown kind and coercible boolean', () => {
  const base = { id: 'one', expectedSessionId: 's1', expectedRevision: 0, mutation: { kind: 'preferences', patch: { optedIn: false } } };
  for (const value of [{ ...base, ownerId: 'other' }, { ...base, expectedRevision: '0' }, { ...base, mutation: { kind: 'FutureUnknown' } }, { ...base, mutation: { kind: 'preferences', patch: { optedIn: 'false' } } }, { ...base, mutation: { kind: 'add', optionId: 'option-0', bindingRevisionId: 'fixture-binding-1', label: 'Дім', confirmed: false } }, { ...base, mutation: { kind: 'preferences', patch: { providerToken: 'x' } } }]) assert.throws(() => parseProfileRequest(value), /INVALID_PROFILE_INPUT/);
});
test('exact catalog option is stored by stable ID, without silently opting in', () => {
  const before = initial();
  const result = apply(before, { kind: 'add', optionId: 'option-0', bindingRevisionId: 'fixture-binding-1', label: 'Батьки', confirmed: true });
  assert.deepEqual(result.state.profile.locations.map(item => item.address.house.literal), ['12А', '12']);
  assert.equal(result.state.profile.locations[1].address.id, REVIEW_ADDRESSES[0].address.id);
  assert.equal(result.state.profile.locations[1].notifications, false); assert.equal(result.state.profile.preferences.optedIn, false);
  assert.equal(before.profile.locations.length, 1);
});
test('stale revision, previous session and changed catalog binding cannot mutate', () => {
  const state = initial(), mutation: ProfileMutation = { kind: 'rename', addressId: state.profile.locations[0].address.id, label: 'Офіс' };
  for (const mismatch of [{ expectedRevision: state.revision + 1, expectedSessionId: state.sessionId }, { expectedRevision: state.revision, expectedSessionId: 'old-session' }]) {
    assert.throws(() => applyProfileMutation(state, { id: 'stale', ...mismatch, mutation }, REVIEW_ADDRESSES), /PROFILE_REVISION_CONFLICT/);
  }
  assert.throws(() => apply(state, { kind: 'add', optionId: 'option-0', bindingRevisionId: 'old-binding', label: 'Батьки', confirmed: true }), /BINDING_REVISION_CONFLICT/);
  assert.equal(state.profile.locations[0].address.label, 'Дім');
});
test('app rename preserves active bot draft and makes previous callbacks stale by revision', () => {
  const started = handleBotInput(initial(), { id: 'bot-add', kind: 'command', text: '/add' }, reviewBotContext(owner)).state;
  const draft = structuredClone(started.draft), callbacks = structuredClone(started.callbacks);
  const result = apply(started, { kind: 'rename', addressId: started.profile.locations[0].address.id, label: 'Офіс' });
  assert.deepEqual(result.state.draft, draft); assert.deepEqual(result.state.callbacks, callbacks);
  assert.equal(result.state.revision, started.revision + 1);
  assert(Object.values(result.state.callbacks).every(callback => callback.stateRevision !== result.state.revision));
  assert.equal(result.state.profile.locations[0].address.label, 'Офіс');
});
test('global opt-in and resume preserve per-address opt-out', () => {
  let state = initial(); state.profile.preferences.paused = true;
  state = apply(state, { kind: 'preferences', patch: { optedIn: true, paused: false } }).state;
  assert.equal(state.profile.preferences.optedIn, true); assert.equal(state.profile.preferences.paused, false);
  assert.equal(state.profile.locations[0].notifications, false);
  const off = apply(state, { kind: 'preferences', patch: { optedIn: false } });
  assert.deepEqual(off.cancelledAddresses, [null]); assert.equal(off.state.profile.locations[0].notifications, false);
});
test('explicit per-address subscription changes only that address plus global consent', () => {
  let state = apply(initial(), { kind: 'add', optionId: 'option-0', bindingRevisionId: 'fixture-binding-1', label: 'Батьки', confirmed: true }).state;
  state = apply(state, { kind: 'location', addressId: 'fixture-address-0', notifications: true }).state;
  assert.equal(state.profile.preferences.optedIn, true); assert.equal(state.profile.locations[0].notifications, false); assert.equal(state.profile.locations[1].notifications, true);
  const paused = apply(state, { kind: 'location', addressId: 'fixture-address-0', paused: true });
  assert.deepEqual(paused.cancelledAddresses, ['fixture-address-0']);
});
test('replacement retains stable scope consent only for unchanged binding', () => {
  const before = initial(); before.profile.locations[0].notifications = true;
  const same = apply(before, { kind: 'replace', addressId: 'fixture-address-1', optionId: 'option-1', bindingRevisionId: 'fixture-binding-1', label: 'Той самий', confirmed: true });
  assert.equal(same.state.profile.locations[0].notifications, true);
  const changed = apply(before, { kind: 'replace', addressId: 'fixture-address-1', optionId: 'option-2', bindingRevisionId: 'fixture-binding-1', label: 'Інший', confirmed: true });
  assert.equal(changed.state.profile.locations[0].notifications, false);
  assert.equal(changed.state.profile.primaryAddressId, 'fixture-address-2'); assert.deepEqual(changed.cancelledAddresses, ['fixture-address-1']);
});
test('delete requires separate confirmation and repairs primary without dropping other records', () => {
  let state = apply(initial(), { kind: 'add', optionId: 'option-0', bindingRevisionId: 'fixture-binding-1', label: 'Батьки', confirmed: true }).state;
  state = apply(state, { kind: 'delete', addressId: 'fixture-address-1', confirmed: true }).state;
  assert.equal(state.profile.primaryAddressId, 'fixture-address-0'); assert.equal(state.profile.locations.length, 1);
  state = apply(state, { kind: 'delete', addressId: 'fixture-address-0', confirmed: true }).state;
  assert.equal(state.profile.primaryAddressId, null); assert.equal(state.profile.locations.length, 0);
});
test('foreign/missing address and duplicate catalog identity fail closed', () => {
  assert.throws(() => apply(initial(), { kind: 'rename', addressId: 'another-owner-address', label: 'X' }), /ADDRESS_NOT_FOUND/);
  assert.throws(() => apply(initial(), { kind: 'add', optionId: 'option-1', bindingRevisionId: 'fixture-binding-1', label: 'Duplicate', confirmed: true }), /ALREADY_SAVED/);
});
test('quiet hours and reminder values are strict and have one shared policy', () => {
  const base = { id: 'one', expectedSessionId: 's', expectedRevision: 0, mutation: {} };
  for (const patch of [{ remindBeforeMinutes: -1 }, { remindBeforeMinutes: 30.5 }, { quietHours: { enabled: true, start: '22:00', end: '22:00', timezone: 'Europe/Kyiv' } }, { quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC' } }]) assert.throws(() => parseProfileRequest({ ...base, mutation: { kind: 'preferences', patch } }), /INVALID_PROFILE_INPUT/);
  const result = apply(initial(), { kind: 'preferences', patch: { reminders: true, remindBeforeMinutes: 15, quietHours: { enabled: true, start: '23:00', end: '07:00', timezone: 'Europe/Kyiv' } } });
  assert.equal(apply(initial(), { kind: 'preferences', patch: { remindBeforeMinutes: 0 } }).state.profile.preferences.remindBeforeMinutes, 0);
  assert.equal(result.state.profile.preferences.remindBeforeMinutes, 15); assert.deepEqual(result.cancelledAddresses, [null]);
});
