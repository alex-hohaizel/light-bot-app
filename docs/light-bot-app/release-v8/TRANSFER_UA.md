# V8 · поточна ізольована передача Phase2

Поточний пакет перевіряти за source-transfer-phase2.json та exact Git commit, повідомленим окремою квитанцією. source-transfer.json і commit4311 залишені як історична Phase1 передача, їхні старі hashes не є manifest нового дерева.

Усі68 must збережено; requirements.json SHA2568c0cf1a5d37694dab25715f6d5a321aaeb9c6bb0d515fc020bad33e3c3b62158. Прийнятий «Адресний пульт»/«Спільна доба», денний і м’який нічний режими та анімації збережені. Нові auth/profile/inbox boundaries мають окремі actual PG/HTTP та незалежні bounded докази в phase2.

Пакет лише для staging build. Canonical sender/worker, повні tools/deep-link replacements, source/address admission/48h, actual live DB binding/backup/restore/delta та повна68/device acceptance ще відкриті. Legacy production routes перекриті до canonical replacements; це не готова для publish feature parity. Чинний Replit mainb825da267772fc87c8cbb1e85b8acb8e7f83fab9 має лише додані порожні userenv секції порівняно з45d77. Не перезаписувати workspace/main або managed databases, не запускати runtime/scheduler/Telegram і не publish.

Production build — окремий build:production, outputdist-production. Default build/start залишені isolated; не переносити synthetic runtime flags у production. Збірка тільки компілює, не запускає app, DB, webhook або seed. Вхідні credentials не потрібні для збірки.

Передача не містить секретів, source ZIP, приватних профілів/БД, .env чи node_modules. Після fetch exact source перевірити кожний manifest file hash/size, build source fingerprint й asset hashes; отримання та збірка не означають production readiness. Рішення та всі подальші зміни залишаються в Codex.
