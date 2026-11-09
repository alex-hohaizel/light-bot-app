import type { NotificationKind, PlanStatus, ScheduleView } from '../product-contract.ts';
import { PLAN_STATUS_COPY } from '../product-contract.ts';
import type { NotificationPolicy, NotificationChannel, ReminderEdge } from '../notification-policy.ts';
import type { BotProfile } from './types.ts';
import { formatMinutesDuration } from '../time-label.ts';

export const NOTIFICATION_COPY = {
  invalid: 'Налаштування потребують перевірки. Попередні значення збережені.',
  saved: 'Налаштування збережено. Адресна прив’язка та дозвіл каналу перевіряються перед доставкою.',
  localSaved: 'Налаштування адреси збережено. Загальна згода каналу діє окремо.',
  missingAddress: 'Цієї адреси вже немає у профілі. Оберіть потрібну адресу ще раз.',
  invalidLead: 'Введіть ціле число від 0 до 1440. Для адреси можна написати «як у каналі».',
  telegramOff: 'Повідомлення у Telegram вимкнені. Ваші адреси збережені.',
  telegramOnButton: 'Дозволити Telegram', telegramOffButton: 'Вимкнути Telegram',
  pushOnButton: 'Дозволити push', pushOffButton: 'Вимкнути push',
  telegramRemindersOn: 'Нагадування Telegram: увімкнути', telegramRemindersOff: 'Нагадування Telegram: вимкнути',
  pushRemindersOn: 'Нагадування push: увімкнути', pushRemindersOff: 'Нагадування push: вимкнути',
  beforeOff: 'Telegram: перед вимкненням', beforeOn: 'Telegram: перед відновленням',
  pushBeforeOff: 'Push: перед вимкненням', pushBeforeOn: 'Push: перед відновленням',
  addressBeforeOff: 'Для адреси: перед вимкненням', addressBeforeOn: 'Для адреси: перед відновленням',
  addressPushBeforeOff: 'Для адреси: push перед вимкненням', addressPushBeforeOn: 'Для адреси: push перед відновленням',
  edgePrompt(channel: NotificationChannel, edge: ReminderEdge, address?: string) {
    return `${channel === 'telegram' ? 'Telegram' : 'Push'} · ${edge === 'starts' ? 'перед вимкненням' : 'перед плановим відновленням'}${address ? ` · ${address}` : ' · загальне налаштування'}\n\nВведіть час у хвилинах. 0 вимикає це нагадування.${address ? ' «Як у каналі» повертає загальне значення.' : ''} Згода на канал не змінюється.`;
  },
};
export function formatNotificationSettings(preferences: BotProfile['preferences'], policy: NotificationPolicy): string {
  const lead = (value: number) => value === 0 ? 'вимкнено' : formatMinutesDuration(value);
  const lines = ['Налаштування сповіщень', preferences.paused ? 'Усі канали на паузі. Значення збережені.' : 'Кожен канал має власну згоду.'];
  for (const channel of ['telegram', 'push'] as const) {
    const value = policy.channels[channel];
    lines.push('', `${channel === 'telegram' ? 'Telegram' : 'Push'}: ${value.enabled ? 'згоду збережено' : 'вимкнено'}`,
      `Нагадування: ${value.remindersEnabled ? 'дозволені' : 'вимкнені'}`,
      `Перед вимкненням: ${lead(value.beforeOffMinutes)}`, `Перед плановим відновленням: ${lead(value.beforeOnMinutes)}`);
  }
  lines.push('', `Тихі години: ${preferences.quietHours.enabled ? `${preferences.quietHours.start}–${preferences.quietHours.end} · Europe/Kyiv` : 'вимкнені'}`,
    `Ранковий огляд Telegram: ${preferences.morningBriefing.enabled ? preferences.morningBriefing.time : 'вимкнено'}`,
    `Мінімальна тривалість перед вимкненням: ${formatMinutesDuration(preferences.minimumOutageMinutes)}`, 'Час окремої адреси може відрізнятися від загального.');
  return lines.join('\n');
}

