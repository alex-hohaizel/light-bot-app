import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotState, restoreBotState, handleBotInput } from '../../shared/bot/engine.ts';
import { createDemoContext, createDemoProfile } from '../../shared/bot/fixtures.ts';
import { MAX_PROFILE_ADDRESSES, ADDRESS_PAGE_SIZE } from '../../shared/profile-constraints.ts';
import type { BotState, BotTurn } from '../../shared/bot/types.ts';

const body = (t: BotTurn) => t.messages.map(m => m.text).join('\n');
function harness(count = 1) {
  const profile = createDemoProfile();
  profile.locations = Array.from({ length: count }, (_, i) => {
    const l = structuredClone(profile.locations[0]);
    if (i) { l.address.id = `saved-${i + 1}`; l.binding.addressId = l.address.id; l.address.label = `Місце ${i + 1}`; } return l;
  });
  profile.primaryAddressId = profile.locations[0]?.address.id ?? null;
  let state = createBotState({ profile }), turn: BotTurn, sequence = 0;
  const context = createDemoContext();
  const send = (text: string) => { turn = handleBotInput(state, { id: `ux-${++sequence}`, kind: 'text', text }, context); state = turn.state; return turn; };
  const click = (label: string) => {
    const b = turn.messages.flatMap(m => m.buttons).find(b => b.label === label); assert.ok(b, `Missing ${label}`);
    turn = handleBotInput(state, { id: `ux-${++sequence}`, kind: 'callback', callbackId: b.callbackId }, context); state = turn.state; return turn;
  };
  const wizard = () => { send('/add'); click('Вінниця · Вінницька область · тестовий каталог'); send('Тестова'); click('Тестова'); send('12/1'); };
  return { send, click, wizard, context, get state() { return state; }, set state(v: BotState) { state = v; }, get turn() { return turn; } };
}

test('A home renders the current saved plan; three actions and reminders retain address scope', () => {
  const h = harness(2); h.state.currentAddressId = h.state.profile.locations[1].address.id;
  let t = h.send('/start'); assert.match(body(t), /Місце 2\nДля цієї адреси поки немає/); assert.doesNotMatch(body(t), /07:30–11:00/);
  assert.deepEqual(t.messages[0].buttons.map(b => b.label), ['Інша адреса', 'Нагадування', 'Меню']);
  h.click('Нагадування'); h.click('Для адреси: перед вимкненням'); assert.equal(h.state.policyAddressId, 'saved-2');
  h.send('0'); assert.equal(h.state.profile.locations[1].notificationPolicy?.channels.telegram.beforeOffMinutes, 0);
  assert.equal(h.state.profile.preferences.notificationPolicy, undefined);
  t = harness(0).send('/start'); assert.deepEqual(t.messages[0].buttons.map(b => b.label), ['Додати адресу', 'Як це працює']);
});

test('twenty addresses paginate three at a time and hide impossible primary/up/down/add controls', () => {
  const h = harness(20); assert.equal(MAX_PROFILE_ADDRESSES, 20); assert.equal(ADDRESS_PAGE_SIZE, 3);
  h.send('/addresses'); const seen = new Set<string>(); let pages = 0;
  while (true) {
    const m = h.turn.messages.at(-1)!; assert.ok(m.buttons.length <= 7); pages++;
    assert.match(m.text, new RegExp(`Сторінка ${pages} з 7`));
    const addresses = m.buttons.filter(b => h.state.callbacks[b.callbackId].action.kind === 'location');
    assert.ok(addresses.length <= 3); addresses.forEach(b => seen.add(b.label)); assert.ok(!m.buttons.some(b => b.label === 'Додати адресу'));
    if (!m.buttons.some(b => b.label === 'Наступні')) break; h.click('Наступні');
  }
  assert.equal(seen.size, 20); assert.equal(pages, 7); h.send('/location_order');
  assert.ok(!h.turn.messages[0].buttons.some(b => /основною|Вище/.test(b.label)));
  h.send('/addresses'); h.click('Місце 20'); h.click('Керування адресою'); h.click('Основна адреса й порядок');
  assert.ok(!h.turn.messages[0].buttons.some(b => /Нижче/.test(b.label)));
  h.state = restoreBotState(JSON.parse(JSON.stringify(h.state)), h.state.ownerId); h.send('Назад'); assert.equal(h.state.stage, 'location_manage');
});

