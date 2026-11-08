import { createHash } from 'node:crypto';
import { DELIVERY_VERSION, type DeliveryClaim, type DeliveryJob, type DeliveryOutcome, type DeliveryRepository } from '../../shared/delivery-contract.ts';
import { restoreBotState } from '../../shared/bot/engine.ts';
import { canDeliver, scheduleSemantics, validInstant, validateScheduleView } from '../../shared/schedule-core.ts';
import type { ScheduleView } from '../../shared/product-contract.ts';
import { assertIsolatedRuntimeReady } from '../isolated-guard.ts';
import { canDispatchStoredEvent, currentPlanCursorId, type EventClient, type EventPool, type StoredEventMessage } from './schedule-event-store.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const epoch = (value: string) => { if (!validInstant(value)) throw new Error('INVALID_DELIVERY_CLOCK'); return Date.parse(value); };
const ownerCheck = (owner: string) => { if (!/^lba-synthetic-[A-Za-z0-9_.:-]{1,100}$/.test(owner)) throw new Error('SYNTHETIC_OWNER_REQUIRED'); };
function record(value: any): DeliveryJob {
  const job = structuredClone(value) as DeliveryJob, e = job?.envelope;
  if (!job || job.version !== DELIVERY_VERSION || !e || e.simulationOnly !== true || !/^[a-f0-9]{64}$/.test(e.operationId) ||
      !/^[a-f0-9]{64}$/.test(e.payloadDigest) || !e.outboxId || !e.addressId || !e.sessionId || !e.scheduleRevisionId || !e.bindingRevisionId ||
      typeof e.text !== 'string' || !e.text.length || e.text.length > 4096 ||
      !['pending', 'leased', 'dispatching', 'retry_wait', 'outcome_unknown', 'sent', 'cancelled', 'failed'].includes(job.state) ||
      !Number.isSafeInteger(job.fence) || job.fence < 0 || !Number.isInteger(job.attempts) || job.attempts < 0 ||
      !Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > 5 || job.attempts > job.maxAttempts ||
      typeof job.cancelRequested !== 'boolean') throw new Error('INVALID_DELIVERY_RECORD');
  ownerCheck(e.ownerId); for (const value of [job.createdAt, job.expiresAt, job.nextAttemptAt]) epoch(value);
  if (e.operationId !== sha(canonical([DELIVERY_VERSION, e.ownerId, e.outboxId]))) throw new Error('DELIVERY_RECORD_IDENTITY_MISMATCH');
  if (job.leaseUntil !== null) epoch(job.leaseUntil);
  return job;
}
function recordRow(row: any) {
  const job = record(row.record);
  if (row.operation_id !== job.envelope.operationId || row.owner_id !== job.envelope.ownerId || row.outbox_id !== job.envelope.outboxId) throw new Error('DELIVERY_RECORD_IDENTITY_MISMATCH');
  return job;
}

