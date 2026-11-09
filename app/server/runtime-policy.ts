import {PRODUCT_TELEGRAM_IDENTITY} from './production/product-identity.ts';
/**
 * Pure startup plan. Reading this module never opens a DB, starts a scheduler,
 * changes a webhook, generates credentials or sends Telegram messages.
 * A policy is a validated configuration, not an authorization grant.
 */
export interface ProductionRuntimePolicy {
  readonly schemaVersion: 'lba-production-runtime/1';
  readonly mode: 'production';
  readonly preserveWebhook: true;
  readonly autoSetWebhook: false;
  readonly dropPendingUpdates: false;
  readonly telegramDeliveryEnabled: boolean;
  readonly telegramUpdatesEnabled: boolean;
  readonly notificationSchedulerEnabled: boolean;
  readonly loadSubscribersOnStart: boolean;
  readonly reconcileSubscribersOnStart: boolean;
  readonly migrateSubscribersOnStart: boolean;
  readonly initializeSubscriberHashesOnStart: boolean;
  readonly botMetadataOnStart: false;
  readonly seedDataOnStart: false;
  readonly apiBodyLogging: false;
  readonly telegramAuthReplayEnabled: boolean;
  readonly canonicalControlEpoch: number|null;
  readonly productProfileMode: 'disabled'|'read_only'|'active';
  readonly sourceIngestionEnabled:boolean;
  readonly accountLinksEnabled:boolean;
}
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export class RuntimePolicyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'RuntimePolicyError'; this.code = code; }
}
function rejected(code: string): never { throw new RuntimePolicyError(code); }
function explicitSwitch(env: RuntimeEnvironment, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === '' || value === 'disabled') return false;
  if (value === 'enabled') return true;
  return rejected('LBA_RUNTIME_INVALID_' + name);
}
const testCredential = (value: string) => /LOCAL[-_]TEST|LOCAL[-_]SYNTHETIC|SYNTHETIC[-_]ONLY|LBA_LOCAL|NOT[-_]A[-_]PRODUCTION|CHANGEME|REPLACE[-_]ME/i.test(value);
function credential(env: RuntimeEnvironment, name: string, minimum: number): string {
  const value = env[name];
  if (!value || value.trim() !== value || value.length < minimum || /[\u0000-\u0020]/.test(value)) return rejected('LBA_RUNTIME_REQUIRED_' + name);
  if (testCredential(value))
    return rejected('LBA_RUNTIME_TEST_CREDENTIAL_' + name);
  return value;
}

