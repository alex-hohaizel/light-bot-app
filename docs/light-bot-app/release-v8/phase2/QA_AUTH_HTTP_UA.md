# Незалежний review Telegram auth HTTP / identity

**Вердикт: bounded auth HTTP/session/identity wiring PASS після адресних repairs. Повний release/identity migration та всі68 must не прийняті.** Reviewer `/root/ux_a_independent_qa` не авторував ці auth modules, routes, middleware або fence. Product edits, реальних secret/provider reads, власної PG чи HTTP/server requests не виконував.

## Фактичні докази й авторство

- Власні actual function/callback probes, **2026-11-08 18:17 UTC:16/16 PASS**, sourceDrift=false. Використано actual HTTP/session/flow/identity/fence functions, AST actual mobile/global-error functions; SQL/session/issuer ports інертні. Crypto JWT negative vectors — actual jsonwebtoken із власним тестовим key, не import environment credentials.
- Targeted strict TypeScript auth HTTP/identity/fence/mobile/policy — **PASS**, no emit, з `--types node,passport`. Початкова вузька команда лише з `--types node` не завантажила Passport Request augmentation й дала2 помилки isAuthenticated; повтор з фактичним host declaration context пройшов без product edits.
- Root `auth-http-pg.json`: **9/9 PASS**, independently source/evidence reviewed; actual own PostgreSQL127.0.0.1:55437, Passport/express-session/connect-pg-simple та loopback HTTP. Pins відповідають прочитаним поточним auth bytes. Це **авторський PG/HTTP запуск**, не мій і не production/пристрій.
- Root `auth-replay-pg.json`: repaired **7/7 PASS** на поточних guard/flow pins; на додачу root HTTP group8 виконує actual timestamptz Date expiry case. Це доповнює попередній `QA_AUTH_REPLAY_UA.md`, у якому PG був історичним на момент його review.

Private repro: `.local/light-bot-app/release-v8/qa-auth-http/probe.mjs`; result `result.json`. `node --experimental-strip-types .local/light-bot-app/release-v8/qa-auth-http/probe.mjs`. Runtime dependencies не роблять native fetch/DB під час reviewer suite.

## Що незалежно перевірено

| Межа | Спостережений результат |
|---|---|
| Mini / Widget / mobile Telegram proof | Три actual routes передають raw proof до одного flow; Mini→mini, Widget/mobile→login. JWT owner походить із flow, не body/query/sessionToken. |
| Replay flag disabled | Всі три proof paths503, flow0/session fallback0/read0/JWT0 навіть із наявною cookie. Старі proof handlers не монтуються як fallback. |
| Invalid proof у mobile за наявності cookie | 401, не переключається на session-only branch. |
| Session-only mobile | Fresh verified session працює; expired/unverified або invented body sessionToken→401, read/JWT0. Це дозволений existing-session exchange, не обхід Telegram proof. |
| Session adapter | Читає server sessionID/current verified owner; expired owner не вважається bound. Login чекає req.login та req.session.save і повертає regenerated server ID. |
| Bind/save/destroy failure | Actual flow+HTTP adapter із valid own Mini **та Widget/mobile proof**:401, req.user cleared, req.session=null, destroy1/clearCookie1, readUser0/JWT0. Cleanup failure не видається за підтверджене видалення зі storage. |
| Response/privacy | Proof errors generic401; session-only read/sign failure generic503. Auth middleware error через actual production global handler не повертає private marker і не логує raw message/stack. No-store встановлено. |
| Existing identity | SELECT exact provider/subject link повертає той самий owner, без INSERT/UPDATE/DELETE user/settings. First name/email/username не є merge key. |
| New / ambiguous identity | Новий user+link мають UUID й спільну transaction; dangling/convention/ambiguous records rollback, не overwrite/auto-adopt. |
| Actual refresh middleware | Truthy req.user недостатній; потрібна fresh verified session або повторно перевірений exact Bearer. Invalid header не fallback-иться на cookie. |
| JWT verifier | Scoped HS256 mobile token прийнято; HS384/wrong type/unsafe subject/old expiry/wrong issuer/audience/forged відхилено. Existing30s clock tolerance не видано за нову безстрокову valid session. |
| Production legacy fence | Link/unlink/auto/login tokens, notify/subscriber/sync, settings/locations, compare share/data та broadcast503 **до handler**. New proof/product/refresh paths не заблоковані цим fence. |

