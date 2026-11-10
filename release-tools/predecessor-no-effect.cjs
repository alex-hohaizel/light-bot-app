"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
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

// server/release/update-campaign.ts
function campaignInstant(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function campaignId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
}
function campaignHash(value) {
  return (0, import_node_crypto.createHash)("sha256").update(JSON.stringify(value)).digest("hex");
}
function campaignOperationId(releaseId, recipientRef) {
  if (!campaignId(releaseId) || !campaignId(recipientRef)) return campaignFail("INVALID_CAMPAIGN_ID");
  return campaignHash([UPDATE_CAMPAIGN_VERSION, releaseId, recipientRef]);
}
function campaignBinding(spec) {
  return { releaseId: spec.releaseId, deploymentId: spec.deploymentId, buildSha256: spec.buildSha256, botId: spec.botId, origin: spec.origin };
}
function prepareCampaignSpec(input, recipientRefs) {
  if (!plain(input) || !exactKeys(input, ["releaseId", "deploymentId", "buildSha256", "botId", "origin", "text", "appUrl", "createdAt", "expiresAt", "pilotRecipientRefs", "maxAttempts"]) || !campaignId(input.releaseId) || !campaignId(input.deploymentId) || !campaignId(input.botId) || !/^[a-f0-9]{64}$/.test(input.buildSha256) || !campaignInstant(input.createdAt) || !campaignInstant(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.createdAt) || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > 7 * 864e5 || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text) || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 5 || !Array.isArray(recipientRefs) || !recipientRefs.length || recipientRefs.length > 1e5 || recipientRefs.some((ref) => !campaignId(ref)) || new Set(recipientRefs).size !== recipientRefs.length || !Array.isArray(input.pilotRecipientRefs) || !input.pilotRecipientRefs.length || input.pilotRecipientRefs.length > 5 || input.pilotRecipientRefs.some((ref) => !recipientRefs.includes(ref)) || new Set(input.pilotRecipientRefs).size !== input.pilotRecipientRefs.length) return campaignFail("INVALID_CAMPAIGN_SPEC");
  try {
    const origin = new URL(input.origin), app = new URL(input.appUrl);
    if (origin.protocol !== "https:" || app.protocol !== "https:" || origin.username || origin.password || origin.origin !== input.origin || app.origin !== origin.origin || app.username || app.password) return campaignFail("INVALID_CAMPAIGN_ORIGIN");
  } catch {
    return campaignFail("INVALID_CAMPAIGN_ORIGIN");
  }
  return {
    version: UPDATE_CAMPAIGN_VERSION,
    ...campaignBinding(input),
    text: input.text,
    appUrl: input.appUrl,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    pilotRecipientRefs: [...input.pilotRecipientRefs].sort(),
    maxAttempts: input.maxAttempts,
    audienceDigest: campaignHash([...recipientRefs].sort())
  };
}
function campaignSpecHash(spec) {
  return campaignHash([
    spec.version,
    spec.releaseId,
    spec.deploymentId,
    spec.buildSha256,
    spec.botId,
    spec.origin,
    spec.text,
    spec.appUrl,
    spec.createdAt,
    spec.expiresAt,
    spec.pilotRecipientRefs,
    spec.maxAttempts,
    spec.audienceDigest
  ]);
}
function validDeploymentHealth(spec, health, now) {
  if (!plain(health) || !exactKeys(health, ["releaseId", "deploymentId", "buildSha256", "botId", "origin", "healthy", "observedAt"]) || health.healthy !== true || !campaignInstant(health.observedAt) || !campaignInstant(now)) return false;
  return ["releaseId", "deploymentId", "buildSha256", "botId", "origin"].every((key) => health[key] === spec[key]) && Date.parse(health.observedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(health.observedAt) <= 3e5;
}
function checkedCampaignOutcome(value) {
  if (!plain(value)) return campaignFail("INVALID_CAMPAIGN_OUTCOME");
  if (value.kind === "sent" && exactKeys(value, ["kind", "receipt"]) && typeof value.receipt === "string" && /^tg-msg-[1-9]\d{0,15}$/.test(value.receipt)) return { kind: "sent", receipt: value.receipt };
  if (value.kind === "rate_limited" && exactKeys(value, ["kind", "retryAfterSeconds"]) && Number.isSafeInteger(value.retryAfterSeconds) && Number(value.retryAfterSeconds) >= 1 && Number(value.retryAfterSeconds) <= 86400) return { kind: "rate_limited", retryAfterSeconds: Number(value.retryAfterSeconds) };
  if ((value.kind === "unknown" || value.kind === "not_sent") && exactKeys(value, value.kind === "unknown" ? ["kind", "reason"] : ["kind", "retryable", "reason"]) && typeof value.reason === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value.reason) && (value.kind === "unknown" || typeof value.retryable === "boolean"))
    return value.kind === "unknown" ? { kind: "unknown", reason: value.reason } : { kind: "not_sent", retryable: value.retryable, reason: value.reason };
  return campaignFail("INVALID_CAMPAIGN_OUTCOME");
}
var import_node_crypto, UPDATE_CAMPAIGN_VERSION, UPDATE_ANNOUNCEMENT_UA, CampaignError, campaignFail, plain, exactKeys;
var init_update_campaign = __esm({
  "server/release/update-campaign.ts"() {
    "use strict";
    import_node_crypto = require("node:crypto");
    UPDATE_CAMPAIGN_VERSION = "lba-update-campaign/1";
    UPDATE_ANNOUNCEMENT_UA = "\u041C\u0438 \u043E\u043D\u043E\u0432\u0438\u043B\u0438 \u0437\u0430\u0441\u0442\u043E\u0441\u0443\u043D\u043E\u043A \u0456 \u0431\u043E\u0442\u0430. \u0423 \u043D\u0430\u0439\u0431\u043B\u0438\u0436\u0447\u0456 \u0434\u043D\u0456 \u0437\u2019\u044F\u0432\u043B\u044F\u0442\u044C\u0441\u044F \u0449\u0435 \u043A\u0456\u043B\u044C\u043A\u0430 \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u044C \u0456 \u043F\u043E\u043A\u0440\u0430\u0449\u0435\u043D\u044C. \u041F\u043E\u043A\u0438 \u0442\u0440\u0438\u0432\u0430\u0454 \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F, \u043C\u043E\u0436\u043B\u0438\u0432\u0456 \u0442\u0438\u043C\u0447\u0430\u0441\u043E\u0432\u0456 \u0437\u0431\u043E\u0457 \u0432 \u0440\u043E\u0431\u043E\u0442\u0456 \u0433\u0440\u0430\u0444\u0456\u043A\u0456\u0432 \u0456 \u0441\u043F\u043E\u0432\u0456\u0449\u0435\u043D\u044C. \u042F\u043A\u0449\u043E \u043F\u043E\u043C\u0456\u0442\u0438\u0442\u0435 \u043D\u0435\u0442\u043E\u0447\u043D\u0456\u0441\u0442\u044C, \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0442\u0435 \u0456\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0456\u044E \u0432 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430 \u043C\u0435\u0440\u0435\u0436\u0456.";
    CampaignError = class extends Error {
    };
    campaignFail = (code) => {
      throw new CampaignError(code);
    };
    plain = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
    exactKeys = (v, keys) => Object.keys(v).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(v, key));
  }
});

