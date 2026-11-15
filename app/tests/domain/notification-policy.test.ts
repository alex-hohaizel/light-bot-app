import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotState } from '../../shared/bot/engine.ts';
import { createDemoProfile } from '../../shared/bot/fixtures.ts';
import { REVIEW_PLAN } from '../../shared/review-fixtures.ts';
import { canDeliver } from '../../shared/schedule-core.ts';
import { NOTIFICATION_POLICY_VERSION as VERSION, defaultNotificationPolicy, globalNotificationPolicy, parseNotificationPolicy,
  parseLocationNotificationPolicy, resolveNotificationPolicy, reminderLeadMinutes, reminderDurationEligible, syncLegacyPolicyChanges } from '../../shared/notification-policy.ts';
import { projectLegacyNotificationPolicy } from '../../server/domain/legacy-policy-adapter.ts';
import { applyProfileMutation, parseProfileRequest } from '../../server/domain/profile-service.ts';
import { migrationHash, planLegacyMigration } from '../../server/domain/legacy-migration.ts';
import type { LegacySnapshot, MigratedAccount } from '../../shared/legacy-migration-contract.ts';

function snapshot(): LegacySnapshot {
  return { kind: 'synthetic_legacy_snapshot', snapshotId: 'policy-fixture-1', sourceRevision: '45d77e22e68816e5695aa4b7d2a62bfc57e8176d', tables: {
    users: [{ id: 'fixture-policy-owner' }],
    userSettings: [{ userId: 'fixture-policy-owner', city: 'Вінниця', street: 'Тестова', houseNumber: '12А', queueId: '1.1',
      notificationsEnabled: false, notifyBeforeOff: 0, notifyBeforeOn: 15, telegramNotifications: true,
      telegramNotifyBeforeOff: 30, telegramNotifyBeforeOn: 5, quietHoursEnabled: true, quietHoursStart: 0, quietHoursEnd: 7,
      morningBriefingEnabled: true, morningBriefingHour: 0, minOutageDuration: 25, queueAlternatives: null, addressQueueMemory: null }],
    userLocations: [
      { id: 1, userId: 'fixture-policy-owner', name: 'Дім', city: 'Вінниця', street: 'Тестова', houseNumber: '12А', queueId: '1.1', isPrimary: true, orderIndex: 0, notifyEnabled: true, telegramNotify: false, notifyBeforeOff: 0, notifyBeforeOn: 10 },
      { id: 2, userId: 'fixture-policy-owner', name: 'Робота', city: 'Вінниця', street: 'Тестова', houseNumber: '12/1', queueId: '1.1', isPrimary: false, orderIndex: 1, notifyEnabled: false, telegramNotify: true, notifyBeforeOff: 20, notifyBeforeOn: 0 },
    ],
    telegramSubscribers: [{ chatId: 'synthetic-policy-chat', userId: 'fixture-policy-owner', enabled: true, notifyBeforeOff: 30, notifyBeforeOn: 5,
      quietHoursEnabled: true, quietHoursStart: 0, quietHoursEnd: 7, morningBriefingEnabled: true, morningBriefingHour: 0, minOutageDuration: 25 }],
    linkedAccounts: [], compareShares: [],
  } };
}
function uninitialized(input = snapshot()): MigratedAccount {
  const account = structuredClone(planLegacyMigration(input).accounts[0]);
  if (account.profile) {
    delete account.profile.legacyNotificationPolicySourceHash;
    delete account.profile.preferences.notificationPolicy;
    for (const location of account.profile.locations) delete location.notificationPolicy;
  }
  return account;
}
function configured() {
  const profile = createDemoProfile();
  profile.preferences.optedIn = true; profile.preferences.reminders = true;
  profile.preferences.notificationPolicy = defaultNotificationPolicy(profile.preferences);
  const location = profile.locations[0]; location.notifications = true;
  location.notificationPolicy = { version: VERSION, channels: { telegram: { enabled: true }, push: { enabled: false } } };
  return profile;
}
function request(profile = configured(), mutation: unknown = { kind: 'preferences', patch: { paused: true } }) {
  const state = createBotState({ ownerId: profile.id, profile });
  return { state, request: parseProfileRequest({ id: 'policy-mutation', expectedSessionId: state.sessionId, expectedRevision: state.revision, mutation }) };
}

