# Поточне незалежне рішення про випуск

**Зараз NO GO для повного production cutover.** Чинний дозвіл власника на випуск і кампанію збережено; повторна загальна згода не потрібна. Причина рішення — конкретні непідтверджені передумови, а не відсутність права продовжувати роботу. Усі 68 must залишаються обов’язковими.

Це адресна перевірка поточного стану, не повтор Work P0 чи установки. Reviewer не змінював продукт, вимоги, production, webhook або одержувачів і не читав приватні чати чи production backup rows.

## Що фактично прийнято в межах доказів

Перевірено цілісність актуальних незалежних квитанцій: Widget account-link — 13 PASS і 24 поточні pins без drift; recipient adapter після виправлення точності — 16 PASS; спільний campaign coordinator після NULL-chat ремонту — 14 PASS і 15 поточних pins без drift. Це реальні локальні PostgreSQL/Passport/HTTPS/Chrome або native-transport fixture перевірки, а не фактичні входи чи повідомлення Telegram.

Fresh-tail recovery — незалежні 6 PASS: native pg_dump/restore/psql, точний R1, відмінність застарілого R0 та повний rollback зіпсованого restore. Це доказ конкретної спожитої public schema й синтетичних sent/unknown records. Він не доводить live fencing чи реальну provider receipt. Звірку приватного backup 10 акаунтів/9 таблиць прийнято як обмежений факт root; приватні записи reviewer не переглядав.

Історичний morning peer proof 12 PASS лишається чинним для своїх bytes; його два sender/eligibility pins тепер відрізняються через recipient union. Потрібен короткий адресний повтор спільного consumer на фінальних bytes, а не новий весь аудит.

## Точні незакриті умови

| Вимоги | Чого бракує | Найменша наступна дія |
|---|---|---|
| DATA-02/03/05/06/08/09, ADDR-05/06 | Кваліфіковані актуальні primary/fallback, точні адресні прив’язки, 20 репрезентативних адрес/ОСР або справді вичерпний менший допустимий scope, **≥48 год фактичних спостережень**. | Завершити current-source admission для обов’язкової географії, потім спостережену звірку й доказове створення delivery certificates. Fixture clock, дзеркало або HTTP200 цього не замінюють. |
| ADDR-01…06, APP-03/04 | Публічні збережені captures і негативні fixtures не доводять живі каталоги/перейменування/вводи по всіх потрібних містах. | Тими самими App/Bot lookup/save/readback шляхами перевірити прийняті provider адреси, aliases, точні номери/вводи й same-target/day графік. |
| PROFILE-03, APP-04/05 | Exact-origin Widget повернув `Bot domain invalid`; реальні Telegram/Replit сесії та Mini App bridge на новому кандидатові не прийняті. | Використати вже запитаний `/setdomain` для чинного бота, перевірити iframe, потім реальний signed callback/secure cookie та same-owner profile на перевіреному HTTPS staging. Новий бот чи named Mini App для browser Widget не потрібні. |
| LANG-05, APP-06/07, CHART-09 | Немає фактичних Android/iOS Telegram/device consumer доказів. | На точному кандидатові перевірити день/ніч, safe area/Back, довгі назви, відновлення живлення/ETA, weak network, reduced motion і читабельність карток/повного тексту. Чинний напрям і тон не відкривати для нового загального голосування. |
| APP-08, PROFILE-03/06 | Старий inventory/disposition не є автоматичним verdict для нинішніх replacement/fence routes. | Лише зачеплені legacy start/callback/share, local-only, PWA/Capacitor/push входи отримують current keep/rebuild/repair verdict. Наявність старого source file не прирівнюється до працездатної функції. |
| TECH-01/05/06 | Нова локальна збірка після VN quarantine має незалежно звірені 278 sources/14 assets; actual Node20 Replit compile/byte readback ще pending. Старий transfer ba342/e95 є історичним. | Зберегти current freeze, передати лише exact sanitized candidate у приватну codex-гілку й ізольований Replit staging; звірити bytes і actual Node20 compile без app start/DB/jobs/production/send. |
| PROFILE-01/02/04/05, TECH-03/08, BOT-06/07 | Немає свіжого live tail і доведеного припинення старих некооперативних writers/senders. | У конкретному вікні отримати актуальний R1, звірити поточний denominator усіх акаунтів/винятків, fence старі процеси, зберегти pending/unknown/receipt/revocation стан і ввімкнути одного канонічного consumer/sender. Serving SHA/DB/bot/menu/TLS перевірити під час дозволеного deployment smoke. |
| PROFILE-06/07, TECH-08 | Нові recipient/coordinator fixtures не створили реальну audience чи enrollment. Старі 9/8/1 counts не дорівнюють нинішнім eligible адресатам. | Звірити актуальні підписки, підготувати дозволений NULL-owner endpoint без вигаданого акаунта, зафіксувати release×recipient audience; після здорового exact deploy — контрольний eligible subscriber, receipt, решта eligible з причинами skip/defer/unknown. Новий test username не запитувати. |

