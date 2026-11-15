# Canonical App API consumer — локальна реалізація

Active App API тепер безпосередньо викликає реальний canonical profile store: snapshot, closed App mutation і exact-input receipt recovery. Це concrete consumer наявного store, а не нова абстракція із фіктивною реалізацією. Disabled/read_only залишаються чинними production modes; root runtime-policy досі забороняє active до окремого cutover. Index/runtime-policy, actual DB, production/webhook/Telegram та секрети автор не змінював.

## Source pins

| Source | SHA256 |
|---|---|
| `app/server/production/product-routes.ts` | `185c79b2696e1740dcee0b6941d04bcccfa9223f3c2915b4d3244713b9fe2990` |
| `app/shared/live-product.ts` | `c47ff48741353f52ede9987f03220f907bc6048c0ba86cbab08c2363b0fe4655` |
| `app/tests/backend/live-product-routes.test.ts` | `3668132d7d0478f043e21be40e00a38eae2ce11a66c6ff5bdb7833770cc3867b` |
| consumed store | `9b4f216b11a6b1fc96e963f05046958534efe9dbc0c87391a8347b2222936373` |

## Root wiring

`registerLiveProductRoutes(app, {mode:'active',releaseId,authenticate,store})` вимагає конкретні `snapshot`, `commitProfileMutation`, `recoverReceipt` methods `ReturnType<typeof createProductionProfileStore>`. У root index це має бути фактичний store instance з injected pg pool, trusted context/registry ports, explicit enabled та expected control epoch. Реальний store повторно перевіряє DB writer_mode/epoch/owner lock на кожному виклику. Route не створює pool, не виконує schema/control seed і не активує середовище. Додавання `'active'` до типу route не змінює runtime-policy allowlist.

Чинні `mode:'disabled'|'read_only'` і `read(principal)` injection збережені. GET disabled не читає дані; read_only читає legacy projection без catalog/plans/write capability. POST mutation/recovery в обох modes повертає503 `LIVE_PROFILE_WRITER_NOT_READY`.

## Реальна поведінка API

- `GET /api/product/profile` у active викликає canonical `store.snapshot` та повертає explicit `LiveProfileSnapshot`. Лише після його завершеної transaction route ставить `profileMutations:true`; `tools:false` лишається видимим, бо canonical tools/effects ще не підключені.
- `POST /api/product/profile` приймає чинний closed `ProfileRequest` із id, expectedSessionId, expectedRevision та mutation. Parse виконується перед store; сам store повторно застосовує контракт/CAS. Повертаються canonical snapshot, projected committed receipt і replayed. Profile, owner, binding або додаткові поля не можна підкласти в body.
- `POST /api/product/profile/receipt` приймає **той самий exact ProfileRequest** і викликає `store.recoverReceipt(principal,{channel:'app',request})`. Committed response містить receipt/use_receipt; fresh ledger miss містить null/not_recorded/retry_same_request. Recovery не вимагає context і не запускає mutation/bootstrap.

Principal походить тільки з injected actual session/mobile authentication middleware (`req.user.claims.sub`). Усі query parameters відхиляються, unsafe/missing subject →401. Body не визначає identity. `Cache-Control:no-store` встановлюється до auth middleware, тому auth/error responses теж не кешуються. Root продовжує володіти фактичною signature/session/cookie/CSRF політикою; local fixture middleware не замінює її перевірку.

`LiveProfileReceipt` конструюється з production runtime/channel/app inputId/committed/session/revision/server timestamp validation. Його `simulationOnly:false` — новий явний public DTO із фактичного production receipt, а не cast isolated receipt. Public receipt не містить controlEpoch/outboxIds/private provenance. Explicit nested mappings профілю/адрес/binding/catalog/plans/source/intervals відсікають невідомі поля. Store result із synthetic runtime, чужим owner або некоректним clock не приймається. Немає object spread сирого store result/provenance до response.

Migration `needs_confirmation` зберігається для manual/unverified address bindings; їх technical display не сертифікує будинок або доставку. `ready` означає тільки доступний для редагування canonical profile/empty account. Відсутній `productAccepted:true`; plans можуть бути порожніми, tools вимкнені, а всі68 вимог і решта release gates залишаються чинними.

