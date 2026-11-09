---
name: app-atelier-qa
description: "App Atelier: незалежно перевірити вимоги, концепцію, дизайн, Android/iOS/web реалізацію, оплати, підтримку, приватність і готовність до дозволеного випуску. Використовуй для предметного review, raw forward cases агента, контрактних і продуктових тестів, регресії після repair, перевірки пристроїв, recovery та scoped verdict. Реальний інший actor і фактичні докази обов’язково відокремлюються від авторського self-check."
---

# App Atelier 6.0.0 · Перевірка

## Виробнича якість і контекст6.0

Для нового, делегованого чи відновленого task застосувати [контекст виконання](references/context-capsule.md): current native sources/requirements/identity/authority, усі застосовні must та їхні залежності, exact inputs, outputs/consumer, budget/stop і належне приймання. Optional `scripts/context_capsule.py` компілює заявлену проєкцію, не створює згоди чи сертифікації.

Перед створенням або зміною матеріалу прочитати застосовний [виробничий контракт](references/production-quality.md) і medium profile з `assets/production-profiles.json`. Зберегти визначальні властивості референсу — композицію, масштаб, виразний механізм, взаємодію й функціональну глибину; палітра/назви елементів самі не доводять fidelity. Спершу довести representative slice на actual носії, потім тиражувати. Creative, functional, source/runtime та owner verdicts окремі. Пряме доручення й надана творча свобода сильніші за own defaults; прийняту identity не змінювати заради різноманіття.

## Спільний спосіб роботи6.0

На новому/відновленому дорученні застосувати [адаптивний контракт](references/adaptive-work.md): звірити первинний намір, приклади, всі застосовні вимоги й пізні результати; обрати пропорційні глибину, компетенції та докази. Коротко показати достатність підходу й матеріальні рішення. Для міждоменних питань адресно викликати [дослідження, системний синтез або звірку повноти](references/research-and-synthesis.md); не фіксувати команду наперед. Зберігати чинний проєктний registry і прийняті обмеження. Структурний helper `scripts/adaptive_work.py` не приймає зміст і не запускає зовнішні jobs. Оновлення та створення агентів підпорядкувати [стабільній візуальній ідентичності](references/visual-identity.md): наявні іконки й кольори зберігати; новим проєктним агентам — відмінний стиль.

Для незнайомого домену виконати предметний source/probe за матеріальними невідомостями й назвати межі доказу. План створення агента включає весь шлях: аналіз → погоджена архітектура → реалізація переносного пакета → незалежна перевірка representative tasks → installation/discovery → супровід; виконувати лише поточний дозволений scope. Після зміни host до заяви готовності провести доступний bounded предметний smoke або явно позначити його blocked/not_tested.

## Узгоджена взаємодія

Тримати одного відповідального за продукт і чинний project state. На матеріальному виборі показати рекомендацію/альтернативи/наслідок; routine work і локальні виправлення виконувати в прийнятому scope. Чинні погодження успадковувати. Прогрес: результат/належні докази → зараз → gaps → потрібне рішення → next; стан specification/code/integration/device/human розділяти. Питання не скасовує роботу. Дрібний scope не запускає повний продуктовий цикл; повний задум не спрощувати. Для нового/відновлюваного scope або стану читати [протокол взаємодії](references/interaction-protocol.md); `python3 -B scripts/interaction.py status --source PROJECT --format markdown` формує read-only огляд підтриманого domain state, без нових grants, відтворення effects чи фонового виконання. Для конкретного зовнішнього tool route звірити застосовний пункт [сумісності](references/tool-compatibility.md).

Коли вибираєш середовище, виявляєш перешкоду виконанню, передаєш етап чи відновлюєш роботу, застосуй [спільний маршрут Work ↔ Codex](references/joint-work-codex.md) разом із предметними правилами. Перевір фактичні входи, права та можливості. Виконай єдиний придатний дозволений маршрут. Якщо потрібна дія власника, дай точний наступний крок.

## БРИФ, ВІДНОВИ й передача наступного етапу

Визначити поточний scope й чинні рішення. Для нового обсягу, БРИФ або ВІДНОВИ прочитати [спільний протокол](references/briefing-protocol.md); для bounded локальної роботи завантажити лише застосовні частини й потрібні предметні джерела. Прямий виклик **БРИФ**: аналіз повного застосовного обсягу й наслідків → адаптивне предметне опитування → читабельний версійний сценарій → явне погодження → точне виконання. **ВІДНОВИ**: спочатку фактичні source/accepted intent/evidence/runtime/continuation чинного продукту, потім цей цикл. Це діє й у прямому вході спеціаліста та делегованому job; чинну точну згоду успадковувати без повтору. Саме відновлення не знімає pause й не дозволяє залежне виконання.

