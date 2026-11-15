import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { assertIsolatedConfig, installIsolatedEgressGuard } from '../../server/isolated-guard.ts';
import { createBotState } from '../../shared/bot/engine.ts';
import { createDemoContext, createDemoProfile } from '../../shared/bot/fixtures.ts';
import { REVIEW_PLAN } from '../../shared/review-fixtures.ts';
import type { LocalTestTransport } from '../../shared/delivery-contract.ts';
import { runLocalDeliveryAttempt } from '../../server/domain/delivery-worker.ts';

installIsolatedEgressGuard(assertIsolatedConfig());
const { pool } = await import('../../server/db');
const { createLocalDeliveryRepository } = await import('../../server/domain/delivery-repository.ts');
const { createLocalScheduleEventStore } = await import('../../server/domain/schedule-event-store.ts');
const { commitProfileMutation, resetBotSession } = await import('../../server/domain/bot-session-store.ts');
const repo = createLocalDeliveryRepository(pool), events = createLocalScheduleEventStore(pool);
const at = (seconds = 0) => new Date(Date.parse('2026-11-07T10:00:00+02:00') + seconds * 1000).toISOString();
const checks: string[] = [];
async function fixture(name: string, expirySeconds = 900) {
  const owner = `lba-synthetic-delivery-${name}`, profile = createDemoProfile(owner);
  profile.preferences.optedIn = true; profile.locations[0].notifications = true;
  const state = createBotState({ ownerId: owner, sessionId: `delivery-${name}`, profile });
  const client = await pool.connect();
  try { await client.query('begin'); await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
    for (const table of ['lba_delivery_jobs', 'lba_bot_outbox', 'lba_bot_inbox', 'lba_bot_sessions']) await client.query(`delete from ${table} where owner_id=$1`, [owner]);
    await client.query('insert into lba_bot_sessions(owner_id,session_id,revision,state) values($1,$2,0,$3::jsonb)', [owner, state.sessionId, JSON.stringify(state)]); await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  const binding = profile.locations[0].binding;
  const view = { ...structuredClone(REVIEW_PLAN), observedAt: at(), revisionId: `delivery-${name}-plan1`, synthetic: false, deliveryEligible: true,
    namespace: binding.namespace, targetId: binding.targetId, bindingRevisionId: binding.revisionId,
    source: { ...REVIEW_PLAN.source, id: 'synthetic-delivery-vector', verifiedLevel: 'integration' as const } };
  const context = createDemoContext(owner, at()), event = { id: `${name}-plan1`, addressId: view.addressId, operatorId: view.operatorId,
    serviceDate: view.serviceDate, fromRevisionId: null, toRevisionId: view.revisionId, kind: 'new_plan' as const, createdAt: at() };
  const committed = await events.commit(owner, event, view, context); assert.equal(committed.receipt.outcome, 'notification_committed');
  await repo.observeCurrentSource(owner, view, context);
  const queued = await repo.enqueueFromOutbox(owner, committed.messages[0].id, at(expirySeconds), at());
  return { owner, state: committed.state, view, event, context, job: queued.job };
}
const read = async (owner: string) => (await repo.snapshot(owner))[0];
async function pause(f: Awaited<ReturnType<typeof fixture>>, id = 'pause') {
  const state = (await pool.query('select state from lba_bot_sessions where owner_id=$1', [f.owner])).rows[0].state;
  return commitProfileMutation(f.owner, { id, expectedSessionId: state.sessionId, expectedRevision: state.revision, mutation: { kind: 'preferences', patch: { paused: true } } });
}
async function worker(transport: LocalTestTransport, seconds = 0, workerId = 'probe', timeoutMs = 1000) {
  return runLocalDeliveryAttempt(repo, transport, { workerId, now: () => at(seconds), leaseSeconds: 30, timeoutMs });
}
try {
  const marker = (await pool.query('select kind,source_revision,marker from lba_isolation_marker where singleton=true')).rows;
  assert.deepEqual(marker, [{ kind: 'synthetic', source_revision: '45d77e22e68816e5695aa4b7d2a62bfc57e8176d', marker: 'lba-local-only-v1' }]);
  if (process.argv[2] === 'resume') {
    const expected = JSON.parse(readFileSync(process.argv[3], 'utf8')); let calls = 0;
    const result = await worker({ kind: 'local-test-only', async send() { calls++; return { kind: 'sent', receipt: 'must-not-send' }; } }, 100, 'fresh-process');
    assert.equal(result.result, 'idle'); assert.equal(calls, 0);
    for (const owner of expected.unknownOwners) assert.equal((await read(owner)).state, 'outcome_unknown');
    assert.equal((await read(expected.sentOwner)).providerReceipt, 'simulated-one');
    checks.push('fresh_node_recovers_expired_dispatch_as_unknown_and_never_resends_ambiguous_attempts');
  } else {
    const f = await fixture('concurrent'); let calls = 0;
    const transport: LocalTestTransport = { kind: 'local-test-only', async send(envelope) { assert(Object.isFrozen(envelope)); calls++; return { kind: 'sent', receipt: 'simulated-one' }; } };
    assert((await repo.enqueueFromOutbox(f.owner, f.job.envelope.outboxId, at(900), at())).replayed);
    await assert.rejects(repo.enqueueFromOutbox(f.owner, f.job.envelope.outboxId, at(901), at()), /CONFLICT/);
    await assert.rejects(repo.enqueueFromOutbox('another-owner', f.job.envelope.outboxId, at(900), at()), /SYNTHETIC_OWNER/);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => worker(transport, 0, `parallel-${i}`)));
    assert.equal(calls, 1); assert.equal(results.filter(result => result.result === 'sent').length, 1); assert.equal((await read(f.owner)).state, 'sent');
    checks.push('actual_event_to_enqueue_dedup_and_eight_workers_only_one_transport_call');
    const tampered = await fixture('tampered-text'); let tamperedCalls = 0;
    await pool.query("update lba_delivery_jobs set record=jsonb_set(record,'{envelope,text}',$2::jsonb) where operation_id=$1", [tampered.job.envelope.operationId, JSON.stringify('Підмінений текст')]);
    assert.equal((await worker({ kind: 'local-test-only', async send() { tamperedCalls++; return { kind: 'sent', receipt: 'must-not-send' }; } })).result, 'cancelled');
    assert.equal(tamperedCalls, 0);
    const identity = await fixture('tampered-identity');
    await pool.query("update lba_delivery_jobs set record=jsonb_set(record,'{envelope,operationId}',$2::jsonb) where operation_id=$1", [identity.job.envelope.operationId, JSON.stringify('0'.repeat(64))]);
    await assert.rejects(worker(transport), /IDENTITY_MISMATCH/);
    await pool.query('delete from lba_delivery_jobs where owner_id=$1', [identity.owner]);
    checks.push('tampered_envelope_text_or_operation_identity_cannot_reach_transport');
    const unavailable = await fixture('source-failure');
    const missing = { ...unavailable.view, observedAt: at(1), revisionId: 'source-failed', status: 'unavailable' as const, dayCoverage: 'none' as const, intervals: [], freshness: 'unknown' as const, deliveryEligible: false, publishedAt: null };
    assert.equal((await repo.observeCurrentSource(unavailable.owner, missing, { actorId: unavailable.owner, now: at(1) })).allowed, false);
    assert.equal((await repo.observeCurrentSource(unavailable.owner, unavailable.view, unavailable.context)).reason, 'older_observation');
    let blockedCalls = 0; const mustNotSend: LocalTestTransport = { kind: 'local-test-only', async send() { blockedCalls++; return { kind: 'sent', receipt: 'must-not-send' }; } };
    assert.equal((await worker(mustNotSend, 2)).result, 'cancelled'); assert.equal(blockedCalls, 0);
    const conflicting = await fixture('source-conflict');
    const conflict = { ...conflicting.view, status: 'stale' as const, freshness: 'stale' as const, deliveryEligible: false };
    await repo.observeCurrentSource(conflicting.owner, conflict, conflicting.context);
    assert.equal((await repo.observeCurrentSource(conflicting.owner, conflicting.view, conflicting.context)).allowed, false);
    assert.equal((await worker(mustNotSend)).result, 'cancelled');
    checks.push('source_failure_and_equal_clock_conflict_block_old_payload_and_older_success_cannot_restore_permission');
    const noObservation = await fixture('missing-observation');
    await pool.query("delete from lba_bot_inbox where owner_id=$1 and input_id like 'event:admission:%'", [noObservation.owner]);
    assert.equal((await worker(mustNotSend)).result, 'cancelled');
    const expiredObservation = await fixture('expired-observation', 1800);
    assert.equal((await worker(mustNotSend, 901)).result, 'cancelled');
    assert.equal((await read(expiredObservation.owner)).attempts, 0); assert.equal(blockedCalls, 0);
    checks.push('missing_or_over_15min_source_observation_cancels_even_unexpired_job');
    const rate = await fixture('rate'); let rateCalls = 0;
    const rateTransport: LocalTestTransport = { kind: 'local-test-only', async send() { rateCalls++; return rateCalls === 1 ? { kind: 'rate_limited', retryAfterSeconds: 60 } : { kind: 'sent', receipt: 'after-rate' }; } };
    await worker(rateTransport); assert.equal((await read(rate.owner)).nextAttemptAt, at(60));
    assert.equal((await worker(rateTransport, 59)).result, 'idle'); await worker(rateTransport, 60); assert.equal(rateCalls, 2);
    checks.push('rate_limit_retry_after_durable_exact_wait_and_next_single_attempt');
    const retry = await fixture('retry'); let failures = 0, second = 0;
    for (let i = 0; i < 5; i++) {
      await worker({ kind: 'local-test-only', async send() { failures++; return { kind: 'not_sent', retryable: true, reason: 'test-safe-rejection' }; } }, second);
      second = (Date.parse((await read(retry.owner)).nextAttemptAt) - Date.parse(at())) / 1000;
    }
    assert.equal(failures, 5); assert.equal((await read(retry.owner)).state, 'failed');
    checks.push('definite_not_sent_uses_bounded_backoff_and_five_attempt_limit');
    const uncertain = await fixture('timeout'); let uncertainEffects = 0;
    await worker({ kind: 'local-test-only', async send() { uncertainEffects++; return new Promise(() => {}); } }, 0, 'timeout', 10);
    assert.equal((await read(uncertain.owner)).state, 'outcome_unknown');
    assert.equal((await worker(transport)).result, 'idle'); assert.equal(uncertainEffects, 1);
    checks.push('timeout_after_simulated_effect_stays_unknown_with_no_blind_retry');
    const unstarted = await fixture('lease');
    const old = await repo.claim('old-worker', at(), 1); assert(old);
    const fresh = await repo.claim('new-worker', at(2), 30); assert(fresh); assert.equal(fresh.fence, old.fence + 1);
    assert.equal(await repo.begin(old, at(2)), 'lost'); await assert.rejects(repo.finish(old, { kind: 'sent', receipt: 'stale' }, at(2)), /FENCE_LOST/);
    assert.equal(await repo.begin(fresh, at(2)), 'dispatch'); await repo.finish(fresh, { kind: 'sent', receipt: 'new-fence' }, at(2));
    assert.equal((await read(unstarted.owner)).providerReceipt, 'new-fence');
    checks.push('unstarted_expired_lease_can_be_reclaimed_but_old_fence_cannot_dispatch_or_ack');
    const beforePause = await fixture('pause'), pauseClaim = await repo.claim('pause-worker', at(), 30); assert(pauseClaim);
    await pause(beforePause); assert.equal(await repo.begin(pauseClaim, at()), 'cancelled'); assert.equal((await read(beforePause.owner)).attempts, 0);
    const deleted = await fixture('delete'), deleteClaim = await repo.claim('delete-worker', at(), 30); assert(deleteClaim);
    await commitProfileMutation(deleted.owner, { id: 'delete', expectedSessionId: deleted.state.sessionId, expectedRevision: deleted.state.revision, mutation: { kind: 'delete', addressId: deleted.view.addressId, confirmed: true } });
    assert.equal(await repo.begin(deleteClaim, at()), 'cancelled');
    checks.push('pause_and_address_delete_after_claim_are_rechecked_before_any_transport_call');
    const inFlight = await fixture('inflight'), flightClaim = await repo.claim('flight-worker', at(), 30); assert(flightClaim);
    assert.equal(await repo.begin(flightClaim, at()), 'dispatch'); await pause(inFlight); await repo.cancel(inFlight.owner, inFlight.job.envelope.operationId);
    await repo.finish(flightClaim, { kind: 'sent', receipt: 'already-in-flight' }, at());
    assert.equal((await read(inFlight.owner)).state, 'sent'); assert((await read(inFlight.owner)).cancelRequested);
    checks.push('cancel_after_dispatch_retains_known_sent_receipt_without_claiming_unsend');
    const obsolete = await fixture('obsolete'), obsoleteClaim = await repo.claim('obsolete-worker', at(), 30); assert(obsoleteClaim);
    const newer = structuredClone(obsolete.view); newer.revisionId = 'obsolete-plan2'; newer.intervals[1].startsAt = '2026-11-07T16:00:00+02:00'; newer.intervals[1].startLocal = '16:00';
    await events.commit(obsolete.owner, { ...obsolete.event, id: 'obsolete-plan2', kind: 'changed', fromRevisionId: obsolete.view.revisionId, toRevisionId: newer.revisionId }, newer, obsolete.context);
    assert.equal(await repo.begin(obsoleteClaim, at()), 'cancelled');
    const reset = await fixture('reset'), resetClaim = await repo.claim('reset-worker', at(), 30); assert(resetClaim);
    await resetBotSession(reset.owner, true); assert.equal(await repo.begin(resetClaim, at()), 'cancelled');
    checks.push('changed_current_semantics_and_reset_session_fence_old_queued_payload');
    const crash = await fixture('crash'), crashClaim = await repo.claim('crashed-worker', at(), 30); assert(crashClaim);
    assert.equal(await repo.begin(crashClaim, at()), 'dispatch');
    const fault = await fixture('finishfault'), faultClaim = await repo.claim('fault-worker', at(), 30); assert(faultClaim); assert.equal(await repo.begin(faultClaim, at()), 'dispatch');
    await pool.query(`create function lba_delivery_finish_fault() returns trigger language plpgsql as $$ begin if new.owner_id='lba-synthetic-delivery-finishfault' and new.record->>'state'='sent' then raise exception 'synthetic finish failure'; end if;return new;end $$`);
    await pool.query('create trigger lba_delivery_finish_fault_trigger before update on lba_delivery_jobs for each row execute function lba_delivery_finish_fault()');
    try { await assert.rejects(repo.finish(faultClaim, { kind: 'sent', receipt: 'simulated-effect-before-db-fault' }, at()), /synthetic finish failure/); }
    finally { await pool.query('drop trigger lba_delivery_finish_fault_trigger on lba_delivery_jobs'); await pool.query('drop function lba_delivery_finish_fault()'); }
    assert.equal((await read(fault.owner)).state, 'dispatching'); assert.equal((await read(fault.owner)).providerReceipt, null);
    checks.push('actual_pg_receipt_write_failure_preserves_dispatch_uncertainty_instead_of_retry');
    const late = await fixture('late'), lateClaim = await repo.claim('late-worker', at(), 1); assert(lateClaim); assert.equal(await repo.begin(lateClaim, at()), 'dispatch');
    await repo.finish(lateClaim, { kind: 'unknown', reason: 'simulated-timeout' }, at()); await repo.finish(lateClaim, { kind: 'sent', receipt: 'late-confirmed' }, at(2));
    assert.equal((await read(late.owner)).state, 'sent'); assert.equal((await read(late.owner)).attempts, 1);
    checks.push('late_known_result_resolves_same_unknown_fence_without_another_dispatch');
    writeFileSync(process.argv[3], JSON.stringify({ sentOwner: f.owner, unknownOwners: [uncertain.owner, crash.owner, fault.owner] }));
  }
  console.log(JSON.stringify({ result: 'pass', checks }));
} finally { await pool.end(); }
