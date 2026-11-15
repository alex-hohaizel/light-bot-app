import { writeFileSync } from 'node:fs';
import { createBotState, handleBotInput, restoreBotState, formatScheduleText, formatNotification } from '../../shared/bot/engine.ts';
import { COPY, BOT_COPY, RUNTIME_COPY } from '../../shared/bot/copy.ts';
import { createDemoContext, createDemoProfile } from '../../shared/bot/fixtures.ts';
import { reviewPlan } from '../../shared/review-fixtures.ts';
import type { BotContext, BotState, BotTurn } from '../../shared/bot/types.ts';
import type { NotificationKind, PlanStatus } from '../../shared/product-contract.ts';

const output: string[] = [
  '# Видимі діалоги LIGHT BOT APP · кандидат 1',
  '',
  'Ці тексти отримані виконанням чистого рушія на синтетичних адресах і планах. Це повні послідовності повідомлень і кнопок кандидата, не лог реального Telegram-чату й не доказ запису production-профілю. Успіх зміни профілю адаптер показує лише після локального durable commit. Тестові джерела не є реальним покриттям Вінниці.',
  '',
  'Пропозиція для D-LANGUAGE: основна українська, ввічливі короткі фрази, без фамільярності, emoji й гумору в важливих повідомленнях; «план» окремо від фактичного світла. Конкретне звертання й інші мови потребують огляду власника. Природність, Telegram devices і owner approval цими samples не оголошуються пройденими.',
  '',
];
let sequence = 0;
function scenario(title: string, returning = false) {
  output.push(`## ${title}`, '');
  let state = createBotState(returning ? { profile: createDemoProfile() } : {});
  const context = createDemoContext();
  let turn: BotTurn;
  const record = (label: string, result: BotTurn) => {
    output.push(`**Користувач:** ${label}`, '');
    if (!result.messages.length) output.push('_Повідомлення не повторюється._', '');
    for (const item of result.messages) {
      output.push(...item.text.split('\n').map(line => `> ${line}`), '');
      if (item.buttons.length) output.push(`Кнопки: ${item.buttons.map(b => `«${b.label}»`).join(' · ')}`, '');
    }
    state = result.state; turn = result;
    return result;
  };
  const send = (value: string, id = `sample-${++sequence}`) => record(value, handleBotInput(state, { id, kind: value.startsWith('/') ? 'command' : 'text', text: value }, context));
  const click = (label: string) => {
    const button = turn.messages.flatMap(m => m.buttons).find(b => b.label === label);
    if (!button) throw new Error(`SAMPLE_BUTTON_MISSING: ${label}`);
    return record(`натискає «${label}»`, handleBotInput(state, { id: `sample-${++sequence}`, kind: 'callback', callbackId: button.callbackId }, context));
  };
  const address = (house = '12А') => { send('/add'); click('Вінниця · Вінницька область · тестовий каталог'); send('Колишня'); click('Тестова'); send(house); };
  return { send, click, address, context, get state() { return state; }, get turn() { return turn; },
    restart() { state = restoreBotState(JSON.parse(JSON.stringify(state)), state.ownerId); output.push('_Локальний snapshot серіалізовано в JSON і відновлено після перезапуску._', ''); },
    external(result: BotTurn, label: string) { return record(label, result); } };
}