/** Explicit production mode with effects disabled until their individual configuration is reviewed. */
export function productionRuntimePolicy(env: RuntimeEnvironment = process.env): ProductionRuntimePolicy {
  if (env.NODE_ENV !== 'production' || (env.LBA_RUNTIME_MODE && env.LBA_RUNTIME_MODE !== 'production'))
    return rejected('LBA_RUNTIME_PRODUCTION_MODE_REQUIRED');
  if ((env.LBA_ISOLATED && env.LBA_ISOLATED !== '0') || (env.LBA_DATA_MODE && env.LBA_DATA_MODE !== 'production') ||
      (env.LBA_DB_DISPOSABLE && env.LBA_DB_DISPOSABLE !== '0')) return rejected('LBA_RUNTIME_SYNTHETIC_MODE_REJECTED');
  if ((env.LBA_WEBHOOK_ACTION && env.LBA_WEBHOOK_ACTION !== 'preserve') ||
      (env.LBA_DROP_PENDING_UPDATES && env.LBA_DROP_PENDING_UPDATES !== 'disabled')) return rejected('LBA_RUNTIME_WEBHOOK_MUTATION_REJECTED');
  if ((env.LBA_API_BODY_LOGS && env.LBA_API_BODY_LOGS !== 'disabled') ||
      (env.LBA_RANDOM_SEED && env.LBA_RANDOM_SEED !== 'disabled') ||
      (env.LBA_BOT_METADATA_ON_START && env.LBA_BOT_METADATA_ON_START !== 'disabled')) return rejected('LBA_RUNTIME_UNSAFE_BOOT_EFFECT_REJECTED');

  // Only presence/shape is checked here. The caller must verify the current target, ownership and actual binding separately.
  const database = credential(env, 'DATABASE_URL', 1);
  let parsed: URL;
  try { parsed = new URL(database); } catch { return rejected('LBA_RUNTIME_DATABASE_URL_INVALID'); }
  let databaseIdentity: string, databasePassword: string;
  try { databaseIdentity = decodeURIComponent(parsed.pathname + ':' + parsed.username); databasePassword = decodeURIComponent(parsed.password); }
  catch { return rejected('LBA_RUNTIME_DATABASE_URL_INVALID'); }
  if (testCredential(databasePassword)) return rejected('LBA_RUNTIME_TEST_CREDENTIAL_DATABASE_URL');
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/' ||
      /lba[_-]synthetic|lba[_-]local/i.test(databaseIdentity))
    return rejected('LBA_RUNTIME_DATABASE_URL_INVALID');
  credential(env, 'SESSION_SECRET', 32);
  credential(env, 'JWT_SECRET', 32);
  const productProfileMode=env.LBA_PRODUCT_PROFILE_MODE||'disabled';
  if(!['disabled','read_only','active'].includes(productProfileMode))return rejected('LBA_RUNTIME_PRODUCT_WRITER_NOT_READY');
  const telegramAuthReplayEnabled=explicitSwitch(env,'LBA_AUTH_REPLAY_GUARD');
  if(telegramAuthReplayEnabled && credential(env,'TELEGRAM_BOT_TOKEN',20).split(':')[0]!==PRODUCT_TELEGRAM_IDENTITY.botId)
    return rejected('LBA_RUNTIME_TELEGRAM_IDENTITY_MISMATCH');

  const telegramDeliveryEnabled = explicitSwitch(env, 'LBA_TELEGRAM_DELIVERY');
  const telegramUpdatesEnabled = explicitSwitch(env, 'LBA_TELEGRAM_UPDATES');
  let canonicalControlEpoch:number|null=null;
  if(env.LBA_CANONICAL_CONTROL_EPOCH!==undefined){
    const value=env.LBA_CANONICAL_CONTROL_EPOCH;
    if(!/^[1-9]\d{0,15}$/.test(value)||!Number.isSafeInteger(Number(value)))return rejected('LBA_RUNTIME_CONTROL_EPOCH_INVALID');
    canonicalControlEpoch=Number(value);
  }
  if(telegramUpdatesEnabled&&canonicalControlEpoch===null)return rejected('LBA_RUNTIME_CONTROL_EPOCH_REQUIRED');
  const notificationSchedulerEnabled = explicitSwitch(env, 'LBA_NOTIFICATION_SCHEDULER');
  const sourceIngestionEnabled=explicitSwitch(env,'LBA_SOURCE_INGESTION');
  const accountLinksEnabled=explicitSwitch(env,'LBA_ACCOUNT_LINKS');
  const reconcileSubscribersOnStart = explicitSwitch(env, 'LBA_RECONCILE_SUBSCRIBERS_ON_START');
  const migrateSubscribersOnStart = explicitSwitch(env, 'LBA_MIGRATE_SUBSCRIBERS_ON_START');
  const initializeSubscriberHashesOnStart = explicitSwitch(env, 'LBA_INITIALIZE_SUBSCRIBER_HASHES_ON_START');
  if(productProfileMode==='active'&&(!telegramAuthReplayEnabled||canonicalControlEpoch===null))return rejected('LBA_RUNTIME_CANONICAL_PROFILE_PREREQUISITES');
  if((telegramUpdatesEnabled||telegramDeliveryEnabled||sourceIngestionEnabled||accountLinksEnabled)&&productProfileMode!=='active')return rejected('LBA_RUNTIME_CANONICAL_PROFILE_REQUIRED');
  if(productProfileMode==='active'&&(reconcileSubscribersOnStart||migrateSubscribersOnStart||initializeSubscriberHashesOnStart))return rejected('LBA_RUNTIME_LEGACY_WRITER_FORBIDDEN');
  if ((telegramUpdatesEnabled || notificationSchedulerEnabled) && !telegramDeliveryEnabled)
    return rejected('LBA_RUNTIME_TELEGRAM_DELIVERY_REQUIRED');
  if (telegramDeliveryEnabled) {
    if(credential(env, 'TELEGRAM_BOT_TOKEN', 20).split(':')[0]!==PRODUCT_TELEGRAM_IDENTITY.botId)
      return rejected('LBA_RUNTIME_TELEGRAM_IDENTITY_MISMATCH');
    const secret = credential(env, 'TELEGRAM_WEBHOOK_SECRET', 1);
    // Keep an existing valid provider secret, rather than rotating it implicitly on startup.
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) return rejected('LBA_RUNTIME_WEBHOOK_SECRET_INVALID');
  } else {
    // A configured placeholder must fail even while outgoing delivery is paused.
    for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET']) if (env[name]) credential(env, name, 1);
  }

  return Object.freeze({
    schemaVersion: 'lba-production-runtime/1', mode: 'production',
    preserveWebhook: true, autoSetWebhook: false, dropPendingUpdates: false,
    telegramDeliveryEnabled, telegramUpdatesEnabled, notificationSchedulerEnabled,
    loadSubscribersOnStart: true,
    reconcileSubscribersOnStart, migrateSubscribersOnStart, initializeSubscriberHashesOnStart,
    botMetadataOnStart: false, seedDataOnStart: false, apiBodyLogging: false,
    telegramAuthReplayEnabled,
    canonicalControlEpoch,
    productProfileMode: productProfileMode as 'disabled'|'read_only'|'active',sourceIngestionEnabled,accountLinksEnabled,
  });
}
