import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotState, restoreBotState, handleBotInput, handleScheduleEvent, normalizeHouse, formatScheduleText, formatNotification } from '../../shared/bot/engine.ts';
import { createDemoContext, createDemoProfile } from '../../shared/bot/fixtures.ts';
import { reviewPlan } from '../../shared/review-fixtures.ts';
import type { BotContext, BotState, BotTurn } from '../../shared/bot/types.ts';
import type { NotificationKind, PlanStatus, ScheduleEvent, ScheduleView } from '../../shared/product-contract.ts';

function harness(profile = false) {
  let state = createBotState(profile ? { profile: createDemoProfile() } : {});
  let context = createDemoContext();
  let sequence = 0;
  let turn: BotTurn;
  const send = (text: string, id = `input-${++sequence}`) => {
    turn = handleBotInput(state, { id, kind: text.startsWith('/') ? 'command' : 'text', text }, context);
    state = turn.state; return turn;
  };
  const click = (label: string, id = `input-${++sequence}`) => {
    const b = turn.messages.flatMap(m => m.buttons).find(b => b.label === label);
    assert.ok(b, `Missing button ${label}`);
    turn = handleBotInput(state, { id, kind: 'callback', callbackId: b.callbackId }, context);
    state = turn.state; return turn;
  };
  const wizard = (house = '12А', query = 'Колишня') => {
    send('/add'); click('Вінниця · Вінницька область · тестовий каталог'); send(query); click('Тестова'); return send(house);
  };
  return { send, click, wizard, get state() { return state; }, set state(value: BotState) { state = value; },
    get context() { return context; }, set context(value: BotContext) { context = value; }, get turn() { return turn; } };
}
const text = (turn: BotTurn) => turn.messages.map(m => m.text).join('\n');

test('new and returning menu retain profile without private identity leakage', () => {
  const h = harness(); assert.match(text(h.send('/start')), /Додайте адресу/);
  assert.equal(h.state.profile.locations.length, 0);
  const returning = harness(true); const t = returning.send('/start');
  assert.equal(t.messages[0].kind, 'schedule'); assert.match(text(t), /Дім ·/); assert.match(text(t), /07:30–11:00/);
  assert.deepEqual(t.messages[0].buttons.map(b => b.label), ['Інша адреса', 'Нагадування', 'Меню']);
  assert.doesNotMatch(text(t), /lba-review-user|fixture-address/);
});

test('alias search, explicit street and exact house require separate save and opt-in', () => {
  const h = harness(); const original = structuredClone(h.state);
  h.send('/add'); h.click('Вінниця · Вінницька область · тестовий каталог');
  h.send('Колишня'); assert.equal(h.state.stage, 'street_choice');
  assert.equal(h.state.profile.locations.length, 0); assert.equal(original.profile.locations.length, 0);
  assert.match(text(h.click('Тестова')), /чинну назву: Тестова/);
  h.send('12 а'); assert.equal(h.state.stage, 'address_confirm'); assert.equal(h.state.profile.locations.length, 0);
  const saved = h.click('Зберегти адресу');
  assert.equal(h.state.profile.locations[0].address.house.literal, '12А');
  assert.equal(h.state.profile.locations[0].notifications, false); assert.equal(h.state.profile.preferences.optedIn, false);
  assert.ok(saved.actions.some(a => a.type === 'persist_profile')); assert.ok(saved.messages.every(m => m.commitBarrier === 'profile'));
  h.click('Увімкнути повідомлення'); assert.equal(h.state.profile.locations[0].notifications, true); assert.equal(h.state.profile.preferences.optedIn, true);
});

test('house punctuation, letter and building stay separate and connection ambiguity asks', () => {
  const values = ['12', '12А', '12/1', '12-1', '12 корпус 1'];
  assert.equal(new Set(values.map(normalizeHouse)).size, 5);
  assert.equal(normalizeHouse('12А/1'), normalizeHouse('12 А/1'));
  assert.notEqual(normalizeHouse('12А/1'), normalizeHouse('12A/1'));
  for (const house of values) { const h = harness(); h.wizard(house); h.click('Зберегти адресу'); assert.equal(h.state.profile.locations[0].address.house.literal, house); }
  const h = harness(); h.wizard('14'); assert.equal(h.state.stage, 'connection'); assert.equal(h.state.profile.locations.length, 0);
  assert.equal(h.turn.messages[0].buttons.filter(b => /ввід/.test(b.label)).length, 2);
  h.click('Другий ввід'); h.click('Зберегти адресу'); assert.equal(h.state.profile.locations[0].binding.targetId, 'fixture-office:second');
});

