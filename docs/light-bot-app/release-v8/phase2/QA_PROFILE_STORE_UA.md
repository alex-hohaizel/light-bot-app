# Незалежний QA canonical profile store

Reviewer `/root/v7_local_tools`, 2026-11-08. Не автор store/reader. Початкове доручення охоплювало read-only source/pure review; root окремо дозволив власний disposable PostgreSQL через `withProofDatabase('profile_store',55438)`. Продуктовий код не змінено, production/Telegram/API/token не використовувалися. Старі 68 must, профілі та поточний scope залишаються чинними. Це bounded store acceptance, не готовність усього продукту.

## Findings

**F1 · P2 · addressed.** Початковий `f10a01a3…` використовував REPEATABLE READ для recoverReceipt: control SELECT встановлював snapshot до очікування owner lock. A міг зберегти inbox, поки B чекав, але B після lock повертав null зі старого snapshot. Це неправильний «confirmed ledger miss»; same-ID durable retry все ще захищав від повторного переходу, тож доказу double send не було. PostgreSQL фіксує RR snapshot на першому non-control statement, а наступний SELECT не бачить пізніший commit. [Офіційна PostgreSQL документація](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-REPEATABLE-READ).

На `33e57453…` recoverReceipt виконує READ COMMITTED зі збереженим control-share → owner lock → exact inbox read. Actual two-client probe спочатку підтвердив через pg_stat_activity, що B **дійсно** чекає advisory lock A; після A commit receipt знайдено. Негативний контроль тільки в QA wrapper підмінив BEGIN B на RR і відтворив null. Продуктовий код для цього контролю не змінювався. F1 закрито в цьому exact scope.

**F2 · P2 · addressed.** Початковий outbox ORDER BY created_at,ordinal,id перемішував turns за однакової мітки часу: обидва ordinal0 перед ordinal1. Inert author port не виконував SQL sorting, тому цього не ловив. На `33e57453…` current-session/current-epoch filter та ORDER BY revision,ordinal,id перевірено actual PG: два `/notifications_off` з тим самим serverNow мали ≥2 messages кожний і поверталися суцільними turns. Це доказ порядку читання outbox, не порядку фактичної мережевої доставки; sender має його зберегти.

**F3 · P2 · addressed у перевіреному manual-display scope.** На `33e57453…` store пов’язував **показ** будь-якого плану з verified personal binding та відкидав user_selected_group. У actual synthetic state встановлено manual group/needs_confirmation, а trusted context надав exact operator/namespace/target/date/binding-revision technical plan з deliveryEligible:false. Direct existing engine показав schedule1; store snapshot мав plans0, durable outbox — schedule0. На [новому source:236](</Users/admin/Projects/LIGHT BOT APP [CODEX]/app/server/production/profile-store.ts:236>) додано окремий manual technical display path: user_selected_group/needs_confirmation, exact owned scope, today/tomorrow, current/nonfuture observation/publication, non-synthetic admitted-level source і deliveryEligible:false. Actual повтор дав snapshot1/outbox schedule1; personal delivery не активовано. Інші unverified binding не отримали автоматичної сертифікації: повний legacy/address migration та його UX залишаються окремою роботою. Це закриття конкретного manual-view дефекту, не всіх функціональних вимог.

**F4 · P2 · addressed.** На `33e57453…` store закривав зовнішні keys payload, але потім clone/cast експортував весь payload.message. Actual PG negative control додав synthetic privateToken усередині message; pendingOutbox повернув extra field без відмови. Це не unauthenticated HTTP writer або доведений production leak: контроль навмисно моделює корупцію/майбутнє розширення збереженого JSON. Нові [storedMessage/storedSchedule](</Users/admin/Projects/LIGHT BOT APP [CODEX]/app/server/production/profile-store.ts:122>) перевіряють nested closed message/buttons/schedule/source/interval keys, зберігають legitimate optional previous-plan поля та перевіряють schedule linkage. Actual той самий negative control тепер відхиляється; extra field не експортується.

## Фактичні докази

Фінальний перевірений адресований source:

