# Кандидат із сумісною перевіркою singleton

Source 15d3c956ff8a9be12d77b44d91b607b47c086e5353a46f893b58a72cb69cf5ac. Parent — приватний commit 269c9fe8e8540dc30e85881f28db63cd3a800197.

Єдина нова зміна коду: `check(id)` для boolean primary key public-source worker виражено як `check(id = true)`. Семантика незмінна. Це усуває native Publish preview з некоректним подвійним CHECK. Production build/start уже виправлені в parent. Клієнт, дизайн, мова бота та всі 68 must збережені.

Локально: TypeScript PASS, 311/311 backend PASS, production build PASS без запуску application/DB/sender. Canonical SQL SHA-256: 3dab788973ff187b372683c0def227da51fd091c2cba94e5ecda04154029e2ce.

Підготовка в Replit: exact source/readback і Node20 compile з незалежними залежностями; рівнозначне оновлення лише development CHECK за цим визначенням; новий штатний Publish preview та перевірка всіх constraints. Старий помилковий native SQL вручну не виправляти й у production не застосовувати. Production bootstrap/fence, фактичні джерела/адреси/provider/device та інші збережені умови перевіряються окремо. Дозвіл власника на повний реліз чинний; готовність не створюється самим дозволом.
