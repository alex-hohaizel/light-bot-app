# Durable Telegram ingress · preparation contract

Виконавець `/root/v7_local_tools`, 2026-11-08. Реалізовано нову inbox межу, її unit tests та own disposable PostgreSQL proof. Root володіє route consumer, identity/profile/worker/sender integration. У цій задачі немає env/token reader, default/global pool, API, startup, consume, profile mutation, Telegram send або webhook change. Production і чинний public webhook не змінено.

Усі 68 must лишаються чинними: `continuation/requirements.json` SHA `8c0cf1a5d37694dab25715f6d5a321aaeb9c6bb0d515fc020bad33e3c3b62158`. Цей код реалізує ingress частину BOT-05/06/07 і TECH-05/08, а не закриває їх цілком. Застосовано локальний recovery1.0.0 (`cd4770ecaa9ec06b236f59c0a4cc45a4b7e4a993adc03abf64912d03d0fbc3b0`) та ChatBot Integrations5.0.0 (`faa060aa6a5d7095b17cf600cd395385a69c869c66dcca6137184a506b53b204`); прочитаний domain-contract source `5f8fbf60f7bd26957d08e1baffa9ffd8fe4c062b8425d3c46eda60853d49ada4`. Рішення reuse/extend: чинний shared BotInput і control gate, окрема durable platform boundary; local/synthetic guards не послаблено.

