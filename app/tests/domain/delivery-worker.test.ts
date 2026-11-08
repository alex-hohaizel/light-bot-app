import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { runLocalDeliveryAttempt } from '../../server/domain/delivery-worker.ts';
import { DELIVERY_VERSION, type DeliveryClaim, type DeliveryJob, type DeliveryOutcome, type DeliveryRepository, type LocalTestTransport } from '../../shared/delivery-contract.ts';

const now = '2026-11-07T16:00:00Z';
function job(): DeliveryJob {
  return { version: DELIVERY_VERSION, envelope: { operationId: 'a'.repeat(64), outboxId: 'event:source:1', ownerId: 'lba-synthetic-worker-test',
    addressId: 'fixture-address', sessionId: 'fixture-session', scheduleRevisionId: 'fixture-plan-1', bindingRevisionId: 'fixture-binding-1',
    payloadDigest: 'b'.repeat(64), text: 'План оновлено.', simulationOnly: true }, state: 'pending', fence: 0, attempts: 0, maxAttempts: 5,
    createdAt: now, expiresAt: '2026-11-08T16:00:00Z', nextAttemptAt: now, leaseOwner: null, leaseUntil: null,
    cancelRequested: false, providerReceipt: null, lastOutcome: null };
}
function harness() {
  let value = job(), idle = false, beginResult: 'dispatch' | 'lost' | 'cancelled' = 'dispatch';
  let beforeBegin = () => {}, beforeFinish = () => {}, finishError = '', afterCommit = false;
  const calls: string[] = [], claims: unknown[][] = [], outcomes: Array<{ claim: DeliveryClaim; outcome: DeliveryOutcome; now: string }> = [];
  const repo: DeliveryRepository = {
    async claim(workerId, clock, lease) {
      calls.push('claim'); claims.push([workerId, clock, lease]);
      if (idle || value.state !== 'pending') return null;
      value.state = 'leased'; value.fence++; value.leaseOwner = workerId; value.leaseUntil = '2026-11-07T16:00:30Z';
      return { job: structuredClone(value), workerId, fence: value.fence };
    },
    async begin(claim) {
      calls.push('begin'); beforeBegin();
      if (claim.fence !== value.fence || claim.workerId !== value.leaseOwner) return 'lost';
      if (beginResult !== 'dispatch') return beginResult;
      value.state = 'dispatching'; value.attempts++; return 'dispatch';
    },
    async finish(claim, outcome, clock) {
      calls.push(`finish:${outcome.kind}`); beforeFinish();
      if (claim.fence !== value.fence || claim.workerId !== value.leaseOwner) throw new Error('DELIVERY_FENCE_LOST');
      if (finishError && !afterCommit) throw new Error(finishError);
      outcomes.push({ claim: structuredClone(claim), outcome: structuredClone(outcome), now: clock });
      value.state = outcome.kind === 'sent' ? 'sent' : outcome.kind === 'unknown' ? 'outcome_unknown' : outcome.kind === 'rate_limited' || outcome.retryable ? 'retry_wait' : 'failed';
      if (outcome.kind === 'sent') value.providerReceipt = outcome.receipt;
      if (finishError) throw new Error(finishError);
    },
  };
  return { repo, calls, claims, outcomes, get job() { return value; }, set job(next) { value = next; },
    setIdle() { idle = true; }, setBegin(next: typeof beginResult) { beginResult = next; },
    beforeBegin(fn: () => void) { beforeBegin = fn; }, beforeFinish(fn: () => void) { beforeFinish = fn; },
    failFinish(message: string, committed = false) { finishError = message; afterCommit = committed; } };
}
const options = () => ({ workerId: 'test-worker', now: () => now });
const transport = (send: LocalTestTransport['send']): LocalTestTransport => ({ kind: 'local-test-only', send });