/** Accepted voice policy: Ukrainian, polite ви, calm and direct, no emoji. */
export const COPY = {
  addressNotificationsOn: 'Увімкнути для адреси',
  addressNotificationsOff: 'Вимкнути для адреси',
  addressNotificationsEnabled: 'Повідомлення для цієї адреси дозволені. Налаштування інших адрес збережені.',
  addressNotificationsDisabled: 'Повідомлення для цієї адреси вимкнені. Інші адреси залишилися без змін.',
  globalNotificationsEnabled: 'Загальну згоду на повідомлення у Telegram збережено. Власні налаштування адрес діють окремо.',
  openApp: 'Відкрити застосунок',
  appIntent: 'У застосунку можна переглянути адреси й особистий графік. Перехід використовує ваш профіль.',
  about: '«Світло Україна» допомагає стежити за планами відключень для збережених адрес. Джерело й час перевірки наведені біля кожного плану. Фактичне живлення може відрізнятися від плану оператора.',
  historyUnavailable: 'Для тижневого огляду поки бракує перевіреної історії. Поточний план можна переглянути зараз.',
  welcome: 'Вітаємо у «Світло Україна». Додайте адресу — тут буде її план відключень і важливі зміни.',
  returning: 'Збережені адреси на місці. Що потрібно переглянути?',
  help: 'Тут можна зберегти кілька адрес, переглянути план і налаштувати повідомлення.\n\nГрафік — це план оператора, а не вимір фактичного живлення. Коли даних бракує, повідомляємо про це прямо.\n\n/start — головне меню\n/schedule — графік\n/addresses — адреси\n/settings — сповіщення\n/pause — пауза\n/resume — відновлення\n/back — крок назад\n/cancel — зупинити поточну дію, зберігши чернетку адреси\n/menu — усі розділи',
  locality: 'Оберіть населений пункт. Однакові назви розрізняємо за територією.',
  street: 'Введіть назву вулиці. Можна вказати її попередню назву.',
  house: 'Введіть точний номер будинку: наприклад, 12А, 12/1 або 12 корпус 1.',
  noStreet: 'Не знайшли такої вулиці в доступному довіднику. Перевірте назву або спробуйте її попередню назву.',
  noHouse: 'Для цього номера немає підтвердженого збігу. 12, 12А і 12/1 — різні будинки. Спробуйте точний запис або поверніться до вулиці.',
  connection: 'Для цього будинку є кілька підключень. Оберіть своє — у них можуть бути різні плани.',
  confirm: 'Перевірте адресу перед збереженням. Сповіщення поки вимкнені.',
  saved: 'Адресу збережено. Увімкнути повідомлення про новий план і його зміни?',
  savedUnverified: 'Адресу збережено, але її прив’язку до графіка ще потрібно підтвердити. Автоматичні повідомлення залишаються вимкненими.',
  paused: 'Сповіщення на паузі. Адреси й налаштування збережені; графік можна переглядати будь-коли.',
  resumed: 'Паузу знято. Повідомлення надходитимуть лише для підтверджених адрес із дозволеними сповіщеннями.',
  cancelled: 'Поточну дію скасовано. Чернетка адреси та раніше збережені дані залишилися на місці.',
  staleButton: 'Ця кнопка вже неактуальна. Зміни не повторювалися. Нижче — актуальні дії.',
  expiredButton: 'Час дії кнопки минув. Нижче можна продовжити з актуальними кнопками.',
  foreignButton: 'Ця дія належить іншому профілю. Відкрийте власне меню командою /start.',
  unknownButton: 'Стару кнопку не вдалося перевірити. Збережені дані на місці; актуальні дії — нижче.',
  noAddresses: 'Ще немає збережених адрес. Додайте першу, щоб переглядати її план.',
  noPlan: 'Для цієї адреси поки немає перевіреного плану. Це не означає відсутність відключень.',
  deliveryDisabled: 'Повідомлення вимкнені. Налаштування й адреси збережені.',
  needVerified: 'Спочатку потрібна підтверджена прив’язка адреси. Зараз можемо зберегти її та показати, що потребує уточнення.',
  renderFailure: 'Картку не вдалося сформувати. Усі дані графіка наведено текстом нижче.',
  unknownOutcome: 'Підтвердження доставки ще немає. Повторне надсилання потребує перевірки, щоб не створити дубль.',
  unavailableAction: 'Цю дію зараз не вдалося підтвердити. Дані профілю не змінено. Можна повернутися до меню й спробувати пізніше.',
} as const;

