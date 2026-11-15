# Explicit legacy Telegram identity mapping

Додано read-only trusted mapping для чинних `linked_accounts` → `telegram_subscribers`, щоб NULL subscriber.user_id не відкидав збережену Bot policy під час legacy projection. Немає identity inference, нових accounts/links, перепризначення subscriber, auto-merge чи delivery.

## Final source pins

| Source | SHA256 |
|---|---|
| `app/server/production/legacy-identity-links.ts` | `49879626ee9673e4c7a392db48b4f97cb1ed7b98eaa4d83717b3febfe7a90b33` |
| `app/server/production/profile-store.ts` | `9b4f216b11a6b1fc96e963f05046958534efe9dbc0c87391a8347b2222936373` |
| `app/tests/backend/legacy-identity-links.test.ts` | `f9e43b786dae9b9eacfdcccc77e093cd28e3144eba1e30f378a620f5206b8ffd` |
| unchanged reader | `bdcdcbba56733ad661b777cfdbc13572e38b76978a828779066725441210e664` |

Historical store `a6bb03ff…` independent actual PG acceptance remains bounded to that source. `83017188…` був проміжним mapping-port pin; final adds copied callback principal/proof ownership. F1–F4 store semantics і schema тут не змінено. Потрібна окрема addressed mapping/transaction перевірка; старий actual proof не приписується новому pin.

## API та root wiring

`selectVerifiedLegacySubscriberMappings(client, verifiedPrincipal)` виконує лише SELECT у transaction, яку контролює caller. Повертає closed `VerifiedSubscriberMapping[]` — kind/ownerId/chatId/revisionId; усі значення приватні. Structural verified flag не автентифікує людину: root передає виключно actual authenticated principal.

`readOwnedLegacyProfile(pool,principal,{now?,rowLimit?})` — готовий read service consumer: один `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, mapping helper, на тому самому client `selectLegacyLiveProfileInTransaction`, COMMIT/release. Root може замінити production read_only port на цей wrapper. Default `readLegacyLiveProfile` не змінено й не отримав неявні mappings. Request/caller не може підкласти `verifiedSubscriberMappings` в options wrapper.

Canonical store port став `verifiedSubscriberMappings(principal,client)`; callback з одним аргументом лишається сумісним. В actual bootstrap root підключає `(principal,client)=>selectVerifiedLegacySubscriberMappings(client,principal)`. Helper виконується після control/owner fence в тій самій RR transaction, а не окремим pool read. Store передає cloned principal і володіє cloned returned mappings: callback не може змінити owner чи згодом підмінити proofs між sourceDigest та origin persistence. Private origins тепер явно зберігають verifiedSubscriberMappings; reader sourceDigest також фіксує їхні revisions. Public snapshot/API не експортує link/chat identity proof.

## Exact SQL boundaries

Використано фактичні схеми `shared/models/auth.ts`, `linked-accounts.ts`, `telegram-subscribers.ts`: users.id; linked_accounts.id/user_id/provider/provider_id; subscriber.chat_id/user_id. Не читаються email, username, display_name, auth tokens або policy fields до приймання ownership.

1. Exact `users WHERE id=$principal.ownerId` мусить існувати. Unknown principal row блокується до mapping.
2. Беруться тільки own `linked_accounts WHERE user_id=$1 AND provider='telegram'` з cap100 і explicit fields. Telegram provider_id має бути canonical positive user identifier. Немає tg-prefix/username/email порівнянь.
3. Окремо читаються лише ownership identifiers subscriber rows `WHERE user_id=$1`, cap10000. Їх треба перевірити на foreign explicit identity links, навіть якщо own Telegram link відсутній.
4. Для union цих own explicit refs і direct-owned subscriber refs global aggregate перевіряє count/own/foreign/dangling links через users join. Це не глобальний export: WHERE provider telegram AND provider_id=ANY(scoped refs), у відповіді лише scoped ref/counts. Duplicate provider_id, foreign ownership або dangling users link fail-closed; не обирається «перший» link.
5. Subscriber candidate ownership читається лише для verified unique own link refs. NULL → proof для reader projection; exact same owner → proof зберігається, але ownership не перепризначається; foreign owner/duplicate row/contradiction → block. Link без bot subscriber не створює subscription і не додає false missing-mapping claim.

Distinct globally unique Telegram links одного owner зберігаються всі. Policy не згортається до одного endpoint: reader/projector зберігає enabled/disabled, explicit0, thresholds, quiet hours, briefing та minimum duration. Невідповідності залишаються explicit projection issues; canonical bootstrap досі блокує issues, не вмикає delivery і не re-enable opt-outs. Це чинна межа reconciled policy, а не мовчазне приймання конфлікту.

Mapping revision — stable SHA256 explicit link id/owner/provider identifier, accepted aggregate ownership proof і original subscriber owner. Policy зміна не підміняє identity revision; reader sourceDigest окремо змінюється за policy даними. Немає timestamp/nonce, який довільно міняє identity на кожному читанні. Raw values не логуються; помилки стабільні й не повертають приватні SQL details.

## Перевірки та межі

Авторські **12/12 mapping groups PASS**: explicit NULL/same-owner projection; one-client RR READ ONLY wrapper; enabled/disabled/zero preservation; unknown/forged principal; no tg-prefix inference; duplicate/foreign/dangling links; direct-owned subscriber with foreign link; multiple distinct refs; unrelated provider/ref exclusion; absent subscriber; malformed rows/caps/error redaction; actual canonical bootstrap+private origin; copied principal/proof immutability; inert import/no mutation exports.

Mapping12 + canonical store24 + reader12 + App routes10 = **58/58 PASS** на наведених pins. Scoped strict TS PASS. Повний project `npm run check` PASS на попередньому `83017188…` store; final copy-only change окремо covered scoped TS/tests. Перший scoped command виявив options.rowLimit unknown/null narrowing, додано явний typeof guard; final results не приховують цю початкову compile помилку.

Усі SQL tests використовують inert injected port. Реальних profiles/links/subscriptions, external HTTP/Telegram, production або secrets автор не читав і не змінював. Actual snapshot/concurrency/schema й deployment докази виконує root/незалежний QA окремо.

## Exact next action

Root підключає wrapper до read_only API, port до canonical bootstrap та передає ці pins незалежному reviewer. Actual disposable PostgreSQL: exact current legacy schema, multiple NULL enabled/disabled endpoints, same-owner/non-owner links, absent users, duplicate/dangling conflicts, same RR client/snapshot, no legacy writes, provenance/sourceDigest, projection issues/store block. Після цього actual authenticated consumer має окремо довести owner scope. Active writer policy, webhook, delivery/cutover і всі68 вимог залишаються окремими відкритими gates.

Після окремого App DTO repair наroutes185c79… повторно пройдено mapping12/store24/reader12/API13 =61/61 tests і повний npm run check PASS на final mapping498/store9b pins. Це не додає actual DB/auth доказів mapping module.
