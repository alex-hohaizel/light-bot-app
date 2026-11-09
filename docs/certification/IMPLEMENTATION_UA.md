# Допуск персональних графіків: ізольований компонент

Поточний робочий root — `.local/light-bot-app/certification-next`. Оригінальний `/app` і кандидат `35db2f5a75d85b90a55b177d18257dd4ae552a9ae3ddedde25ce438cf6ce58f1` не змінюються. Новий код не є production релізом. Усі 68 вимог залишаються must; прийняті дизайн, мова, денний/нічний режими й анімації зберігаються.

Цей компонент закриває відсутній механізм `reviewed evidence → current selected binding → certificate → projection → interactive qualification → existing events/morning briefing → existing global Telegram dispatcher`. Він не створює нову систему надсилання, обліковий запис, таблицю, webhook чи public API. CurrentRawScheduleFact залишається фактом із `addressBindingVerified:false` і `deliveryEligible:false`.

## Джерело authority

Production loader читає виключно `DEPLOYED_QUALIFICATION_PINS` із `app/server/production/deployed-schedule-qualification.ts`. Чинний список порожній: **реальних source admissions і виданих цим компонентом production certificates — нуль**. Запит HTTP, environment flag, об’єкт профілю або виклик loader із власними production pins не вводить authority. Брендована registry має приватні дані в WeakMap; її не можна відтворити через JSON або змінити Set із зовнішнього коду.

Injected pins дозволені лише в явно відокремленому synthetic test composition. Такий loader приймає тільки `medium:synthetic_fixture`; перейменування fixture на observed відхиляється. Production service відхиляє synthetic registry. Тести цього каталогу не створюють independent review чи actual live source acceptance.

Після справжнього review root може додати до source-owned списку два точні file pins: bundle SHA256 та SHA256 окремої independent review receipt. Loader перевіряє локальні файли, contained paths, symlinks, bytes/hashes/межі; точний inventory семантичного коду й залежностей; мінімум 20 репрезентативних адрес або явно вичерпний менший address scope; фактичні observation records протягом ≥48 год, відсутність пропусків понад прийняту cadence, відповідність scope та часову послідовність; рівність primary/fallback/control plan facts; виконувані негативні raw fixtures. Primary Yasno raw додатково повторно проходить чинний нормалізатор. Control/fallback normalization facts і exact raw captures входять у pinned independent review inventory: сам JSON не доводить, що спостереження справді відбулося.

Free fallback може мати спільний upstream із primary. Окремий домен чи дзеркало не рахується незалежним control. Bundle окремо фіксує transport route, upstream chain і independently acquired control sample. Formal rights, observation quality й actual acquisition підтверджує незалежний review точних artifacts; loader не вгадує їх із `accepted:true`.

Deployment pin file відокремлено від validator. Bundle може pin-ити сам `schedule-certification.ts`, profile recipe, усі три наявні parser families, пов’язаний код і package/lock bytes без циклу `bundle hash → validator hash → той самий bundle hash`. Остаточний source/build inventory має окремо включити source-owned pin file і самі bundle/receipt artifacts. Деплойований root походить від actual bundled/source index directory; `process.cwd()` та env override не визначають identity.

## Поточні connectors і невиконані must

Підтриманий trusted address resolver — тільки `yasno:25/902` для нового exact provider street/house selection у чинному canonical owner/session. Назви чи aliases не стають доказом. `user_selected_group`, fuzzy, legacy address ID без exact saved selection, інший ОСР і непідтверджений namespace не підвищуються.

Навіть справжній bundle сам по собі не створить відсутній connector для Одеси, Вінниці, Харкова або legacy IDs. Не створює він і відсутній operational Kyiv fallback route. DATA-02, DATA-03, DATA-04, DATA-09 та адресні must для цих областей залишаються pending; це не погоджений зменшений scope. Нові adapters можливі лише після фактичного джерельного контракту й окремих належних доказів. Жодна fixture чи стара дата не замінює реальні 48 год і 20 адрес.

Чинний source ingestion cache видаляє superseded raw snapshots, на які вже не вказують current plan pointers. Самі збережені run timestamps не доводять 48 год порівняння. До початку actual qualification window root/data виконавець має забезпечити дозволений durable collector/control-sample artifact route із збереженням exact raw captures; цей компонент не запускає його й не видає старий cache за готовий evidence bundle.

## Єдиний canonical profile writer

