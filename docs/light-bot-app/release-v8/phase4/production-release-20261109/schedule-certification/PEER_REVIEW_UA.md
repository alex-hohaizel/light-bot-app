# Незалежне QA issuer: current exact 9d7e

**33/33 незалежних груп сценаріїв пройшли на фактичній власній PostgreSQL.** Це bounded component PASS для нових canonical профілів із явно вибраними точними адресами YASNO Києва. Воно не закриває повний продукт, legacy/non-Kyiv mapping, fallback connector чи реальний предметний допуск 20 адрес/48 год. Production registry лишається порожнім.

Вхід — author freeze `docs/certification/freeze.json`, SHA-256 `d050c0ecc82deb4b0666256cfa9f064e2b6e52037bafacd8079440c40de7c858`: 6 owned files і 38 semantic dependencies фактично звірено до запуску. Module SHA-256 `9d7e6a74ae718c2fbff48153d255d0146bbb593f910d28546c63cd817f80b9cb`. Source before/after тестового вікна однаковий; окремий empty-registry source також звірено до та після. Автор `/root/production_campaign_worker`, reviewer `/root/release_authority_judge`; авторські 18 тестів та backend/typecheck не зараховано до цих 33.

## Що фактично перевірено

- Production відхиляє injected pins, observed relabel і synthetic registry; default real admissions — 0. Loader виконує negative fixtures і відхиляє <48h, завеликі gaps, <20 для representative scope, повтор адреси, однаковий acquisition замість independent control, неправильні scope/code bytes, відсутній package-lock pin, symlink і конфлікт PlanFacts. Operational fallback зі спільним upstream не відкидається як transport.
- Public candidate без owner-scoped saved selection не сертифікує профіль. Wrong session/stale revision та manual group відхилено. Видача зберегла preferences, labels/order та другу адресу. Повторні одночасні виклики повернули той самий certificate без зайвої profile revision.
- Actual rename після видачі не переписує digest старого cached certificate: показ деградує до false, старий qualifier/producer не доставляє його, нова видача повертає exact current label і зберігає preferences. Registry rotation та нова суперечлива група того самого будинку зупиняють old qualification; після повернення сумісних фактів вона відновлюється за чинними доказами.
- Реальна SQL-помилка відкотила binding і certificate разом. Втрата відповіді перед фактичним COMMIT залишила 0 записів; після фактичного COMMIT — 1. Exact deterministic readback/retry дав один запис і одну revision. Revoked generation не відновлюється; новий фактичний capture створив нову generation.
- Реальний preference writer утримував owner lock: stale issuer дочекався його та відмовив, не перезаписавши налаштування; fresh retry їх зберіг. Реальний UPDATE plan pointer блокувався до atomic certificate/binding COMMIT. Worker обробив дві адреси × today/tomorrow попри власні revision increments.
- Opt-out залишився чинним і не створив autonomous delivery. Wrong control epoch відхилено. Short certificate TTL завершився всередині ще свіжого 30-секундного memory generation й перестав бути integration. Schema лишилася 50/3dab; issuer не створив auth/login/link/campaign записи.

Ці tests використовують лише позначені synthetic captures, fixture review boundary і власні SQL connections. Історичні дати всередині fixture не є фактом спостереження 48 год. Provider, реальні source API, Telegram та production не викликалися. Авторський synthetic shared-dispatcher/unknown proof лишається окремим; цей driver перевіряє same-TX interactive/event eligibility без фактичної Telegram мережі.

## Межі та наступна дія

Кластер зупинено; тимчасові synthetic artifact files видалено. Первинні setup/oracle помилки самого reviewer driver збережено окремо як HARNESS findings: FK insert order, відсутні current catalog query/owned lookup fixtures, еквівалентний safe stale-selection code та вже виданий попереднім worker idempotent результат. Вони не приписані продуктовому коду.

Незмінний receipt поточного запуску — `peer-history/9d7e6a74/peer-tests.json`, SHA-256 `8a94595aab288ec28d8cf0f64f1aa01d62a6e60e4b02f2db43a7021abd916de2`. Попередній e936/33 receipt та aggregate збережено незмінними у власному historical каталозі. Поточний aggregate — `peer-review.json`.

Поточний повтор виконано після exact generic-notice repair та оновлення KH domain dependency до `39e09483…b201a`: старий proof не переприв’язано. У фактичному certificate record перевірено людський qualified текст «План для цієї адреси. Час та інтервали можуть змінюватися.» та окремий synthetic provider warning, який збережено без змін. Усі 6/38 current pins повторно звірено після запуску. Саме KH semantic qualification цей Kyiv issuer зріз не доводить; вона має власні окремі докази. Невиправленого issuer-specific дефекту в цьому freeze не залишено. Final integrated build і affected bootstrap/profile-store import proof залишаються окремими наступними результатами root; попередні AA7 40 тестів — історичний baseline.

Застосовано фактичні QA sources App Atelier 6.0.0 (`e61a53ab…32018`) і ChatBot Atelier 6.0.0 (`5e8b365b…f6d9a`), core quality6 та всі 68 чинних must. Нової загальної згоди не запитано. Фактичний реальний admission, device/human acceptance, serving provenance та production readiness тут не засвідчуються.
