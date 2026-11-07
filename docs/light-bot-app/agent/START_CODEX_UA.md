# Запуск агента LIGHT BOT APP у Codex

Версія навички 1.0.0. Файли підготовлено для чинного проєкту LIGHT BOT APP [CODEX]. Вхід — `.agents/skills/light-bot-app-recovery/SKILL.md`. Погодження власника від 07.11.2026 охоплює створення й перевірку агента. Продовження продукту потребує чинного завдання з його scope.

## Перша копія

У Terminal перейди в уже створену папку, яку використовуватиме чинний Codex-проєкт, і перевір `pwd -P` та її вміст. У порожній папці виконай:

```bash
git clone --branch agent/light-bot-app-recovery-v1 https://github.com/alex-hohaizel/light-bot-app.git .
git remote get-url origin
git branch --show-current
git rev-parse HEAD
git status --short
```

Для приватного репозиторію використай наявну локальну Git-авторизацію. Якщо папка вже містить checkout, звір origin/branch/HEAD/status і збережи локальні зміни перед зміною гілки. У Codex відкрий саме цей checkout у чинному проєкті. Навичка тут має одну project-local копію, Work використовує свою збережену копію.

## Контроль файлів

Із кореня checkout виконай:

```bash
python3 -B .agents/skills/light-bot-app-recovery/scripts/lba_audit.py --help
python3 -B .agents/skills/light-bot-app-recovery/scripts/check_joint_use.py .agents/skills/light-bot-app-recovery
```

Звір усі source hashes із `skill-files.sha256`, вважаючи коренем списку `.agents/skills/light-bot-app-recovery`. Це контроль bytes. Реальний source selection і перший виклик Codex перевіряються окремо.

## Встав у Codex

> Використай $light-bot-app-recovery з .agents/skills/light-bot-app-recovery/SKILL.md. Прочитай паспорт і QA у docs/light-bot-app/agent. Звір робочу папку, origin, поточну гілку, повний HEAD та локальні зміни. Віднови погоджені вимоги й обмеження, перевір доступність App і ChatBot Atelier. Перший крок цього виклику — контроль установки агента та підготовка наступної дозволеної задачі з явними входами й blocker. Поверни прочитаний source/version/hash, результати перевірок та exact next action. Дані й production дії використовують чинний продуктовий scope.

Повернення в Work містить project/task ID, scope, repo/branch/full SHA, input hashes, прочитане джерело навички, outputs/checks, unresolved і next action. Схожі назви проєктів або збережений файл передачі самі не підтверджують запуск на Mac.

## Моделі й QA

Оригінальні паспорт/blueprint/depth збережено без зміни hashes. Build model і shared depth проєкція стосуються перевірки джерел агента в первинному factory layout `skills/…`. У repo використано `.agents/skills/…`; для replay потрібен відповідний layout і точні джерела. M1 product model має майбутні outputs. Live ОСР, міграція, клієнти й production отримують докази в своїх етапах. QA і manifest описують фактичні local/independent результати цієї версії навички.
