# Незалежний review legacy Telegram links

**Bounded verdict: PASS для current explicit DB relationship mapping, RR read wrapper і canonical bootstrap handoff. Історичне криптографічне походження links та production cutover не прийняті.** Reviewer `/root/ux_a_independent_qa` не автор helper/reader/store/index. Мій раніше авторований `legacy-profile.ts` тут не отримує незалежного self-approval.

## Фактичні докази

- Незалежно виконано mapping12 + reader12: **24/24 PASS**. Це actual source functions із інертними SQL ports, без БД/мережі. Scoped strict TypeScript helper/tests — **PASS**, no emit.
- Прочитано helper, wrapper, actual reader SQL, store bootstrap, index consumer та `tools/lba_v8_app_writer_pg.mjs`. Root `app-writer-http-pg.json` **9/9 PASS**: actual own PostgreSQL127.0.0.1:55440, loopback HTTP/JWT. Source pins receipt збігаються з disk. Запуск належить root; reviewer його не виконував.
- Root actual vector: owner A має explicit Telegram link і NULL subscriber.user_id; bootstrap залишає цей NULL у legacy SQL, proof потрапляє лише в private origins, public HTTP snapshot не містить chatId/provenance. Foreign owner mapping відхиляється, convention-ID без link не створює subscription. Усі три profile legacy tables після App/Bot writes логічно незмінні.
- Actual root race: після першого SELECT links інший client змінює link owner. Поточний RR read повертає попередній coherent sourceDigest і NULL subscriber policy; новий read бачить зміну та вже не додає цей endpoint. Це MVCC snapshot consistency, **не row lock, який забороняє unlink**, і не доказ доставки після revocation.

## Перевірені інваріанти

| Межа | Спостережений результат |
|---|---|
| Wrong actor | Closed verified principal; malformed/extra/foreign fields відхиляються до pool. Exact users.id мусить існувати. Structural verified flag сам не автентифікує особу. Index передає principal з product auth. |
| Scope SQL | Власні Telegram link IDs і subscriber ownership IDs читаються parameterized owner predicates. Global aggregate обмежений union цих refs; немає export усіх чужих rows, username/email/token lookup або tg-prefix inference. |
| Duplicate / ambiguous / stale relation | Duplicate own chat/link PK, foreign/dangling provider relation, чужий subscriber чи суперечливий owner fail closed до policy DTO read. Немає «першого придатного» link. |
| NULL / same owner / absent endpoint | NULL ownership допускається тільки за explicit unique own relation; same-owner не перепризначається. Link без subscriber не створює subscription або false missing-mapping claim. Distinct own links зберігаються всі. |
| One transaction | Wrapper BEGIN RR READ ONLY → helper → reader на тому самому client → COMMIT/release. Canonical store використовує свій fenced RR client, а не окремий pool read. Default reader не отримав implicit mappings. |
| Privacy / errors | Helper SELECT повертає лише identifiers/counts; policy читається після ownership. Closed proof лишається private; raw driver errors стають stable safe codes. Public API projection перевірена окремо у `QA_APP_WRITER_UA.md`. |
| Mutation / failure | Helper не має INSERT/UPDATE/DELETE, DDL, provider або delivery path. Wrapper failure робить ROLLBACK/release; import без environment/DB інертний. Це не mutating cancel API. |
| Stable proof / policy | Mapping revision залежить від exact link/owner/accepted count proof/original subscriber owner; звичайна policy edit не видається за нову identity. Reader sourceDigest окремо враховує policy. Raw enabled/disabled/explicit0 збережено в reader provenance; конфлікт consent лишається issue, bootstrap issues не ігнорує. |
| Callback ownership | Store передає cloned principal і копіює returned mappings до наступних awaits: trusted callback не змінює owner або вже прийнятий origin proof. |

Read-only consumer у поточному index викликає `readOwnedLegacyProfile(pool,principal)`. Runtime policy далі допускає лише disabled/read_only; наявність canonical store або helper не активує writer. Нові sender/control зміни в інших частинах index/policy не отримують приймання цим review.

## Точна trust-межа

Helper доводить **чинне explicit відношення в first-party DB**, а не signed історію створення кожного link. HHTTP-01 у `QA_AUTH_HTTP_UA.md` встановив, що старий `/api/auth/link-telegram` міг записувати/reassign relation з body.chatId; production fence закриває це prospectively. Сам SELECT helper не розрізнить законний current row та історично неперевірений row однакової структури.

Реальні приватні rows reviewer не читав; доказів фактичного poisoning/compromise тут немає. Це не вимога blanket повторної верифікації всіх користувачів і не підстава втратити чинні профілі. Root зберігає current trusted first-party DB baseline; exact per-account continuity/adoption та known ambiguous rows належать чинному cutover gate. Будь-який фактичний ownership conflict — hold/manual resolution, без auto-merge, перепризначення або ввімкнення delivery.

Після bootstrap canonical profile не переімпортується на кожний read; старий source не є постійним grant на send. Effect sender має перевіряти current owner/session/control/consent/binding і revocation перед effect окремо. Process restart, actual schema adoption/production history, distributed old-writer fencing та revocation-to-delivery тут не доведені. Historical store PG proofs мають власні pins.

## Exact pins і передача

| Source / evidence | SHA256 |
|---|---|
| production/legacy-identity-links.ts | `49879626ee9673e4c7a392db48b4f97cb1ed7b98eaa4d83717b3febfe7a90b33` |
| tests/backend/legacy-identity-links.test.ts | `f9e43b786dae9b9eacfdcccc77e093cd28e3144eba1e30f378a620f5206b8ffd` |
| production/profile-reader.ts, незмінний | `bdcdcbba56733ad661b777cfdbc13572e38b76978a828779066725441210e664` |
| production/profile-store.ts, consumed integration | `9b4f216b11a6b1fc96e963f05046958534efe9dbc0c87391a8347b2222936373` |
| index.ts, лише mapping consumer readback | `ee4c69f65b9ebab3bfdebe040e0d4a8c1cd5e034b1680d1e9201ffe25019bd9b` |
| runtime-policy.ts, лише disabled/read_only gate readback | `39b08685270f0aa938e075e731a1c5fec2e34f322a14b0c925ac2cb4b9eaa07f` |
| tools/lba_v8_app_writer_pg.mjs, root driver | `aaa3e6a17cef71712cd0e25377cfa6ba0a7be9a4055c64df38f3dad0a490126b` |
| Root app-writer-http-pg.json | `ab2440b912ec2c2617115d1d2e2138ede18852a11fb66d43970477cc1feb929a` |

Нових concrete code defects у цьому bounded helper scope не залишилось. Передача root: зберегти explicit DB trust/adoption межу, same-client snapshot та no-private-response projection; не оголошувати закритими tools/native/production delivery/cutover або всі 68 must. Власних product edits, PG/HTTP/provider requests, real-chat/secret reads чи external effects — **0**.
