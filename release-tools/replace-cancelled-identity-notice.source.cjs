'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createRequire} = require('node:module');
const {
  UPDATE_ANNOUNCEMENT_UA, campaignHash, campaignId, campaignInstant, campaignOperationId,
  campaignSpecHash, prepareCampaignSpec,
} = require('../app/server/release/update-campaign.ts');
const {productionRuntimePolicy} = require('../app/server/runtime-policy.ts');

const KIND = 'lba-identity-cancelled-notice-replacement/1';
const EVENT = 'operator_replace_identity_cancelled_notice';
const CAMPAIGN_LOCK = 'lba-update-campaign-global-v1';
const EXPIRY = '2026-11-11T12:54:30.870Z';
const INITIAL_WINDOW = '2026-11-10T22:53:00.000Z';
const OLD_WINDOW = '2026-11-10T22:24:00.000Z';
const PRODUCTION_PINS = Object.freeze({
  oldReleaseId: 'lba-v8-idle-fc244e31-20261111-r3',
  oldDeploymentRef: 'lba-release:idle-fc244e31-20261111-r3',
  oldSourceSha256: 'fd4ebd4cb2e0a95defba674d7323b112bb7ae04fb5734bc0b2ac1741abb8daf9',
  oldSpecHash: '8a2e238cd3325cfe944ac9ee2f79935ab4f8b0818879cdff792a069fc25ab60f',
  audienceDigest: '4998040c6c58df6eab51402e72aa7b6fd34cd18879a81f4a349fdb80223a9a0b',
  previousReleaseId: 'lba-v8-dispatch-768f1d60-20261110-r2',
  previousDeploymentRef: 'lba-release:dispatch-768f1d60-20261110-r2',
  previousSourceSha256: '768f1d605d91d6b917691d1bb9aa9d83d24ac17c3dc15d50127c0939f1476126',
  previousSpecHash: '25f32d7ce0319b12acc6ffbd4998dc5af4a74373e26b96148c441563e032844d',
  previousCertificateSha256: 'c12856ea7fec34c631be50933249138b070334b29fd11128f9f286052655c904',
  previousOperatorSha256: '28d96d1118f3930483f1dc67fa6c61523d4ff5dcc1992d73919aed77735ed8ae',
  previousPilotCertificateSha256: '3dd3141863feddfb38c97204d7bf3029eff0dc562a588c76ae7b2c1e1577799f',
  previousRecoveryCertificateSha256: '4b698aa0a9663fc0e8f0ab87129eca884c68119f777524373a0c6aa836da0eb4',
  previousObservedAt: '2026-11-10T22:49:35.808Z',
  dispatchStartedAt: '2026-11-10T22:49:48.177Z',
  unknownObservedAt: '2026-11-10T22:50:27.247Z',
  leaseUntil: '2026-11-10T22:50:46.848Z',
  nativePreparedAt: '2026-11-10T22:50:38.848Z',
  nativeFinishedAt: '2026-11-10T22:50:45.150Z',
  nativeNotBefore: '2026-11-10T22:50:46.361Z',
  newReleaseId: 'lba-v8-notice-deadline-20261111-r4',
  newDeploymentRef: 'lba-release:notice-deadline-20261111-r4',
  newSourceSha256: '9be789cb0afe4099a8bac4d19a728ea8290e4e146df5c23769f6554f79d6eb27',
  authoritySha256: '613b008586fe302bc4cbdd45d4f34ae2eb45d2c050ddbf4c459747ac22e5a2bc',
  oldSenderSha256: 'dc52d97c21310265e9b9f296ce4a3c7fd039ab1223fa8b2f8372b183170483b9',
  oldTransportSha256: '4b3469e5566feb73956f18987c75cc36baf206fd246bc6a02ab04cf4ce7e36b6',
  botId: '8577497098',
  origin: 'https://power-ukraine.net',
});
const POLICY_SOURCE = '53f3a9eea4c8648ed717939699f29d16d0264928f8ce0f17f48fff33c76dde5c';
const ENVIRONMENT = '302a2c28f5b8899c639d4648117a2274da3515504a963c71e3309474789b310d';
const STATES = new Set(['pending','leased','dispatching','retry_wait','outcome_unknown','sent','cancelled','failed']);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const decode = value => typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
const iso = value => value instanceof Date ? value.toISOString() : value;
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const digest = value => hash(canonical(value));
function check(condition, code) {
  if (!condition) throw Error(code);
}
function certificateDigest(certificate) {
  const unsigned = {...certificate};
  delete unsigned.certificateSha256;
  return digest(unsigned);
}
function validateJob(row, spec) {
  const job = decode(row.record);
  check(job && job.operationId === row.operation_id && job.releaseId === row.release_id &&
    job.releaseId === spec.releaseId && job.recipientRef === row.recipient_ref && job.cohort === row.cohort &&
    job.operationId === campaignOperationId(spec.releaseId, job.recipientRef) && job.botId === spec.botId &&
    job.cohort === (spec.pilotRecipientRefs.includes(job.recipientRef) ? 'pilot' : 'full') &&
    STATES.has(job.state) && Number.isSafeInteger(job.fence) && job.fence >= 0 &&
    Number.isSafeInteger(job.attempts) && job.attempts >= 0 && campaignInstant(job.nextAttemptAt) &&
    (job.leaseUntil === null || campaignInstant(job.leaseUntil)) &&
    (job.leaseOwner === null || campaignId(job.leaseOwner)), 'REPLACE_JOB_BINDING');
  return job;
}
function pristine(job, state, outcome) {
  return job.state === state && job.fence === 0 && job.attempts === 0 &&
    job.leaseOwner === null && job.leaseUntil === null && job.providerReceipt === null && job.lastOutcome === outcome;
}
function matchingAttempt(row, operationId, releaseId, specHash) {
  return row?.operation_id === operationId && row.release_id === releaseId && row.spec_hash === specHash &&
    Array.isArray(decode(row.events));
}
function oldSpecMatches(spec, pins) {
  return spec?.version === 'lba-update-campaign/1' && spec.releaseId === pins.oldReleaseId &&
    spec.deploymentId === pins.oldDeploymentRef && spec.buildSha256 === pins.oldSourceSha256 &&
    spec.botId === pins.botId && spec.origin === pins.origin && spec.appUrl === pins.origin + '/' &&
    spec.text === UPDATE_ANNOUNCEMENT_UA && spec.createdAt === OLD_WINDOW && spec.expiresAt === EXPIRY &&
    spec.maxAttempts === 3 && Array.isArray(spec.pilotRecipientRefs) && spec.pilotRecipientRefs.length === 1 &&
    spec.audienceDigest === pins.audienceDigest && campaignSpecHash(spec) === pins.oldSpecHash;
}

