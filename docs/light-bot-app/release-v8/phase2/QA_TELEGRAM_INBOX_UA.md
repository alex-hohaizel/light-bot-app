# Незалежний bounded review durable Telegram ingress

Reviewer `/root/v7_runtime_map`, не автор `telegram-inbox.ts`, HTTP consumer, runtime-policy або wiring. Ownership лише цей документ і приватний in-memory harness. Product source не редагувався; actual DB, HTTP listeners, provider/network, production та секрети reviewer не використовував.

**Verdict:** у перевірених source/control/handler vectors concrete unresolved defects не залишилося. HTTP receipt validation finding addressed на final source. Це не приймання всіх68 вимог, identity/profile worker, sender, actual webhook або live activation.

## Exact reviewed pins

| Source | SHA256 |
|---|---|
| `app/server/production/telegram-inbox.ts` | `bef089341282b676a3c76236249fd5b85cd63bfedad93a179a34f4d2af09cc5d` |
| `app/server/production/telegram-inbox-http.ts` | `f21bbf5006ebe3beef2e02ab50fd33924c01ad28fc7c7fbfa80793e3bec687f9` |
| `app/server/runtime-policy.ts` | `39b08685270f0aa938e075e731a1c5fec2e34f322a14b0c925ac2cb4b9eaa07f` |
| `app/server/routes.ts` | `7a4fb8722152e018979b6d42167a39c20aa9167aac2d3fb6a46a5772386c4c43` |
| `app/server/index.ts` | `ee4c69f65b9ebab3bfdebe040e0d4a8c1cd5e034b1680d1e9201ffe25019bd9b` |
| `app/server/production/product-identity.ts` | `5e2499b9174f309458545424d0e7f32fe7e9f74af01eccb8887b629526bdf5bf` |
| own private HTTP driver | `3b8ab844823ec8798d9b7e6e580c4ac123409b6e165c6dfd9a5a387b4b5341f9` |
| own addressed result | `919e48f529e3d6df9a48243fd8c462c4bdf90920dbee81d729b2ed64ab19ad82` |

Own artifacts: `phase2/private/telegram-inbox-http-review.mjs` та `telegram-inbox-http-review-addressed.json`. SourceBefore/After збігаються, drift0. Scoped strict TypeScript core+consumer незалежно PASS.

## Перевірений source flow

Index `express.json.verify` зберігає Buffer у `req.rawBody`; handler передає саме цей value в `accept`, а не parsed `req.body`. Parsed update_id застосовується тільки для correlation returned receipt з уже parsed JSON request. Він не підміняє raw native admission: actual inbox відхиляє missing raw bytes, duplicate JSON keys, malformed UTF-8/shape/oversize до own pool. Core header validation/hash timingSafeEqual передує native parsing/clock/inbox pool access. Перевірка «до DB» у власному harness стосується саме inbox pool; весь startup/session middleware graph або HTTP socket ця in-memory перевірка не виконує.

Прочитано bounded native normalization: explicit private human actor/chat equality, callback sender fixed product bot ID, opaque callback1…64 UTF-8 bytes; native facts не стають application owner principal. Unsupported events durable ignored з private_input NULL. Немає username/prefix identity inference чи domain/profile call на ingress. Canonical native hash — semantic parsed JSON hash, а не raw whitespace hash; duplicate keys відхиляються до такого зведення.

DDL explicit additive, не виконується constructor/import, UNIQUE(bot_id,update_id). Actual SQL sequence READ COMMITTED → control FOR SHARE/canonical/exact epoch → per-update advisory lock → exact receipt/hash/private normalized input check → INSERT-on-conflict/readback → COMMIT/release. Fresh statement snapshot після очікування lock потрібен для recovery. Changed payload, corrupt stored private input і old-epoch duplicate fail-closed; row не перепризначається. Unknown COMMIT/release дає ack:false; exact retry/recovery використовують той самий update ID. Receipt reconstruction не виносить native user/chat/text/private hash.

Root routes зареєстрували новий consumer замість старого webhook handler; пошук `telegram-webhook|handleTelegramUpdate|processTelegramUpdate|handleUpdate` у routes/consumer не знайшов old-handler fallback. Handler завершує всі branches без `next` до legacy bot. Presence старих функцій в іншому модулі не є ingress викликом. Product identity фіксована public botId/username; runtime token prefix та callback botId мусять відповідати їй.