| Файл | SHA-256 |
|---|---|
| profile-store.ts | `a6bb03ff865dc02f5e84d972ca47521061e3a60e05b736352981baa8b4c89913` |
| profile-reader.ts | `bdcdcbba56733ad661b777cfdbc13572e38b76978a828779066725441210e664` |
| legacy-profile.ts | `cdd1b91905ce2cf2ec1540a9fc8e7e7c63bd7541af5a75589f9c853dc19d618e` |
| live-profile-store.test.ts | `802da85f2068bf7ccb1bee3df279084855f6fb1084eb771cf2f5c2ee5074da1b` |
| tools/lba_v8_profile_store_pg.mjs | `b858d200700e489f0ceb8748d63dd33f364294911bc08c40fac3d914d0fe7c93` |
| phase2/profile-store-pg.json | `992cace852eab0154e4bd8d22d73557edca8fb6fbcded069691bbd1c072d3540` |

Actual target: fresh `lba_test_profile_store`, 127.0.0.1:55438, random local credentials лише в пам’яті helper. SQL fixture schema/rows взяті з попереднього root probe як схема, значення synthetic. Початкова sandbox спроба зупинилася на initdb shared memory до старту сервера; дозволений escalation повтор завершився. Helper await-stop виконався, clusterStopped:true. Production writes0, real provider requests0, HTTP0. Усі sourceBefore/sourceAfter pins збігаються.

**12/12 основних actual PG груп PASS**: missing/disabled/wrong epoch gate; точний legacy bootstrap/origin/ledger/owner; concurrent CAS; identical provider input replay; RC recovery race та RR negative control; same-ms turns; saved/not-saved COMMIT uncertainty; rollback після state update; trusted empty-account proof/tombstone (включно з fully-shaped wrong-owner proof); exact owned source pinning/foreign/synthetic denial; owner/session/epoch outbox fences; незмінність усіх первинних legacy SQL rows. Окремі actual F3/F4 addressed controls PASS. Початковий proof `b808890a…` та driver `fb03e346…` збережені у `phase2/private/profile-store-pg.initial.json` / `profile-store-pg.initial-driver.txt`; первинні findings не перезаписані історично.

Independent query-port harness у `phase2/private/profile-store-probe.mjs` повторив addressed F1/F2/F3/F4 без БД/мережі: 4/4 PASS на final a6bb03ff…, source drift0. Це додатковий regression route, а не заміна actual PG. Його перша спроба мала помилку самого owner-index SQL fixture для INSERT outbox; fixture виправлено, продукт не змінювався.

Незалежно повторено авторські store+reader tests: **36/36 PASS**. Scoped strict tsc з ESNext lib, як у project tsconfig, PASS. Логи — `phase2/private/profile-store-author-tests.log` і `profile-store-typecheck.log`. Початковий tsc invocation без ESNext lib не мав Array.findLast types; це уточнення QA command, не source failure.

## SQL і production межі

Розглянуто actual SQL і frozen reader: параметризовані owner predicates; closed verified principal shape перед DB; control-share/epoch/owner advisory lock; state owner/session/revision cross-check; SQL CAS update; однотранзакційні state/inbox/outbox/cancellations; постійний input digest/replay conflict; SELECT-only legacy helper; additive opt-in schema без autoDDL/control seed; independent bootstrap ledger; current-session/current-epoch outbox. У перевірених vectors не знайдено cross-owner mutation/read bypass, double commit, automatic reimport або fake sent claim.

Структурний principal сам не автентифікує людину. Control row сам не фехтує старий deployment. Немає production dispatch/claim/ack, scheduler event writer, legacy dual-write cutover, підтримки всіх tools/effect handlers або rollback routing. pendingOutbox є тільки читанням, а не grant на send; current policy/address/binding/consent й one-sender fence треба перевіряти в durable sender перед effect. Ці межі не оголошені N/A або виконаними через цей QA.

Exact next action: root інтегрує цей exact source у authenticated service й durable sender, окремо доводить legacy writer fencing, grants/revocation, delivery, rollback та release acceptance. Поточний bounded verdict: **F1/F2/F3/F4 addressed у зазначених vectors; нових конкретних defects у перевіреному scope не залишилося. Live activation і всі 68 вимог цим QA не приймаються.**
