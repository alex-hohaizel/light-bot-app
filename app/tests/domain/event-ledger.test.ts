import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalScheduleEventStore, type EventClient, type EventPool } from '../../server/domain/schedule-event-store.ts';
import { createBotState } from '../../shared/bot/engine.ts';
import { createDemoContext, createDemoProfile } from '../../shared/bot/fixtures.ts';
import { REVIEW_PLAN } from '../../shared/review-fixtures.ts';
import type { BotState } from '../../shared/bot/types.ts';
import type { ScheduleEvent, ScheduleView } from '../../shared/product-contract.ts';

const owner = 'lba-synthetic-event-test';
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

test('one committed event stores exact card revision/text/profile label; repeats have one receipt', async () => {
  const f = fixture(), h = mock(f.state), result = await h.store.commit(owner, f.event, f.view, f.context);
  assert.equal(result.receipt.outcome, 'notification_committed'); assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].schedule.revisionId, f.event.toRevisionId); assert.equal(result.messages[0].schedule.addressLabel, 'Офіс');
  assert.match(result.messages[0].text, /Офіс/); assert.equal(result.messages[0].scheduleRevisionId, f.view.revisionId);
  assert.deepEqual(result.messages[0].schedule.intervals, f.view.intervals); assert.equal(f.view.addressLabel, 'Дім');
  const repeated = await h.store.commit(owner, f.event, f.view, f.context);
  assert.equal(repeated.receipt.id, result.receipt.id); assert(repeated.replayed); assert.equal(h.db.outbox.length, 1);
  await assert.rejects(h.store.commit(owner, { ...f.event, createdAt: '2026-11-07T09:59:00+02:00' }, f.view, f.context), /EVENT_ID_CONFLICT/);
  assert(h.guards >= 4); assert(h.releases >= 4);
});
test('format/provenance-only revisions are silent; A→B→A transitions both notify', async () => {
  const f = fixture(), h = mock(f.state); await h.store.commit(owner, f.event, f.view, f.context);
  const split = structuredClone(f.view); split.revisionId = 'plan-a-format'; split.source.revision = 'new-provenance';
  split.intervals.splice(0, 1, { ...f.view.intervals[0], endsAt: '2026-11-07T08:00:00+02:00', endLocal: '08:00' }, { ...f.view.intervals[0], startsAt: '2026-11-07T08:00:00+02:00', startLocal: '08:00' });
  const silent = await h.store.commit(owner, { ...f.event, id: 'format', kind: 'changed', toRevisionId: split.revisionId, fromRevisionId: f.view.revisionId }, split, f.context);
  assert.equal(silent.receipt.reason, 'semantic_unchanged'); assert.equal(h.db.outbox.length, 1);
  const b = structuredClone(f.view); b.revisionId = 'plan-b'; b.intervals[0].endsAt = '2026-11-07T11:30:00+02:00'; b.intervals[0].endLocal = '11:30';
  await h.store.commit(owner, { ...f.event, id: 'b', kind: 'changed', fromRevisionId: split.revisionId, toRevisionId: b.revisionId }, b, f.context);
  const a = { ...f.view, revisionId: 'plan-a-return' };
  const returned = await h.store.commit(owner, { ...f.event, id: 'a-return', kind: 'changed', fromRevisionId: b.revisionId, toRevisionId: a.revisionId }, a, f.context);
  assert.equal(returned.messages.length, 3); assert.equal(h.db.outbox.length, 3);
});
test('out-of-order changed baseline is ignored without advancing the cursor', async () => {
  const f = fixture(), h = mock(f.state); await h.store.commit(owner, f.event, f.view, f.context);
  const b = structuredClone(f.view); b.revisionId = 'plan-b'; b.intervals[0].endsAt = '2026-11-07T11:30:00+02:00'; b.intervals[0].endLocal = '11:30';
  const result = await h.store.commit(owner, { ...f.event, id: 'b', kind: 'changed', fromRevisionId: 'unknown', toRevisionId: b.revisionId }, b, f.context);
  assert.equal(result.receipt.reason, 'revision_mismatch'); assert.equal(h.db.outbox.length, 1);
  const cursor = [...h.db.inbox.values()].find(row => row.receipt.kind === 'lba-event-cursor/1'); assert.equal(cursor?.receipt.revisionId, 'plan-a');
});
test('wrong-lineage equal-semantic refresh cannot advance cursor or block the valid next change', async () => {
  const f = fixture(), h = mock(f.state); await h.store.commit(owner, f.event, f.view, f.context);
  const unchanged = { ...f.view, revisionId: 'rogue-format-revision' };
  const blocked = await h.store.commit(owner, { ...f.event, id: 'rogue-format', kind: 'changed', fromRevisionId: 'not-current', toRevisionId: unchanged.revisionId }, unchanged, f.context);
  assert.equal(blocked.receipt.reason, 'revision_mismatch');
  const cursor = [...h.db.inbox.values()].find(row => row.receipt.kind === 'lba-event-cursor/1'); assert.equal(cursor?.receipt.revisionId, f.view.revisionId);
  const changed = structuredClone(f.view); changed.revisionId = 'valid-b'; changed.intervals[0].endsAt = '2026-11-07T11:30:00+02:00'; changed.intervals[0].endLocal = '11:30';
  const accepted = await h.store.commit(owner, { ...f.event, id: 'valid-b', kind: 'changed', fromRevisionId: f.view.revisionId, toRevisionId: changed.revisionId }, changed, f.context);
  assert.equal(accepted.receipt.outcome, 'notification_committed'); assert.equal(accepted.messages.length, 2);
});
test('synthetic/unverified/opt-out events do not enqueue or silently certify data', async () => {
  for (const mode of ['synthetic', 'catalog', 'optout', 'paused', 'foreign-binding']) {
    const f = fixture();
    if (mode === 'synthetic') { f.view.synthetic = true; f.view.deliveryEligible = false; }
    if (mode === 'catalog') { f.view.source.verifiedLevel = 'catalog'; f.view.deliveryEligible = false; }
    if (mode === 'optout') f.state.profile.preferences.optedIn = false;
    if (mode === 'paused') f.state.profile.preferences.paused = true;
    if (mode === 'foreign-binding') f.state.profile.locations[0].binding.targetId = 'other';
    const h = mock(f.state), result = await h.store.commit(owner, f.event, f.view, f.context);
    assert.equal(result.receipt.outcome, 'ignored', mode); assert.equal(h.db.outbox.length, 0, mode);
    assert.equal(f.view.synthetic, mode === 'synthetic');
  }
});
test('unknown kind, actor, malformed clock and mismatched cancellation are rejected before DB writes', async () => {
  const f = fixture(), h = mock(f.state);
  for (const event of [{ ...f.event, kind: 'FutureUnknown' }, { ...f.event, createdAt: 'tomorrow' }, { ...f.event, kind: 'cancelled' }]) await assert.rejects(h.store.commit(owner, event as ScheduleEvent, f.view, f.context));
  await assert.rejects(h.store.commit(owner, f.event, f.view, { ...f.context, actorId: 'other' }), /ACTOR/);
  assert.equal(h.db.inbox.size, 0); assert.equal(h.db.outbox.length, 0);
});
test('pause cancels pending notifications but preserves pending manual replies', async () => {
  const f = fixture(); f.state.profile.preferences.paused = true; const h = mock(f.state);
  for (const kind of ['notification', 'reply']) h.db.outbox.push({ id: kind, owner, inputId: `manual:${kind}`, address: f.view.addressId, revision: 0, ordinal: 0, payload: { kind, schedule: f.view }, status: 'pending', sequence: ++h.db.sequence });
  const result = await h.store.commit(owner, f.event, f.view, f.context);
  assert.equal(result.receipt.cancelledPending, 1); assert.equal(h.db.outbox.find(row => row.id === 'notification')?.status, 'cancelled');
  assert.equal(h.db.outbox.find(row => row.id === 'reply')?.status, 'pending');
});
test('emergency cancels planned pending only and respects quiet hours', async () => {
  const f = fixture(), h = mock(f.state);
  const emergency: ScheduleView = { ...f.view, revisionId: 'emergency', status: 'emergency', intervals: [], dayCoverage: 'none' };
  h.db.outbox.push({ id: 'planned-pending', owner, inputId: 'event:input:prior', address: f.view.addressId, revision: 0, ordinal: 0, payload: { kind: 'notification', schedule: f.view }, status: 'pending', sequence: ++h.db.sequence });
  const result = await h.store.commit(owner, { ...f.event, id: 'emergency-event', kind: 'emergency', toRevisionId: emergency.revisionId }, emergency, f.context);
  assert.equal(h.db.outbox[0].status, 'cancelled'); assert.equal(result.messages.length, 1); assert.match(result.messages[0].text, /Погодинний план може не діяти/);
  const quiet = fixture(); quiet.state.profile.preferences.quietHours.enabled = true;
  const suppressed = await mock(quiet.state).store.commit(owner, { ...quiet.event, id: 'quiet-emergency', kind: 'emergency', toRevisionId: emergency.revisionId }, emergency, { ...quiet.context, now: '2026-11-07T23:00:00+02:00' });
  assert.equal(suppressed.receipt.outcome, 'ignored'); assert.equal(suppressed.messages.length, 0);
});
test('same reminder edge commits once even if scheduler changes event ID or raw revision', async () => {
  const f = fixture(); f.state.profile.preferences.reminders = true;
  const h = mock(f.state), context = { ...f.context, now: '2026-11-07T14:30:10+02:00' };
  const event: ScheduleEvent = { ...f.event, id: 'reminder-a', createdAt: context.now, kind: 'reminder', reminder: { edge: 'starts', intervalStartsAt: f.view.intervals[1].startsAt, intervalEndsAt: f.view.intervals[1].endsAt } };
  const first = await h.store.commit(owner, event, f.view, context); assert.equal(first.messages.length, 1);
  const refreshed = { ...f.view, revisionId: 'same-edge-new-raw' };
  refreshed.intervals = f.view.intervals.map(interval => ({ ...interval, startsAt: new Date(interval.startsAt).toISOString(), endsAt: new Date(interval.endsAt).toISOString() }));
  const second = await h.store.commit(owner, { ...event, id: 'reminder-b', toRevisionId: refreshed.revisionId,
    reminder: { ...event.reminder!, intervalStartsAt: new Date(event.reminder!.intervalStartsAt).toISOString(), intervalEndsAt: new Date(event.reminder!.intervalEndsAt).toISOString() } }, refreshed, context);
  assert.equal(second.receipt.reason, 'reminder_already_committed'); assert.equal(h.db.outbox.length, 1);
});
test('new admitted semantics cancel same-scope older pending plan and reminder, preserving manual reply', async () => {
  const f = fixture(); f.state.profile.preferences.reminders = true; const h = mock(f.state);
  await h.store.commit(owner, f.event, f.view, f.context);
  const context = { ...f.context, now: '2026-11-07T14:30:10+02:00' };
  const reminder: ScheduleEvent = { ...f.event, id: 'old-reminder', kind: 'reminder', createdAt: '2026-11-07T14:30:00+02:00',
    reminder: { edge: 'starts', intervalStartsAt: f.view.intervals[1].startsAt, intervalEndsAt: f.view.intervals[1].endsAt } };
  for (const [id, kind, event] of [['old-plan', 'notification', f.event], ['old-reminder', 'notification', reminder], ['manual-schedule', 'schedule', f.event]] as const)
    h.db.outbox.push({ id, owner, inputId: kind === 'schedule' ? 'manual:requested' : `event:input:${id}`, address: f.view.addressId, revision: 0, ordinal: 0,
      payload: { id, kind, schedule: f.view, event }, status: 'pending', sequence: ++h.db.sequence });
  const changed = structuredClone(f.view); changed.revisionId = 'new-b'; changed.intervals[1].startsAt = '2026-11-07T16:00:00+02:00'; changed.intervals[1].startLocal = '16:00';
  const result = await h.store.commit(owner, { ...f.event, id: 'new-b', kind: 'changed', fromRevisionId: f.view.revisionId, toRevisionId: changed.revisionId }, changed, context);
  assert.equal(result.receipt.supersededPending, 2); assert.equal(h.db.outbox.find(row => row.id === 'old-plan')?.status, 'cancelled');
  assert.equal(h.db.outbox.find(row => row.id === 'old-reminder')?.status, 'cancelled'); assert.equal(h.db.outbox.find(row => row.id === 'manual-schedule')?.status, 'pending');
  assert.equal(result.messages.at(-1).schedule.revisionId, changed.revisionId);
});
test('valid equal-semantic refresh preserves pending plan while today emergency preserves tomorrow scope', async () => {
  const f = fixture(), h = mock(f.state); await h.store.commit(owner, f.event, f.view, f.context);
  h.db.outbox.push({ id: 'same-semantic-pending', owner, inputId: 'event:input:same-pending', address: f.view.addressId, revision: 0, ordinal: 0,
    payload: { id: 'same', kind: 'notification', schedule: f.view, event: f.event }, status: 'pending', sequence: ++h.db.sequence });
  const refreshed = { ...f.view, revisionId: 'same-raw-new' };
  const silent = await h.store.commit(owner, { ...f.event, id: 'same-raw-new', kind: 'changed', fromRevisionId: f.view.revisionId, toRevisionId: refreshed.revisionId }, refreshed, f.context);
  assert.equal(silent.receipt.supersededPending, 0); assert.notEqual(h.db.outbox.find(row => row.id === 'same-semantic-pending')?.status, 'cancelled');
  const tomorrow: ScheduleView = { ...structuredClone(f.view), revisionId: 'tomorrow-plan', serviceDate: '2026-11-08',
    intervals: f.view.intervals.map(interval => ({ ...interval, startsAt: new Date(Date.parse(interval.startsAt) + 86_400_000).toISOString(), endsAt: new Date(Date.parse(interval.endsAt) + 86_400_000).toISOString() })) };
  const tomorrowEvent = { ...f.event, id: 'tomorrow-event', serviceDate: tomorrow.serviceDate, toRevisionId: tomorrow.revisionId };
  h.db.outbox.push({ id: 'tomorrow-pending', owner, inputId: 'event:input:tomorrow', address: f.view.addressId, revision: 0, ordinal: 0,
    payload: { id: 'tomorrow', kind: 'notification', schedule: tomorrow, event: tomorrowEvent }, status: 'pending', sequence: ++h.db.sequence });
  const emergency: ScheduleView = { ...f.view, revisionId: 'today-emergency', status: 'emergency', intervals: [], dayCoverage: 'none' };
  await h.store.commit(owner, { ...f.event, id: 'today-emergency', kind: 'emergency', fromRevisionId: refreshed.revisionId, toRevisionId: emergency.revisionId }, emergency, f.context);
  assert.notEqual(h.db.outbox.find(row => row.id === 'tomorrow-pending')?.status, 'cancelled');
});
test('pending reminders recheck current opt-in, minimum duration and exact due window before publication', async () => {
  for (const mode of ['off', 'minimum', 'late']) {
    const f = fixture(); f.state.profile.preferences.reminders = mode !== 'off';
    f.state.profile.preferences.minimumOutageMinutes = mode === 'minimum' ? 180 : 0;
    const now = mode === 'late' ? '2026-11-07T14:32:00+02:00' : '2026-11-07T14:30:10+02:00';
    const event: ScheduleEvent = { ...f.event, id: 'pending-reminder', kind: 'reminder', createdAt: '2026-11-07T14:30:00+02:00',
      reminder: { edge: 'starts', intervalStartsAt: f.view.intervals[1].startsAt, intervalEndsAt: f.view.intervals[1].endsAt } };
    const h = mock(f.state);
    h.db.outbox.push({ id: 'pending-reminder', owner, inputId: 'event:input:pending-reminder', address: f.view.addressId, revision: 0, ordinal: 0,
      payload: { id: 'pending-reminder', kind: 'notification', schedule: f.view, event }, status: 'pending', sequence: ++h.db.sequence });
    const snapshot = await h.store.snapshot(owner, now);
    assert.equal(snapshot.messages.length, 0, mode); assert.equal(h.db.outbox[0].status, 'cancelled', mode);
  }
});
test('INSERT failure after state mutation rolls back state, cursor, inbox and outbox', async () => {
  for (const failure of ['outbox', 'inbox']) {
    const f = fixture(), h = mock(f.state), before = structuredClone(h.db); h.setFailure(failure);
    await assert.rejects(h.store.commit(owner, f.event, f.view, f.context)); assert.deepEqual(h.db, before, failure);
    const retry = await h.store.commit(owner, f.event, f.view, f.context); assert.equal(retry.messages.length, 1);
  }
});
test('lost commit acknowledgement or postcommit snapshot retries the durable receipt once', async () => {
  for (const failure of ['commit-ack', 'snapshot']) {
    const f = fixture(), h = mock(f.state); h.setFailure(failure);
    await assert.rejects(h.store.commit(owner, f.event, f.view, f.context));
    const receipt = h.db.inbox.get('event:input:plan-a-event')!.receipt;
    const retry = await h.store.commit(owner, f.event, f.view, f.context);
    assert.equal(retry.receipt.id, receipt.id); assert(retry.replayed); assert.equal(h.db.outbox.length, 1);
  }
});