test('known source fields become independent effective channel/edge policies, without losing0 or midnight', () => {
  const before = uninitialized(), original = structuredClone(before), after = projectLegacyNotificationPolicy(before), profile = after.profile!;
  assert.deepEqual(before, original); assert.deepEqual(after.archive, before.archive);
  const policy = profile.preferences.notificationPolicy!;
  assert.deepEqual(policy.channels.push, { enabled: false, remindersEnabled: true, beforeOffMinutes: 0, beforeOnMinutes: 15 });
  assert.deepEqual(policy.channels.telegram, { enabled: true, remindersEnabled: true, beforeOffMinutes: 30, beforeOnMinutes: 5 });
  assert.equal(profile.preferences.quietHours.start, '00:00'); assert.equal(profile.preferences.morningBriefing.time, '00:00');
  assert.equal(profile.preferences.minimumOutageMinutes, 1500);
  const home = profile.locations[0], work = profile.locations[1];
  assert.equal(resolveNotificationPolicy(profile.preferences, home, 'telegram').enabled, false);
  assert.equal(resolveNotificationPolicy(profile.preferences, home, 'push').enabled, false);
  assert.equal(reminderLeadMinutes(profile.preferences, work, 'telegram', 'starts'), 20);
  assert.equal(reminderLeadMinutes(profile.preferences, work, 'telegram', 'ends'), 0);
  assert.equal(after.archive.userSettings![0].queueAlternatives, null);
  assert.equal(after.archive.userSettings![0].addressQueueMemory, null);
  assert(profile.locations.every(location => location.binding.status === 'needs_confirmation' && location.binding.verifiedAt === null));
});
test('subscriber fallback does not resurrect any linked address with an explicit local opt-out', () => {
  const input = snapshot(); input.tables.userLocations.forEach(row => { row.telegramNotify = false; });
  const profile = projectLegacyNotificationPolicy(uninitialized(input)).profile!;
  assert(profile.preferences.notificationPolicy!.channels.telegram.enabled);
  assert(profile.locations.every(location => !resolveNotificationPolicy(profile.preferences, location, 'telegram').enabled));
});
test('a settings carrier retains separate global Telegram and push leads on its only address', () => {
  const input = snapshot(); input.tables.userLocations = [];
  const profile = projectLegacyNotificationPolicy(uninitialized(input)).profile!;
  const local = profile.locations[0].notificationPolicy!;
  assert.equal(local.channels.telegram.beforeOffMinutes, 30); assert.equal(local.channels.telegram.beforeOnMinutes, 5);
  assert.equal(local.channels.push.beforeOffMinutes, 0); assert.equal(local.channels.push.beforeOnMinutes, 15);
});
test('global edge0 does not erase a positive independent legacy address override', () => {
  const input = snapshot(), settings = input.tables.userSettings[0], subscriber = input.tables.telegramSubscribers[0];
  settings.notifyBeforeOff = 0; settings.notifyBeforeOn = 0; settings.notificationsEnabled = true;
  settings.telegramNotifyBeforeOff = 0; settings.telegramNotifyBeforeOn = 0;
  subscriber.notifyBeforeOff = 0; subscriber.notifyBeforeOn = 0;
  const result = projectLegacyNotificationPolicy(uninitialized(input)).profile!, home = result.locations[0], work = result.locations[1];
  assert.equal(result.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 0);
  assert.equal(reminderLeadMinutes(result.preferences, work, 'telegram', 'starts'), 20);
  assert.equal(reminderLeadMinutes(result.preferences, home, 'push', 'ends'), 10);
  result.preferences.notificationPolicy!.channels.telegram.remindersEnabled = false; result.preferences.reminders = false;
  assert.equal(reminderLeadMinutes(result.preferences, work, 'telegram', 'starts'), 0);
});
test('initialization is deterministic, JSON-restart safe, and never overwrites later owner edits or reset', () => {
  const first = projectLegacyNotificationPolicy(uninitialized());
  assert.deepEqual(first, projectLegacyNotificationPolicy(JSON.parse(JSON.stringify(first))));
  first.profile!.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes = 77;
  first.profile!.preferences.optedIn = false;
  assert.deepEqual(first, projectLegacyNotificationPolicy(first));
  const reset = structuredClone(first); reset.profile!.locations = []; delete reset.profile!.preferences.notificationPolicy;
  assert.deepEqual(reset, projectLegacyNotificationPolicy(reset));
});
test('null notification fields remain quarantined and inconsistent channel/quiet rules stay explicit and off', () => {
  const invalid = snapshot(); invalid.tables.userSettings[0].telegramNotifyBeforeOn = null;
  const account = planLegacyMigration(invalid).accounts[0];
  assert.equal(projectLegacyNotificationPolicy(account).profile, null); assert.equal(account.archive.userSettings![0].telegramNotifyBeforeOn, null);
  const disagree = snapshot(); disagree.tables.telegramSubscribers[0].quietHoursStart = 22;
  const result = projectLegacyNotificationPolicy(uninitialized(disagree));
  assert.equal(result.profile!.preferences.notificationPolicy!.channels.telegram.enabled, false);
  assert(result.issues.some(issue => issue.code === 'legacy_policy_global_rules_disagree'));
  assert.equal(result.archive.telegramSubscribers![0].quietHoursStart, 22);
  const leads = snapshot(); leads.tables.telegramSubscribers[0].notifyBeforeOn = 99;
  const mismatch = projectLegacyNotificationPolicy(uninitialized(leads));
  assert.equal(mismatch.profile!.preferences.notificationPolicy!.channels.telegram.enabled, false);
  assert(mismatch.issues.some(issue => issue.code === 'legacy_policy_endpoint_thresholds_disagree'));
  const sparse = snapshot(); delete sparse.tables.userSettings[0].quietHoursEnabled;
  const missing = projectLegacyNotificationPolicy(uninitialized(sparse));
  assert.equal(missing.profile!.preferences.optedIn, false);
  assert(missing.issues.some(issue => issue.code === 'legacy_policy_global_rules_disagree'));
  const multi = snapshot(); multi.tables.userSettings = []; multi.tables.telegramSubscribers.push({ ...multi.tables.telegramSubscribers[0], chatId: 'synthetic-second-chat', notifyBeforeOn: 99 });
  const variants = projectLegacyNotificationPolicy(uninitialized(multi));
  assert.equal(variants.profile!.preferences.optedIn, false); assert(variants.issues.some(issue => issue.code === 'legacy_policy_endpoint_thresholds_disagree'));
});
test('equal legacy quiet bounds normalize to disabled, while source values and future policy validation remain exact', () => {
  const source = snapshot(); source.tables.userSettings[0].quietHoursEnd = 0; source.tables.telegramSubscribers[0].quietHoursEnd = 0;
  const result = projectLegacyNotificationPolicy(uninitialized(source));
  assert.deepEqual(result.profile!.preferences.quietHours, { enabled: false, start: '00:00', end: '00:00', timezone: 'Europe/Kyiv' });
  assert.equal(result.archive.userSettings![0].quietHoursEnabled, true);
  assert.doesNotThrow(() => request(configured(), { kind: 'preferences', patch: { quietHours: result.profile!.preferences.quietHours } }));
  assert.throws(() => request(configured(), { kind: 'preferences', patch: { quietHours: { ...result.profile!.preferences.quietHours, enabled: true } } }), /INVALID_PROFILE_INPUT/);
});
test('source tampering, forged origin and verified binding cannot be authorized by a policy projection', () => {
  const raw = uninitialized(); raw.archive.userSettings![0].notifyBeforeOn = 444;
  assert.throws(() => projectLegacyNotificationPolicy(raw), /SOURCE_HASH/);
  const verified = uninitialized(); verified.profile!.locations[0].binding.status = 'verified'; verified.profile!.locations[0].binding.verifiedAt = '2026-11-07T00:00:00Z';
  assert.throws(() => projectLegacyNotificationPolicy(verified), /CANNOT_VERIFY_BINDING/);
  const before = configured(), forged = structuredClone(before); forged.legacyNotificationPolicySourceHash = 'a'.repeat(64);
  assert.throws(() => syncLegacyPolicyChanges(before, forged), /INVALID_LEGACY_POLICY_ORIGIN/);
});
test('unmapped notification rules stay archived, explicit and disabled in their affected scope', () => {
  const input = snapshot(); input.tables.userSettings[0].notificationsEnabled = true;
  input.tables.userSettings[0].notifyOnlyBusinessDays = true;
  input.tables.userLocations[1].telegramNotifyAtWeekend = false;
  const result = projectLegacyNotificationPolicy(uninitialized(input));
  assert.equal(result.profile!.preferences.notificationPolicy!.channels.push.enabled, false);
  assert.equal(result.profile!.preferences.notificationPolicy!.channels.telegram.enabled, true);
  assert.equal(result.profile!.locations[1].notificationPolicy!.channels.telegram.enabled, false);
  assert.equal(result.archive.userSettings![0].notifyOnlyBusinessDays, true);
  assert.equal(result.archive.userLocations![1].telegramNotifyAtWeekend, false);
  assert(result.issues.find(issue => issue.code === 'legacy_policy_unmapped_notification_fields')!.sourceRefs.length >= 2);
});
test('strict policy boundaries preserve0, absent inheritance, and reject null/string/extra fields', () => {
  const policy = defaultNotificationPolicy(configured().preferences); policy.channels.telegram.beforeOffMinutes = 0;
  assert.equal(parseNotificationPolicy(policy).channels.telegram.beforeOffMinutes, 0);
  const local = { version: VERSION, channels: { telegram: { enabled: true }, push: { enabled: false, beforeOffMinutes: 0 } } };
  assert.equal(parseLocationNotificationPolicy(local).channels.telegram.beforeOffMinutes, undefined);
  for (const change of [
    (p: any) => { p.channels.telegram.beforeOffMinutes = null; },
    (p: any) => { p.channels.push.enabled = 'false'; },
    (p: any) => { p.sourceHash = 'forged'; },
    (p: any) => { p.channels.telegram.beforeOnMinutes = -1; },
  ]) { const bad = structuredClone(policy); change(bad); assert.throws(() => parseNotificationPolicy(bad), /INVALID_NOTIFICATION_POLICY/); }
});
test('push permission and reminder leads are independent of Telegram opt-out, including global/local pauses', () => {
  const profile = configured(), location = profile.locations[0];
  profile.preferences.optedIn = false; profile.preferences.reminders = false;
  profile.preferences.notificationPolicy!.channels.telegram.enabled = false;
  profile.preferences.notificationPolicy!.channels.push = { enabled: true, remindersEnabled: true, beforeOffMinutes: 0, beforeOnMinutes: 9 };
  location.notificationPolicy!.channels.push.enabled = true;
  assert(resolveNotificationPolicy(profile.preferences, location, 'push').enabled);
  assert(!resolveNotificationPolicy(profile.preferences, location, 'telegram').enabled);
  assert.equal(reminderLeadMinutes(profile.preferences, location, 'push', 'starts'), 0);
  assert.equal(reminderLeadMinutes(profile.preferences, location, 'push', 'ends'), 9);
  const binding = location.binding;
  const view = { ...REVIEW_PLAN, addressId: location.address.id, synthetic: false, deliveryEligible: true,
    source: { ...REVIEW_PLAN.source, verifiedLevel: 'integration' as const }, namespace: binding.namespace, targetId: binding.targetId, bindingRevisionId: binding.revisionId };
  assert(canDeliver(view, binding, profile.preferences, '2026-11-07T12:00:00+02:00', 'push'));
  assert(!canDeliver(view, binding, profile.preferences, '2026-11-07T12:00:00+02:00'));
  location.paused = true; assert(!resolveNotificationPolicy(profile.preferences, location, 'push').enabled);
  location.paused = false; profile.preferences.paused = true; assert(!globalNotificationPolicy(profile.preferences, 'push').enabled);
});
test('minimum duration applies only to before-off, keeps converted25hours and rejects invalid duration', () => {
  assert(!reminderDurationEligible({ minimumOutageMinutes: 1500 }, 'starts', 120));
  assert(reminderDurationEligible({ minimumOutageMinutes: 1500 }, 'ends', 120));
  assert(reminderDurationEligible({ minimumOutageMinutes: 1500 }, 'starts', 1500));
  assert(!reminderDurationEligible({ minimumOutageMinutes: -1 }, 'starts', 100));
  assert(!reminderDurationEligible({}, 'ends', NaN));
});
test('typed local enabling never changes global opt-out or revives other addresses', () => {
  const profile = configured(); profile.preferences.optedIn = false; profile.preferences.notificationPolicy!.channels.telegram.enabled = false;
  const old = structuredClone(profile.locations[0]); old.address.id = 'fixture-second-address'; old.binding.addressId = old.address.id; profile.locations.push(old);
  const policy = structuredClone(profile.locations[0].notificationPolicy!); policy.channels.telegram.enabled = true;
  const { state, request: input } = request(profile, { kind: 'location', addressId: profile.locations[0].address.id, notificationPolicy: policy });
  const after = applyProfileMutation(state, input, []).state.profile;
  assert.equal(after.preferences.optedIn, false); assert.equal(after.preferences.notificationPolicy!.channels.telegram.enabled, false);
  assert(after.locations.every(location => !resolveNotificationPolicy(after.preferences, location).enabled));
});
test('pending bindings can keep/edit configured typed policies, without becoming deliverable', () => {
  const profile = projectLegacyNotificationPolicy(uninitialized()).profile!;
  const policy = structuredClone(profile.preferences.notificationPolicy!); policy.channels.push.enabled = true; policy.channels.telegram.beforeOnMinutes = 6;
  const { state, request: input } = request(profile, { kind: 'preferences', patch: { notificationPolicy: policy } });
  const after = applyProfileMutation(state, input, []).state.profile;
  assert.equal(after.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 6);
  assert.equal(after.preferences.notificationPolicy!.channels.push.enabled, true);
  assert(after.locations.every(location => location.binding.verifiedAt === null));
  const location = after.locations[0], binding = location.binding;
  const view = { ...REVIEW_PLAN, addressId: location.address.id, operatorId: binding.operatorId, synthetic: false, deliveryEligible: true,
    source: { ...REVIEW_PLAN.source, verifiedLevel: 'integration' as const }, namespace: binding.namespace, targetId: binding.targetId, bindingRevisionId: binding.revisionId };
  assert(!canDeliver(view, binding, after.preferences, '2026-11-07T12:00:00+02:00', 'push'));
});
test('a local typed policy on another address prevents a plain alias mutation from implicitly granting global consent', () => {
  const profile = configured(); delete profile.preferences.notificationPolicy; profile.preferences.optedIn = false;
  const target = structuredClone(profile.locations[0]); target.address.id = 'fixture-untyped-target'; target.binding.addressId = target.address.id;
  delete target.notificationPolicy; target.notifications = false; profile.locations.push(target);
  const { state, request: input } = request(profile, { kind: 'location', addressId: target.address.id, notifications: true });
  const after = applyProfileMutation(state, input, []).state.profile;
  assert.equal(after.preferences.optedIn, false);
  assert.equal(resolveNotificationPolicy(after.preferences, after.locations[0]).enabled, false);
});
test('old command bridge updates only Telegram, preserves explicit typed changes and source origin on reset', () => {
  const before = configured(); before.legacyNotificationPolicySourceHash = 'b'.repeat(64);
  before.preferences.notificationPolicy!.channels.push = { enabled: true, remindersEnabled: true, beforeOffMinutes: 3, beforeOnMinutes: 4 };
  const legacy = structuredClone(before); legacy.preferences.remindBeforeMinutes = 0; legacy.preferences.reminders = false;
  const synced = syncLegacyPolicyChanges(before, legacy);
  assert.equal(synced.preferences.notificationPolicy!.channels.telegram.beforeOffMinutes, 0); assert.equal(synced.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 0);
  assert.deepEqual(synced.preferences.notificationPolicy!.channels.push, before.preferences.notificationPolicy!.channels.push);
  const explicit = structuredClone(before); explicit.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes = 44;
  assert.equal(syncLegacyPolicyChanges(before, explicit).preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 44);
  const reset = createDemoProfile(before.id); delete reset.preferences.notificationPolicy;
  assert.equal(syncLegacyPolicyChanges(before, reset).legacyNotificationPolicySourceHash, before.legacyNotificationPolicySourceHash);
});
test('profile policy request rejects contradictory alias values and source marker injection', () => {
  const profile = configured(), policy = defaultNotificationPolicy(profile.preferences);
  assert.throws(() => request(profile, { kind: 'preferences', patch: { notificationPolicy: policy, optedIn: false } }), /INVALID_PROFILE_INPUT/);
  assert.throws(() => request(profile, { kind: 'preferences', patch: { legacyNotificationPolicySourceHash: migrationHash({}) } }), /INVALID_PROFILE_INPUT/);
});
