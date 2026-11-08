# V8 · Telegram provider boundary

Виконавець `/root/v7_local_tools`, Codex, 2026-11-08. Реалізовано тільки нові `app/server/production/telegram-transport.ts`, `app/tests/backend/live-telegram-transport.test.ts` і цей handoff. Реальний token не читався, env/БД/Telegram не використовувалися; всі provider responses у спробах інжектовано. Production sender не активовано, `@PowerUkraineBot`/webhook/metadata не змінено. Усі 68 must збережені; ця межа допомагає BOT-05/06/07, CHART-04/07/08 та TECH-05/08, але не закриває їх цілком.

Прочитано ChatBot Integrations 5.0.0 actual SKILL (`faa060aa6a5d7095b17cf600cd395385a69c869c66dcca6137184a506b53b204`) та `references/platform-adapters.md` (`679f5e30e63bfccb56637429708866f0208d095fc035997c0902f4d42fa40f0b`). Рішення compose: доменна модель й чинні guards збережені, новий egress adapter використовує спільний outcome та наявний campaign sender port. Installed/listed/source-checked підтверджені для поточного host; це локальна реалізація методу, не доказ live operation.

Офіційний контракт звірено 2026-11-08: [Bot API: requests](https://core.telegram.org/bots/api#making-requests), [getMe](https://core.telegram.org/bots/api#getme), [getWebhookInfo](https://core.telegram.org/bots/api#getwebhookinfo), [sendMessage](https://core.telegram.org/bots/api#sendmessage), [sendPhoto](https://core.telegram.org/bots/api#sendphoto), [answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery), [InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton). Native API має Boolean `ok`; message acceptance повертає Message; callback answer — Boolean true. Callback data має межу 1–64 UTF-8 bytes; фото має 10 MB / суму вимірів ≤10000 / ratio ≤20. Ці факти визначають межі адаптера, не дають права виконувати API-запит.

## Exports і точні входи

`createTelegramTransport({ expectedBotId, token, fetch, authorize?, now, renderPhoto?, limits? })` повертає `botId`, окремі `read` та `effects`.

- `read.getMe({actorId,capabilityId}, signal)`; `read.getWebhookInfo(context, signal)`.
- `effects.sendMessage(context,{text,keyboard?},signal)`.
- `effects.answerCallbackQuery(context,{text?,showAlert?},signal)`.
- `effects.sendPhoto(context,{caption,png,keyboard?},signal)`.
- `effects.sendRenderedSchedule(context,{text,renderKey,keyboard?},signal)`.

Effect context: `{actorId,capabilityId,operationId,recipientRef,callbackRef?}`. `recipientRef` — внутрішній scoped reference; native chat ID із запиту не приймається. `callbackRef` — reference до вже перевіреного server inbox record; native callback_query_id із довільного запиту також не приймається. Входи effect копіюються до першого await, щоб caller mutation не змінила actor/destination/rendered text під час роботи.

`authorize(request, signal)` — **server-owned capability/mapping port**, а не довіра до переданих користувачем claims. Request містить exact actor/capability/bot/method, effect operation/recipient/callback refs, `dispatchIndex` (1 або 2 при fallback) та optional `fallbackFrom`. Порт повертає `TelegramVerifiedGrant` з усіма цими самими значеннями, explicit-offset `expiresAt`, а для effect — `chatId` як точний signed decimal ≤52 bits, `chatType`, `bindingRevision`. Callback answer додатково вимагає `callbackQueryId` саме з цього trusted grant. Усі scopes і expiry звіряються; expiry перевіряється повторно безпосередньо перед provider dispatch. Callback ownership, subscription/opt-out, current profile/binding, grant revoke, durable permit/fence й bot-global sender ownership забезпечує цей порт/батьківський repository. Без authorize жоден метод не робить HTTP.

Перед effect потрібен **окремий явний getMe**, який перевірив numeric expected bot ID, token prefix, `is_bot:true` і username `PowerUkraineBot`. Proof свіжий максимум 5 хвилин; автоматичного getMe/startup немає. Token prefix мусить збігатися з `expectedBotId` ще під час factory validation. GetMe повертає тільки перевірені `botId/username/name`; mismatch скидає proof. Зміни публічного name не виконуються автоматично — поточне старе ім’я можна побачити й адресно виправити через окремо дозволену операцію.

`getWebhookInfo` повертає лише configured flag, SHA-256 повного URL, pending count і certificate flag. Повний webhook URL, query/path secret, provider errors та IP не експортуються. Незмінність чинного webhook root звіряє за hash із захищеного очікуваного значення. Методи setWebhook/deleteWebhook, polling/offset/drop_pending_updates, bot metadata writers, startup/schedulers відсутні.

## Транспорт, параметри й outcomes

`fetch` обов’язково інжектується. Private token URL створюється тільки в пам’яті перед exact `https://api.telegram.org/bot…/<allowed method>`; нема default fetch або env/файлового credential reader. Port одержує POST, `redirect:'error'`, `credentials:'omit'`, `accept-encoding:identity`, abort signal, bounded bytes body. Він має поважати ці параметри, не додавати credentials/cookies, не пересилати запит за redirect й не логувати token-bearing URL/body. Фактичний response URL має буквально збігтися. Exceptions, provider description та raw response body не виходять назовні і не логуються.

Повідомлення — plain text, без прихованого HTML parse mode. Unknown payload options, довільні chat_id/paid flags не приймаються. `allow_paid_broadcast:false` передається явно. Text ≤4096 і photo caption ≤1024 консервативних UTF-16 units; без truncation/неявного поділу на кілька повідомлень. Keyboard whitelist: callback, HTTPS URL або private-chat Mini App button; максимум 8 rows, 4 buttons/row, 16 загалом як локальний product/resource cap. Callback_data перевіряється саме за bytes, без обрізання або непомітного хешування.

`telegramKeyboardFromBotButtons(buttons)` зберігає точні engine callback IDs (`BotButton`) і розкладає по 2 на рядок. Прострочення/actor/revision semantics callback залишаються у чинному engine; транспорт їх не замінює.

Фото — тільки renderer PNG bytes з перевіркою signature/IHDR/dimensions; fixed filename, жодних довільних файлових шляхів, URL чи file_id. PNG default cap 5 MB, конфігурована верхня межа 10 MB. Multipart bytes формуються явно та мають загальну request-byte межу. Renderer — інжектований локальний producer за scoped renderKey, не прихований зовнішній платний сервіс. JPEG та повне декодування/перевірка PNG pixel stream цією межею не реалізовані; provider може точно відхилити невалідний PNG.

Загальний deadline типово 10 с (до 30 с), response default 128 KiB (до 256 KiB), до 2048 непорожніх chunks, UTF-8/JSON/content-length/media/encoding checks. Один active operation на екземпляр. Якщо fetch/renderer/authorize ігнорує abort, slot утримується до реального завершення, щоб timeout не породив приховану fan-out. Пізнє завершення не запускає новий send.

Effect result: `{outcome:DeliveryOutcome,receipt}`. Read result: `{ok:true,value,receipt}` або `{ok:false,outcome,receipt}`. Safe receipt містить bot/operation/recipient refs, completedAt і список attempted methods/request hashes/providerAccepted/messageId або verified error code; private chat ID, callback native ID, token URL, description/body відсутні. Немає delivered/read/human claim.

- `sent` для message/photo тільки після HTTP200, `ok:true`, positive message_id, exact mapped `chat.id/type`, відповідного sender bot, якщо `from` присутній. Receipt — `tg-msg-N`.
- Callback acknowledgement вимагає `result:true`; окремий `tg-callback-*` receipt не є message receipt.
- Узгоджені HTTP/API403 — terminal not_sent. Інші definite API4xx — not_sent, без сліпого retry.
- 429 тільки з узгодженим API code й integer retry_after 1…86400 → rate_limited. Missing/0/string/надмірне retry_after → unknown; вигаданого cooldown немає.
- Network/timeout/redirect/malformed/mismatched target та **всі 5xx**, включно з JSON error reply, — unknown. Автоматичних retries не існує.

`sendRenderedSchedule` використовує весь оригінальний text. Якщо caption не вміщується або renderer упав/повернув непридатні bytes **до dispatch**, надсилає повний text. Після explicit verified photo400 може отримати **новий current grant** для sendMessage й зробити один text fallback, зберігши обидва attempts. Після photo success, 403,429,5xx, network/timeout/unknown fallback заборонений. При abort навіть пізній photo400 не запускає text.

## Споживачі й збережені межі

Спільний `DeliveryOutcome` використано type-only з `app/shared/delivery-contract.ts` (`346a0f56aafaa03fc23d49a4d62d8bca0d207698dd26f0eef8288b273baa156c`). **LocalTestTransport/DeliveryEnvelope.simulationOnly guards не змінено і не приведено до production cast.** Новий adapter не має `kind:'local-test-only'` і не підключається до local worker.

`campaignSenderFromTelegramTransport(transport,resolveContext)` реалізує чинний `CampaignTelegramSender` port з `update-campaign.ts` (`61783b2d0bd1e1ed028a697034673ed2127aecff81e5cfb9ad9e83866068d968`). ResolveContext є серверним; bot/operation/recipient мусять збігтися з envelope. Bridge повертає тільки мінімальні підтверджені Bot API facts: sent message_id, verified429 interval або definite4xx. Unknown/5xx → body:null, тому чинний campaign classifier не перетворить ambiguous5xx на retryable not_sent. Raw provider body не передається.

Це provider boundary, **не durable outbox/дедуплікація або глобальний rate coordinator**. Root зобов’язаний використовувати один durable fenced sender, перевіряти актуальну eligibility й фіксувати attempt перед dispatch та outcome після; не викликати повторно unknown logical operation. Пізній positive reply після внутрішнього timeout не експортується як автоматичний success: потрібне окреме reconcile, без resend. Cross-process/restart locking, rate budget, staged campaign gates і effect grant consumption залишаються у repository/service.

Під час source inspection передано root конкретні legacy gaps: tgApi логував e.message, який може містити token URL; legacy sendPhoto робив fallback за будь-яким !ok/catch. Цей модуль сам їх не переписує/не підмінює live. Перед активацією треба адресно переключити їх на єдину захищену межу та fence старі send paths.

## Перевірки й exact next action

23 авторські тестові групи PASS; scoped strict TypeScript PASS. Same-process deny fetch/http/https/net/tls/DNS/listen probe з unset DB/auth/TG env: всі 23 PASS, `networkOrServerAttempts:0`. Fixture token створено в тесті, actual provider/network/token reader не використовувалися. Негативні controls охоплюють exact bot/actor/recipient/capability, native callback bytes/ownership, photo fallback classes, ambiguous5xx/429, timeout/ignored-abort/late400, expiry безпосередньо перед dispatch, in-flight mutation, secret redaction, request/response/media/UTF8 bounds та campaign bridge.

Команди у `app`: `node --experimental-strip-types --test tests/backend/live-telegram-transport.test.ts`; scoped tsc — `./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --esModuleInterop --types node tests/backend/live-telegram-transport.test.ts`. Це adapter/pure injected proof; live API, native client rendering, notification delivery, human acceptance та повний release не підтверджені.

Кодові pins: source `4b3469e5566feb73956f18987c75cc36baf206fd246bc6a02ab04cf4ce7e36b6`; tests `fd3ab2def5f3ed3deb987e66b4f602004f16f5ccb3d63034ac8b2ea88c3f09ea`. Це перевірені авторські pins; незалежний verdict передається окремо.

Exact next action: bounded independent review цієї межі; root реалізує server-owned durable capability/chat/inbox mapping, one-sender fencing і read-only identity/webhook probe на захищених remote credentials. Лише після окремо належних grants/readback і exact source/build acceptance root може інтегрувати дозволені sends. Цей task жодної такої операції не виконав.
