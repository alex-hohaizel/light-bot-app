# Динамічні спеціалісти й складові спільного продукту

Зміст: discovery/reuse → відомі component routes → stable selectors → делегування → спільні контракти → приймання.

## Спочатку знайти, потім створювати

До нового engine, агента чи матеріального розширення виконати [динамічне discovery](specialist-discovery.md): current-host metadata → actual source read/version/hash → відповідність capabilities/inputs/outputs/stages/compatibility/rights/limits/need → обґрунтоване `reuse|compose|extend|create_gap`. Відомі нижче маршрути є прикладами; нові вузькі спеціалісти знаходяться за актуальними джерелами без whitelist. Немає capability card — проаналізувати source, не відкинути кандидата. Архів, дубльований slug і stale source вирішуються до вибору. Інший host лишається unverified до власної перевірки.

Створений агент успадковує цей порядок незалежно від наявності app/chatbot. Для нових спеціалістів використовувати bounded project task/handoff; чинний типізований component checker нижче не заявляти універсальним. Reuse не переносить повноваження на витрати, встановлення чи ефекти.

## Один намір і предметний власник

Agent Foundry відновлює проблему, потребу в агенті, склад продукту, requirements, рішення, поточний стан і scope дозволів. Він не додає застосунок або чатбот лише тому, що відповідна навичка встановлена. Вхід може містити готовий продуктовий план, лише ідею або поточний репозиторій; спочатку зіставити фактичні дані. Невизначені компоненти залишаються пропозиціями з причиною й умовою вибору.

Одне project-owned джерело визначає accepted intent і права. Component handoff є переносною проєкцією цих записів, не другою authority. Той самий продукт не отримує новий набір суперечливих вимог у кожному Atelier. Кожний компонент має окремий owner/consumer/outputs/evidence, а спільні рішення й контракти — одного названого власника.

## Яку навичку залучати

| Намір | Стабільний ідентифікатор | Застосування |
|---|---|---|
| Виготовити або перебудувати reusable спеціалізовану навичку/сімейство | `design-specialist-skills` | Перетворює прийняті компетенції й child contracts на предметний skill workflow, методи, templates та verification. Не є додатковим кроком для кожної задачі агента. |
| Продукт містить застосунок | `app-atelier-director` | Веде весь погоджений app scope та потрібні app stages; розробка продукту не починається з самого факту створення агента. |
| Продукт містить чатбота | `chatbot-atelier-director` | Веде потрібні bot stages; спочатку встановлює канал або набір каналів, аудиторію й реальні обмеження. |

Skill Creator залишається механізмом ініціалізації, перевірки та збереження personal skills. Конструктор спеціалізованих навичок додає предметне проєктування, команду й критерії; ці два засоби мають різні функції. Для агента, який є лише кодом/config і не створює reusable skills, конструктор навичок не обов'язковий. Для одиничної простої правки достатньо прямого відповідного методу.

У Work вибирати поточну навичку через `@design-specialist-skills`, `@app-atelier-director`, `@chatbot-atelier-director`; якщо інтерфейс шукає за видимою назвою, вибрати відповідний запис і звірити його frontmatter. У Codex використовувати `$design-specialist-skills`, `$app-atelier-director`, `$chatbot-atelier-director`. Людська назва може показувати версію, а цей ідентифікатор залишається незмінним. Завантажити останню актуальну встановлену редакцію, зафіксувати фактично прочитаний source/version/hash і її межі; не підставляти цифри версії у виклик.

Для відомого вузького етапу дозволений прямий stage selector із того самого сімейства, наприклад `@chatbot-atelier-integrations` / `$chatbot-atelier-integrations` або `@app-atelier-support` / `$app-atelier-support`. Не називати це викликом директора, якщо реально виконувався етап; новий повний цикл не потрібний за прийнятої продуктової бази. Каталог містить усі поточні stable stage IDs.

Наявність назви в [каталозі](../assets/specialist-routes.json) не підтверджує встановлення. Resolve через available skills і фактичні файли поточного хоста, прочитати інструкцію до виконання. Після переходу Work↔Codex повторити resolution: доступність, шлях і версія іншого середовища можуть відрізнятися.

## Делегування без повторної анкети

Після прийняття паспорта Foundry передає конструктору навичок exact scope, criteria/child contracts, sources, known decisions, outputs, permissions і acceptance. Конструктор звіряє отримане з фактичним дорученням, допрацьовує лише потрібні методичні прогалини та виготовляє skill artifacts. Не запускати повторне discovery, ще один незалежний паспорт або повторне погодження незмінного scope лише через вкладений виклик. Матеріальна нова можливість, зовнішній effect чи витрата повертається інтегратору як точний delta; чинне точне доручення враховується.

За відсутності конструктора можна виконати еквівалентний локальний метод за bundled domain/inheritance/production contracts і Skill Creator. Записати `embedded_method`, фактичного виконавця й приймання; недоступну навичку не називати викликаною. Якщо еквівалентної компетенції/інструмента немає, підготувати конкретний handoff і продовжити незалежну частину.