test('unknown house does not fall back to nearby number and street aliases do not duplicate addresses', () => {
  const h = harness(true); h.wizard('12Б'); assert.match(text(h.turn), /немає підтвердженого збігу/);
  assert.equal(h.state.profile.locations.length, 1); h.send('12А');
  assert.match(text(h.click('Зберегти адресу')), /Дубль не створено/); assert.equal(h.state.profile.locations.length, 1);
});

test('JSON restart resumes draft; cancel/back leave saved profile intact', () => {
  const h = harness(true); const profile = structuredClone(h.state.profile);
  h.wizard('12/1'); const snapshot = JSON.parse(JSON.stringify(h.state));
  h.state = restoreBotState(snapshot, 'lba-review-user'); h.send('/start');
  assert.ok(h.turn.messages.flatMap(m => m.buttons).some(b => b.label === 'Продовжити чернетку'));
  h.click('Продовжити чернетку'); assert.equal(h.state.stage, 'address_confirm'); h.click('Назад'); assert.equal(h.state.stage, 'house');
  h.send('/cancel'); assert.deepEqual(h.state.profile, profile); assert.equal(h.state.draft?.resumeStage, 'house'); h.send('/discard_draft'); assert.equal(h.state.draft, null);
  assert.throws(() => restoreBotState(snapshot, 'someone-else'), /BOT_STATE_INVALID/);
});

test('double confirmation, input replay, old callback and callback expiry cannot repeat mutations', () => {
  const h = harness(); h.wizard(); const callbackId = h.turn.messages[0].buttons.find(b => b.label === 'Зберегти адресу')!.callbackId;
  const saved = h.click('Зберегти адресу', 'save-once'); const snapshot = structuredClone(h.state);
  const duplicate = handleBotInput(h.state, { id: 'save-once', kind: 'callback', callbackId }, h.context);
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.state, snapshot); assert.equal(duplicate.actions.length, 0);
  const replay = handleBotInput(h.state, { id: 'save-twice', kind: 'callback', callbackId }, h.context);
  assert.equal(replay.rejected, 'stale_callback'); assert.deepEqual(replay.state.profile, snapshot.profile); assert.equal(replay.actions.length, 0);
  assert.equal(replay.requiresCommit, true); assert.ok(replay.messages.some(m => m.buttons.length));
  assert.equal(saved.actions.filter(a => a.type === 'persist_profile').length, 1);
  const old = harness(); old.send('/start'); const token = old.turn.messages[0].buttons[0].callbackId;
  const expired = handleBotInput(old.state, { id: 'expired', kind: 'callback', callbackId: token }, { ...old.context, now: '2026-11-07T10:16:00+02:00' });
  assert.equal(expired.rejected, 'expired_callback'); assert.deepEqual(expired.state.profile, old.state.profile); assert.ok(expired.messages.some(m => m.buttons.length));
});

test('foreign actor and unknown legacy callbacks never alter state or reveal profile', () => {
  const h = harness(true); h.send('/start'); const token = h.turn.messages[0].buttons[0].callbackId;
  const foreign = handleBotInput(h.state, { id: 'foreign', kind: 'callback', callbackId: token }, { ...h.context, actorId: 'other-user' });
  assert.equal(foreign.rejected, 'foreign_actor'); assert.deepEqual(foreign.state, h.state); assert.equal(foreign.actions.length, 0);
  assert.doesNotMatch(text(foreign), /Дім|Тестова/);
  const unknown = handleBotInput(h.state, { id: 'old', kind: 'callback', callbackId: 'set_city_vinnytsia' }, h.context);
  assert.equal(unknown.rejected, 'unknown_callback'); assert.deepEqual(unknown.state.profile, h.state.profile); assert.equal(unknown.actions.length, 0); assert.ok(unknown.messages.some(m => m.buttons.length));
});