## Unknown outcome і безпечні помилки

`PRODUCTION_COMMIT_UNKNOWN` →503 з тим самим stable code, nextAction `recover_same_request`, retryWithSameRequestId true. Власник/UI має зберегти початковий id/payload/CAS і виконати recovery або exact retry. Не створювати новий ID і не вважати зміну відхиленою лише через timeout.

Semantic ID conflict/CAS/address/binding constraints →409; closed input errors →400; safe transaction retry →503/retry_same_request. Невідомі SQL/provider/private error details не потрапляють у JSON. Загальна503 не стверджує, що дані не могли змінитися; вона також вказує той самий request ID. Цей API не надсилає повідомлень і не позначає pending outbox доставленим.

## Перевірки

Авторські **13/13 groups PASS** у `live-product-routes.test.ts`. Route handlers виконуються in-memory без HTTP listener/network. Тести викликають **реальний `createProductionProfileStore`** через inert injected SQL port із canonical row/origin/ledger, а не підміняють mutation статичним success object. Перевірені snapshot→mutation→replay→receipt, 401/unsafe subjects, чужий authenticated owner, query/body owner spoofing, saved/not-saved ambiguous COMMIT, same-ID conflict/CAS, nested/private DTO projection, malformed/foreign/simulated result denial, safe error text, disabled/read_only write denial, empty editable readiness і constructor gate.

Разом із поточним runtime-policy suite **22/22 PASS** (13 API +9 policy); окремо source/tests scoped strict TypeScript PASS і повний `npm run check` PASS. Actual HTTP/cookie/auth signatures, actual PostgreSQL через route, deployment/cutover або production effects автор не перевіряв і не заявляє.

Canonical store окремо має actual independent QA на своєму exact pin: `phase2/QA_PROFILE_STORE_UA.md` та `profile-store-pg.json`. Ці докази підтверджують перевірені store vectors і не замінюють незалежний API consumer review.

## Exact next action

Root/незалежний reviewer перевіряє ці exact source pins і фактичний authenticated HTTP consumer зі scoped disposable PostgreSQL: same owner subject, foreign/body/query denial, mutation/CAS/replay, same-ID recovery після commit uncertainty, private response projection, read_only/disabled gates. Root окремо інтегрує store instance в index і UI pending-request recovery consumer; runtime activation залишається за ним після full old-writer fence/cutover/delivery acceptance. Глобальних чи додаткових production дозволів цей документ не створює.

## Адресний DTO repair після незалежного QA

Historical routes `7c46f107…`/tests `f57e4bd9…` пройшли початкові10 author groups, але незалежний reviewer відтворив4 failures серед13 vectors: false/undefined/0/empty recovery result помилково означав confirmed ledger miss; malformed known scalar slots могли пройти allowlist mapping і винести приватний object (label/paused/source.url), а string boolean/aliases/false binding status — хибну semantic shape. Це відтворювалося також через actual store над інертним SQL, тому origin lookup або typed interface не були достатнім DTO захистом.

Final185c79… використовує **тільки found===null** для not_recorded. Усі інші results мусять пройти receipt validation; malformed values→503. Перед public mapping додано runtime перевірку відомих primitive/object/array/enum/date/time/integer/policy slots профілю, адреси/house/aliases, binding, preferences, catalog, ScheduleView/source/intervals. Unknown keys відкидаються explicit projection; malformed known values не перетворюються і не повертаються. Optional policy false/null також не означає «відсутня». Author13 groups/scopedTS PASS; повний project npm run check PASS; сукупні mapping12/store24/reader12/API13 =61/61 PASS.

Незалежний reviewer повторив **власні13/13 addressed vectors PASS, sourceDrift0** на185c79…, додатково повторивauthorAPI13/scopedTS. Це bounded AW-D1/D2 addressed verdict, не приймання store/release/live. Root actual HTTP/PG7groups було виконано на попередніх830/7c46 pins; новий підготовлений9-group consumer proof слід читати окремо після виконання. API/schema/runtime-policy activation у цьому repair не змінена.