Root actual9 groups додатково перевірили real Passport cookie/PG session regeneration+binding, same-cookie retry/інший browser, Widget↔mobile common ledger, forged/expired proofs, exact existing link+retained preferences, new UUID/orphan convention hold, actual concurrent proof winner, failed durable bind destroy та expired/invented session-token exchange.

## Конкретні findings і їхня диспозиція

**HHTTP-01 — legacy identity reassignment.** Source review виявив `POST /api/auth/link-telegram` з довільним body.chatId: тільки isAuthenticated caller, потім migrate чужих settings і `addLinkedAccount`, який у storage робить ON CONFLICT UPDATE userId. Поруч unauthenticated detect-chat/subscriber/sync-address дозволяли приватний read/write за chatId. Root додав production fence перед legacy registerRoutes; final own fence probes не пропускають handler. **Старий handler не став безпечним сам по собі — він fenced, не прийнятий для повторного ввімкнення.**

**HHTTP-02 — expired-session refresh bypass.** Старий `isAuthenticatedMobileOrSession` приймав будь-який req.user, а `/api/auth/refresh-token` видавав JWT. Root змінив actual middleware: safe verified Bearer або authenticated fresh expires_at/sub. Власні expired/forged-user/header negatives тепер401.

**HHTTP-03 — неповний share fence.** Початково не закривалися `/api/compare/share` і `/api/compare/data/:id`. Root додав цю family; actual final middleware probes дали503 для обох без handler.

**HHTTP-04 — raw-error path.** Session-only mobile IIFE передавав readUser/sign errors через next до старого global err.message echo. Root змінив catch на generic503 та production global error handler на generic message/status-only log. Actual own injected private read/sign/auth errors не вийшли в response. Початкові findings — source review; final runtime probes виконані вже після root repairs, не приписані старим bytes.

Власний initial harness12PASS/3FAIL збережено в `probe-initial.mjs`/`result-initial.json`: два oracle predicates помилково вважали SELECT FOR UPDATE write, а AST compiler не прибирав export modifier. Виправлено тільки harness; це **не product defects**. Final16/16 містить також stronger valid mobile cleanup та actual JWT tests.

## Відкриті, але не приховані межі

Replay guard у source використовує existing mandatory `SESSION_SECRET`, а не per-request/random key; factory кешується на процес. Фактична однаковість secret/ledger між production workers і key rotation policy не доведені. Rotation поки старі signed proofs valid потребує fail-closed/keyring/migration стратегії. Значення secret reviewer не читав.

Identity resolver серіалізує provider subject advisory lock, locked exact join і unique provider/subject constraint. Root actual race тут використовує той самий proof; concurrent **різні valid proofs одного subject**, actual dangling FK/legacy exceptions і production identity continuity потребують свого targeted migration proof. Власні SQL ports не є PG lock proof.

HTTP proof використовує fresh synthetic schema й loopback cookie settings. Actual HTTPS/proxy/SameSite/browser/native/Mini client, provider identity, production session migration/retention/schema adoption і deployed artifact не прийняті. Cleanup storage error чесно unconfirmed; caller не має видавати success/JWT, навіть коли clearCookie вже викликано.

**Fence — підготовка, не feature parity.** Він навмисно закриває старі login-linking/public-share/data/settings paths. Legacy LoginPage/deep-link replacement та всі відповідні можливості мають бути завершені до повного production cutover; не можна назвати disabled old functions збереженим функціоналом. Цей PASS не дозволяє віддати користувачам неповний продукт або запускати campaign до verified deployment.

## Exact source / receipts основного проходу18:17 UTC

