# Незалежний review canonical App writer

**Фінальний bounded verdict: App route boundary PASS після адресного repair; AW-D1/AW-D2 addressed у наведених vectors.** Reviewer `/root/ux_a_independent_qa` не автор цих routes/shared DTO/store. Product edits, DB/server/provider requests, secrets або production writes не виконував. Це перевірка API boundary, не повтор V7 UX і не приймання всіх 68 must.

## Докази 8 листопада 2026

- Власний actual route-handler suite18:25 UTC: **9/13 PASS, 4 FAIL**, sourceDrift=false. Останній failing case використовує **actual canonical store** з інертним read-only SQL port; решта — actual registered routes з інертними authenticated principal/store ports. Немає HTTP listener або PostgreSQL. Private `.local/light-bot-app/release-v8/qa-app-writer/{probe-initial.mjs,result-initial.json}` зберігають первинні failures.
- Незалежно повторено author tests: canonical App routes10 + runtime policy8 на тодішніх bytes — **18/18 PASS**. Route tests споживають actual canonical store через transactional SQL fixture; це не actual PG/HTTP/auth signatures.
- Targeted strict TypeScript routes/shared/tests із host `node,passport` declarations — **PASS**, no emit.
- Окремий актуальний policy delta й fixed-bot9/9 PASS мають власні pins у `QA_AUTH_HTTP_UA.md`; вони не перетворюють initial App proof на нові source bytes.
- Фінальний повтор **того самого власного suite:13/13 PASS о18:31 UTC**, sourceDrift=false; `probe.mjs`/`result.json`. Новий author API suite незалежно повторено: **13/13 PASS**; scoped strict TypeScript — **PASS**. Первинні failures залишені окремо.
- Root `app-writer-http-pg.json`: **9/9 PASS**, actual own PostgreSQL127.0.0.1:55440 + loopback HTTP/JWT. Прочитано receipt та зіставлено source pins; це root запуск, не мій actual PG/HTTP proof. Покриває exact owner bootstrap, App↔Bot shared state, duplicate ID, two HTTP CAS writers1winner, unknown saved commit/recovery, disable gate, mapping privacy та незмінність legacy rows. Його mapping detail review передається окремому `QA_LEGACY_LINKS_UA.md`.

## Конкретні initial findings і repair

**AW-D1 · P2 · false recovery result видається за відомий miss.** Actual `POST /api/product/profile/receipt` з тим самим valid request і injected recoverReceipt→false, undefined,0 або порожній рядок повернув200 `{outcome:'not_recorded',receipt:null,nextAction:'retry_same_request'}`. Визначений контракт допускає receipt або **null**; інші результати не підтверджують відсутність ledger row. Потрібно fail closed503; valid null має лишитися200 miss. Це не доведений double commit: exact same-ID store dedup лишається захистом. Дефект — неправдивий recovery outcome на пошкодженій межі.

**AW-D2 · P2 · field whitelist не гарантує scalar DTO/privacy.** Actual GET повернув200 для `preferences.optedIn='false'`, `aliases='abc'`, `binding.status=false`. `address.label={privateProvenance:'QA_PRIVATE'}` та `location.paused` із таким об’єктом повернули вкладений marker. Actual canonical store з injected stored state теж повернув200, optedIn рядок і marker: дефект не обмежений mocked routes result. Окремий valid non-synthetic plan із `source.url` як об’єктом пройшов existing schedule validator та вивів marker. Потрібна runtime валідація scalar/enums/arrays/nullability всіх public DTO slots перед mapping, не лише видалення unknown property names.

**Addressed result:** на routes185c79b2… тільки literal null означає receipt miss; false/undefined/0/порожній рядок дають safe503 із same-ID guidance. Додано runtime primitive/array/enum/date/policy validators для public profile/address/house/aliases/binding/preferences/catalog/plan/source/interval fields. Ті самі malformed profile/source vectors, включно з actual canonical store через інертний SQL port, тепер503 без marker. Valid commit, source.url:null і genuine null recovery miss лишилися PASS. Source readback також підтвердив boolean replayed validation. Нова валідація не перетворює generic503 на заяву, що commit точно не відбувся.

Це **synthetic corrupted-state/trusted-port negatives**, не unauthenticated write exploit і не доведений витік реальних даних. Closed public mutation input у цьому ж suite відхилив owner/profile injection та object label до store. Саме відсутність production leak не робить malformed JSON безпечним для наступного cutover.

## Підтверджені межі й негативні сценарії