async function inspectPreviousReplacement(client, currentJobs, pins) {
  const rows = (await client.query('select * from lba_release_campaigns where release_id=$1', [pins.previousReleaseId])).rows;
  const row = rows[0], prior = decode(row?.record), spec = prior?.spec;
  check(rows.length === 1 && row.bot_id === pins.botId && row.spec_hash === pins.previousSpecHash &&
    prior?.specHash === pins.previousSpecHash && prior.phase === 'completed' && prior.pauseReason === null &&
    spec?.releaseId === pins.previousReleaseId && spec.deploymentId === pins.previousDeploymentRef &&
    spec.buildSha256 === pins.previousSourceSha256 && spec.botId === pins.botId && spec.origin === pins.origin &&
    spec.audienceDigest === pins.audienceDigest && campaignSpecHash(spec) === pins.previousSpecHash, 'REPLACE_PREVIOUS_BINDING');
  const raw = (await client.query('select * from lba_release_campaign_jobs where release_id=$1 order by operation_id limit 9', [pins.previousReleaseId])).rows;
  const jobs = raw.map(item => validateJob(item, spec));
  const pilot = jobs.find(job => job.cohort === 'pilot');
  const full = jobs.filter(job => job.cohort === 'full');
  const currentPilot = currentJobs.find(job => job.cohort === 'pilot');
  check(jobs.length === 8 && full.length === 7 && pilot?.recipientRef === currentPilot?.recipientRef &&
    pilot.state === 'failed' && pilot.lastOutcome === 'not_sent' && pilot.providerReceipt === null &&
    pilot.fence === 64 && pilot.attempts === 1, 'REPLACE_PREVIOUS_PILOT');
  const history = (await client.query(`select operation_id,release_id,spec_hash,events
    from lba_release_campaign_attempts where operation_id=$1 and fence=15`, [full[0].operationId])).rows;
  check(history.length === 1 && matchingAttempt(history[0], full[0].operationId, pins.previousReleaseId, pins.previousSpecHash), 'REPLACE_PREVIOUS_CERTIFICATE');
  const event = decode(history[0].events).at(-1), cert = event?.operatorCertificate;
  check(event?.kind === 'operator_replace_unissued_notice' && event.reason === 'verified_no_native_attempt_replaced' &&
    event.deliveryOutcome === 'not_issued' && cert?.kind === 'lba-unissued-notice-replacement/1' &&
    cert.certificateSha256 === pins.previousCertificateSha256 && certificateDigest(cert) === cert.certificateSha256 &&
    cert.operatorSha256 === pins.previousOperatorSha256 && cert.observedAt === pins.previousObservedAt &&
    event.observedAt === cert.observedAt && cert.oldReleaseId === pins.previousReleaseId &&
    cert.oldSourceSha256 === pins.previousSourceSha256 && cert.oldSpecHash === pins.previousSpecHash &&
    cert.newReleaseId === pins.oldReleaseId && cert.newSourceSha256 === pins.oldSourceSha256 && cert.newSpecHash === pins.oldSpecHash &&
    cert.authoritySha256 === pins.authoritySha256 && cert.controlEpoch === 1 && cert.audienceDigest === pins.audienceDigest &&
    cert.oldPilotCertificateSha256 === pins.previousPilotCertificateSha256 && cert.oldRecoveryCertificateSha256 === pins.previousRecoveryCertificateSha256 &&
    cert.retiredJobsSha256 === digest(jobs) && cert.oldFullOperationDigest === campaignHash(full.map(job => job.operationId).sort()) &&
    cert.newOperationDigest === campaignHash(currentJobs.map(job => job.operationId).sort()) &&
    cert.originalAudience === 8 && cert.pendingReplacement === 7 && cert.excludedForbidden === 1 &&
    cert.nativeJobs === 0 && cert.nativeAttempts === 0 && cert.nativeMarks === 0 && cert.nativeReceipts === 0, 'REPLACE_PREVIOUS_CERTIFICATE');
  return full.map(job => job.operationId);
}

