import { DELIVERY_VERSION, type DeliveryAttemptResult, type DeliveryClaim, type DeliveryEnvelope,
  type DeliveryOutcome, type DeliveryRepository, type LocalTestTransport } from '../../shared/delivery-contract.ts';
import { validInstant } from '../../shared/schedule-core.ts';

export interface LocalDeliveryOptions {
  workerId: string;
  now(): string;
  leaseSeconds?: number;
  timeoutMs?: number;
}
const invalid = (name: string): never => { throw new Error(name); };
function identifier(value: unknown, max = 600): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
function checkedClaim(raw: DeliveryClaim, workerId: string): DeliveryClaim {
  let claim: DeliveryClaim;
  try { claim = structuredClone(raw); } catch { return invalid('INVALID_DELIVERY_CLAIM'); }
  const job = claim?.job, e = job?.envelope;
  const fields = ['operationId', 'outboxId', 'ownerId', 'addressId', 'sessionId', 'scheduleRevisionId', 'bindingRevisionId', 'payloadDigest', 'text', 'simulationOnly'];
  if (!plain(claim) || !plain(job) || !plain(e) || !keys(e, fields) ||
      fields.slice(0, 8).some(field => !identifier(e[field])) || e.simulationOnly !== true ||
      !/^[a-f0-9]{64}$/.test(e.operationId) || !/^[a-f0-9]{64}$/.test(e.payloadDigest) ||
      !/^lba-synthetic-[A-Za-z0-9_.:-]{1,100}$/.test(e.ownerId) ||
      typeof e.text !== 'string' || e.text.length < 1 || e.text.length > 4096 ||
      claim.workerId !== workerId || job.leaseOwner !== workerId || claim.fence !== job.fence ||
      !Number.isSafeInteger(claim.fence) || claim.fence < 1 || job.version !== DELIVERY_VERSION || job.state !== 'leased' ||
      !Number.isInteger(job.attempts) || job.attempts < 0 || !Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > 5 || job.attempts > job.maxAttempts ||
      ![job.createdAt, job.expiresAt, job.nextAttemptAt, job.leaseUntil].every(validInstant) || typeof job.cancelRequested !== 'boolean') return invalid('INVALID_DELIVERY_CLAIM');
  return claim;
}
function checkedOutcome(value: unknown): DeliveryOutcome {
  if (!plain(value)) return { kind: 'unknown', reason: 'invalid_transport_outcome' };
  if (value.kind === 'sent' && keys(value, ['kind', 'receipt']) && typeof value.receipt === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.receipt)) return { kind: 'sent', receipt: value.receipt };
  if (value.kind === 'rate_limited' && keys(value, ['kind', 'retryAfterSeconds']) && typeof value.retryAfterSeconds === 'number' && Number.isSafeInteger(value.retryAfterSeconds) && value.retryAfterSeconds >= 1 && value.retryAfterSeconds <= 86400) return { kind: 'rate_limited', retryAfterSeconds: value.retryAfterSeconds };
  if (value.kind === 'not_sent' && keys(value, ['kind', 'retryable', 'reason']) && typeof value.retryable === 'boolean' && identifier(value.reason)) return { kind: 'not_sent', retryable: value.retryable, reason: value.reason };
  if (value.kind === 'unknown' && keys(value, ['kind', 'reason']) && identifier(value.reason)) return { kind: 'unknown', reason: value.reason };
  return { kind: 'unknown', reason: 'invalid_transport_outcome' };
}
const lost = (error: unknown) => error instanceof Error && error.message === 'DELIVERY_FENCE_LOST';

