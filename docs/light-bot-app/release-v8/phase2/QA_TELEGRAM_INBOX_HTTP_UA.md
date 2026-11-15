# Незалежний actual HTTP + PostgreSQL proof Telegram ingress

**Bounded verdict: 6/6 PASS, sourceDrift=false; concrete defects у перевірених vectors не залишилося.** Reviewer `/root/ux_a_independent_qa` не автор inbox/HTTP consumer/routes. Власна реалізація — тільки тестовий driver і цей evidence/report. Production, зовнішні API, реальні secrets/chats або deployment не використовувалися.

## Реальне виконання

`node --experimental-strip-types tools/lba_v8_telegram_inbox_http_pg.mjs` виконав actual Express listener на випадковому loopback port та actual fresh PostgreSQL `lba_test_inbox_http`,127.0.0.1:55441. Дозволене escalation потрібне для власного локального cluster; запуск завершився exit0. Helper не читає DATABASE_URL/PG credentials: генерує власні credentials у пам’яті, перевіряє target і чекає завершення cluster stop. HTTP server також закрито.

Схема містила **лише** `lba_production_control` та `lba_production_telegram_inbox`; profile/domain/outbox/legacy tables не створювались. Control epoch7/canonical задано явно власним fixture. Secret — власний випадковий інертний literal, не product credential. Payloads synthetic. Fixed public botID8577497098 задає factory; це не getMe/token verification.

Express `express.json.verify` зберігав raw Buffer до parsing; actual consumer отримував цей Buffer. Усі HTTP requests обмежені origin власного loopback listener. Native Telegram/webhook registration, provider requests і production writes — **0**.

## Шість груп із фактичними негативними controls

| Група | Спостережений результат |
|---|---|
| Secret / duplicate raw keys | Wrong secret→403; valid JSON із duplicate update_id keys→400. Inbox pool connections0, SQL rows0; parsed body не обійшов raw admission. |
| ACK / transaction boundary | Client зупинено перед actual COMMIT. HTTP response ще не завершився, інше PG connection бачило0 rows, commits0. Після release actual COMMIT→200 `{ok:true}`, row1/commit1. |
| Race / duplicate / restart factory | Два concurrent HTTP duplicates→200/200; один SQL row. Новий inbox factory над тією самою PG→200 і той самий один row. Native input ID стабільний `tg:8577497098:1201`; application owner не вигадано. |
| Unknown saved COMMIT | Actual COMMIT відбувся, wrapper втратив його відповідь→503, durable row уже1. Exact provider retry через новий factory→200, rows1. Той самий update ID зі зміненим payload→503, rows1. |
| Disabled / control / epoch | Disabled HTTP route, disabled inbox, disabled/legacy/missing control і wrong epoch8 проти expected7 — усі503, additional rows0. Disabled route навіть не викликав factory; disabled inbox не відкрив pool. |
| Native callback / ignored / privacy | Callback human actor≠private chat та wrong sender bot→400/400 до inbox DB connection. Valid callback→200 і minimized native input; unsupported channel update→200 тільки після durable ignored row з private_input NULL. Відкинуто display name/username/old-card text; public response не містить native facts або secret. |

ACK тут означає **durable ingress**, не виконану команду, прив’язаний application profile чи доставлене повідомлення. «Foreign callback» у цьому proof — native actor/chat mismatch; ownership/expiry opaque domain callback ID мусить перевірити наступний domain worker.

## Контракт consumer та композиція доказів

Прочитано frozen HTTP source: потрібні closed8 receipt fields, ingress version/phase, fixed botID, safe positive updateId, exact expectedControlEpoch, valid receivedAt та accepted/null або ignored/known reason. `req.body.update_id` мусить точно корелювати з durable receipt. Own actual valid receipts пройшли цей gate; malformed-return matrix — окремий peer proof, а не вигаданий результат actual PG.

`QA_TELEGRAM_INBOX_UA.md` іншого незалежного reviewer `/root/v7_runtime_map` містить14/14 in-memory addressed cases, включно з missing/extra/false receipt fields, wrong update correlation/epoch, missing raw bytes та error redaction. Його initial1PASS/11 configuration errors — outdated harness без newly-required epoch, не product failures; історія збережена. Source поля peer addressed receipt збігаються з цим frozen core/HTTP consumer.

Root routes передає той самий policy epoch в HTTP port і lazy inbox factory, зберігає fixed identity; старий bot handler не є fallback цього consumer. Цей proof не запускав повний index/session/startup graph. Попередні actual core PG12 і App HTTP/PG9 мають окремих actors, drivers та limits і не додаються до власних шести груп.

## Exact pins

| Source / evidence | SHA256 |
|---|---|
| production/telegram-inbox.ts | `bef089341282b676a3c76236249fd5b85cd63bfedad93a179a34f4d2af09cc5d` |
| production/telegram-inbox-http.ts | `f21bbf5006ebe3beef2e02ab50fd33924c01ad28fc7c7fbfa80793e3bec687f9` |
| production/product-identity.ts | `5e2499b9174f309458545424d0e7f32fe7e9f74af01eccb8887b629526bdf5bf` |
| routes.ts | `7a4fb8722152e018979b6d42167a39c20aa9167aac2d3fb6a46a5772386c4c43` |
| tools/local-runtime/disposable-proof-db.mjs | `8785a5b6e84f27b2c6ed47e7bf635d60addf37a9916ed89d522d30d43da1cc56` |
| Own tools/lba_v8_telegram_inbox_http_pg.mjs | `5e3e598bc67fbb4ed0e63223883fd62f5464a1037784c42d2a8df95fd5d05408` |
| Own phase2/telegram-inbox-http-pg.json | `a8629d9ed5d9c29c1cdd34a077096fb504400a9b529aea710cbeff89c8322900` |
| Own control DDL string | `d9d3cb7069eb59a548ee7a4c40f2951a5909a2a40032393525148c0e26e116f7` |

Receipt зберігає sourceBefore/sourceAfter та driver hash; всі збігаються. У власному actual run failed attempts не було. Тестовий cluster зупинено після suite; product source не змінено.

## Межі й передача

Restart тут — **новий factory в тому самому Node process**, не OS/container restart. Тест не перевіряв реальні HTTPS/proxy/timeouts/provider retries, deployed schema/control/webhook identity, process kill, epoch drain/rollback або інфраструктурну доступність. Unknown not-saved commit/RC recovery race — окремі core proofs; власний HTTP case моделював саме saved commit.

Перед активацією лишаються existing target/cutover gates: trusted per-account identity mapping, actual domain worker/CAS, stale/wrong-owner callback rejection, callback answer UX, one-sender/current-consent/binding checks, outbox delivery та rollback. SQL ACK не дає права на будь-яку наступну зовнішню дію. Production release/campaign, повний функціонал і всі 68 must цим bounded PASS не прийняті. Root може поєднати ці exact pins з рештою незалежних доказів; broad rerun без source drift або нового finding не потрібний.