test('default capacity reaches twenty and explicit lower maximum is honored at begin and confirmation', () => {
  const h = harness(19); h.wizard(); h.click('Зберегти адресу'); assert.equal(h.state.profile.locations.length, 20);
  const before = structuredClone(h.state.profile); h.send('/add'); assert.match(body(h.turn), /20/); assert.deepEqual(h.state.profile, before);
  const low = harness(); low.context.maxAddresses = 1; low.send('/add'); assert.equal(low.state.draft, null);
  low.context.maxAddresses = 2; low.wizard(); low.context.maxAddresses = 1; low.click('Зберегти адресу'); assert.equal(low.state.profile.locations.length, 1);
});

test('typed Back and Cancel precede data fields and preserve unrelated address drafts', () => {
  const h = harness(); h.wizard(); const pending = structuredClone(h.state.draft);
  h.send('Скасувати'); assert.equal(h.state.stage, 'home'); assert.deepEqual(h.state.draft, pending);
  h.click('Продовжити чернетку'); assert.equal(h.state.stage, 'address_confirm'); h.send('Назад'); assert.equal(h.state.stage, 'house');
  h.send('назад'); assert.equal(h.state.stage, 'street'); assert.equal(h.state.draft?.house, '12/1');
  h.send('/start'); const draft = structuredClone(h.state.draft), profile = structuredClone(h.state.profile);
  h.send('/before_off'); h.send('Скасувати'); assert.equal(h.state.stage, 'telegram'); assert.deepEqual(h.state.draft, draft);
  h.send('/location_manage'); h.click('Назва'); h.send('Скасувати'); assert.equal(h.state.stage, 'location_manage'); assert.deepEqual(h.state.profile, profile);
  for (const command of ['/quiet', '/briefing', '/minimum', '/reminders']) { h.send(command); h.send('Назад'); assert.equal(h.state.stage, 'timing'); assert.deepEqual(h.state.profile, profile); }
  h.send('/start'); h.click('Відкинути чернетку'); assert.equal(h.state.draft, null); assert.deepEqual(h.state.profile, profile);
});

test('invalid reminder has fresh Back/Cancel and stale old Cancel recovers without writing policy', () => {
  const h = harness(); h.wizard(); const draft = structuredClone(h.state.draft);
  h.send('/address_before_off'); const oldCancel = h.turn.messages[0].buttons.find(b => b.label === 'Скасувати')!.callbackId;
  const before = structuredClone(h.state.profile); h.send('некоректно'); assert.deepEqual(h.turn.messages[0].buttons.map(b => b.label), ['Назад', 'Скасувати']);
  let t = handleBotInput(h.state, { id: 'old-cancel', kind: 'callback', callbackId: oldCancel }, h.context);
  assert.equal(t.rejected, 'stale_callback'); assert.equal(t.requiresCommit, true); assert.deepEqual(t.state.profile, before); assert.equal(t.actions.length, 0);
  const freshCancel = t.messages.flatMap(m => m.buttons).find(b => b.label === 'Скасувати')!;
  t = handleBotInput(t.state, { id: 'fresh-cancel', kind: 'callback', callbackId: freshCancel.callbackId }, h.context);
  assert.equal(t.rejected, undefined); assert.equal(t.state.stage, 'location_telegram'); assert.deepEqual(t.state.draft, draft); assert.deepEqual(t.state.profile, before);
});

test('every invalid scalar input retains actionable navigation after JSON restore', () => {
  const h = harness();
  for (const cmd of ['/before_off', '/before_on', '/push_before_off', '/push_before_on', '/address_before_off', '/address_push_before_on', '/reminders', '/minimum', '/quiet', '/briefing']) {
    h.send(cmd); h.state = restoreBotState(JSON.parse(JSON.stringify(h.state)), h.state.ownerId); const before = structuredClone(h.state.profile);
    const t = h.send('not a value'); assert.deepEqual(t.state.profile, before); assert.deepEqual(t.messages[0].buttons.map(b => b.label), ['Назад', 'Скасувати']);
    for (const b of t.messages[0].buttons) assert.equal(t.state.callbacks[b.callbackId].stateRevision, t.state.revision);
  }
});

test('missing/deleted policy or deletion target fails closed without changing a global or different address', () => {
  const h = harness(2); h.send('/address_before_on'); h.state.profile.locations.shift(); const profile = structuredClone(h.state.profile);
  h.send('15'); assert.deepEqual(h.state.profile, profile); assert.match(body(h.turn), /адреси вже немає/);
  const old = harness(); old.state.stage = 'reminder_off_time'; delete old.state.policyAddressId;
  const before = structuredClone(old.state.profile); old.send('30'); assert.deepEqual(old.state.profile, before);
  old.send('/location_manage'); old.click('Видалити'); const token = old.turn.messages[0].buttons[0].callbackId;
  old.state.profile.locations = []; old.state.profile.primaryAddressId = null;
  const t = handleBotInput(old.state, { id: 'deleted', kind: 'callback', callbackId: token }, old.context);
  assert.equal(t.actions.length, 0); assert.equal(t.state.profile.locations.length, 0);
});