DATA-04 зберігає обов’язок актуальної диспозиції підтверджених нових територій, зокрема DNE/CEK/MK. Цей review не повторює національний аудит і не оголошує кандидатні джерела operational. TECH-09 залишається обов’язковим: instrumentation/runbook/owner готуються до активації, фактичні production metrics спостерігаються після неї; неіснуючий background job не зараховується.

## Нова конкретна знахідка Вінниці

Локальні bytes та Git blob hash поточного опублікованого parser перевірено: `44ddfdf75828b98b1ab36602080084994cfe0af9`, SHA-256 `45037fa228986f8e2362f483141ec29a467cd0c913db427849e3e4c024773e61`. Він читає сторонній BezSvitla, заповнює відсутні/невдалі slots значенням `yes` та записує безумовний `ok`. README про operator origin не є нинішнім первинним доказом. Незмінність 576 mirror cells не перевіряє official plan.

Це доводить provenance/decoder ризик, **не доводить, що конкретні сьогоднішні інтервали фактично хибні**. Точне віддалене виконання, яке створило історичний JSON, незалежно не атестоване. Вузький quarantine repair уже реалізовано: source policy `fa0525aae9dd13195eb64d922e22609a8f675836ada0eedc89f1b9d48edbec62`, незалежні 6 PG і 32 scoped unit перевірки пройшли. Це чесно прибирає непідтверджений план із technical display; official source/address/fallback/48h admission не створює. Після цієї зміни фінальна локальна збірка пройшла: source SHA-256 `71a9ed65edc29987f812afa4bdb78966fd6c0fee0ac50c4e16a4150689197e55`, 278 source і 14 assets. Reviewer незалежно перерахував кожний hash та fingerprint; sourceBefore == sourceAfter. Target Node20, build runtime Node24; app/DB/deploy не запускалися. Root підтвердив 311/311 backend, TypeScript exit0 та 7 consumer PASS на нинішніх sender/quarantine bytes. Ізольований фактичний Replit Node20 compile/readback ще pending.

## Межі рішення й продовження

Погоджені «Адресний пульт» + «Спільна доба», м’яка нейтральна ніч, анімації та спокійна українська на «ви» без emoji у важливих повідомленнях зберігаються. GOV-06 не відкривається лише через застаріле metadata: точний первинний текст відновлено, text SHA-256 `b1c3c454026e671792650b528181797c001df5211663bfc65a2a00feea158a9a`.

Не всі 68 можуть мати вже спостережений post-release результат до першого publish: serving smoke, дозволена кампанія та P6 metrics мають свою послідовність. Однак їхня майбутня природа не знімає наявних data/auth/device/fresh-cutover передумов. Повідомлення власника про можливу нестабільність не є відмовою від must.

**Exact next action:** завершити дозволені exact private-candidate transfer та ізольований Replit Node20 compile/readback без app start/DB/jobs/production. Зберігати VN quarantine й отримати чинний дозволений первинний канал/каталог; паралельно використати pending domain repair для реального provider/device staging. Довести primary/address admission і фактичну 48-годинну звірку; після цього зафіксувати final candidate/fresh fenced tail і виконати вже дозволений cutover → smoke → pilot → remaining campaign. Подальший загальний approval не вигадувати.

Машинний запис із конкретними IDs, evidence hashes і межами: `verdict.json`. Усі production effects цього reviewer — 0.