test('catalog binding revision drift invalidates pending confirmation', () => {
  const h = harness(); h.wizard(); h.context.addresses[0].binding.revisionId = 'binding-after-change';
  const turn = h.click('Зберегти адресу'); assert.match(text(turn), /Прив’язка змінилася/);
  assert.equal(h.state.profile.locations.length, 0); assert.equal(turn.actions.length, 0);
});

test('same locality/street names are scoped by territory and alias collisions stay explicit', () => {
  const h = harness(); const other = structuredClone(h.context.addresses[0]);
  other.id = 'other-option'; other.address.id = 'other-address'; other.address.territoryId = 'other-territory';
  other.territoryLabel = 'Інша область'; other.binding.addressId = 'other-address'; h.context.addresses.push(other);
  const collision = structuredClone(h.context.addresses[0]); collision.id = 'collision-option'; collision.address.id = 'collision-address';
  collision.address.street = 'Інша Тестова'; collision.binding.addressId = 'collision-address'; h.context.addresses.push(collision);
  h.send('/add'); assert.equal(h.turn.messages[0].buttons.filter(b => b.label.startsWith('Вінниця ·')).length, 2);
  h.click('Вінниця · Вінницька область · тестовий каталог'); h.send('Колишня');
  assert.ok(h.turn.messages[0].buttons.some(b => b.label === 'Тестова')); assert.ok(h.turn.messages[0].buttons.some(b => b.label === 'Інша Тестова'));
  assert.equal(h.state.profile.locations.length, 0); h.click('Інша Тестова'); h.send('12А'); h.click('Зберегти адресу');
  assert.equal(h.state.profile.locations[0].address.id, 'collision-address');
});

test('management supports label, primary, order, per-address pause and explicit deletion', () => {
  const h = harness(true); h.wizard('12/1'); h.click('Зберегти адресу'); h.click('Залишити вимкненими');
  h.send('/addresses'); h.click('Адреса 2'); h.click('Керування адресою'); h.click('Назва'); h.send('Робота'); assert.equal(h.state.profile.locations[1].address.label, 'Робота');
  h.click('Основна адреса й порядок'); h.click('Зробити основною'); assert.equal(h.state.profile.primaryAddressId, 'fixture-address-12-slash-1');
  h.send('/location_notifications'); h.click('Пауза адреси'); assert.equal(h.state.profile.locations[1].paused, true); assert.ok(h.turn.actions.some(a => a.type === 'cancel_pending_delivery'));
  h.send('/location_order'); h.click('Вище у списку'); assert.equal(h.state.profile.locations[0].address.label, 'Робота');
  h.send('/addresses'); h.click('Основна · Робота · пауза'); h.click('Керування адресою'); h.click('Видалити'); assert.equal(h.state.profile.locations.length, 2);
  h.click('Залишити адресу'); assert.equal(h.state.profile.locations.length, 2); h.click('Видалити'); h.click('Видалити адресу');
  assert.equal(h.state.profile.locations.length, 1); assert.equal(h.state.profile.primaryAddressId, 'fixture-address-home');
});

test('edit draft and interruption never modify active binding before confirmation', () => {
  const h = harness(true); const profile = structuredClone(h.state.profile);
  h.send('/addresses'); h.click('Основна · Дім'); h.click('Керування адресою'); h.click('Змінити адресу'); h.click('Вінниця · Вінницька область · тестовий каталог');
  h.send('Тестова'); h.click('Тестова'); h.send('12/1'); assert.deepEqual(h.state.profile, profile);
  h.send('/pause'); const pending = structuredClone(h.state.draft); h.send('продовжити');
  assert.match(text(h.turn), /додавання адреси чи зняти паузу/); assert.deepEqual(h.state.draft, pending);
  h.click('Продовжити чернетку'); h.click('Зберегти адресу');
  assert.equal(h.state.profile.locations.length, 1); assert.equal(h.state.profile.locations[0].address.id, 'fixture-address-12-slash-1');
  assert.equal(h.state.profile.preferences.paused, true); assert.equal(h.state.profile.locations[0].notifications, false);
  assert.ok(h.turn.actions.some(a => a.type === 'cancel_pending_delivery' && a.reason === 'binding_changed'));
});