/** Adapter-only lifecycle messages: select from actual observed outcome, never simulate an outcome. */
export const RUNTIME_COPY = {
  loadingProfile: 'Відкриваємо збережені адреси…',
  loadingCatalog: 'Перевіряємо адресу в доступному довіднику…',
  checkingPlan: 'Перевіряємо, чи є свіжий план…',
  offline: 'Немає зв’язку з джерелом. Нижче можна переглянути останній збережений план із часом перевірки.',
  saveFailed: 'Не вдалося зберегти зміни. Попередні налаштування залишилися на місці. Спробуйте ще раз.',
  renderingFailed: COPY.renderFailure,
  deliveryUnknown: COPY.unknownOutcome,
  noAccess: 'Немає доступу до цієї дії. Відкрийте власний профіль через /start.',
} as const;

function dateLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Kyiv' }).format(new Date(`${date}T12:00:00Z`));
}
function instantLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'час не вказано';
  return new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }).format(new Date(value));
}
export function formatScheduleText(view: ScheduleView): string {
  const title = view.status === 'no_planned_outages' ? 'Оператор не планує відключень на цю дату' : PLAN_STATUS_COPY[view.status].title;
  const lines = [`${view.synthetic ? 'Тестовий приклад · ' : ''}${view.addressLabel} · ${dateLabel(view.serviceDate)}`, title];
  if (view.intervals.length) {
    lines.push(view.status === 'stale' ? 'Останні відомі інтервали:' : 'Інтервали за планом:');
    for (const interval of view.intervals) lines.push(`${interval.startLocal}–${interval.endLocal}${interval.kind === 'possible_outage' ? ' · можливе відключення' : ' · планове відключення'}`);
  }
  lines.push(PLAN_STATUS_COPY[view.status].detail);
  if (view.dayCoverage === 'partial') lines.push('Дані охоплюють лише частину доби. Решта часу не вважається підтвердженою.');
  if (view.notice) lines.push(view.notice);
  lines.push(`Джерело: ${view.source.name}`, `Перевірено: ${instantLabel(view.observedAt)} · Europe/Kyiv`);
  if (view.publishedAt) lines.push(`Опубліковано: ${instantLabel(view.publishedAt)}`);
  return lines.join('\n');
}
export function formatNotification(kind: NotificationKind, view: ScheduleView, reminderEdge?: 'starts' | 'ends'): string {
  const titles: Record<NotificationKind, string> = { new_plan: 'Є новий план', changed: 'План змінився', moved: 'Час відключення перенесено', cancelled: 'Планове відключення скасовано', emergency: 'Оператор повідомив про аварійний режим', reminder: 'Нагадування про заплановану зміну' };
  const lines = [titles[kind]];
  if (kind === 'reminder' && reminderEdge) lines[0] = reminderEdge === 'starts' ? 'Нагадування: заплановано початок відключення' : 'Нагадування: заплановано завершення відключення';
  if (view.previousIntervals && ['changed', 'moved', 'cancelled'].includes(kind)) {
    lines.push(`Було: ${view.previousIntervals.length ? view.previousIntervals.map(i => `${i.startLocal}–${i.endLocal}`).join(', ') : 'планових інтервалів не було'}`);
    lines.push(`Стало: ${view.intervals.length ? view.intervals.map(i => `${i.startLocal}–${i.endLocal}`).join(', ') : 'планових інтервалів немає'}`);
  }
  lines.push(formatScheduleText(view));
  return lines.join('\n\n');
}
export function statusExample(status: PlanStatus): string { return PLAN_STATUS_COPY[status].detail; }