/** All methods are local-only. The existing outbox remains an immutable message source. */
export function createLocalDeliveryRepository(pool: EventPool, assertReady = assertIsolatedRuntimeReady) {
  async function transaction<T>(work: (client: EventClient) => Promise<T>): Promise<T> {
    assertReady(); const client = await pool.connect();
    try { await client.query('begin');
      const marker = await client.query('select kind,source_revision,marker from lba_isolation_marker where singleton=true');
      if (marker.rows.length !== 1 || marker.rows[0].kind !== 'synthetic' || marker.rows[0].source_revision !== '45d77e22e68816e5695aa4b7d2a62bfc57e8176d' || marker.rows[0].marker !== 'lba-local-only-v1') throw new Error('SYNTHETIC_MARKER_REQUIRED');
      // Fixed order: local delivery mutex → profile mutex → record. No lock crosses transport IO.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [DELIVERY_VERSION]);
      const result = await work(client); await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }
  async function profile(client: EventClient, owner: string) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
    const result = await client.query('select state from lba_bot_sessions where owner_id=$1 for update', [owner]);
    if (result.rows.length !== 1) return null;
    return restoreBotState(result.rows[0].state, owner);
  }
  async function admitted(client: EventClient, job: DeliveryJob, now: string) {
    const e = job.envelope, state = await profile(client, e.ownerId);
    if (!state || state.sessionId !== e.sessionId) return false;
    const source = await client.query("select payload,status from lba_bot_outbox where owner_id=$1 and id=$2 and input_id like 'event:%'", [e.ownerId, e.outboxId]);
    const payload = source.rows[0]?.payload as StoredEventMessage | undefined;
    if (!payload || source.rows[0].status === 'cancelled' || payload.kind !== 'notification' || sha(canonical(payload)) !== e.payloadDigest || e.text !== payload.text ||
        payload.schedule.addressId !== e.addressId || payload.schedule.revisionId !== e.scheduleRevisionId || payload.schedule.bindingRevisionId !== e.bindingRevisionId) return false;
    const cursor = await client.query('select receipt from lba_bot_inbox where owner_id=$1 and input_id=$2', [e.ownerId, currentPlanCursorId(state, payload.schedule)]);
    if (!cursor.rows[0] || cursor.rows[0].receipt.kind !== 'lba-event-cursor/1' || cursor.rows[0].receipt.semantics !== payload.semantics) return false;
    const observation = (await client.query('select receipt from lba_bot_inbox where owner_id=$1 and input_id=$2', [e.ownerId,
      currentPlanCursorId(state, payload.schedule).replace('event:cursor:', 'event:admission:')])).rows[0]?.receipt;
    if (!observation || observation.kind !== 'lba-source-admission/1' || observation.allowed !== true || observation.semantics !== payload.semantics ||
        observation.sourceId !== payload.schedule.source.id || !validInstant(observation.observedAt) || epoch(observation.observedAt) > epoch(now) || epoch(now) - epoch(observation.observedAt) > 900000) return false;
    try { return canDispatchStoredEvent(state, payload, now); } catch { return false; }
  }
  /** A trusted local producer records every fetch outcome, including source failure. No notification is created. */
  async function observeCurrentSource(owner: string, view: ScheduleView, context: { actorId: string; now: string }) {
    ownerCheck(owner); const time = epoch(context.now); validateScheduleView(view);
    if (context.actorId !== owner || epoch(view.observedAt) > time) throw new Error('DELIVERY_OBSERVATION_REJECTED');
    return transaction(async client => {
      const state = await profile(client, owner), binding = state?.profile.locations.find(location => location.address.id === view.addressId)?.binding;
      if (!state || !binding || view.operatorId !== binding.operatorId || view.namespace !== binding.namespace || view.targetId !== binding.targetId || view.bindingRevisionId !== binding.revisionId) throw new Error('DELIVERY_OBSERVATION_SCOPE_MISMATCH');
      const key = currentPlanCursorId(state, view).replace('event:cursor:', 'event:admission:');
      const previous = (await client.query('select receipt from lba_bot_inbox where owner_id=$1 and input_id=$2', [owner, key])).rows[0]?.receipt;
      let allowed = false;
      try { allowed = canDeliver(view, binding, { optedIn: true, paused: false, reminders: false, remindBeforeMinutes: 30,
        quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'Europe/Kyiv' } }, context.now); } catch { /* quality failure stays off */ }
      const semantics = scheduleSemantics(view), digest = sha(canonical({ semantics, source: view.source, observedAt: view.observedAt,
        publishedAt: view.publishedAt, synthetic: view.synthetic, eligible: view.deliveryEligible, freshness: view.freshness }));
      if (previous) {
        if (previous.kind !== 'lba-source-admission/1' || !validInstant(previous.observedAt)) throw new Error('DELIVERY_OBSERVATION_CORRUPT');
        if (epoch(previous.observedAt) > epoch(view.observedAt)) return { accepted: false, allowed: previous.allowed === true, reason: 'older_observation' };
        if (epoch(previous.observedAt) === epoch(view.observedAt)) {
          if (previous.digest === digest) return { accepted: false, allowed: previous.allowed === true, reason: 'same_observation' };
          // Equal timestamps with conflicting content cannot select a winning source result.
          allowed = false;
        }
      }
      const receipt = { kind: 'lba-source-admission/1', observedAt: view.observedAt, sourceId: view.source.id, revisionId: view.revisionId, semantics, digest, allowed };
      await client.query(`insert into lba_bot_inbox(owner_id,input_id,input_digest,receipt) values($1,$2,$3,$4::jsonb)
        on conflict(owner_id,input_id) do update set input_digest=excluded.input_digest,receipt=excluded.receipt`, [owner, key, digest, JSON.stringify(receipt)]);
      return { accepted: true, allowed, reason: allowed ? 'quality_current' : 'source_not_admitted' };
    });
  }
  async function write(client: EventClient, job: DeliveryJob) {
    await client.query('update lba_delivery_jobs set record=$2::jsonb,updated_at=now() where operation_id=$1', [job.envelope.operationId, JSON.stringify(job)]);
  }
  function clearLease(job: DeliveryJob) { job.leaseOwner = null; job.leaseUntil = null; }
  function matches(job: DeliveryJob, claim: DeliveryClaim) {
    return job.fence === claim.fence && job.leaseOwner === claim.workerId && canonical(job.envelope) === canonical(claim.job.envelope);
  }
  async function enqueueFromOutbox(owner: string, outboxId: string, expiresAt: string, now: string) {
    ownerCheck(owner); const time = epoch(now), expiry = epoch(expiresAt);
    if (typeof outboxId !== 'string' || !outboxId || outboxId.length > 600 || /[\u0000-\u001f\u007f]/.test(outboxId)) throw new Error('INVALID_DELIVERY_INPUT');
    return transaction(async client => {
      const operationId = sha(canonical([DELIVERY_VERSION, owner, outboxId]));
      const existing = await client.query('select operation_id,owner_id,outbox_id,record from lba_delivery_jobs where operation_id=$1', [operationId]);
      const source = await client.query("select payload,status from lba_bot_outbox where owner_id=$1 and id=$2 and input_id like 'event:%'", [owner, outboxId]);
      const payload = source.rows[0]?.payload as StoredEventMessage | undefined;
      if (existing.rows.length) {
        const previous = recordRow(existing.rows[0]);
        if ((payload && previous.envelope.payloadDigest !== sha(canonical(payload))) || epoch(previous.expiresAt) !== expiry) throw new Error('DELIVERY_OPERATION_CONFLICT');
        return { job: previous, replayed: true };
      }
      if (expiry <= time || expiry - time > 86400000) throw new Error('INVALID_DELIVERY_INPUT');
      const state = await profile(client, owner); if (!state) throw new Error('DELIVERY_PROFILE_NOT_FOUND');
      if (!payload || payload.kind !== 'notification' || typeof payload.text !== 'string' || payload.text.length < 1 || payload.text.length > 4096) throw new Error('DELIVERY_SOURCE_REJECTED');
      const digest = sha(canonical(payload));
      if ((await client.query('select count(*)::int as n from lba_delivery_jobs where owner_id=$1', [owner])).rows[0].n >= 1000) throw new Error('DELIVERY_OWNER_CAPACITY');
      if ((await client.query('select count(*)::int as n from lba_delivery_jobs')).rows[0].n >= 10000) throw new Error('DELIVERY_QUEUE_CAPACITY');
      const job: DeliveryJob = { version: DELIVERY_VERSION, envelope: { operationId, outboxId, ownerId: owner, addressId: payload.schedule.addressId,
        sessionId: state.sessionId, scheduleRevisionId: payload.schedule.revisionId, bindingRevisionId: payload.schedule.bindingRevisionId!, payloadDigest: digest, text: payload.text, simulationOnly: true },
        state: 'pending', fence: 0, attempts: 0, maxAttempts: 5, createdAt: new Date(time).toISOString(), expiresAt: new Date(expiry).toISOString(), nextAttemptAt: new Date(time).toISOString(),
        leaseOwner: null, leaseUntil: null, cancelRequested: false, providerReceipt: null, lastOutcome: null };
      record(job); if (!await admitted(client, job, now)) throw new Error('DELIVERY_NOT_ELIGIBLE');
      await client.query('insert into lba_delivery_jobs(operation_id,owner_id,outbox_id,record) values($1,$2,$3,$4::jsonb)', [operationId, owner, outboxId, JSON.stringify(job)]);
      return { job, replayed: false };
    });
  }
  const repo: DeliveryRepository = {
    async claim(workerId, now, leaseSeconds) {
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(workerId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new Error('INVALID_DELIVERY_WORKER');
      const time = epoch(now);
      return transaction(async client => {
        const rows = await client.query(`select operation_id,owner_id,outbox_id,record from lba_delivery_jobs where
          (record->>'state' in ('pending','retry_wait') and ((record->>'nextAttemptAt')::timestamptz <= $1::timestamptz or (record->>'expiresAt')::timestamptz <= $1::timestamptz or (record->>'cancelRequested')::boolean)) or
          (record->>'state' in ('leased','dispatching') and (record->>'leaseUntil')::timestamptz <= $1::timestamptz)
          order by (record->>'createdAt')::timestamptz,operation_id limit 100 for update`, [now]);
        for (const row of rows.rows) {
          const job = recordRow(row);
          if (job.state === 'dispatching') {
            if (!job.leaseUntil || epoch(job.leaseUntil) <= time) { job.state = 'outcome_unknown'; job.lastOutcome = 'dispatch_lease_expired'; await write(client, job); }
            continue;
          }
          if (job.state === 'leased' && job.leaseUntil && epoch(job.leaseUntil) > time) continue;
          if (job.cancelRequested || epoch(job.expiresAt) <= time) { job.state = 'cancelled'; job.lastOutcome = 'cancelled_before_dispatch'; clearLease(job); await write(client, job); continue; }
          if (epoch(job.nextAttemptAt) > time) continue;
          if (job.attempts >= job.maxAttempts) { job.state = 'failed'; job.lastOutcome = 'attempt_limit'; clearLease(job); await write(client, job); continue; }
          job.state = 'leased'; job.fence++; job.leaseOwner = workerId; job.leaseUntil = new Date(time + leaseSeconds * 1000).toISOString();
          await write(client, job); return { job, workerId, fence: job.fence };
        }
        return null;
      });
    },
    async begin(claim, now) {
      const time = epoch(now); ownerCheck(claim.job.envelope.ownerId);
      return transaction(async client => {
        const result = await client.query('select operation_id,owner_id,outbox_id,record from lba_delivery_jobs where operation_id=$1 for update', [claim.job.envelope.operationId]);
        if (!result.rows.length) return 'lost'; const job = recordRow(result.rows[0]);
        if (!matches(job, claim) || job.state !== 'leased' || !job.leaseUntil || epoch(job.leaseUntil) <= time) return 'lost';
        if (job.cancelRequested || epoch(job.expiresAt) <= time || !await admitted(client, job, now)) {
          job.state = 'cancelled'; job.lastOutcome = 'eligibility_changed_before_dispatch'; clearLease(job); await write(client, job); return 'cancelled';
        }
        job.state = 'dispatching'; job.attempts++; job.lastOutcome = 'dispatch_started'; await write(client, job); return 'dispatch';
      });
    },
    async finish(claim, outcome, now) {
      const time = epoch(now);
      const allowedKeys = outcome?.kind === 'sent' ? ['kind', 'receipt'] : outcome?.kind === 'rate_limited' ? ['kind', 'retryAfterSeconds'] : outcome?.kind === 'not_sent' ? ['kind', 'retryable', 'reason'] : ['kind', 'reason'];
      if (!outcome || !['sent', 'rate_limited', 'not_sent', 'unknown'].includes(outcome.kind) ||
          Object.keys(outcome).some(key => !allowedKeys.includes(key)) ||
          (outcome.kind === 'sent' && (typeof outcome.receipt !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(outcome.receipt))) ||
          (outcome.kind === 'rate_limited' && (!Number.isSafeInteger(outcome.retryAfterSeconds) || outcome.retryAfterSeconds < 1 || outcome.retryAfterSeconds > 86400)) ||
          (outcome.kind === 'not_sent' && typeof outcome.retryable !== 'boolean') ||
          (['not_sent', 'unknown'].includes(outcome.kind) && (typeof (outcome as any).reason !== 'string' || !(outcome as any).reason.length || (outcome as any).reason.length > 600 || /[\u0000-\u001f\u007f]/.test((outcome as any).reason)))) throw new Error('INVALID_DELIVERY_OUTCOME');
      return transaction(async client => {
        const result = await client.query('select operation_id,owner_id,outbox_id,record from lba_delivery_jobs where operation_id=$1 for update', [claim.job.envelope.operationId]);
        if (!result.rows.length) throw new Error('DELIVERY_FENCE_LOST'); const job = recordRow(result.rows[0]);
        if (job.fence === claim.fence && canonical(job.envelope) === canonical(claim.job.envelope) && job.state === 'sent' &&
            (outcome.kind === 'unknown' || outcome.kind === 'sent' && outcome.receipt === job.providerReceipt)) return;
        if (!matches(job, claim) || !['dispatching', 'outcome_unknown'].includes(job.state)) throw new Error('DELIVERY_FENCE_LOST');
        // A late known result can resolve this same attempt. It cannot overwrite a different fence.
        if (outcome.kind === 'unknown') { if (job.state !== 'outcome_unknown') { job.state = 'outcome_unknown'; job.lastOutcome = 'provider_outcome_unknown'; await write(client, job); } return; }
        if (outcome.kind === 'sent') { job.state = 'sent'; job.providerReceipt = outcome.receipt; job.lastOutcome = 'provider_confirmed'; clearLease(job); }
        else {
          const retry = outcome.kind === 'rate_limited' || outcome.retryable;
          const delay = outcome.kind === 'rate_limited' ? outcome.retryAfterSeconds : Math.min(60, 2 ** job.attempts);
          job.nextAttemptAt = new Date(time + delay * 1000).toISOString();
          job.state = job.cancelRequested || epoch(job.expiresAt) <= time ? 'cancelled' : !retry || job.attempts >= job.maxAttempts || epoch(job.nextAttemptAt) >= epoch(job.expiresAt) ? 'failed' : 'retry_wait';
          job.lastOutcome = outcome.kind; clearLease(job);
        }
        await write(client, job);
      });
    },
  };
  async function snapshot(owner: string) { ownerCheck(owner); return transaction(async client => (await client.query('select operation_id,owner_id,outbox_id,record from lba_delivery_jobs where owner_id=$1 order by operation_id', [owner])).rows.map(row => recordRow(row))); }
  async function cancel(owner: string, operationId: string) {
    ownerCheck(owner); return transaction(async client => {
      const result = await client.query('select operation_id,owner_id,outbox_id,record from lba_delivery_jobs where owner_id=$1 and operation_id=$2 for update', [owner, operationId]);
      if (!result.rows.length) throw new Error('DELIVERY_NOT_FOUND'); const job = recordRow(result.rows[0]);
      job.cancelRequested = true;
      if (['pending', 'leased', 'retry_wait'].includes(job.state)) { job.state = 'cancelled'; job.lastOutcome = 'cancelled_before_dispatch'; clearLease(job); }
      // Dispatching/unknown may already have reached a provider. Never claim they were unsent.
      await write(client, job); return job;
    });
  }
  return { ...repo, enqueueFromOutbox, snapshot, cancel, observeCurrentSource };
}
