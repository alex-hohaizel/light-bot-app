# Операційний протокол

Зміст: scope → input/current state → blueprint → target construction → jobs → effects → пауза → transfer.

## Сфера інструмента

`scripts/foundry.py` — внутрішній Python CLI для versioned стану, graph/coverage, source pins, approval, readiness та запису фактичних результатів. Він не розуміє природну мову, не генерує предметний зміст, не викликає зовнішні tools і не створює повноваження. Природний намір, domain research, компетенції й реальні дії виконує агент. Кожне поле authority/evidence має відповідати фактичній відповіді чи спостереженню.

Перед використанням прочитати `python3 -B <ACTIVE_SKILL>/scripts/foundry.py --help`, потрібний subcommand help і [records](../assets/runtime-records.json). Підставляти фактичний активний шлях зі списку навичок; чужий шлях не є інструкцією для користувача. Локальний стандартний runtime потребує сумісного Python і POSIX locking; фактично перевірені ОС/версії зазначаються в поточному QA, не вгадуються.

## Окремі session roots

Factory session і product execution session мають різні явно обрані roots/purpose. Для існуючого проекту вибрати окрему робочу папку конструктора; вона не перезаписує product state або accepted packages. `init` створює новий ledger, не мігрує довільні старі записи й не обирає компетенції за користувача. Файли canonical authority зберігати й pin-ити; не переписувати стару відмову в нове схвалення через sidecar.

Після імпорту звірити raw bytes/версії/права/source й відокремити historical metadata від поточних згод. Archive paths/symlinks/resource caps перевіряти; inbound code не виконувати. Великі матеріали передавати контрольованими частинами або versioned artifact storage з hashes/recipe, а не вимикати перевірку чи губити originals.

## Паспорт до gate

Агент заповнює фактичний blueprint за [архітектурним контрактом](architecture-contract.md), зв’язує всі capabilities, фазовий DAG, roles/components/outputs/tests, discovery applicability, questions і constraints. Число фаз не визначає число skills. Структурний check потрібний, але предметну повноту й якість підтверджують людина та reviewer.

Читабельний паспорт і список складових показати **до** створення target skills. Approval record pin-ить exact blueprint ID/revision/content hash/scope і реальне джерело позитивної відповіді. Не записувати fake approval, не використовувати заповнений template як згоду. Змінився матеріальний зміст або залежне knowledge/authority — звірити impact і відкрити адресний delta. Негативне, pending, revoked або stale approval не дозволяє build.

Перед authoring, перед дорогим dependent job та перед пакуванням виконати актуальний `build-gate`. Перевірка дозволяє лише конкретний scope конструкції; вона не запускає нічого сама. Після gate агент користується Skill Creator й предметними tools, фактично створює outputs, виконує QA, реєструє artifacts/evidence і перевіряє bundle проти approved entry/skillset/coverage. Шаблон із відсутнім змістом не є ready target.

## Виконання створеним агентом

Виконання продуктового scope потребує окремого actual execution grant із поточною метою/межами/phase IDs. Він може походити з тієї самої відповіді, якщо користувач явно доручив і створити, і виконати; scope не розширювати інтерпретацією. Blueprint acceptance не підміняє execution permission.

Для кожної work unit: concrete goal/owner/skill, current source, exact inputs/dependencies, фазові передумови, due requirements/decisions/evidence/capabilities, outputs, limits і stop. `readiness` перевіряти перед `start`; `complete` після actual output/proof/closure. Pending requirement, над яким task працює, не блокує його створення завчасно, але заявлене fulfillment має закритися до completion. Готовність попередньої фази або scoped prerequisite evidence не можна обійти пропущеним depends_on.

Завершення pin-ить outputs, proofs і залежності. Зміна bytes/knowledge/source/permission відкриває відповідні tasks/reviews. Бounded self-check не стає незалежним pass; де потрібний незалежний review — відповідний gate явний. Новий предметний must створює свій acceptance і due gate, а не загальну нотатку в кінці.

## Зовнішні effects

Підготувати конкретний результат для рішення, перевірити actual capability/environment/target, outputs/hashes/parameters і чинну позитивну authority. Effect approval відділене від blueprint та execution grant; scope і bytes точні. Згода на відмовний варіант не є дозволом.

Спочатку запис pending/dispatch, потім один actual tool call, потім actual receipt/provider proof. Runtime не виконує effect. Збої, missing receipt і unknown outcome не означають невиконання: read-only status/reconciliation перед retry. Provider idempotency/deduplication застосовувати за підтримки; local state не є distributed exactly-once гарантією.

## Пауза, контекст і повторне відкриття

Звіряти stop перед залежною дією. Now блокує нові jobs; future boundary зупиняє на точному artifact/phase. Active pause не скидається новим формулюванням або future-stop. Безпечно записати повернений receipt/checkpoint дозволено; почати нову роботу за stop — ні.

Зберігати читабельний current brief: завершене/поточне/pending, exact source/blueprint versions, questions, gaps, real jobs/effects, limits, next allowed action/host/return. Context вибирає актуальні записи й залежні джерела; це не автоматична семантична пам’ять всіх проектів. Перед resume — files/hashes/knowledge/permissions/external outcomes; не відтворювати завершені effects.

Інцидент, невелика зміна чи нове знання відкривають зачеплений фрагмент, не весь конструктор заново. Зміна suite має compatibility review й declared impact; routine compatible cleanup не потребує нової анкети користувача. Матеріальна зміна компетенцій/права/якості/вартість — точне адресне рішення.

## Доставка й manual return

Кожний потрібний перехід має читабельний пакет, actual files/hashes/checkpoint/authority, конкретні launch steps, working path, argv чи перевірені UI дії, expected outputs/receipt і return validation. Відсутня можливість ізолює конкретний blocked scope. Зберегти користувачу один next step; не вимагати вибирати назви модулів або повторювати вже наявні джерела.

Exit/status CLI тлумачити за actual help/record contract. Успішний запис стану не доводить, що людина щось схвалила, інструмент виконав дію, матеріал має потрібну якість або продукт працює наживо. Ці твердження потребують власних відповідних evidence.

## Чинний контракт: admission і checkpoints виробництва

Перед work unit звірити operation/recipe IDs, current material parameter support/consumption, consumer і ресурси. У checkpoint додати maturity, depth model path/hash, operation/recipe/attempt refs, reserved unknown cost, assembly/evidence gaps та exact next validator. Дані attempt залишаються у project ledger; reusable source не містить поточних provider IDs або secrets. Recipe/semantic inputs/importer/target profile/rights change відкривають залежні outputs/proofs; source master не змінюється без причини. Після двох однакових repair без прогресу змінити гіпотезу або повідомити точний blocker. Resume спочатку reconciles незавершений effect, потім продовжує дозволений node.

## Короткий керівний огляд

На матеріальному рубежі сформувати [read-only огляд](interaction-protocol.md) з чинного state. Для малої правки коротко показати actual diff/перевірку/результат, без повного нового продуктового циклу. Чинне точне доручення залишається в межах своєї authority; локальний стан/шаблон не надає нового дозволу. Власник бачить рішення з наслідками; технічні подробиці та raw traces доступні за потребою.