/** One fenced attempt. It has no sender, destination, retry loop or database dependency. */
export async function runLocalDeliveryAttempt(repo: DeliveryRepository, transport: LocalTestTransport, options: LocalDeliveryOptions): Promise<DeliveryAttemptResult> {
  if (!options || typeof options.workerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(options.workerId) || typeof options.now !== 'function') return invalid('INVALID_DELIVERY_WORKER');
  if (!repo || !['claim', 'begin', 'finish'].every(key => typeof repo[key as keyof DeliveryRepository] === 'function')) return invalid('INVALID_DELIVERY_REPOSITORY');
  if (!transport || transport.kind !== 'local-test-only' || typeof transport.send !== 'function') return invalid('LOCAL_TEST_TRANSPORT_REQUIRED');
  const lease = options.leaseSeconds === undefined ? 30 : options.leaseSeconds, timeout = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
  if (!Number.isInteger(lease) || lease < 1 || lease > 300 || !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) return invalid('INVALID_DELIVERY_BOUNDS');
  let lastNow: string;
  try { lastNow = options.now(); } catch { return invalid('INVALID_DELIVERY_CLOCK'); }
  if (!validInstant(lastNow)) return invalid('INVALID_DELIVERY_CLOCK');
  function clock() {
    try {
      const value = options.now();
      if (validInstant(value) && Date.parse(value) >= Date.parse(lastNow)) { lastNow = value; return { now: value, valid: true }; }
    } catch { /* A broken clock cannot turn an ambiguous effect into a retry. */ }
    return { now: lastNow, valid: false };
  }
  const raw = await repo.claim(options.workerId, lastNow, lease);
  if (raw === null) return { operationId: null, result: 'idle', simulationOnly: true };
  const claim = checkedClaim(raw, options.workerId), operationId = claim.job.envelope.operationId;
  // A transport gets its own immutable scalar snapshot, never the repository's object.
  const envelope: Readonly<DeliveryEnvelope> = Object.freeze({ ...claim.job.envelope });
  const start = clock();
  if (!start.valid) return invalid('INVALID_DELIVERY_CLOCK');
  const begun = await repo.begin(claim, start.now);
  if (begun !== 'dispatch') {
    if (begun !== 'cancelled' && begun !== 'lost') return invalid('INVALID_DELIVERY_BEGIN_RESULT');
    return { operationId, result: begun, simulationOnly: true };
  }
  async function persist(outcome: DeliveryOutcome, at: string): Promise<DeliveryAttemptResult> {
    try { await repo.finish(claim, outcome, at); }
    catch (error) {
      if (lost(error)) return { operationId, result: 'lost', simulationOnly: true };
      // A failed/lost commit acknowledgement is never reported as sent.
      throw error;
    }
    return { operationId, result: outcome.kind, simulationOnly: true };
  }
  // begin may have waited on a database lock. Its earlier clock is not a
  // dispatch permit after the lease or expiry boundary has passed.
  const dispatch = clock();
  if (!dispatch.valid) return persist({ kind: 'unknown', reason: 'clock_invalid_after_dispatch' }, dispatch.now);
  if (Date.parse(dispatch.now) >= Date.parse(claim.job.leaseUntil!) || Date.parse(dispatch.now) >= Date.parse(claim.job.expiresAt)) {
    return persist({ kind: 'not_sent', retryable: Date.parse(dispatch.now) < Date.parse(claim.job.expiresAt), reason: 'dispatch_deadline_elapsed' }, dispatch.now);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
  const deadline = new Promise<DeliveryOutcome>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      // Settle unknown first; a synchronous abort callback is a late outcome.
      resolve({ kind: 'unknown', reason: 'transport_timeout' });
      controller.abort();
    }, timeout);
  });
  let completion: Promise<DeliveryOutcome>;
  try {
    // Invoke immediately after the boundary checks, without another queued turn.
    completion = Promise.resolve(transport.send(envelope, controller.signal)).then(checkedOutcome)
      .catch(() => ({ kind: 'unknown', reason: 'transport_error' } as const));
  } catch { completion = Promise.resolve({ kind: 'unknown', reason: 'transport_error' }); }
  let outcome = await Promise.race([completion, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  const finish = clock();
  if (!finish.valid) outcome = { kind: 'unknown', reason: 'clock_invalid_after_dispatch' };
  const result = await persist(outcome, finish.now);
  if (result.result === 'lost') return result;
  if (timedOut) {
    // This observes only the already-issued attempt, never invokes send again.
    // Failure here leaves the durably recorded unknown for explicit reconciliation.
    void completion.then(async late => {
      if (late.kind !== 'sent') return;
      const observed = clock(); if (!observed.valid) return;
      try { await repo.finish(claim, late, observed.now); } catch { /* The fence may have changed, or the database may be unavailable. */ }
    });
  }
  return result;
}
