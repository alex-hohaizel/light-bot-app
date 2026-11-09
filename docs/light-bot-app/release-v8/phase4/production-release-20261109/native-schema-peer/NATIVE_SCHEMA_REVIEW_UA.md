# Незалежна перевірка native schema preview

**Свіжий preview `44fc2c69…1112` — PASS_EXACT_NORMALIZED_SCHEMA.** Після development-only виправлення та повторної генерації платформи exact SQL розміром 39933 байти встановлено у власну порожню PostgreSQL і порівняно з reviewed DDL `3dab7889…9e2ce` в іншій власній БД. У tables, columns/defaults/types/nullability, constraints/FK actions/deferrability та indexes/partial predicates/opclasses/collations різниць 0. В обох: 50 таблиць, 396 колонок, PK50/UNIQUE14/CHECK55/FK42, 78 індексів, із них 5 partial. Два explicit constraint name consumers також збігаються; автоіменування решти не є штучним gate. Доказ — `fresh-native-peer.json`, SHA-256 `0ff91c3a64b7e56a15467b9b97d1c7ed47e25ffddb894476778764ace4c025d6`.

**Історичний preview `850d6e39…07ca8` відхилено.** На власній порожній PostgreSQL він реально дає SQLSTATE `42601`: native генератор створив `CHECK (CHECK (id))` для `lba_public_source_worker_id_check`. Усі його DDL-дії виконувалися в явній тестовій транзакції й відкотилися; canonical-таблиць у відхиленій цільовій БД залишилося 0. Production не читали й не змінювали.

До виконання перевірено повний SHA-256 `850d6e39fd4839f7a4ea6d6ffc73ec100102c7362559e9f6c61efd43ded07ca8`, розмір 39934 байти та статичний allowlist: 106 statements — 50 CREATE TABLE, 42 ALTER ADD FOREIGN KEY, 14 CREATE INDEX. Tokenizer розділяє strings/identifiers/comments; відхиляє інші statement classes, невідомі функції, сторонні schema/table names та dollar bodies. Додавання DROP, DML, SELECT, DO чи CREATE FUNCTION негативними пробами відхилено до SQL-виконання. Відхилений native-файл не редагувався.

## Мінімальне виправлення вихідного DDL

Повні exact reviewed DDL `77205a42…98e57` і explicit-predicate DDL `3dab7889…9e2ce` встановлено у двох окремих власних БД з однаковим мінімальним legacy users fixture. Обидва успішні:

- 50 таблиць і 396 колонок;
- 50 PK, 14 UNIQUE, 55 CHECK, 42 FK;
- 78 усіх індексів, зокрема 5 partial.

Різниця вихідних DDL — рівно `check(id)` → `check(id = true)`. У фактичному PostgreSQL catalog усі columns/types/defaults/nullability, індекси та інші constraints збігаються. Відрізняється тільки текст одного predicate. PK зберігає NOT NULL, тому старий і новий predicates рівнозначні для цієї таблиці.

Перевірено сім фактичних INSERT-сценаріїв на обох схемах: true приймається; false дає `23514`; NULL або пропущений ID — `23502`; NULL uncertain — `23502`; hold text приймається; duplicate true ID — `23505`. Кожна тестова спроба відкотилася. Default для ID не з’явився, і поведінка решти полів не змінилася.

Це незалежне приймання мінімального **source** виправлення. Воно не приймає native preview, згенерований до виправлення. Прихована заміна тексту у старому native SQL не використовується: потрібні development-only зміна constraint та повторна генерація платформою.

## Наступна точна перевірка

`compare-native-schema.mjs` готовий отримати шлях і SHA нового exact native SQL. До цього новий preview не виконується. Він порівнює через фактичний PostgreSQL catalog дві власні порожні БД: reviewed canonical DDL і наданий native SQL. Перевіряються типи/defaults/nullability/identity/generated, PK/UNIQUE/CHECK/FK/actions/deferrability/validation, індексні terms/opclasses/collations/options та partial uniqueness. Constraint/index names діагностуються окремо й не створюють хибної нерівності лише через автоіменування.

Знайдено два name consumers у canonical DDL: умовні DO guards для `lba_dispatch_recipient_subject` та `lba_chat_recipient_subject`. Runtime `ON CONSTRAINT` consumer у перевірених production/release файлах не знайдено. Цей факт відділено від семантичного порівняння.

Новий exact native preview повністю пройшов саме це actual PG порівняння, а не лише summary від платформи. Його SHA-256 `44fc2c6935c6d73325309431303bbd1b2700d9817c55320b95b7ef588a451112` незалежно перераховано перед виконанням; жодної ручної заміни у native SQL не робили. Parent перевірив gzip-transport, reviewer незалежно перевірив отримані SQL bytes та фактичний результат. Зміна майбутнього native input відкриває лише залежний proof. Це не квитанція production DDL, data bootstrap, fence чи всього release GO. Немає нового загального permission gate: чинний дозвіл власника збережено.

Машинні докази: `predicate-and-rejection-proof.json`; відтворюваний драйвер: `predicate-proof.mjs`. Власний loopback-кластер зупинений. Production, application runtime, provider requests і зміни source reviewer — 0.
