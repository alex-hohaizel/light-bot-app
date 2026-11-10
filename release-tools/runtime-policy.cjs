"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// app/server/runtime-policy.ts
var runtime_policy_exports = {};
__export(runtime_policy_exports, {
  RuntimePolicyError: () => RuntimePolicyError,
  productionRuntimePolicy: () => productionRuntimePolicy
});
module.exports = __toCommonJS(runtime_policy_exports);

// app/server/production/product-identity.ts
var PRODUCT_TELEGRAM_IDENTITY = Object.freeze({ botId: "8577497098", username: "PowerUkraineBot" });

// app/server/runtime-policy.ts
var RuntimePolicyError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "RuntimePolicyError";
    this.code = code;
  }
};
function rejected(code) {
  throw new RuntimePolicyError(code);
}
function explicitSwitch(env, name) {
  const value = env[name];
  if (value === void 0 || value === "" || value === "disabled") return false;
  if (value === "enabled") return true;
  return rejected("LBA_RUNTIME_INVALID_" + name);
}
var testCredential = (value) => /LOCAL[-_]TEST|LOCAL[-_]SYNTHETIC|SYNTHETIC[-_]ONLY|LBA_LOCAL|NOT[-_]A[-_]PRODUCTION|CHANGEME|REPLACE[-_]ME/i.test(value);
function credential(env, name, minimum) {
  const value = env[name];
  if (!value || value.trim() !== value || value.length < minimum || /[\u0000-\u0020]/.test(value)) return rejected("LBA_RUNTIME_REQUIRED_" + name);
  if (testCredential(value))
    return rejected("LBA_RUNTIME_TEST_CREDENTIAL_" + name);
  return value;
}
function productionRuntimePolicy(env = process.env) {
  if (env.NODE_ENV !== "production" || env.LBA_RUNTIME_MODE && env.LBA_RUNTIME_MODE !== "production")
    return rejected("LBA_RUNTIME_PRODUCTION_MODE_REQUIRED");
  if (env.LBA_ISOLATED && env.LBA_ISOLATED !== "0" || env.LBA_DATA_MODE && env.LBA_DATA_MODE !== "production" || env.LBA_DB_DISPOSABLE && env.LBA_DB_DISPOSABLE !== "0") return rejected("LBA_RUNTIME_SYNTHETIC_MODE_REJECTED");
  if (env.LBA_WEBHOOK_ACTION && env.LBA_WEBHOOK_ACTION !== "preserve" || env.LBA_DROP_PENDING_UPDATES && env.LBA_DROP_PENDING_UPDATES !== "disabled") return rejected("LBA_RUNTIME_WEBHOOK_MUTATION_REJECTED");
  if (env.LBA_API_BODY_LOGS && env.LBA_API_BODY_LOGS !== "disabled" || env.LBA_RANDOM_SEED && env.LBA_RANDOM_SEED !== "disabled" || env.LBA_BOT_METADATA_ON_START && env.LBA_BOT_METADATA_ON_START !== "disabled") return rejected("LBA_RUNTIME_UNSAFE_BOOT_EFFECT_REJECTED");
  const database = credential(env, "DATABASE_URL", 1);
  let parsed;
  try {
    parsed = new URL(database);
  } catch {
    return rejected("LBA_RUNTIME_DATABASE_URL_INVALID");
  }
  let databaseIdentity, databasePassword;
  try {
    databaseIdentity = decodeURIComponent(parsed.pathname + ":" + parsed.username);
    databasePassword = decodeURIComponent(parsed.password);
  } catch {
    return rejected("LBA_RUNTIME_DATABASE_URL_INVALID");
  }
  if (testCredential(databasePassword)) return rejected("LBA_RUNTIME_TEST_CREDENTIAL_DATABASE_URL");
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/" || /lba[_-]synthetic|lba[_-]local/i.test(databaseIdentity))
    return rejected("LBA_RUNTIME_DATABASE_URL_INVALID");
  credential(env, "SESSION_SECRET", 32);
  credential(env, "JWT_SECRET", 32);
  const productProfileMode = env.LBA_PRODUCT_PROFILE_MODE || "disabled";
  if (!["disabled", "read_only", "active"].includes(productProfileMode)) return rejected("LBA_RUNTIME_PRODUCT_WRITER_NOT_READY");
  const telegramAuthReplayEnabled = explicitSwitch(env, "LBA_AUTH_REPLAY_GUARD");
  if (telegramAuthReplayEnabled && credential(env, "TELEGRAM_BOT_TOKEN", 20).split(":")[0] !== PRODUCT_TELEGRAM_IDENTITY.botId)
    return rejected("LBA_RUNTIME_TELEGRAM_IDENTITY_MISMATCH");
  const telegramDeliveryEnabled = explicitSwitch(env, "LBA_TELEGRAM_DELIVERY");
  const telegramUpdatesEnabled = explicitSwitch(env, "LBA_TELEGRAM_UPDATES");
  let canonicalControlEpoch = null;
  if (env.LBA_CANONICAL_CONTROL_EPOCH !== void 0) {
    const value = env.LBA_CANONICAL_CONTROL_EPOCH;
    if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) return rejected("LBA_RUNTIME_CONTROL_EPOCH_INVALID");
    canonicalControlEpoch = Number(value);
  }
  if (telegramUpdatesEnabled && canonicalControlEpoch === null) return rejected("LBA_RUNTIME_CONTROL_EPOCH_REQUIRED");
  const notificationSchedulerEnabled = explicitSwitch(env, "LBA_NOTIFICATION_SCHEDULER");
  const sourceIngestionEnabled = explicitSwitch(env, "LBA_SOURCE_INGESTION");
  const operatorAddressLookupEnabled = explicitSwitch(env, "LBA_OPERATOR_ADDRESS_LOOKUP");
  if (operatorAddressLookupEnabled && !sourceIngestionEnabled) return rejected("LBA_RUNTIME_OPERATOR_ADDRESS_LOOKUP_REQUIRES_SOURCE");
  const odesaPlanApiEnabled = explicitSwitch(env, "LBA_ODESA_PLAN_API");
  if (odesaPlanApiEnabled && !sourceIngestionEnabled) return rejected("LBA_RUNTIME_ODESA_PLAN_API_REQUIRES_SOURCE");
  const accountLinksEnabled = explicitSwitch(env, "LBA_ACCOUNT_LINKS");
  const reconcileSubscribersOnStart = explicitSwitch(env, "LBA_RECONCILE_SUBSCRIBERS_ON_START");
  const migrateSubscribersOnStart = explicitSwitch(env, "LBA_MIGRATE_SUBSCRIBERS_ON_START");
  const initializeSubscriberHashesOnStart = explicitSwitch(env, "LBA_INITIALIZE_SUBSCRIBER_HASHES_ON_START");
  if (productProfileMode === "active" && (!telegramAuthReplayEnabled || canonicalControlEpoch === null)) return rejected("LBA_RUNTIME_CANONICAL_PROFILE_PREREQUISITES");
  if ((telegramUpdatesEnabled || telegramDeliveryEnabled || sourceIngestionEnabled || accountLinksEnabled) && productProfileMode !== "active") return rejected("LBA_RUNTIME_CANONICAL_PROFILE_REQUIRED");
  if (productProfileMode === "active" && (reconcileSubscribersOnStart || migrateSubscribersOnStart || initializeSubscriberHashesOnStart)) return rejected("LBA_RUNTIME_LEGACY_WRITER_FORBIDDEN");
  if ((telegramUpdatesEnabled || notificationSchedulerEnabled) && !telegramDeliveryEnabled)
    return rejected("LBA_RUNTIME_TELEGRAM_DELIVERY_REQUIRED");
  if (telegramDeliveryEnabled) {
    if (credential(env, "TELEGRAM_BOT_TOKEN", 20).split(":")[0] !== PRODUCT_TELEGRAM_IDENTITY.botId)
      return rejected("LBA_RUNTIME_TELEGRAM_IDENTITY_MISMATCH");
    const secret = credential(env, "TELEGRAM_WEBHOOK_SECRET", 1);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) return rejected("LBA_RUNTIME_WEBHOOK_SECRET_INVALID");
  } else {
    for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]) if (env[name]) credential(env, name, 1);
  }
  return Object.freeze({
    schemaVersion: "lba-production-runtime/1",
    mode: "production",
    preserveWebhook: true,
    autoSetWebhook: false,
    dropPendingUpdates: false,
    telegramDeliveryEnabled,
    telegramUpdatesEnabled,
    notificationSchedulerEnabled,
    loadSubscribersOnStart: true,
    reconcileSubscribersOnStart,
    migrateSubscribersOnStart,
    initializeSubscriberHashesOnStart,
    botMetadataOnStart: false,
    seedDataOnStart: false,
    apiBodyLogging: false,
    telegramAuthReplayEnabled,
    canonicalControlEpoch,
    productProfileMode,
    sourceIngestionEnabled,
    operatorAddressLookupEnabled,
    odesaPlanApiEnabled,
    accountLinksEnabled
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RuntimePolicyError,
  productionRuntimePolicy
});
