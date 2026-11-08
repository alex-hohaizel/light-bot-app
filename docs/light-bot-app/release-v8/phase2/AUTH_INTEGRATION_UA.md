# V8 phase2 · фактичний спільний вхід і закриті legacy обходи

Root інтегрував Mini App, Telegram Login Widget і mobile-token Telegram exchange через один createTelegramAuthFlow та PostgreSQL replay ledger. Runtime читає чинні Replit секрети тільки в пам’яті. LBA_AUTH_REPLAY_GUARD=enabled — явна конфігурація після additive schema; без неї три proof endpoints повертають 503, старого unsafe fallback немає. Schema не застосовується при імпорті, збірці чи звичайному startup.

Спільний key для HMAC ledger походить із сталого SESSION_SECRET. Його заміна до завершення valid proof lifetime потребує спільної fail-closed/keyring rotation процедури; випадковий process key заборонений. Telegram identity resolver використовує лише explicit stored issuer/subject link з users row. Новий підписаний subject створює UUID та unique link атомарно; dangling link чи старий convention-ID без явного link потребує reconciliation, ніколи не перезаписується. Немає автоматичного злиття налаштувань або підтвердження права proactive send із факту входу.

Фактичний Passport/express-session adapter чекає завершення login/regeneration та session save до durable proof binding. Якщо binding/login/save не підтверджений, destroy прибирає нову session, req.user очищається, cookie видаляється; при failure cleanup виникає окремий fail-closed результат. Новий JWT створюється лише після успішного binding. Session-only mobile exchange використовує чинний session verifier з expiry, а не truthy req.user. Public errors не містять DB/provider деталей.

Незалежний review виявив старі маршрути, через які можна було переприв’язати чужий chatId, напряму надсилати Telegram, записувати legacy settings/locations/shares і отримувати JWT від простроченої session. У production preparation ці операції перекриті legacy-route-fence; у mobile-auth додано actual Bearer revalidation/HS256/sub shape або справжню непорожню session з чинним expiry. Fence монтується до legacy handlers. Startup більше не робить DTEK session/challenge чи віддалений prefetch/seed loop. Production global error handler повертає generic message і логує лише status.

Це підготовка, а не feature parity: старі login-request/auto/deep-link, settings/locations, reports/digests/shares та неприйняті source routes недоступні до відповідних canonical replacements. APP-08 та решта68 не оголошені виконаними. Цей artifact не можна publish як завершений продукт, поки ці paths/дані/delivery/restore не зведені та перевірені.

Докази на поточних pins: auth-replay-pg.json — 7 actual PG groups; auth-http-pg.json — 9 actual HTTP+PG+Passport groups зі synthetic signed credentials; QA_AUTH_HTTP_UA.md — independent16 groups та source/actual evidence review. Actual PG перевірив timestamptz Date expiry, cross-session/cross-route replay, concurrency, реальний destroy після failed bind, збереження existing settings, UUID new account і legacy collision. Це не доказ реального Telegram клієнта, physical device чи production sessions.

| Джерело | SHA256 |
|---|---|
| `app/server/production/auth-replay.ts` | `2bec24f8d6f2aea1bb910d79956999680263757f1f9f7156d0186fc298b2fd0f` |
| `app/server/production/telegram-auth-flow.ts` | `17d0771f8aca1e81404beda8823576aefb343d4c21e0af47cf3bf4e056329f40` |
| `app/server/production/telegram-auth-http.ts` | `9bc006bce037cda2dbb41efeb5b3dfedb6a66c251615d46c92b9149aea9f72aa` |
| `app/server/production/telegram-identity.ts` | `ee5211f7099cd7c8c5a32882bccf85f4315bf49f318e913c212586cdfceec4b1` |
| `app/server/production/product-identity.ts` | `5e2499b9174f309458545424d0e7f32fe7e9f74af01eccb8887b629526bdf5bf` |
| `app/server/production/legacy-route-fence.ts` | `14898198e6ac377a9fe844997aa772fdfeaf5a84c1fef7f9bfc30ed17f8b5b68` |
| `app/server/mobile-auth.ts` | `c2105c0723a32cd26a22d98e4fdcd31b6e46a07cec3961b110ecba70d2d4ea2e` |
| `app/server/runtime-policy.ts` | `39b08685270f0aa938e075e731a1c5fec2e34f322a14b0c925ac2cb4b9eaa07f` |
| `app/server/routes.ts` | `7a4fb8722152e018979b6d42167a39c20aa9167aac2d3fb6a46a5772386c4c43` |
| `app/server/index.ts` | `ee4c69f65b9ebab3bfdebe040e0d4a8c1cd5e034b1680d1e9201ffe25019bd9b` |

Жодного production DB write, publish, webhook setter або send ці спроби не виконували. Next: звести canonical store, trusted legacy subscriber mapping та App/Bot ingress/delivery, повторити bounded affected checks і сформувати новий exact staging package. Production DB binding/backup/restore лишаються окремим фактичним gate.
