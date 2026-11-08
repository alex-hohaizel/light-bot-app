# V8 · ізольована передача для Replit staging

Це точний код погодженого «Адресного пульта» та «Спільної доби», зі світлою, м’якою нічною темою та анімаціями. Усі 68 canonical must збережені, SHA256 requirements.json: 8c0cf1a5d37694dab25715f6d5a321aaeb9c6bb0d515fc020bad33e3c3b62158.

Пакет НЕ готовий до production cutover: реальний writer/спільний Bot runtime, допуск поточних джерел, identity/replay, rollback та sender coordination ще мають свої gates. Не замінювати чинний workspace, не запускати npm start/build/deploy за замовчуванням: default build/start навмисно лишилися isolated. Production candidate build — окремий build:production; він тільки збирає dist-production і не запускає runtime.

Доставка: прочитати source-transfer.json, перевірити кожний hash, тримати код в окремій staging-папці чинного Replit. Чинний main@45d77e22e68816e5695aa4b7d2a62bfc57e8176d, deployment, webhook, користувачі та дані залишаються недоторканими. Збірка ще не означає live readiness.

Значень секретів, архіву source, приватних профілів/БД, .env, node_modules та локальних звітів установки тут немає. Не додавати secret values у Git або відповіді. Наявні installation й canonical docs у базовій гілці збережені. Подальші рішення й QA веде root у чинному Codex-проєкті.