Офіційну документацію звірено 2026-11-08: [Update](https://core.telegram.org/bots/api#update), [webhook secret](https://core.telegram.org/bots/api#setwebhook), [CallbackQuery](https://core.telegram.org/bots/api#callbackquery), [InaccessibleMessage](https://core.telegram.org/bots/api#inaccessiblemessage). Update має не більше одного optional event; update_id використовується для повторів і не можна вважати його безперервним лічильником. Shared-secret header та його charset/межа походять з webhook contract. Inaccessible callback message має date0; inline callback має іншу область адресування. Ці факти не підтверджують actual configured bot/webhook або право змінювати їх.

## API для root route

```ts
const inbox = createTelegramInbox({
  enabled: false, // explicit trusted deployment switch
  expectedBotId: TELEGRAM_INBOX_BOT_ID, // literal '8577497098'
  expectedControlEpoch,
  secret, pool, now: () => new Date().toISOString(),
  // maxBytes?: up to 262144
});
await inbox.accept(secretHeader, rawBody);
await inbox.recoverReceipt(secretHeader, sameRawBody);
```

Factory сама не підключається до БД, не виконує DDL та не встановлює route. Inputs secret/pool/clock тільки інжектуються root; expected bot ID не береться з native JSON, username або Telegram actor ID. `rawBody` — UTF-8 bytes/Buffer або raw JSON string, не parsed request object. Header — одне точне значення X-Telegram-Bot-Api-Secret-Token, без array/comma/trim fallback. SHA-256 обох secret values порівнюються timingSafeEqual на фіксованій довжині; неправильний header відхиляється до parser/clock/pool.

Повернення `accept`:

- `{status:'committed',ack:true,receipt,replayed}` — лише після успішного COMMIT **та release**. Receipt phase — ingress_committed; це ще не commit профілю, виконання command, callback answer або доставка.
- `{status:'rejected'|'unavailable'|'unknown',ack:false,code}` — жодного ACK. Code стабільний; exception/query/body/secret не експортується.
- `recoverReceipt` читає exact bot/update/hash/normalized payload під тим самим fence; committed або `{status:'missing',ack:false}`. Вона не створює record, не виконує event і не consume-ить чергу. Після ambiguous COMMIT відновлення робиться за тим самим raw payload, без нового update ID.

Public receipt whitelist: version, phase, botId, updateId, accepted/ignored disposition, safe ignoredReason, controlEpoch, receivedAt. Немає chat/user IDs, native query ID, text, full native JSON, private hash або body. Для actual route root може віддати Telegram тільки `{ok:true}` після committed; unknown/unavailable/control/record error мають повертати non-2xx, щоб не підтвердити невідомий commit. Auth/payload/conflict errors потребують відповідного explicit non-2xx; не має бути legacy handler fallback після durable accept.

## Native admission і мінімізація

До pool access виконуються bounded bytes (default/max256 KiB), fatal UTF-8, JSON grammar/duplicate-key checks, max depth16 / nodes20000, unsafe/nonfinite number та unpaired-surrogate rejection. Потрібні positive safe native update ID і рівно один event. Canonical hash включає повний parsed native payload із відсортованими object keys: інший key order/whitespace не створює нову подію, але будь-яка semantic зміна того самого bot/update дає UPDATE_CONFLICT. Raw bytes/capture ніколи не зберігаються як fixture або inbox payload.

Accepted private message: actual human from.id == private chat.id, positive message/date, text≤4096. Копіюються тільки actorTelegramId/chatId/messageId та shared BotInput з immutable ID `tg:8577497098:<update_id>`. `/…` є command input, інший text — text input; виконання належить наступному worker. First/last name, username, photo, quoted card, chat instance, entities та додаткові native metadata не копіюються.

Accepted private callback: та сама human/private actor перевірка, accessible message, from.id **саме8577497098** та is_bot:true, точний callback data1…64 UTF-8 bytes. Native callback query ID зберігається тільки в private input для майбутнього scoped answer. Callback data не обрізається, не хешується в alias і не визнається чинним domain callback автоматично; owner/revision/TTL/consumed перевірить engine після identity mapping.

Нормалізований `TelegramPrivateInput` — **native transport facts, не VerifiedLegacyPrincipal**. Немає ownerId, `tg_` guess, account creation/merge або profile lookup. Actor Telegram ID має пройти чинний server-owned identity mapping у наступній фазі.

Непідтримані update types, group/channel chats, non-text private messages, inline/inaccessible/game callbacks durable ignored. У SQL для них private_input **NULL**, тільки safe reason/metadata/hash; зайва PII з native JSON не зберігається. Для цих варіантів немає claim про повну розмовну/media підтримку чи callback UI answer. Foreign-bot accessible callback, private actor mismatch і завеликий callback_data відхиляються до DB.

## SQL, ACK і epoch

`TELEGRAM_INBOX_SCHEMA_SQL` містить тільки additive inbox CREATE TABLE/INDEX. Existing lba_production_control не перевизначається і не seed-иться. PK/UNIQUE `(bot_id,update_id)` зберігає dedupe між екземплярами/restart; minimized private_input лежить тільки в private SQL. Receipt readback також перевіряє exact normalized private payload: corrupt/extra stored field не вважається придатною durable роботою.

Transaction: READ COMMITTED → existing control FOR SHARE/canonical/expected epoch → per(bot,update) advisory xact lock → exact receipt read → insert-on-conflict або duplicate check → COMMIT. Recovery використовує той самий per-update lock і fresh statement snapshot після очікування, щоб не повернути хибний ledger miss під час завершення конкурентного accept. Унікальний ключ лишається додатковим DB guard; hash conflict ніколи не переписує первинний input.

Якщо COMMIT або release має невідомий результат, method повертає COMMIT_UNKNOWN/ack:false, навіть якщо рядок міг зберегтися. Є safe exact readback; немає автоматичного припущення not-saved, resend, domain call або ACK. Failure після INSERT до COMMIT rollback-ить record.

Root окремо прийняв conservative preparation policy: після control epoch rollover старий stored duplicate також дає CONTROL_EPOCH_CONFLICT/ack:false. Старі rows/update IDs не видаляються й не перепризначаються. Перед cutover/root consumer має явно drain/reconcile/migrate pending epochs; поточний getWebhookInfo pending0 не доводить майбутню відсутність tail. Код не створює власного cleanup/TTL/offset/drop_pending_updates path.

## Виконані перевірки й freeze

| Артефакт | SHA-256 |
|---|---|
| app/server/production/telegram-inbox.ts | `bef089341282b676a3c76236249fd5b85cd63bfedad93a179a34f4d2af09cc5d` |
| app/tests/backend/live-telegram-inbox.test.ts | `a4817401a406c4b024e510186ba05cf8e89475d17944bfa42e653e62c5f9964b` |
| tools/lba_v8_telegram_inbox_pg.mjs | `8d8bd987dea38cb1bc5a4ff3e23c0e2d7026981ede1626a987dafd761675e2ba` |
| phase2/telegram-inbox-pg.json | `cfaf9851a9074a69fc4599d54b84dd78e56a1aa268af5befa862aa053f94eb33` |
| phase2/telegram-inbox-unit.log | `26cbe2963b02046c4d8bb8cb66c0c01419713d6503c0fa9a117274d7d5ac837b` |

Unit16/16 PASS, scoped strict TypeScript PASS. Same-process deny fetch/http/https/net/tls/DNS/listen probe з DB/auth/TG env unset:16/16, networkOrServerAttempts0. Імпорт і constructor не створили pool/DDL/network. Перший scoped TS run мав недосяжне comparison у test oracle після narrowing rejected; branch виправлено до freeze, runtime tests уже проходили. Actual PG failures не було.

Actual own PostgreSQL: **12/12 груп PASS**, fresh lba_test_telegram_inbox, 127.0.0.1:55439, helper random local credentials у пам’яті; clusterStopped:true, source drift0. Покрито missing schema/control/disabled/legacy/epoch; signature/invalid bytes before DB; canonical duplicate/change conflict; concurrent receivers/restart; ignored payload PII-null; foreign bot/actor/native64 bytes; ACK held until actual commit; real A-accept/B-advisory-wait recovery з pg_stat_activity та explicit RR negative control; saved/not-saved commit uncertainty; rollback/private corruption; old-epoch stop; жодних canonical profile/domain/outbox writes. Shared control DDL exact hash: `2f38c616fd7269ba9a1ed7d11ef88ed425d126d5a263edb548b1183173eb8371`.

Commands: `node --experimental-strip-types --test app/tests/backend/live-telegram-inbox.test.ts`; actual own cluster — `node --experimental-strip-types tools/lba_v8_telegram_inbox_pg.mjs`. Source і tests frozen перед root candidate build; після сигналу freeze змінювався тільки цей документ/доказові логи. Незалежне приймання чи actual HTTP route/provider ingress цими авторськими probes не заявляється.

Exact next action: root read-only review/imports на exact frozen pins, explicit additive schema/config у належному target лише в дозволеній фазі, route consumer з ACK mapping без старого legacy fallback, потім окрема durable identity/profile worker і one-sender implementation/приймання. Публічний webhook і production залишаються чинними до окремого cutover. Ця inbox readiness не дозволяє активувати sends або вважати весь LIGHT BOT APP завершеним.
