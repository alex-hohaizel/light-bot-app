import { createHash } from 'node:crypto';
import { projectLegacyNotificationPolicy } from './legacy-policy-adapter.ts';
import { parseLocationNotificationPolicy, parseNotificationPolicy, syncLegacyPolicyChanges } from '../../shared/notification-policy.ts';
import type { BotLocation, BotProfile } from '../../shared/bot/types.ts';
import { LEGACY_TABLES, type LegacyRow, type LegacySnapshot, type LegacyTable, type JsonValue, type MigrationIssue, type MigratedAccount, type MigrationPlan, type MigrationStore, type MigrationReceipt, type ProfileDelta, type RollbackResult, type RowDisposition } from '../../shared/legacy-migration-contract.ts';

const SOURCE_REVISION = '45d77e22e68816e5695aa4b7d2a62bfc57e8176d';
const VERSION = 'lba-legacy-migration/1' as const;
const maxRows = 10_000, maxRowBytes = 64_000;
const unsafeKey = /(?:password|secret|credential|token|session|authorization|cookie|initData|jwt|privateKey|apiKey)|^sess$/i;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function migrationHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function plain(value: unknown): value is LegacyRow { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype); }
function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every(item => safeJson(item, depth + 1));
  return plain(value) && Object.entries(value).every(([key, item]) => !unsafeKey.test(key) && safeJson(item, depth + 1));
}
function str(row: LegacyRow, key: string): string { return typeof row[key] === 'string' ? row[key] as string : ''; }
function boolean(row: LegacyRow, key: string): boolean { return row[key] === true; }
function integer(row: LegacyRow, key: string, fallback: number, max = 1440): number {
  return Number.isInteger(row[key]) && Number(row[key]) >= 0 && Number(row[key]) <= max ? Number(row[key]) : fallback;
}
const pk = (table: LegacyTable, row: LegacyRow): JsonValue => row[table === 'userSettings' ? 'userId' : table === 'telegramSubscribers' ? 'chatId' : 'id'] ?? null;
const accountOwner = (table: LegacyTable, row: LegacyRow): string | null => table === 'users' ? str(row, 'id') || null : table === 'compareShares' ? null : str(row, 'userId') || null;
const clock = (value: number) => `${String(value).padStart(2, '0')}:00`;
const addressId = (owner: string, carrier: string, key: JsonValue) => `legacy:${migrationHash([owner, carrier, key]).slice(0, 32)}`;