function inspectTargetHistory(rows, target, pins) {
  check(rows.length === 1 && Number(rows[0].fence) === 1 &&
    matchingAttempt(rows[0], target.operationId, pins.oldReleaseId, pins.oldSpecHash), 'REPLACE_TARGET_HISTORY');
  const current = rows[0], events = decode(current.events), last = events.at(-1);
  const replaced = last?.kind === EVENT;
  const prefix = replaced ? events.slice(0, -1) : events;
  check(prefix.length === 2 && canonical(prefix[0]) === canonical({kind:'dispatching',observedAt:pins.dispatchStartedAt}) &&
    canonical(prefix[1]) === canonical({kind:'unknown',reason:'coordinator_unconfirmed',observedAt:pins.unknownObservedAt}) &&
    Date.parse(pins.dispatchStartedAt) <= Date.parse(pins.unknownObservedAt), 'REPLACE_CURRENT_HISTORY');
  return {current, prefix, replacement:replaced ? last : null};
}

async function inspectCancelledIdentity(client, target, spec, pins, retiredAt) {
  const jobs = (await client.query(`select operation_id,bot_id,source_kind,source_id,recipient_ref,recipient_kind,
    owner_id,session_id,source_revision,source_ordinal,control_epoch,chat_key,mapping_revision,payload_digest,payload,
    state,fence,attempts,not_before,provider_receipt,last_reason,updated_at
    from lba_production_telegram_dispatch_jobs where operation_id=$1 limit 2`, [target.operationId])).rows;
  const attempts = (await client.query(`select operation_id,fence,worker_id,control_epoch,state,prepared_at,
    dispatch_marked_at,finished_at,outcome,receipt from lba_production_telegram_dispatch_attempts
    where operation_id=$1 order by fence limit 2`, [target.operationId])).rows;
  check(jobs.length === 1 && attempts.length === 1, 'REPLACE_IDENTITY_JOURNAL_COUNT');
  const job = jobs[0], attempt = attempts[0], payload = decode(job.payload), outcome = decode(attempt.outcome);
  check(job.operation_id === target.operationId && job.bot_id === pins.botId && job.source_kind === 'campaign' &&
    job.source_id === target.operationId && job.recipient_ref === target.recipientRef &&
    /^legacy:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(job.recipient_ref) &&
    job.recipient_kind === 'legacy_subscription' && job.owner_id === null && job.session_id === null &&
    Number(job.source_revision) === 0 && Number(job.source_ordinal) === 0 && Number(job.control_epoch) === 1 &&
    hex(job.chat_key) && /^legacy-mapping:[a-f0-9]{64}$/.test(job.mapping_revision) && Number(job.fence) === 1 &&
    Number(job.attempts) === 1 && job.provider_receipt === null && hex(job.payload_digest) &&
    digest(payload) === job.payload_digest, 'REPLACE_IDENTITY_JOB');
  const envelope = {
    releaseId:spec.releaseId,deploymentId:spec.deploymentId,buildSha256:spec.buildSha256,botId:spec.botId,
    origin:spec.origin,operationId:target.operationId,recipientRef:target.recipientRef,text:spec.text,appUrl:spec.appUrl,
  };
  const expectedPayload = {message:{id:target.operationId,kind:'reply',text:spec.text,buttons:[],commitBarrier:'none'},campaign:envelope};
  check(canonical(payload) === canonical(expectedPayload), 'REPLACE_IDENTITY_PAYLOAD');
  check(attempt.operation_id === target.operationId && Number(attempt.fence) === 1 && Number(attempt.control_epoch) === 1 &&
    typeof attempt.worker_id === 'string' && attempt.worker_id.length > 0 && attempt.state === 'not_dispatched' &&
    attempt.dispatch_marked_at === null && attempt.receipt === null && iso(attempt.prepared_at) === pins.nativePreparedAt &&
    iso(attempt.finished_at) === pins.nativeFinishedAt && Date.parse(pins.nativePreparedAt) <= Date.parse(pins.nativeFinishedAt) &&
    canonical(outcome) === canonical({kind:'not_sent',retryable:false,reason:'telegram_cancelled_before_dispatch'}), 'REPLACE_IDENTITY_OUTCOME');
  if (retiredAt) {
    check(job.state === 'cancelled' && job.last_reason === 'operator_verified_not_issued_replaced' &&
      job.not_before === null && iso(job.updated_at) === retiredAt, 'REPLACE_IDENTITY_RETIREMENT');
  } else {
    check(job.state === 'retry_wait' && job.last_reason === 'identity_unverified' &&
      iso(job.not_before) === pins.nativeNotBefore && Date.parse(pins.nativeFinishedAt) <= Date.parse(pins.nativeNotBefore), 'REPLACE_IDENTITY_JOB');
  }
  const identity = {
    operationId:job.operation_id,botId:job.bot_id,sourceKind:job.source_kind,sourceId:job.source_id,
    recipientRef:job.recipient_ref,recipientKind:job.recipient_kind,controlEpoch:1,fence:1,attempts:1,
    sourceRevision:0,sourceOrdinal:0,chatKey:job.chat_key,mappingRevision:job.mapping_revision,payloadDigest:job.payload_digest,
  };
  const proof = {...attempt,prepared_at:iso(attempt.prepared_at),finished_at:iso(attempt.finished_at),outcome};
  return {nativeJobIdentitySha256:digest(identity),nativeAttemptSha256:digest(proof)};
}

