# Незалежний review auth replay boundary

**Вердикт: bounded guard/flow PASS після expiry repair; APP-05 і production auth ще не закриті.** Reviewer `/root/ux_a_independent_qa` не авторував `auth-replay.ts` або `telegram-auth-flow.ts`. Product/routes/PG/provider не змінював. Власні output — цей документ і private harness; лише власні нечинні HMAC fixtures, жодних реальних осіб, cookie, bot credentials або чатів.

## Фактичний доказ

| Спроба | Результат / exact scope |
|---|---|
| `private/auth-replay-initial-result.json` | **23 PASS / 1 FAIL**, sourceDrift=false. Actual verifier/guard/flow з незалежним transactional memory-PG port. |
| `private/auth-replay-result.json`, 2026-11-08 17:52 UTC | **30/30 PASS**, sourceDrift=false, на repaired source. Включає expiry/cleanup negatives. |
| Targeted strict TypeScript | **PASS** для guard/flow/validator, no emit. |
| Root `auth-replay-pg.json` | Прочитано **історичний 7/7 actual PostgreSQL proof**, actor `/root`, own127.0.0.1:55436 / `lba_test_auth_replay`. На момент review pins ще **до ремонту**. Це не мій PG запуск і не current repaired PG verdict. |

Модельний порт реалізує unique proof PK, rowCount, commit/rollback та serialized transactions; розклад сильніший за PostgreSQL. Він перевіряє переходи actual guard/flow, **не фізичні PG locks, реальний restart, distributed execution або session store**. Root SQL proof окремо перевірив first claim, same-bound/cross-browser, actual concurrent winner, widget/mobile common proof, invalid/expired signature, failed login й відсутність raw secrets у рядках; його старі pins не переписано заднім числом.

Відтворення власного bounded suite без SQL/network:

```sh
node --experimental-strip-types docs/light-bot-app/release-v8/phase2/private/auth-replay-probe.mjs
cd app
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions server/production/auth-replay.ts server/production/telegram-auth-flow.ts server/telegram-init-data.ts
```

## Прийняті властивості

- **Signature до effects.** Обидва входи викликають actual `verifyTelegramInitData` / `verifyTelegramLoginData` до reserve. Підроблений/чужого bot підпис, tamper, duplicate/unsigned field, expired/future proof дали0 pool connects, identity0, login0. Guard сам не є cryptographic verifier: його `VerifiedAuthProof` створює лише trusted verified caller.
- **Повтор і wrong session.** Перший valid proof дає identity1/login1. Повтор у тій самій уже bound valid session повертає `alreadyAuthenticated:true` без другого writer/login. Інший browser/session, logout/currentOwner=null або wrong bound owner не відновлює auth.
- **Canonical proof identity.** Key виведено із verified signature+kind+bot+subject+authDate, а не raw query string. Reorder params та URL-еквівалентне `%20`/`+` дали той самий proof: жодного нового claim. Cross-bot/type path відхилено криптографічно; trusted guard namespaces також розділені.
- **Конкурентний reserve.** Actual SQL має PK `proof_key` та `INSERT ... ON CONFLICT DO NOTHING`, наступний locked read. Модельний simultaneous flow отримав1 winner/2 rejects та identity1/login1. Actual PG конкуренція підтверджена тільки зазначеним старим root proof; repaired PG потребує свого повтору.
- **Failed/unknown outcome.** Failed login лишає claim consumed; retry не повторює identity/login. Unknown bind commit до commit лишає `claimed`, після фактичного commit із втраченою ACK — `bound`. В обох repaired випадках newly issued session invalidated1, owner cleared; повтор не породжує нових effects. Fresh launch може бути потрібний — blind release/reclaim або unsafe retry відсутні.
- **Fence/restart.** Чужий claim ID не bind-иться. Новий guard instance над тим самим портом/ключем бачить попередній bound proof; це не реальний process/DB restart proof. Cancel після початку login покривається mandatory invalidate, а не обіцянкою rollback уже виконаного identity SQL.
- **Privacy/import.** SQL values/model rows не містили raw initData/signature/session ID/cookie/token/HMAC key. Зберігаються keyed proof/session bindings, claim, expiry, public bot ID і internal owner ID. Немає SQL logs/raw error interpolation. Export schema SQL — лише рядок; import/constructor не виконують DDL і не створюють pool. Schema під час reviewer suite не застосовувалась.

