# План Харкова та застереження джерела: локальне виправлення

Виконавець `/root/app_experience`, 9 листопада2026. Єдина змінювана ціль — `.local/light-bot-app/certification-next`. Первинний `/app` не редагувався. Це вузьке виконання чинного scope всіх68must, а не нове встановлення чи дизайн. Повне чинне доручення власника на release зберігається; цьому компоненту делегована тільки локальна копія, prerequisites activation лишаються окремими.

Офіційний RSS містить датований повний план на9Nov для12груп, публікацію `2026-11-08T20:18:03Z`, item `https://oblenergo.kharkiv.ua/uk/node/13883460` та орієнтовність часу з урахуванням перемикань. Архівний raw SHA256 `96b817608a6a53cfdb53322d2ddd22e2826aacf5a0cf5ee1777819237286d720` незалежний judge прочитав до ремонту. Root окремо фактично отримав той самий raw одним дозволеним публічним GET о `2026-11-09T05:00:37.710470Z`; оригінальний receipt збережено у `current-source/network-observation.json`. Архів не перейменовано на нове спостереження: спочатку відтворено старий час, потім новий фактичний capture використано окремим входом. Наш renderer/tests не виконували HTTP.

Попередня source policy блокувала весь технічний показ Харкова через непідтверджений поточний аварійний стан після повідомлення8Nov. Це змішувало існування погодинного плану й підтвердження фактичного живлення. Сам парсер уже повертав `published/planned_outage`, але застереження втрачалося у частині форматів.

## Поведінка після виправлення

- Технічний показ обмежений саме9Nov, точним item/pub timestamp,12 target plan hashes та значущим notice. `reviewedAt` відповідає фактичному новому спостереженню root; expiry — `2026-11-09T22:00:00Z` (кінець місцевої доби). Старі дні, майбутні неперевірені дні й інші оператори не приймаються цим scope.
- SHA всього RSS залишається provenance. Стороння новина може змінити raw envelope, не змінюючи прийнятий plan item. Зміна publication timestamp, цільового плану, відсутність відомого caveat або оперативне повідомлення про аварійні відключення у відповідній території й даті дії потребують окремої перевірки. Попередній good plan при невдалому refresh може лишитися лише `stale` з явною причиною; новий поточний стан не вигадується.
- Старий emergency post сам по собі не стає безстроковою аварією9Nov і не створює скасування. Новий operative emergency на відповідну service date не ігнорується: parser відмовляється проєктувати точний план до scoped review, навіть коли його оголошено напередодні. Дата дії з тексту відрізняється від publication date; наступний план не вважається скасуванням. Поради/умовні приклади й явно інша територія не стають оперативною аварією Харкова. Це консервативний schema rejection, а не автоматичне твердження «аварія всюди». Наявний окремий `emergency`, `conflict`, `stale` зберігає пріоритет у спільному display engine.
- В `notice` явно сказано про орієнтовність перемикань, невідомий поточний аварійний стан групи, можливу різницю фактичного живлення та відсутність сертифікації будинку/персональної доставки. `published` не перетворюється на `possible/stale` лише через невідомий overlay.
- Notice фактично доходить до app text, bot text, SVG/PNG, порівняння й обох public saved-plan projections. У порівнянні однаковий текст об’єднується за оператором/джерелом/днем/змістом з явними мітками адрес. Стандартні pending/stale повідомлення не видалено.
- Групова картка не називається підтвердженим персональним планом. Час наступної події у порівнянні явно позначений «за планом». Публічна картка/посилання самостійно зберігають застереження.
- У notification editor прибрано хибну production фразу про «тестовий сеанс», обіцянку збереження чернетки при reload та зайвий тестовий banner. Залишено один зрозумілий вступ: параметри каналу/адреси використовуються там, де підтверджено графік. Згоди, lead times, quiet hours, pause та результати durable mutation не змінювалися.

## Незмінні межі

`addressBindingVerified=false`, `deliveryEligible=false`, `parallel48hAccepted=false`, `independentFallbackVerified=false`; source level тільки `schedule`. Немає cert/production admission, нової ліцензії, API key, provider quota чи дозволу автоматизації. Зберігаються попередні robots/rate constraints;45хв — локальний бюджет RSS, не квота оператора. Однаковий DSO у резервному транспорті не рахується двома незалежними підтвердженнями точності.

Усі68must та рішення/відкладені докази лишаються в canonical project registry. Зачеплені вимоги: DATA-02/03/08/09 (джерельна точність/scope/fallback), CHART-03–08 (зміст/єдина модель/час/стан/приватність/fallback), APP-03/06/07 (корисні surface/negative states/читабельність), GOV-03 (окремі рівні доказів). Цей repair не закриває їх цілком. Джерела, адреси, профілі, міграція, бот, прийнятий «Адресний пульт»/«Спільна доба», денна/нічна тема, Onest/Manrope, анімації й семантичні кольори збережені. Новий generic redesign не створювався.

## Фактичні перевірки

