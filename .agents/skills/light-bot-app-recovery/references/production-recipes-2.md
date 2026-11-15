# Виробнича система Agent Foundry

Зміст: записи → admission → рецепти → спроби → assembly → handoff. Читати до вибору інструментів, авторингу target skills, їх виконання, пакування та зміни інтеграції. Прикладні класи — початкова таксономія, не вимога використати всі.

## П’ять пов’язаних записів

1. **Capability:** конкретна операція, provider/tool/model/version/host, actual schema/catalog, inputs/outputs/limits, unsupported fields, parameter consumption, editable sources, доступ/права/data scope/cost, observed evidence та freshness triggers. `candidate`, `descriptor_seen`, `configured`, `operation_tested`, `integrated` — різні claims; discovery не доводить тест.
2. **Recipe:** requirement IDs, accepted inputs+hashes, компетентний owner, consumer, exact bound argv/API fields або numbered GUI procedure, ordered DAG, output/master format, validators, limits, effects, fallback/repair/stop. Незаповнений template не виконується.
3. **Transformation:** source/target, semantics/units/IDs/time/precision/privacy, preserved invariants, дозволені втрати, actual mapping, validator/oracle/tolerance.
4. **Attempt:** stable identity перед effect, recipe/input/toolchain digests, actual arguments, request/job refs, append-only observations, status/cost/outputs/receipts, reconciliation і retry relation. Немає вигаданого run ID для плану.
5. **Assembly:** exact output/component/config/version, bindings, scenario, expected vs observed outcomes, proper evidence modality, author/reviewer, gaps і acceptance. Присутність окремих файлів не доводить цілісну користь.

## Admission та ресурсна дисципліна

Перед node перевірити чинні inputs, operation capability, unsupported material parameters, authority, бюджети, consumer, доступність компетенції й ресурсу, single-writer ownership. Cheap schema/types/ref checks перед дорогими генераціями, builds чи зовнішніми jobs. Зайнятий ресурс не звільняється лише від lease timeout без перевірки фактичного стану. За material gap блокується залежний scope, незалежні роботи продовжуються.

Tools/skills обирати після читання їхніх фактичних контрактів. Каталог не гарантує конектор, установка — доступ, доступ — дозвіл, а підписка — оплачені сторонні API. Порівнювати придатні маршрути за must, правами, керованістю, maintenance і витратами. Framework/SDK/RAG/backend/database — умовний вибір, не список престижних назв.

## Сімейства рецептів

| Клас | Конкретний алгоритм і приймання |
|---|---|
| AF-R01 Намір→паспорт | Чинні sources/accepted originals→карта області та застосовності→requirements із негативними cases→альтернативи→M1 blueprint→точний список компонентів/витрат/невідомостей→реальна відповідь на exact revision. Source completeness та предметний review окремо. |
| AF-R02 Паспорт→спеціалізація | Approved capability→компетенція/межі→вузький trigger/workflow→предметні rules/data/recipes/fixtures→self-contained shared core→UI metadata→syntax/link/contract checks→raw forward task. Наявність YAML не доводить компетентність. |
| AF-R03 Дані→знання | Правомірне джерело/версія→parse з provenance→структурування/нормалізація з втратами→IDs/index→targeted retrieval→актуальність/конфлікти/видалення→answer із джерелом. RAG індекс — похідний, не друга authority; retrieval precision/recall оцінити на власному корпусі. |
| AF-R04 Правило→код/adapter | Typed rule/state/oracle→reference fixtures→обрані модулі/сумісні бібліотеки→input validation/authz→domain implementation→API boundary→unit/property/integration→actual consumer scenario. Очікуваний результат визначити незалежно від коду; parser pass не є integration pass. |
| AF-R05 Намір→зовнішня дія | Чинний scope/дані/одержувач→reviewable parameters/output→capability/auth check→pending key→один submit→receipt/read-back→reconciliation unknown→durable closure. Provider idempotency лише за підтримки. Кінцевий effect має власне спостереження. |
| AF-R06 Матеріал→модальність | Прийнята поведінка/identity/state inventory→правомірний source/master→редагування/генерація→export/import→actual channel playback/render/use→semantic+perceptual review. Застосовувати лише потрібні текст/зображення/звук/відео/3D канали. Format metadata не доводить якість сприйняття. |
| AF-R07 Джерело→пакет→host | Прийнятий exact skill set→contained files/modes/hashes→manifest/guide→preflight/dry-run→backup/conflict resolution→apply/verify→host discovery→safe invocation→validated return. Один source, перевірені exports; Work/Codex мають окремий capability profile. |
| AF-R08 Випуск→експлуатація | Exact deployed artifacts/config/schema→реальний release receipt→перша корисна дія→тільки дозволені observations→incident impact→bounded repair/retest→compatible update/rollback→checkpoint. Runbook не доводить запущений monitoring; service-loss/exit/export path визначити до залежності. |

У recipes параметри з прикладів інстанціювати під конкретний предмет і доступну актуальну операцію. У межах однієї capabilities grammar охопити normal/empty/edge/invalid/concurrent/late/cancel/retry/resume та потрібні locale/platform/user-role variants. Не замінювати повний каталог кількома красивими прикладами. До заяви великої спроможності провести виміряний end-to-end цикл одного репрезентативного елемента; записати фактичний час, вартість, частку ремонту й bottleneck. Не екстраполювати малий sample у гарантію.

## Attempts, cache та ремонт

Запис pending до costly/remote operation, actual job ID одразу після submission. Timeout означає unknown; cancel request — pending cancel. Зберегти reserved cost до reconcile. Нову спробу не створювати для невідомого старого effect без перевірки provider status/outputs. Append новий verdict, не переписувати старий fail.

Класи ремонту: input_contract, unsupported_operation, generation/craft, format, semantic_conversion, integration, environment/access, transient_provider, acceptance_defect. Кожна спроба має гіпотезу, змінену змінну, очікуваний наслідок і наступну перевірку. Дві однакові безрезультатні спроби змінюють діагностику/метод або точний blocker; cap не знімає must.

Cache key: semantic inputs+hashes, recipe revision, actual operation/model/toolchain/exporter/importer, parameters, target profile, права/data scope. Зміна importer відкриває derivative/proof, прийнятий master з незмінними bytes зберігається. Нові terms/access/schema/source/authority — freshness triggers. Reuse не створює нову незалежність чи вищу доказовість. AI opaque operation не обіцяє bitwise regeneration.

## Приймання складання й переходу

До scenario pin-ити components/config/model/inputs і середовище. Перевірити complete user job, видимий результат, помилку/скасування/відновлення, правильність даних/прав, ресурси й залежні канали. Structural, semantic, domain, integration, human/device, operational/business verdicts окремі. AI critique не є user study, latency simulation не є production observation, факт відправлення не є бізнес-результат.

Host bridge: reason/scope, producer/consumer host, preflight, exact inputs/hashes/cwd, підтримувані steps/argv, permissions/secret refs без values, очікуваний результат/receipt, return files/hashes, validators і next action. Return перевірити перед ready. Не вимагати від користувача повторного опису відомого чи ручного вибору внутрішніх модулів.
