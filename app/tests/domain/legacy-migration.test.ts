import test from 'node:test';
import assert from 'node:assert/strict';
import { planLegacyMigration, applyMigrationPlan, emptyMigrationStore, applyProfileDelta, prepareMigrationRollback, replayRollbackChanges, migrationHash } from '../../server/domain/legacy-migration.ts';
import type { LegacyRow, LegacySnapshot } from '../../shared/legacy-migration-contract.ts';

const user = (id = 'fixture-owner-a'): LegacyRow => ({ id, email: 'synthetic@example.invalid', firstName: 'Тест', createdAt: '2025-01-01T00:00:00Z' });
const settings = (userId = 'fixture-owner-a'): LegacyRow => ({ userId, lookupMode: 'address', city: 'Вінниця', street: 'Колишня', houseNumber: '12А', queueId: '1.1', queueAlternatives: ['1.2'], addressQueueMemory: { 'Колишня:12А': '1.1' },
  notificationsEnabled: true, notifyBeforeOff: 0, notifyBeforeOn: 15, telegramNotifications: false, telegramChatId: 'synthetic-chat-a', telegramNotifyBeforeOff: 0, telegramNotifyBeforeOn: 5,
  quietHoursEnabled: true, quietHoursStart: 0, quietHoursEnd: 7, morningBriefingEnabled: true, morningBriefingHour: 0, minOutageDuration: 25, themeMode: 'elegant', hasSeenOnboarding: true });
const location = (id = 1, userId = 'fixture-owner-a', extras: LegacyRow = {}): LegacyRow => ({ id, userId, name: id === 1 ? 'Дім' : 'Робота', city: 'Вінниця', lookupMode: 'address', street: 'Колишня', houseNumber: id === 1 ? '12А' : '12/1', queueId: '1.1', isPrimary: id === 1, orderIndex: id - 1,
  notifyEnabled: true, telegramNotify: false, notifyBeforeOff: 0, notifyBeforeOn: 15, lastNotifKey: 'synthetic-historical-key', lastScheduleHash: 'synthetic-history-hash', shareId: `fixture-share-${id}`, ...extras });