| Сценарій | Фактичний результат |
|---|---|
| Wrong actor / query owner | Auth/unsafe subject/query fields→401/400 до store; owner формується тільки з server principal. Foreign authenticated owner у actual-store route suite не отримує чужий profile і не змінює його. |
| Closed body / cancel confirmation | Owner/full profile/unknown mutation fields, false revision, object label та delete confirmed:false→400; store calls0. Закриття UI draft тут не перевірялось. |
| Valid commit / duplicate | Actual-store suite snapshot→rename→same-ID replay→same receipt, одна mutation/inbox row. Власний route probe зберіг exact app input ID і видалив unknown nested property names. |
| Stale / changed payload / wrong session | Actual-store suite повертає409; власний route probe підтвердив safe409 для ID/CAS/binding/address constraints без receipt. |
| Lost COMMIT response | Actual-store fixture окремо моделює saved і not-saved commit:503/recover_same_request; recovery відрізняє committed/miss; retry того самого ID дає одну logical transition. Private exception text у JSON не потрапляє. |
| Receipt integrity | Wrong channel/input/session, future receipt revision та committed:false не стають success. Null source object→503; valid source.url:null→200. |
| Runtime / fixture / activation | Foreign owner, simulated runtime/synthetic plan→503. Disabled/read_only не викликають canonical writer/recovery. Current policy відхиляє active, index не отримав автоматичного writer grant через наявність routes. |

## Exact initial pins

| Source | SHA256 |
|---|---|
| production/product-routes.ts | `7c46f1078455b6499558567474ec474ed5f87594b4eddf8e2576143edb5669d8` |
| shared/live-product.ts | `c47ff48741353f52ede9987f03220f907bc6048c0ba86cbab08c2363b0fe4655` |
| domain/profile-service.ts | `0c5e6b7871a3e45d83e39aba10449486fad937c3a0711b6a15e4d98574e9cfc4` |
| production/profile-store.ts | `830171887308ff0d06ccc62eafb02dc76b582c5aa95c0281741698045fb4bc9e` |
| tests/backend/live-product-routes.test.ts | `f57e4bd9c22ca325f5fac68a6c32cfc6ee9dd9da0b9825518857adfbf3a0bf36` |
| runtime-policy.ts | `d016d0aa29dff141678290f8e21385fdc5b5eb6a8ce1e406a3e4c14eae342ae3` |

## Фінальні addressed pins

| Source | SHA256 |
|---|---|
| production/product-routes.ts | `185c79b2696e1740dcee0b6941d04bcccfa9223f3c2915b4d3244713b9fe2990` |
| shared/live-product.ts, без змін | `c47ff48741353f52ede9987f03220f907bc6048c0ba86cbab08c2363b0fe4655` |
| production/profile-store.ts, consumed dependency | `9b4f216b11a6b1fc96e963f05046958534efe9dbc0c87391a8347b2222936373` |
| tests/backend/live-product-routes.test.ts | `3668132d7d0478f043e21be40e00a38eae2ce11a66c6ff5bdb7833770cc3867b` |

Domain/profile-service та runtime-policy у власному фінальному проході мають ті самі pins, що у initial таблиці. Consuming store не означає незалежне повторне приймання всього store; його окремі зміни та докази мають власних author/reviewer.

## Race, restart та handoff

Independent store reviewer `/root/v7_local_tools` на actual own PostgreSQL вже перевірив concurrent CAS1winner, concurrent identical input replay, recovery lock race, rollback та epoch/session/owner fences. Його `profile-store-pg.json`12/12 PASS має **окремий історичний store pin a6bb03ff…**, не поточний83017188…; це суміжний доказ, не мій actual PG запуск або безумовне приймання нових bytes. Current App suite доводить forwarding/CAS/error mapping, але не HTTP concurrency, Pg session identity або deployment old-writer fencing.

Процесний restart із реальною PG тут не запускався. Наступний конкретний integration vector: після committed та unknown response зупинити service instance, створити новий над тією ж disposable ledger, виконати exact receipt recovery тим самим full request, потім exact retry; очікується той самий receipt і одна mutation. Не міняти request ID та не приписувати outbox pending доставці.

Root handoff: AW-D1/AW-D2 закриті у bounded scope; initial failures збережені. Actual HTTP/PG root9 додає concurrency і shared-state proof, але не browser UI pending consumer, process restart, old deployment fencing або production migration. Далі окремо UI pending consumer, old-writer cutover/catalog/live ingestion/delivery та всі незавершені 17 feature dispositions. `migration.ready` тут означає лише editable profile, tools:false — не whole-product acceptance і не release/campaign grant.