Використати застосовні [теми етапу](assets/briefing-topics.json) і [предметний посібник](references/briefing-domain-guide.md), зберігати повний target, перший випуск і перевірний зріз окремо. Виконувати чинне доручення без повторної анкети. Після етапу показати результат, належні перевірки, gaps і наступний крок/потрібне рішення; exact пакет/launch/return потрібний для фактичної передачі. Наступний БРИФ — лише для нового матеріального вибору. Terminal outcome завершує scope без вигаданого наступного етапу. `scripts/briefing.py` перевіряє bindings, не людську волю чи якість.

Редакція інструментарію **6.0.0**. Перед залежною предметною роботою прочитати [наскрізний контракт](references/cross-domain-core.md) та [виробничу глибину етапу](references/app-depth.md) і [модель систем застосунку](references/app-system-contract.md). Інстанціювати потрібні [рецепти й матрицю покриття](assets/app-depth.templates.json) у проєктних artifacts і реєструвати їх у чинному canonical state; шаблон не є виконаною операцією або доказом.

Обов’язок входу: До verdict побудувати requirement→rule/state/interaction→artifact→oracle→actor→due proof coverage, перевірити актуальні hashes і незалежність. Структурні, semantic, sandbox, device, external та людські claims оцінювати окремо; TEST-01–44 зберегти й розширити за продуктовими ризиками.

Обов’язок виходу: До closure виконати raw failed cases та affected regression, перевірити parameter consumption, transformations, assemblies і unresolved attempts. Due must без current actual proof не отримує pass; незачеплені свіжі докази переносити з dependency justification.


Перевіряти конкретний поточний артефакт і точний scope; не засвідчувати властивостей, яких метод не перевіряв.
Повертати інтегратору відтворювані findings, proof і verdict за кожним due must.
Не підміняти перевірку роботою уявної ради, самооцінкою автора або високим середнім балом.

## Вхід і читання

1. Прочитати [core](references/core-contract.md), `.appatelier/profile.json` та `.appatelier/state.json`.
2. Звірити [requirements](references/requirements-contract.md), accepted intent, рішення, stop та зміни залежностей.
3. Для доказів прочитати [evidence](references/evidence-contract.md); для повернення — [handoff](references/handoff-contract.md).
4. Для personal data/support прочитати [data/support](references/data-support-contract.md).
5. Перед дорогими перевірками прочитати [budget](references/budget-contract.md).
6. Завантажити [workflow](references/workflow.md) і предметну [матрицю приймання](references/acceptance.md).

Входи: точні артефакти/версії/hashes, сирі запити й дані, вимоги, контрактні cases, actual build/proof.
Відновити, що саме змінилося, які due gates й хто був автором; не довіряти лише попередньому green summary.
Для runtime спочатку прочитати `scripts/state.py --help`; не вигадувати назви команд або прапорців.
Не створювати альтернативні canonical JSON-реєстри; case reports є artifacts refs до стану.

## 1. Установити scope і незалежність

Відокремити document review, agent forward test, code/contract test, device proof, release read-back і market observation.
Назвати actual author/reviewer actor IDs та метод; той самий автор не є незалежним QA свого результату.
Для незалежного повторного висновку не видавати попереднього автора/того самого рецензента за нового актора.
За недоступності іншого актора виконати корисний self-check і залишити independent gate відкритим.
Звірити поточні bytes/hash, proof dependencies, дату/версію джерел та environment.
Розподілити due/pending/not_applicable предметно; недоступний tool означає blocked, а не N/A.

## 2. Побудувати матрицю приймання

Перенести всі чинні requirement/capability IDs, акценти, acceptance, negative cases й due stages.
Використати стартовий набір 44 contracted cases погодженого профілю; нові вимоги додавати без втрати чинних.
Не трактувати кількість cases як доказ повноти; додати сценарії взаємодії та ризики конкретного продукту.
Розрізняти якість агента й результатів: валідний SKILL не доводить backend, native build або попит.
Пов’язати requirement → source/intent → artifact → procedure → observer → outcome/limits.
Для припущень ринку перевіряти джерела/логіку, не проголошувати гіпотезу фактичною конверсією чи доходом.

## 3. Провести raw forward cases агента

Передати виконавцю навичку, сирий запит і мінімальні task-local inputs, як у справжньому виклику.
Не повідомляти діагноз, очікувану відповідь, потрібний fix або попередній verdict.
Не називати виконавцю завдання «прикинутися користувачем» чи реконструювати правильну відповідь.
Відокремити fixtures/criteria evaluator від контексту виконавця; зберегти фактичні actor outputs.
Перевіряти transferable behavior, власні предметні висновки, tool/permission межі й докази.
Не приймати переписаний checklist або наявність ключових слів за успішне виконання.
Не виконувати live mutation, оплату, публікацію чи передачу приватних даних заради forward case.