// server/release/update-campaign-pg.ts
var update_campaign_pg_exports = {};
__export(update_campaign_pg_exports, {
  UPDATE_CAMPAIGN_SCHEMA_SQL: () => UPDATE_CAMPAIGN_SCHEMA_SQL,
  createPgUpdateCampaignRepository: () => createPgUpdateCampaignRepository,
  reconcileCampaignProvenUnissued: () => reconcileCampaignProvenUnissued
});
async function reconcileCampaignProvenUnissued(pool, request) {
  const b = request?.binding, hex2 = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (!pool || typeof pool.connect !== "function" || !b || !campaignId(b.releaseId) || !campaignId(b.deploymentId) || !campaignId(b.botId) || !hex2(b.buildSha256) || b.origin !== "https://power-ukraine.net" || !Number.isSafeInteger(request.controlEpoch) || request.controlEpoch < 1 || !Number.isInteger(request.audienceSize) || request.audienceSize < 1 || request.audienceSize > 1e5 || !hex2(request.predecessorSenderSha256) || !hex2(request.operatorCodeSha256)) return campaignFail("PROVEN_UNISSUED_OPTIONS");
  const acquire = request.acquireMs ?? 4e3;
  if (!Number.isInteger(acquire) || acquire < 1 || acquire > 1e4) return campaignFail("PROVEN_UNISSUED_LOCK_BUDGET");
  const client = await pool.connect(), locks = [];
  let begun = false, tainted = false;
  const check2 = (yes, code) => {
    if (!yes) campaignFail(code);
  };
  async function inspect() {
    const backend = (await client.query(`select pg_is_in_recovery() as recovery,current_setting('default_transaction_read_only') as default_ro,to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as observed_at`)).rows[0];
    check2(backend?.recovery === false && backend.default_ro === "off" && campaignInstant(backend.observed_at), "PROVEN_UNISSUED_NOT_PRIMARY");
    const control = (await client.query("select control_epoch,writer_mode from lba_production_control where id=true")).rows;
    check2(control.length === 1 && Number(control[0].control_epoch) === request.controlEpoch && control[0].writer_mode === "canonical", "PROVEN_UNISSUED_CONTROL");
    const rows = (await client.query("select * from lba_release_campaigns where release_id=$1", [b.releaseId])).rows;
    check2(rows.length === 1, "PROVEN_UNISSUED_CAMPAIGN_MISSING");
    const c = record(rows[0]), s = c.spec;
    check2(["releaseId", "deploymentId", "buildSha256", "botId", "origin"].every((k) => s[k] === b[k]) && s.text === UPDATE_ANNOUNCEMENT_UA && s.appUrl === b.origin + "/" && c.phase === "paused" && c.pauseReason === "dispatch_outcome_unknown", "PROVEN_UNISSUED_BINDING");
    const all = (await client.query("select * from lba_release_campaign_jobs where release_id=$1 order by operation_id", [b.releaseId])).rows.map(job);
    check2(all.length === request.audienceSize && new Set(all.map((j) => j.operationId)).size === all.length && all.every((j) => j.botId === b.botId && j.providerReceipt === null), "PROVEN_UNISSUED_AUDIENCE");
    check2(s.audienceDigest === campaignHash(all.map((j) => j.recipientRef).sort()), "PROVEN_UNISSUED_AUDIENCE_DIGEST");
    const pilot = all.filter((j) => j.cohort === "pilot");
    check2(pilot.length === 1 && s.pilotRecipientRefs.length === 1 && pilot[0].recipientRef === s.pilotRecipientRefs[0], "PROVEN_UNISSUED_PILOT");
    const opids = all.map((j) => j.operationId), history = (await client.query("select operation_id,fence,spec_hash,events from lba_release_campaign_attempts where release_id=$1 order by operation_id,fence", [b.releaseId])).rows;
    check2(history.every((a) => opids.includes(a.operation_id) && a.spec_hash === c.specHash && Array.isArray(decode(a.events))), "PROVEN_UNISSUED_HISTORY");
    const proofEvents = history.flatMap((a) => decode(a.events).filter((e) => e?.reason === "operator_proven_unissued").map((e) => ({ attempt: a, event: e })));
    const dispatch = (await client.query("select count(*)::int as count from lba_production_telegram_dispatch_jobs where operation_id::text=any($1::text[])", [opids])).rows;
    const attempts = (await client.query("select count(*)::int as count from lba_production_telegram_dispatch_attempts where operation_id::text=any($1::text[])", [opids])).rows;
    check2(dispatch.length === 1 && dispatch[0].count === 0 && attempts.length === 1 && attempts[0].count === 0, "PROVEN_UNISSUED_DISPATCH_PRESENT");
    const operationsDigest = campaignHash([...opids].sort());
    if (proofEvents.length) {
      check2(proofEvents.length === 1, "PROVEN_UNISSUED_CERTIFICATE_CONFLICT");
      const { attempt, event } = proofEvents[0], cert = event.operatorCertificate;
      check2(event.kind === "not_sent" && event.retryable === false && campaignInstant(event.observedAt) && cert?.kind === "lba-campaign-proven-unissued/1" && cert.releaseId === b.releaseId && cert.specHash === c.specHash && cert.buildSha256 === b.buildSha256 && cert.botId === b.botId && cert.controlEpoch === request.controlEpoch && cert.audienceDigest === s.audienceDigest && cert.operationIdsDigest === operationsDigest && cert.operations === all.length && cert.dispatchJobs === 0 && cert.dispatchAttempts === 0 && cert.providerReceipts === 0 && cert.predecessorSenderSha256 === request.predecessorSenderSha256 && hex2(cert.operatorCodeSha256) && campaignInstant(cert.observedAt) && event.observedAt === cert.observedAt && certHash(cert) === cert.certificateSha256 && pilot[0].operationId === attempt.operation_id && pilot[0].fence === Number(attempt.fence) && pilot[0].state === "failed" && pilot[0].lastOutcome === "operator_proven_unissued" && pilot[0].leaseOwner === null && pilot[0].leaseUntil === null && all.filter((j) => j.cohort === "full").every((j) => j.state === "pending" && j.lastOutcome === null && j.fence === 0 && j.attempts === 0 && j.leaseOwner === null && j.leaseUntil === null), "PROVEN_UNISSUED_CERTIFICATE_INVALID");
      return { already: true, certificate: cert, campaign: c, jobs: all, history, observedAt: backend.observed_at };
    }
    check2(pilot[0].state === "outcome_unknown" && pilot[0].lastOutcome === "coordinator_unconfirmed" && pilot[0].fence >= 1 && pilot[0].attempts >= 1 && pilot[0].leaseOwner !== null && pilot[0].leaseUntil !== null && Date.parse(pilot[0].leaseUntil) < Date.parse(backend.observed_at) && all.filter((j) => j.cohort === "full").every((j) => j.state === "pending" && j.lastOutcome === null && j.fence === 0 && j.attempts === 0 && j.leaseOwner === null && j.leaseUntil === null), "PROVEN_UNISSUED_NOT_LOCAL_UNKNOWN");
    check2(history.length >= 1 && history.length <= c.spec.maxAttempts && history.every((a) => a.operation_id === pilot[0].operationId && decode(a.events).every((e) => e?.kind === "dispatching" && e.reason == null || e?.kind === "local_deferred" && ["coordinator_busy", "coordinator_deferred"].includes(e.reason) || e?.kind === "unknown" && e.reason === "coordinator_unconfirmed")), "PROVEN_UNISSUED_HISTORY_NOT_LOCAL");
    check2(history.some((a) => Number(a.fence) === pilot[0].fence), "PROVEN_UNISSUED_ATTEMPT_MISSING");
    return { already: false, campaign: c, jobs: all, history, observedAt: backend.observed_at, operationsDigest };
  }
  try {
    await client.query("set statement_timeout='3000ms'");
    await client.query("set lock_timeout='1000ms'");
    await client.query("begin isolation level repeatable read read only");
    begun = true;
    const prior = await inspect();
    await client.query("rollback");
    begun = false;
    if (prior.already) return { state: "already_reconciled", certificate: prior.certificate };
    const until = Date.now() + acquire;
    while (locks.length !== 2 && Date.now() < until) {
      for (const key of ["lba-update-campaign-global-v1", `lba-telegram-dispatch-bot:${b.botId}`]) {
        if ((await client.query("select pg_try_advisory_lock(hashtextextended($1,0)) as locked", [key])).rows[0]?.locked === true) locks.push(key);
        else break;
      }
      if (locks.length !== 2) {
        while (locks.length) await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [locks.pop()]);
        await new Promise((r) => setTimeout(r, 75));
      }
    }
    check2(locks.length === 2, "PROVEN_UNISSUED_BUSY");
    await client.query("begin isolation level repeatable read");
    begun = true;
    const current = await inspect();
    if (current.already) {
      await client.query("rollback");
      begun = false;
      return { state: "already_reconciled", certificate: current.certificate };
    }
    const bot = (await client.query("select hold_reason,hold_operation from lba_production_telegram_bot_state where bot_id=$1", [b.botId])).rows;
    check2(bot.length === 1 && bot[0].hold_reason === null && bot[0].hold_operation === null, "PROVEN_UNISSUED_BOT_HOLD");
    const unsigned = {
      kind: "lba-campaign-proven-unissued/1",
      releaseId: b.releaseId,
      specHash: current.campaign.specHash,
      buildSha256: b.buildSha256,
      botId: b.botId,
      controlEpoch: request.controlEpoch,
      audienceDigest: current.campaign.spec.audienceDigest,
      operationIdsDigest: current.operationsDigest,
      operations: current.jobs.length,
      dispatchJobs: 0,
      dispatchAttempts: 0,
      providerReceipts: 0,
      predecessorSenderSha256: request.predecessorSenderSha256,
      operatorCodeSha256: request.operatorCodeSha256,
      observedAt: current.observedAt
    };
    const certificate = { ...unsigned, certificateSha256: certHash(unsigned) };
    const event = { kind: "not_sent", retryable: false, reason: "operator_proven_unissued", observedAt: current.observedAt, operatorCertificate: certificate };
    const target = current.jobs.find((j) => j.cohort === "pilot");
    const appended = await client.query("update lba_release_campaign_attempts set events=events||$3::jsonb where operation_id=$1 and fence=$2", [target.operationId, target.fence, JSON.stringify([event])]);
    check2(appended.rowCount === 1, "PROVEN_UNISSUED_FENCE_LOST");
    const resolved = { ...target, state: "failed", lastOutcome: "operator_proven_unissued", leaseOwner: null, leaseUntil: null };
    const saved = await client.query("update lba_release_campaign_jobs set record=$2::jsonb where operation_id=$1", [target.operationId, JSON.stringify(resolved)]);
    check2(saved.rowCount === 1, "PROVEN_UNISSUED_FENCE_LOST");
    await client.query("commit");
    begun = false;
    return { state: "reconciled", certificate };
  } finally {
    if (begun) try {
      await client.query("rollback");
    } catch {
      tainted = true;
    }
    while (locks.length) try {
      if ((await client.query("select pg_advisory_unlock(hashtextextended($1,0)) as unlocked", [locks.pop()])).rows[0]?.unlocked !== true) tainted = true;
    } catch {
      tainted = true;
    }
    client.release();
    if (tainted) campaignFail("PROVEN_UNISSUED_CLIENT_QUARANTINED");
  }
}
function decode(value) {
  return structuredClone(typeof value === "string" ? JSON.parse(value) : value);
}
function record(row) {
  const c = decode(row?.record);
  if (!c?.spec || c.spec.version !== UPDATE_CAMPAIGN_VERSION || c.spec.releaseId !== row.release_id || c.spec.botId !== row.bot_id || c.specHash !== row.spec_hash || campaignSpecHash(c.spec) !== c.specHash || !["prepared", "pilot", "full", "paused", "completed"].includes(c.phase) || !campaignInstant(c.spec.createdAt) || !campaignInstant(c.spec.expiresAt)) return campaignFail("CAMPAIGN_RECORD_INVALID");
  return c;
}
function job(row) {
  const j = decode(row?.record);
  if (!j || j.operationId !== row.operation_id || j.releaseId !== row.release_id || j.recipientRef !== row.recipient_ref || j.cohort !== row.cohort || j.operationId !== campaignOperationId(j.releaseId, j.recipientRef) || !campaignId(j.botId) || !STATES.includes(j.state) || !Number.isSafeInteger(j.fence) || j.fence < 0 || !Number.isSafeInteger(j.attempts) || j.attempts < 0 || !campaignInstant(j.nextAttemptAt) || j.leaseUntil !== null && !campaignInstant(j.leaseUntil) || j.leaseOwner !== null && !campaignId(j.leaseOwner)) return campaignFail("CAMPAIGN_JOB_INVALID");
  return j;
}
function sameClaim(c, j, claim) {
  return c.specHash === claim.campaign.specHash && c.specHash === campaignSpecHash(claim.campaign.spec) && j.operationId === claim.job.operationId && j.recipientRef === claim.job.recipientRef && j.releaseId === claim.job.releaseId && j.botId === claim.job.botId && j.fence === claim.fence && j.fence === claim.job.fence && j.leaseOwner === claim.workerId;
}
function createPgUpdateCampaignRepository(pool, eligibility) {
  if (!pool || typeof pool.connect !== "function" || typeof eligibility?.enabled !== "function") return campaignFail("INVALID_CAMPAIGN_REPOSITORY");
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended('lba-update-campaign-global-v1',0))");
      const value = await fn(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async function load(client, releaseId) {
    if (!campaignId(releaseId)) return campaignFail("INVALID_CAMPAIGN_ID");
    const rows = await client.query("select * from lba_release_campaigns where release_id=$1 for update", [releaseId]);
    if (!rows.rows.length) return campaignFail("CAMPAIGN_NOT_FOUND");
    return record(rows.rows[0]);
  }
  async function jobs(client, releaseId) {
    return (await client.query("select * from lba_release_campaign_jobs where release_id=$1 order by operation_id for update", [releaseId])).rows.map(job);
  }
  async function saveCampaign(client, c) {
    await client.query("update lba_release_campaigns set record=$2::jsonb where release_id=$1", [c.spec.releaseId, JSON.stringify(c)]);
  }
  async function saveJob(client, j) {
    await client.query("update lba_release_campaign_jobs set record=$2::jsonb where operation_id=$1", [j.operationId, JSON.stringify(j)]);
  }
  async function summaryIn(client, c) {
    const rows = await jobs(client, c.spec.releaseId), states = zero(), pilotStates = zero();
    for (const j of rows) {
      states[j.state]++;
      if (j.cohort === "pilot") pilotStates[j.state]++;
    }
    return {
      releaseId: c.spec.releaseId,
      specHash: c.specHash,
      phase: c.phase,
      pauseReason: c.pauseReason,
      total: rows.length,
      pilotTotal: rows.filter((j) => j.cohort === "pilot").length,
      states,
      pilotStates
    };
  }
  async function botJobs(client, botId) {
    return (await client.query(`select j.* from lba_release_campaign_jobs j join lba_release_campaigns c on c.release_id=j.release_id
      where c.bot_id=$1 and (j.record->>'state' in ('leased','dispatching','outcome_unknown','retry_wait') or j.record->>'lastOutcome'='rate_limited') order by j.operation_id for update of j`, [botId])).rows.map(job);
  }
  async function event(client, j, outcome, now) {
    const result = await client.query("update lba_release_campaign_attempts set events=events||$3::jsonb where operation_id=$1 and fence=$2", [j.operationId, j.fence, JSON.stringify([{ ...outcome, observedAt: now }])]);
    if (!result.rowCount) return campaignFail("CAMPAIGN_ATTEMPT_MISSING");
  }
  async function recoverBot(client, botId, now) {
    const time = nowCheck(now), rows = await botJobs(client, botId);
    for (const j of rows) {
      if (!["leased", "dispatching"].includes(j.state) || j.leaseUntil === null || Date.parse(j.leaseUntil) > time) continue;
      if (j.state === "dispatching") {
        await event(client, j, { kind: "unknown", reason: "dispatch_lease_expired" }, now);
        j.state = "outcome_unknown";
        j.lastOutcome = "dispatch_lease_expired";
        const c = await load(client, j.releaseId);
        c.phase = "paused";
        c.pauseReason = "dispatch_outcome_unknown";
        await saveCampaign(client, c);
      } else {
        j.state = "pending";
        j.lastOutcome = "lease_expired_before_dispatch";
        clearLease(j);
      }
      await saveJob(client, j);
    }
  }
  async function noUnknown(client, botId) {
    return !(await botJobs(client, botId)).some((j) => j.state === "outcome_unknown");
  }
  async function prepare(input, recipientRefs) {
    const spec = prepareCampaignSpec(input, recipientRefs), specHash = campaignSpecHash(spec);
    return tx(async (client) => {
      const existing = await client.query("select * from lba_release_campaigns where release_id=$1 for update", [spec.releaseId]);
      if (existing.rows.length) {
        const prior = record(existing.rows[0]);
        if (prior.specHash !== specHash) return campaignFail("CAMPAIGN_RELEASE_CONFLICT");
        return { ...await summaryIn(client, prior), replayed: true };
      }
      const c = { spec, specHash, phase: "prepared", pauseReason: null };
      await client.query("insert into lba_release_campaigns(release_id,bot_id,spec_hash,record) values($1,$2,$3,$4::jsonb)", [spec.releaseId, spec.botId, specHash, JSON.stringify(c)]);
      for (let offset = 0; offset < recipientRefs.length; offset += 500) {
        const rows = recipientRefs.slice(offset, offset + 500).map((recipientRef) => {
          const j = {
            operationId: campaignOperationId(spec.releaseId, recipientRef),
            releaseId: spec.releaseId,
            botId: spec.botId,
            recipientRef,
            cohort: spec.pilotRecipientRefs.includes(recipientRef) ? "pilot" : "full",
            state: "pending",
            fence: 0,
            attempts: 0,
            nextAttemptAt: spec.createdAt,
            leaseOwner: null,
            leaseUntil: null,
            providerReceipt: null,
            lastOutcome: null
          };
          return { operation_id: j.operationId, release_id: j.releaseId, recipient_ref: recipientRef, cohort: j.cohort, record: j };
        });
        await client.query(`insert into lba_release_campaign_jobs(operation_id,release_id,recipient_ref,cohort,record)
          select x.operation_id,x.release_id,x.recipient_ref,x.cohort,x.record from jsonb_to_recordset($1::jsonb)
          as x(operation_id text,release_id text,recipient_ref text,cohort text,record jsonb)`, [JSON.stringify(rows)]);
      }
      return { ...await summaryIn(client, c), replayed: false };
    });
  }
  async function startPilot(releaseId, now) {
    nowCheck(now);
    return tx(async (client) => {
      let c = await load(client, releaseId);
      await recoverBot(client, c.spec.botId, now);
      c = await load(client, releaseId);
      if (!["prepared", "paused", "pilot"].includes(c.phase) || Date.parse(now) < Date.parse(c.spec.createdAt) || Date.parse(now) >= Date.parse(c.spec.expiresAt) || !await noUnknown(client, c.spec.botId)) return null;
      c.phase = "pilot";
      c.pauseReason = null;
      await saveCampaign(client, c);
      return summaryIn(client, c);
    }).then((value) => value ?? campaignFail("CAMPAIGN_PILOT_BLOCKED"));
  }
  async function promote(releaseId, now) {
    nowCheck(now);
    return tx(async (client) => {
      let c = await load(client, releaseId);
      await recoverBot(client, c.spec.botId, now);
      c = await load(client, releaseId);
      const pilot = (await jobs(client, releaseId)).filter((j) => j.cohort === "pilot");
      if (!pilot.length || pilot.length !== c.spec.pilotRecipientRefs.length || pilot.some((j) => j.state !== "sent") || Date.parse(now) >= Date.parse(c.spec.expiresAt) || !await noUnknown(client, c.spec.botId)) return null;
      if (c.phase !== "completed") {
        c.phase = "full";
        c.pauseReason = null;
        await saveCampaign(client, c);
      }
      return summaryIn(client, c);
    }).then((value) => value ?? campaignFail("CAMPAIGN_PILOT_NOT_CONFIRMED"));
  }
  async function pause(releaseId) {
    return tx(async (client) => {
      const c = await load(client, releaseId);
      if (c.phase !== "completed") {
        c.phase = "paused";
        c.pauseReason = "operator_paused";
        await saveCampaign(client, c);
      }
      return summaryIn(client, c);
    });
  }
  const repo = {
    async claim(releaseId, workerId, now, leaseSeconds) {
      const time = nowCheck(now);
      if (!campaignId(workerId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) return campaignFail("INVALID_CAMPAIGN_WORKER");
      return tx(async (client) => {
        let c = await load(client, releaseId);
        await recoverBot(client, c.spec.botId, now);
        c = await load(client, releaseId);
        if (!["pilot", "full"].includes(c.phase) || time < Date.parse(c.spec.createdAt)) return null;
        const active = await botJobs(client, c.spec.botId);
        if (active.some((j) => j.state === "outcome_unknown" || ["leased", "dispatching"].includes(j.state) && j.leaseUntil !== null && Date.parse(j.leaseUntil) > time || j.lastOutcome === "rate_limited" && Date.parse(j.nextAttemptAt) > time)) return null;
        const all = await jobs(client, releaseId);
        for (const j of all) {
          if (!["pending", "retry_wait"].includes(j.state)) continue;
          if (time >= Date.parse(c.spec.expiresAt) || j.attempts >= c.spec.maxAttempts) {
            j.state = time >= Date.parse(c.spec.expiresAt) ? "cancelled" : "failed";
            j.lastOutcome = "campaign_expired_or_attempt_limit";
            clearLease(j);
            await saveJob(client, j);
            continue;
          }
          if (c.phase === "pilot" && j.cohort !== "pilot" || Date.parse(j.nextAttemptAt) > time) continue;
          j.state = "leased";
          j.fence++;
          j.leaseOwner = workerId;
          j.leaseUntil = new Date(time + leaseSeconds * 1e3).toISOString();
          await saveJob(client, j);
          return { campaign: c, job: j, workerId, fence: j.fence };
        }
        if ((c.phase === "full" || time >= Date.parse(c.spec.expiresAt)) && all.every((j) => TERMINAL.includes(j.state))) {
          c.phase = "completed";
          c.pauseReason = null;
          await saveCampaign(client, c);
        }
        return null;
      });
    },
    async begin(claim, health, now) {
      const time = nowCheck(now);
      return tx(async (client) => {
        const c = await load(client, claim.job.releaseId), rows = await client.query("select * from lba_release_campaign_jobs where operation_id=$1 for update", [claim.job.operationId]);
        if (!rows.rows.length) return "lost";
        const j = job(rows.rows[0]);
        if (!sameClaim(c, j, claim) || j.state !== "leased" || !j.leaseUntil || time >= Date.parse(j.leaseUntil)) return "lost";
        if (time >= Date.parse(c.spec.expiresAt)) {
          j.state = "cancelled";
          j.lastOutcome = "campaign_expired_before_send";
          clearLease(j);
          await saveJob(client, j);
          return "cancelled";
        }
        if (!["pilot", "full"].includes(c.phase) || c.phase === "pilot" && j.cohort !== "pilot" || !validDeploymentHealth(campaignBinding(c.spec), health, now)) {
          j.state = "pending";
          j.lastOutcome = "deployment_health_unverified";
          clearLease(j);
          c.phase = "paused";
          c.pauseReason = j.lastOutcome;
          await saveJob(client, j);
          await saveCampaign(client, c);
          return "health_blocked";
        }
        const enabled = await eligibility.enabled(client, j.recipientRef, c.spec.botId, now);
        if (enabled !== true) {
          j.state = "cancelled";
          j.lastOutcome = "subscription_not_enabled";
          clearLease(j);
          await saveJob(client, j);
          return "cancelled";
        }
        j.state = "dispatching";
        j.attempts++;
        j.lastOutcome = "dispatch_started";
        await client.query("insert into lba_release_campaign_attempts(operation_id,fence,release_id,worker_id,spec_hash,events) values($1,$2,$3,$4,$5,$6::jsonb)", [j.operationId, j.fence, j.releaseId, claim.workerId, c.specHash, JSON.stringify([{ kind: "dispatching", observedAt: now }])]);
        await saveJob(client, j);
        return "dispatch";
      });
    },
    async defer(claim, deferral, now) {
      const time = nowCheck(now);
      if (!deferral || !["coordinator_busy", "coordinator_deferred"].includes(deferral.reason) || !campaignInstant(deferral.retryAt) || Date.parse(deferral.retryAt) <= time || Date.parse(deferral.retryAt) - time > 864e5) return campaignFail("INVALID_CAMPAIGN_LOCAL_DEFERRAL");
      return tx(async (client) => {
        const c = await load(client, claim.job.releaseId), rows = await client.query("select * from lba_release_campaign_jobs where operation_id=$1 for update", [claim.job.operationId]);
        if (rows.rows.length !== 1) return "lost";
        const j = job(rows.rows[0]);
        if (!sameClaim(c, j, claim) || j.state !== "dispatching" || !j.leaseUntil || time >= Date.parse(j.leaseUntil) || j.attempts !== claim.job.attempts + 1) return "lost";
        const updated = await client.query("update lba_release_campaign_attempts set events=events||$3::jsonb where operation_id=$1 and fence=$2", [j.operationId, j.fence, JSON.stringify([{ kind: "local_deferred", reason: deferral.reason, retryAt: deferral.retryAt, observedAt: now }])]);
        if (updated.rowCount !== 1) return campaignFail("CAMPAIGN_ATTEMPT_MISSING");
        j.attempts--;
        j.nextAttemptAt = deferral.retryAt;
        j.lastOutcome = deferral.reason;
        j.state = time >= Date.parse(c.spec.expiresAt) || Date.parse(deferral.retryAt) >= Date.parse(c.spec.expiresAt) ? "cancelled" : "retry_wait";
        clearLease(j);
        await saveJob(client, j);
        if (c.phase === "full" && (await jobs(client, j.releaseId)).every((item) => TERMINAL.includes(item.state))) {
          c.phase = "completed";
          c.pauseReason = null;
          await saveCampaign(client, c);
        }
        return j.state === "cancelled" ? "cancelled" : "deferred";
      });
    },
    async finish(claim, value, now) {
      const time = nowCheck(now), outcome = checkedCampaignOutcome(value);
      return tx(async (client) => {
        const c = await load(client, claim.job.releaseId), rows = await client.query("select * from lba_release_campaign_jobs where operation_id=$1 for update", [claim.job.operationId]);
        if (!rows.rows.length) return campaignFail("CAMPAIGN_FENCE_LOST");
        const j = job(rows.rows[0]);
        if (j.state === "sent" && j.fence === claim.fence && c.specHash === claim.campaign.specHash && outcome.kind === "sent" && outcome.receipt === j.providerReceipt) return;
        if (!sameClaim(c, j, claim) || !["dispatching", "outcome_unknown"].includes(j.state)) return campaignFail("CAMPAIGN_FENCE_LOST");
        if (j.state === "outcome_unknown" && outcome.kind !== "sent" && outcome.kind !== "unknown") return;
        if (j.state === "outcome_unknown" && outcome.kind === "unknown" && j.lastOutcome === outcome.reason) return;
        await event(client, j, outcome, now);
        if (outcome.kind === "unknown") {
          j.state = "outcome_unknown";
          j.lastOutcome = outcome.reason;
          c.phase = "paused";
          c.pauseReason = "dispatch_outcome_unknown";
        } else if (outcome.kind === "sent") {
          j.state = "sent";
          j.providerReceipt = outcome.receipt;
          j.lastOutcome = "telegram_confirmed";
          clearLease(j);
        } else {
          const retry = outcome.kind === "rate_limited" || outcome.retryable;
          const delay = outcome.kind === "rate_limited" ? outcome.retryAfterSeconds : Math.min(60, 2 ** j.attempts);
          j.nextAttemptAt = new Date(time + delay * 1e3).toISOString();
          j.state = !retry || j.attempts >= c.spec.maxAttempts || Date.parse(j.nextAttemptAt) >= Date.parse(c.spec.expiresAt) ? "failed" : "retry_wait";
          j.lastOutcome = outcome.kind;
          clearLease(j);
          if (j.cohort === "pilot" && j.state === "failed") {
            c.phase = "paused";
            c.pauseReason = "pilot_failed";
          }
        }
        await saveJob(client, j);
        if (c.phase === "full" && (await jobs(client, j.releaseId)).every((item) => TERMINAL.includes(item.state))) {
          c.phase = "completed";
          c.pauseReason = null;
        }
        await saveCampaign(client, c);
      });
    }
  };
  return {
    ...repo,
    prepare,
    startPilot,
    promote,
    pause,
    summary: (releaseId) => tx(async (client) => summaryIn(client, await load(client, releaseId))),
    attemptHistory: (releaseId) => tx(async (client) => {
      await load(client, releaseId);
      return (await client.query("select operation_id,fence,worker_id,spec_hash,events from lba_release_campaign_attempts where release_id=$1 order by operation_id,fence", [releaseId])).rows;
    })
  };
}
var UPDATE_CAMPAIGN_SCHEMA_SQL, certHash, STATES, TERMINAL, nowCheck, zero, clearLease;
var init_update_campaign_pg = __esm({
  "server/release/update-campaign-pg.ts"() {
    "use strict";
    init_update_campaign();
    UPDATE_CAMPAIGN_SCHEMA_SQL = `
create table if not exists lba_release_campaigns (
 release_id text primary key, bot_id text not null, spec_hash text not null, record jsonb not null
);
create table if not exists lba_release_campaign_jobs (
 operation_id text primary key, release_id text not null references lba_release_campaigns(release_id),
 recipient_ref text not null, cohort text not null check(cohort in ('pilot','full')), record jsonb not null,
 unique(release_id,recipient_ref)
);
create table if not exists lba_release_campaign_attempts (
 operation_id text not null references lba_release_campaign_jobs(operation_id), fence integer not null,
 release_id text not null references lba_release_campaigns(release_id), worker_id text not null, spec_hash text not null,
 events jsonb not null, primary key(operation_id,fence)
);
create index if not exists lba_release_campaign_bot on lba_release_campaigns(bot_id);
create index if not exists lba_release_campaign_job_release on lba_release_campaign_jobs(release_id,cohort);
create index if not exists lba_release_campaign_job_state on lba_release_campaign_jobs((record->>'state'));
`;
    certHash = (c) => campaignHash([
      c.kind,
      c.releaseId,
      c.specHash,
      c.buildSha256,
      c.botId,
      c.controlEpoch,
      c.audienceDigest,
      c.operationIdsDigest,
      c.operations,
      c.dispatchJobs,
      c.dispatchAttempts,
      c.providerReceipts,
      c.predecessorSenderSha256,
      c.operatorCodeSha256,
      c.observedAt
    ]);
    STATES = ["pending", "leased", "dispatching", "retry_wait", "outcome_unknown", "sent", "cancelled", "failed"];
    TERMINAL = ["sent", "cancelled", "failed"];
    nowCheck = (now) => {
      if (!campaignInstant(now)) return campaignFail("INVALID_CAMPAIGN_CLOCK");
      return Date.parse(now);
    };
    zero = () => Object.fromEntries(STATES.map((state) => [state, 0]));
    clearLease = (j) => {
      j.leaseOwner = null;
      j.leaseUntil = null;
    };
  }
});

// ../release-tools/predecessor-no-effect.source.cjs
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");
var { createRequire } = require("node:module");
var { reconcileCampaignProvenUnissued: reconcileCampaignProvenUnissued2 } = (init_update_campaign_pg(), __toCommonJS(update_campaign_pg_exports));
var APP = path.resolve(__dirname, "../app");
var hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
var sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
var OperatorError = class extends Error {
};
var check = (ok, code) => {
  if (!ok) throw new OperatorError(code);
};
async function runPredecessorReconciliation(expected) {
  let pool;
  try {
    check(hex(expected), "PROVEN_UNISSUED_ARGUMENTS");
    check(process.versions.node.split(".")[0] === "20", "PROVEN_UNISSUED_NODE20_REQUIRED");
    const verified = createRequire(__filename)("./verify-prebuilt.cjs").verify();
    check(verified.sourceSha256 === expected && expected !== "ab0a12bc69fe45961941367d8263ae40e89e9cb8330c24b419e276abd08f65fc", "PROVEN_UNISSUED_BUILD_MISMATCH");
    const bytes = fs.readFileSync(path.join(APP, "dist-production/build-receipt.json"));
    check(JSON.parse(bytes).sourceSha256 === expected, "PROVEN_UNISSUED_RECEIPT_DRIFT");
    check(typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0, "PROVEN_UNISSUED_DATABASE_CONFIG");
    const { Pool } = createRequire(path.join(APP, "package.json"))("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5e3, idleTimeoutMillis: 1e3 });
    pool.on("error", () => {
    });
    const result = await reconcileCampaignProvenUnissued2(pool, {
      binding: { releaseId: "lba-v8-font-ab0a12bc-20261110", deploymentId: "lba-release:font-ab0a12bc-20261110", buildSha256: "ab0a12bc69fe45961941367d8263ae40e89e9cb8330c24b419e276abd08f65fc", botId: "8577497098", origin: "https://power-ukraine.net" },
      controlEpoch: 1,
      audienceSize: 8,
      predecessorSenderSha256: "8c8a1aa2817726d491184cece61183b600d3c2014f08870d8faac0c635bcf51f",
      operatorCodeSha256: sha(fs.readFileSync(__filename))
    });
    const receipt = {
      kind: "lba-predecessor-proven-unissued/1",
      newSourceSha256: expected,
      buildReceiptSha256: sha(bytes),
      ...result,
      scope: "One proven-unissued campaign metadata resolution; no provider call, old spec/history/full recipients/profile/schema unchanged."
    };
    console.log(JSON.stringify(receipt));
    return receipt;
  } finally {
    if (pool) await pool.end();
  }
}
async function main() {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--verify") {
      const verified = createRequire(__filename)("./verify-prebuilt.cjs").verify();
      console.log(JSON.stringify({ kind: "lba-predecessor-proven-unissued-config/1", ...verified, databaseConnected: false, reconciled: false, sent: false }));
      return;
    }
    check(process.argv.length === 4 && process.argv[2] === "--expected-source", "PROVEN_UNISSUED_ARGUMENTS");
    await runPredecessorReconciliation(process.argv[3]);
  } catch (error) {
    const code = typeof error?.message === "string" && /^(?:PROVEN_UNISSUED|CAMPAIGN)_[A-Z_]+$/.test(error.message) ? error.message : "PROVEN_UNISSUED_UNCONFIRMED";
    console.error(JSON.stringify({ kind: "lba-predecessor-proven-unissued/1", success: false, code }));
    process.exitCode = 1;
  }
}
module.exports = { runPredecessorReconciliation, main };
if (require.main === module) void main();
