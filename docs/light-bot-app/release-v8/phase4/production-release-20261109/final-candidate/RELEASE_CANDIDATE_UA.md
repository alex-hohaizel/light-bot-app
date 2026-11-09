# Остаточний кандидат LIGHT BOT APP

Приватний source-пакет для exact readback, збірки у чинному Replit і подальшого
дозволеного випуску. Parent commit: d49b2a53395958f4f8c6027a74d5a7162b46dd4d.
App source SHA-256: 35db2f5a75d85b90a55b177d18257dd4ae552a9ae3ddedde25ce438cf6ce58f1.
Build receipt SHA-256: 681b7b8487ee1022c388faf130f349435f97b3afb7d0830901d71bc89ee6da3d.

Збережено всі 68 must, чинного бота, домен, профілі й налаштування та прийняті
«Адресний пульт» + «Спільна доба», денний/нічний режими, анімації й природну
українську мову зі звертанням «ви». Цей пакет не вводить нових продуктових рішень.
Фактичний AGENTS.md включено без зміни. Production profile 6.0.0 отримано як
чинну інструкцію власника; прочитані core-джерела та їхні SHA зафіксовано окремо
в quality-profile-6.json. Це не твердження про встановлення recovery skill 6.0.0.

Локально: TypeScript PASS, 311 backend tests PASS, production build PASS;
279 source-файлів і 14 build artifacts, застосунок/БД не запускалися цією збіркою.
Незалежно: кампанія — 50 перевірок на own PostgreSQL і TLS loopback;
оператор — 24 core + 16 schema/preactivation перевірок на own PostgreSQL;
native SQL точної ревізії пройшов повну семантичну звірку 50 canonical таблиць.
Ці докази мають окремі source pins і не є доказом production, реального Telegram,
пристроїв або остаточного приймання всіх 68 вимог.

Наступний Replit крок: перевірити всі файли manifest і створити нову ізольовану
копію цього exact source, виконати збірку Node20 та зчитати source/artifact receipts.
Підготовка не запускає App, workers, scheduler, sender, webhook чи міграції.
Наявний development maintenance guard залишається до окремого точного cutover.
Production конфігурацію guard не можна публікувати як готовий застосунок.

Власник уже дозволив передачу і повний реліз. Сам manifest не надає права й не
створює підтвердження readiness. Перед активацією потрібні фактичний fence усіх
старих writers, свіжа R1, явне встановлення схеми/перенесення core і reconciliation;
після запуску — actual provider/HTTPS readback. Кампанія лише після healthy:
контрольна вибірка, квитанції, потім чинні eligible підписки через спільний sender.
Невідомий зовнішній результат спочатку звіряється, а не повторюється.

Чинні gates даних, адрес, незалежних безплатних fallback, фактичних 48 годин,
реального Telegram domain/login, пристроїв і hosting liveness не замінені
локальними тестами. Непідтверджені джерела залишаються у карантині.
Оригінальний ZIP, дампи, приватні backup, секрети й реальні рядки акаунтів
до пакета не входять. Єдиний SQL — публічна точна DDL schema за reviewed SHA;
це не дані та не автоматична команда до production.
