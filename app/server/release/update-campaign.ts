import { createHash } from 'node:crypto';
import type { DeliveryOutcome, DeliveryState } from '../../shared/delivery-contract.ts';

/** Explicit release control plane. Importing this module cannot send or open a database. */
export const UPDATE_CAMPAIGN_VERSION = 'lba-update-campaign/1' as const;
export const UPDATE_ANNOUNCEMENT_UA = 'Ми оновили застосунок і бота. У найближчі дні з’являться ще кілька оновлень і покращень. Поки триває оновлення, можливі тимчасові збої в роботі графіків і сповіщень. Якщо помітите неточність, перевірте інформацію в оператора мережі.';
export interface CampaignBinding {
  releaseId: string;
  deploymentId: string;
  buildSha256: string;
  botId: string;
  origin: string;
}
export interface UpdateCampaignSpec extends CampaignBinding {
  version: typeof UPDATE_CAMPAIGN_VERSION;
  text: string;
  appUrl: string;
  createdAt: string;
  expiresAt: string;
  pilotRecipientRefs: string[];
  maxAttempts: number;
  audienceDigest: string;
}
export type CampaignPhase = 'prepared' | 'pilot' | 'full' | 'paused' | 'completed';
export interface CampaignRecord {
  spec: UpdateCampaignSpec;
  specHash: string;
  phase: CampaignPhase;
  pauseReason: string | null;
  resumePhase?: 'pilot' | 'full';
}
export interface CampaignJob {
  operationId: string;
  releaseId: string;
  botId: string;
  recipientRef: string;
  cohort: 'pilot' | 'full';
  state: DeliveryState;
  fence: number;
  attempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  providerReceipt: string | null;
  lastOutcome: string | null;
}
export interface CampaignClaim {
  campaign: CampaignRecord;
  job: CampaignJob;
  workerId: string;
  fence: number;
}
/** A trusted observer supplies an actual readback, never a user-supplied authorization claim. */
export interface DeploymentHealthObservation extends CampaignBinding {
  healthy: true;
  observedAt: string;
}
export interface UpdateCampaignRepository {
  claim(releaseId: string, workerId: string, now: string, leaseSeconds: number): Promise<CampaignClaim | null>;
  begin(claim: CampaignClaim, health: DeploymentHealthObservation | null, now: string): Promise<'dispatch' | 'cancelled' | 'health_blocked' | 'lost'>;
  finish(claim: CampaignClaim, outcome: DeliveryOutcome, now: string): Promise<void>;
}
/** Local coordinator admission is not a provider failure and spends no send attempt. */
export interface CampaignLocalDeferral {reason:'coordinator_busy'|'coordinator_deferred';retryAt:string}
export interface CoordinatedCampaignRepository extends UpdateCampaignRepository {
  defer(claim:CampaignClaim,deferral:CampaignLocalDeferral,now:string):Promise<'deferred'|'cancelled'|'lost'>;
}
export interface CampaignEnvelope extends CampaignBinding {
  operationId: string;
  recipientRef: string;
  text: string;
  appUrl: string;
}
/** The injected adapter resolves private destinations and validates the target bot. No credentials belong here. */
export interface CampaignTelegramSender {
  readonly kind: 'telegram-release-campaign';
  readonly botId: string;
  send(envelope: Readonly<CampaignEnvelope>, signal: AbortSignal): Promise<{
    botId: string;
    recipientRef: string;
    body: unknown;
  }>;
}
export interface CampaignHealthObserver {
  observe(binding: Readonly<CampaignBinding>, signal: AbortSignal): Promise<DeploymentHealthObservation | null>;
}
export interface CampaignAttemptOptions {
  releaseId: string;
  workerId: string;
  now(): string;
  leaseSeconds?: number;
  timeoutMs?: number;
  healthTimeoutMs?: number;
}
export interface CampaignAttemptResult {
  operationId: string | null;
  result: 'idle' | 'cancelled' | 'health_blocked' | 'lost' | DeliveryOutcome['kind'];
}
export interface CampaignSummary {
  releaseId: string;
  specHash: string;
  phase: CampaignPhase;
  pauseReason: string | null;
  total: number;
  pilotTotal: number;
  states: Record<DeliveryState, number>;
  pilotStates: Record<DeliveryState, number>;
}
export class CampaignError extends Error {}
export const campaignFail = (code: string): never => { throw new CampaignError(code); };
export function campaignInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
export function campaignId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
}
const plain = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(v, key));
export function campaignHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function campaignOperationId(releaseId: string, recipientRef: string): string {
  if (!campaignId(releaseId) || !campaignId(recipientRef)) return campaignFail('INVALID_CAMPAIGN_ID');
  return campaignHash([UPDATE_CAMPAIGN_VERSION, releaseId, recipientRef]);
}
export function campaignBinding(spec: CampaignBinding): CampaignBinding {
  return { releaseId: spec.releaseId, deploymentId: spec.deploymentId, buildSha256: spec.buildSha256, botId: spec.botId, origin: spec.origin };
}
/** Strict immutable normalization makes prepare/retry semantic hashes stable. */
export function prepareCampaignSpec(input: Omit<UpdateCampaignSpec, 'version' | 'audienceDigest'>, recipientRefs: string[]): UpdateCampaignSpec {
  if (!plain(input) || !exactKeys(input, ['releaseId','deploymentId','buildSha256','botId','origin','text','appUrl','createdAt','expiresAt','pilotRecipientRefs','maxAttempts']) ||
      !campaignId(input.releaseId) || !campaignId(input.deploymentId) || !campaignId(input.botId) || !/^[a-f0-9]{64}$/.test(input.buildSha256) ||
      !campaignInstant(input.createdAt) || !campaignInstant(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.createdAt) ||
      Date.parse(input.expiresAt) - Date.parse(input.createdAt) > 7 * 86400000 || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text) ||
      !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 5 || !Array.isArray(recipientRefs) || !recipientRefs.length || recipientRefs.length > 100000 ||
      recipientRefs.some(ref => !campaignId(ref)) || new Set(recipientRefs).size !== recipientRefs.length || !Array.isArray(input.pilotRecipientRefs) ||
      !input.pilotRecipientRefs.length || input.pilotRecipientRefs.length > 5 || input.pilotRecipientRefs.some(ref => !recipientRefs.includes(ref)) ||
      new Set(input.pilotRecipientRefs).size !== input.pilotRecipientRefs.length) return campaignFail('INVALID_CAMPAIGN_SPEC');
  try {
    const origin = new URL(input.origin), app = new URL(input.appUrl);
    if (origin.protocol !== 'https:' || app.protocol !== 'https:' || origin.username || origin.password || origin.origin !== input.origin || app.origin !== origin.origin || app.username || app.password) return campaignFail('INVALID_CAMPAIGN_ORIGIN');
  } catch { return campaignFail('INVALID_CAMPAIGN_ORIGIN'); }
  return { version: UPDATE_CAMPAIGN_VERSION, ...campaignBinding(input), text: input.text, appUrl: input.appUrl,
    createdAt: input.createdAt, expiresAt: input.expiresAt, pilotRecipientRefs: [...input.pilotRecipientRefs].sort(), maxAttempts: input.maxAttempts,
    audienceDigest: campaignHash([...recipientRefs].sort()) };
}
export function campaignSpecHash(spec: UpdateCampaignSpec): string {
  return campaignHash([spec.version, spec.releaseId, spec.deploymentId, spec.buildSha256, spec.botId, spec.origin, spec.text, spec.appUrl,
    spec.createdAt, spec.expiresAt, spec.pilotRecipientRefs, spec.maxAttempts, spec.audienceDigest]);
}
export function validDeploymentHealth(spec: CampaignBinding, health: unknown, now: string): health is DeploymentHealthObservation {
  if (!plain(health) || !exactKeys(health, ['releaseId','deploymentId','buildSha256','botId','origin','healthy','observedAt']) || health.healthy !== true ||
      !campaignInstant(health.observedAt) || !campaignInstant(now)) return false;
  return ['releaseId','deploymentId','buildSha256','botId','origin'].every(key => health[key] === spec[key as keyof CampaignBinding]) &&
    Date.parse(health.observedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(health.observedAt) <= 300000;
}
export function checkedCampaignOutcome(value: unknown): DeliveryOutcome {
  if (!plain(value)) return campaignFail('INVALID_CAMPAIGN_OUTCOME');
  if (value.kind === 'sent' && exactKeys(value, ['kind','receipt']) && typeof value.receipt === 'string' && /^tg-msg-[1-9]\d{0,15}$/.test(value.receipt)) return { kind: 'sent', receipt: value.receipt };
  if (value.kind === 'rate_limited' && exactKeys(value, ['kind','retryAfterSeconds']) && Number.isSafeInteger(value.retryAfterSeconds) && Number(value.retryAfterSeconds) >= 1 && Number(value.retryAfterSeconds) <= 86400) return { kind: 'rate_limited', retryAfterSeconds: Number(value.retryAfterSeconds) };
  if ((value.kind === 'unknown' || value.kind === 'not_sent') && exactKeys(value, value.kind === 'unknown' ? ['kind','reason'] : ['kind','retryable','reason']) &&
      typeof value.reason === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value.reason) && (value.kind === 'unknown' || typeof value.retryable === 'boolean'))
    return value.kind === 'unknown' ? { kind: 'unknown', reason: value.reason } : { kind: 'not_sent', retryable: value.retryable as boolean, reason: value.reason };
  return campaignFail('INVALID_CAMPAIGN_OUTCOME');
}
/** Only an explicit Telegram acceptance with a message_id counts as provider-confirmed. */
export function classifyCampaignReply(envelope: CampaignEnvelope, reply: unknown): DeliveryOutcome {
  if (!plain(reply) || reply.botId !== envelope.botId || reply.recipientRef !== envelope.recipientRef || !plain(reply.body)) return { kind: 'unknown', reason: 'provider_target_or_response_unverified' };
  const body = reply.body;
  if (body.ok === true && plain(body.result) && Number.isSafeInteger(body.result.message_id) && Number(body.result.message_id) > 0)
    return { kind: 'sent', receipt: 'tg-msg-' + String(body.result.message_id) };
  if (body.ok !== false || !Number.isInteger(body.error_code)) return { kind: 'unknown', reason: 'provider_response_unverified' };
  const code = Number(body.error_code);
  if (code === 429) {
    if (plain(body.parameters) && Number.isSafeInteger(body.parameters.retry_after) && Number(body.parameters.retry_after) >= 1 && Number(body.parameters.retry_after) <= 86400)
      return { kind: 'rate_limited', retryAfterSeconds: Number(body.parameters.retry_after) };
    // A rejected request does not prove that another request is allowed now.
    // An unverified throttling window fails stopped for this bot, rather than falling through to permanent4xx.
    return { kind: 'unknown', reason: 'rate_limit_unverified' };
  }
  if (code === 403) return { kind: 'not_sent', retryable: false, reason: 'telegram_forbidden' };
  if (code >= 400 && code < 500) return { kind: 'not_sent', retryable: false, reason: 'telegram_rejected_' + code };
  // A definite API rejection can retry; missing/HTML/proxy/transport responses remain unknown.
  if (code >= 500 && code <= 599) return { kind: 'not_sent', retryable: true, reason: 'telegram_rejected_' + code };
  return { kind: 'unknown', reason: 'provider_response_unverified' };
}
function checkedClaim(claim: CampaignClaim, options: CampaignAttemptOptions): CampaignClaim {
  const c = structuredClone(claim), j = c?.job, campaign = c?.campaign, spec = campaign?.spec;
  if (!campaign || !spec || campaignSpecHash(spec) !== campaign.specHash || spec.releaseId !== options.releaseId ||
      !j || j.releaseId !== spec.releaseId || j.botId !== spec.botId || !campaignId(j.recipientRef) || j.operationId !== campaignOperationId(spec.releaseId, j.recipientRef) ||
      j.state !== 'leased' || j.leaseOwner !== options.workerId || c.workerId !== options.workerId || c.fence !== j.fence || !Number.isSafeInteger(j.fence) || j.fence < 1 ||
      !campaignInstant(j.leaseUntil) || !Number.isSafeInteger(j.attempts) || j.attempts < 0 || j.attempts >= spec.maxAttempts || !['pilot','full'].includes(campaign.phase) ||
      j.cohort !== (spec.pilotRecipientRefs.includes(j.recipientRef) ? 'pilot' : 'full')) return campaignFail('INVALID_CAMPAIGN_CLAIM');
  return c;
}
export const checkedCampaignClaim=checkedClaim;
/** One bounded attempt; caller controls the run and no recurring job is created. */
export async function runUpdateCampaignAttempt(repo: UpdateCampaignRepository, sender: CampaignTelegramSender, observer: CampaignHealthObserver, options: CampaignAttemptOptions): Promise<CampaignAttemptResult> {
  if (!campaignId(options?.releaseId) || !campaignId(options?.workerId) || typeof options.now !== 'function' || !repo ||
      !['claim','begin','finish'].every(key => typeof repo[key as keyof UpdateCampaignRepository] === 'function') ||
      sender?.kind !== 'telegram-release-campaign' || !campaignId(sender.botId) || typeof sender.send !== 'function' || typeof observer?.observe !== 'function') return campaignFail('INVALID_CAMPAIGN_RUN');
  const lease = options.leaseSeconds ?? 45, timeout = options.timeoutMs ?? 15000, healthTimeout = options.healthTimeoutMs ?? 5000;
  if (!Number.isInteger(lease) || lease < 5 || lease > 300 || !Number.isInteger(timeout) || timeout < 1 || timeout > 30000 ||
      !Number.isInteger(healthTimeout) || healthTimeout < 1 || healthTimeout > 10000) return campaignFail('INVALID_CAMPAIGN_BOUNDS');
  let last = options.now();
  if (!campaignInstant(last)) return campaignFail('INVALID_CAMPAIGN_CLOCK');
  function clock() {
    try { const value = options.now(); if (campaignInstant(value) && Date.parse(value) >= Date.parse(last)) { last = value; return { now: value, valid: true }; } } catch { /* no raw exception/logging */ }
    return { now: last, valid: false };
  }
  const raw = await repo.claim(options.releaseId, options.workerId, last, lease);
  if (!raw) return { operationId: null, result: 'idle' };
  const claim = checkedClaim(raw, options), operationId = claim.job.operationId, spec = claim.campaign.spec;
  if (sender.botId !== spec.botId) {
    await repo.begin(claim, null, clock().now); return { operationId, result: 'health_blocked' };
  }
  const healthController = new AbortController(); let healthTimer: ReturnType<typeof setTimeout> | undefined;
  const healthPromise = Promise.resolve().then(() => observer.observe(Object.freeze(campaignBinding(spec)), healthController.signal)).catch(() => null);
  const health = await Promise.race([healthPromise, new Promise<null>(resolve => { healthTimer = setTimeout(() => { resolve(null); healthController.abort(); }, healthTimeout); })]);
  if (healthTimer) clearTimeout(healthTimer);
  const before = clock(), verified = before.valid && validDeploymentHealth(spec, health, before.now) ? health : null;
  const begun = await repo.begin(claim, verified, before.now);
  if (begun !== 'dispatch') return { operationId, result: begun };
  const at = clock();
  if (!at.valid || !claim.job.leaseUntil || Date.parse(at.now) >= Date.parse(claim.job.leaseUntil) || Date.parse(at.now) >= Date.parse(spec.expiresAt)) {
    await repo.finish(claim, { kind: 'unknown', reason: 'dispatch_clock_or_deadline_changed' }, at.now);
    return { operationId, result: 'unknown' };
  }
  const envelope: Readonly<CampaignEnvelope> = Object.freeze({ ...campaignBinding(spec), operationId, recipientRef: claim.job.recipientRef, text: spec.text, appUrl: spec.appUrl });
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
  const deadline = new Promise<DeliveryOutcome>(resolve => { timer = setTimeout(() => { timedOut = true; resolve({ kind: 'unknown', reason: 'telegram_timeout' }); controller.abort(); }, timeout); });
  let completion: Promise<DeliveryOutcome>;
  try { completion = Promise.resolve(sender.send(envelope, controller.signal)).then(value => classifyCampaignReply(envelope, value)).catch(() => ({ kind: 'unknown', reason: 'telegram_transport_error' })); }
  catch { completion = Promise.resolve({ kind: 'unknown', reason: 'telegram_transport_error' }); }
  const outcome = await Promise.race([completion, deadline]); if (timer) clearTimeout(timer);
  const finish = clock(), final = finish.valid ? outcome : { kind: 'unknown' as const, reason: 'clock_changed_after_send' };
  await repo.finish(claim, final, finish.now);
  if (timedOut) void completion.then(async late => {
    // Reconcile only this issued attempt. A late success never invokes send again.
    if (late.kind === 'sent') { const observed = clock(); if (observed.valid) try { await repo.finish(claim, late, observed.now); } catch { /* retain durable unknown */ } }
  });
  return { operationId, result: final.kind };
}
