# Незалежна перевірка campaign worker

Висновок: **PASS_COMPONENT_ONLY**, 50/50 незалежних сценаріїв після виправлення відтвореного дефекту MIME. Це приймання вузького локального компонента, а не всього продукту чи production результату.

На початковому `release-campaign.ts` SHA-256 `71ec626de0da0e73df35d4c863ab111c2b20b94886cc68bb9529cc221ede4a5c` реальна відповідь власного HTTPS із `Content-Type: application/jsonx` помилково ставала `healthy` через `startsWith('application/json')`. Автор виправив точний media type. На новому SHA `82ef3074267742547fe1e0b1a4eb17442dccbfea3f37e9d786d0b9d065651c42` незалежно спостережено відмову observer і worker до SQL prepare/native, а також позитивний `APPLICATION/JSON ; charset=UTF-8`. Дефект закритий на нових байтах; старі докази залишені історичними, не переприв’язані.

Власний driver `tools/lba_v8_campaign_worker_peer.mjs` SHA `703c483edd3578589e0f058f6c28c1c09f80a1b18b461ad9203ab171ed55f2c6` дав фінальні 50 PASS / 0 FAIL, exit0. Це окремий driver і окремі fixtures, не повтор авторського звіту. `peer-review.json` містить усі чотири raw attempts; у першому також залишено виправлені згодом помилки очікувань самого тесту щодо API `begin` і tick завершення. В останньому run помилок тестового API немає.

Команда: `app/node_modules/.bin/tsx --tsconfig app/tsconfig.json tools/lba_v8_campaign_worker_peer.mjs`. Фактичне середовище — Node24.22.2, PostgreSQL16.15, база `lba_test_camp_notice_peer` тільки `127.0.0.1:55497`; 100 власних TLS-запитів на HTTPS55499. Відповідність Replit/Node20 цим тестом не заявляється.

Спостережено на справжній локальній PostgreSQL16 та HTTPS із перевіркою власного сертифіката:

- constructor/disabled configuration не створює IO;
- status/redirect/URL/body/build/ref/bot/mode/staleness/oversize/timeouts/abort health відхиляються;
- worker споживає негативну HTTPS-відповідь до SQL prepare/native; жодна transaction не утримується під час обох health observations;
- canonical та окремі legacy підписки заморожуються без вигаданих owners; opt-out і неоднозначні записи виключаються, pilot потребує обох позитивних квитанцій до full;
- два незалежні workers не дублюють підготовку/надсилання; restart не повторює завершені повідомлення;
- звичайна відповідь перед campaign зберігає порядок і не скасовує живий pending campaign; terminal outer cancelled/failed очищається без блокування наступної відповіді;
- actual `pg_terminate_backend` після native intent у campaign блокує profile іншого chat, і навпаки; жодного нового native виклику до reconciliation;
- unknown, 429/cooldown, 403, global advisory lock, operator pause, expiry і відкликання згоди обробляються без переходу до недозволеної full розсилки;
- stop під час HTTPS та getMe не допускає подальший send;
- правильний configuredBotId у health не замінює native getMe: неправильний фактично повернутий botId блокує send;
- справжній canonical runtime інертний до prepare/start, виконує optional campaign і припиняє роботу після stop/drain;
- звичайний profile dispatcher працює без optional campaign tables.

Підміна public URL лише направляє запит на власний HTTPS `127.0.0.1:55499`; вона явно позначена в доказі. Telegram native transport синтетичний. Ці тести не доводять фактичний public domain, Telegram, Replit deployment UUID чи доставку живим користувачам. `deploymentRef` — логічний `lba-release:...`, а native provider UUID має окремо звірити root. Всі 68 вимог, device/source/product gates та приймання власника зберігаються.

Source before/after усіх дев’яти залежностей у raw receipt збігається. Власні PostgreSQL55497 і HTTPS55499 завершені; `lsof` не знайшов listeners. Production writes, provider requests, real messages і доступ до secrets: **0**.

Root може використовувати це як незалежний доказ компонента для PROFILE-06/PROFILE-07/TECH-06, зберігаючи окремо їх повне продуктове приймання. Наступна дія: включити саме `82ef307/c326643/898adbb/8c8a1aa` у новий exact-source build, звірити фактичні public health та native provider identity за чинним release-планом. Реальні pilot/full counts і Telegram receipts мають виникнути тільки з фактичного дозволеного виконання. Цей висновок не створює нового approval flow і не скасовує чинного права власника на випуск.

Застосовано engineering-профіль Agent System6; фактично прочитані production-quality SHA `7ebe6f7fb8834de7741f328d48cf5fb44d7e4b8344b73cd10e97b051b8815d41`, context-capsule `c5e0a797f6e95392199c91e364483467b4a6bcfd2d96a1a0363a405c9217b9ba`, tool-compatibility `98a5e7de2ec46f4a26ec62179f79c87a48dd3ffcc67d400ab1b88f9f9600b3fe`, production-profiles `a1db1ea55bb6f5a3f9d02ef314623e5a9ddb2eab4468733107a07df0b137fed9`.
