---
name: chatbot-atelier-qa
description: "ChatBot Atelier — Незалежне предметне QA: незалежно перевіряє вимоги, повну модель, розмову, пам’ять, дії, медіа, runtime та готовність чатбота за фактичними доказами й негативними сценаріями. Використовувати для відповідного етапу нового бота або розвитку чинного в Work чи Codex; усі наявні можливості зберігати."
---

# ChatBot Atelier 6.0.0 · Перевірка

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

Інструментарій **6.0.0**. Працювати українською, якщо користувач не визначив іншу мову. Виконувати свій етап повністю за предметною областю, реальними capabilities і чинним наміром; не обіцяти runtime/live/human результат за текстом чи схемою.


## Канали, поточні формати й компонентні входи

Для нового бота спочатку визначити обраний канал за наміром: Telegram, Instagram, Slack, Discord, WhatsApp, Teams, web або інший; не підставляти Telegram за замовчуванням. Для чинного бота відновити канали з repo/config й підтверджених рішень; не повторювати вже відомий вибір. Неоднозначну назву уточнити. Для нового каналу або зміни його можливостей прочитати [платформні адаптери](references/platform-adapters.md) і потрібні [офіційні джерела](references/platform-sources.md); для відомого незміненого каналу взяти прийнятий adapter contract та оновити лише зачеплені або неперевірені операції. Поточні записи вести за [форматами](references/protocols.md). Усі прийняті journeys мають selected adapter contracts; MCP/API/connector доступність та права перевіряти по конкретній операції.

`python3 scripts/check_platform_adapter.py ADAPTER.json` і `python3 scripts/check_round.py ROUND.json` перевіряють поточні записи, не фактичний live результат. `chatbot.blueprint/3` містить `platform_adapters` та `adapter_ids` користувацьких journeys; старі формати не читаються. Для компонента застосунку/складеного агента приймати [atelier-component-handoff](assets/component-handoff.template.json) і виконати `python3 scripts/check_component_handoff.py HANDOFF.json --root PROJECT_DIR`; зберігати authority/IDs/shared contracts/permissions батьківського продукту. `@agent-foundry`, `@app-atelier-director` та модулі ChatBot Atelier визначаються стабільними іменами й поточною доступною версією.


## Початок

Прочитати [наскрізний контракт](references/cross-domain-core.md), [повний контракт цього етапу](references/stage-contract.md), [маршрути й команду](references/lifecycle-and-team.md). Поточний проєкт/checkpoint/source й права відновити до змін; локальний ремонт не починати з нового research. Вхід: користувацький намір/requirement IDs, актуальні матеріали/версії, applicability/невідомості, дозволи, target і критерії завершення.

Побудувати потрібний зв’язок requirement→formal domain contract→operation→recipe→actual attempt→integrated journey→evidence. Застосувати [точні доменні контракти](references/domain-contracts.md), [виробничі рецепти](references/production-recipes.md), [якість та супровід](references/quality-and-operations.md), [Work/Codex](references/work-codex.md). Потрібний відсутній інструмент — gap, не N/A. Пропорційність orchestration не зменшує повноту вимог.

## Предметна робота

## Незалежний intake

Отримати frozen requirement/source IDs, exact artifacts/diff/hash/env/model/config/target, assigned scope, baseline, expected positive/negative results. Не приймати author «усе pass» за доказ. Незалежний reviewer не змінює implementation мовчки; repair окремий artifact, потім addressed retest. Назви ролей не доводять виконані reviews.

Матриця24 companion requirements і26H/12J за applicability; кожен active має verdict/evidence/strongest objection/uncertainty/reversal condition. Невідоме не unchanged/pass. Hard privacy/consent/false outcome/resource/version failure не компенсується high naturalness score. Structural validator/schema pass не доводить фактичну людську згоду чи provider receipt.

## Негативні сценарії й перетини

Відтворити ingress/callback/tool→state→effect→delivery/recovery. Inject duplicate/stale/wrong actor, cancel before/after dispatch, source/spec/privacy version race, partial failure, timeout after provider success, crash/restart, forget/revoke/restore, DST fold/gap, resource exhaustion. DM/group/cache/error/progress/export leakage перевірити на same trace. Knowledge evals: ACL/citation/retrieval/factuality/abstention окремо; external prompt injection не змінює права.

Conversation:8 frozen strata, minimal pairs, wrong speech/silence/referent/extra questions, supported locales, complete action+dialogue. Human blind naturalness evaluation окремо. Media: frozen final bytes, decode, all changed motion/audio/identity/loop/order/manifest; samples не доводять entire pack. Platform/mobile smoke/live readback і actual deployment identity окремо.

## Висновки та closure

Finding: ID/severity/requirement/source file:line/reproduction/expected-vs-actual/actual evidence/proof limits/causal hypothesis/falsifier/proposed fix/retest/residual unknown. Класифікувати reported/reproduced/hypothesis/preference/duplicate; необов’язкове покращення не блокує scoped repair. Жодного fabricated test/human/source/receipt.

Carry-forward лише за unchanged transitive source/code/schema/tool/model/generator/env dependencies і valid freshness, immutable prior review receipt, independent impact check. Same QA може retest fix; final adjudicator не автор/попередній QA. Після двох повторів без new information змінити diagnostic approach; не оголошувати pass за лімітом. Deliver scoped GO/NO-GO/unknown, actual commands/results, evidence and release boundaries.

## Зберегти можливості й довести scope

[24 критерії співрозмовника](assets/requirements.json) і [детальні доменні правила](references/evolution-domains.md) збережено всередині сімейства. Для існуючого бота вести active/unchanged impact усіхIDs; unknown не unchanged. Профіль, груповані незалежні reviews і локальне завершення описані в [team-policy](references/team-policy.md). [Перенесення розвитку](references/evolution-contract.md) пояснює маршрути без окремої зовнішньої навички.

За full scope зберегти round.json і виконати `python3 scripts/check_round.py /absolute/path/round.json`; чинні команди `teamctl.py plan`, `hashes`, `freeze` описані в [доказах](references/evidence-and-delivery.md). Структурний pass не доводить природність, private consent, actual effect чи delivery. Читати лише поточні формати за protocols.md; непідтриманий format identifier відхиляти без адаптера.

Додатковий formal model: [поточна предметна модель](assets/chatbot-blueprint.template.json), [action](assets/action-contract.template.json), [memory](assets/memory-contract.template.json), [operations](assets/operation-catalog.json), [eval matrix](assets/evaluation-matrix.json). `python3 scripts/check_chat_contract.py /absolute/path/chatbot-blueprint.json` перевіряє їхню структуру; спільний graph gate виконати за cross-domain-core.

Самодостатня передача має exact inputs/outputs/hashes/decisions/actual attempts/jobs/evidence limits/receiver/next action/acceptance і повернення upstream. Наприкінці вказати завершений scope, фактичні перевірки, unresolved і окремі readiness assessments specification/code/integration/device/human та actual deployed/observed_in_chat за фактами; human_validated є historical human assessment, не загальний stage. Наявний явний дозвіл на конкретну дію не запитувати повторно.

Для наявного продукту, зокрема Люмена, прочитати [продовження наявного бота](references/resume-current-project.md): достатні доступний current repo/source й мета; попередній агентський пакет не є передумовою.

Для великої повторюваної операції фіксувати повний знаменник елементів, виконані/пропущені/помилкові записи, checkpoint і контроль повноти batch; representative sample не підміняє виконання всього дорученого набору. Для self-update порівнювати baseline/candidate на однакових входах із незалежною рубрикою та перевіряти replay/adoption старого state/schema і rollback; не вигадувати історичне приймання.