function fixture(): LegacySnapshot {
  return { kind: 'synthetic_legacy_snapshot', snapshotId: 'fixture-snapshot-1', sourceRevision: '45d77e22e68816e5695aa4b7d2a62bfc57e8176d', tables: {
    users: [user()], userSettings: [settings()], userLocations: [location(), location(2)],
    telegramSubscribers: [{ chatId: 'synthetic-chat-a', userId: 'fixture-owner-a', username: 'synthetic_handle', enabled: false, notifyBeforeOff: 0, notifyBeforeOn: 5, quietHoursEnabled: true, quietHoursStart: 0, quietHoursEnd: 7, lastBotMsgId: 27, lastBriefingDate: '2026-11-06' }],
    linkedAccounts: [{ id: 'fixture-link-a', userId: 'fixture-owner-a', provider: 'telegram', providerId: 'synthetic-chat-a', displayName: 'Fixture' }],
    compareShares: [{ id: 5, shareId: 'fixture-compare-a', data: JSON.stringify({ locations: [{ city: 'Вінниця', queueId: '1.1' }] }), expiresAt: '2026-11-08T00:00:00Z' }],
  } };
}
test('each source row has a deterministic disposition and no IO/delivery effects', () => {
  const source = fixture(), before = structuredClone(source), plan = planLegacyMigration(source);
  assert.deepEqual(source, before); assert.deepEqual(plan, planLegacyMigration(structuredClone(source)));
  assert.equal(plan.rows.length, Object.values(source.tables).reduce((n, rows) => n + rows.length, 0));
  assert.equal(plan.counts.sourceRows, plan.counts.dispositions); assert.equal(plan.counts.accounts, 1);
  assert.equal(new Set(plan.rows.map(row => row.sourceRef)).size, plan.rows.length);
  assert(plan.rows.every(row => row.sourceHash.length === 64));
});
test('preserves exact IDs, order, primary, midnight/zero preferences and independent push/Telegram', () => {
  const account = planLegacyMigration(fixture()).accounts[0], profile = account.profile!;
  assert.equal(profile.id, 'fixture-owner-a'); assert.equal(profile.locations.length, 2);
  assert.equal(profile.primaryAddressId, profile.locations[0].address.id);
  assert.equal(profile.preferences.remindBeforeMinutes, 0); assert(profile.preferences.reminders);
  assert.equal(profile.preferences.notificationPolicy?.channels.telegram.beforeOnMinutes, 5);
  assert.equal(profile.preferences.quietHours.start, '00:00'); assert.equal(profile.preferences.morningBriefing.time, '00:00');
  assert.equal(profile.preferences.minimumOutageMinutes, 25 * 60); assert(!profile.preferences.optedIn);
  assert(account.locationCompatibility[0].pushEnabled); assert(!account.locationCompatibility[0].telegramEnabled);
  assert.equal(account.locationCompatibility[0].beforeOffMinutes, 0); assert.equal(account.locationCompatibility[0].beforeOnMinutes, 15);
  assert.equal(account.locationCompatibility[0].shareId, 'fixture-share-1');
});
test('old queue and raw renamed street survive without asserting a verified building or alias', () => {
  const account = planLegacyMigration(fixture()).accounts[0];
  for (const location of account.profile!.locations) {
    assert.equal(location.binding.kind, 'user_selected_group'); assert.equal(location.binding.status, 'needs_confirmation');
    assert.equal(location.binding.verifiedAt, null); assert.equal(location.address.street, 'Колишня'); assert.deepEqual(location.address.aliases, []);
  }
  assert.equal(account.archive.userSettings![0].addressQueueMemory !== undefined, true);
  assert.equal(account.archive.userLocations![0].lastNotifKey, 'synthetic-historical-key');
});
test('provider claims and channels are preserved without authenticating or inferring bot identity', () => {
  const account = planLegacyMigration(fixture()).accounts[0];
  assert.equal(account.accessClaims[0].subject, 'synthetic-chat-a'); assert.equal(account.accessClaims[0].verification, 'legacy_claim_unverified');
  assert.equal(account.channels[0].botId, null); assert.equal(account.channels[0].reachability, 'unknown'); assert(!account.channels[0].allowedByLegacy);
});
test('duplicate email/name does not merge accounts, even when addresses match', () => {
  const source = fixture(); source.tables.users.push(user('fixture-owner-b')); source.tables.userSettings.push(settings('fixture-owner-b'));
  const plan = planLegacyMigration(source); assert.equal(plan.accounts.length, 2);
  assert.notEqual(plan.accounts[0].profile!.locations[0].address.id, plan.accounts[1].profile!.locations[0].address.id);
  assert(plan.accounts.every(account => account.classification === 'needs_confirmation'));
});
test('same provider/subject across owners quarantines both without deletion or merge', () => {
  const source = fixture(); source.tables.users.push(user('fixture-owner-b'));
  source.tables.linkedAccounts.push({ ...source.tables.linkedAccounts[0], id: 'fixture-link-b', userId: 'fixture-owner-b' });
  const plan = planLegacyMigration(source); assert(plan.accounts.every(account => account.classification === 'conflict' && account.profile === null));
  assert.equal(plan.rows.length, 9); assert(plan.accounts.every(account => account.archive.users!.length === 1));
});
test('orphan subscriber/foreign location are explicit unresolved rows, never tg-prefix autoaccounts', () => {
  const source = fixture(); source.tables.telegramSubscribers.push({ chatId: 'synthetic-orphan-chat', userId: null, enabled: true });
  source.tables.userLocations.push(location(9, 'fixture-missing-owner'));
  const plan = planLegacyMigration(source); assert.equal(plan.accounts.length, 1); assert.equal(plan.counts.unresolved, 2);
  assert(plan.rows.filter(row => row.classification === 'unresolved').every(row => row.targetId === null));
});
test('malformed serialized preferences, booleans and unknown fields cannot silently become enabled', () => {
  const source = fixture(); source.tables.userSettings[0].queueAlternatives = '["1.1"]'; source.tables.userSettings[0].telegramNotifications = 'false'; source.tables.userSettings[0].unknownLegacySetting = { synthetic: true };
  const account = planLegacyMigration(source).accounts[0]; assert.equal(account.classification, 'conflict'); assert.equal(account.profile, null);
  assert.deepEqual(account.archive.userSettings![0].unknownLegacySetting, { synthetic: true });
});
test('nullable/missing settings stay off, fallback does not invent identities or force subscriber opt-in', () => {
  const source = fixture(); source.tables.userSettings = []; source.tables.userLocations = [];
  Object.assign(source.tables.telegramSubscribers[0], { city: 'Вінниця', street: 'Тестова', houseNumber: '12', queueId: '1.1' });
  const account = planLegacyMigration(source).accounts[0]; assert(!account.profile!.preferences.optedIn); assert(!account.profile!.locations[0].notifications);
  assert(!account.locationCompatibility[0].pushEnabled); assert.equal(account.profile!.preferences.remindBeforeMinutes, 0);
});
test('multiple primary and duplicated share IDs preserve all rows and require resolution', () => {
  const source = fixture(); source.tables.userLocations[1].isPrimary = true;
  const ambiguous = planLegacyMigration(source).accounts[0]; assert.equal(ambiguous.profile!.primaryAddressId, null); assert(ambiguous.issues.some(issue => issue.code === 'multiple_primary_locations'));
  source.tables.userLocations[1].shareId = source.tables.userLocations[0].shareId;
  const collision = planLegacyMigration(source); assert.equal(collision.accounts[0].classification, 'conflict'); assert.equal(collision.accounts[0].archive.userLocations!.length, 2);
});
test('exact repeated import does not duplicate or overwrite later opt-out delta', () => {
  const plan = planLegacyMigration(fixture()), imported = applyMigrationPlan(emptyMigrationStore(), plan);
  const profile = structuredClone(imported.state.accounts['fixture-owner-a'].profile!); profile.preferences.paused = true;
  const updated = applyProfileDelta(imported.state, { id: 'fixture-delta-1', accountId: profile.id, expectedRevision: 0, profile });
  const repeated = applyMigrationPlan(updated.state, plan); assert(repeated.receipt.replayed); assert.deepEqual(repeated.state, updated.state);
  const tampered = structuredClone(plan); tampered.accounts[0].profile!.preferences.optedIn = true;
  assert.throws(() => applyMigrationPlan(emptyMigrationStore(), tampered), /PLAN_TAMPERED/);
});
test('same snapshot ID with new content conflicts and existing target account cannot be clobbered', () => {
  const source = fixture(), first = applyMigrationPlan(emptyMigrationStore(), planLegacyMigration(source));
  source.tables.userLocations[0].name = 'Змінена мітка';
  assert.throws(() => applyMigrationPlan(first.state, planLegacyMigration(source)), /SNAPSHOT_ID_CONTENT_CONFLICT/);
  source.snapshotId = 'fixture-other-snapshot';
  assert.throws(() => applyMigrationPlan(first.state, planLegacyMigration(source)), /TARGET_ACCOUNT_EXISTS/);
});
test('delta retry is idempotent, stale revision and identity/binding promotion fail closed', () => {
  const imported = applyMigrationPlan(emptyMigrationStore(), planLegacyMigration(fixture())).state;
  const profile = structuredClone(imported.accounts['fixture-owner-a'].profile!); profile.locations[0].address.label = 'Офіс';
  const delta = { id: 'fixture-delta-2', accountId: profile.id, expectedRevision: 0, profile };
  const changed = applyProfileDelta(imported, delta); assert(applyProfileDelta(changed.state, delta).replayed);
  assert.throws(() => applyProfileDelta(changed.state, { ...delta, id: 'another' }), /REVISION_CONFLICT/);
  assert.throws(() => applyProfileDelta(changed.state, { ...delta, profile: { ...profile, primaryAddressId: null } }), /DELTA_ID_CONTENT_CONFLICT/);
  const promoted = structuredClone(profile); promoted.locations[0].binding.status = 'verified';
  assert.throws(() => applyProfileDelta(imported, { ...delta, id: 'binding-promotion', profile: promoted }), /TRUSTED_BINDING/);
});
test('rollback restores exact hash, refuses to discard newer writes, exports and replays delta', () => {
  const initial = emptyMigrationStore(), imported = applyMigrationPlan(initial, planLegacyMigration(fixture()));
  const exact = prepareMigrationRollback(imported.state, imported.receipt); assert.equal(migrationHash(exact.state), migrationHash(initial)); assert.equal(exact.status, 'restored_exact');
  const profile = structuredClone(imported.state.accounts['fixture-owner-a'].profile!); profile.locations[0].address.label = 'Нова мітка після імпорту';
  const delta = { id: 'fixture-new-write', accountId: profile.id, expectedRevision: 0, profile };
  const updated = applyProfileDelta(imported.state, delta).state;
  assert.throws(() => prepareMigrationRollback(updated, imported.receipt), /POST_SNAPSHOT_WRITES/);
  const prepared = prepareMigrationRollback(updated, imported.receipt, true); assert(prepared.requiresReplay); assert.equal(prepared.postSnapshotChanges.length, 1);
  const replayed = replayRollbackChanges(prepared.state, prepared); assert.equal(replayed.accounts[profile.id].profile!.locations[0].address.label, profile.locations[0].address.label);
  assert(applyProfileDelta(replayed, delta).replayed);
  const drifted = structuredClone(prepared.state); drifted.importedSnapshots.extra = 'unrelated';
  assert.throws(() => replayRollbackChanges(drifted, prepared), /REPLAY_BASE_DRIFT/);
  const tampered = structuredClone(imported.receipt); tampered.before.importedSnapshots.modified = 'yes';
  assert.throws(() => prepareMigrationRollback(imported.state, tampered), /MANIFEST_TAMPERED/);
});
test('secret/session payloads and unsupported provenance are refused before planning', () => {
  const source = fixture(); source.tables.users[0].token = 'synthetic-disallowed-field'; assert.throws(() => planLegacyMigration(source), /UNSAFE/);
  const other = fixture(); other.sourceRevision = 'unverified'; assert.throws(() => planLegacyMigration(other), /SNAPSHOT_IDENTITY/);
});
test('orphan and ownerless global rows retain their full safe source payload in the applied store', () => {
  const source = fixture(); source.tables.telegramSubscribers.push({ chatId: 'fixture-orphan', userId: null, street: 'fixture-orphan-payload', enabled: false });
  const plan = planLegacyMigration(source), applied = applyMigrationPlan(emptyMigrationStore(), plan);
  assert(JSON.stringify(plan).includes('fixture-orphan-payload'));
  const archive = Object.values(applied.state.snapshotArchives)[0];
  assert.deepEqual(archive, source); assert.equal(archive.tables.compareShares[0].shareId, 'fixture-compare-a');
});
test('prototype-like delta IDs are own ledger keys and replay exactly once', () => {
  const imported = applyMigrationPlan(emptyMigrationStore(), planLegacyMigration(fixture())).state;
  for (const id of ['__proto__', 'constructor', 'toString']) {
    const profile = structuredClone(imported.accounts['fixture-owner-a'].profile!); profile.preferences.paused = true;
    const delta = { id, accountId: profile.id, expectedRevision: 0, profile };
    const once = applyProfileDelta(imported, delta); assert(Object.hasOwn(once.state.appliedDeltas, id));
    assert(applyProfileDelta(once.state, delta).replayed);
  }
});
test('rollback seals cover carried account changes, baseline, delta ledger and later import archives', () => {
  const imported = applyMigrationPlan(emptyMigrationStore(), planLegacyMigration(fixture()));
  const profile = structuredClone(imported.state.accounts['fixture-owner-a'].profile!); profile.preferences.paused = true;
  const updated = applyProfileDelta(imported.state, { id: 'sealed-delta', accountId: profile.id, expectedRevision: 0, profile }).state;
  const rollback = prepareMigrationRollback(updated, imported.receipt, true);
  for (const mutate of [
    (value: typeof rollback) => { value.postSnapshotChanges[0].account!.profile!.preferences.optedIn = true; },
    (value: typeof rollback) => { value.state.importedSnapshots.injected = 'untrusted'; },
    (value: typeof rollback) => { value.deltaLedger.injected = 'untrusted'; },
    (value: typeof rollback) => { value.postSnapshotImports.push({ key: 'injected', digest: null, archive: null }); },
  ]) {
    const tampered = structuredClone(rollback); mutate(tampered);
    assert.throws(() => replayRollbackChanges(rollback.state, tampered), /ROLLBACK_PACKAGE_TAMPERED/);
  }
});
test('embedded credential fields are rejected before any plan or archive is produced', () => {
  const source = fixture(); source.tables.compareShares[0].data = JSON.stringify({ token: 'synthetic-sensitive-marker' });
  assert.throws(() => planLegacyMigration(source), /UNSAFE_EMBEDDED/);
});
test('rollback preserves subsequent imports and their raw archive/idempotency ledger', () => {
  const first = applyMigrationPlan(emptyMigrationStore(), planLegacyMigration(fixture()));
  const sourceB = fixture(); sourceB.snapshotId = 'fixture-snapshot-b';
  sourceB.tables = { users: [user('fixture-owner-b')], userSettings: [settings('fixture-owner-b')], userLocations: [], telegramSubscribers: [], linkedAccounts: [], compareShares: [] };
  const planB = planLegacyMigration(sourceB), second = applyMigrationPlan(first.state, planB);
  const rollback = prepareMigrationRollback(second.state, first.receipt, true);
  const replayed = replayRollbackChanges(rollback.state, rollback);
  assert(replayed.accounts['fixture-owner-b']); assert(!replayed.accounts['fixture-owner-a']);
  assert.equal(Object.keys(replayed.importedSnapshots).length, 1);
  assert.deepEqual(Object.values(replayed.snapshotArchives)[0], sourceB);
  const retried = applyMigrationPlan(replayed, planB); assert(retried.receipt.replayed); assert.deepEqual(retried.state, replayed);
});
test('SQL-nullable JSON caches remain null and do not quarantine a valid account', () => {
  const source = fixture(); source.tables.userSettings[0].queueAlternatives = null; source.tables.userSettings[0].addressQueueMemory = null;
  const account = planLegacyMigration(source).accounts[0]; assert.equal(account.classification, 'needs_confirmation');
  assert.equal(account.archive.userSettings![0].queueAlternatives, null); assert.equal(account.archive.userSettings![0].addressQueueMemory, null);
  assert(account.profile!.locations.every(location => location.binding.status === 'needs_confirmation'));
});