test('invalid worker, transport, clock and resource bounds are rejected before claiming', async () => {
  const badOptions: any[] = [{ workerId: 123 }, { workerId: '' }, { workerId: 'unsafe worker' }, { workerId: 'w'.repeat(65) },
    { now: () => 'tomorrow' }, { now: () => { throw new Error('clock'); } }, { leaseSeconds: 0 }, { leaseSeconds: 301 }, { leaseSeconds: null },
    { timeoutMs: 0 }, { timeoutMs: 60001 }, { timeoutMs: 1.5 }, { timeoutMs: null }];
  for (const bad of badOptions) {
    const h = harness(); await assert.rejects(runLocalDeliveryAttempt(h.repo, transport(async () => ({ kind: 'sent', receipt: 'r' })), { ...options(), ...bad }));
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  await assert.rejects(runLocalDeliveryAttempt(h.repo, { kind: 'telegram-http', send: async () => ({ kind: 'sent', receipt: 'r' }) } as any, options()), /LOCAL_TEST_TRANSPORT_REQUIRED/);
  assert.deepEqual(h.calls, []);
});
test('idle poll uses explicit defaults and never invokes begin or transport', async () => {
  const h = harness(); h.setIdle();
  const result = await runLocalDeliveryAttempt(h.repo, transport(async () => { throw new Error('must not send'); }), options());
  assert.deepEqual(result, { operationId: null, result: 'idle', simulationOnly: true });
  assert.deepEqual(h.claims, [['test-worker', now, 30]]); assert.deepEqual(h.calls, ['claim']);
});
test('success has one durable begin/send/finish and an independent frozen envelope', async () => {
  const h = harness(), original = structuredClone(h.job.envelope);
  const result = await runLocalDeliveryAttempt(h.repo, transport(async (envelope, signal) => {
    h.calls.push('send'); assert(Object.isFrozen(envelope)); assert.equal(signal.aborted, false);
    assert.throws(() => { (envelope as any).text = 'changed'; }, TypeError);
    assert.deepEqual(envelope, original); return { kind: 'sent', receipt: 'local-receipt-1' };
  }), options());
  assert.deepEqual(h.calls, ['claim', 'begin', 'send', 'finish:sent']);
  assert.equal(result.result, 'sent'); assert.equal(h.job.providerReceipt, 'local-receipt-1');
  assert.deepEqual(h.job.envelope, original);
});
test('lost fence and cancellation before dispatch never invoke transport', async () => {
  for (const kind of ['lost', 'cancelled'] as const) {
    const h = harness(); h.setBegin(kind);
    const result = await runLocalDeliveryAttempt(h.repo, transport(async () => { throw new Error('must not send'); }), options());
    assert.equal(result.result, kind); assert.deepEqual(h.calls, ['claim', 'begin']);
  }
});
test('concurrent workers dispatch only the single claimed job', async () => {
  const h = harness(); let effects = 0;
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => runLocalDeliveryAttempt(h.repo,
    transport(async () => { effects++; return { kind: 'sent', receipt: 'one-effect' }; }), { ...options(), workerId: `worker-${index}` })));
  assert.equal(effects, 1); assert.equal(results.filter(result => result.result === 'sent').length, 1);
  assert.equal(results.filter(result => result.result === 'idle').length, 19);
});
test('stale fence before begin is silent; lost fence after effect never returns a false sent acknowledgement', async () => {
  const before = harness(); before.beforeBegin(() => { before.job.fence++; });
  assert.equal((await runLocalDeliveryAttempt(before.repo, transport(async () => { throw new Error('must not send'); }), options())).result, 'lost');
  const after = harness(); let effects = 0; after.beforeFinish(() => { after.job.fence++; });
  const result = await runLocalDeliveryAttempt(after.repo, transport(async () => { effects++; return { kind: 'sent', receipt: 'effect-before-fence-loss' }; }), options());
  assert.equal(result.result, 'lost'); assert.equal(effects, 1); assert.equal(after.job.providerReceipt, null);
});
test('throw after effect is durably unknown and never retried by the worker', async () => {
  const h = harness(); let effects = 0;
  const sender = transport(async () => { effects++; throw new Error('provider secret must not be copied'); });
  assert.equal((await runLocalDeliveryAttempt(h.repo, sender, options())).result, 'unknown');
  assert.deepEqual(h.outcomes[0].outcome, { kind: 'unknown', reason: 'transport_error' });
  assert.equal((await runLocalDeliveryAttempt(h.repo, sender, options())).result, 'idle'); assert.equal(effects, 1);
});
test('malformed provider results never manufacture sent or retryable outcomes', async () => {
  for (const outcome of [{ kind: 'sent', receipt: '' }, { kind: 'sent', receipt: 'r', chatId: 'forbidden' },
    { kind: 'rate_limited', retryAfterSeconds: '3' }, { kind: 'rate_limited', retryAfterSeconds: -1 },
    { kind: 'not_sent', retryable: 'true', reason: 'x' }, null, 'sent']) {
    const h = harness(); assert.equal((await runLocalDeliveryAttempt(h.repo, transport(async () => outcome as any), options())).result, 'unknown');
    assert.equal(h.outcomes[0].outcome.kind, 'unknown');
  }
});
test('definite not-sent and429 are persisted unchanged, without worker retries or sleeping', async () => {
  for (const outcome of [{ kind: 'not_sent', retryable: true, reason: 'local_rejected_before_effect' },
    { kind: 'not_sent', retryable: false, reason: 'local_permanent_rejection' }, { kind: 'rate_limited', retryAfterSeconds: 59 }] as DeliveryOutcome[]) {
    const h = harness(); let calls = 0;
    const result = await runLocalDeliveryAttempt(h.repo, transport(async () => { calls++; return outcome; }), options());
    assert.equal(result.result, outcome.kind); assert.deepEqual(h.outcomes[0].outcome, outcome); assert.equal(calls, 1);
  }
});
test('timeout after an effect aborts the signal, persists unknown and does not resend', async () => {
  const h = harness(); let effects = 0, signal: AbortSignal | undefined;
  const sender = transport(async (_envelope, value) => { effects++; signal = value; return new Promise(() => {}); });
  const result = await runLocalDeliveryAttempt(h.repo, sender, { ...options(), timeoutMs: 5 });
  assert.equal(result.result, 'unknown'); assert.equal(signal?.aborted, true);
  assert.deepEqual(h.outcomes[0].outcome, { kind: 'unknown', reason: 'transport_timeout' });
  await runLocalDeliveryAttempt(h.repo, sender, options()); assert.equal(effects, 1);
});
test('late known success resolves only that timed-out fence, after unknown was persisted', async () => {
  const h = harness(); let resolve!: (outcome: DeliveryOutcome) => void, effects = 0;
  const result = await runLocalDeliveryAttempt(h.repo, transport(async () => { effects++; return new Promise(done => { resolve = done; }); }), { ...options(), timeoutMs: 5 });
  assert.equal(result.result, 'unknown'); assert.equal(h.job.state, 'outcome_unknown');
  resolve({ kind: 'sent', receipt: 'late-local-receipt' }); await tick();
  assert.deepEqual(h.outcomes.map(row => row.outcome.kind), ['unknown', 'sent']); assert.equal(h.job.providerReceipt, 'late-local-receipt'); assert.equal(effects, 1);
});
test('a stale late receipt cannot overwrite a new fence and late non-success cannot create an automatic retry', async () => {
  for (const stale of [true, false]) {
    const h = harness(); let resolve!: (outcome: DeliveryOutcome) => void;
    await runLocalDeliveryAttempt(h.repo, transport(async () => new Promise(done => { resolve = done; })), { ...options(), timeoutMs: 5 });
    if (stale) h.job.fence++;
    resolve(stale ? { kind: 'sent', receipt: 'stale-late-receipt' } : { kind: 'rate_limited', retryAfterSeconds: 7 }); await tick();
    assert.equal(h.job.state, 'outcome_unknown'); assert.equal(h.job.providerReceipt, null); assert.equal(h.outcomes.length, 1);
  }
});
test('failed durable finish or lost commit acknowledgement never returns sent or retries the transport', async () => {
  for (const committed of [false, true]) {
    const h = harness(); h.failFinish('DB_ACK_FAILED', committed); let effects = 0;
    await assert.rejects(runLocalDeliveryAttempt(h.repo, transport(async () => { effects++; return { kind: 'sent', receipt: 'effect-but-no-ack' }; }), options()), /DB_ACK_FAILED/);
    assert.equal(effects, 1); assert.equal(h.calls.filter(value => value.startsWith('finish:')).length, 1);
  }
});
test('invalid clock before begin has no effect; invalid/backward postdispatch clock is saved as unknown at last trusted instant', async () => {
  const before = harness(); let reads = 0;
  await assert.rejects(runLocalDeliveryAttempt(before.repo, transport(async () => { throw new Error('must not send'); }), { ...options(), now: () => ++reads === 1 ? now : 'bad' }), /CLOCK/);
  assert.deepEqual(before.calls, ['claim']);
  for (const invalid of ['bad', '2026-11-07T15:59:59Z']) {
    const h = harness(); reads = 0;
    const result = await runLocalDeliveryAttempt(h.repo, transport(async () => ({ kind: 'sent', receipt: 'known-but-clock-invalid' })), { ...options(), now: () => ++reads < 4 ? now : invalid });
    assert.equal(result.result, 'unknown'); assert.equal(h.outcomes[0].now, now);
    assert.deepEqual(h.outcomes[0].outcome, { kind: 'unknown', reason: 'clock_invalid_after_dispatch' });
  }
});
test('slow begin or clock change cannot dispatch after lease/job expiry or with invalid time', async () => {
  for (const after of ['2026-11-07T16:00:30Z', '2026-11-08T16:00:00Z', 'bad', '2026-11-07T15:59:59Z']) {
    const h = harness(); let value = now, effects = 0;
    h.beforeBegin(() => { value = after; });
    const result = await runLocalDeliveryAttempt(h.repo, transport(async () => { effects++; return { kind: 'sent', receipt: 'must-not-dispatch' }; }), { ...options(), now: () => value });
    const valid = after !== 'bad' && after !== '2026-11-07T15:59:59Z';
    assert.equal(effects, 0); assert.equal(result.result, valid ? 'not_sent' : 'unknown');
    if (valid) assert.deepEqual(h.outcomes[0].outcome, { kind: 'not_sent', retryable: after === '2026-11-07T16:00:30Z', reason: 'dispatch_deadline_elapsed' });
    else assert.equal(h.outcomes[0].now, now);
  }
});
test('malformed or nonlocal claimed envelope is rejected without begin/send', async () => {
  const absent = harness(); absent.repo.claim = async () => undefined as any;
  await assert.rejects(runLocalDeliveryAttempt(absent.repo, transport(async () => { throw new Error('must not send'); }), options()), /INVALID_DELIVERY_CLAIM/);
  for (const change of [(j: any) => { j.envelope.simulationOnly = false; }, (j: any) => { j.envelope.ownerId = 'production-owner'; },
    (j: any) => { j.envelope.text = 'x'.repeat(4097); }, (j: any) => { j.envelope.chatId = 'destination'; },
    (j: any) => { j.envelope.sessionId = 'bad\nkey'; }, (j: any) => { j.envelope.payloadDigest = 'wrong'; }]) {
    const h = harness(); change(h.job);
    await assert.rejects(runLocalDeliveryAttempt(h.repo, transport(async () => { throw new Error('must not send'); }), options()), /INVALID_DELIVERY_CLAIM/);
    assert.deepEqual(h.calls, ['claim']);
  }
});
