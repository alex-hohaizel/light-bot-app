# Незалежний review Telegram transport

**Вердикт: PASS у bounded injected-provider scope. Нових product defects не виявлено; live delivery/release не прийняті.** Reviewer `/root/ux_a_independent_qa` не автор transport/tests/handoff. Product, PG, чинний бот, secrets та actual Telegram API не читалися й не змінювалися. Єдиний зовнішній read — офіційна документація.

Фактично виконано 2026-11-08 18:02 UTC, Node24.22.2:

- Авторські `live-telegram-transport.test.ts`: **23/23 PASS**, повторно виконані reviewer, авторство tests не змінено.
- Targeted strict TypeScript: **PASS** за командою handoff.
- Власні injected grant/render/HTTP/clock probes: **16/16 PASS**, sourceDrift=false. Нативний fetch не викликався; всі responses інертні.

Private reproducible harness: `.local/light-bot-app/release-v8/qa-telegram-transport/probe.mjs`, output `result.json`. Запуск: `node --experimental-strip-types .local/light-bot-app/release-v8/qa-telegram-transport/probe.mjs`.

## Незалежно підтверджені межі

| Сценарій | Фактичний результат |
|---|---|
| Grant revoked поки renderer чекає | Provider calls0, not_sent. |
| Photo400, наступний text grant denied | Тільки photo1, text0; окремий current grant з dispatchIndex2/fallback reason запитано. |
| Caption1025 | Один sendMessage із **повним** незрізаним text, photo0. |
| Photo403/429/500 | Один photo, text0; terminal/rate_limited/unknown відповідно. |
| HTTP200 із error429 body | Unknown, не false sent/retryable. |
| Синхронний throw після dispatch marker | Unknown, один attempt, без fallback; raw exception/token не повертаються. |
| Abort під час response body | Unknown, photo1, text0. |
| Timeout до завершення renderer | not_sent; late renderer не виконує provider dispatch. |
| Timeout після dispatch, ignored abort, late400 | Unknown; slot зайнятий до settlement; late400 не створює text/send і не змінює вже повернуту cloned receipt. |
| Actor/operation/recipient/index/binding grant mismatch | not_sent до provider. |
| Callback ack | Native ID походить із trusted grant; `true` прийнято, receipts без raw callback/chat ID/token. |
| Конкурентний другий request у factory | Busy, provider fan-out відсутній. |
| Campaign5xx | Bridge body=null, raw provider description не виходить. |

Source review також підтвердив: token лише в injected provider URL; fixed HTTPS origin, redirect:error, credentials:omit; exact token/bot binding та explicit getMe identity gate; bounded request/response/media; plain text без parse_mode; paid broadcast=false; keyboard native byte bound; capability expiry перевірено безпосередньо перед dispatch. Provider result звіряє message ID і chat/type; sender перевіряється, коли `from` присутній. Це важливо для channels, де optional `from` не можна оголосити універсально обов'язковим.

Поточний [sendPhoto contract](https://core.telegram.org/bots/api#sendphoto) повертає Message; [answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery) — Boolean true. Параметр [retry_after](https://core.telegram.org/bots/api#responseparameters) задає flood-control delay. Project policy трактує malformed/redirect/network/timeout/5xx як unknown без blind resend; це консервативне рішення, не provider exactly-once гарантія.

## Збережена невдала спроба

Перший власний run мав15PASS/1FAIL: callback mock помилково повертав Message замість Boolean true. Transport правильно класифікував це як unknown. Виправлено **лише private fixture**, product bytes не змінювалися; наступний16/16 PASS. `probe-initial.mjs`/`result-initial.json` збережено. Це oracle/fixture defect, не product finding.

## Конкретні межі інтеграції

- **Adapter не durable dedup.** Actual own probe двічі послідовно викликав той самий operation — provider calls2. Це відповідає documented scope, але caller зобов'язаний fence logical operation через durable inbox/outbox/ledger, claim/dispatch marker та unknown recovery. Per-factory busy не є global one-sender або cross-process lock.
- Current grant — trusted server-owned port. Він має звіряти актуальні ownership/subscription/pause/block/address-binding та inbox callback; arbitrary caller claims не є правом send. Renderer виконується до фінального egress grant, тому сам trusted renderer мусить scope renderKey/actor до джерельного job, не надавати довільний filesystem/data доступ.
- Atomic eligibility/dispatch fence, global rate budget, payload↔outbox digest, restart, real secret storage та one-sender wiring не реалізуються цим transport. Стан після зовнішнього dispatch не можна атомарно відкликати зміною профілю.
- Campaign consumer зараз створює `Object.freeze(envelope)` перед send; bridge покладається на цей readonly contract при await resolveContext. Не передавати mutable/untrusted envelope від public route.
- Unknown після timeout не має автоматичного resend; пізній transport response не стає новою доставкою. Потрібне ledger reconciliation. Ignored-abort port може тримати factory busy довго; відсутність fan-out не є доступністю провайдера або energy/performance proof.
- Receipt виключає raw text/media/chat IDs/provider body, але це не загальна перевірка приватності вмісту PNG. Renderer/content whitelist та приватність actual personal card потребують власних доказів.
- Legacy send paths ще мають бути fenced/переключені на єдину межу. Цей PASS не приймає старий sendPhoto catch→text fallback або production webhook/бота.

## Exact pins і передача

| Артефакт | SHA256 |
|---|---|
| `app/server/production/telegram-transport.ts` | `4b3469e5566feb73956f18987c75cc36baf206fd246bc6a02ab04cf4ce7e36b6` |
| `app/tests/backend/live-telegram-transport.test.ts` | `fd3ab2def5f3ed3deb987e66b4f602004f16f5ccb3d63034ac8b2ea88c3f09ea` |
| `release-v8/TELEGRAM_TRANSPORT_UA.md` | `53f79f7b3cad72549e73d2f0160c4a53a5753870d7135d9000a08e69e36a9151` |

Передача `/root`: source adapter прийнято в injected scope; наступний gate — server-owned grants/inbox mapping + durable sender/old-writer fence та actual дозволений platform smoke на exact build. Жодного send, grant на нові зовнішні effects або whole-product/68-must acceptance цей review не створює.