{
  const s = scenario('1. Перше додавання, стара назва вулиці, окрема згода');
  s.send('/start'); s.address(); s.click('Зберегти адресу'); s.click('Увімкнути повідомлення'); s.send('/schedule');
}
{
  const s = scenario('2. Номер без збігу й кілька вводів'); s.address('12Б'); s.send('14'); s.click('Другий ввід'); s.click('Зберегти адресу'); s.click('Залишити вимкненими');
}
{
  const s = scenario('3. Повернення до профілю, чернетка, перезапуск і скасування', true);
  s.send('/start'); s.address('12/1'); s.restart(); s.send('/start'); s.click('Продовжити чернетку'); s.click('Назад'); s.click('Скасувати'); s.send('/schedule');
}
{
  const s = scenario('4. Зміна назви, основна адреса, порядок і окремі сповіщення', true);
  s.address('12/1'); s.click('Зберегти адресу'); s.click('Залишити вимкненими'); s.send('/addresses'); s.click('Адреса 2'); s.click('Назва'); s.send('Робота');
  s.click('Зробити основною'); s.click('Увімкнути для адреси'); s.click('Пауза адреси'); s.click('Вище у списку');
}
{
  const s = scenario('5. Редагування не змінює активну адресу до підтвердження', true);
  s.send('/addresses'); s.click('Основна · Дім'); s.click('Змінити адресу'); s.click('Вінниця · Вінницька область · тестовий каталог'); s.send('Тестова'); s.click('Тестова'); s.send('12/1'); s.send('/pause'); s.send('продовжити'); s.click('Продовжити чернетку'); s.click('Зберегти адресу');
}
{
  const s = scenario('6. Видалення з можливістю залишити адресу', true);
  s.send('/addresses'); s.click('Основна · Дім'); s.click('Видалити'); s.click('Залишити адресу'); s.click('Видалити'); s.click('Видалити адресу');
}
{
  const s = scenario('7. Сповіщення, тихі години, нагадування й ранковий огляд', true);
  s.send('/settings'); s.click('Тихі години'); s.send('22:00–22:00'); s.send('22:00–08:00'); s.click('Нагадування'); s.send('45');
  s.click('Ранковий огляд'); s.send('25:20'); s.send('07:30'); s.click('Мінімальна тривалість'); s.send('60'); s.send('/pause'); s.send('/resume');
}
{
  const s = scenario('8. Дубль підтвердження, стара, прострочена й чужа кнопка'); s.address();
  const callbackId = s.turn.messages[0].buttons[0].callbackId;
  s.click('Зберегти адресу');
  s.external(handleBotInput(s.state, { id: 'sample-double-confirm', kind: 'callback', callbackId }, s.context), 'повторно натискає стару «Зберегти адресу»');
  s.send('/start'); const token = s.turn.messages[0].buttons[0].callbackId;
  s.external(handleBotInput(s.state, { id: 'sample-expired', kind: 'callback', callbackId: token }, { ...s.context, now: '2026-11-07T10:16:00+02:00' }), 'натискає кнопку через 16 хвилин');
  s.external(handleBotInput(s.state, { id: 'sample-foreign', kind: 'callback', callbackId: token }, { ...s.context, actorId: 'other-user' }), 'інший профіль намагається використати кнопку');
}
{
  const s = scenario('9. Каталог змінився під час підтвердження'); s.address(); s.context.addresses[0].binding.revisionId = 'new-binding'; s.click('Зберегти адресу');
}
{
  const s = scenario('10. Ручна черга не стає підтвердженим будинком'); s.send('/queue'); s.click('Вінниця · 1.1'); s.send('/notifications_on'); s.send('/schedule');
}
{
  const s = scenario('11. Міграція, старі посилання й старий callback', true);
  s.context.migration = { status: 'needs_confirmation' }; s.send('/start'); s.send('/migration');
  s.send('/start link_TEST_ONLY'); s.external(handleBotInput(s.state, { id: 'sample-old-callback', kind: 'callback', callbackId: 'legacy_city_vinnytsia' }, s.context), 'натискає кнопку зі старої версії');
  s.context.migration.status = 'failed'; s.send('/migration'); s.context.migration.status = 'in_progress'; s.send('/migration'); s.context.migration.status = 'complete'; s.send('/migration');
}
{
  const s = scenario('12. Особисте спостереження, допомога й reset', true);
  s.send('/report'); s.click('Світла немає'); s.send('/help'); s.send('не зрозуміло'); s.send('/reset'); s.click('Залишити дані'); s.send('/reset'); s.click('Підтвердити скидання');
}

output.push('## 13. Повний текстовий резерв усіх станів даних', '');
const statuses: PlanStatus[] = ['published', 'no_planned_outages', 'possible', 'emergency', 'not_published', 'stale', 'unavailable', 'conflict', 'needs_confirmation'];
for (const status of statuses) { output.push(`### ${status}`, '', ...formatScheduleText(reviewPlan(status)).split('\n').map(line => `> ${line}`), ''); }
output.push('## 14. Новий план, зміна, перенесення, скасування, аварія й нагадування', '', 'Це previews текстів подій, не підтвердження eligible delivery. Тестові плани мають synthetic=true; функція доставки їх блокує.', '');
const kinds: NotificationKind[] = ['new_plan', 'changed', 'moved', 'cancelled', 'emergency', 'reminder'];
for (const kind of kinds) {
  const view = reviewPlan(kind === 'emergency' ? 'emergency' : kind === 'cancelled' ? 'no_planned_outages' : 'published');
  view.previousIntervals = [{ ...reviewPlan().intervals[0], startLocal: '07:00', startsAt: '2026-11-07T07:00:00+02:00' }];
  output.push(`### ${kind}`, '', ...formatNotification(kind, view, kind === 'reminder' ? 'starts' : undefined).split('\n').map(line => `> ${line}`), '');
}
output.push('## 15. Loading, offline, запис не вдався, PNG не сформовано, send outcome unknown', '', 'Адаптер вибирає ці повідомлення лише за фактичним результатом. Помилка запису не підтверджує успіх, а unknown delivery не дає підстав для сліпого повтору.', '');
for (const [key, value] of Object.entries(RUNTIME_COPY)) output.push(`**${key}**`, '', `> ${value}`, '');
writeFileSync(new URL('../../../docs/light-bot-app/p2/bot/CONVERSATION_UA.md', import.meta.url), output.join('\n'));
const deck = { schemaVersion: 'lba-copy-candidate/1', ownerAccepted: false, language: 'uk', core: COPY,
  engine: Object.fromEntries(Object.entries(BOT_COPY).map(([key, value]) => [key, typeof value === 'function' ? (value as (...parts: unknown[]) => string)(...Array.from({ length: 15 }, (_, n) => `{${n + 1}}`)) : value])), runtime: RUNTIME_COPY };
writeFileSync(new URL('../../../docs/light-bot-app/p2/bot/copy-deck.json', import.meta.url), JSON.stringify(deck, null, 2) + '\n');
process.stdout.write(`Generated ${output.length} transcript lines; ${Object.keys(deck.engine).length} engine templates.\n`);
