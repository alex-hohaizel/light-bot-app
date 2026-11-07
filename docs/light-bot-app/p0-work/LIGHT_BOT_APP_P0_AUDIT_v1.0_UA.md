# LIGHT BOT APP — P0-аудит і наступний етап

**Редакція 1.0 · 7 листопада 2026 · LBA-P0-001**  
**Результат: read-only аудит доступних джерел виконано; приймальний gate P0 частково заблокований.** Відновлено погоджений контекст, отримано поточний аудит Replit, підтверджено ревізії GitHub, робочого коду й ідентичність перевіреного бота, схему та агрегати керованих БД. Підготовлено P0-R для закриття provenance/відтворюваності та план P1.

**Головні результати:** у робочому коді Харків читає київське джерело; підтверджені небезпечні auth/logging/cache та delivery/startup патерни. У managed production знайдено один Telegram-link conflict та групи дублікатів адрес/дайджестів. Доказу відповідності цих файлів serving build і зв’язку live-процесу з перевіреною БД немає. Реліз не змінювався.

## 1. Межі роботи й чинні рішення

Підстава цього виконання — пряме доручення власника: «ВІДНОВИ LIGHT BOT APP за погодженим паспортом v1.0. Виконай P0-аудит у режимі читання та підготуй наступний етап». Раніше погоджене створення агента не використовується як дозвіл на продуктові зміни.

Збережено рішення D-01–D-03:

- Мінімум першого відновлення: Київ, Вінниця, Одеса, Харків і весь додатковий фактичний legacy-обсяг, який ще потрібно встановити. Нові території додаються за підтвердженими даними.
- Вартість доступу до основного й резервного API — 0. Платні API та проксі не є fallback. Бюджет інфраструктури ще не визначений.
- Зберігаємо чинного @PowerUkraineBot, домен і профілі. Заява власника про доступи прийнята; фактичні bot ID, production DB binding і права конкретного хоста ще перевіряються.

Виконувалися читання матеріалів, metadata, Git refs/tree/files і один запит read-only аудиту до Replit. Аудитору прямо заборонено запуск сервера, seed, міграцій, планувальника, webhook registration, polling/getUpdates, розсилки та production export. Продуктових записів, деплою чи розсилки цей виконавець не запускав. Результат віддаленого аудиту отримано; це не дозвіл на виконання запропонованих ним продуктових змін.

## 2. Що підтверджено зараз

