# Повідомлення про реліз: виконаний компонент

Компонент `lba-v8-production-campaign-worker` підключає вже наявні `update-campaign`, PostgreSQL repository і глобальний Telegram dispatcher до життєвого циклу canonical runtime. Окремого відправника, нової таблиці, нового облікового запису або нового бота немає. Без явної конфігурації компонент вимкнений; створення об’єкта й виклик вимкненого компонента не виконують SQL, HTTP чи native send.

Виконавець: `/root/production_campaign_worker`. Компонент отримано й реально розпочато за записом `received-started.json`. Застосовано фактично прочитаний snapshot ChatBot Atelier Build 5.0.0 `skill-build.md`. Пізніший профіль якості AgentSystem 6.0.0 застосований до результату; історичне джерело навички не переприв’язане. Виконання компонента не є незалежним QA або прийманням усіх 68 вимог.

## Явне ввімкнення

Єдиний новий вхід runtime — `LBA_RELEASE_NOTICE_CONFIG`, JSON із закритим набором полів:

```json
{
  "kind": "lba-release-notice/1",
  "releaseId": "approved-stable-notice-release-id",
  "deploymentRef": "lba-release:approved-rollout-reference",
  "buildSha256": "ACTUAL_FINAL_COMPILED_SOURCE_SHA256",
  "authoritySha256": "613b008586fe302bc4cbdd45d4f34ae2eb45d2c050ddbf4c459747ac22e5a2bc",
  "createdAt": "ACTUAL_APPROVED_WINDOW_START_ISO",
  "expiresAt": "ACTUAL_APPROVED_WINDOW_END_ISO",
  "controlEpoch": 1,
  "pilotSize": 1,
  "maxAttempts": 3
}
```

Це приклад форми, який навмисно не можна виконати як готове production налаштування. Root підставляє фінальний source hash, фактичний control epoch і вікно. Вікно не довше семи діб, pilotSize 1–5, maxAttempts 1–5. Відсутній вхід означає вимкнення; зайве поле, невірна authority/source/epoch або форма вхідних даних означає відмову. Hash посилається на чинний `authorization.json`; прапорець чи hash самі по собі не створюють нової згоди людини. Після створення кампанії її ID, текст, binding, вікно та maxAttempts не можна підмінити новою конфігурацією.

`deploymentRef` — явний логічний ідентифікатор цього rollout, який відображається на історичне поле рушія `CampaignBinding.deploymentId`. Він **не є native Replit deployment UUID**. Окремий фактичний provider deployment ID і квитанцію `get_publish_status` зберігає root. Публічний health показує `configuredBotId` як конфігурацію; це не доказ відповіді Telegram `getMe`.

## Публічний health і native boundary

Перед підготовкою аудиторії та перед кожною спробою компонент реально читає лише `https://power-ukraine.net/api/health/release`. Redirect заборонений, timeout обмежений, JSON не більший 16 KiB. Перевіряються actual compiled `releaseId` та `buildSha256`, noticeReleaseId, deploymentRef, origin, configuredBotId, production/active/process_serving, timestamp без майбутнього й не старший 10 секунд, canonical ready/started/deliveryReady та stopped=false. Observation складається з отриманої відповіді. Мережеве читання не утримує DB locks.

Неправильний, старий, ізольований або неготовий public build не готує кампанію і не відправляє notice. Media type має точно дорівнювати `application/json` після нормалізації регістру й пробілів; параметри на кшталт `charset=utf-8` дозволені, `application/jsonx` відхиляється. Об’єкт health не проголошує приймання продукту. Точну схему для bootstrap finalizer містить `health-contract.json`; для завершення core bootstrap не потрібне ввімкнення кампанії. Native identity, destination, eligibility, throttle, journal і receipt перевіряє той самий глобальний dispatcher на реальній межі надсилання.

## Аудиторія та послідовність

Один приватний read-only SQL snapshot класифікує кожний subscription chat рівно в одну гілку. Canonical owner використовує точний `telegramOwnerRecipientRef(ownerId)` і чинні canonical preferences. Accountless legacy subscription використовує existing registry з тим самим `SESSION_SECRET`, що й canonical runtime. Історичні accounts/owners не вгадуються; legacy enabled має бути буквально true. Наявність неоднозначних links, сторонніх settings references, паузи, opt-out, epoch або ownership drift не дає право надсилання. Кандидат повторно перевіряється під поточними locks, frozen branch не змінюється на інший recipient ref після конфлікту. Оцінка йде обмеженими порціями 64 кандидати або дві секунди на tick. Ліміти snapshot: 100 000 subscriptions/profiles і 200 000 links.