`profile-store.commitCertifiedBinding` є server-only recipe з одноразовою closure. Control/epoch, canonical owner advisory lock, request authorization, поточний existing profile, exact session/revision/address/prior binding digest перевіряються до зміни. Bootstrap через issuer заборонений. Профіль клонується; змінюється тільки binding відповідної адреси, revision і stale callbacks. Labels, порядок, primary, navigation, history, preferences, opt-out, pause та policy зберігаються. Чинний `onProfileChange` лишається на тому самому шляху. Тільки pending schedule/notification effects цієї адреси скасовуються; unknown/native history не стирається.

Issuer перевіряє owner-scoped saved resolve result/generation, exact provider IDs, актуальні три address capture pointers, їхній query state, hashes/час/namespace/будинок/групу, raw source pointer/run/epoch і повторну нормалізацію. Мережеве оновлення каталогів і source collection відбуваються поза owner transaction; certificate recipe використовує тільки SQL. Statement і lock timeouts обмежені для нового recipe.

Certificate містить чинні closed record/digests. `accepted_source_revision.acceptedAt` — момент фактичної автоматичної перевірки **нового raw**, не стара дата contract review. `parallel48hEvidence` посилається на окремий прийнятий actual evidence window. Строк certificate обмежений source operating admission/cache freshness, усіма трьома address capture TTL, binding validity, review validity і кінцем service day. Новий raw може кваліфікуватися автоматично за чинним reviewed contract; ручна згода кожні п’ять хвилин не потрібна.

Під owner lock generation ID детермінований за owner/session/epoch/view/binding/bundle/address capture digests. Exact replay не змінює revision і не додає overlapping certificate. Втрата COMMIT acknowledgement перевіряється readback наступного того самого покоління. Помилка після profile update відкочує profile/certificate/revocations разом. Уже expired/revoked **те саме** покоління не resurrect; нові eligible raw/capture facts створюють інше покоління, яке атомарно відкликає superseded active record. Unknown зовнішньої доставки залишається у чинному глобальному dispatcher hold.

## Current projection і доставка

`runtime-context.refresh` читає projection поза owner transaction. Кожний `forProfile` знову звіряє owner/session/address, поточний binding, source/view revision, exact presentation labels, freshness і **час expiry**, навіть усередині 30-секундного memory generation. Нове ім’я адреси не підміняється старим certificate; до recertification показ лишається technical. Якщо current catalog уже суперечить старій групі, старі інтервали не показуються як чинний персональний план.

Projection вимагає exact current review/bundle authority і SQL identity/digests. `events.qualifySchedule` та certified current-source port додатково перевіряють current адресний capture chain у **тому самому dispatcher transaction**. Тому відома зміна групи, address query failure, expiry, registry removal, source/raw drift або revocation зупиняє доставку відразу, до наступного issuer tick.

Інтерактивне повідомлення `kind:schedule` із certified view має окремий adapter через `events.qualifySchedule`. Воно не підробляє notification event proof. Technical `deliveryEligible:false` зберігає старий raw-only шлях. Автосповіщення, reminders і ранковий briefing використовують чинні event/outbox/certificate правила, preferences та глобальний coordinator. За порожньої registry health не оголошує notificationsReady.

Worker має обмеження owner batch, до 50 locations і до 100 candidate attempts на tick, current raw snapshots, private keyset progress та stop guard. Після успішного binding transition він перечитує current revision перед іншою адресою чи наступною датою. Restart може повторити читання, але не повторює видачу exact active generation. Незавершений хвіст лишається на наступний bounded pass.

## Доказ і повернення root

Спершу фактично виконано representative slice на одноразовому PostgreSQL; первинний raw receipt збережено в `representative-first-slice.json` з його власними історичними source hashes. Актуальний author suite і metadata не переприв’язують цей proof до нових bytes. Окрема independent перевірка виконується іншим агентом і має власні fixtures/PG/receipt.

Author suite використовує actual local PostgreSQL, actual filesystem reads/hash failures і actual CJS target-node20 compilation/entry execution з різних cwd. HTTP/source/native responses і qualification review boundary — чесні synthetic fixtures; це не actual provider, Node20 process, device, current 48h observation чи owner acceptance. Детальні результати й final pins міститиме `component-receipt.json` після проходження перевірок.

Наступна дія root: прийняти exact code/proof після незалежного review, далі отримати відсутні actual source/address/fallback/48h artifacts і реалізувати непідтримані connectors у чинному повному scope. Original35db proof, user authority та всі 68 must залишаються окремими від нового локального component PASS. Production/schema/secrets/webhook/розсилка тут не змінено.
