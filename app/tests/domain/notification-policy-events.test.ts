import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalScheduleEventStore, type EventClient, type EventPool } from '../../server/domain/schedule-event-store.ts';
import { createBotState } from '../../shared/bot/engine.ts';
import { createDemoContext, createDemoProfile } from '../../shared/bot/fixtures.ts';
import { REVIEW_PLAN } from '../../shared/review-fixtures.ts';
import type { BotState } from '../../shared/bot/types.ts';
import type { ScheduleEvent, ScheduleView } from '../../shared/product-contract.ts';

import { NOTIFICATION_POLICY_VERSION as VERSION, defaultNotificationPolicy } from '../../shared/notification-policy.ts';

const owner = 'lba-synthetic-policy-event-test';
function fixture() {
  const profile = createDemoProfile(owner); profile.preferences.optedIn = true; profile.locations[0].notifications = true;
  profile.locations[0].address.label = 'Офіс';
  const state = createBotState({ ownerId: owner, sessionId: 'event-test-session', profile });
  const binding = profile.locations[0].binding;
  const view: ScheduleView = { ...structuredClone(REVIEW_PLAN), revisionId: 'plan-a', synthetic: false, deliveryEligible: true,
    namespace: binding.namespace, targetId: binding.targetId, bindingRevisionId: binding.revisionId,
    source: { ...REVIEW_PLAN.source, id: 'synthetic-eligibility-vector', name: 'Синтетичний вектор допуску', verifiedLevel: 'integration' } };
  const context = createDemoContext(owner), event: ScheduleEvent = { id: 'plan-a-event', addressId: view.addressId,
    operatorId: view.operatorId, serviceDate: view.serviceDate, fromRevisionId: null, toRevisionId: view.revisionId, kind: 'new_plan', createdAt: context.now };
  return { state, view, context, event };
}
type Row = { id: string; owner: string; inputId: string; address: string | null; revision: number; ordinal: number; payload: any; status: string; sequence: number };
function mock(initial: BotState) {
  let db = { state: structuredClone(initial), inbox: new Map<string, { input_digest: string; receipt: any }>(), outbox: [] as Row[], sequence: 0 };
  let fail = '', releases = 0;
  const result = (rows: any[] = [], count: number | null = rows.length) => ({ rows, rowCount: count });
  const pool: EventPool = { async connect() {
    let backup: typeof db | null = null;
    const client: EventClient = { release() { releases++; }, async query(sql, values = []) {
      const text = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === 'begin') { backup = structuredClone(db); return result(); }
      if (text === 'rollback') { if (backup) db = backup; backup = null; return result(); }
      if (text === 'commit') { backup = null; if (fail === 'commit-ack') { fail = ''; throw new Error('COMMIT_ACK_LOST'); } return result(); }
      if (text.includes('lba_isolation_marker')) return result([{ kind: 'synthetic', source_revision: '45d77e22e68816e5695aa4b7d2a62bfc57e8176d', marker: 'lba-local-only-v1' }]);
      if (text.startsWith('select pg_advisory')) return result();
      if (text.startsWith('select state from lba_bot_sessions')) return result([{ state: structuredClone(db.state) }]);
      if (text.startsWith('select input_digest,receipt')) { const value = db.inbox.get(values[1]); return result(value ? [structuredClone(value)] : []); }
      if (text.startsWith('select receipt')) { const value = db.inbox.get(values[1]); return result(value ? [{ receipt: structuredClone(value.receipt) }] : []); }
      if (text.startsWith('select id,payload')) return result(db.outbox.filter(row => row.owner === values[0] && row.status === 'pending' && row.payload.kind === 'notification' &&
        (!text.includes("input_id like 'event:%'") || row.inputId.startsWith('event:'))).map(row => ({ id: row.id, payload: structuredClone(row.payload) })));
      if (text.startsWith('update lba_bot_sessions')) { db.state = JSON.parse(values[2]); return result([], 1); }
      if (text.startsWith('insert into lba_bot_outbox')) {
        if (fail === 'outbox') { fail = ''; throw new Error('OUTBOX_INSERT_FAILED'); }
        db.outbox.push({ id: values[0], owner: values[1], inputId: values[2], address: values[3], revision: values[4], ordinal: values[5], payload: JSON.parse(values[6]), status: 'pending', sequence: ++db.sequence }); return result([], 1);
      }
      if (text.startsWith('insert into lba_bot_inbox')) {
        if (fail === 'inbox') { fail = ''; throw new Error('INBOX_INSERT_FAILED'); }
        if (db.inbox.has(values[1]) && !text.includes('on conflict')) throw new Error('DUPLICATE_INBOX');
        db.inbox.set(values[1], { input_digest: values[2], receipt: JSON.parse(values[3]) }); return result([], 1);
      }
      if (text.startsWith("update lba_bot_outbox set status='cancelled'")) {
        let count = 0; for (const row of db.outbox) {
          const match = text.includes('where id=') ? row.id === values[0] && row.owner === values[1] : row.owner === values[0] && (!values[1] || row.address === values[1]);
          if (match && row.status === 'pending' && (text.includes("payload->>'kind'") ? row.payload.kind === 'notification' : true)) { row.status = 'cancelled'; count++; }
        } return result([], count);
      }
      if (text.startsWith("update lba_bot_outbox set status='simulated_delivered'")) {
        let count = 0; for (const row of db.outbox) if (row.owner === values[0] && row.status === 'pending' && row.inputId.startsWith('event:') && row.payload.kind === 'notification') { row.status = 'simulated_delivered'; count++; } return result([], count);
      }
      if (text.startsWith('select payload')) {
        if (fail === 'snapshot') { fail = ''; throw new Error('SNAPSHOT_FAILED'); }
        return result(db.outbox.filter(row => row.owner === values[0] && row.status === 'simulated_delivered').sort((a, b) => a.sequence - b.sequence).map(row => ({ payload: structuredClone(row.payload) })));
      }
      throw new Error(`UNHANDLED_SQL: ${text}`);
    } }; return client;
  } };
  let guards = 0;
  return { store: createLocalScheduleEventStore(pool, () => { guards++; }), get db() { return db; }, setFailure(value: string) { fail = value; }, get releases() { return releases; }, get guards() { return guards; } };
}

