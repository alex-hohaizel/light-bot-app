# Знайти й повторно використати спеціаліста до створення

Зміст: межа пошуку → фактичні джерела → відповідність → рішення → передача → перевірка.

## Обов’язковий порядок

До нового агента, сімейства, engine або матеріального розширення спочатку відновити потребу й чинний scope, потім знайти актуальних спеціалістів. Кількість відомих імен не обмежує пошук. Новий вузький агент, який з’явився після випуску конструктора, є рівноправним кандидатом; оновлення статичного каталогу для цього не потрібне. Не відтворювати його engine у новому агенті лише тому, що його немає серед прикладів.

Шукати за потрібною компетенцією, user job, входами/виходами й етапом. Записати межу пошуку, джерела поточного host, дату, запит і предметну причину завершення пошуку. Урахувати пряму заборону змінювати чи залучати окремі джерела до їх читання; scope виключення передавати інвентаризатору через `--exclude-source`. Каталог відомих маршрутів — приклади, не whitelist і не доказ доступності. Не обіцяти пошук усіх існуючих агентів.

## Звідки брати кандидатів

- У Work: актуальні metadata доступних skills/tools та їхні source locators через підтримуваний skills listing/read. У Codex: актуальні metadata і схвалені installed source directories поточного executor. Список у старому чаті, export або архіві є підказкою для resolution.
- Прочитати actual `SKILL.md` кожного потенційно придатного кандидата та потрібні referenced contracts/resources до вибору. Ідентичність визначає лише початковий frontmatter `name`. Зафіксувати stable slug, host, origin/source, фактичну версію, SHA-256 source і прочитаних залежностей. Невідому версію позначити `unknown`, а не вивести з дати чи display label.
- Опційний `assets/capability-card.json` може описувати capabilities, inputs, outputs, stages, compatibility, rights і limits. Це індекс, який звіряють із source. Відсутня чи застаріла картка не відкидає кандидата: виконати аналіз фактичних інструкцій і записати його з source pin. Metadata й картка не розширюють повноваження.
- Для поточного host розділяти `available` (видимий у поточних metadata), `installed` (підтверджений активний installed source), `source_checked` (фактично прочитаний source). Ці факти записувати окремо; кожен із них відрізняється від фактичного виклику й успішної операції.
- Відомий однойменний counterpart іншого host зберігати окремим записом, спочатку `unverified`. Доступний Work source не підтверджує встановлення у Codex, доступ до Mac, локальних файлів, credentials або зовнішньої операції. Після реального переходу повторити listing/read і pin у новому середовищі. Підказка `installed` із чужого export не є перевіркою іншого host.

Архів/`uninstalled`/disabled source не вибирати як активну встановлену навичку. Два активні sources з одним slug потребують явного resolution походження й актуального встановленого джерела: не обирати мовчки більшу цифру версії або новішу дату. За зміни source/hash повторно оцінити відповідність і залежні докази. Старий source може пояснювати історію; він не замінює актуальну редакцію.

## Аналіз відповідності й рішення

Для кожного релевантного кандидата пояснити всі вісім вимірів: **capabilities, inputs, outputs, stages, compatibility, rights, limits, need_fit**. Зв’язати їх із requirement IDs, фактичними source sections і hashes. Встановити потрібну maturity входу, формат/consumer виходу, entry/exit етапу, допустимі hosts/tools, ліцензії/дані, бюджет, ефекти, stop і acceptance. Популярність чи збіг назви не доводить відповідність.

| Рішення | Коли й що записати |
|---|---|
| `reuse` | Один наявний спеціаліст покриває scope; назвати його source pin, owned requirements і причину придатності. Новий engine не створюється. |
| `compose` | Кілька доповнюють один одного; назвати owners, точні interfaces/consumer, shared parent contracts і приймання композиції. Не дублювати спільну поведінку. |
| `extend` | Наявний метод покриває основу; назвати reuse частину та точні uncovered requirement IDs, потрібну зміну й межі згоди. Розширювати лише доведену прогалину. |
| `create_gap` | Після обмеженого source-backed пошуку потрібна компетенція не покрита; назвати розглянуті альтернативи, причини несумісності й точну прогалину. Непрочитаний, неоднозначний або `unknown` кандидат не доводить відсутність компетенції. |

Недоступність підходящого спеціаліста — blocker/адресний bridge, а не доказ потреби виготовити дублікат. Якщо альтернативний локальний метод реально достатній і дозволений, записати `embedded_method`, його виконавця, source й те саме acceptance. Не називати це викликом недоступної навички. Рішення про reuse не дає нового права встановлювати skills, платити, публікувати, надсилати дані чи змінювати продукт; кожна фактична дія звіряє чинний authority.