test('pause preserves opt-out; invalid quiet/reminder/briefing input has no profile effect', () => {
  const h = harness(true); h.send('/pause'); assert.ok(h.turn.actions.some(a => a.type === 'cancel_pending_delivery'));
  h.send('/resume'); assert.equal(h.state.profile.preferences.optedIn, false);
  h.send('/quiet'); const prior = structuredClone(h.state.profile); h.send('22:00–22:00'); assert.deepEqual(h.state.profile, prior);
  h.send('22:00–08:00'); assert.deepEqual(h.state.profile.preferences.quietHours, { enabled: true, start: '22:00', end: '08:00', timezone: 'Europe/Kyiv' });
  h.send('/reminders'); h.send('1441'); assert.equal(h.state.profile.preferences.reminders, false); h.send('45'); assert.equal(h.state.profile.preferences.remindBeforeMinutes, 45);
  h.send('/briefing'); h.send('25:20'); assert.equal(h.state.profile.preferences.morningBriefing.enabled, false); h.send('07:30'); assert.equal(h.state.profile.preferences.morningBriefing.enabled, true);
  h.send('/minimum'); h.send('60'); assert.equal(h.state.profile.preferences.minimumOutageMinutes, 60);
  h.send('/notifications_on'); assert.equal(h.state.profile.preferences.optedIn, true);
  h.send('/notifications_off'); assert.equal(h.state.profile.preferences.optedIn, false); assert.ok(h.turn.actions.some(a => a.reason === 'opt_out'));
});

test('per-address opt-out survives global permission on/off and resume', () => {
  const h = harness(true); h.send('/addresses'); h.click('Основна · Дім'); h.click('Сповіщення адреси'); h.click('Telegram для адреси'); h.click('Увімкнути для адреси');
  assert.equal(h.state.profile.locations[0].notifications, true); h.click('Вимкнути для адреси');
  assert.ok(h.turn.actions.some(a => a.reason === 'address_opt_out'));
  h.send('/notifications_off'); h.send('/notifications_on'); h.send('/pause'); h.send('/resume');
  assert.equal(h.state.profile.preferences.optedIn, true); assert.equal(h.state.profile.locations[0].notifications, false);
});

test('manual queue is explicit unverified selection without subscriptions; reset needs confirmation', () => {
  const h = harness(); h.send('/queue'); h.click('Вінниця · 1.1');
  assert.equal(h.state.profile.locations[0].binding.kind, 'user_selected_group'); assert.equal(h.state.profile.locations[0].binding.status, 'needs_confirmation');
  h.send('/notifications_on'); assert.equal(h.state.profile.preferences.optedIn, false);
  h.send('/reset'); assert.equal(h.state.profile.locations.length, 1); h.click('Залишити дані'); assert.equal(h.state.profile.locations.length, 1);
  h.send('/reset'); h.click('Підтвердити скидання'); assert.equal(h.state.profile.locations.length, 0); assert.equal(h.state.ownerId, 'lba-review-user');
});

test('same manual group label/target in different namespaces creates distinct identities', () => {
  const h = harness(); h.context.manualGroups = [
    { id: 'a', label: '1.1', locality: 'Місто А', territoryLabel: 'А', operatorId: 'same-operator', namespace: 'namespace:A', targetId: '1.1', revisionId: 'r1' },
    { id: 'b', label: '1.1', locality: 'Місто Б', territoryLabel: 'Б', operatorId: 'same-operator', namespace: 'namespace:B', targetId: '1.1', revisionId: 'r1' },
  ];
  h.send('/queue'); h.click('Місто А · 1.1'); h.send('/queue'); h.click('Місто Б · 1.1');
  assert.equal(h.state.profile.locations.length, 2); assert.notEqual(h.state.profile.locations[0].address.id, h.state.profile.locations[1].address.id);
  assert.equal(h.state.profile.locations[1].binding.namespace, 'namespace:B');
});

test('legacy links never echo/store raw auth payload or silently merge identity', () => {
  for (const prefix of ['link_', 'weblogin_', 'addr_']) {
    const h = harness(true); const profile = structuredClone(h.state.profile);
    const t = h.send(`/start ${prefix}PRIVATE_TOKEN`); assert.deepEqual(h.state.profile, profile);
    assert.equal(t.actions[0].type, 'resolve_legacy_link'); assert.equal(t.actions[0].value, prefix.slice(0, -1));
    assert.doesNotMatch(JSON.stringify(t), /PRIVATE_TOKEN/);
  }
});

