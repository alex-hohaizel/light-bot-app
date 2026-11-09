# Незалежна перевірка production bootstrap operator

**Exact helper `aa7a08958a34aa4250912042734e8cf3264020fab3160a47b3deb2f8e26f8abd` пройшов незалежні 40/40 груп сценаріїв: 24 core/finalize та 16 schema-install/preactivation.** Перевірки виконано на власній одноразовій PostgreSQL із чотирма синтетичними власниками та реальними `pg_dump` і `pg_restore --list`. Це приймання механіки оператора; фактичний production реліз цим документом не засвідчується. Чинний дозвіл власника на повний реліз збережено; повторної загальної згоди не потрібно.

На поточних aa7 bytes повторно перевірено READ ONLY plan, fence-bound admission, native R1 для 59 таблиць перед DML, відхилення fake/copied/peeled/пошкодженого/видаленого R1, збереження наявної папки, same-count legacy drift, per-owner prefix/resume/repeat, opt-out/orphan/session preservation, реальні advisory та TABLE SHARE locks. Нові auth/profile/user delta збережено при окремому posthealthy finalize. Втрата відповіді до і після реального COMMIT розрізняється readback без автоматичного повторного UPDATE; historical replay не звертається до БД й не знімає пізніший hold.

Окремий extension driver фактично пройшов повний прямий шлях: strict legacy-only 9 → справжній native 9-table R1 до всіх операторських DDL/DML → лише exact native SQL `44fc2c6935c6d73325309431303bbd1b2700d9817c55320b95b7ef588a451112` → full 59/schema `3dab788973ff187b372683c0def227da51fd091c2cba94e5ecda04154029e2ce` → bootstrap чотирьох власників → окрема preactivation CAS власного hold. Результат явно містить `deployedHealthy:false`; provider health та bot verification також не заявляються. Documented owner-client шлях передано root; тест не використовує production чи SELECT-only MCP як write bypass.

Негативні сценарії extension відхилили часткову/невідому схему, змінений native SQL, непов’язаний із fence plan, відсутню explicit install опцію, підроблений R1, чужий hold, legacy/canonical drift, unknown native state та неправильні source/target/epoch/authority. Реальна помилка всередині DDL transaction відкотила всі 50 нових таблиць, залишивши legacy bytes незмінними. Втрата відповіді перед COMMIT залишила 9 таблиць; після фактичного COMMIT readback знайшов 59 і власний hold. Подальший контрольований resume вимагав нового 59-table R1, не повторював DDL та зберіг усі сирі legacy записи. Для readiness також перевірено втрату COMMIT з обох боків і historical replay, який не знімає пізніший hold.

Inputs before/after однакові. Кластер зупинено, тимчасові raw fixtures видалено. Command SHA-256: `da628a115ab090a8d48d145df3196f4f0c934cadcd07603a0ac96cc602f47003`. Core proof aa7 збережено окремо в `peer-history/aa7a0895/core-review.json`, SHA-256 `fd54fd7f90b7e317054798165a3a3f51faa59b1dae244215606f9f682524291c`; extension — `peer-extension.json`, SHA-256 `059117f4ed94c2b1a96aaf0ec9406aa54a5faa1697f73733fa1e301cab495d23`. Старий c7 proof залишається історичним і не переприв’язаний до нових bytes.

## Фактичні знахідки початкової ревізії

На попередній exact ревізії з pins у `peer-adversarial.json` (helper `37a6c556…58cf0`) у власній тимчасовій PostgreSQL та власних синтетичних файлах відтворено три дефекти:

1. `createFreshR1` після `mkdir` з `EEXIST` видаляв уже існуючу папку разом із sentinel через unconditional cleanup.
2. `applyCoreBootstrap` із допустимою test-only authority та простим об’єктом backup metadata виконав bootstrap трьох тестових профілів, хоча жодного R1 archive не існувало.
3. Injectable `dumpPort` записав не-PGDMP текст, але `createFreshR1` повернув signed record із production-R1 kind.

Це відтворення механічних інваріантів, а не production-ефекти. CLI використовував default native pg_dump, проте API не гарантував фактичний R1 перед DML. Доказ і драйвер збережено в `peer-adversarial.json` / `peer-adversarial.mjs`; тестовий кластер зупинено, тимчасові raw fixtures видалено. Справжній production fence не створювався.

Автор виправив допуск: потрібен оригінальний native R1 із приватною capability та повторною перевіркою файла, target/source/schema/snapshot; cleanup видаляє лише власну новостворену папку. Усі три регресії фактично перевірено на поточній aa7 ревізії у full59 та legacy9 гілках. Plain/copy backup metadata більше не надає допуску до запису.

## Межі й конкретний наступний крок

Усі authority у цих інтеграційних тестах явно синтетичні та придатні тільки для власної loopback БД. Fixture source `15d3…f5ac` залишається історичним тестовим binding; його не видано за поточний production source. Реального remote TLS handshake, production fence, deploy, HTTPS health, bot verification чи send не виконано. `pg_restore --list` перевіряє native archive TOC; фактичне відновлення архіву ці два драйвери не доводять. Окремі попередні 25 unit-перевірок campaign health observer мають власний source pin і не входять до цих 40.

Конкретний відсутній input для production operator — свіжі справжні докази призупинення всіх старих production/dev writers із binding до точного поточного source, resource, target та epoch. Root може підготувати їх у межах чинного дозволу, потім виконати fence-bound readonly plan, native9 R1, exact44fc install, full3dab і held core bootstrap. Перед activation окремий fresh fence дозволяє зняти лише власний hold, поки жоден app actor не працює. Native publish, фактичні HTTPS/bot/serving-to-DB докази та решта чинних 68 вимог залишаються окремими production результатами.

Застосовано production-quality/context/tool-compatibility guidance 6.0.0, профіль engineering. Функціональні, isolated integration, provider observation і actual production докази залишаються окремими. Accepted дизайн, мова, усі 68 must та історичні proofs не відкривалися наново.

Production connections/writes, provider requests, application runtime та зміни source reviewer — 0. Машинний стан і exact input pins — `peer-review.json`.