App/ChatBot Atelier не підміняються загальним шаблоном лише тому, що вони недоступні. Required компонент лишається blocked до належного виконавця або явно обраної й перевіреної предметної альтернативи. Передати підготовлений пакет у здатне середовище, а не вигадувати виконання. Відсутній продуктовый компонент не позначати N/A через відсутність інструмента.

## Проєкт із застосунком і чатботом

Наприклад, застосунок і бот можуть працювати з одним замовленням. Parent owner фіксує identity, access/tenant scope, IDs, transitions, API/events, idempotency, версії, privacy/retention/delete, deep links і shared copy. App owner відповідає за самостійний app journey; ChatBot owner — за вибраний канал, platform adapter, conversation/actions/delivery. Не створювати два незалежні баланси, джерела згоди або статуси того самого замовлення.

Передати спільний contract обом компонентам із одним ID/hash, owner та `component_ids`. Назвати конкретні source→consumer reads/writes/events/failures; не вимагати all-to-all. Для одночасної зміни договору відкрити обидві залежні гілки, узгодити contract revision перед інтеграцією. Зміна лише локальної копії UI не відкриває незалежну серверну логіку без причинного впливу.

Product support bot може бути лише компонентом підтримки застосунку. Не запускати повний новий bot business/research track, якщо доручено вузький support adapter із прийнятою продуктовою базою. Якщо потрібний повноцінний окремий bot journey, каталог і експлуатація, це окремий component scope з власним прийманням.

## Самодостатня передача й отримання

Використати `assets/component-handoff.template.json`, формат `atelier-component-handoff/1`. Включити product/component IDs, parent intent/authority, inherited/owned requirements, scope/stop, permissions/budget, прийняті рішення, actual capabilities, input files/hash, shared contract refs/owners/consumers, deliverables/acceptance, actual jobs/evidence, unresolved, checkpoint і next action. `return_to` містить стабільний parent selector і component ID; `orchestrator_chain` — реальний ланцюг відповідальності, не додаткові керівні шари. Він закінчується фактичним `invocation.selector`, а передостанній selector дорівнює `return_to.selector`; усі selectors є стабільними slug без display-номерів версії.

Для бота `proposed_channels` і `selected_channels` розділені. Невибраний канал є відкритим рішенням, не мовчазним Telegram default; `platform_adapter_contract_refs` посилаються на включені contract IDs. Для неботового компонента ці масиви можуть бути порожні.

`invocation.status=planned` не означає виклик; `performed` потребує actual actor, resolved skill snapshot та receipt evidence з реальними bytes/hash. Snapshot визначається тільки початковим frontmatter, не прикладами `name:` у тексті. Кожний referenced receipt має `actor`, який дорівнює `invocation.actor`, поточний `component_id` і непорожні `requirement_ids` у межах owned requirements; `claim/method/scope` пояснюють, що саме доведено. Це явне структурне зв’язування, а не автоматичне підтвердження істинності довільного тексту.

Відрізняти діяльність `invocation.activity` від назви навички та від виданого scope. `planning` — читання, аналіз, дослідження й документи для рішення; дозволене кожним із трьох чинних grants без нового погодження лише через виклик App/ChatBot. `skill_construction` — створення/зміна reusable навичок у компоненті `agent_skill`; потрібний `construction_only`. `product_execution` — реалізація чи зміна app/bot продукту; потрібний `component_execution`. Grant на продукт не надає автоматичного дозволу встановлювати нові reusable personal skills. `performed`, embedded construction execution і ready-to-receive scope повинні відповідати цій матриці; draft може явно містити ще не дозволену пропозицію. Дозвіл виготовити агента або встановити skill не є дозволом розгортати його продукт, надсилати повідомлення чи оплачувати сервіси.

`deliverables` завжди містить лише фактичні наявні файли з path/hash і перевіряється в кожному статусі; майбутні виходи описуються scope/acceptance, не фіктивними файлами. Кожне `open_questions` — об’єкт із `question`, boolean `blocking`, `status=pending|resolved`; resolved має `resolution_ref`. Неправильний тип, невідомий status або нерозв’язане blocking питання не приховуються в ready пакеті.

Виконати `python3 -B scripts/check_component_handoff.py HANDOFF.json --root PROJECT_DIR`; для ready-to-receive пакета додати `--ready`. Це перевіряє форму, refs, актуальні files/hash, селектори та межі заявленого виконання. Воно не оцінює предметну повноту, справжність згоди або фактичне використання інструмента. Production/component acceptance потребує окремих integration/human/provider proofs за заявленим scope.

Отримувач читає пакет без історії чату, перевіряє джерела/права/versions, відтворює очікуваний сценарій і повертає outputs/hash/verdict/межі. Missing/stale input, несумісне правило або матеріальний delta повертається за `return_to` з точними requirement IDs. Не втрачати accepted originals і не починати завершене заново. Після кожного продуктового етапу оновлюється той самий parent registry й checkpoint.