test('all plan statuses have exact complete text fallback; diff shows before/after', () => {
  const statuses: PlanStatus[] = ['published', 'no_planned_outages', 'possible', 'emergency', 'not_published', 'stale', 'unavailable', 'conflict', 'needs_confirmation'];
  for (const view of statuses.map(reviewPlan)) {
    const output = formatScheduleText(view); assert.match(output, /Джерело:/); assert.match(output, /Europe\/Kyiv/);
    assert.match(output, /Тестовий приклад/);
    for (const i of view.intervals) assert.ok(output.includes(`${i.startLocal}–${i.endLocal}`));
  }
  const view = { ...structuredClone(createDemoContext().plans[0]), previousIntervals: [] };
  const kinds: NotificationKind[] = ['new_plan', 'changed', 'moved', 'cancelled', 'emergency', 'reminder'];
  for (const kind of kinds) assert.match(formatNotification(kind, view), /Джерело:/);
  assert.match(formatNotification('changed', view), /Було: планових інтервалів не було/);
  assert.match(formatNotification('changed', view), /Стало:/);
});

function eligible() {
  const profile = createDemoProfile(); profile.preferences.optedIn = true; profile.locations[0].notifications = true;
  const state = createBotState({ profile }); const context = createDemoContext();
  const view: ScheduleView = { ...structuredClone(context.plans[0]), synthetic: false, deliveryEligible: true,
    bindingRevisionId: profile.locations[0].binding.revisionId, namespace: profile.locations[0].binding.namespace, targetId: profile.locations[0].binding.targetId,
    source: { ...context.plans[0].source, verifiedLevel: 'integration' } };
  const event: ScheduleEvent = { id: 'schedule-event-1', addressId: view.addressId, operatorId: view.operatorId, serviceDate: view.serviceDate,
    fromRevisionId: null, toRevisionId: view.revisionId, kind: 'new_plan', createdAt: context.now };
  return { state, context, view, event };
}

test('delivery gate allows only scoped current verified opt-in and deduplicates local event', () => {
  const f = eligible(); const t = handleScheduleEvent(f.state, f.event, f.view, f.context);
  assert.equal(t.messages.length, 1); assert.equal(t.actions[0].simulationOnly, true); assert.equal(t.requiresCommit, true);
  assert.equal(handleScheduleEvent(restoreBotState(JSON.parse(JSON.stringify(t.state)), f.state.ownerId), f.event, f.view, f.context).duplicate, true);
  const variants: Array<(f: ReturnType<typeof eligible>) => void> = [
    f => { f.view.synthetic = true; f.view.deliveryEligible = false; },
    f => { f.state.profile.preferences.paused = true; }, f => { f.state.profile.preferences.optedIn = false; },
    f => { f.state.profile.locations[0].paused = true; }, f => { f.state.profile.locations[0].notifications = false; },
    f => { f.state.profile.locations[0].binding.status = 'needs_confirmation'; }, f => { f.view.targetId = 'other-connection'; },
    f => { f.event.operatorId = 'other-operator'; }, f => { f.event.toRevisionId = 'other-revision'; },
    f => { f.view.source.verifiedLevel = 'schedule'; }, f => { f.view.observedAt = 'broken'; },
    f => { f.state.profile.preferences.quietHours = { enabled: true, start: '22:00', end: '11:00', timezone: 'Europe/Kyiv' }; },
  ];
  for (const mutate of variants) { const bad = eligible(); mutate(bad); const blocked = handleScheduleEvent(bad.state, bad.event, bad.view, bad.context); assert.equal(blocked.actions.length, 0); assert.deepEqual(blocked.state, bad.state); }
});

test('reminder gate requires explicit reminder opt-in and future sufficiently long interval', () => {
  const f = eligible(); f.event.kind = 'reminder';
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 0);
  f.state.profile.preferences.reminders = true; f.state.profile.preferences.minimumOutageMinutes = 1440;
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 0);
});