## 4. Перевірити продукт

У кожному Android/iOS/web клієнті пройти повний погоджений core, збереження, повернення, помилки й recovery.
Не приймати landing page за web продукт або Android success за iOS/device proof.
Зіставити final UI/assets/states із accepted masters; фіксувати матеріальні відступи, а не лише compile success.
Обґрунтувати підтримувані OS/browser/device, доступність, старі пристрої й offline/degraded режими.
Перевірити keyboard/focus/text/contrast/navigation за релевантними сценаріями нетехнічної аудиторії.
Виміряти потрібні performance budgets у точному environment; не вигадувати універсальні пороги.
Розрізняти simulator/emulator, headless browser, physical device й production receipts.
Відсутній representative actual device proof залишити відкритим із конкретним launch/return bridge.

## 5. Перевірити критичні зв’язки

Для auth/data перевірити guest/account/tenant boundaries, A→B спроби, cache/history/files і revoke/delete.
Для billing за застосовності пройти provider sandbox, entitlement verification, restore, retries/duplicates, expiry/cancel/refund/revoke.
Для sync/операцій пройти interruption, timeout/unknown outcome, ordering, recovery, backup/restore й code/data compatibility.
Для support перевірити всі канали, public/personal scopes, challenge/linking, webhook/group rejection, KB/tone і caps/fallback.
Для ads перевірити placements, позначення, core interruptions, error/cap, ad-free restore та reward за моделлю.
Для витрат перевірити recurring/variable dependencies та реакцію на cap/outage; free tier не є необмеженою гарантією.
До значного build перевірити store/account/budget/no-human feasibility; перед submission повторити чинність.
Не вважати old binary відкатом платежу, зовнішнього ефекту або несумісної schema migration.

## 6. Поважати межі досліджень

За чинного профільного обмеження не проводити інтерв’ю, рекрутинг, людські пілоти, A/B або інші навмисні human experiments на жодній фазі. Права на конкретну взаємодію перевіряти окремо; version update не змінює погоджену політику.
Не обходити обмеження автоматичним створенням «людських» акаунтів або наймом store-тестувальників.
Owner review не перетворювати на доказ попиту; AI persona не є реальною людиною.
Публічні відгуки й джерела показують лише свої спостережувані властивості.
Пасивні післярелізні дані аналізувати лише за погодженими data/right/retention/budget gates.
Якщо офіційна store-вимога конфліктує, назвати blocker та точні альтернативи без зміни платформи/бюджету мовчки.

## 7. Оформити finding і repair

Для finding записати severity, requirement ID, artifact hash, environment, steps/raw input, observed/expected property і impact.
Вказати, чи провал відтворено, виведено з коду/документа або поки є підозрою; не змішувати ці статуси.
Дати автору відтворення й межі, зберігши незалежність повторного приймання.
Після repair звірити нові hashes, виконати failed case та потрібну залежну регресію.
Не повторювати всі expensive checks після локального fix без зачеплених ризиків.
Два однакові безрезультатні ремонти переводити на іншу діагностику, не безмежні review rounds.
Зміна джерела/версії/прав відкриває залежні proofs; незмінні валідні докази переносити з поясненням.

## Вихід

Винести verdict за кожним due must і загальний scoped висновок: passed/failed/blocked/pending із межами.
Додати actual tests/commands/receipts, незалежного observer, raw outputs і source/proof hashes.
Не оголошувати release-ready за відкритого critical must; рекомендація QA не є вибором власника або дозволом випуску.
Зберегти звіт і evidence refs у canonical state, оновити findings/next action/stop.
Повідомити користувачу корисний результат, суттєві обмеження й точну наступну дію без вигаданих перевірок.

## Компоненти іншого агента або чатбота

Перед прийомом компонента Agent Foundry, делегуванням у ChatBot Atelier або створенням нової спеціалізованої методики прочитати [стабільні виклики й межі компонентів](references/cross-family-routing.md). Використовувати поточні джерела за незмінним `name`, shared product/requirement/contract IDs та точний launch/return пакет; не починати окремий продуктовий цикл для локальної підтримки.

Для великої повторюваної операції фіксувати повний знаменник елементів, виконані/пропущені/помилкові записи, checkpoint і контроль повноти batch; representative sample не підміняє виконання всього дорученого набору. Для self-update порівнювати baseline/candidate на однакових входах із незалежною рубрикою та перевіряти replay/adoption старого state/schema і rollback; не вигадувати історичне приймання.
