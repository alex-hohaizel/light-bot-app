import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultNotificationPolicy, parseNotificationPolicy, parseLocationNotificationPolicy, resolveNotificationPolicy, reminderLeadMinutes, syncLegacyPolicyChanges } from '../../shared/notification-policy.ts';
import { createDemoProfile } from '../../shared/bot/fixtures.ts';
import { applyMigrationPlan, applyProfileDelta, emptyMigrationStore, planLegacyMigration, prepareMigrationRollback, replayRollbackChanges } from '../../server/domain/legacy-migration.ts';
import type { LegacySnapshot } from '../../shared/legacy-migration-contract.ts';

// Independent review of /root/legacy_policy code; root-authored migration consumer is separately labelled.
test('independent: malformed policies cannot admit either channel or recover positive leads', () => {
  const profile = createDemoProfile(); profile.preferences.optedIn = true; profile.preferences.reminders = true;
  const policy = defaultNotificationPolicy(profile.preferences);
  for (const value of [null, '30', -1, 1.5, 1441, NaN, Infinity, undefined]) {
    for (const channel of ['telegram', 'push'] as const) {
      const malformed = structuredClone(policy); (malformed.channels[channel] as any).beforeOnMinutes = value;
      assert.throws(() => parseNotificationPolicy(malformed));
      profile.preferences.notificationPolicy = malformed;
      profile.locations[0].notifications = true;
      assert.equal(reminderLeadMinutes(profile.preferences, profile.locations[0], 'telegram', 'ends'), 0);
    }
  }
  assert.throws(() => parseNotificationPolicy(Object.assign(Object.create({ version: policy.version }), { channels: policy.channels })));
  assert.throws(() => parseLocationNotificationPolicy({ version: policy.version, channels: { telegram: { enabled: true, beforeOffMinutes: null }, push: { enabled: false } } }));
});
test('independent: changes to paused raw policy keep each channel and edge through JSON restart', () => {
  const before = createDemoProfile(); before.preferences.notificationPolicy = defaultNotificationPolicy(before.preferences);
  before.preferences.paused = true; before.locations[0].notifications = true;
  before.locations[0].notificationPolicy = { version: 'lba-notification-policy/1', channels: { telegram: { enabled: true, beforeOnMinutes: 0 }, push: { enabled: true, beforeOnMinutes: 17 } } };
  const after = structuredClone(before);
  after.preferences.notificationPolicy!.channels.push = { enabled: true, remindersEnabled: true, beforeOffMinutes: 0, beforeOnMinutes: 11 };
  const saved = syncLegacyPolicyChanges(before, after);
  assert.equal(saved.preferences.optedIn, false); assert(saved.preferences.notificationPolicy!.channels.push.enabled);
  assert(!resolveNotificationPolicy(saved.preferences, saved.locations[0], 'push').enabled);
  const resumed = JSON.parse(JSON.stringify(saved)); resumed.preferences.paused = false;
  assert.equal(reminderLeadMinutes(resumed.preferences, resumed.locations[0], 'push', 'ends'), 17);
  assert.equal(reminderLeadMinutes(resumed.preferences, resumed.locations[0], 'telegram', 'ends'), 0);
});
const snapshot = (): LegacySnapshot => ({ kind: 'synthetic_legacy_snapshot', snapshotId: 'root-policy-rollback', sourceRevision: '45d77e22e68816e5695aa4b7d2a62bfc57e8176d', tables: {
  users: [{ id: 'synthetic-root-policy' }], userSettings: [{ userId: 'synthetic-root-policy', city: 'Тест', street: 'Тестова', houseNumber: '12А', queueId: '1.1', notificationsEnabled: false, telegramNotifications: false, notifyBeforeOff: 0, notifyBeforeOn: 15, telegramNotifyBeforeOff: 0, telegramNotifyBeforeOn: 5, minOutageDuration: 25 }],
  userLocations: [], telegramSubscribers: [], linkedAccounts: [], compareShares: [],
} });
test('root consumer regression: policy delta/rollback preserves newer independent channel writes and raw source', () => {
  const imported = applyMigrationPlan(emptyMigrationStore(), planLegacyMigration(snapshot()));
  const profile = structuredClone(imported.state.accounts['synthetic-root-policy'].profile!);
  profile.preferences.notificationPolicy!.channels.push.enabled = true;
  profile.preferences.notificationPolicy!.channels.push.beforeOnMinutes = 19;
  const updated = applyProfileDelta(imported.state, { id: 'policy-delta', accountId: profile.id, expectedRevision: 0, profile });
  assert.equal(updated.state.accounts[profile.id].profile!.preferences.minimumOutageMinutes, 1500);
  assert.throws(() => prepareMigrationRollback(updated.state, imported.receipt), /POST_SNAPSHOT_WRITES/);
  const rollback = prepareMigrationRollback(updated.state, imported.receipt, true);
  const replay = replayRollbackChanges(rollback.state, rollback);
  assert.deepEqual(replay.accounts[profile.id], updated.state.accounts[profile.id]);
  assert.deepEqual(replay.accounts[profile.id].archive, imported.state.accounts[profile.id].archive);
  assert.equal(replay.accounts[profile.id].profile!.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 5);
  assert.equal(replay.accounts[profile.id].profile!.preferences.notificationPolicy!.channels.push.beforeOnMinutes, 19);
});
test('root consumer regression: omitted policy/origin and malformed delta cannot erase imported rules', () => {
  const imported = applyMigrationPlan(emptyMigrationStore(), planLegacyMigration(snapshot()));
  for (const mutate of [
    (p: any) => { delete p.legacyNotificationPolicySourceHash; },
    (p: any) => { delete p.preferences.notificationPolicy; },
    (p: any) => { delete p.locations[0].notificationPolicy; },
    (p: any) => { p.preferences.notificationPolicy.channels.push.beforeOnMinutes = '19'; },
    (p: any) => { p.preferences.quietHours = { enabled: true, start: '00:00', end: '00:00', timezone: 'Europe/Kyiv' }; },
  ]) {
    const profile = structuredClone(imported.state.accounts['synthetic-root-policy'].profile!); mutate(profile);
    assert.throws(() => applyProfileDelta(imported.state, { id: 'bad-policy-delta', accountId: profile.id, expectedRevision: 0, profile }), /POLICY|INVALID_PROFILE_DELTA/);
  }
});