test('unknown event kinds and event/status mismatches fail closed at runtime', () => {
  const f = eligible(); const unknown = { ...f.event, kind: 'FutureUnknown' } as unknown as ScheduleEvent;
  assert.equal(handleScheduleEvent(f.state, unknown, f.view, f.context).actions.length, 0);
  const mismatched = { ...f.event, kind: 'emergency' } as ScheduleEvent;
  assert.equal(handleScheduleEvent(f.state, mismatched, f.view, f.context).actions.length, 0);
  assert.equal(handleScheduleEvent(f.state, { ...f.event, kind: 'cancelled' }, f.view, f.context).actions.length, 0);
  assert.equal(handleScheduleEvent(f.state, { ...f.event, createdAt: '2030-01-01T00:00:00Z' }, f.view, f.context).actions.length, 0);
  assert.equal(handleScheduleEvent(f.state, { ...f.event, createdAt: '2026-11-07' }, f.view, f.context).actions.length, 0);
});

test('reminder uses exact start/end interval identity, saved lead and one-minute due window', () => {
  const f = eligible(); f.state.profile.preferences.reminders = true;
  const interval = f.view.intervals[1];
  const due = new Date(Date.parse(interval.startsAt) - 30 * 60000).toISOString();
  f.context.now = due; f.event.createdAt = due; f.event.kind = 'reminder';
  f.event.reminder = { edge: 'starts', intervalStartsAt: interval.startsAt, intervalEndsAt: interval.endsAt };
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 1);
  assert.match(text(handleScheduleEvent(f.state, f.event, f.view, f.context)), /заплановано початок/);
  f.event.reminder = { edge: 'starts', intervalStartsAt: new Date(interval.startsAt).toISOString(), intervalEndsAt: new Date(interval.endsAt).toISOString() };
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 1);
  f.context.now = new Date(Date.parse(due) - 5 * 3600000).toISOString(); f.event.createdAt = f.context.now;
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 0);
  f.context.now = new Date(Date.parse(due) + 60000).toISOString(); f.event.createdAt = f.context.now;
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 0);
  f.event.reminder.edge = 'ends'; f.context.now = new Date(Date.parse(interval.endsAt) - 30 * 60000).toISOString(); f.event.createdAt = f.context.now;
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 1);
  assert.match(text(handleScheduleEvent(f.state, f.event, f.view, f.context)), /заплановано завершення/);
  f.event.reminder.intervalStartsAt = '2026-11-07T12:00:00+02:00';
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 0);
});

test('qualified emergency cancels planned pending intents then proposes truthful information', () => {
  const f = eligible(); f.event.kind = 'emergency';
  f.view.status = 'emergency'; f.view.intervals = []; f.view.dayCoverage = 'none';
  const t = handleScheduleEvent(f.state, f.event, f.view, f.context);
  assert.equal(t.actions.length, 2); assert.equal(t.actions[0].type, 'cancel_pending_delivery'); assert.equal(t.actions[0].reason, 'emergency_mode');
  assert.match(text(t), /Аварійний режим/); assert.doesNotMatch(text(t), /Світло є|Світла немає|Інтервали за планом:/);
  f.state.profile.preferences.quietHours = { enabled: true, start: '09:00', end: '11:00', timezone: 'Europe/Kyiv' };
  assert.equal(handleScheduleEvent(f.state, f.event, f.view, f.context).actions.length, 0);
});

test('callbacks fit platform size and contain no address/owner; invalid clock stops all mutation', () => {
  const h = harness(true); h.send('/addresses');
  for (const b of h.turn.messages.flatMap(m => m.buttons)) { assert.ok(Buffer.byteLength(b.callbackId) <= 64); assert.doesNotMatch(b.callbackId, /fixture-address|lba-review-user/); }
  const stopped = handleBotInput(h.state, { id: 'clock', kind: 'command', text: '/pause' }, { ...h.context, now: 'invalid' });
  assert.equal(stopped.rejected, 'invalid_clock'); assert.deepEqual(stopped.state, h.state);
  assert.equal(handleBotInput(h.state, { id: 'clock-date-only', kind: 'command', text: '/pause' }, { ...h.context, now: '2026-11-07' }).rejected, 'invalid_clock');
});

test('schedule and event use current profile label without mutating provider view', () => {
  const h = harness(true); h.state.profile.locations[0].address.label = 'Офіс';
  assert.match(text(h.send('/schedule')), /Тестовий приклад · Офіс/); assert.equal(h.context.plans[0].addressLabel, 'Дім');
  const f = eligible(); f.state.profile.locations[0].address.label = 'Офіс';
  assert.match(text(handleScheduleEvent(f.state, f.event, f.view, f.context)), /Офіс/); assert.equal(f.view.addressLabel, 'Дім');
});