async function requireNoNative(client, operationIds) {
  const counts = (await client.query(`select
    (select count(*) from lba_production_telegram_dispatch_jobs where operation_id::text=any($1::text[]))::int as jobs,
    (select count(*) from lba_production_telegram_dispatch_attempts where operation_id::text=any($1::text[]))::int as attempts`, [operationIds])).rows[0];
  check(counts?.jobs === 0 && counts.attempts === 0, 'REPLACE_NATIVE_PRESENT');
}

/** An injected pool lets tests exercise the actual SQL without production credentials. */
async function replaceWithPool(pool, {pins = PRODUCTION_PINS, operatorSha256} = {}) {
  check(pool && typeof pool.connect === 'function' && hex(operatorSha256), 'REPLACE_OPTIONS');
  const client = await pool.connect();
  let transaction = false, timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { client.release(Error('REPLACE_TIMEOUT')); } catch {}
  }, 20000);
  async function begin(statement) {
    await client.query(statement);
    transaction = true;
    await client.query("set local statement_timeout='2000ms'");
    await client.query("set local lock_timeout='1000ms'");
  }
  async function readPrimaryTime() {
    const row = (await client.query(`select pg_is_in_recovery() as recovery,
      current_setting('default_transaction_read_only') as default_ro,
      to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as observed_at`)).rows[0];
    check(row?.recovery === false && row.default_ro === 'off' && campaignInstant(row.observed_at), 'REPLACE_PRIMARY');
    return row.observed_at;
  }
  async function inspect(now) {
    const rows = (await client.query('select * from lba_release_campaigns where release_id=any($1::text[])', [[pins.oldReleaseId, pins.newReleaseId]])).rows;
    const old = rows.find(row => row.release_id === pins.oldReleaseId);
    const replacement = rows.find(row => row.release_id === pins.newReleaseId);
    const campaign = decode(old?.record), spec = campaign?.spec;
    check(old?.bot_id === pins.botId && old.spec_hash === pins.oldSpecHash && campaign.specHash === pins.oldSpecHash && oldSpecMatches(spec, pins), 'REPLACE_OLD_BINDING');
    const oldRows = (await client.query('select * from lba_release_campaign_jobs where release_id=$1 order by operation_id limit 9', [pins.oldReleaseId])).rows;
    const jobs = oldRows.map(row => validateJob(row, spec));
    const refs = jobs.map(job => job.recipientRef);
    check(jobs.length === 8 && new Set(refs).size === 8 && campaignHash([...refs].sort()) === pins.audienceDigest, 'REPLACE_AUDIENCE');
    const pilot = jobs.find(job => job.cohort === 'pilot'), full = jobs.filter(job => job.cohort === 'full');
    check(pilot && full.length === 7, 'REPLACE_AUDIENCE');
    const target = full[0];
    check(pristine(pilot, 'cancelled', 'predecessor_telegram_forbidden'), 'REPLACE_EXCLUDED_PILOT');
    const previousFullIds = await inspectPreviousReplacement(client, jobs, pins);
    const history = (await client.query(`select operation_id,release_id,spec_hash,worker_id,fence,events
      from lba_release_campaign_attempts where operation_id=$1 order by fence limit 2`, [target.operationId])).rows;
    const {current, prefix, replacement: event} = inspectTargetHistory(history, target, pins);
    const identityProof = await inspectCancelledIdentity(client, target, spec, pins, event?.operatorCertificate?.observedAt);
    const absentOldIds = [...previousFullIds, ...jobs.filter(job => job.operationId !== target.operationId).map(job => job.operationId)];
    const nextSpec = prepareCampaignSpec({
      releaseId: pins.newReleaseId, deploymentId: pins.newDeploymentRef, buildSha256: pins.newSourceSha256,
      botId: pins.botId, origin: pins.origin, text: spec.text, appUrl: spec.appUrl,
      createdAt: INITIAL_WINDOW, expiresAt: EXPIRY, pilotRecipientRefs: [pilot.recipientRef], maxAttempts: 3,
    }, refs);
    const nextHash = campaignSpecHash(nextSpec);
    const nextJobs = jobs.map(job => ({
      operationId: campaignOperationId(nextSpec.releaseId, job.recipientRef), releaseId: nextSpec.releaseId,
      botId: pins.botId, recipientRef: job.recipientRef, cohort: job.cohort,
      state: job.cohort === 'pilot' ? 'cancelled' : 'pending', fence: 0, attempts: 0,
      nextAttemptAt: INITIAL_WINDOW, leaseOwner: null, leaseUntil: null, providerReceipt: null,
      lastOutcome: job.cohort === 'pilot' ? 'predecessor_telegram_forbidden' : null,
    }));
    check(nextSpec.audienceDigest === pins.audienceDigest && nextJobs.every(next => !jobs.some(old => old.operationId === next.operationId)), 'REPLACE_NEW_AUDIENCE');
    const retired = jobs.map(job => {
      if (job.cohort === 'pilot') return job;
      if (job.operationId === target.operationId) return {...job, state:'failed', leaseOwner:null, leaseUntil:null, lastOutcome:'operator_verified_not_issued'};
      return {...job, state:'cancelled', lastOutcome:'transferred_to_replacement_notice'};
    });
    function certificate(observedAt, retiredJobs) {
      const unsigned = {
        kind: KIND, oldReleaseId: pins.oldReleaseId, oldSourceSha256: pins.oldSourceSha256, oldSpecHash: pins.oldSpecHash,
        newReleaseId: pins.newReleaseId, newSourceSha256: pins.newSourceSha256, newSpecHash: nextHash,
        authoritySha256: pins.authoritySha256, controlEpoch: 1, audienceDigest: pins.audienceDigest,
        previousReplacementCertificateSha256: pins.previousCertificateSha256,
        oldSenderSha256: pins.oldSenderSha256, oldTransportSha256:pins.oldTransportSha256, operatorSha256, oldFullOperationDigest: campaignHash(full.map(job => job.operationId).sort()),
        newOperationDigest: campaignHash(nextJobs.map(job => job.operationId).sort()), targetHistoryPrefixSha256: digest(prefix),
        retiredJobsSha256: digest(retiredJobs), originalFence: 1, originalAttempts: 1,
        ...identityProof, nativeJobsRetired: 1, nativeAttemptsPreserved: 1, nativeMarks: 0, nativeReceipts: 0,
        nativePreparedAt:pins.nativePreparedAt,nativeFinishedAt:pins.nativeFinishedAt,nativePreviousNotBefore:pins.nativeNotBefore,
        nativeProof:'identity_not_dispatched_telegram_cancelled_before_dispatch',
        originalAudience: 8, pendingReplacement: 7, excludedForbidden: 1, observedAt,
      };
      return {...unsigned, certificateSha256: digest(unsigned)};
    }

    if (replacement || event) {
      check(replacement && event && campaign.phase === 'completed' && campaign.pauseReason === null &&
        target.state === 'failed' && target.fence === 1 && target.attempts === 1 && target.providerReceipt === null &&
        target.leaseOwner === null && target.leaseUntil === null && target.lastOutcome === 'operator_verified_not_issued' &&
        full.slice(1).every(job => pristine(job, 'cancelled', 'transferred_to_replacement_notice')), 'REPLACE_REPLAY_CONFLICT');
      const saved = event.operatorCertificate;
      check(event.reason === 'verified_identity_cancelled_before_dispatch_replaced' && event.deliveryOutcome === 'not_issued' &&
        campaignInstant(saved?.observedAt) && event.observedAt === saved.observedAt &&
        Date.parse(saved.observedAt) >= Date.parse(INITIAL_WINDOW) && Date.parse(saved.observedAt) < Date.parse(EXPIRY) &&
        canonical(saved) === canonical(certificate(saved.observedAt, jobs)), 'REPLACE_CERTIFICATE');
      const replacementRecord = decode(replacement.record);
      check(replacement.bot_id === pins.botId && replacement.spec_hash === nextHash && replacementRecord?.specHash === nextHash &&
        canonical(replacementRecord.spec) === canonical(nextSpec) && ['full','paused','completed'].includes(replacementRecord.phase), 'REPLACE_NEW_SCOPE');
      const replacementRows = (await client.query('select * from lba_release_campaign_jobs where release_id=$1 order by operation_id limit 9', [pins.newReleaseId])).rows;
      const live = replacementRows.map(row => validateJob(row, nextSpec));
      check(live.length === 8 && campaignHash(live.map(job => job.operationId).sort()) === saved.newOperationDigest, 'REPLACE_NEW_AUDIENCE');
      const excluded = live.find(job => job.cohort === 'pilot');
      check(excluded && canonical(excluded) === canonical(nextJobs.find(job => job.cohort === 'pilot')), 'REPLACE_EXCLUDED_PILOT');
      await requireNoNative(client, [...absentOldIds, excluded.operationId]);
      return {replayed:true, certificate:saved};
    }

    check(campaign.phase === 'paused' && campaign.pauseReason === 'dispatch_outcome_unknown' &&
      target.state === 'outcome_unknown' && target.lastOutcome === 'coordinator_unconfirmed' && target.fence === 1 && target.attempts === 1 &&
      target.providerReceipt === null && typeof target.leaseOwner === 'string' && target.leaseOwner === current.worker_id &&
      target.leaseUntil === pins.leaseUntil && Date.parse(target.leaseUntil) < Date.parse(now) &&
      full.slice(1).every(job => pristine(job, 'pending', null)), 'REPLACE_TARGET_STATE');
    check(Date.parse(now) >= Date.parse(INITIAL_WINDOW) && Date.parse(now) < Date.parse(EXPIRY) &&
      Date.parse(pins.unknownObservedAt) <= Date.parse(now), 'REPLACE_WINDOW');
    await requireNoNative(client, [...absentOldIds, ...nextJobs.map(job => job.operationId)]);
    return {replayed:false, certificate:certificate(now, retired), campaign, target, retired, nextSpec, nextHash, nextJobs};
  }

  try {
    const exists = (await client.query('select 1 from lba_release_campaigns where release_id=$1', [pins.newReleaseId])).rows.length > 0;
    if (exists) {
      await begin('begin isolation level repeatable read read only');
      const prior = await inspect(await readPrimaryTime());
      check(prior.replayed, 'REPLACE_REPLAY_CONFLICT');
      await client.query('rollback'); transaction = false;
      return {kind:KIND, state:'already_replaced', certificate:prior.certificate};
    }
    await begin('begin isolation level read committed');
    await client.query("set local statement_timeout='11000ms'");
    await client.query("set local lock_timeout='10000ms'");
    for (const key of [CAMPAIGN_LOCK, `lba-telegram-dispatch-bot:${pins.botId}`]) {
      await client.query({text:'select pg_advisory_xact_lock(hashtextextended($1,0))', values:[key], query_timeout:11500});
    }
    await client.query("set local statement_timeout='2000ms'");
    await client.query("set local lock_timeout='1000ms'");
    // All mutation evidence is read after both locks. No pre-lock snapshot is reused.
    const prepared = await inspect(await readPrimaryTime());
    if (prepared.replayed) {
      await client.query('rollback'); transaction = false;
      return {kind:KIND, state:'already_replaced', certificate:prepared.certificate};
    }
    const control = (await client.query('select control_epoch,writer_mode from lba_production_control where id=true for share')).rows;
    check(control.length === 1 && Number(control[0].control_epoch) === 1 && control[0].writer_mode === 'canonical', 'REPLACE_CONTROL');
    const bot = (await client.query('select hold_reason,hold_operation from lba_production_telegram_bot_state where bot_id=$1 for update', [pins.botId])).rows;
    check(bot.length === 1 && bot[0].hold_reason === null && bot[0].hold_operation === null, 'REPLACE_HOLD');
    const active = (await client.query(`select
      (select count(*) from lba_release_campaign_jobs j join lba_release_campaigns c on c.release_id=j.release_id
        where c.bot_id=$1 and j.operation_id<>$2 and j.record->>'state' in ('leased','dispatching','outcome_unknown','retry_wait'))::int as campaigns,
      (select count(*) from lba_production_telegram_dispatch_jobs where bot_id=$1 and operation_id::text<>$2 and state in ('pending','prepared','dispatching','retry_wait','unknown','held'))::int as jobs,
      (select count(*) from lba_production_telegram_dispatch_attempts a left join lba_production_telegram_dispatch_jobs j on j.operation_id=a.operation_id
        where (j.bot_id=$1 or j.operation_id is null) and a.state in ('prepared','dispatching','unknown'))::int as attempts,
      (select count(*) from lba_production_profile_outbox where status in ('dispatching','unknown'))::int as outbox`, [pins.botId, prepared.target.operationId])).rows[0];
    check(active && ['campaigns','jobs','attempts','outbox'].every(key => active[key] === 0), 'REPLACE_OTHER_UNRESOLVED');

    const certificate = prepared.certificate;
    // The terminal identity branch committed before any message marker or native effect.
    const nativeRetired = await client.query(`update lba_production_telegram_dispatch_jobs
      set state='cancelled',last_reason='operator_verified_not_issued_replaced',not_before=null,updated_at=$3
      where operation_id=$1 and bot_id=$2 and source_kind='campaign' and source_id=$1::text and control_epoch=1
        and recipient_kind='legacy_subscription' and fence=1 and attempts=1 and state='retry_wait'
        and last_reason='identity_unverified' and not_before=$4 and provider_receipt is null`,
      [prepared.target.operationId,pins.botId,certificate.observedAt,pins.nativeNotBefore]);
    check(nativeRetired.rowCount === 1, 'REPLACE_NATIVE_RETIREMENT_FENCE');
    const event = {kind:EVENT, reason:'verified_identity_cancelled_before_dispatch_replaced', deliveryOutcome:'not_issued', observedAt:certificate.observedAt, operatorCertificate:certificate};
    const appended = await client.query(`update lba_release_campaign_attempts set events=events||$3::jsonb
      where operation_id=$1 and fence=1 and spec_hash=$2`, [prepared.target.operationId, pins.oldSpecHash, JSON.stringify([event])]);
    check(appended.rowCount === 1, 'REPLACE_WRITE_FENCE');
    const transferred = prepared.retired.filter(job => job.cohort === 'full').map(job => ({operation_id:job.operationId,record:job}));
    const retired = await client.query(`update lba_release_campaign_jobs j set record=x.record
      from jsonb_to_recordset($2::jsonb) as x(operation_id text,record jsonb)
      where j.release_id=$1 and j.operation_id=x.operation_id`, [pins.oldReleaseId, JSON.stringify(transferred)]);
    check(retired.rowCount === 7, 'REPLACE_WRITE_FENCE');
    const closed = await client.query(`update lba_release_campaigns set record=$2::jsonb
      where release_id=$1 and spec_hash=$3`, [pins.oldReleaseId, JSON.stringify({...prepared.campaign,phase:'completed',pauseReason:null}), pins.oldSpecHash]);
    check(closed.rowCount === 1, 'REPLACE_WRITE_FENCE');
    const next = {spec:prepared.nextSpec,specHash:prepared.nextHash,phase:'full',pauseReason:null};
    const inserted = await client.query(`insert into lba_release_campaigns(release_id,bot_id,spec_hash,record)
      values($1,$2,$3,$4::jsonb)`, [pins.newReleaseId,pins.botId,prepared.nextHash,JSON.stringify(next)]);
    check(inserted.rowCount === 1, 'REPLACE_WRITE_FENCE');
    const newRows = prepared.nextJobs.map(job => ({operation_id:job.operationId,release_id:job.releaseId,recipient_ref:job.recipientRef,cohort:job.cohort,record:job}));
    const seeded = await client.query(`insert into lba_release_campaign_jobs(operation_id,release_id,recipient_ref,cohort,record)
      select x.operation_id,x.release_id,x.recipient_ref,x.cohort,x.record
      from jsonb_to_recordset($1::jsonb) as x(operation_id text,release_id text,recipient_ref text,cohort text,record jsonb)`, [JSON.stringify(newRows)]);
    check(seeded.rowCount === 8, 'REPLACE_WRITE_FENCE');
    await client.query('commit'); transaction = false;
    return {kind:KIND, state:'replaced', certificate};
  } catch (error) {
    if (timedOut) throw Error('REPLACE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
    if (transaction && !timedOut) await client.query('rollback').catch(() => {});
    if (!timedOut) client.release();
  }
}