function typedFixture() {
  const f = fixture(); f.state.profile.preferences.reminders = true;
  f.state.profile.preferences.notificationPolicy = defaultNotificationPolicy(f.state.profile.preferences);
  f.state.profile.locations[0].notificationPolicy = { version: VERSION, channels: { telegram: { enabled: true, beforeOffMinutes: 0, beforeOnMinutes: 10 }, push: { enabled: false } } };
  return f;
}
test('typed global and local opt-outs still establish trusted semantic baseline, so resume creates no backlog', async () => {
  for (const mode of ['global', 'local']) {
    const f = typedFixture();
    if (mode === 'global') f.state.profile.preferences.notificationPolicy!.channels.telegram.enabled = false;
    else f.state.profile.locations[0].notificationPolicy!.channels.telegram.enabled = false;
    const h = mock(f.state), before = await h.store.commit(owner, f.event, f.view, f.context);
    assert.equal(before.receipt.outcome, 'ignored', mode); assert.equal(h.db.outbox.length, 0, mode);
    assert([...h.db.inbox.values()].some(row => row.receipt.kind === 'lba-event-cursor/1'), mode);
    h.db.state.profile.preferences.notificationPolicy!.channels.telegram.enabled = true;
    h.db.state.profile.locations[0].notificationPolicy!.channels.telegram.enabled = true;
    const refresh = { ...f.view, revisionId: 'same-plan-after-resume' };
    const resumed = await h.store.commit(owner, { ...f.event, id: 'after-resume', kind: 'changed', fromRevisionId: f.view.revisionId, toRevisionId: refresh.revisionId }, refresh, f.context);
    assert.equal(resumed.receipt.reason, 'semantic_unchanged', mode); assert.equal(h.db.outbox.length, 0, mode);
  }
});
test('publication rechecks explicit local edge0, independent before-on lead and hours-based before-off filter', async () => {
  for (const mode of ['zero-start', 'on-time-end', 'old-global-window', 'short-start']) {
    const f = typedFixture(); f.state.profile.preferences.minimumOutageMinutes = 1500;
    const edge = mode === 'zero-start' || mode === 'short-start' ? 'starts' : 'ends';
    if (mode === 'short-start') f.state.profile.locations[0].notificationPolicy!.channels.telegram.beforeOffMinutes = 10;
    const now = mode === 'zero-start' ? '2026-11-07T14:30:10+02:00' : mode === 'short-start' ? '2026-11-07T14:50:10+02:00' : mode === 'on-time-end' ? '2026-11-07T17:20:10+02:00' : '2026-11-07T17:00:10+02:00';
    const event: ScheduleEvent = { ...f.event, id: `pending-${mode}`, kind: 'reminder', createdAt: now,
      reminder: { edge, intervalStartsAt: f.view.intervals[1].startsAt, intervalEndsAt: f.view.intervals[1].endsAt } };
    const h = mock(f.state);
    h.db.outbox.push({ id: event.id, owner, inputId: `event:input:${event.id}`, address: f.view.addressId, revision: 0, ordinal: 0,
      payload: { id: event.id, kind: 'notification', schedule: f.view, event }, status: 'pending', sequence: ++h.db.sequence });
    const result = await h.store.snapshot(owner, now), allowed = mode === 'on-time-end';
    assert.equal(result.messages.length, allowed ? 1 : 0, mode);
    assert.equal(h.db.outbox[0].status, allowed ? 'simulated_delivered' : 'cancelled', mode);
  }
});
test('pending typed channel consent cannot pass stale binding or source evidence', async () => {
  for (const mode of ['binding', 'source']) {
    const f = typedFixture();
    if (mode === 'binding') f.state.profile.locations[0].binding.status = 'needs_confirmation';
    else f.view.source.verifiedLevel = 'catalog';
    const h = mock(f.state), event = f.event;
    h.db.outbox.push({ id: event.id, owner, inputId: `event:input:${event.id}`, address: f.view.addressId, revision: 0, ordinal: 0,
      payload: { id: event.id, kind: 'notification', schedule: f.view, event }, status: 'pending', sequence: ++h.db.sequence });
    assert.equal((await h.store.snapshot(owner, f.context.now)).messages.length, 0, mode);
    assert.equal(h.db.outbox[0].status, 'cancelled', mode);
  }
});