| Об’єкт | Спостережений факт | Межа доказу |
| --- | --- | --- |
| Work | Чинний LIGHT BOT APP [WORK], project ID `g-p-6aee37634784819189b085127be2946b` | Локальний Codex не запускався |
| Replit | [Power Outage Tracker](https://replit.com/@ghostssaus/Power-Outage-Tracker), app ID `6cdd42ed-6051-42d1-bea6-d73e9f98682d` | Точний app, а не збіг назви |
| Робочий код | `main @ 45d77e22e68816e5695aa4b7d2a62bfc57e8176d`; normal porcelain status порожній | За аудитом Replit Agent; ignored-файли не охоплені |
| Source inventory | Маніфест 142 web/backend/config-файлів, SHA-256 `0fcef7b6d415ee61ba4f4c89074ca9b0f54e4759e7511a7c9b3677bd573db704` | Текст маніфесту отриманий і його digest незалежно повторено; самі source bytes тут не отримані |
| Публікація | ID `e214ddd5-f6c3-4834-a5d8-2fd29d64a979`, статус `success`, [power-ukraine.net](https://power-ukraine.net/) | API metadata, не функціональний тест |
| Build history | Найновіший отриманий success build `9f7e9359-5129-4dea-a595-25f6b1db9d1e`, cloud_run, created `2026-06-22T12:55:55.090Z` | Не доведено як actual serving revision; Git SHA unknown |
| GitHub | Приватний [alex-hohaizel/light-bot-app](https://github.com/alex-hohaizel/light-bot-app), ID `1448402213`; read доступне | Push/merge не виконувалися |
| main GitHub | `cc7f2f410b2d7b0e8457110ee5af70293b49beff`; full tree: README і LICENSE | Код застосунку тут відсутній |
| Гілка агента | `agent/light-bot-app-recovery-v1 @ f19cf19c2dad177cc059157b9ded4443637ebefc` | Full tree містить агента й документи, не реалізацію продукту |
| Паспорт/blueprint | Байти й контрольні hashes збігаються з прийнятою редакцією | Цілісність наміру, не runtime proof |
| Telegram | getMe: `8577497098 / PowerUkraineBot` | Identity доступного перевіреного токена; його тотожність production secret не порівнювалась |
| Конфігурація бота | Webhook host power-ukraine.net, path /api/telegram-webhook; menu web_app того самого host; commands start/schedule/settings/help; allowed updates message/callback_query; pending 0 | Не доводить оброблення updates чи доставку; повний webhook URL/secret не збережені |

Replit metadata workspace updated — `2026-06-22T13:04:07.340Z`; це не заміна revision/hash. Анонімне web-читання обох доменів не вдалося; це не доказ downtime. Авторизований веб/Mini App на пристрої не тестували.

**Стан перенесення:** у двох перевірених GitHub-деревах є агент і контекст, але немає коду застосунку. Поточний код виявлено в Replit. Доказу його втрати немає.

## 3. Метод, аудитори й відновлення після timeout

Основний виконавець перевірив GitHub refs/tree/files, вихідні документи та hashes. Replit Agent у межах read-only запиту оглянув workspace source/config, Git metadata, runtime/lockfiles, deployment metadata, системні каталоги й агрегати двох managed DB targets та виконав Telegram getMe/getWebhookInfo/getChatMenuButton/getMyCommands. Аудит source/SQL/API є **опосередкованим доказом від Replit Agent**; незалежного читання продуктових source bytes у Work не було.

Перший запит перевищив час очікування; наступні busy-питання не приймалися. Пізніше отримано вже готовий результат, phase=paused, і деталі без повторних команд. **Невідомий результат початкового читання знято.** Повний аудит паралельно не перезапускався.

Додатковий bounded read-only probe прочитав build logs саме build `9f7e9359-5129-4dea-a595-25f6b1db9d1e`: `build.logs=[]`, 0 записів. Full Git SHA і DB resource binding не встановлені. Це не доводить відсутності provenance в інших системах; цей конкретний канал більше доказу не дав. Runtime/request/user logs не читалися.

Незалежний reviewer перевірив критерії P0 та межі висновків. Це review аудиту, а не незалежне QA реалізації або production.

## 4. Критерії P0 та вердикти

| Перевірка | Вимоги | Вердикт | Залишок |
| --- | --- | --- | --- |
| Project identity, прийнятий намір, read-only scope | LBA-01, LBA-11 | Підтверджено | При передачі зберегти bindings |
| GitHub refs/tree, паспорт і комплект агента | LBA-01, LBA-08 | Підтверджено | Перевіряти drift HEAD |
| Workspace revision і source inventory | LBA-01 | Частково підтверджено | Маніфест 142 файлів не є повним придатним source snapshot; source bytes/виключення відкриті |
| Deployed revision і diff workspace↔serving | LBA-01, LBA-08 | Blocked | Metadata/build logs не дали Git SHA/serving provenance |
| Startup graph | LBA-01, LBA-08 | Підтверджено віддаленим static review | Development mode не усуває auto-seed/reconciliation |
| Ізольована відтворюваність | LBA-01, LBA-08 | Не виконано; blocked | Потрібні source copy й isolation; build/typecheck/server/tests не запускались |
| Схема PK/FK/index/default | LBA-01, LBA-04 | Оглянуто source і managed production catalog | Не встановлює DB live-процесу |
| Dev/prod inventory та integrity | LBA-04 | Агрегати отримані; 3 ненульові предикати | Окремі SELECT, не transactional snapshot; потрібна класифікація винятків |
| Live-process→production DB binding | LBA-01, LBA-04 | Blocked | Потрібен авторитетний mapping або безпечна вже наявна runtime-діагностика |
| Bot identity/config | LBA-05, LBA-11 | Підтверджено для перевіреного токена | Зв’язок production secret/runtime не доведено; delivery не тестувалась |
| Web/Mini App/auth/cache risks | LBA-05–07 | Поточні source findings отримані | Serving applicability і regression runtime proofs відкриті |
| Фактичний legacy scope | LBA-10 | Чотири головні гілки + збережені локації підтверджені | Історичний повний scope і незалежне ОСР/address binding не доведені |

**P0 gate не пройдено повністю.** Read-only аудит доступної поверхні завершений, критичні невідомі збережені як blockers. LBA-02/03/09 — due P1; LBA-07 має подальші P2+ докази. Немає припущення, що отриманий звіт або publication success закриває integration/device/human readiness.

## 5. Пріоритетні source risks

Перевірено Replit Agent для workspace `45d77e22e68816e5695aa4b7d2a62bfc57e8176d`. Місця нижче стосуються source; наявність цих дефектів у serving build unknown. Значення секретів і персональні записи не виводилися.

| ID | Підтверджений патерн і можливий наслідок | Доказ source | Наступна перевірка/ремонт |
| --- | --- | --- | --- |
| R-01 | Харків читає YASNO 25/902 і київський emergency; може показувати чужий графік | server/scraper-kharkiv.ts:3–5,115; server/emergency-alerts.ts:267–268 | Власний харківський ОСР; fixture відхиляє foreign scope |
| R-02 | Невідомий upstream status перетворюється на online | server/scraper.ts:102–114 | Empty/missing/unknown/error → окремий статус, не «світло є» |
| R-03 | Telegram detect/subscriber/sync-address handlers без обов’язкової auth/ownership перевірки | server/routes.ts:1629–1679 | Server auth і ownership; синтетичні негативні запити на isolated стенді |
| R-04 | Mini App HMAC без freshness initData | server/routes.ts:2115–2167 | auth_date, replay policy, target bot; окремі negative fixtures |
| R-05 | API JSON і webhook text логуються; PNG key не включає адресу, яку отримує renderer | server/index.ts:50–69; server/routes.ts:1603–1605; server/telegram-bot.ts:2128–2136 | Redacted log allowlist; cache isolation і відсутність приватної адреси в загальних картках |
| R-06 | State/tokens у пам’яті; webhook ACK перед async processing; notif key до send | server/telegram-bot.ts:133–161,4893–4994,4546–4555; server/routes.ts:1601–1606 | Durable inbox/outbox, shared state, один sender, outcome_unknown, restart/429/timeout/duplicate tests |
| R-07 | Startup робить auto-seed і reconciliation до development guard | server/routes.ts:2678–2694; server/telegram-bot.ts:4819–4826 | Ізолювати startup; одного NODE_ENV=development недостатньо |
| R-08 | Літеральний webhook secret у коді | server/telegram-bot.ts:4711–4715 | Names-only secret inventory, санітизована копія; rotation лише в дозволеному переключенні |
| R-09 | Дайджест містить випадкові показники; report-історія переважно seed | server/routes-digest.ts:47–79; агрегати managed DB | Відділити synthetic/unknown від фактів, не переносити як telemetry |

Ризик profile linking додатково підтверджує один ненульовий managed-DB предикат у розділі 6. Це не дає права автоматично зливати акаунти за username/email/chat ID.

Фактичні витоки, експлуатація replay, втрата чи дублювання повідомлень не перевірялися й не стверджуються. Потрібний regression oracle має відтворювати конкретний патерн на синтетичних даних; текстовий review не заміняє такого тесту.

## 6. Дані, схема та фактичний legacy

Нижче — нові агрегати від Replit Agent для позначених **managed development/production targets**. Live-процес→ця production DB не доведено. SELECT виконувались окремо, без спільного transactional snapshot.

| Таблиця | Development | Production |
| --- | ---: | ---: |
| users | 0 | 10 |
| sessions | 0 | 4 |
| user_settings | 0 | 10 |
| telegram_subscribers | 2 | 9 |
| linked_accounts | 0 | 10 |
| user_locations | 0 | 15 |
| power_reports | 13 342 | 15 699 |
| weekly_digests | 0 | 5 |
| compare_shares | 1 | 4 |

Seed classification за іменем: dev 13 342 seed / 0 інших; prod 15 649 seed / 50 інших. Ці 50 не доведені як реальні. Кількість рядків subscribers не дорівнює охопленню дозволеної розсилки.

**Integrity:** у managed prod знайдено 1 групу однакових user/city/street/house locations, 1 settings Telegram-link conflict і 1 duplicate digest user/week group. У dev усі виконані перевірки — 0. Нуль у prod отримано для перевірених orphan settings/locations/linked/digests/subscribers/non-seed reports, duplicate provider+provider_id, missing/multiple primary locations і subscriber Telegram-link conflicts.

Settings conflict: telegram_chat_id у settings збігається з Telegram provider_id linked_accounts, але user_id відрізняються. Це кандидат на ручне доказове зіставлення, без автоматичного merge. Duplicate location може бути припустимим бізнес-випадком; його не слід видаляти лише через count.

**Source/catalog schema:** users PK+unique email; sessions PK sid+expire index; linked_accounts FK users CASCADE+unique provider/provider_id; settings PK/FK users; locations serial PK+FK users+unique share_id; subscribers PK chat_id без user FK; power_reports без user/chat FK; digests nonunique user/week index; compare_shares unique share_id. Повний names-only inventory defaults/constraints і предикатів міститься в evidence/replit-p0-details.txt. Числа default-полів не перетворюються на обрану політику нового продукту.

| Гілка | Legacy source routes | Збережені локації managed prod |
| --- | --- | ---: |
| Вінниця | Community GitHub JSON, local address JSON, VOE news emergency | 7 |
| Київ | YASNO 25/902; streets/houses/group; notifications region 25 | 2 |
| Одеса | DTEK proxy odeska-oblast, OEM address AJAX, proxy emergency | 3 |
| Харків | UI «Харківобленерго», але київський upstream зі зміною груп; local address lists | 3 |

У всіх 15 локацій непорожня street. Address lookup mode: Вінниця 6, Київ 2, Одеса 3, Харків 3. Окремої operator-колонки немає. Це підтверджує наявність налаштувань у містах, **не коректність адресного графіка**. Допоміжні Bezsvitla/Svitlo адаптери виявлені, активність основними routes/bot не доведена. Інші регіони в перевірених головних гілках не встановлені; повний історичний Git/native/docs scope не досліджувався.

Для майбутньої міграції зберігаються old PK або детермінований ID mapping, verified identities, адреси/мітки/порядок/основна локація, quiet hours, reminders, opt-outs. Старі notification keys/message IDs — історія, не доказ доставки. Сесії/share IDs, synthetic та unknown records класифікуються окремо. Сирого export/import не виконано.

## 7. Безпосередній наступний етап: P0-R

**Мета:** закрити provenance і підготувати відтворюваний ізольований запуск. Це точний залишок P0; не новий агент, бот чи продукт. Read-only діагностика успадковує чинне доручення. Продуктові зміни, імпорт у GitHub, startup-ремонт і запуск зміненого стенду ще не виконуються в межах цього read-only closeout.

| Вхід/блокер | Власник наступного кроку | Точний крок | Критерій успіху |
| --- | --- | --- | --- |
| Serving Git/source revision | Директор + власник Replit deployment | Перевірити вже наявні authoritative deployment/build provenance; build logs уже перевірені й порожні | Serving artifact↔source revision доведені; інакше explicit unknown |
| Live-process→DB binding | Власник/оператор хоста | Publishing→Database та Database→Production: звірити resource binding, якщо UI його показує; передати лише resource ID/label без connection string | Mapping саме запущеного deployment, не просто managed SQL target |
| Придатний source-only snapshot | Директор у довіреному середовищі Replit/Codex | Отримати санітизовану копію exact source, manifest і список вилучень | Bytes+hash+revision, lockfiles, schema, startup і renderer; без секретів/PII |
| Небезпечний startup | Build-виконавець після прийняття writable scope | У копії перед будь-яким запуском ізолювати seed/reconcile, webhook/send/scheduler, DB й outbound network | Synthetic конфігурація не може торкатися production |
| Три ненульові data predicates | Data lead | Класифікувати на дозволеному наборі; підготувати deterministic mapping/quarantine rules | Жодного auto-merge за username/email; per-account proof |
| Неповний legacy scope | Директор/data lead | Перевірити дозволену історію й native/docs inventory без secrets/data export | Підтверджена baseline карта або exact scope limitation |

Підтриманого read-only інструмента, який уже довів identity DB connection serving-процесу, не знайдено. Довільний HTTP GET чи запуск старого сервера не є безпечним замінником. Якщо mapping не видно й у доступному UI, наступним окремим scope буде безпечна runtime-діагностика; її наслідки треба спочатку підготувати до огляду.

Source snapshot запасним шляхом: відкрити [чинний Replit](https://replit.com/@ghostssaus/Power-Outage-Tracker) → Files → ⋯ → Download as zip; **до передачі** підготувати локально санітизовану копію. Не додавати необроблений архів у чат/GitHub. Вилучити .env/секрети, історію з секретами, dumps/logs/user/subscriber records, caches і rebuild outputs; зберегти дозволений source, package/lockfiles, schema/migrations, config без credentials, чисті assets і походження/ліцензії.

Відомий secret-bearing server/telegram-bot.ts треба санітизувати зі збереженням логіки; його просте вилучення не дає придатного Telegram/build snapshot. Нові sanitized bytes отримають власний hash, посилання на початковий HEAD і redaction manifest. Перелік консервативно виключених data/example файлів є в evidence; не кожний із них доведено містить PII.

У Work продуктового checkout/source bytes немає. Шлях/HEAD на Mac не спостерігалися. Передавання пакета не означає автоматичний запуск Codex. До точного каналу/копії не виконується імпорт у GitHub.

**Приймання P0-R:** source bytes/manifest і startup isolation, serving/source relationship, live DB binding, bot/runtime relationship, повний або явно обмежений legacy inventory та ізольована відтворюваність. Кожен незнятий must зберігає blocker→owner→next probe. Остаточний repair/replace залежить від цієї перевірки.

## 8. Підготовлений P1: допуск безплатних джерел і адрес

**Статус:** план готовий; actual P1 fetch/certification, 48-годинний моніторинг і допуск не запускалися. Залежність P0→P1 з погодженого blueprint збережена. Наступний продуктовий етап не починається під виглядом цього аудиту.

**Мета:** для кожного operator×territory×capability довести окремо актуальність графіка і точність адресної прив’язки. Мінімум — чотири початкові міста плюс підтверджений P0 legacy. Усі інші ОСР — кандидати з паспорта, доки нове дослідження не встановить фактичний обсяг.

| Початковий scope | Lead із паспорта, потребує нової перевірки | Окремий предметний ризик |
| --- | --- | --- |
| Київ, місто | ДТЕК КЕМ; YASNO як технічний кандидат | Перевірити чинну адресну модель; стара черга лише історія; Київська область — інший namespace |
| Вінниця | Сервіс Вінницяобленерго | Дата, актуальний адресний маршрут, перейменування; community JSON не дорівнює незалежному доказу |
| Одеса | ДТЕК Одеські електромережі | Адресні винятки, кілька вводів, літери/корпуси, фактична географія |
| Харків | Харківобленерго: чинний план і адресні списки | Власний ОСР і харківський scope; київський feed непридатний як доказ Харкова |

Публікації й URL із паспорта — leads, а не новий висновок про їхню актуальність сьогодні. До жодного регіону не записано active/address_verified чи дозвіл на push.

**Вхід:** закритий або явно scoped P0; source snapshots/hashes; погоджені D-01–D-03. **Власник shared registry:** директор; дослідники можуть повертати окремі результати по ОСР. App/ChatBot implementation handoff створюються після спільних контрактів P2, не зараз.

**Реєстр P1 міститиме:**

- operator ID/назву, територію/КАТОТТГ, namespace і capability;
- primary/fallback, upstream chain і незалежність контрольного джерела;
- метод/формат/auth, schema revision, права повторного використання й дозволені ліміти;
- доказ нульової вартості основного й резервного доступу;
- service_date, Europe/Kyiv, published_at/observed_at, freshness і точний semantic state;
- address ID/aliases/точний будинок/підключення, binding revision, effective interval і provenance;
- raw fixture hash, canonical intervals, adapter fingerprint, results контрольної звірки;
- status catalog/schedule_verified/address_verified/integration_accepted, owner, stop reason, next probe.

**Приймання:** початкова вибірка 20 різних репрезентативних адрес/ОСР або вичерпний менший набір вузького scope; щонайменше 48 годин спостереженої паралельної звірки. Час без доказів ревізій не є допуском. Потрібні стара/нова назва, сусідні будинки з різними планами, `12`, `12А`, `12/1`, `12-1`, `12 корпус 1` як окремі кандидати, кілька вводів, upstream-ID change, missing/unknown/error/empty feed, stale HTTP 200, conflict, midnight/24:00/DST, півгодини, A→B→A і scoped emergency. Вікна заживлення не інвертуються без доказу повного покриття доби.

При stale/conflict/unknown персональні pushes не допускаються; графік має чесний датований статус. Ручний вибір черги не перетворюється на address_verified. Перший ОСР для P2 обирається за пройденим допуском і відтворюваністю; назва міста не визначає його наперед.

**Вихід P1:** dated source registry, fixtures/golden set, coverage verdict по кожній можливості, журнал 48 годин, блокери/owner/probe і один доказово готовий кандидат на P2. Один ОСР не закриває весь цільовий legacy-обсяг.

## 9. Готовий текст продовження у цьому Work-проєкті

> Продовжуй LIGHT BOT APP, LBA-P0-001, з цього звіту, checkpoint і паспорта v1.0. Read-only P0-аудит отримано; початковий timeout узгоджено, останній phase Replit paused. Не повторюй увесь аудит. Звір актуальні refs із зафіксованими SHA. Робочий Replit source main@45d77e22e68816e5695aa4b7d2a62bfc57e8176d, subset manifest142 з hash0fcef7b6d415ee61ba4f4c89074ca9b0f54e4759e7511a7c9b3677bd573db704; GitHub agent branch f19cf19c2dad177cc059157b9ded4443637ebefc містить агента, не продукт. Наступний read-only крок P0-R: знайти authoritative serving provenance і deployment→DB mapping; build logs9f7e9359-5129-4dea-a595-25f6b1db9d1e вже порожні. Підготуй безпечний source-only snapshot/ізоляцію до огляду, не змінюй production, не запускай старий сервер/seed/reconcile/scheduler/webhook/send/export. Source findings підтверджені Replit Agent, але serving applicability не доведена. Поверни evidence або конкретний blocker на кожний must. P1 має готовий план; фактичний допуск і подальша реалізація потребують застосовного scope.

Для Codex після отримання snapshot використовувати згаданий у паспорті LIGHT BOT APP [CODEX]; його фактична прив’язка і локальна папка ще не перевірені. Спочатку перевірити pwd/origin/branch/HEAD/status; очікувана гілка агента й SHA наведені вище. Локальні зміни зберегти. Невідомий шлях на Mac не вигадувати. Пакет додати лише до чинного проєкту; факт отримання/запуску підтверджувати окремо.

**Return contract:** task/project ID, scope, actual actor/host, repo/branch/full SHA, source/deployed hashes, input/output manifest, methods/results, privacy-safe evidence, unresolved effects, verdict кожного P0 must, next action/stop/return_to=LIGHT BOT APP [WORK].

## 10. Приймання, незалежність і межі

| Вісь | Результат цього виконання |
| --- | --- |
| Specification/context | Паспорт відновлено; byte/hash lineage звірено |
| Source code | Remote static review поточного workspace; source bytes тут відсутні, full subset manifest отримано й digest повторено |
| Integration/runtime | Схема/managed DB aggregates і Telegram GET отримані; serving bindings та end-to-end не доведені |
| Build/tests | Product build/typecheck/unit/integration/E2E/server startup не виконувалися |
| Devices | Не перевірено |
| Independent review | Окремий reviewer перевірив checklist і межі висновків; не QA продукту |
| Human acceptance | Результат ще не прийнятий власником |
| Released/observed | Реліз не виконувався; current publication metadata отримана |

Попередня рекомендація: зберігати сумісні UI/assets/профілі, замінювати недостовірні adapters і перебудовувати auth/delivery/startup за доведеними патернами. Остаточний repair/replace та стек визначаються після source-copy/isolated probe; Go, новий бот чи новий домен не обрані.

Нового продуктового рішення для вже дозволеного читання не потрібно. Writable реалізація й production effects не випливають із цього доручення. Конкретний наступний пакет — P0-R і підготовлений P1; нова загальна анкета не потрібна.

## 11. Походження та контрольні значення

Первинні спостереження: GitHub metadata/refs/recursive tree/files, Replit URL resolution/publish status; нові source/schema/aggregate/Telegram findings — звіт Replit Agent для конкретного workspace. Стислий результат, деталі, build-provenance probe і source subset manifest збережені окремо. Анонімне web open — лише обмеження каналу.

- Паспорт SHA-256: `3c8fdf19c232fc361f1b4f15e494f8b8fbeaec7f70efd82f3eaf825c2e274de1`.
- БРИФ SHA-256: `a24f33323c8e9144d37f9a9797dd0d61ba8c3f6a47189e29a28fa12fac9d9b7c`.
- Blueprint file SHA-256: `feb30b91c83e311aa1fb65dd6a3e1f676735ee88ca7e4ebdeb51821b4dc66b08`.
- Blueprint canonical SHA-256: `493a4a454ccc9784297d3448e73263177c0d61d8ccf32e58b53f34add13adcd5`.
- Depth SHA-256: `08db6a4edc868dcb85efec2b9113de12beb955e8e15a7e63424483f073a58db9`.

Супровідний пакет містить цей звіт, точні вхідні документи, privacy-safe evidence, task contract, checkpoint, dependency/status notes і SHA-256 manifest. Manifest контролює цілісність байтів, не доводить runtime, дозвіл або людське приймання.


## 12. Runtime та чому старий dev startup не запускався

За віддаленим аудитом: workspace Node 20.20.0, npm 10.8.2; .replit оголошує Node20/Python3.11/PostgreSQL16. package-lock v3, додатково uv.lock. Locked React19.2.3/Vite7.3.5/Express5.2.1/TypeScript5.6.3/pg8.18.0/Drizzle0.39.3/canvas3.2.1/Zustand5.0.11. Це lockfile, не підтверджені installed production versions.

| Порядок | Операція | Source |
| --- | --- | --- |
| 1 | DB Pool читає DATABASE_URL | server/db.ts:7–14 |
| 2 | setupAuth/registerAuthRoutes/registerRoutes | server/index.ts:77–79 |
| 3 | Початкові street fetch і async auto-seed IIFE | server/routes.ts:1229–1232,2678–2694 |
| 4 | Static/Vite, HTTP listen, startTelegramBot | server/index.ts:97–118 |
| 5 | loadSubscribers, reconcileSubscribersWithUserSettings, migrateAllBotSubscribersToLocations | server/telegram-bot.ts:4819–4822 |
| 6 | Лише після reconciliation — development return | server/telegram-bot.ts:4824–4826 |
| 7 | У production: setWebhook, metadata/menu, init hashes, scheduler30s | server/telegram-bot.ts:4837–4889 |

Auto-seed асинхронний; його завершення до listen/reconciliation не гарантоване. Dev запускається через tsx server/index.ts, build через tsx script/build.ts, production через node ./dist/index.cjs; build outputs dist/public і dist/index.cjs. Відсутність production credentials сама по собі не гарантує відсутності інших network effects. Запуск read-only DB credentials може лише спричинити помилки запису; це не доказ нешкідливого startup.

Тому product startup не виконувався. Read-only Telegram GET були окремим metadata-процесом, який не імпортує застосунок.