Runtime defaults telegramUpdatesEnabled false; увімкнення вимагає explicit switch, matching configured product token, delivery switch і positive safe canonicalControlEpoch. Root wiring передає цей epoch у HTTP port та inbox factory. Відсутній schema/control або wrong mode/epoch не є дозволом створити/прийняти update. Constructor/readiness не seed-ять control і не змінюють webhook. Чинна productProfileMode allowlist лишається disabled/read_only, цей ingress не активує canonical profile writer автоматично.

## Historical finding I-HTTP-01 і repair

На прочитаному historical HTTP source `81e745b2bf22a39715f401f53eb03f120e4a7b7f9ce41cac8d8edd46f3c97936` ACK gate перевіряв тільки status/ack та version/phase/botId receipt. Code-level injected malformed receipt без updateId/disposition/reason/epoch/time проходив би200. Root отримав concrete code-path finding до власного repair; reviewer не змінював source. Це не був public parsed-body bypass actual core: core сам перевіряв свої receipts, але consumer не захищав runtime contract failure.

Root final `f21bbf50…` вимагає closed8 fields, known version/phase/fixed bot, safe positive native updateId, exact expectedControlEpoch, valid timestamp і accepted/null-reason або ignored/known-reason. Окремо перевірено receipt updateId correlation з req.body.update_id. Missing/unknown fields, invalid/different update, zero/string/different epoch, bad disposition/reason/time тепер503; некоректний backend result не стає ACK.

Перша спроба власного harness уже прочитала **новий** frozen consumer, але мала старий config без newly-required expectedControlEpoch. Результат1PASS/11 configuration errors збережено в `telegram-inbox-http-review-initial.json`; це **помилка harness/oracle, не11 product failures** і не runtime proof historical finding. Harness оновлено до required port/consistent parsed update ID; старий результат не перезаписано.

## Власні14/14 addressed probes PASS

1. Disabled route не конструює inbox/pool.
2. Forward exact raw Buffer identity і secret; parsed body не є payload source.
3. Actual inbox bad secret →403 до clock/pool, навіть із malformed bytes.
4. Missing rawBody із valid parsed body →400, no fallback/storage.
5. Actual inbox над inert query port не дає HTTP ACK до завершення COMMIT gate.
6. Saved/not-saved ambiguous commit →503; exact retry →200, один durable input.
7. Durable ignored update →200/{ok:true}, private_input NULL.
8. Consumer/storage exception →503 без private details.
9. Missing receipt fields →503.
10. Invalid native update ID →503.
11. Zero epoch →503.
12. Invalid disposition/reason/receivedAt →503.
13. Different valid update ID →503.
14. Different positive/string epoch або extra private field →503.

Власний driver використовує зареєстрований handler без Express listener та actual frozen inbox із independent inert query port. Це не actual PostgreSQL, native Telegram delivery або повний middleware HTTP test. Немає domain command/profile/worker/send side effects. Public response тільки `{ok:true}` або non2xx; ingress_committed не означає command виконано/повідомлення доставлено.

## Раніше виконані авторські докази, прийняті як окреме джерело

Прочитано `TELEGRAM_INBOX_UA.md`, авторські16/16 unit groups та actual `telegram-inbox-pg.json` SHA `cfaf9851a9074a69fc4599d54b84dd78e56a1aa268af5befa862aa053f94eb33`. Proof actor — інший agent `/root/v7_local_tools`:12/12 actual disposable PostgreSQL groups, drift0, clusterStopped:true; actualHttp:false/provider0/productionWrites0. Є explicit A-accept/B-advisory-wait recovery та RR negative control, concurrent receivers/restart, held actual COMMIT, saved/not-saved uncertainty, rollback/private corruption, epoch fence та відсутність canonical profile/domain/outbox writes. Reviewer цього документа **не запускав** цей cluster і не видає прочитаний author evidence за власний actual DB probe.

## Межі та exact next action

Інший незалежний reviewer `/root/ux_a_independent_qa` окремо володіє actual HTTP+PG harness і `QA_TELEGRAM_INBOX_HTTP_UA.md`; його результат слід читати окремо. Root поєднує exact frozen source/build, цей bounded review і actual HTTP/PG proof. Before activation залишаються actual target/control/schema, legacy-writer fence, pending-epoch drain/rollback, trusted identity mapping/domain worker, callback UX answer, one-sender/policy-recheck/delivery acceptance. Ніякого webhook/send/production права чи claim виконання всіх68 цей review не створює.
