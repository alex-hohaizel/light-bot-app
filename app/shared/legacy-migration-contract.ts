import type { BotProfile } from './bot/types.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type LegacyRow = { [key: string]: JsonValue };
export const LEGACY_TABLES = ['users', 'userSettings', 'userLocations', 'telegramSubscribers', 'linkedAccounts', 'compareShares'] as const;
export type LegacyTable = typeof LEGACY_TABLES[number];
/** Only synthetic DTOs. Session blobs, credentials and real exports are outside this adapter. */
export interface LegacySnapshot {
  kind: 'synthetic_legacy_snapshot';
  snapshotId: string;
  sourceRevision: string;
  tables: Record<LegacyTable, LegacyRow[]>;
}
export interface MigrationIssue { code: string; sourceRefs: string[]; nextAction: string }
export interface RowDisposition {
  sourceRef: string; table: LegacyTable; oldPk: JsonValue; sourceHash: string;
  accountId: string | null; targetId: string | null;
  classification: 'needs_confirmation' | 'preserved_history' | 'unresolved' | 'conflict';
  reasons: string[];
}
export interface MigratedAccount {
  accountId: string;
  revision: number;
  sourceHash: string;
  classification: 'needs_confirmation' | 'conflict';
  profile: BotProfile | null;
  /** Identity references survive; this field cannot authenticate a person. */
  accessClaims: { legacyLinkId: string; provider: string; subject: string; verification: 'legacy_claim_unverified' }[];
  channels: { chatId: string; botId: null; allowedByLegacy: boolean; reachability: 'unknown'; verification: 'legacy_claim_unverified' }[];
  locationCompatibility: { addressId: string; oldLocationId: JsonValue; shareId: string | null; pushEnabled: boolean; telegramEnabled: boolean; beforeOffMinutes: number; beforeOnMinutes: number }[];
  /** Bounded synthetic source rows retain distinctions unsupported by the present UI contract. */
  archive: Partial<Record<LegacyTable, LegacyRow[]>>;
  issues: MigrationIssue[];
}
export interface MigrationPlan {
  version: 'lba-legacy-migration/1'; snapshotId: string; snapshotHash: string; planHash: string;
  sourceRevision: string; syntheticOnly: true;
  accounts: MigratedAccount[]; rows: RowDisposition[];
  /** Safe synthetic source bytes/DTOs retain orphan and ownerless rows as well. */
  sourceSnapshot: LegacySnapshot;
  sharedHistory: LegacyRow[];
  counts: { sourceRows: number; dispositions: number; accounts: number; conflicts: number; unresolved: number };
}
export interface MigrationStore {
  version: 'lba-migration-store/1';
  accounts: Record<string, MigratedAccount>;
  importedSnapshots: Record<string, string>;
  snapshotArchives: Record<string, LegacySnapshot>;
  appliedDeltas: Record<string, string>;
}
export interface MigrationReceipt {
  snapshotHash: string; beforeHash: string; afterHash: string;
  before: MigrationStore; after: MigrationStore;
  importedAccountIds: string[]; replayed: boolean;
}
export interface ProfileDelta {
  id: string; accountId: string; expectedRevision: number;
  profile: BotProfile;
}
export interface RollbackResult {
  state: MigrationStore;
  postSnapshotChanges: { accountId: string; account: MigratedAccount | null }[];
  deltaLedger: Record<string, string>;
  postSnapshotImports: { key: string; digest: string | null; archive: LegacySnapshot | null }[];
  packageHash: string;
  requiresReplay: boolean;
  status: 'restored_exact' | 'prepared_with_preserved_delta';
}
