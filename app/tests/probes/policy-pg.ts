import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { assertIsolatedConfig, installIsolatedEgressGuard } from '../../server/isolated-guard.ts';
import { createBotState } from '../../shared/bot/engine.ts';
import { createDemoContext, createDemoProfile } from '../../shared/bot/fixtures.ts';
import { defaultNotificationPolicy } from '../../shared/notification-policy.ts';
import { REVIEW_PLAN } from '../../shared/review-fixtures.ts';
import type { BotState } from '../../shared/bot/types.ts';
import type { ScheduleEvent, ScheduleView } from '../../shared/product-contract.ts';

const config = assertIsolatedConfig(); installIsolatedEgressGuard(config);
const owner = 'lba-synthetic-policy-parent-review';
const { pool } = await import('../../server/db');
const { commitProfileMutation, commitBotInput } = await import('../../server/domain/bot-session-store.ts');
const { createLocalScheduleEventStore } = await import('../../server/domain/schedule-event-store.ts');
const store = createLocalScheduleEventStore(pool), checks: string[] = [];
async function saved(): Promise<BotState> { return (await pool.query('select state from lba_bot_sessions where owner_id=$1', [owner])).rows[0].state; }
async function saveState(state: BotState) {
  const client = await pool.connect();
  try { await client.query('begin'); await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
    await client.query('update lba_bot_sessions set revision=$2,state=$3::jsonb where owner_id=$1', [owner, state.revision, JSON.stringify(state)]); await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}
try {
  const marker = (await pool.query('select kind,source_revision,marker from lba_isolation_marker where singleton=true')).rows;
  assert.deepEqual(marker, [{ kind: 'synthetic', source_revision: '45d77e22e68816e5695aa4b7d2a62bfc57e8176d', marker: 'lba-local-only-v1' }]);
  if (process.argv[2] === 'resume') {
    const expected = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    assert.deepEqual(await saved(), expected.state);
    const result = await store.commit(owner, expected.event, expected.view, expected.context);
    assert(result.replayed); assert.equal(result.receipt.id, expected.receiptId);
    assert.deepEqual(result.state.profile.preferences.notificationPolicy, expected.state.profile.preferences.notificationPolicy);
    checks.push('fresh_node_process_restores_independent_policy_and_replays_same_event_receipt');
  } else {
    const profile = createDemoProfile(owner); profile.preferences.optedIn = true; profile.preferences.reminders = true;
    profile.preferences.minimumOutageMinutes = 1500;
    profile.preferences.notificationPolicy = defaultNotificationPolicy(profile.preferences);
    profile.preferences.notificationPolicy.channels.telegram.beforeOffMinutes = 0;
    profile.preferences.notificationPolicy.channels.telegram.beforeOnMinutes = 5;
    profile.preferences.remindBeforeMinutes = 0;
    profile.preferences.notificationPolicy.channels.push = { enabled: true, remindersEnabled: true, beforeOffMinutes: 37, beforeOnMinutes: 13 };
    profile.locations[0].notifications = true;
    profile.locations[0].notificationPolicy = { version: 'lba-notification-policy/1', channels: { telegram: { enabled: true }, push: { enabled: false } } };
    const initial = createBotState({ ownerId: owner, sessionId: 'p3-policy-pg', profile });
    const setup = await pool.connect();
    try { await setup.query('begin'); await setup.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
      for (const table of ['lba_bot_outbox', 'lba_bot_inbox', 'lba_bot_sessions']) await setup.query(`delete from ${table} where owner_id=$1`, [owner]);
      await setup.query('insert into lba_bot_sessions(owner_id,session_id,revision,state) values($1,$2,$3,$4::jsonb)', [owner, initial.sessionId, initial.revision, JSON.stringify(initial)]); await setup.query('commit');
    } catch (error) { await setup.query('rollback'); throw error; } finally { setup.release(); }
    const binding = profile.locations[0].binding;
    // Explicit eligibility vectors only. These flags never certify a public source or real address.
    const view: ScheduleView = { ...structuredClone(REVIEW_PLAN), revisionId: 'policy-pg-plan', synthetic: false, deliveryEligible: true,
      namespace: binding.namespace, targetId: binding.targetId, bindingRevisionId: binding.revisionId,
      source: { ...REVIEW_PLAN.source, id: 'synthetic-policy-vector', verifiedLevel: 'integration' } };
    const context = createDemoContext(owner, '2026-11-07T17:25:00+02:00');
    const event: ScheduleEvent = { id: 'policy-pg-on', addressId: view.addressId, operatorId: view.operatorId, serviceDate: view.serviceDate,
      fromRevisionId: null, toRevisionId: view.revisionId, kind: 'reminder', createdAt: context.now,
      reminder: { edge: 'ends', intervalStartsAt: view.intervals[1].startsAt, intervalEndsAt: view.intervals[1].endsAt } };
    const values = await Promise.all(Array.from({ length: 6 }, () => store.commit(owner, event, view, context)));
    assert.equal(new Set(values.map(value => value.receipt.id)).size, 1); assert.equal(values.filter(value => !value.replayed).length, 1);
    assert.equal(values[0].receipt.outcome, 'notification_committed'); assert.equal(values[0].messages.length, 1);
    checks.push('six_concurrent_end_reminders_one_pg_commit_despite_1500min_start_only_minimum');
    const offContext = { ...context, now: '2026-11-07T14:30:00+02:00' };
    const offEvent = { ...event, id: 'policy-pg-off-zero', createdAt: offContext.now, reminder: { ...event.reminder!, edge: 'starts' as const } };
    const off = await store.commit(owner, offEvent, view, offContext); assert.equal(off.receipt.outcome, 'ignored');
    checks.push('global_before_off_zero_does_not_fall_back_to_old_generic_lead');
    const beforeMutation = await saved(), localPolicy = structuredClone(beforeMutation.profile.locations[0].notificationPolicy!);
    localPolicy.channels.telegram.enabled = false;
    const input = { id: 'policy-pg-local-off', expectedSessionId: beforeMutation.sessionId, expectedRevision: beforeMutation.revision,
      mutation: { kind: 'location' as const, addressId: view.addressId, notificationPolicy: localPolicy } };
    const change = await commitProfileMutation(owner, input);
    assert(!change.profile.locations[0].notifications); assert(change.profile.preferences.notificationPolicy!.channels.push.enabled);
    assert.equal(change.profile.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 5);
    const no = await store.commit(owner, { ...event, id: 'policy-pg-local-block' }, view, context); assert.equal(no.receipt.outcome, 'ignored');
    checks.push('actual_profile_mutation_keeps_push_and_other_edge_while_local_TG_optout_blocks_event');
    const restored = await saved(); restored.profile.locations[0].notifications = true;
    restored.profile.locations[0].notificationPolicy!.channels.telegram.enabled = true;
    restored.profile.locations[0].notificationPolicy!.channels.telegram.beforeOnMinutes = 0; await saveState(restored);
    await pool.query('insert into lba_bot_outbox(id,owner_id,input_id,address_id,revision,ordinal,payload) values($1,$2,$3,$4,0,0,$5::jsonb)',
      ['policy-pg-pending', owner, 'event:input:policy-pg-pending', view.addressId, JSON.stringify({ id: 'policy-pg-pending', kind: 'notification', text: 'Тестовий запис', buttons: [], schedule: view, event })]);
    await store.snapshot(owner, context.now);
    assert.equal((await pool.query('select status from lba_bot_outbox where owner_id=$1 and id=$2', [owner, 'policy-pg-pending'])).rows[0].status, 'cancelled');
    checks.push('pending_event_rechecks_new_local_end_zero_before_local_publication');
    const beforeFault = await saved();
    await pool.query(`create function lba_p3_policy_fault() returns trigger language plpgsql as $$ begin if new.owner_id='lba-synthetic-policy-parent-review' and new.input_id='policy-pg-fault' then raise exception 'policy synthetic fault'; end if;return new;end $$`);
    await pool.query('create trigger lba_p3_policy_fault_trigger before insert on lba_bot_outbox for each row execute function lba_p3_policy_fault()');
    try { await assert.rejects(commitBotInput(owner, { id: 'policy-pg-fault', kind: 'command', text: '/push_off' }), /policy synthetic fault/); }
    finally { await pool.query('drop trigger lba_p3_policy_fault_trigger on lba_bot_outbox'); await pool.query('drop function lba_p3_policy_fault()'); }
    assert.deepEqual(await saved(), beforeFault);
    assert.equal((await pool.query('select count(*)::int as n from lba_bot_inbox where owner_id=$1 and input_id=$2', [owner, 'policy-pg-fault'])).rows[0].n, 0);
    checks.push('actual_outbox_failure_rolls_back_typed_push_change_and_input_ledger');
    const success = await commitBotInput(owner, { id: 'policy-pg-fault', kind: 'command', text: '/push_off' });
    assert(!success.state!.profile.preferences.notificationPolicy!.channels.push.enabled);
    assert.equal(success.state!.profile.preferences.notificationPolicy!.channels.push.beforeOffMinutes, 37);
    assert.equal(success.state!.profile.preferences.notificationPolicy!.channels.telegram.beforeOnMinutes, 5);
    checks.push('same_id_after_rollback_commits_only_requested_channel_without_losing_its_times');
    writeFileSync(process.argv[3], JSON.stringify({ state: await saved(), receiptId: values[0].receipt.id, event, view, context }));
  }
  console.log(JSON.stringify({ result: 'pass', checks }));
} finally { await pool.end(); }