Перший представницький шлях: збережений public raw → `normalizeKharkivRss` → точні інтервали `01:00–04:30`, `06:00–15:00`, `18:30–24:00` → повний текст → actual SVG → actual PNG. Пікселі оглянуті автором у денній/нічній темі320px. Після цього сформовано решту scoped target hashes і виконано граничні cases.

Фінальний harness `app/tests/backend/render-schedule-notices.mts` використовує окремий фактичний current capture root та реальний `createSourceIntake` з `publicationScope`, потім ті самі нормалізовані views для тексту, SVG, PNG й Chrome SSR відображення. Усі HTTP routes браузера blocked; локальні прийняті шрифти embedded. Шість renders: light/dark ×320/390/1280px. DOM перевіряє відсутність горизонтального overflow й один notice у comparison; SVG `getBBox()` перевіряє межі всіх actual text nodes. `render-observations.json` та PNG/SVG — належні виходи. Це реальне render measurement, але не hydrated end-to-end/browser interaction або фізичний Telegram device test.

`tests.txt`:75/75 PASS після consolidated repair — scoped12group/raw identity, unrelated news, зміна плану/pub, старий/новий emergency, caveat loss, expiry,3h stale/cache-refresh failure, notices у текстах/public DTO, старі YASNO/OEM/rate/auth/privacy/public-share guards. `typecheck.txt`:PASS. Необхідні відсутні public fixtures скопійовані з existing project archive; приватні/виробничі дані не читалися.

Команди з ізольованої `app/`:

```sh
node --test tests/backend/schedule-notices.test.ts tests/backend/source-operating-policy.test.ts tests/backend/fresh-source-2026-11-09.test.ts tests/backend/live-address-catalog.test.ts tests/backend/live-source-ingestion.test.ts tests/backend/live-source-intake.test.ts tests/backend/live-product-tools.test.ts tests/backend/review-tools.test.ts
./node_modules/.bin/tsc --noEmit --incremental false
node --import tsx tests/backend/render-schedule-notices.mts
```

Chrome launch потребував дозволеного sandbox escalation для локального headless процесу. Перший sandbox launch завершився SIGABRT, не був зарахований як render success. Дозволений наступний запуск пройшов; це не мережевий grant.

## Передача

Exact source/output hashes, inputs, actor та freeze збережено в `handoff.json`. Незалежний `/root/current_release_judge` за першими frozen bytes фактично отримав23PASS/4FAIL та6 hydrated Chrome scenarios. Його failed report/screens/source pins збережено без змін у `attempt-01/`; він не переприв’язаний до нового коду. Поточна редакція усуває educational/other-region false positives, missing pre-midnight effective bulletin, внутрішню certification мову та оманливий reminder CTA. Новий незалежний verdict очікується; автор не привласнює його. Root worker читає нові actual source hashes для своєї synthetic certification campaign. Старі докази не переприв’язуються до нових bytes. Наступна дозволена дія — незалежний review/repair конкретних findings у цій копії; production/webhook/send залишаються за межами завдання.

## Attempt02: фактична поточна навичка й виправлення

Прочитано встановлену `app-atelier-experience`6.0.0 та застосовні production/context/adaptive/acceptance/evidence contracts. Повторного встановлення немає; попередні2.3/5.x записи історичні. Нове notice має три природні речення зі збереженням орієнтовності перемикань, непідтвердженої відповідності будинку, unknown emergency, можливого відступу фактичного живлення й недоступності сповіщень. Кнопка «Налаштувати нагадування» точно називає наявний перехід у settings; lead-time/opt-in/pause не змінені. Actual320px day/night App і card pixels повторно оглянуті, нових style/template змін немає.

## Attempt03: часовий пояс і чинність повідомлення

Попередні frozen докази збережено в `attempt-02/`. Тепер UTC offset у label береться з фактичної IANA-проєкції Europe/Kyiv через чинні `localParts`/`validInstant`, а не з текстового суфікса ISO. Один instant у `Z`, `+02:00` чи іншому серіалізованому offset має один Kyiv label. Golden cases: winter+02, summer+03, fold+03→+02, spring+02→+03,24:00. Instants, local clock labels, duration engine та semantic digest rules не змінені. `now/next` використовують «Час перегляду», synthetic marker окремий.

Джерельний ремонт розпочато після явного закриття cert/PG review window root. Оперативні «не скасовано», «не було скасовано», «залишаються чинними» для Харкова/9Nov потребують review. Поради/conditional, явний інший регіон і скасування без заперечення не перетворюються на аварію Харкова. Це не створює нової cancellation/expiry inference або personal admission.

Фактично86/86 affected tests і TypeScript PASS. Повторено6ChromeSSR renders та додано2actual hydrated320px day/night details: натискання точного інтервалу й розгортання повного fallback показують `01:00–04:30 (UTC+02:00)` та «Час перегляду». Створено окремі now/next SVG/PNG й тексти. Автор переглянув обидва actual details screenshots; обрізання/overflow немає. Незалежний повтор потрібний на нових frozen pins; старі PASS/FAIL не переприв’язано.