Це application replay policy за canonical APP-05. Telegram надає підпис і timestamp, а не зовнішню гарантію одноразовості raw proof; [офіційний Mini App validation contract](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) і [legacy Widget algorithm](https://core.telegram.org/widgets/login-legacy#checking-authorization) не оголошені provider idempotency API. Поточні validators на незмінених bytes уже адресно прийнято в `../QA_AUTH_UA.md`.

## Знайдений expiry defect та repair

**AREPLAY-01, підтверджений FAIL:** valid Mini proof резервувався при t0; `resolveUser` повертався після переходу clock наt0+3601. Початковий flow усе ще робив login1, bind ставав `bound`, error був відсутній навіть на ledger expiry. Guard перевіряв proof лише до SQL, а bind не читав expiry.

Root додав freshness після await у reserve/flow, expiry before/after UPDATE у bind і mandatory `session.invalidate()` при login/bind failure після початку login. На addressed source:

| Deadline/failure точка | Actual model result |
|---|---|
| Після resolver, до login | `AUTH_REPLAY_EXPIRED`; identity1, **login0**, claim лишився consumed. |
| Після awaited BEGIN або INSERT | Rollback; **identity0/login0**, новий row не збережено. |
| Після persisted login, до bind | Expired; invalidate1, owner cleared, row `claimed`. |
| Після awaited bind SELECT або UPDATE | Expired; rollback, invalidate1, owner cleared, row `claimed`. |
| Login failure / unknown bind до чи після commit | Invalidate1; повтор не повторює identity/login. |
| Invalidate сам відмовив | Явний `AUTH_SESSION_CLEANUP_UNCONFIRMED`; **не** login success і не твердження, що session фізично знищена. |

Пізнє отримання ACK для вже коректно завершеного bound login не названо новою автентифікацією після expiry. Repaired module не відмотує назад identity mapping, якщо opaque resolver уже виконав свій commit; воно блокує подальшу видачу session і невизначені повтори. Actual identity repository потребує власної атомарності/idempotency.

## Передумови wiring та відкриті докази

1. **Один ledger і стабільний key для всіх workers/restarts.** HMAC key не може бути per-process random. Його зміна змінює proofKey: rotation має мати explicit fail-closed/keyring/migration policy, поки старі signed proofs ще valid. Ця операційна передумова не доведена локальним key fixture. Retention/cleanup після validity window — окремий runbook, без raw credentials.
2. **Всі три маршрути мають споживати flow.** Mini → `mini`; legacy Widget і mobile exchange → той самий `login`, той самий bot/kind/key/ledger. Не лишати альтернативний direct validator→identity/JWT path, що оминає reserve. OIDC/session refresh — інші протоколи, не автоматично one-time за цією схемою.
3. **Реальна session authority.** `id/currentOwnerId` походять із verified server session, не body/header/initDataUnsafe. `login()` має завершуватися тільки після persisted regeneration. Invalidate adapter має destroy/revoke та clear cookie; cleanup failure не може повертати auth success/JWT. Потрібний real HTTP/session-store replay/cleanup proof до активації.
4. **Actual PG на repaired bytes.** Повторити хоча б concurrent first reserve, expiry на SELECT/UPDATE із actual `expires_at` Date, commit ambiguity та cleanup binding у fresh owned DB. Reviewer не запускав іншої DB. Старий7/7 source: guard135657…/flow7ca182…; current2bec24…/17d077… — окремий scope.
5. **Модулі ще не wired active.** Тому API-wide APP-05, production schema migration, real identity continuity, multiworker deployment/rollback і фізичний Mini/native login залишаються pending. Bounded module PASS не дозволяє production campaign або заяву про повну готовність.

## Exact pins

| Scope | SHA256 |
|---|---|
| Historical guard | `135657acf73f62b2bb1a7fedcf4b085347e273a3068ce6f155b8af313108d781` |
| Historical flow | `7ca18225e1e91a2871fdf17fbd3984b3696c2f9a34463befe2576e9bf169d520` |
| **Repaired auth-replay.ts** | `2bec24f8d6f2aea1bb910d79956999680263757f1f9f7156d0186fc298b2fd0f` |
| **Repaired telegram-auth-flow.ts** | `17d0771f8aca1e81404beda8823576aefb343d4c21e0af47cf3bf4e056329f40` |
| Unchanged telegram-init-data.ts | `693c6753f11277a5c8b4f23a41c3220d7629a822ac57ea46a2d1111ca8cca308` |
| Initial result23/1 | `55cab81d11a5f5c1309a36f8647de23e5bb99483c19a8f70b5e528f4e4ef54ca` |
| Addressed result30/30 | `1b83664b2455802a763e12e2ba72ea10d959d30df829aff9af5648600c04b3b5` |
| Current private harness | `12a153deb0ae42f3d6415c5ba81243a2dc48e7b4f322bb4d56313769f8cc6ae6` |
| Historical root PG receipt7/7 | `121e53b8c241179d1bcfc5d27b8c17c6d97f6bf45d8d3868ba7e1b1a272f469e` |

Передача `/root`: module repair прийнято в bounded in-process scope; перейти до actual repaired PG та повного common-route/session adapter wiring. Нові source changes відкривають лише зачеплені gates. Початковий FAIL, harness і різні pins збережені; жодного blanket release/human acceptance не видано.