Repository заморожує обрані refs. Pilot бере до pilotSize з фактично eligible аудиторії: canonical спочатку, потім standalone legacy. Немає вигаданого тестового акаунта чи окремого повідомлення: використовується єдиний погоджений `UPDATE_ANNOUNCEMENT_UA` і URL застосунку. Full дозволено тільки після позитивної перевіреної provider receipt для **кожного** pilot recipient і відсутності unknown. Restart використовує той самий campaign/spec/jobs і не повторює sent. Поточний opt-out, зміна власності, 403, 429, cooldown і native ambiguity обробляються на спільній межі. 403 у pilot лишається terminal skip і не дає примусової full promotion; unknown зупиняє кампанію без автоматичної повторної відправки. Operator pause не скидається. Expiry закриває не розпочаті jobs, залишаючи ambiguous effect під hold. Stop перериває HTTP/identity boundary й зупиняє один bounded worker.

Приватні aggregate counts доступні через observation; публічний health не містить audience, owner, chat або recipient refs. Тут жодного production subscriber не читали й не реєстрували. Фактичні production eligible/excluded counts і provider receipts мають з’явитися тільки під час дозволеного root rollout.

## Виправлення спільного dispatcher

Реальний локальний PostgreSQL відтворив баг: normal worker сканував deferred campaign job без чинної outer campaign claim і скасовував notice. Старий файл зафіксовано в `base-telegram-dispatch.ts`; failed-before доказ — `before-poison-repro.json`. Виправлено тільки вибір семантичної hydration та dispatch: normal worker працює з profile jobs, explicit campaign path — зі своїм operation. Уже terminal cancelled/failed outer jobs можна очистити для розблокування наступної роботи. Standalone profile dispatcher продовжує працювати без optional campaign tables.

Global bot advisory lock, відновлення native intent після crash **для всіх видів jobs**, unknown holds, cooldown, reachability і порядок одного chat залишилися спільними. Це підтверджено фактичним завершенням PostgreSQL backend після native intent: campaign crash блокує profile іншого chat, profile crash блокує campaign. Shared boundary потребує незалежної перевірки root judge.

## Докази й межі

`author-pg.json`: 17/17 на справжньому одноразовому PostgreSQL і справжньому локальному HTTP server. Native Telegram transport — synthetic fixture. Public HTTPS origin у harness — явний synthetic URL adapter; це не production HTTPS receipt. Покрито disabled 0 effects, malformed/foreign/stale/future health, pilot→full, restart, regular coordination, обидва crash напрямки, consent revoke, unknown, 429/403, bot lock, expiry/operator pause, stop during HTTP/getMe, canonical prepare/start/stop і відсутність optional repository.

`legacy-regression/peer-pg.json`: 14/14 на чинному shared dispatcher. Це повторне виконання автором компонента, позначене `independent: false`; воно не переписує попередній independent receipt. Перша регресія 13/14 перед terminal cleanup збережена окремо. Після незалежно виявленого MIME багу авторський actual PG+HTTP regression також відтворив `application/jsonx` → pilot на попередніх bytes; raw і попередні source/receipt збережено в `before-mime-repair/`. Після однорядкового виправлення актуальні 17/17 знову пройшли, включно з negative jsonx і positive uppercase JSON із параметром. TypeScript check: exit 0. Backend 311/311 виконано до MIME-виправлення і не переприв’язано до нових bytes; фінальні broad checks проводить root. Dispatcher і всі залежності чинного legacy 14/14 proof не змінилися, його не повторювали. Вхідні source hashes, output pins, відсутність drift та команди містить `component-receipt.json`.

Наступна дія root: незалежно перевірити ці чотири app outputs і shared dispatcher, сформувати новий exact-source candidate, отримати фактичні public same-build/provider receipts і лише тоді задати явну notice configuration для дозволеного pilot/full. Цей компонент не замінює data QA, device QA, source certification, native identity/domain checks або приймання решти 68 вимог. Production, чинний webhook, дані та Telegram тут не змінено.
