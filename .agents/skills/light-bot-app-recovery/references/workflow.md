# Карта можливостей і локальні перевірки

Читати при відновленні задачі, плануванні етапу, передачі або перевірці повноти. Поточний source, рішення й докази зберігаються в project-owned state. Інструкції встановленої навички визначають метод.

## Зберегти lineage вимог

| ID | Можливість | Основні outputs | Приймання |
| --- | --- | --- | --- |
| LBA-01 | Legacy/P0 | Source inventory, exact revisions, startup effects, фактичне старе покриття | Ізольована відтворюваність, deployed/source відмінності й явні gaps |
| LBA-02 | Джерела | Реєстр ОСР, raw fixtures, canonical revision | Дата, scope, походження й відмови звірені з ОСР |
| LBA-03 | Адреси | Незмінний ID, alias history, versioned bindings | Точний будинок і підключення, колізії без auto-select |
| LBA-04 | Профілі | Snapshot, ID mapping, dry-run, per-user reconciliation | Ідемпотентний імпорт, ownership/preferences, відновлення й rollback |
| LBA-05 | Telegram | FSM, commands/callback, inbox/outbox, delivery policy | Стан після restart, дублі, block/pause/delete, retry та unknown outcome |
| LBA-06 | Веб і Mini App | Спільний профіль, два launch adapters, session/auth | Підпис і свіжість initData, object authorization, same revision |
| LBA-07 | Графіки й доступність | ScheduleView → HTML/PNG/text | Точні інтервали, легенда, before/after, cache isolation і fallback |
| LBA-08 | Передача й супровід | CI, checkpoint, runbooks, scoped rollout | Exact return, регресії, один sender, актуальні source proofs |
| LBA-09 | 0 за API | Вартість/права основного й резервного джерел | Відсутність платного доступу та платного fallback |
| LBA-10 | Повнота покриття | Legacy baseline + operator×territory×capability | Мінімум старих міст і весь підтверджений legacy-обсяг, нове лише за доказами |
| LBA-11 | Права на дію | Actor/target/scope/host/authority і receipts | Заява про доступ, реальна capability й чинний дозвіл мають окремі перевірки |

До створення конкретного продуктового output сформувати task contract із exact inputs, allowed paths/effects, consumer, acceptance, due phase й stop. Під час P0–P6 користуватися потрібними domain/migration/operations правилами. Докази майбутніх етапів залишаються pending до належної операції.

## Стан проєкту

Використати наявний canonical state, якщо він є. Додаткові helper-records є проєкцією для read-only перевірки. Один integrator і чинні записи рішень лишаються authority. Не створювати другий журнал погоджень лише заради валідатора.

Проєктна контрольна точка містить project/task IDs, scope, accepted requirements/decisions, repo/origin/full SHA, input hashes, phase, current owner, completed/current/pending, unresolved effects, pause, grants та next action/return. Зберігати джерельний намір, суперечності й причину перенесення незалежних доказів. Нова редакція джерела відкриває лише залежні результати.

Відновлення проходить exact identity → current sources → decisions/permissions → pending/unknown actions → current gate → next allowed task. За timeout спершу звірити ціль. За розбіжності hash зупинити залежний крок і зберегти фактичний стан.

## Read-only helper

Формат допоміжних записів — [local-records](../assets/local-records.md). Шаблони `assets/source-registry.template.json` і `assets/checkpoint.template.json` навмисно мають незаповнені фактичні поля. Копіювати їх у проєкт і заповнювати з актуальних джерел. Збережений evidence filename та hash перевіряє bytes, а людина або окремий observer перевіряє предметний зміст і походження.

З кореня навички виконати:

```bash
python3 -B scripts/lba_audit.py --help
python3 -B scripts/lba_audit.py --root /absolute/project \
  --registry docs/light-bot-app/source-registry.json \
  --checkpoint docs/light-bot-app/checkpoint.json --format markdown
```

На чужому cwd використати абсолютний фактичний шлях до скрипта навички. `--at` дає відтворюваний aware ISO timestamp для синтетичного тесту. Звичайна перевірка використовує поточний час. Exit 0 — consistency записів. Exit 2 — некоректний або незавершений запис. Фактичний fetch, придатність джерела, права й доставку перевіряти окремо.

Registry helper приймає власні enum, що відображають доменну модель. `active` означає лише заявлений активний запис. `scheduled/explicit_none` відповідають `published/no_planned_outages` домену. Catalog не може заявляти активний графік. `stale/conflict/unavailable/not_published` залишають `blocked/candidate` зі сповіщеннями false. Для особистих пушів потрібні recorded address verification та integration witness того самого scope, service date й source revision.

Кожна перевірка поточного графіка на сьогодні або завтра враховує локальну дату Europe/Kyiv. Історичні fixtures зберігаються окремо й не вмикають delivery. За минулої дати live helper відхиляє active record. Вихід містить `external_verification=not_performed`.

## Пропорційне приймання

- Local — точний дефект, зміна й зачеплений регресійний сценарій.
- Feature — повний user journey на всіх залежних поверхнях, повернення й відмова.
- Critical — незалежний review для авторизації, приватності, міграції, unknown effects і релізу.
- Stage — усі due must, integration/target observations і контрольна точка.

Структура, кількість артефактів або загальний score не перекривають проваленого must. Вхід нового джерела, зміна parser/schema/importer/renderer чи rights відкривають причинно залежні checks. Після другого однакового невдалого ремонту змінити гіпотезу. Для незалежного QA передати raw task, artifacts і exact versions без нав’язаної відповіді.

## Відновити на іншому хості

Використати чинні Work і Codex проєкти, перевірити repository binding і working folder. Для checkout виконати origin/branch/HEAD/status. Для першої копії спочатку підтвердити default branch і target, потім дати clone у порожню перевірену папку. Вказати точний source package, inputs/hashes, permissions, expected receipt, return paths і next action. Якщо шлях на Mac невідомий, підготувати готову інструкцію для вже створеної папки без вигаданого абсолютного шляху.

Створення файлу передачі, його доставка, отримання і запуск — окремі факти. Для двох придатних маршрутів обирати менше перемикань за рівноцінності. Матеріальні відмінності вартості, даних, строків чи результату виносяться на адресне рішення. Відсутній tool або host має точний owner step із критерієм успіху.