function validateRows(snapshot: LegacySnapshot): void {
  if (snapshot.kind !== 'synthetic_legacy_snapshot' || snapshot.sourceRevision !== SOURCE_REVISION || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId || !plain(snapshot.tables)) throw new Error('SYNTHETIC_SNAPSHOT_IDENTITY_REQUIRED');
  if (Object.keys(snapshot.tables).sort().join('|') !== [...LEGACY_TABLES].sort().join('|')) throw new Error('EXACT_LEGACY_TABLE_SET_REQUIRED');
  let count = 0;
  for (const table of LEGACY_TABLES) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows)) throw new Error('ROW_ARRAY_REQUIRED');
    count += rows.length;
    for (const row of rows) if (!plain(row) || !safeJson(row) || Buffer.byteLength(canonical(row)) > maxRowBytes) throw new Error('UNSAFE_OR_OVERSIZED_SYNTHETIC_ROW');
    if (table === 'compareShares') for (const row of rows) {
      if (typeof row.data !== 'string') continue;
      try {
        const embedded = JSON.parse(row.data);
        if (!safeJson(embedded)) throw new Error('UNSAFE_EMBEDDED_SYNTHETIC_ROW');
      } catch (error) {
        if (error instanceof Error && error.message === 'UNSAFE_EMBEDDED_SYNTHETIC_ROW') throw error;
        // Invalid JSON receives an explicit row conflict. Recognizable credential
        // keys in unparseable JSON are refused rather than copied into an archive.
        if (/\b(?:password|secret|credential|token|session|authorization|cookie|initData|jwt|apiKey)\b/i.test(row.data)) throw new Error('UNSAFE_EMBEDDED_SYNTHETIC_ROW');
      }
    }
  }
  if (count > maxRows) throw new Error('SYNTHETIC_ROW_LIMIT');
}
function rowErrors(table: LegacyTable, row: LegacyRow): string[] {
  const errors: string[] = [];
  if (pk(table, row) === null || (typeof pk(table, row) !== 'string' && typeof pk(table, row) !== 'number')) errors.push('missing_or_invalid_primary_key');
  if (['userLocations', 'compareShares'].includes(table) && (!Number.isSafeInteger(row.id) || Number(row.id) < 1)) errors.push('invalid_serial_primary_key');
  if (['users', 'userSettings', 'telegramSubscribers', 'linkedAccounts'].includes(table) && (typeof pk(table, row) !== 'string' || !pk(table, row))) errors.push('invalid_text_primary_key');
  if (table === 'users' && !str(row, 'id')) errors.push('missing_account_id');
  if (table !== 'users' && table !== 'compareShares' && typeof row.userId !== 'string' && !(table === 'telegramSubscribers' && row.userId === null)) errors.push('missing_owner');
  const bools = ['enabled', 'notificationsEnabled', 'telegramNotifications', 'quietHoursEnabled', 'morningBriefingEnabled', 'isPrimary', 'notifyEnabled', 'telegramNotify', 'hasSeenOnboarding'];
  for (const key of bools) if (Object.hasOwn(row, key) && typeof row[key] !== 'boolean') errors.push(`invalid_boolean:${key}`);
  for (const key of ['notifyBeforeOff', 'notifyBeforeOn', 'telegramNotifyBeforeOff', 'telegramNotifyBeforeOn', 'minOutageDuration', 'orderIndex']) if (Object.hasOwn(row, key) && (!Number.isInteger(row[key]) || Number(row[key]) < 0 || Number(row[key]) > (key === 'orderIndex' ? 100_000 : 1440))) errors.push(`invalid_integer:${key}`);
  for (const key of ['quietHoursStart', 'quietHoursEnd', 'morningBriefingHour']) if (Object.hasOwn(row, key) && (!Number.isInteger(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 23)) errors.push(`invalid_hour:${key}`);
  if (Object.hasOwn(row, 'lookupMode') && !['queue', 'address'].includes(String(row.lookupMode))) errors.push('invalid_lookup_mode');
  if (Object.hasOwn(row, 'queueAlternatives') && row.queueAlternatives !== null && (!Array.isArray(row.queueAlternatives) || !row.queueAlternatives.every(item => typeof item === 'string'))) errors.push('invalid_queue_alternatives_json');
  if (Object.hasOwn(row, 'addressQueueMemory') && row.addressQueueMemory !== null && (!plain(row.addressQueueMemory) || !Object.values(row.addressQueueMemory).every(item => typeof item === 'string'))) errors.push('invalid_address_memory_json');
  if (table === 'linkedAccounts' && (!str(row, 'provider') || !str(row, 'providerId'))) errors.push('missing_provider_subject');
  if (table === 'compareShares') {
    if (!str(row, 'shareId') || !str(row, 'data')) errors.push('invalid_compare_share');
    else { try { const data = JSON.parse(str(row, 'data')); if (!safeJson(data)) errors.push('unsafe_compare_json'); } catch { errors.push('invalid_compare_json'); } }
  }
  return errors;
}
function makeLocation(owner: string, carrier: string, row: LegacyRow): BotLocation {
  const id = addressId(owner, carrier, pk(carrier as LegacyTable, row));
  const queue = str(row, 'queueId');
  return { address: { id, label: str(row, 'name') || 'Дім', territoryId: `legacy-locality:${migrationHash(str(row, 'city')).slice(0, 16)}`,
    locality: str(row, 'city'), street: str(row, 'street'), house: { number: str(row, 'houseNumber'), literal: str(row, 'houseNumber') }, aliases: [] },
    binding: { addressId: id, operatorId: 'legacy-operator-unresolved', namespace: `legacy:${str(row, 'city')}`,
      targetId: queue || 'legacy-target-unresolved', kind: queue ? 'user_selected_group' : 'building',
      revisionId: `legacy:${migrationHash(row)}`, status: 'needs_confirmation', verifiedAt: null, effectiveFrom: null, effectiveUntil: null },
    notifications: carrier === 'userLocations' ? boolean(row, 'telegramNotify') : carrier === 'userSettings' ? boolean(row, 'telegramNotifications') : boolean(row, 'enabled'),
    paused: false };
}
/** A pure migration plan: no IO, identity activation, sending, deletion or live writes. */
export function planLegacyMigration(snapshot: LegacySnapshot): MigrationPlan {
  validateRows(snapshot);
  const rows: RowDisposition[] = [];
  const rowByRef = new Map<string, LegacyRow>();
  const indexes = new Map<string, RowDisposition[]>();
  for (const table of LEGACY_TABLES) snapshot.tables[table].forEach((row, index) => {
    const ref = `${table}:${index}`;
    const disposition: RowDisposition = { sourceRef: ref, table, oldPk: pk(table, row), sourceHash: migrationHash(row), accountId: accountOwner(table, row), targetId: null, classification: 'needs_confirmation', reasons: rowErrors(table, row) };
    if (disposition.reasons.length) disposition.classification = 'conflict';
    rows.push(disposition); rowByRef.set(ref, row);
    const key = `${table}:${canonical(disposition.oldPk)}`;
    indexes.set(key, [...(indexes.get(key) || []), disposition]);
  });
  const conflict = (group: RowDisposition[], reason: string) => group.forEach(row => { row.classification = 'conflict'; if (!row.reasons.includes(reason)) row.reasons.push(reason); });
  for (const group of indexes.values()) if (group.length > 1) conflict(group, 'duplicate_primary_key');
  for (const [table, fields] of [['linkedAccounts', ['provider', 'providerId']], ['userLocations', ['shareId']], ['compareShares', ['shareId']]] as const) {
    const seen = new Map<string, RowDisposition[]>();
    for (const row of rows.filter(item => item.table === table)) {
      const data = rowByRef.get(row.sourceRef)!;
      if (fields.some(field => !str(data, field))) continue;
      const key = canonical(fields.map(field => data[field])); seen.set(key, [...(seen.get(key) || []), row]);
    }
    for (const group of seen.values()) if (group.length > 1) conflict(group, table === 'linkedAccounts' ? 'provider_identity_collision' : 'share_identity_collision');
  }
  const accountIds = [...new Set(rows.filter(row => row.table === 'users' && row.accountId).map(row => row.accountId!))].sort();
  const known = new Set(accountIds);
  for (const row of rows) {
    if (row.table === 'compareShares') { if (row.classification !== 'conflict') row.classification = 'preserved_history'; continue; }
    if (!row.accountId || !known.has(row.accountId)) { if (row.classification !== 'conflict') row.classification = 'unresolved'; row.reasons.push('orphan_owner_requires_verified_link'); }
  }
  const accounts: MigratedAccount[] = accountIds.map(accountId => {
    const own = rows.filter(row => row.accountId === accountId);
    const archive: MigratedAccount['archive'] = {};
    for (const row of own) { archive[row.table] ||= []; archive[row.table]!.push(clone(rowByRef.get(row.sourceRef)!)); }
    const issues: MigrationIssue[] = [];
    for (const row of own) for (const reason of row.reasons) issues.push({ code: reason, sourceRefs: [row.sourceRef], nextAction: 'Resolve the source row explicitly; do not merge or discard it.' });
    if (own.some(row => row.classification === 'conflict')) {
      conflict(own, 'account_quarantined_for_source_conflict');
      return { accountId, revision: 0, sourceHash: migrationHash(archive), classification: 'conflict', profile: null, accessClaims: [], channels: [], locationCompatibility: [], archive, issues };
    }
    const settings = archive.userSettings?.[0];
    const subs = archive.telegramSubscribers || [];
    const prefs = settings || subs[0] || {};
    const consentSignals = [...(settings ? [boolean(settings, 'telegramNotifications')] : []), ...subs.map(row => boolean(row, 'enabled'))];
    const optedIn = consentSignals.length > 0 && consentSignals.every(Boolean);
    if (new Set(consentSignals).size > 1) issues.push({ code: 'legacy_consent_disagrees', sourceRefs: own.filter(row => ['telegramSubscribers', 'userSettings'].includes(row.table)).map(row => row.sourceRef), nextAction: 'Keep Telegram off until the authenticated owner chooses.' });
    if (subs.length > 1) issues.push({ code: 'multiple_legacy_channels', sourceRefs: own.filter(row => row.table === 'telegramSubscribers').map(row => row.sourceRef), nextAction: 'Preserve channels separately; validate bot identity and reachability.' });
    let carrier: LegacyTable = 'userLocations';
    let locationRows = [...(archive.userLocations || [])].sort((a, b) => integer(a, 'orderIndex', 0, 100_000) - integer(b, 'orderIndex', 0, 100_000) || canonical(pk('userLocations', a)).localeCompare(canonical(pk('userLocations', b))));
    if (!locationRows.length && settings && (str(settings, 'queueId') || str(settings, 'street'))) { carrier = 'userSettings'; locationRows = [settings]; }
    else if (!locationRows.length && subs.length === 1 && (str(subs[0], 'queueId') || str(subs[0], 'street'))) { carrier = 'telegramSubscribers'; locationRows = subs; }
    const locations = locationRows.map(row => makeLocation(accountId, carrier, row));
    const addressTuple = (row: LegacyRow) => canonical(['city', 'street', 'houseNumber', 'lookupMode', 'queueId'].map(key => row[key] ?? null));
    const projected = new Set(locationRows.map(addressTuple));
    const additional = [...(settings ? [settings] : []), ...subs].filter(row => (str(row, 'queueId') || str(row, 'street')) && !projected.has(addressTuple(row)));
    if (additional.length) issues.push({ code: 'additional_legacy_address_carrier', sourceRefs: own.filter(row => ['userSettings', 'telegramSubscribers'].includes(row.table)).map(row => row.sourceRef), nextAction: 'Raw address variants are preserved in archive; reconcile them explicitly before presenting every address as migrated.' });
    const primaryIndexes = locationRows.map((row, i) => boolean(row, 'isPrimary') ? i : -1).filter(i => i >= 0);
    const primaryAddressId = primaryIndexes.length === 1 ? locations[primaryIndexes[0]].address.id : carrier !== 'userLocations' && locations.length === 1 ? locations[0].address.id : null;
    if (locations.length && !primaryAddressId) issues.push({ code: primaryIndexes.length > 1 ? 'multiple_primary_locations' : 'missing_primary_location', sourceRefs: own.filter(row => row.table === carrier).map(row => row.sourceRef), nextAction: 'Ask the owner which saved location is primary; preserve order.' });
    const before = integer(prefs, settings ? 'telegramNotifyBeforeOff' : 'notifyBeforeOff', 30);
    const profile: BotProfile = { id: accountId, locations, primaryAddressId, preferences: { optedIn, paused: false, reminders: before > 0, remindBeforeMinutes: before,
      quietHours: { enabled: boolean(prefs, 'quietHoursEnabled'), start: clock(integer(prefs, 'quietHoursStart', 23, 23)), end: clock(integer(prefs, 'quietHoursEnd', 7, 23)), timezone: 'Europe/Kyiv' },
      morningBriefing: { enabled: boolean(prefs, 'morningBriefingEnabled'), time: clock(integer(prefs, 'morningBriefingHour', 7, 23)) }, minimumOutageMinutes: integer(prefs, 'minOutageDuration', 0) * 60 } };
    for (const row of own) { row.targetId = row.table === 'userLocations' || row.table === carrier ? addressId(accountId, row.table, row.oldPk) : accountId; row.reasons.push('legacy_identity_and_binding_require_reconfirmation'); }
    issues.push({ code: 'unverified_identity_and_binding', sourceRefs: own.map(row => row.sourceRef), nextAction: 'Verify compatible login and exact building/operator binding before delivery.' });
    return { accountId, revision: 0, sourceHash: migrationHash(archive), classification: 'needs_confirmation', profile,
      accessClaims: (archive.linkedAccounts || []).map(row => ({ legacyLinkId: str(row, 'id'), provider: str(row, 'provider'), subject: str(row, 'providerId'), verification: 'legacy_claim_unverified' })),
      channels: subs.map(row => ({ chatId: str(row, 'chatId'), botId: null, allowedByLegacy: boolean(row, 'enabled'), reachability: 'unknown', verification: 'legacy_claim_unverified' })),
      locationCompatibility: locationRows.map((row, index) => ({ addressId: locations[index].address.id, oldLocationId: pk(carrier, row), shareId: str(row, 'shareId') || null,
        pushEnabled: carrier === 'userLocations' ? boolean(row, 'notifyEnabled') : carrier === 'userSettings' ? boolean(row, 'notificationsEnabled') : false,
        telegramEnabled: locations[index].notifications, beforeOffMinutes: integer(row, 'notifyBeforeOff', 30), beforeOnMinutes: integer(row, 'notifyBeforeOn', 15) })), archive, issues };
  });
  const body: Omit<MigrationPlan, 'planHash'> = { version: VERSION, snapshotId: snapshot.snapshotId, snapshotHash: migrationHash(snapshot), sourceRevision: snapshot.sourceRevision, syntheticOnly: true,
    accounts: accounts.map(projectLegacyNotificationPolicy), rows, sourceSnapshot: clone(snapshot), sharedHistory: clone(snapshot.tables.compareShares), counts: { sourceRows: rows.length, dispositions: rows.length, accounts: accounts.length,
      conflicts: rows.filter(row => row.classification === 'conflict').length, unresolved: rows.filter(row => row.classification === 'unresolved').length } };
  return { ...body, planHash: migrationHash(body) };
}
export function emptyMigrationStore(): MigrationStore { return { version: 'lba-migration-store/1', accounts: {}, importedSnapshots: {}, snapshotArchives: {}, appliedDeltas: {} }; }
export function applyMigrationPlan(store: MigrationStore, plan: MigrationPlan): { state: MigrationStore; receipt: MigrationReceipt } {
  if (store.version !== 'lba-migration-store/1' || plan.version !== VERSION || plan.syntheticOnly !== true) throw new Error('UNSUPPORTED_MIGRATION');
  const { planHash, ...body } = plan;
  if (migrationHash(body) !== planHash) throw new Error('MIGRATION_PLAN_TAMPERED');
  if (planLegacyMigration(plan.sourceSnapshot).planHash !== planHash) throw new Error('MIGRATION_PLAN_SOURCE_MISMATCH');
  const key = `${VERSION}:${plan.snapshotId}`;
  if (store.importedSnapshots[key] && store.importedSnapshots[key] !== plan.snapshotHash) throw new Error('SNAPSHOT_ID_CONTENT_CONFLICT');
  const before = clone(store), state = clone(store), replayed = Boolean(store.importedSnapshots[key]);
  if (!replayed) {
    for (const account of plan.accounts) {
      if (Object.hasOwn(state.accounts, account.accountId)) throw new Error('TARGET_ACCOUNT_EXISTS_REQUIRES_RECONCILIATION');
      Object.defineProperty(state.accounts, account.accountId, { value: clone(account), enumerable: true, configurable: true, writable: true });
    }
    state.importedSnapshots[key] = plan.snapshotHash;
    state.snapshotArchives[key] = clone(plan.sourceSnapshot);
  }
  return { state, receipt: { snapshotHash: plan.snapshotHash, beforeHash: migrationHash(before), afterHash: migrationHash(state), before, after: clone(state), importedAccountIds: plan.accounts.map(account => account.accountId), replayed } };
}
/** Target-side synthetic writes after import; caller supplies the complete authenticated profile. */
export function applyProfileDelta(store: MigrationStore, delta: ProfileDelta): { state: MigrationStore; replayed: boolean } {
  if (!delta.id || delta.profile.id !== delta.accountId || !Number.isInteger(delta.expectedRevision) || !safeJson(delta)) throw new Error('INVALID_PROFILE_DELTA');
  const digest = migrationHash(delta), state = clone(store);
  if (Object.hasOwn(state.appliedDeltas, delta.id)) {
    if (state.appliedDeltas[delta.id] !== digest) throw new Error('DELTA_ID_CONTENT_CONFLICT');
    return { state, replayed: true };
  }
  const account = Object.hasOwn(state.accounts, delta.accountId) ? state.accounts[delta.accountId] : undefined;
  if (!account || account.classification === 'conflict' || !account.profile) throw new Error('DELTA_ACCOUNT_UNRESOLVED');
  if (account.revision !== delta.expectedRevision) throw new Error('DELTA_REVISION_CONFLICT');
  const ids = delta.profile.locations.map(location => location.address.id);
  if (new Set(ids).size !== ids.length || (delta.profile.primaryAddressId !== null && !ids.includes(delta.profile.primaryAddressId))) throw new Error('DELTA_LOCATION_IDENTITY_CONFLICT');
  const otherIds = new Set(Object.values(state.accounts).filter(other => other.accountId !== delta.accountId).flatMap(other => other.profile?.locations.map(location => location.address.id) || []));
  if (ids.some(id => otherIds.has(id))) throw new Error('DELTA_CROSS_OWNER_LOCATION');
  const p = delta.profile.preferences;
  if (delta.profile.legacyNotificationPolicySourceHash !== account.profile.legacyNotificationPolicySourceHash) throw new Error('DELTA_POLICY_ORIGIN_CONFLICT');
  if (account.profile.preferences.notificationPolicy && !p.notificationPolicy) throw new Error('DELTA_POLICY_LOSS');
  if (p.notificationPolicy !== undefined) parseNotificationPolicy(p.notificationPolicy);
  if (![p.optedIn, p.paused, p.reminders, p.quietHours.enabled, p.morningBriefing.enabled].every(value => typeof value === 'boolean') ||
      !Number.isInteger(p.remindBeforeMinutes) || p.remindBeforeMinutes < 0 || p.remindBeforeMinutes > 1440 ||
      !Number.isInteger(p.minimumOutageMinutes) || p.minimumOutageMinutes < 0 || p.minimumOutageMinutes > 86400 ||
      p.quietHours.timezone !== 'Europe/Kyiv' || ![p.quietHours.start, p.quietHours.end, p.morningBriefing.time].every(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('INVALID_PROFILE_DELTA');
  if (p.quietHours.enabled && p.quietHours.start === p.quietHours.end) throw new Error('INVALID_PROFILE_DELTA');
  for (const location of delta.profile.locations) {
    if (location.binding.addressId !== location.address.id || typeof location.notifications !== 'boolean' || typeof location.paused !== 'boolean') throw new Error('DELTA_LOCATION_IDENTITY_CONFLICT');
    const old = account.profile.locations.find(item => item.address.id === location.address.id);
    if (old?.notificationPolicy && !location.notificationPolicy) throw new Error('DELTA_POLICY_LOSS');
    if (location.notificationPolicy !== undefined) parseLocationNotificationPolicy(location.notificationPolicy);
    if (old ? migrationHash(old.binding) !== migrationHash(location.binding) : location.binding.status !== 'needs_confirmation') throw new Error('DELTA_REQUIRES_TRUSTED_BINDING_ADAPTER');
  }
  account.profile = syncLegacyPolicyChanges(account.profile, delta.profile); account.revision++;
  Object.defineProperty(state.appliedDeltas, delta.id, { value: digest, enumerable: true, writable: true, configurable: true });
  return { state, replayed: false };
}
export function prepareMigrationRollback(store: MigrationStore, receipt: MigrationReceipt, preservePostSnapshotChanges = false): RollbackResult {
  if (migrationHash(receipt.before) !== receipt.beforeHash || migrationHash(receipt.after) !== receipt.afterHash) throw new Error('ROLLBACK_MANIFEST_TAMPERED');
  const seal = (body: Omit<RollbackResult, 'packageHash'>): RollbackResult => ({ ...body, packageHash: migrationHash(body) });
  if (migrationHash(store) === receipt.afterHash) return seal({ state: clone(receipt.before), postSnapshotChanges: [], deltaLedger: {}, postSnapshotImports: [], requiresReplay: false, status: 'restored_exact' });
  if (!preservePostSnapshotChanges) throw new Error('ROLLBACK_HAS_POST_SNAPSHOT_WRITES');
  const ids = new Set([...Object.keys(receipt.after.accounts), ...Object.keys(store.accounts)]);
  const changes = [...ids].sort().filter(id => migrationHash(receipt.after.accounts[id] ?? null) !== migrationHash(store.accounts[id] ?? null)).map(accountId => ({ accountId, account: clone(store.accounts[accountId] ?? null) }));
  const importKeys = new Set([...Object.keys(receipt.after.importedSnapshots), ...Object.keys(store.importedSnapshots)]);
  const imports = [...importKeys].sort().filter(key => receipt.after.importedSnapshots[key] !== store.importedSnapshots[key] || migrationHash(receipt.after.snapshotArchives[key] ?? null) !== migrationHash(store.snapshotArchives[key] ?? null))
    .map(key => ({ key, digest: store.importedSnapshots[key] ?? null, archive: clone(store.snapshotArchives[key] ?? null) }));
  if (!changes.length && !imports.length) throw new Error('ROLLBACK_UNKNOWN_STORE_DRIFT');
  return seal({ state: clone(receipt.before), postSnapshotChanges: changes, deltaLedger: clone(store.appliedDeltas), postSnapshotImports: imports, requiresReplay: true, status: 'prepared_with_preserved_delta' });
}
/** Replays preserved target DTO changes only onto the exact prepared baseline. No SQL conversion. */
export function replayRollbackChanges(state: MigrationStore, rollback: RollbackResult): MigrationStore {
  const { packageHash, ...body } = rollback;
  if (migrationHash(body) !== packageHash) throw new Error('ROLLBACK_PACKAGE_TAMPERED');
  if (migrationHash(state) !== migrationHash(rollback.state)) throw new Error('ROLLBACK_REPLAY_BASE_DRIFT');
  const result = clone(state);
  for (const change of rollback.postSnapshotChanges) {
    if (change.account) Object.defineProperty(result.accounts, change.accountId, { value: clone(change.account), enumerable: true, writable: true, configurable: true });
    else delete result.accounts[change.accountId];
  }
  for (const [id, hash] of Object.entries(rollback.deltaLedger)) {
    if (Object.hasOwn(result.appliedDeltas, id) && result.appliedDeltas[id] !== hash) throw new Error('ROLLBACK_DELTA_ID_CONFLICT');
    Object.defineProperty(result.appliedDeltas, id, { value: hash, enumerable: true, writable: true, configurable: true });
  }
  for (const item of rollback.postSnapshotImports) {
    if (item.digest === null || item.archive === null) {
      if (item.digest !== null || item.archive !== null) throw new Error('ROLLBACK_IMPORT_ARCHIVE_MISMATCH');
      delete result.importedSnapshots[item.key]; delete result.snapshotArchives[item.key];
    } else {
      validateRows(item.archive);
      if (migrationHash(item.archive) !== item.digest) throw new Error('ROLLBACK_IMPORT_ARCHIVE_MISMATCH');
      Object.defineProperty(result.importedSnapshots, item.key, { value: item.digest, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(result.snapshotArchives, item.key, { value: clone(item.archive), enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}
