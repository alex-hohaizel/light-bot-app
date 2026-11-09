import test from 'node:test';
import assert from 'node:assert/strict';
import { productionRuntimePolicy, RuntimePolicyError, type RuntimeEnvironment } from '../../server/runtime-policy.ts';
const base: RuntimeEnvironment = {
  NODE_ENV: 'production', DATABASE_URL: 'postgresql://fixture_account:fixture_password@db.example.invalid/power_fixture',
  SESSION_SECRET: 'session_fixture_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  JWT_SECRET: 'jwt_fixture_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
};
const telegram = {
  TELEGRAM_BOT_TOKEN: '8577497098:fixture_provider_token_xxxxxxxxxxxxx',
  TELEGRAM_WEBHOOK_SECRET: 'existing_provider_secret',
};
const canonical={...telegram,LBA_PRODUCT_PROFILE_MODE:'active',LBA_AUTH_REPLAY_GUARD:'enabled',LBA_CANONICAL_CONTROL_EPOCH:'7'};
function refuses(env: RuntimeEnvironment, code: string) {
  assert.throws(() => productionRuntimePolicy(env), error => error instanceof RuntimePolicyError && error.code === code);
}

test('production plan is immutable, does not expose credentials, and preserves every webhook/seed/log default', () => {
  const input = { ...base, ...telegram }, before = structuredClone(input);
  const policy = productionRuntimePolicy(input);
  assert.deepEqual(input, before); assert(Object.isFrozen(policy));
  assert.equal(policy.mode, 'production'); assert.equal(policy.preserveWebhook, true);
  for (const field of ['autoSetWebhook', 'dropPendingUpdates', 'telegramDeliveryEnabled', 'telegramUpdatesEnabled',
    'notificationSchedulerEnabled', 'reconcileSubscribersOnStart', 'migrateSubscribersOnStart',
    'initializeSubscriberHashesOnStart', 'botMetadataOnStart', 'seedDataOnStart', 'apiBodyLogging'] as const) assert.equal(policy[field], false, field);
  const serialized = JSON.stringify(policy);
  for (const secret of [base.DATABASE_URL!, base.SESSION_SECRET!, base.JWT_SECRET!, telegram.TELEGRAM_BOT_TOKEN, telegram.TELEGRAM_WEBHOOK_SECRET])
    assert(!serialized.includes(secret));
  assert.throws(() => { (policy as unknown as Record<string, unknown>).autoSetWebhook = true; }, TypeError);
});
test('canonical profile mode requires explicit replay guard and reviewed epoch; old writers stay forbidden',()=>{
  assert.equal(productionRuntimePolicy(base).productProfileMode,'disabled');
  assert.equal(productionRuntimePolicy({...base,LBA_PRODUCT_PROFILE_MODE:'read_only'}).productProfileMode,'read_only');
  for(const value of ['enabled','true','review'])
    refuses({...base,LBA_PRODUCT_PROFILE_MODE:value},'LBA_RUNTIME_PRODUCT_WRITER_NOT_READY');
  refuses({...base,LBA_PRODUCT_PROFILE_MODE:'active'},'LBA_RUNTIME_CANONICAL_PROFILE_PREREQUISITES');
  assert.equal(productionRuntimePolicy({...base,...canonical}).productProfileMode,'active');
  for(const flag of ['LBA_RECONCILE_SUBSCRIBERS_ON_START','LBA_MIGRATE_SUBSCRIBERS_ON_START','LBA_INITIALIZE_SUBSCRIBER_HASHES_ON_START'])
    refuses({...base,...canonical,[flag]:'enabled'},'LBA_RUNTIME_LEGACY_WRITER_FORBIDDEN');
  refuses({...base,...telegram,LBA_SOURCE_INGESTION:'enabled'},'LBA_RUNTIME_CANONICAL_PROFILE_REQUIRED');
});
test('production identity rejects local/synthetic/ambiguous modes and databases without logging their values', () => {
  for (const NODE_ENV of [undefined, 'test', 'development']) refuses({ ...base, NODE_ENV }, 'LBA_RUNTIME_PRODUCTION_MODE_REQUIRED');
  refuses({ ...base, LBA_RUNTIME_MODE: 'isolated' }, 'LBA_RUNTIME_PRODUCTION_MODE_REQUIRED');
  for (const fields of [{ LBA_ISOLATED: '1' }, { LBA_ISOLATED: 'true' }, { LBA_DATA_MODE: 'synthetic' }, { LBA_DB_DISPOSABLE: '1' }])
    refuses({ ...base, ...fields }, 'LBA_RUNTIME_SYNTHETIC_MODE_REJECTED');
  for (const DATABASE_URL of ['https://db.example.invalid/data', 'postgres://user@host/', 'postgres://user@host/lba_synthetic',
    'postgres://user@host/db%xx'])
    refuses({ ...base, DATABASE_URL }, 'LBA_RUNTIME_DATABASE_URL_INVALID');
  refuses({ ...base, DATABASE_URL: 'postgres://lba_local@127.0.0.1:55432/lba_synthetic' }, 'LBA_RUNTIME_TEST_CREDENTIAL_DATABASE_URL');
  refuses({ ...base, DATABASE_URL: 'postgres://user:LBA%5FLOCAL%5FTEST@host/database' }, 'LBA_RUNTIME_TEST_CREDENTIAL_DATABASE_URL');
});
test('stable auth credentials are mandatory; sanitized local/test literals cannot become production secrets', () => {
  for (const name of ['SESSION_SECRET', 'JWT_SECRET']) {
    refuses({ ...base, [name]: undefined }, 'LBA_RUNTIME_REQUIRED_' + name);
    refuses({ ...base, [name]: 'short' }, 'LBA_RUNTIME_REQUIRED_' + name);
    refuses({ ...base, [name]: 'lba-local-synthetic-only-session-secret' }, 'LBA_RUNTIME_TEST_CREDENTIAL_' + name);
    refuses({ ...base, [name]: 'LBA_LOCAL_TEST_ONLY_WEBHOOK_SECRET'.repeat(2) }, 'LBA_RUNTIME_TEST_CREDENTIAL_' + name);
  }
  refuses({ ...base, ...telegram, TELEGRAM_WEBHOOK_SECRET: 'LBA_LOCAL_TEST_ONLY_WEBHOOK_SECRET' }, 'LBA_RUNTIME_TEST_CREDENTIAL_TELEGRAM_WEBHOOK_SECRET');
  refuses({ ...base, ...telegram, TELEGRAM_BOT_TOKEN: 'LOCAL-TEST-NOT-A-PRODUCTION-TOKEN' }, 'LBA_RUNTIME_TEST_CREDENTIAL_TELEGRAM_BOT_TOKEN');
});
test('scheduler and updates require explicit delivery and actual credential configuration', () => {
  for (const flag of ['LBA_NOTIFICATION_SCHEDULER', 'LBA_TELEGRAM_UPDATES'])
    refuses({ ...base, ...canonical, [flag]: 'enabled' }, 'LBA_RUNTIME_TELEGRAM_DELIVERY_REQUIRED');
  refuses({ ...base,LBA_PRODUCT_PROFILE_MODE:'active',LBA_AUTH_REPLAY_GUARD:'enabled',LBA_CANONICAL_CONTROL_EPOCH:'7', LBA_TELEGRAM_DELIVERY: 'enabled' }, 'LBA_RUNTIME_REQUIRED_TELEGRAM_BOT_TOKEN');
  refuses({ ...base, ...canonical, TELEGRAM_WEBHOOK_SECRET:undefined, LBA_TELEGRAM_DELIVERY: 'enabled' }, 'LBA_RUNTIME_REQUIRED_TELEGRAM_WEBHOOK_SECRET');
  const policy = productionRuntimePolicy({ ...base, ...canonical, LBA_TELEGRAM_DELIVERY: 'enabled',
    LBA_CANONICAL_CONTROL_EPOCH:'7', LBA_TELEGRAM_UPDATES: 'enabled', LBA_NOTIFICATION_SCHEDULER: 'enabled' });
  assert(policy.telegramDeliveryEnabled && policy.telegramUpdatesEnabled && policy.notificationSchedulerEnabled);
  assert.equal(policy.autoSetWebhook, false); assert.equal(policy.dropPendingUpdates, false);
});
test('durable ingress requires a reviewed positive canonical epoch, never a guessed control row',()=>{
  refuses({...base,...telegram,LBA_TELEGRAM_DELIVERY:'enabled',LBA_TELEGRAM_UPDATES:'enabled'},'LBA_RUNTIME_CONTROL_EPOCH_REQUIRED');
  for(const value of ['','0','-1','1.2','01','9007199254740992'])refuses({...base,LBA_CANONICAL_CONTROL_EPOCH:value},'LBA_RUNTIME_CONTROL_EPOCH_INVALID');
  assert.equal(productionRuntimePolicy(base).canonicalControlEpoch,null);
});
test('writer switches are separate, exact and disabled until deliberately configured', () => {
  for (const flag of ['LBA_RECONCILE_SUBSCRIBERS_ON_START', 'LBA_MIGRATE_SUBSCRIBERS_ON_START', 'LBA_INITIALIZE_SUBSCRIBER_HASHES_ON_START']) {
    const policy = productionRuntimePolicy({ ...base, [flag]: 'enabled' });
    assert.equal(Number(policy.reconcileSubscribersOnStart) + Number(policy.migrateSubscribersOnStart) + Number(policy.initializeSubscriberHashesOnStart), 1);
    refuses({ ...base, [flag]: 'true' }, 'LBA_RUNTIME_INVALID_' + flag);
    refuses({ ...base, [flag]: '1' }, 'LBA_RUNTIME_INVALID_' + flag);
  }
});
test('Telegram proof login and outgoing runtime cannot silently switch to another configured bot',()=>{
  const wrong={...base,...telegram,TELEGRAM_BOT_TOKEN:'123456789:fixture_other_bot_token_xxxxxxxxx'};
  refuses({...wrong,LBA_AUTH_REPLAY_GUARD:'enabled'},'LBA_RUNTIME_TELEGRAM_IDENTITY_MISMATCH');
  refuses({...base,...canonical,TELEGRAM_BOT_TOKEN:wrong.TELEGRAM_BOT_TOKEN,LBA_TELEGRAM_DELIVERY:'enabled'},'LBA_RUNTIME_TELEGRAM_IDENTITY_MISMATCH');
  assert.equal(productionRuntimePolicy({...base,...telegram,LBA_AUTH_REPLAY_GUARD:'enabled'}).telegramAuthReplayEnabled,true);
  refuses({...base,...telegram,LBA_AUTH_REPLAY_GUARD:'true'},'LBA_RUNTIME_INVALID_LBA_AUTH_REPLAY_GUARD');
});
test('unsafe boot effects are denied even if supplied alongside otherwise valid production configuration', () => {
  refuses({ ...base, LBA_WEBHOOK_ACTION: 'register' }, 'LBA_RUNTIME_WEBHOOK_MUTATION_REJECTED');
  refuses({ ...base, LBA_DROP_PENDING_UPDATES: 'enabled' }, 'LBA_RUNTIME_WEBHOOK_MUTATION_REJECTED');
  for (const flag of ['LBA_API_BODY_LOGS', 'LBA_RANDOM_SEED', 'LBA_BOT_METADATA_ON_START'])
    refuses({ ...base, [flag]: 'enabled' }, 'LBA_RUNTIME_UNSAFE_BOOT_EFFECT_REJECTED');
});
test('provider secret format preserves an existing permitted value without implicit rotation', () => {
  for (const secret of ['a', 'A_z-0123456789', 'x'.repeat(256)]) {
    const policy = productionRuntimePolicy({ ...base, ...canonical, TELEGRAM_WEBHOOK_SECRET: secret, LBA_TELEGRAM_DELIVERY: 'enabled' });
    assert(policy.telegramDeliveryEnabled); assert.equal(policy.autoSetWebhook, false);
  }
  for (const secret of ['a.b', 'x'.repeat(257), 'тест'])
    refuses({ ...base, ...canonical, TELEGRAM_WEBHOOK_SECRET: secret, LBA_TELEGRAM_DELIVERY: 'enabled' }, 'LBA_RUNTIME_WEBHOOK_SECRET_INVALID');
});