Відомого кандидата іншого host у bounded shortlist оцінити окремо: `unknown` — source/fit ще не доведені; `bridge` — придатна компетенція потребує адресного виконання в її host; `irrelevant` або `incompatible` — actual source-backed порівняння пояснює непридатність для всіх запитаних requirement IDs. `unknown` і `bridge` блокують висновок `create_gap`, а не всю незалежну роботу. Це перевірка застосовності відомої вибірки, не вимога необмеженого глобального пошуку. Непридатний для іншої предметної області спеціаліст після аналізу не блокує нову компетенцію. Наявність portable source review не підтверджує встановлення або доступу до чужого host. Для cross-host композиції parent план пов’язує окремі перевірені host decisions і bounded launch/return bridges; локальний helper не оголошує їх одним виконаним викликом.

## Виклик і передача

Стабільний selector — `@<frontmatter-name>` у Work та `$<frontmatter-name>` у Codex. Display-версія не входить у selector. Передати точну task contract: parent intent/authority, requirement IDs, bounded scope/stop, actual inputs/hashes, owned paths, outputs/consumer, interfaces, acceptance, бюджет/allowed effects, unresolved, checkpoint, next action й `return_to`. Запланований виклик лишається `planned`; `performed` потребує реального actor, resolved source snapshot та actual operation/output receipt.

Для наявних типізованих app/chatbot/agent_skill компонентів застосувати [specialist-orchestration](specialist-orchestration.md) і їхній `atelier-component-handoff/1` checker. Довільний новий спеціаліст використовує project-owned bounded task/handoff із наведеними полями й окремим предметним прийманням. Чинний app/chatbot checker не перевіряє будь-яке нове сімейство. Не підганяти новий slug під чужий component kind для зеленого звіту.

App і chatbot одного продукту використовують наявні відповідні Atelier й один parent requirements/identity/data/API contract; продукт не створюється повторно у двох незалежних гілках. Вузька компетенція, продуктовий компонент і спеціаліст конкретного проєкту мають різні scope; залучати лише потрібний.

## Локальний read-only helper

`python3 -B scripts/discover_specialists.py inventory --host codex --root /ACTUAL/APPROVED/INSTALLED/ROOT --metadata /PROJECT/current-skill-metadata.json` друкує JSON; він не запускає content, мережу чи ефекти. Дозволені повторні `--root`, `--metadata`, `--exclude-source`, `--snapshot-root`. Root має бути реально дозволеним installed source directory або точним skill folder; не сканувати довільний home чи іншу машину. Для Work actual source читати підтримуваним skills reader, а не трактувати resource URI як локальний файл. За потреби зберегти точний результат reader у дозволеному `--snapshot-root` і в metadata додати `source_snapshot` з його шляхом, лишивши actual URI у `source`. Snapshot pin-ить прочитаний source, не встановлює skill; його root не сканується. Актуальний tool listing має окремо підтвердити `listed=true`.

Metadata — `{"entries":[{"name":"future-spectrum-lab","host":"codex","source":"/APPROVED/future/SKILL.md","listed":true,"installed":true}]}`. Опційні `version`/`sha256` pin-ять очікуване джерело й виявляють stale export; `status=archived` виключає активний вибір. Інший host автоматично лишається unverified. Зберегти отриманий inventory як project evidence.

`python3 -B scripts/discover_specialists.py check-decision INVENTORY.json DECISION.json` перевіряє agent-authored рішення: `decision`, `reason`, `search_scope`, `authority_ref`, `requirement_ids`, `selected` candidate IDs та `analyses`. Кожний analysis має `candidate_id`, `source_sha256`, усі вісім текстових fit dimensions, `fit=usable|extend|incompatible|unknown` і покриті `requirement_ids`. Прочитані потрібні referenced contracts/resources додати як `source_files` з `path`/`sha256` у межах approved roots; їхня зміна також відкриває аналіз. Для фактично розв’язаного duplicate slug додати `identity_resolutions`: `candidate_id`, actual current-host `binding_ref` і `reason`; обидва source лишаються у inventory, а справжність binding оцінюється предметно. Без такого evidence-backed resolution duplicate блокує вибір. Для `compose` потрібний `interface_contract_ref`; для `extend`/`create_gap` — точні `gap_requirement_ids`. `create_gap` вимагає source analysis усіх active current-host кандидатів у заявленій обмеженій вибірці; для великого каталогу спочатку обґрунтувати metadata shortlist і його межі. Структурний helper повторно звіряє bytes; текст аналізу, повноту пошуку, справжність прав і предметну якість оцінює відповідальний actor. `valid` не означає згоду або виконання.

Для відомих other-host записів передати `counterpart_assessments`: `candidate_id`, `status=unknown|bridge|incompatible|irrelevant` і `reason`. Крім `unknown`, потрібні `need_fit`, розглянуті `requirement_ids` та `source_review` з exact `host`, `reference` з metadata, локальним approved snapshot `path` і `sha256`; actual source прочитати підтримуваним reader на належному host, а переносний snapshot не називати його встановленням. Для `bridge` також вказати bounded `bridge_ref`. Для виключення кандидата з висновку про gap оцінка покриває всі запитані вимоги; snapshot і його hash перевіряються повторно. Це лишає foreign availability unverified, доки інший host не перевірено фактично.