function copyDuration(value: unknown): string {
  if (typeof value === 'number') return formatMinutesDuration(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return formatMinutesDuration(Number(value));
  return 'не вказано';
}
/** Complete candidate UI templates used by the deterministic engine; keys are stable copy-deck references. */
export const BOT_COPY = {
  engineText001: "Не вдалося прочитати стан розмови. Відкрийте /start — профіль не змінювався.",
  engineText002: "Мій графік",
  engineText003: "Мої адреси",
  engineText004: "Сповіщення",
  engineText005: "Назад",
  engineText006: "Скасувати",
  engineText007: "Для цього будинку підтверджено зв’язок із графіком.",
  engineText008: "Прив’язка ще потребує перевірки.",
  engineText009: "Зберегти адресу",
  engineText010: "Що потрібно зробити?",
  engineText011: "Основна · ",
  engineText012: " · на паузі",
  engineText013: " · потребує підтвердження",
  engineText014: "Додати адресу",
  engineText015: "Як це працює",
  engineText016: "Продовжити чернетку",
  engineText017: "\n\nСповіщення зараз на паузі.",
  engineText018: "Старі адреси збережено. Для частини з них змінився спосіб прив’язки до графіка — потрібне підтвердження. Налаштування й паузи не скидаємо.",
  engineText019: "Перевірити адреси",
  engineText020: "Збережені адреси. Для кожної можна окремо змінити назву, порядок або сповіщення.",
  engineText021: "Основна · ",
  engineText022: " · пауза",
  engineText023: "Додати адресу",
  engineText024: "Головне меню",
  engineText025: "Чергу обрано вручну; це не підтверджена адреса.",
  engineText026: "Прив’язку підтверджено.",
  engineText027: "Прив’язка потребує уточнення.",
  engineText028: "на паузі",
  engineText029: "увімкнені",
  engineText030: "вимкнені",
  engineText031: (p0: unknown, p1: unknown, p2: unknown, p3: unknown, p4: unknown, p5: unknown) => "" + String(p0) + "\n" + String(p1) + ", " + String(p2) + "" + String(p3) + "\n" + String(p4) + "\nTelegram для адреси: " + String(p5) + ".",
  engineText032: "Показати графік",
  engineText033: "Назва",
  engineText034: "Змінити адресу",
  engineText035: "Зробити основною",
  engineText036: "Вище у списку",
  engineText037: "Нижче у списку",
  engineText038: "Зняти паузу адреси",
  engineText039: "Пауза адреси",
  engineText040: "Поділитися",
  engineText041: "Повідомити про світло",
  engineText042: "Видалити",
  engineText043: "Усі адреси",
  engineText044: "на паузі",
  engineText045: "дозволені для підтверджених адрес",
  engineText046: "вимкнені",
  engineText047: (p0: unknown) => {
    const duration = copyDuration(p0);
    return duration === 'не вказано' ? 'Час нагадування не вказано' : `за ${duration}`;
  },
  engineText048: "вимкнені",
  engineText049: "вимкнені",
  engineText050: "вимкнений",
  engineText051: (p0: unknown, p1: unknown, p2: unknown, p3: unknown, p4: unknown) => "Сповіщення: " + String(p0) + ".\nНагадування: " + String(p1) + ".\nТихі години: " + String(p2) + ".\nРанковий огляд: " + String(p3) + ".\nМінімальна тривалість для нагадування: " + copyDuration(p4) + ".",
  engineText052: "Відновити після паузи",
  engineText053: "Пауза всіх повідомлень",
  engineText054: "Вимкнути повідомлення",
  engineText055: "Увімкнути повідомлення",
  engineText056: "Нагадування",
  engineText057: "Тихі години",
  engineText058: "Ранковий огляд",
  engineText059: "Мінімальна тривалість",
  engineText060: "Адреси",
  engineText061: "Головне меню",
  engineText062: (p0: unknown) => "Досягнуто поточного ліміту адрес: " + String(p0) + ". Можна змінити або видалити одну зі збережених.",
  engineText063: "Мої адреси",
  engineText064: "У цьому довіднику поки немає підтверджених адрес. Можна повернутися пізніше; збережені дані не змінюються.",
  engineText065: "Перевірити адресу",
  engineText066: "Оновити план",
  engineText067: "Інша адреса",
  engineText068: "Налаштування",
  engineText069: "Це посилання зі старого бота. Спочатку перевіримо його строк дії та належність профілю. Дані акаунтів не об’єднуються автоматично.",
  engineText070: "Відкрити своє меню",
  engineText071: "Незавершених адрес немає.",
  engineText072: "Відновити",
  engineText073: "Мій графік",
  engineText074: "Паузу знято. Сповіщення залишаються вимкненими — їх можна окремо увімкнути в налаштуваннях.",
  engineText075: "Перевірити адресу",
  engineText077: "За скільки хвилин нагадати про планову зміну? Введіть число від 1 до 1440. Щоб вимкнути нагадування — 0.",
  engineText078: "Назад",
  engineText079: "Вкажіть тихі години у форматі 22:00–08:00. Час — Europe/Kyiv. Щоб вимкнути — «вимкнути». Аварійні винятки не вмикаємо без окремо прийнятої політики.",
  engineText080: "Назад",
  engineText081: "О котрій надсилати ранковий огляд? Наприклад, 07:30 · Europe/Kyiv. Щоб вимкнути — «вимкнути».",
  engineText082: "Назад",
  engineText083: "Від якої тривалості відключення потрібне нагадування? Введіть хвилини; 0 — для всіх підтверджених інтервалів.",
  engineText084: "Назад",
  engineText085: "Ручний вибір черги — окремий режим. Він не підтверджує будинок і сам по собі не вмикає персональні сповіщення.",
  engineText086: "Пошук за адресою",
  engineText087: "Назад",
  engineText088: "Готуємо посилання з безпечним доступом. Повну приватну адресу до публічної картки не додаємо.",
  engineText089: "Порівняння адрес доступне у застосунку. Використовується той самий профіль і ревізія плану.",
  engineText090: "Що зараз спостерігається за цією адресою? Це особисте повідомлення, окреме від графіка оператора.",
  engineText091: "Світло є",
  engineText092: "Світла немає",
  engineText093: "Скасувати",
  engineText094: "Перенесення профілю підтверджено. Адреси й налаштування доступні в цьому ж профілі.",
  engineText095: "Перенесення ще триває. Повторний запуск не потрібний; старі дані зберігаються до звірки.",
  engineText096: "Перенесення не завершилось. Старі дані збережено; потрібна перевірка перед повтором.",
  engineText097: "Старі адреси й налаштування потрібно звірити. Невідомі прив’язки не видаляються і не переносяться іншому власнику.",
  engineText098: "Мої адреси",
  engineText099: "Скинути адреси та налаштування цього профілю? Сповіщення вимкнуться. Ця дія потребує підтвердження; вхід до акаунта не видаляється.",
  engineText100: "Підтвердити скидання",
  engineText101: "Залишити дані",
  engineText102: "Можна переглянути графік, змінити адресу або налаштувати сповіщення. Для всіх команд — /help.",
  engineText103: (p0: unknown) => "Знайдено чинну назву: " + String(p0) + ". Попередня назва збережена як варіант пошуку.\n\n",
  engineText104: "Прив’язка змінилася під час підтвердження. Перевірте будинок ще раз; адресу не збережено.",
  engineText105: "Ця адреса вже є у профілі. Дубль не створено.",
  engineText106: (p0: unknown) => "Адреса " + String(p0) + "",
  engineText107: "Дім",
  engineText108: "Увімкнути повідомлення",
  engineText109: "Залишити вимкненими",
  engineText110: "Повідомлення для цієї адреси увімкнені. План можна переглянути зараз.",
  engineText111: "Адреса збережена. Повідомлення залишилися вимкненими.",
  engineText112: "Як назвати адресу? Наприклад: Дім, Батьки або Робота. До 60 символів.",
  engineText113: "Назад",
  engineText114: "Ця адреса тепер основна.",
  engineText115: "Повідомлення для адреси на паузі.",
  engineText116: "Паузу адреси знято.",
  engineText117: (p0: unknown) => "Видалити «" + String(p0) + "»? Налаштування інших адрес залишаться без змін.",
  engineText118: "Видалити адресу",
  engineText119: "Залишити адресу",
  engineText120: "Адресу видалено. Ще не розпочаті повідомлення для неї скасовуються.",
  engineText121: "Досягнуто поточного ліміту адрес.",
  engineText122: (p0: unknown) => "Черга " + String(p0) + "",
  engineText123: "Ручну чергу збережено. Вона позначена як вибір користувача; будинок і персональні повідомлення не підтверджені.",
  engineText124: "Адреси й налаштування скинуто. Сповіщення вимкнені. Вхід до акаунта збережений.",
  engineText125: "Додати адресу",
  engineText126: "Особисте спостереження підготовлено до запису. Воно не замінює опублікований план оператора.",
  engineText127: "Введіть щонайменше дві літери назви вулиці.",
  engineText128: "Оберіть точну вулицю зі списку. Пошуковий збіг сам по собі не підтверджує адресу.",
  engineText129: (p0: unknown) => "Підключення " + String(p0) + "",
  engineText130: "Вкажіть назву від 1 до 60 символів без службових переносів.",
  engineText131: "Назад",
  engineText132: "Назву адреси змінено.",
  engineText133: "Потрібне ціле число хвилин від 0 до 1440.",
  engineText134: "Назад",
  engineText135: "вимкнути",
  engineText136: "Вкажіть різні початок і кінець у форматі 22:00–08:00. Для повної паузи є /pause.",
  engineText137: "Назад",
  engineText138: "вимкнути",
  engineText139: "Вкажіть час у форматі 07:30 або «вимкнути».",
  engineText140: "Назад",
  engineText141: "продовжити",
  engineText142: "Продовжити додавання адреси чи зняти паузу сповіщень?",
  engineText143: "Продовжити чернетку",
  engineText144: "Зняти паузу",
  engineText145: "продовжити",
} as const;
