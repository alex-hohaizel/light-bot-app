import {productionRuntimePolicy} from './runtime-policy';

// This boundary runs before importing any DB, auth, legacy bot, routes or server.
// Invalid configuration cannot create a pool, generate fallback JWT credentials,
// run a migration or touch the configured Telegram identity.
productionRuntimePolicy();
void import('./index').catch(() => {
  console.error('LBA_PRODUCTION_START_FAILED');
  process.exitCode = 1;
});
