# Сумісність підключених інструментів

Це правила використання перевірених пакетів у прийнятому проєкті, не копія їхніх сервісів і не доказ actual availability. Перед операцією прочитати актуальний source/параметри та перевірити потрібний рівень доступу. Конкретна воля користувача, предметні інваріанти й політика host мають відповідний пріоритет; конфлікт показати до залежної дії. Повний каталог усіх інструментів не завантажувати в кожну задачу.

| Операція | Обов'язковий спосіб роботи |
|---|---|
| Назва/UI metadata навички | Адресний patch; зберегти `name`, `policy`, `dependencies` та незачеплені поля. Генератор, що перезаписує YAML, не є безпечним rename. Перевірити actual diff. |
| Генерація зображення | Використати підтриманий built-in маршрут; fallback лише за чинним explicit scope. Перевірити output collision до виклику, actual budget/permissions і pending/unknown effect. Timeout не доводить відсутність роботи; спершу reconciliation. Local ledger не гарантує exactly-once провайдера. |
| Генерація/візуальне приймання | Actual output оглянути за предметною рубрикою та інтеграцією. Промпт/опис не є доказом зображення, delivery або поведінки. Required QA не скасовується інструкцією пакета «не переглядати власну генерацію». |
| Новий Google Doc / редагування | Native create/edit за фактичним бажаним результатом і підтриманими tools; Word import потрібний для запитаного conversion/Word source або обґрунтованого обраного маршруту. Не робити прихований export/import для read-only Q&A. |
| Таблиця/Slides | Зберегти identity/target існуючого документа. Ремонт закінчується після належних current checks; механічний третій цикл без дефекту не додається. Після повторів без прогресу змінити діагностику. |
| DOCX redaction | Звірити реальний `--help` helper; documented flags можуть бути stale. Перевірити зміст і довжину заміни на synthetic fixture до actual document. Не називати anonymized без перевірки всіх застосовних носіїв даних. |
| Go review | Вибрати предметний lead general/distributed/fintech, вузькі style references за потребою. Baseline tooling failures фіксувати окремо. `gofmt` приймає files/directories, не package pattern `./...`. |
| Go concurrency / API | Cancel має охоплювати очікування input/output і всі owned goroutines; WithoutCancel потребує bounds/owner/drain. APQ не є allowlist без окремої серверної політики. Unimplemented gRPC embedding не доводить ручну реалізацію нових методів. Clip не звільняє той самий backing array. |
| Доступ до даних | Перевірка owner/tenant/object authorization потрібна незалежно від UUID. Загальна порада уникати RLS не скасовує прийняту isolation модель. Для Supabase helper policy перевірити actual EXECUTE grants і search_path за вибраною моделлю. |
| Database constraints | Прив'язати перевірку constraint до конкретної таблиці/schema/OID; одне ім'я може бути неунікальним. Міграції перевірити на потрібних ролях і сценаріях. |
| Перенесення Heroku/Render | Names-only/redacted inventory секретів; значення не просити вставляти в чат. Для snapshot/cutover зупинити або узгоджено fenced усіх writers, включно workers/schedulers/external sync. Maintenance mode HTTP недостатній. |
| Перенесення Redis | RDB binary не є RESP command stream для `--pipe`. Вибрати підтриманий provider/import або перевірений DUMP/RESTORE route із TTL/type/count, writer/replay та rollback правилами. |
| Публікація website/cloud | Уточнити, чи actual deploy одразу публічний і яка БД live. Підготовлений preview/показ результату не створює нового deployment grant. Не вигадувати staging/container/GLB capability без exact supported operation. |
| Візуалізація/Page | Локальний widget може пояснювати стан; його shared/sandbox state не стає authority для product decisions. Наявність visual не доводить API керування Work-чатом або фонової роботи. |
| Актуальність пакетних вказівок | Датовані конкурси/credits/host policy перевіряти перед застосуванням; не переносити onboarding defaults на повний production scope. Структурні/keyword graders доповнювати actual предметними probes. |

Детальні джерела й reproduction збережені в аудиті2026-11-04. Ця таблиця не є live-сертифікацією сервісів. Для недоступного/суперечливого required маршруту підготувати exact gap і здатний host; зберігати потрібний обсяг, а не позначати його N/A через відсутність інструмента.
