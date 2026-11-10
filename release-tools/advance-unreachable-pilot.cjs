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
var update_campaign_exports = {};
__export(update_campaign_exports, {
  CampaignError: () => CampaignError,
  UPDATE_ANNOUNCEMENT_UA: () => UPDATE_ANNOUNCEMENT_UA,
  UPDATE_CAMPAIGN_VERSION: () => UPDATE_CAMPAIGN_VERSION,
  campaignBinding: () => campaignBinding,
  campaignFail: () => campaignFail,
  campaignHash: () => campaignHash,
  campaignId: () => campaignId,
  campaignInstant: () => campaignInstant,
  campaignOperationId: () => campaignOperationId,
  campaignSpecHash: () => campaignSpecHash,
  checkedCampaignClaim: () => checkedCampaignClaim,
  checkedCampaignOutcome: () => checkedCampaignOutcome,
  classifyCampaignReply: () => classifyCampaignReply,
  prepareCampaignSpec: () => prepareCampaignSpec,
  runUpdateCampaignAttempt: () => runUpdateCampaignAttempt,
  validDeploymentHealth: () => validDeploymentHealth
});
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
function classifyCampaignReply(envelope, reply) {
  if (!plain(reply) || reply.botId !== envelope.botId || reply.recipientRef !== envelope.recipientRef || !plain(reply.body)) return { kind: "unknown", reason: "provider_target_or_response_unverified" };
  const body = reply.body;
  if (body.ok === true && plain(body.result) && Number.isSafeInteger(body.result.message_id) && Number(body.result.message_id) > 0)
    return { kind: "sent", receipt: "tg-msg-" + String(body.result.message_id) };
  if (body.ok !== false || !Number.isInteger(body.error_code)) return { kind: "unknown", reason: "provider_response_unverified" };
  const code = Number(body.error_code);
  if (code === 429) {
    if (plain(body.parameters) && Number.isSafeInteger(body.parameters.retry_after) && Number(body.parameters.retry_after) >= 1 && Number(body.parameters.retry_after) <= 86400)
      return { kind: "rate_limited", retryAfterSeconds: Number(body.parameters.retry_after) };
    return { kind: "unknown", reason: "rate_limit_unverified" };
  }
  if (code === 403) return { kind: "not_sent", retryable: false, reason: "telegram_forbidden" };
  if (code >= 400 && code < 500) return { kind: "not_sent", retryable: false, reason: "telegram_rejected_" + code };
  if (code >= 500 && code <= 599) return { kind: "not_sent", retryable: true, reason: "telegram_rejected_" + code };
  return { kind: "unknown", reason: "provider_response_unverified" };
}
function checkedClaim(claim, options) {
  const c = structuredClone(claim), j = c?.job, campaign = c?.campaign, spec = campaign?.spec;
  if (!campaign || !spec || campaignSpecHash(spec) !== campaign.specHash || spec.releaseId !== options.releaseId || !j || j.releaseId !== spec.releaseId || j.botId !== spec.botId || !campaignId(j.recipientRef) || j.operationId !== campaignOperationId(spec.releaseId, j.recipientRef) || j.state !== "leased" || j.leaseOwner !== options.workerId || c.workerId !== options.workerId || c.fence !== j.fence || !Number.isSafeInteger(j.fence) || j.fence < 1 || !campaignInstant(j.leaseUntil) || !Number.isSafeInteger(j.attempts) || j.attempts < 0 || j.attempts >= spec.maxAttempts || !["pilot", "full"].includes(campaign.phase) || j.cohort !== (spec.pilotRecipientRefs.includes(j.recipientRef) ? "pilot" : "full")) return campaignFail("INVALID_CAMPAIGN_CLAIM");
  return c;
}
async function runUpdateCampaignAttempt(repo, sender, observer, options) {
  if (!campaignId(options?.releaseId) || !campaignId(options?.workerId) || typeof options.now !== "function" || !repo || !["claim", "begin", "finish"].every((key) => typeof repo[key] === "function") || sender?.kind !== "telegram-release-campaign" || !campaignId(sender.botId) || typeof sender.send !== "function" || typeof observer?.observe !== "function") return campaignFail("INVALID_CAMPAIGN_RUN");
  const lease = options.leaseSeconds ?? 45, timeout = options.timeoutMs ?? 15e3, healthTimeout = options.healthTimeoutMs ?? 5e3;
  if (!Number.isInteger(lease) || lease < 5 || lease > 300 || !Number.isInteger(timeout) || timeout < 1 || timeout > 3e4 || !Number.isInteger(healthTimeout) || healthTimeout < 1 || healthTimeout > 1e4) return campaignFail("INVALID_CAMPAIGN_BOUNDS");
  let last = options.now();
  if (!campaignInstant(last)) return campaignFail("INVALID_CAMPAIGN_CLOCK");
  function clock() {
    try {
      const value = options.now();
      if (campaignInstant(value) && Date.parse(value) >= Date.parse(last)) {
        last = value;
        return { now: value, valid: true };
      }
    } catch {
    }
    return { now: last, valid: false };
  }
  const raw = await repo.claim(options.releaseId, options.workerId, last, lease);
  if (!raw) return { operationId: null, result: "idle" };
  const claim = checkedClaim(raw, options), operationId = claim.job.operationId, spec = claim.campaign.spec;
  if (sender.botId !== spec.botId) {
    await repo.begin(claim, null, clock().now);
    return { operationId, result: "health_blocked" };
  }
  const healthController = new AbortController();
  let healthTimer;
  const healthPromise = Promise.resolve().then(() => observer.observe(Object.freeze(campaignBinding(spec)), healthController.signal)).catch(() => null);
  const health = await Promise.race([healthPromise, new Promise((resolve) => {
    healthTimer = setTimeout(() => {
      resolve(null);
      healthController.abort();
    }, healthTimeout);
  })]);
  if (healthTimer) clearTimeout(healthTimer);
  const before = clock(), verified = before.valid && validDeploymentHealth(spec, health, before.now) ? health : null;
  const begun = await repo.begin(claim, verified, before.now);
  if (begun !== "dispatch") return { operationId, result: begun };
  const at = clock();
  if (!at.valid || !claim.job.leaseUntil || Date.parse(at.now) >= Date.parse(claim.job.leaseUntil) || Date.parse(at.now) >= Date.parse(spec.expiresAt)) {
    await repo.finish(claim, { kind: "unknown", reason: "dispatch_clock_or_deadline_changed" }, at.now);
    return { operationId, result: "unknown" };
  }
  const envelope = Object.freeze({ ...campaignBinding(spec), operationId, recipientRef: claim.job.recipientRef, text: spec.text, appUrl: spec.appUrl });
  const controller = new AbortController();
  let timer, timedOut = false;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ kind: "unknown", reason: "telegram_timeout" });
      controller.abort();
    }, timeout);
  });
  let completion;
  try {
    completion = Promise.resolve(sender.send(envelope, controller.signal)).then((value) => classifyCampaignReply(envelope, value)).catch(() => ({ kind: "unknown", reason: "telegram_transport_error" }));
  } catch {
    completion = Promise.resolve({ kind: "unknown", reason: "telegram_transport_error" });
  }
  const outcome = await Promise.race([completion, deadline]);
  if (timer) clearTimeout(timer);
  const finish = clock(), final = finish.valid ? outcome : { kind: "unknown", reason: "clock_changed_after_send" };
  await repo.finish(claim, final, finish.now);
  if (timedOut) void completion.then(async (late) => {
    if (late.kind === "sent") {
      const observed = clock();
      if (observed.valid) try {
        await repo.finish(claim, late, observed.now);
      } catch {
      }
    }
  });
  return { operationId, result: final.kind };
}
var import_node_crypto, UPDATE_CAMPAIGN_VERSION, UPDATE_ANNOUNCEMENT_UA, CampaignError, campaignFail, plain, exactKeys, checkedCampaignClaim;
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
    checkedCampaignClaim = checkedClaim;
  }
});

