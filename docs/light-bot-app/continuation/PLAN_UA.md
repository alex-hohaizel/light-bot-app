# Повний план виконання LIGHT BOT APP

Редакція 1.1. Джерело деталізованих must: requirements.json. Оригінальні LBA-01–LBA-11 з паспорта 1.0 збережені; цей реєстр їх деталізує. Не заводити ще один незалежний backlog.

## Етапи та результати

| Етап | Конкретна робота й вихід | Must / приймання |
| --- | --- | --- |
| INTAKE | Прийняти цей пакет, зберегти 5 локальних installation reports, звірити origin/HEAD/status, current skills/tools; установку не повторювати без drift | GOV-01/02/04/05; source/permission state зрозумілий; exact next source probe |
| P0-R | Санітизований source-only snapshot; повний legacy screens/commands/features inventory; startup graph; source/serving/DB bindings; safe isolated-run prerequisites | TECH-01/02/03, BOT-01, APP-01; кожний незнятий must має blocker/owner/probe; старий server не запускати навмання |
| P1 | Порівняти universal API/прямі ОСР/структуровані джерела; допуск графіка й адрес окремо;4 базові міста+legacy+розширення | DATA-01–09, ADDR-01–04/06; безплатні primary+fallback,20 адрес/ОСР або exhaustive narrow scope, ≥48 год observed validation |
| P2 | Спільні identity/address/schedule/event contracts; сучасний діалог і copy deck; оновлений UI й повна сім’я графічних карток; accepted design/language decisions; один вертикальний зріз | LANG-01/02/03, APP-02, CHART-01/02, BOT-02, ADDR-05, TECH-04, GOV-03/06; visual/copy results показані; old/new identity safe |
| P3 | Реалізувати data/auth/migration contracts, усі бот-сценарії, web/MiniApp, рендер/текст і UI; meaningful regressions; CI/staging | Усі requirements з due P3; actual journey на спільному revision; один sender; repair не обмежується старим кодом |
| P4 | Міграційна репетиція, per-account checks, restore/rollback; незалежне QA; веб+Telegram Android/iOS; actual visual і language verification | PROFILE-01–05, LANG-05, APP-07, CHART-09, TECH-07; кожен snapshot record має контрольований результат; власник бачить реалізований досвід |
| P5 | Окремо дозволений release чинного бота й домену; verified cutover+delta; візуальне повідомлення старим користувачам | PROFILE-06/07, TECH-08; потрібні чинні specific release/data/send права;пілот, квитанції й rollback |
| P6 | Супровід джерел, адрес, черг/помилок, нових ОСР і наступних версій | TECH-09; actual monitoring runtime, source drift/re-certification, runbooks та checkpoint |

## Паралельність без втрати вимог

Після приймання baseline незалежні дослідження джерел, дизайн-напрямів, мови й діалогів можна вести паралельно із закриттям технічних gaps, якщо вони не потребують непідтверджених даних. Остаточний адресний контракт потребує P1; остаточний дизайн реальних графіків — перевіреної семантики. Ранній startup milestone не відкладає появу дизайн/мовних робіт у реєстрі: вони вже обов’язкові.

Один ОСР у зрізі перевіряє інтеграцію. Повний перший реліз включає 4 міста й підтверджений legacy; зменшення цього обсягу потребує адресного рішення власника.

## Обов’язкові видимі результати P2

- Карта всіх екранних/діалогових сценаріїв та keep/rebuild/decision по legacy-функціях.
- Сучасний дизайн усіх ключових екранів і станів, адаптивність, теми, компоненти/типографіка/іконки.
- Реальні зразки PNG/web/text-карток усіх визначених типів, включно з було/стало і статусами відмов.
- Каталог текстів і повні діалоги:новий/старий користувач, адреси, помилки, пауза, зміни, міграція.
- Технологічне рішення reuse/часткова/повна заміна:будь-які доречні мови дозволені; React/TS — кандидат, не нав’язаний остаточний стек.
- Рішення D-ORIGINAL-TEXT, D-VISUAL, D-LANGUAGE, D-NOTIFICATIONS, D-LEGACY-FEATURES мають due; не вважати мовчання acceptance.

## Як закривається етап

Короткий звіт показує всі блоки U1/U2/U3/U4/U5/U6/CROSS, ID виконаних must, планові due пізніших фаз, докази й залишок. Для кожного результату окремо:specification, code, integration, device, visual-language, owner acceptance, released/observed. Статус completed вимагає actual evidence, не наявності документа/коду/green structural checker.

Критичний review проводить окремий виконавець. Всі реалізації App/ChatBot спираються на один shared contract, owner і revision. Установлені директори використовуються за предметним scope; новий координатор не створюється.