function verify() {
  const localRequire = createRequire(__filename);
  const verified = localRequire('./verify-prebuilt.cjs').verify();
  check(verified.sourceSha256 === PRODUCTION_PINS.newSourceSha256 && verified.sourceInputs === 315 && verified.buildArtifacts === 17, 'REPLACE_BUILD');
  const app = path.resolve(__dirname,'../app');
  check(hash(fs.readFileSync(path.join(app,'server/runtime-policy.ts'))) === POLICY_SOURCE &&
    hash(fs.readFileSync(path.join(__dirname,'production-environment.cjs'))) === ENVIRONMENT, 'REPLACE_POLICY_DRIFT');
  return {kind:'lba-replace-cancelled-identity-notice-config/1',...verified,operatorSha256:hash(fs.readFileSync(__filename)),databaseConnected:false,providerCalls:0};
}
function productionGuard() {
  check(process.env.NODE_ENV === 'production' && process.env.LBA_CANONICAL_CONTROL_EPOCH === '1', 'REPLACE_ENVIRONMENT');
  const expected = {
    kind:'lba-release-notice/1', releaseId:PRODUCTION_PINS.newReleaseId, deploymentRef:PRODUCTION_PINS.newDeploymentRef,
    buildSha256:PRODUCTION_PINS.newSourceSha256, authoritySha256:PRODUCTION_PINS.authoritySha256,
    createdAt:INITIAL_WINDOW, expiresAt:EXPIRY, controlEpoch:1, pilotSize:1, maxAttempts:3,
  };
  let notice;
  try { notice = JSON.parse(process.env.LBA_RELEASE_NOTICE_CONFIG || ''); } catch { throw Error('REPLACE_NOTICE'); }
  check(canonical(notice) === canonical(expected), 'REPLACE_NOTICE');
  createRequire(__filename)('./production-environment.cjs').applyProductionEnvironmentDefaults();
  let policy;
  try { policy = productionRuntimePolicy(); } catch { throw Error('REPLACE_RUNTIME_POLICY'); }
  check(policy.productProfileMode === 'active' && policy.telegramDeliveryEnabled === true &&
    policy.telegramUpdatesEnabled === true && policy.canonicalControlEpoch === 1, 'REPLACE_DELIVERY_POLICY');
}
function safeError(error) {
  if (error?.code === '55P03') return 'REPLACE_BUSY';
  if (error?.code === '57014') return 'REPLACE_QUERY_TIMEOUT';
  return /^REPLACE_[A-Z_]+$/.test(error?.message) ? error.message : 'REPLACE_UNCONFIRMED';
}
async function run() {
  let pool;
  try {
    const verified = verify();
    productionGuard();
    const {Pool} = createRequire(path.resolve(__dirname,'../app/package.json'))('pg');
    pool = new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:4000,idleTimeoutMillis:1000,query_timeout:2400});
    pool.on('error', () => {});
    return await replaceWithPool(pool, {operatorSha256:verified.operatorSha256});
  } catch (error) {
    throw Error(safeError(error));
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}
async function main() {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--verify') { console.log(JSON.stringify(verify())); return; }
    check(process.argv.length === 2, 'REPLACE_ARGUMENTS');
    console.log(JSON.stringify(await run()));
  } catch (error) {
    console.error(JSON.stringify({kind:KIND,success:false,code:safeError(error)}));
    process.exitCode = 1;
  }
}
module.exports = {run,verify,replaceWithPool,PRODUCTION_PINS};
if (require.main === module) void main();