test('owned expired/unknown/session callbacks recover once without mutation; foreign actor sees no private data', () => {
  for (const kind of ['expired', 'unknown', 'foreign-session'] as const) {
    const h = harness(); h.send('/location_manage'); h.click('Видалити'); const token = h.turn.messages[0].buttons[0].callbackId;
    const profile = structuredClone(h.state.profile), input = { id: `rejected-${kind}`, kind: 'callback' as const, callbackId: kind === 'expired' ? token : kind === 'unknown' ? 'legacy-command' : `${token}-other-session` };
    const context = kind === 'expired' ? { ...h.context, now: '2026-11-07T12:00:00+02:00' } : h.context;
    const t = handleBotInput(h.state, input, context); assert.ok(t.rejected); assert.equal(t.actions.length, 0); assert.deepEqual(t.state.profile, profile); assert.ok(t.messages.some(m => m.buttons.length));
    assert.equal(handleBotInput(t.state, input, context).duplicate, true);
    const foreign = handleBotInput(h.state, { ...input, id: 'foreign' }, { ...context, actorId: 'intruder' });
    assert.equal(foreign.rejected, 'foreign_actor'); assert.deepEqual(foreign.state, h.state); assert.doesNotMatch(body(foreign), /Дім|Тестова/); assert.ok(foreign.messages.every(m => !m.buttons.length));
  }
});

test('groups have four business choices at most and advanced features have visible routes', () => {
  const h = harness(2), commands = new Set<string>();
  for (const cmd of ['/menu', '/addresses', '/settings', '/telegram', '/push', '/timing', '/tools', '/account', '/help', '/location_manage', '/location_order', '/location_notifications', '/location_telegram', '/location_push', '/location_tools']) {
    const t = h.send(cmd); assert.ok(t.messages.at(-1)!.buttons.length <= 5, cmd);
    for (const b of t.messages.flatMap(m => m.buttons)) { const a = t.state.callbacks[b.callbackId].action; if (a.kind === 'command') commands.add(a.value); if (a.kind === 'location_action') commands.add(`location:${a.value}`); }
  }
  for (const cmd of ['/compare', '/history', '/digest', '/account', '/app', '/migration', '/reset', '/about', '/queue', '/quiet', '/briefing', '/minimum', '/reminders', '/before_off', '/before_on', '/push_before_off', '/push_before_on', '/address_before_off', '/address_before_on', '/address_push_before_off', '/address_push_before_on', 'location:rename', 'location:edit', 'location:delete', 'location:pause', 'location:notifications', 'location:share', 'location:report']) assert.ok(commands.has(cmd), `Unreachable ${cmd}`);
  h.send('/share'); assert.ok(h.turn.actions.some(a => a.type === 'prepare_share' && a.simulationOnly)); assert.doesNotMatch(body(h.turn), /посилання створено|надіслано/);
  h.send('/history'); assert.match(body(h.turn), /бракує перевіреної історії/);
});

test('before off/on, zero, inheritance and Telegram/push permissions remain independent', () => {
  const h = harness(); h.send('/push_before_on'); h.send('45'); h.send('/before_off'); h.send('0');
  assert.equal(h.state.profile.preferences.notificationPolicy?.channels.push.beforeOnMinutes, 45); assert.equal(h.state.profile.preferences.notificationPolicy?.channels.telegram.beforeOffMinutes, 0);
  assert.equal(h.state.profile.preferences.notificationPolicy?.channels.push.enabled, false); assert.equal(h.state.profile.preferences.optedIn, false);
  h.send('/address_before_on'); h.send('10'); h.send('/address_before_off'); h.send('0');
  assert.equal(h.state.profile.locations[0].notificationPolicy?.channels.telegram.beforeOnMinutes, 10); assert.equal(h.state.profile.locations[0].notificationPolicy?.channels.telegram.beforeOffMinutes, 0);
  h.send('/address_before_on'); h.send('Як у каналі'); assert.equal(h.state.profile.locations[0].notificationPolicy?.channels.telegram.beforeOnMinutes, undefined);
  assert.equal(h.state.profile.locations[0].notificationPolicy?.channels.telegram.beforeOffMinutes, 0); assert.equal(h.state.profile.locations[0].notifications, false);
});