// ../release-tools/advance-unreachable-pilot.source.cjs
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");
var { createRequire } = require("node:module");
var { campaignHash: campaignHash2, campaignSpecHash: campaignSpecHash2, campaignOperationId: campaignOperationId2, UPDATE_ANNOUNCEMENT_UA: UPDATE_ANNOUNCEMENT_UA2 } = (init_update_campaign(), __toCommonJS(update_campaign_exports));
var SOURCE = "768f1d605d91d6b917691d1bb9aa9d83d24ac17c3dc15d50127c0939f1476126";
var RELEASE = "lba-v8-dispatch-768f1d60-20261110-r2";
var DEPLOYMENT = "lba-release:dispatch-768f1d60-20261110-r2";
var BOT = "8577497098";
var ORIGIN = "https://power-ukraine.net";
var AUTHORITY = "613b008586fe302bc4cbdd45d4f34ae2eb45d2c050ddbf4c459747ac22e5a2bc";
var SENDER = "8c8a1aa2817726d491184cece61183b600d3c2014f08870d8faac0c635bcf51f";
var TRANSPORT = "4b3469e5566feb73956f18987c75cc36baf206fd246bc6a02ab04cf4ce7e36b6";
var SPEC = "25f32d7ce0319b12acc6ffbd4998dc5af4a74373e26b96148c441563e032844d";
var AUDIENCE = "4998040c6c58df6eab51402e72aa7b6fd34cd18879a81f4a349fdb80223a9a0b";
var KIND = "lba-unreachable-pilot-advance/1";
var hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
var plain2 = (v) => v && typeof v === "object" && !Array.isArray(v);
var instant = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
var canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
var digest = (v) => crypto.createHash("sha256").update(canonical(v)).digest("hex");
var sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
var decode = (v) => typeof v === "string" ? JSON.parse(v) : structuredClone(v);
var fail = (code) => {
  throw Error(code);
};
var check = (ok, code) => {
  if (!ok) fail(code);
};
var negative = (o) => plain2(o) && Object.keys(o).sort().join("|") === "kind|reason|retryable" && o.kind === "not_sent" && o.reason === "telegram_forbidden" && o.retryable === false;
function certificateHash(c) {
  const value = { ...c };
  delete value.certificateSha256;
  return digest(value);
}
function healthValid(h, now) {
  return plain2(h) && h.releaseId === RELEASE && h.deploymentId === DEPLOYMENT && h.buildSha256 === SOURCE && h.botId === BOT && h.origin === ORIGIN && h.healthy === true && instant(h.observedAt) && Date.parse(h.observedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(h.observedAt) <= 3e5;
}
async function publicHealth() {
  const url = ORIGIN + "/api/health/release", abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5e3);
  let reader;
  try {
    const response = await fetch(url, { redirect: "error", credentials: "omit", cache: "no-store", headers: { accept: "application/json" }, signal: abort.signal });
    check(response.status === 200 && !response.redirected && response.url === url && response.headers.get("content-type")?.split(";")[0].trim() === "application/json" && response.body, "ADVANCE_HEALTH");
    reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
    for (; ; ) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      check(bytes <= 16384, "ADVANCE_HEALTH");
      chunks.push(part.value);
    }
    const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    check(b.releaseId === SOURCE && b.buildSha256 === SOURCE && b.noticeReleaseId === RELEASE && b.deploymentRef === DEPLOYMENT && b.configuredBotId === BOT && b.origin === ORIGIN && b.mode === "production" && b.profileMode === "active" && b.status === "process_serving" && b.canonical?.ready === true && b.canonical?.started === true && b.canonical?.stopped === false && b.canonical?.deliveryReady === true, "ADVANCE_HEALTH");
    const result = { releaseId: RELEASE, deploymentId: DEPLOYMENT, buildSha256: SOURCE, botId: BOT, origin: ORIGIN, healthy: true, observedAt: b.observedAt };
    check(healthValid(result, (/* @__PURE__ */ new Date()).toISOString()), "ADVANCE_HEALTH");
    return result;
  } catch (e) {
    fail("ADVANCE_HEALTH");
  } finally {
    clearTimeout(timer);
    abort.abort();
    if (reader) void reader.cancel().catch(() => {
    });
  }
}
async function advanceWithPool(pool, { apply = false, operatorSha256, expectedSpecHash, expectedAudienceDigest, getHealth = publicHealth } = {}) {
  check(pool && typeof pool.connect === "function" && typeof apply === "boolean" && hex(operatorSha256) && hex(expectedSpecHash) && hex(expectedAudienceDigest), "ADVANCE_OPTIONS");
  const client = await pool.connect();
  let transaction = false, destroyed = false, timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    destroyed = true;
    try {
      client.release(Error("ADVANCE_TIMEOUT"));
    } catch {
    }
  }, 85e3);
  async function begin(sql) {
    await client.query(sql);
    transaction = true;
    await client.query("set local statement_timeout='3000ms'");
    await client.query("set local lock_timeout='1000ms'");
  }
  async function backend() {
    const r = (await client.query(`select pg_is_in_recovery() as recovery,current_setting('default_transaction_read_only') as default_ro,to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as observed_at`)).rows[0];
    check(r?.recovery === false && r.default_ro === "off" && instant(r.observed_at), "ADVANCE_PRIMARY");
    return r.observed_at;
  }
  async function inspect() {
    const rows = (await client.query("select * from lba_release_campaigns where release_id=$1", [RELEASE])).rows;
    check(rows.length === 1, "ADVANCE_CAMPAIGN");
    const row = rows[0], c = decode(row.record), s = c?.spec;
    check(s && s.version === "lba-update-campaign/1" && s.releaseId === RELEASE && s.deploymentId === DEPLOYMENT && s.buildSha256 === SOURCE && s.botId === BOT && s.origin === ORIGIN && s.text === UPDATE_ANNOUNCEMENT_UA2 && s.appUrl === ORIGIN + "/" && s.createdAt === "2026-11-10T12:54:30.870Z" && s.expiresAt === "2026-11-11T12:54:30.870Z" && s.maxAttempts === 3 && s.pilotRecipientRefs?.length === 1 && row.bot_id === BOT && row.release_id === RELEASE && row.spec_hash === c.specHash && campaignSpecHash2(s) === c.specHash && c.specHash === expectedSpecHash && s.audienceDigest === expectedAudienceDigest, "ADVANCE_BINDING");
    const raw = (await client.query("select * from lba_release_campaign_jobs where release_id=$1 order by operation_id", [RELEASE])).rows;
    const jobs = raw.map((r) => {
      const j = decode(r.record);
      check(j && j.operationId === r.operation_id && j.releaseId === r.release_id && j.recipientRef === r.recipient_ref && j.cohort === r.cohort && j.releaseId === RELEASE && j.botId === BOT && j.operationId === campaignOperationId2(RELEASE, j.recipientRef) && j.cohort === (s.pilotRecipientRefs.includes(j.recipientRef) ? "pilot" : "full") && ["pending", "leased", "dispatching", "retry_wait", "outcome_unknown", "sent", "cancelled", "failed"].includes(j.state) && Number.isSafeInteger(j.fence) && j.fence >= 0 && Number.isSafeInteger(j.attempts) && j.attempts >= 0, "ADVANCE_JOB");
      return j;
    });
    check(jobs.length === 8 && new Set(jobs.map((j) => j.operationId)).size === 8 && s.audienceDigest === campaignHash2(jobs.map((j) => j.recipientRef).sort()), "ADVANCE_AUDIENCE");
    const pilots = jobs.filter((j) => j.cohort === "pilot");
    check(pilots.length === 1, "ADVANCE_PILOT");
    const pilot = pilots[0], full = jobs.filter((j) => j.cohort === "full");
    check(pilot.state === "failed" && pilot.lastOutcome === "not_sent" && pilot.fence === 64 && pilot.attempts === 1 && pilot.providerReceipt === null && pilot.leaseOwner === null && pilot.leaseUntil === null, "ADVANCE_PILOT");
    const history = (await client.query("select * from lba_release_campaign_attempts where operation_id=$1 order by fence", [pilot.operationId])).rows;
    check(history.length >= 1 && history.length <= 1e3 && history.every((a2) => a2.release_id === RELEASE && a2.spec_hash === c.specHash && Array.isArray(decode(a2.events))), "ADVANCE_HISTORY");
    const current = history.filter((a2) => Number(a2.fence) === 64);
    check(current.length === 1, "ADVANCE_HISTORY");
    const events = decode(current[0].events);
    check(events.some((e) => negative(Object.fromEntries(Object.entries(e).filter(([k]) => k !== "observedAt")))), "ADVANCE_NEGATIVE_EVENT");
    const nativeJobs = (await client.query("select * from lba_production_telegram_dispatch_jobs where operation_id=$1", [pilot.operationId])).rows;
    check(nativeJobs.length === 1, "ADVANCE_NATIVE_JOB");
    const n = nativeJobs[0], payload = decode(n.payload), envelope = payload?.campaign;
    check(n.bot_id === BOT && n.source_kind === "campaign" && n.source_id === pilot.operationId && n.recipient_ref === pilot.recipientRef && Number(n.control_epoch) === 1 && n.state === "not_sent" && n.provider_receipt === null && n.last_reason === "telegram_forbidden" && Number(n.fence) === 1 && Number(n.attempts) === 1 && hex(n.payload_digest) && digest(payload) === n.payload_digest, "ADVANCE_NATIVE_JOB");
    check(envelope && envelope.releaseId === RELEASE && envelope.deploymentId === DEPLOYMENT && envelope.buildSha256 === SOURCE && envelope.botId === BOT && envelope.origin === ORIGIN && envelope.operationId === pilot.operationId && envelope.recipientRef === pilot.recipientRef && envelope.text === s.text && envelope.appUrl === s.appUrl && payload.message?.id === pilot.operationId && payload.message?.text === s.text, "ADVANCE_NATIVE_PAYLOAD");
    const nativeAttempts = (await client.query("select * from lba_production_telegram_dispatch_attempts where operation_id=$1 order by fence", [pilot.operationId])).rows;
    check(nativeAttempts.length === 1, "ADVANCE_NATIVE_ATTEMPT");
    const a = nativeAttempts[0], outcome = decode(a.outcome), receipt = decode(a.receipt), date = (v) => v instanceof Date ? v.toISOString() : v;
    check(Number(a.fence) === 1 && Number(a.control_epoch) === 1 && a.state === "not_sent" && negative(outcome) && instant(date(a.prepared_at)) && instant(date(a.dispatch_marked_at)) && instant(date(a.finished_at)) && Date.parse(date(a.prepared_at)) <= Date.parse(date(a.dispatch_marked_at)) && Date.parse(date(a.dispatch_marked_at)) <= Date.parse(date(a.finished_at)), "ADVANCE_NATIVE_ATTEMPT");
    check(receipt && receipt.botId === BOT && receipt.operationId === pilot.operationId && receipt.recipientRef === pilot.recipientRef && instant(receipt.completedAt) && Date.parse(receipt.completedAt) >= Date.parse(date(a.dispatch_marked_at)) && Date.parse(receipt.completedAt) <= Date.parse(date(a.finished_at)) && Array.isArray(receipt.attempts) && receipt.attempts.length === 1, "ADVANCE_RECEIPT");
    const wire = receipt.attempts[0];
    check(wire.method === "sendMessage" && wire.providerAccepted === false && wire.providerErrorCode === 403 && wire.messageId === void 0 && hex(wire.requestSha256) && wire.requestSha256 !== "0".repeat(64) && receipt.fallback === void 0, "ADVANCE_RECEIPT");
    const evidence = { operationId: pilot.operationId, fence: 1, payloadDigest: n.payload_digest, dispatchMarkedAt: date(a.dispatch_marked_at), finishedAt: date(a.finished_at), outcome, receipt };
    const nativeDigest = digest(evidence), pilotDigest = digest(pilot), operationsDigest = campaignHash2(jobs.map((j) => j.operationId).sort());
    const certEvents = history.flatMap((a2) => decode(a2.events).filter((e) => e?.kind === "operator_advance" && e.reason === "verified_pilot_telegram_forbidden").map((event) => ({ attempt: a2, event })));
    if (certEvents.length) {
      check(certEvents.length === 1, "ADVANCE_CERTIFICATE");
      const { attempt, event } = certEvents[0], cert = event.operatorCertificate;
      check(cert?.kind === KIND && cert.releaseId === RELEASE && cert.sourceSha256 === SOURCE && cert.specHash === c.specHash && cert.authoritySha256 === AUTHORITY && cert.controlEpoch === 1 && cert.audienceDigest === s.audienceDigest && cert.operationIdsDigest === operationsDigest && cert.audience === 8 && cert.remaining === 7 && cert.pilotFence === 64 && cert.pilotSnapshotSha256 === pilotDigest && cert.nativeEvidenceSha256 === nativeDigest && cert.senderSha256 === SENDER && cert.transportSha256 === TRANSPORT && hex(cert.operatorSha256) && instant(cert.observedAt) && certificateHash(cert) === cert.certificateSha256 && Number(attempt.fence) === 64 && event.observedAt === cert.observedAt && event.deliveryOutcome === "not_sent" && ["full", "completed", "paused"].includes(c.phase), "ADVANCE_CERTIFICATE");
      return { already: true, certificate: cert };
    }
    check(c.phase === "paused" && c.pauseReason === "pilot_failed", "ADVANCE_PHASE");
    check(full.length === 7 && full.every((j) => j.state === "pending" && j.attempts === 0 && j.fence === 0 && j.lastOutcome === null && j.providerReceipt === null && j.leaseOwner === null && j.leaseUntil === null), "ADVANCE_FULL_PRISTINE");
    const fullNative = (await client.query("select (select count(*) from lba_production_telegram_dispatch_jobs where operation_id::text=any($1::text[]))::int as jobs,(select count(*) from lba_production_telegram_dispatch_attempts where operation_id::text=any($1::text[]))::int as attempts", [full.map((j) => j.operationId)])).rows[0];
    check(fullNative?.jobs === 0 && fullNative.attempts === 0, "ADVANCE_FULL_NATIVE");
    return { already: false, campaign: c, jobs, pilot, operationsDigest, pilotDigest, nativeDigest };
  }
  try {
    await begin("begin isolation level repeatable read read only");
    await backend();
    const prior = await inspect();
    await client.query("rollback");
    transaction = false;
    if (prior.already) return { kind: KIND, state: "already_advanced", certificate: prior.certificate };
    const health = apply ? await getHealth() : null;
    await begin(apply ? "begin isolation level read committed" : "begin isolation level read committed read only");
    await client.query("set local statement_timeout='20000ms'");
    await client.query("set local lock_timeout='15000ms'");
    for (const key of ["lba-update-campaign-global-v1", `lba-telegram-dispatch-bot:${BOT}`]) await client.query({ text: "select pg_advisory_xact_lock(hashtextextended($1,0))", values: [key], query_timeout: 21e3 });
    await client.query("set local statement_timeout='3000ms'");
    await client.query("set local lock_timeout='1000ms'");
    const now = await backend(), control = (await client.query("select control_epoch,writer_mode from lba_production_control where id=true" + (apply ? " for share" : ""))).rows;
    check(control.length === 1 && Number(control[0].control_epoch) === 1 && control[0].writer_mode === "canonical", "ADVANCE_CONTROL");
    const current = await inspect();
    if (current.already) {
      await client.query("rollback");
      transaction = false;
      return { kind: KIND, state: "already_advanced", certificate: current.certificate };
    }
    check(Date.parse(current.campaign.spec.createdAt) <= Date.parse(now) && Date.parse(now) < Date.parse(current.campaign.spec.expiresAt), "ADVANCE_WINDOW");
    const bot = (await client.query("select hold_reason,hold_operation from lba_production_telegram_bot_state where bot_id=$1" + (apply ? " for update" : ""), [BOT])).rows;
    check(bot.length === 1 && bot[0].hold_reason === null && bot[0].hold_operation === null, "ADVANCE_HOLD");
    const global = (await client.query(`select
   (select count(*) from lba_release_campaign_jobs j join lba_release_campaigns c on c.release_id=j.release_id where c.bot_id=$1 and j.record->>'state' in ('leased','dispatching','outcome_unknown','retry_wait'))::int as campaign_active,
   (select count(*) from lba_production_telegram_dispatch_jobs where bot_id=$1 and state in ('pending','prepared','dispatching','retry_wait','unknown','held'))::int as dispatch_active,
   (select count(*) from lba_production_telegram_dispatch_attempts a left join lba_production_telegram_dispatch_jobs j on j.operation_id=a.operation_id where (j.bot_id=$1 or j.operation_id is null) and a.state in ('prepared','dispatching','unknown'))::int as attempt_active,
   (select count(*) from lba_production_profile_outbox where status in ('dispatching','unknown'))::int as outbox_active`, [BOT])).rows[0];
    check(global && ["campaign_active", "dispatch_active", "attempt_active", "outbox_active"].every((k) => global[k] === 0), "ADVANCE_UNRESOLVED");
    if (apply) check(healthValid(health, now), "ADVANCE_HEALTH");
    const certificate = { kind: KIND, releaseId: RELEASE, sourceSha256: SOURCE, specHash: current.campaign.specHash, authoritySha256: AUTHORITY, controlEpoch: 1, audienceDigest: current.campaign.spec.audienceDigest, operationIdsDigest: current.operationsDigest, audience: 8, remaining: 7, pilotFence: 64, pilotSnapshotSha256: current.pilotDigest, nativeEvidenceSha256: current.nativeDigest, senderSha256: SENDER, transportSha256: TRANSPORT, operatorSha256, observedAt: now, healthObservedAt: health?.observedAt ?? null, getMeEvidence: "inferred_from_pinned_dispatch_marker_and_actual_sendMessage_403" };
    certificate.certificateSha256 = certificateHash(certificate);
    if (!apply) {
      await client.query("rollback");
      transaction = false;
      return { kind: KIND, state: "plan", certificate, changes: { campaignPhase: "full", pendingRecipients: 7, providerCalls: 0 } };
    }
    const event = { kind: "operator_advance", reason: "verified_pilot_telegram_forbidden", deliveryOutcome: "not_sent", observedAt: now, operatorCertificate: certificate };
    const appended = await client.query("update lba_release_campaign_attempts set events=events||$3::jsonb where operation_id=$1 and fence=$2", [current.pilot.operationId, 64, JSON.stringify([event])]);
    check(appended.rowCount === 1, "ADVANCE_FENCE");
    const changed = { ...current.campaign, phase: "full", pauseReason: null };
    const updated = await client.query("update lba_release_campaigns set record=$2::jsonb where release_id=$1 and spec_hash=$3", [RELEASE, JSON.stringify(changed), current.campaign.specHash]);
    check(updated.rowCount === 1, "ADVANCE_FENCE");
    await client.query("commit");
    transaction = false;
    return { kind: KIND, state: "advanced", certificate };
  } catch (e) {
    if (timedOut) fail("ADVANCE_TIMEOUT");
    throw e;
  } finally {
    clearTimeout(deadline);
    if (transaction && !destroyed) try {
      await client.query("rollback");
    } catch {
    }
    if (!destroyed) client.release();
  }
}
function verify() {
  const app = path.resolve(__dirname, "../app"), v = createRequire(__filename)("./verify-prebuilt.cjs").verify();
  check(v.sourceSha256 === SOURCE, "ADVANCE_SOURCE");
  check(sha(fs.readFileSync(path.join(app, "server/production/telegram-dispatch.ts"))) === SENDER && sha(fs.readFileSync(path.join(app, "server/production/telegram-transport.ts"))) === TRANSPORT, "ADVANCE_SENDER");
  return { kind: "lba-unreachable-pilot-advance-config/1", sourceSha256: SOURCE, operatorSha256: sha(fs.readFileSync(__filename)), databaseConnected: false, providerCalls: 0 };
}
async function run({ apply = false } = {}) {
  let pool;
  try {
    const verified = verify();
    check(typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0, "ADVANCE_DATABASE_CONFIG");
    const config = JSON.parse(process.env.LBA_RELEASE_NOTICE_CONFIG || "null");
    check(config?.kind === "lba-release-notice/1" && config.releaseId === RELEASE && config.deploymentRef === DEPLOYMENT && config.buildSha256 === SOURCE && config.authoritySha256 === AUTHORITY && config.controlEpoch === 1, "ADVANCE_AUTHORITY");
    const { Pool } = createRequire(path.resolve(__dirname, "../app/package.json"))("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5e3, idleTimeoutMillis: 1e3, query_timeout: 4e3 });
    pool.on("error", () => {
    });
    return await advanceWithPool(pool, { apply, operatorSha256: verified.operatorSha256, expectedSpecHash: SPEC, expectedAudienceDigest: AUDIENCE });
  } catch (e) {
    fail(typeof e?.message === "string" && /^ADVANCE_[A-Z_]+$/.test(e.message) ? e.message : "ADVANCE_UNCONFIRMED");
  } finally {
    if (pool) await pool.end();
  }
}
async function main() {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--verify") {
      console.log(JSON.stringify(verify()));
      return;
    }
    check(process.argv.length === 3 && ["--plan", "--apply"].includes(process.argv[2]), "ADVANCE_ARGUMENTS");
    console.log(JSON.stringify(await run({ apply: process.argv[2] === "--apply" })));
  } catch (e) {
    console.error(JSON.stringify({ kind: KIND, success: false, code: /^ADVANCE_[A-Z_]+$/.test(e?.message) ? e.message : "ADVANCE_UNCONFIRMED" }));
    process.exitCode = 1;
  }
}
module.exports = { advanceWithPool, run, verify, main };
if (require.main === module) void main();