| Артефакт | SHA256 |
|---|---|
| telegram-auth-http.ts | `9bc006bce037cda2dbb41efeb5b3dfedb6a66c251615d46c92b9149aea9f72aa` |
| telegram-identity.ts | `ee5211f7099cd7c8c5a32882bccf85f4315bf49f318e913c212586cdfceec4b1` |
| auth-replay.ts | `2bec24f8d6f2aea1bb910d79956999680263757f1f9f7156d0186fc298b2fd0f` |
| telegram-auth-flow.ts | `17d0771f8aca1e81404beda8823576aefb343d4c21e0af47cf3bf4e056329f40` |
| telegram-init-data.ts | `693c6753f11277a5c8b4f23a41c3220d7629a822ac57ea46a2d1111ca8cca308` |
| legacy-route-fence.ts | `14898198e6ac377a9fe844997aa772fdfeaf5a84c1fef7f9bfc30ed17f8b5b68` |
| mobile-auth.ts | `c2105c0723a32cd26a22d98e4fdcd31b6e46a07cec3961b110ecba70d2d4ea2e` |
| routes.ts | `35f6f727219cc349ece835fc006bd2224935122103d0a13c5abff89362ac2174` |
| index.ts | `5f713ddabd25b3aa719a8ffe631264a23c5feeb086e705d8483f9a1699f76d9c` |
| runtime-policy.ts | `11bac6ad5a91e80f2acb66cc4c057386ab4fbf4872fefa629277946335796fce` |
| Root auth-http-pg.json9/9 | `f96ea6af7e802f0e4822d1d2f5a36a55ff378b2e5a747a734d4f0ed1836a8342` |
| Root auth-replay-pg.json7/7 | `abcf7aa6af0d996e59c2c141fd2df81cbd83077200bcc88ed87fb6cc95d2e77b` |
| Own result16/16 | `9782acf4efdb44091533f446c1bed2e0bcde08486fc78092dc8e005a3506023d` |

Передача `/root`: scoped auth wiring прийнято; зберегти fail-closed flags/fence й не розширювати acceptance на незавершені replacements. Нові інтеграційні source changes відкривають лише зачеплені gates; попередні replay/transport/reader proofs мають власні exact pins і межі.

## Адресований fixed-bot delta18:27 UTC

Після основного проходу root змінив product identity/wiring. Попередня таблиця й16/16 залишаються доказом своїх bytes; routes/index/policy більше не називаються незміненими. Новий bounded probe — **4/4 PASS, sourceDrift=false**; independently rerun current runtime-policy suite — **9/9 PASS**. Private `qa-auth-http/identity-probe.mjs` / `identity-result.json` під `.local/light-bot-app/release-v8/`.

Actual pure policy з власними інертними env literals: replay enabled і delivery enabled кожен відхиляє token іншого numeric bot prefix із `LBA_RUNTIME_TELEGRAM_IDENTITY_MISMATCH`; коректний public prefix допускає replay configuration. Default лишається disabled; canonical App active все ще відхиляється. Source readback actual flow тепер бере `botId` зі сталого `PRODUCT_TELEGRAM_IDENTITY`, а не з довільного configured token. Public identity object frozen: botID8577497098, usernamePowerUkraineBot. Root заявив authorized getMe readback; reviewer **не виконував getMe та не перевіряв реальний token**. Тому prefix consistency не є самостійним доказом фактичної credential/provider identity.

| Поточний адресований source | SHA256 |
|---|---|
| production/product-identity.ts | `5e2499b9174f309458545424d0e7f32fe7e9f74af01eccb8887b629526bdf5bf` |
| runtime-policy.ts | `d016d0aa29dff141678290f8e21385fdc5b5eb6a8ce1e406a3e4c14eae342ae3` |
| routes.ts | `7b57fa0fb1f20ece3e80e2d9cc52f57fb1f7343c3f30f60d666bea96551c72cc` |
| index.ts | `3338e4320b137cfd732ad04c887ee7e86047dfd62addc0b7258f0c70a98296e1` |
| tests/backend/runtime-policy.test.ts | `5a12cc323609c429e367a12e95c3a70af2d5b4583b39017825b67833b2d71378` |

Цей delta не повторює actual HTTP/PG9 і не приймає інші index integration зміни; auth function/guard/identity proofs мають попередні exact pins. Фактична production identity continuity, deployed build і feature replacements залишаються root release gates.
