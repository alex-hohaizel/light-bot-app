# Вузький public address probe · Київ / YASNO

Виконавець `/root/public_address_probe`; 2026-11-07, UTC14:00–14:04. Це доповнення P1, не повтор Work-аудиту й не новий реєстр покриття. Усі зміни лише в цьому каталозі. Production, webhook, підписники та повідомлення не використовувалися.

## Фактичний результат

Публічний unauthenticated GET-ланцюжок **street → exact house → group** працює для вибірки Києва, `regionId=25`, `dsoId=902`. Контракти не вгадувалися: точні маршрути прочитані в чинному `app/server/scraper-kyiv.ts:185–209`, потім перевірені нормальними GET без cookies, Authorization або browser impersonation. [Публічний пошук вулиці](https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/streets?regionId=25&dsoId=902&query=%D0%A0%D0%B5%D0%B2%D1%83%D1%86%D1%8C%D0%BA%D0%BE%D0%B3%D0%BE).

Збережено **12 source-reported building-binding candidates**, **0 сертифікованих адрес**, **0 фактичних 48h observations**. Це дві вулиці одного DSO, не весь Київ і не вимоги щодо чотирьох міст. Для кожної пари provider street/house ID є URL, час, raw SHA, точний designator і target у `binding-candidates.json`.

| Вулиця / будинок | Provider house ID | Source-reported target |
| --- | --- | --- |
| вул. Ревуцького, 1 | 30816 | 47.1 |
| вул. Ревуцького, 2В | 30856 | 57.1 |
| вул. Ревуцького, 2Г | 30857 | 47.1 |
| вул. Ревуцького, 4А | 30887 | 45.1 |
| вул. Ревуцького, 5/7 | 30889 | 47.1 |
| вул. Ревуцького, 6/8 | 30901 | 46.1 |
| вул. Ревуцького, 12/1 | 30822 | 45.1 |
| вул. Ревуцького, 12А | 30823 | 45.1 |
| просп. Берестейський, 12 | 48783 | 20.1 |
| просп. Берестейський, 121А | 48785 | 6.1 |
| просп. Берестейський, 121Б | 48784 | 6.1 |
| просп. Берестейський, 128/2 | 48792 | 18.1 |

Усі сім отриманих target keys є у вже зафіксованому YASNO KEM feed за 7 листопада (`yasno-kem.json`, SHA наведено в кожному case). Це cross-reference двох читань одного upstream; не незалежна звірка ОСР і не доказ узгодженої ревізії в часі.

## Реальні негативні приклади для інтеграції

1. Пошук будинків `query=12` для Ревуцького736 повернув **12/1** та **12А**, без точного **12**. Старий fallback `exactHouse || houses[0]` присвоїв би чужий designator. Немає точного збігу — потрібне уточнення, не активна прив’язка.
2. На тій самій вулиці будинки мають **45.1,46.1,47.1,57.1**. Вулиця не доводить одну групу.
3. 12А й12/1 повернули однаковий group payload і SHA, але це різні house IDs. ID адреси й binding revision повинні включати region/DSO/street/house scope; лише hash відповіді `{group,subgroup}` не розрізняє адрес.
4. Порожній `query=` повернув20 рядків, у яких немає12А/12/1 із запиту `12`. Це **не вичерпний каталог**. Факт відповіді20 не доводить офіційний загальний limit/pagination contract; його ще треба з’ясувати.
5. Пошук `Берестейський` повернув **просп. Берестейський1211** і **пров. Берестейський2301**. Тип вулиці та provider ID не можна втрачати.
6. Пошук `Перемоги` повернув вул. Перемоги641 і сел. Перемоги1234; він не повернув просп. Берестейський1211. Цей probe **не доводить alias/rename mapping**. Не ототожнювати результати за подібністю слів без офіційного акту й canonical address evidence.
7. Київські технічні45.1/57.1 не можна зводити до історичних1.1–6.2. Namespace — саме `yasno:25/902`; не переносити його на область, Харків або інший DSO.

## Права, ліміти й stop

Виконано19 direct GET та1 офіційний web-open attempt, разом **20/20 дозволених attempts**. Web-open `robots.txt` недоступний; direct robots GET200 повернув212байтів Incapsula HTML. Захист не обходився; цей body не збережено як robots policy. Усі18 API GET повернули200 JSON без challenge. Між direct observations щонайменше1.2с; retry не було. Заголовок API `Cache-Control: private,max-age=120`; це кеш-підказка, не SLA чи дозвіл polling. Авторизація, cookies, платні API/проксі й зовнішні повідомлення відсутні.

Публічне читання обійшлося без плати й API key. Умови систематичного продуктового використання, дозволена частота, fallback та права на повторну публікацію **не встановлені**. Поточний binding response не містить provider effective revision, часів чинності або connection ID; client-derived revision позначена окремо. Не оголошувати12 candidates `address_verified` або вмикати сповіщення.

## Exact next action

Parent інтегрує **тільки offline captured contract/regressions**: exact street/house confirmation, provider namespace, відсутній exact12, різні групи однієї вулиці, окремі12А/12/1, incomplete catalog. `deliveryEligible=false`, до independently accepted binding/source policy.

Для наступного P1 probe потрібні підтверджений безплатний reuse/rate contract і незалежне офіційне building/connection reference; після цього — решта репрезентативної вибірки≥20/ОСР, aliases/корпуси/кілька вводів, fallback і справжні48год спостереження. Власник усієї матриці/root вирішує наступний bounded probe; цей job ліміт вичерпав і більше мережевих запитів не робить.
