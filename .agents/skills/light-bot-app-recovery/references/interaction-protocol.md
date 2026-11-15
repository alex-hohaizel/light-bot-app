# Зрозуміле керування роботою й огляд стану

Один предметний директор відповідає за прийняту мету, вимоги та інтеграцію. Чинний проєктний реєстр залишається authority; чат, картка рішення, статус і handoff є його проєкціями. Допоміжний огляд не створює ще одного backlog, погодження або сервісу виконання.

## Делегування та рішення

На вході відновити мету, повний target, поточний scope, чинні рішення, фактичні capabilities й найближчий потрібний вибір. Використати доступні джерела до повторних запитань. Для локальної оборотної правки достатньо точного короткого маршруту; для значного нового обсягу застосувати предметний БРИФ. Повний задум, перший випуск і перевірний зріз мають окремий scope; зріз не закриває весь задум.

Власник погоджує мету, важливі продуктові рішення, матеріальні зміни й результат етапу. Звичайне виконання та виправлення в чинному дорученні автономні. Зміна аудиторії, продуктової поведінки, launch-платформи, монетизації, правил доступу/даних або істотної залежності потребує адресного рішення, якщо його ще не делеговано. Зовнішня дія звіряється з фактично чинним scope і правом; уже наданий точний дозвіл не перепитувати. Числовий бюджет/поріг не вигадувати.

Картка рішення: питання → чому потрібне зараз → рекомендація й підстава → реальні альтернативи та наслідки → точний scope/редакція → чинні успадковані рішення → відповідь власника. Використати `assets/decision-card.template.md`. Прийняти, відхилити, змінити, відкласти й прийняти частину мають різні наслідки. Сам запис `confirmed`, hash, порада, мовчання або відповідь виконавця не створюють волі користувача.

Матеріальна дельта відкриває причинно зачеплені рішення/результати; незалежні гілки зберігаються. Якщо залежність невідома, встановити її або явно пояснити обережно ширшу перевірку. Спільні writers мають одного інтегратора та перевірку редакції. Статус «прийнято власником» можливий лише після фактичної застосовної відповіді, окремо від технічного PASS.

## Прогрес, втручання і завершення

Огляд відповідає на п'ять питань: мета; що вже перевірено й на якій редакції; що виконується; що блокує залежне продовження; яке рішення потрібне від власника. Показувати змістовні зміни й фактичні межі доказів. Подробиці, журнали й IDs відкриваються за потребою. Кількість документів, ролей і tool calls не є якістю продукту.

Уточнювальне питання під час роботи не скасовує активної задачі. «Продовжуй» відновлює точний дозволений крок. Пауза, скасування, blocked, очікування доказу та завершення відрізняються; після розпочатого effect спершу звірити actual outcome до повтору. Фонове виконання існує лише за реально запущеного дозволеного scheduler/runtime.

Приймання етапу містить сам результат, відповідність due-вимогам, перевірені сценарії, матеріальні gaps і рекомендоване продовження. Завершений scope може мати terminal closeout без вигаданого наступного етапу чи обов'язкової анкети. Контекст і exact launch/return зберігаються у потрібному пакеті; короткий чат не змушує переписувати всі ці матеріали в кожному повідомленні.

## Read-only helper

`scripts/interaction.py` — stdlib CLI, який читає існуючі native records і формує JSON або Markdown. Він не викликає модель/інструмент, не змінює реєстр, не схвалює рішення й не запускає background job. Поточні native gates виконуються відповідним контролером; цей helper не підміняє його domain readiness.

```bash
python3 -B scripts/interaction.py status --source /absolute/project --format markdown
python3 -B scripts/interaction.py status --source /absolute/project/.appatelier/state.json --format json
python3 -B scripts/interaction.py status --source /absolute/project/round.json --project-root /absolute/project --format markdown
python3 -B scripts/interaction.py decision --source /absolute/project --id D-1 --format markdown
```

Підтримані джерела:

| Домен | Native schema та шлях |
|---|---|
| Foundry | `1.0.0` з native layout; `.agent-foundry/state.json` |
| Game | `2.0.0` з toolkit/journal layout; `.gameatelier/orchestrator/state.json` |
| App | `app-atelier-state/1`; `.appatelier/state.json` |
| ChatBot round | `chatbot.round/1`; точний існуючий файл задається явно |
| ChatBot blueprint | `chatbot.blueprint/3`; точний існуючий файл задається явно |

Коли в root кілька відомих ledger, обрати точний файл; автоматичного пріоритету немає. `--scope VALUE` означає тільки точний збіг scope, включно з доказами; це не загальний project gate. Для повного огляду параметр scope пропустити. JSON schema проєкції: `assets/status-view.schema.json`. Ревізія й SHA-256 стосуються прочитаних bytes, а не довіри до автора чи автентичності згоди.

Для Foundry/Game звіряються native snapshot/journal hashes. Для App/ChatBot вказано відсутність такого native підпису. У будь-якому випадку це контроль цілісності, не proof людської волі або поточної доступності tool. Кожна вісь `specification/code/integration/device/human` окрема: `recorded_pass`, `recorded_failed`, `recorded_pending`, `recorded_unresolved` або `unknown`. ChatBot `completion.assessments` враховуються явно: failed/pending не перекриваються позитивним evidence; passed із відсутнім або unsuccessful linked proof не стає pass. `not_assessed`/`not_applicable` не означають готовності. Самі stage/maturity/імена reviewer не дають позитивного доказу. Для Foundry/Game/App авторитетним outcome є native `status`, для ChatBot — `result`; сторонні `axis/result` fields не перекривають native modality/test kind/status. Recorded stale не стає pass. Пройдені локальні checks не переносяться мовчки в native/device/human readiness.

ChatBot round `stage_complete`/`scoped_complete` показуються як записане завершення власного scope; відкриті вимоги беруться з unresolved IDs і recorded reviews/carry claims, а не з applicability `state=active/unchanged`. Це не новий current proof. Blueprint `attempt.result` відокремлює running/passed/failed, а записаний maturity показується окремо й сам не закриває delivery-вимоги.

Helper читає лише заданий JSON/fixed ledger, не обхід папок, configs або credentials. Не читає чи не виконує referenced scripts/proof/artifact files; тому їхня свіжість лишається native domain gate. Paths нормалізуються перед containment check; symlink перевіряється й у початковому traversal. Symlinks, неповний або неоднозначний layout, неузгоджений journal, дубльовані JSON keys, nonfinite numbers і oversize inputs відхиляються. Виводяться лише вибрані поля; поширені секрети в тексті, зокрема quoted JSON assignments, маскуються best-effort; path/read помилки не віддзеркалюють довільне ім’я файлу. Секрети взагалі не мають потрапляти в проєктний ledger або публічні описи.

Повноту правил, якість гри/застосунку/розмови, незалежність actual actors, native builds, external receipts і людське приймання перевіряти предметно. Майбутня панель може читати цю проєкцію після належної інтеграції, але сама її наявність не надає керування довільним Work-чатом.
