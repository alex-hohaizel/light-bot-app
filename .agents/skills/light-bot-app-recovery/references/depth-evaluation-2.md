# Приймання глибини Agent Foundry

Зміст: інстанціювання → gates → claim matrix → негативні сценарії → cold receiver. Читати до приймання паспорта, generated family, production output та зміни залежного інструмента.

## Інстанціювати модель із чинних джерел

Створити новий `foundry-depth/2` із шаблону, встановити `is_template=false` лише після фактичного наповнення; зв’язати subject із current blueprint ID/revision/hash та source згоди. `blueprint_sha256` — canonical semantic digest поточного `foundry.py` blueprint, не hash довільного JSON formatting. M0 може лишати subject pending; M1/M2 потребують заповнених чотирьох полів. JSON поле не створює згоди. Поточний `foundry.py` веде authority/tasks/effects у своєму єдиному форматі; depth model не є паралельним ledger дозволів.

Records:

- `requirements`: id/source/owner/acceptance/negative_case/due_gate/applicability та rationale для pending/N/A.
- `systems`: id/purpose/owner/input_contract/output_contract/invariants/depends_on.
- `rules`: id/requirement_ids/input_contract/steps/output_contract/oracle/failure_policy/state_ids; точний предметний зміст за domain-model.
- `state_fields`: id/type/authority/persistence/consistency_group/migration/recovery_oracle; default/range/retention за застосовністю.
- `capabilities`: id/tool/operation/environment/status/evidence_ids; full schema/catalog/rights/cost/freshness як linked supporting record.
- `operations`: id/requirement_ids/capability_id/recipe_id/consumer_id/output_ids/parameter_bindings. Binding: requirement_id/field/status/consumption_check. Material parameter може бути supported_not_tested/consumed/unsupported/unknown; ready потребує consumed.
- `recipes`: id/operation_ids/input_ids/output_ids/consumer_id/steps/validators/repair_policy; додати budgets/authority/current input hashes за чинним production recipe.
- `artifacts`: id/path/sha256/owner/kind; відносний contained шлях, без links/escape. До actual creation hash pending; не вигадувати digest.
- `evidence`: id/artifact_ids/subject_sha256/level/result/observer/independent/environment/method/scope. Subject map pin-ить кожний artifact ID до фактичного hash. Levels: source/structural/semantic/operation/integration/human/operational. Result: pass/fail/not_run/inconclusive.
- `modules`: id/name/path/requirement_ids/inherited_contracts. Path містить SKILL.md; кожний успадкований contract має kind core/domain/production/evaluation, contained path і hash. Один файл може містити кілька контрактів; машинний kind не доводить змісту, його читає reviewer.
- `assemblies`: id/artifact_ids/required_evidence_ids/consumer_id/scenario/expected_result; actual observations зберігати як artifact/evidence.

Модель сама по собі не є логом фактичних provider дій. Attempt/receipt залишаються в чинному project ledger; exact refs й digest вписати у linked recipe/evidence. Не копіювати secrets, приватні conversations або project state в універсальний skill.

## Два машинні gates і предметний gate

`check_foundry_depth.py MODEL --root PACKAGE` перевіряє shape, IDs/refs, необхідні поля, inherited contracts та declared evidence boundaries. Pending production outputs дозволені як план, але pass-claims із неповним subject pin заборонені. M0/M1 не стають M2.

`check_foundry_depth.py MODEL --root PACKAGE --ready --session SESSION` додатково вимагає поточну прийняту Foundry session, точний subject ID/revision/canonical hash/approval source, M2, current output bytes/hash, застосовність усіх requirements, production operation на кожну applicable вимогу, спожиті material parameters, capability з належним passing witness та consumer assembly із passing integration/human/operational evidence exact artifact set. Якщо `PACKAGE` уже є initialized session із `.agent-foundry/state.json`, `--session` визначається автоматично. Для іншого package root потрібен точний session path; це технічна прив'язка до чинного дозволу, не повторне людське погодження.

Checker читає session під її чинним lock, перевіряє journal/snapshot, актуальні джерела, suite, pause і canonical authority через bundled runtime лише в пам'яті; він не виконує `save`, dispatch або provider action. Скопійований build-gate JSON не приймається замість session. Звіт pin-ить actual model bytes/hash та прочитаний session state hash/revision і scope. Плановий gate не вимагає ще не отриманого approval й не оголошує current authority підтвердженою без `--session`. Це **не** сертифікат професійної якості, прав чи автентичності спостереження.

Далі — предметний reviewer і cold receiver; для потрібних claims фактичні human/device/provider/production спостереження. Разом із `foundry.py build-gate`, `bundle-check`, current Skill Creator validation та shared `verify_depth.py` це різні перевірки. Не підміняти один gate іншим. Для нового generated package depth model/report включити у delivery і виконати gates перед `package_agent.py`. Поточний package interface перевіряє лише свій підтримуваний формат; жоден зовнішній пакет не одержує domain closure за одним номером інструментарію.

## Матриця тверджень

| Claim | Належний доказ | Що не є доказом |
|---|---|---|
| Повний предметний паспорт | Coverage застосовних jobs/rules/state/failures/dependencies + accountable domain review | Число ролей або довжина тексту |
| Tool підтримує критичний параметр | Actual operation/schema, bound value й consumption observation | Generic descriptor або prompt |
| Generated skill компетентна | Raw task→actual output→discriminating acceptance іншим actor | Наявний SKILL.md/metadata |
| Інтеграція дає потрібний результат | Exact assembled components/scenario/observations | Окремі unit passes |
| Незалежне приймання | Реальний інший reviewer, raw artifacts, scope й output | Self-check перейменований у QA |
| Надійний зовнішній ефект | Provider receipt/read-back/reconciliation за предметом | Local dispatch flag або timeout |
| Work/Codex готові | Окремі placement/discovery/source/version/safe invocation | ZIP або схожа назва у двох hosts |
| Тривалий service outcome | Реально запущене дозволене спостереження й часовий scope | Runbook або обіцянка агента |

## Негативні сценарії

Обов’язково перевірити відсутню recipe/consumer/domain rule; unsupported material parameter; stale source/importer/schema/hash; dangling evidence; source-level witness замість integration; absent/malformed inherited contract; authored reviewer; перекритий writer; replay unknown remote effect; rounding/time/ID conversion loss; changed authority; partial output/crash/disk failure за предметом; old-state restore після delete/revoke; невідповідний host return; pending application масковану N/A; template, поданий як completed.

Тест має впасти від контрольованого дефекту, який він заявляє. Не створювати тести лише як копію реалізації; незалежний oracle/fixture і перевірка strongest objection корисніші за кількість asserts. Не виконувати live payments/deploy/messages або дорогі generations заради validation.

## Cold receiver і завершення

Незалежний отримувач із raw request та пакетом, без історії чату, знаходить current intent/approval, потрібну skill, inputs, exact steps, output/consumer, oracle, gaps та дозволений next action. Якщо він мусить вигадати правило або запитати вже відоме — передача неповна.

Closure pin-ить exact artifacts/proofs/dependencies й verdict per must. Ремонт відкриває зачеплені branches, accepted originals зберігаються; toolkit/model change не робить історичний proof новим. Фінал чітко відділяє створення агента, його встановлення/виклик, виконаний кінцевий результат та фактичну експлуатацію.
