import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotState, handleBotInput, handleScheduleEvent } from '../../shared/bot/engine.ts';
import { createDemoContext, createDemoProfile } from '../../shared/bot/fixtures.ts';
import { defaultNotificationPolicy, NOTIFICATION_POLICY_VERSION as VERSION } from '../../shared/notification-policy.ts';
import type { BotState, BotContext, BotTurn } from '../../shared/bot/types.ts';
import type { ScheduleEvent, ScheduleView } from '../../shared/product-contract.ts';
import { REVIEW_PLAN } from '../../shared/review-fixtures.ts';
import { applyMigrationPlan, applyProfileDelta, emptyMigrationStore, planLegacyMigration } from '../../server/domain/legacy-migration.ts';

// These probes review root-authored engine/copy integration. The policy author
// does not claim independent review of their own resolver or projection.
function fixture() {
  const profile = createDemoProfile(); profile.preferences.optedIn = false; profile.preferences.reminders = true;
  profile.preferences.notificationPolicy = defaultNotificationPolicy(profile.preferences);
  profile.preferences.notificationPolicy.channels.telegram.beforeOnMinutes = 15;
  profile.preferences.notificationPolicy.channels.push = { enabled: true, remindersEnabled: true, beforeOffMinutes: 8, beforeOnMinutes: 9 };
  profile.locations[0].notifications = true;
  profile.locations[0].notificationPolicy = { version: VERSION, channels: { telegram: { enabled: true }, push: { enabled: true } } };
  return { state: createBotState({ ownerId: profile.id, profile }), context: createDemoContext(profile.id) };
}
function runner(initial: BotState, context: BotContext) {
  let state = structuredClone(initial), sequence = 0;
  return { get state() { return state; }, send(text: string, kind: 'command' | 'text' = 'command'): BotTurn {
    const turn = handleBotInput(state, { id: `policy-review-${++sequence}`, kind, text }, context);
    assert.equal(turn.rejected, undefined); state = turn.state; return turn;
  } };
}
test('root engine saves independent global edge commands without altering push or granting Telegram consent', () => {
  const f = fixture(), r = runner(f.state, f.context), push = structuredClone(f.state.profile.preferences.notificationPolicy!.channels.push);
  r.send('/before_off'); r.send('0', 'text');
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.beforeOffMinutes, 0);
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 15);
  r.send('/before_on'); r.send('5', 'text');
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 5);
  assert.equal(r.state.profile.preferences.optedIn, false);
  assert.deepEqual(r.state.profile.preferences.notificationPolicy!.channels.push, push);
  r.send('/push_before_off'); r.send('0', 'text');
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.push.beforeOffMinutes, 0);
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.push.beforeOnMinutes, 9);
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 5);
});
test('root engine explicit channel toggles and pause preserve other channel and raw configured intent', () => {
  const f = fixture(), r = runner(f.state, f.context);
  r.send('/push_off'); assert.equal(r.state.profile.preferences.notificationPolicy!.channels.push.enabled, false);
  assert.equal(r.state.profile.preferences.optedIn, false);
  r.send('/push_on'); assert.equal(r.state.profile.preferences.notificationPolicy!.channels.push.enabled, true);
  assert.equal(r.state.profile.preferences.optedIn, false);
  r.send('/notifications_on'); assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.enabled, true);
  r.send('/pause'); assert.equal(r.state.profile.preferences.paused, true);
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.enabled, true);
  r.send('/resume'); assert.equal(r.state.profile.preferences.paused, false);
  r.send('/notifications_off'); assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.enabled, false);
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.push.enabled, true);
});
test('generic reminder choice sets both Telegram edges even when chosen value equals saved before-off', () => {
  const f = fixture(), r = runner(f.state, f.context);
  assert.equal(r.state.profile.preferences.remindBeforeMinutes, 30);
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 15);
  r.send('/reminders'); r.send('30', 'text');
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.beforeOffMinutes, 30);
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 30);
  assert.equal(r.state.profile.preferences.notificationPolicy!.channels.push.beforeOnMinutes, 9);
});
test('persisted address edge wizard without its target fails closed instead of mutating global policy', () => {
  const f = fixture(), r = runner(f.state, f.context); r.send('/address_before_on');
  const restored = structuredClone(r.state); delete restored.policyAddressId;
  const before = structuredClone(restored.profile);
  const turn = handleBotInput(restored, { id: 'missing-wizard-target', kind: 'text', text: '77' }, f.context);
  assert.deepEqual(turn.state.profile, before);
  const deleted = structuredClone(r.state); deleted.profile.locations = [];
  const absent = handleBotInput(deleted, { id: 'deleted-wizard-target', kind: 'text', text: '77' }, f.context);
  assert.deepEqual(absent.state.profile, deleted.profile);
});
test('a local typed policy prevents bot address toggle from implicitly opting in the global Telegram channel', () => {
  const f = fixture(); delete f.state.profile.preferences.notificationPolicy;
  f.state.profile.locations[0].notifications = false; f.state.profile.locations[0].notificationPolicy!.channels.telegram.enabled = false;
  const r = runner(f.state, f.context); r.send('/address_before_on'); r.send('10', 'text');
  const callback = Object.entries(r.state.callbacks).find(([, value]) => value.stateRevision === r.state.revision && value.action.kind === 'location_action' && value.action.value === 'notifications');
  assert(callback);
  const turn = handleBotInput(r.state, { id: 'local-only-typed-toggle', kind: 'callback', callbackId: callback[0] }, f.context);
  assert.equal(turn.state.profile.locations[0].notifications, true);
  assert.equal(turn.state.profile.preferences.optedIn, false);
});
test('root event intake reads local channel permission and independent0/end edge before constructing a message', () => {
  const f = fixture(), state = f.state, location = state.profile.locations[0];
  state.profile.preferences.optedIn = true; state.profile.preferences.notificationPolicy!.channels.telegram.enabled = true;
  location.notificationPolicy!.channels.telegram = { enabled: true, beforeOffMinutes: 0, beforeOnMinutes: 10 };
  state.profile.preferences.minimumOutageMinutes = 1500;
  const binding = location.binding;
  const view: ScheduleView = { ...structuredClone(REVIEW_PLAN), synthetic: false, deliveryEligible: true,
    namespace: binding.namespace, targetId: binding.targetId, bindingRevisionId: binding.revisionId,
    source: { ...REVIEW_PLAN.source, verifiedLevel: 'integration' } };
  const interval = view.intervals[1];
  const event: ScheduleEvent = { id: 'policy-edge-check', addressId: view.addressId, operatorId: view.operatorId,
    serviceDate: view.serviceDate, fromRevisionId: null, toRevisionId: view.revisionId, kind: 'reminder', createdAt: '2026-11-07T14:30:10+02:00',
    reminder: { edge: 'starts', intervalStartsAt: interval.startsAt, intervalEndsAt: interval.endsAt } };
  assert.equal(handleScheduleEvent(state, event, view, { ...f.context, now: event.createdAt }).messages.length, 0);
  const endEvent = { ...event, id: 'policy-end-check', createdAt: '2026-11-07T17:20:10+02:00', reminder: { ...event.reminder!, edge: 'ends' as const } };
  assert.equal(handleScheduleEvent(state, endEvent, view, { ...f.context, now: endEvent.createdAt }).messages.length, 1);
  location.notificationPolicy!.channels.telegram.enabled = false;
  assert.equal(handleScheduleEvent(state, endEvent, view, { ...f.context, now: endEvent.createdAt }).messages.length, 0);
});
test('root migration consumes projection, preserves hour units and reconciles old alias deltas without losing push or provenance', () => {
  const plan = planLegacyMigration({ kind: 'synthetic_legacy_snapshot', snapshotId: 'independent-policy-wire', sourceRevision: '45d77e22e68816e5695aa4b7d2a62bfc57e8176d',
    tables: { users: [{ id: 'fixture-independent-wire' }], userSettings: [{ userId: 'fixture-independent-wire', notificationsEnabled: true,
      notifyBeforeOff: 0, notifyBeforeOn: 7, telegramNotifications: false, telegramNotifyBeforeOff: 0, telegramNotifyBeforeOn: 12, minOutageDuration: 25 }],
    userLocations: [], telegramSubscribers: [], linkedAccounts: [], compareShares: [] } });
  const account = plan.accounts[0], profile = account.profile!;
  assert.equal(profile.preferences.minimumOutageMinutes, 1500);
  assert.equal(profile.legacyNotificationPolicySourceHash, account.sourceHash);
  assert(profile.preferences.notificationPolicy!.channels.push.enabled);
  const imported = applyMigrationPlan(emptyMigrationStore(), plan).state;
  const oldCommand = structuredClone(profile); oldCommand.preferences.optedIn = true;
  const delta = { id: 'independent-legacy-alias', accountId: account.accountId, expectedRevision: 0, profile: oldCommand };
  const changed = applyProfileDelta(imported, delta).state.accounts[account.accountId].profile!;
  assert(changed.preferences.notificationPolicy!.channels.telegram.enabled);
  assert.deepEqual(changed.preferences.notificationPolicy!.channels.push, profile.preferences.notificationPolicy!.channels.push);
  assert.equal(changed.legacyNotificationPolicySourceHash, account.sourceHash);
  const missing = structuredClone(delta); delete missing.profile.preferences.notificationPolicy;
  assert.throws(() => applyProfileDelta(imported, missing), /DELTA_POLICY_LOSS/);
  const forged = structuredClone(delta); forged.profile.legacyNotificationPolicySourceHash = 'c'.repeat(64);
  assert.throws(() => applyProfileDelta(imported, forged), /DELTA_POLICY_ORIGIN_CONFLICT/);
});
