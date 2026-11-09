# Контракт спостережень cutover та activation

Це опис полів для root, **не accepted live fence, не шаблон із вигаданим результатом і не дозвіл виконати provider stop**. Структурно коректний локальний JSON/SHA не доводить, що процеси справді зупинені. Єдиний допустимий production автор — root, який уже спостеріг фактичний дозволений effect і сирий readback підтриманого інструмента. Cryptographic attestation від Replit цей контракт не обіцяє; trusted Codex observations мають бути перевірені людиною/root проти реальних викликів. Файли зберігаються приватно під `.local/`, root-owned, без symlink і group/world write; final files0600.

Ідентичність усіх ланок: project `g-p-6aee37634784819189b085127be2946b`, Replit `6cdd42ed-6051-42d1-bea6-d73e9f98682d`, bot `8577497098`, domain `power-ukraine.net`; current frozen source SHA, schema3dab, той самий target HMAC і явно обраний positive epoch. Provider UUID і logical app deploymentRef — різні поля.

## Bootstrap fence

Рекомендований приватний шлях `.local/light-bot-app/cutover/fence.json`. Root збирає ці поля лише після реальних зупинок:

| Об’єкт | Обов’язкові поля/значення |
|---|---|
| Fence | `kind:lba-controlled-cutover-fence/1`, `outcome:confirmed`, `observedAt`, `projectId,replId,botId,domain,sourceSha256,schemaSha256,targetHmac,controlEpoch`, `providerReadback:{path,sha256}`, `developmentReadback:{path,sha256}` |
| Provider observation | `kind:lba-provider-observation/1`, `tool:mcp__codex_apps__replit_get_publish_status`, `arguments.replId` exact, `observedAt`, незмінений `result.structuredContent` з `found:true,status:suspended,deploymentId:e214ddd5-f6c3-4834-a5d8-2fd29d64a979,url:https://power-ukraine.net` |
| Development assessment | `kind:lba-development-writer-observation/1`, `observer:Codex-root`, exact `replId`, `observedAt`, `assessment:{outcome:confirmed,oldApplicationProcessesStopped:true,oldBotWorkersStopped:true,workflowMode:stopped або build_only}`, `rawReadback:{path,sha256}` |
| Raw development readback | `kind:lba-replit-writer-readback/1`, `tool:mcp__codex_apps__replit_ask_question`, `arguments.replId` exact, `observedAt`, фактичний незмінений `result.structuredContent` з `phase:paused,replId` exact |

Assessment має спиратися на фактичний tool result, який підтверджує відсутність старих application/bot workers, а не лише на довільне поле `phase`. Якщо readback цього не показав, root не ставить confirmed. Build-only workflow допустимий лише з доведеним незапуском старого server/bot.

Усі чотири observedAt мають бути не старші5хв і не більш як5с у майбутньому. Кожен referenced файл читається за exact byte SHA; fence byte SHA входить у readonly bound plan. Зміна bytes/source/epoch/target/repl/domain або expiration між планом і apply відхиляється. Реальний provider status `success`, pending/unknown, development still running, queue pending0, health200 або пустий outbox **не є fence**. Якщо інструмент не може підтвердити suspended для exact old deployment, потрібен supported capability bridge; контракт не послаблюється.

Preview сам по собі не є installed proof. В optional owner-client режимі helper після fresh actual9 R1 виконує лише exact allowlisted native SQL44fc, SHA44fc2c6935c6d73325309431303bbd1b2700d9817c55320b95b7ef588a451112, у transaction разом із initial control/ownhold. Перед commit він сам перевіряє фактично встановлену повну schema3dab та unchanged legacy через direct owner connection; без explicit install допускається лише вже повна59-table schema. Поки artifact відсутній — apply недопустимий. Default readonly plan без fence не допускає наступний apply.

## Підготовка до activation до запуску нової програми

Окремий `--ready-for-activation --fence PATH` потребує completed `verified_held` journal, full59/schema3dab, exact frozen source/target/epoch, того самого own operation hold і fresh фактичного підтвердження тих самих all-old-production/dev stops. Нова phase може мати свіжі re-observed fence bytes після5хв; старий і новий SHA зберігаються в receipt lineage. Apply bound plan натомість вимагає exact той fence SHA, який було переглянуто при створенні плану.

Поки actors зупинені, ready звіряє початкові legacy/canonical HMAC, immutable account proofs і native unknown guards, робить новий actual59 R1 та CAS знімає тільки свій hold. Результат READY_FOR_ACTIVATION має `deployedHealthy:false` і не потребує жодного provider-success чи HTTPS-healthy припущення. Це готовність до подальшого root native Publish (`hasDiff=false`), не deployment. Readback unknown COMMIT не видає повторний UPDATE; historical receipt не знімає пізніший hold.

Цей маршрут усуває взаємне блокування startup prepare/bot hold. Він не змінює runtime/API і не послаблює окремий posthealthy finalize нижче. Після ready фактичні deployment, serving/DB, TLS і native identity докази лишаються окремими.

## Healthy activation для posthealthy зняття власного hold

Це окрема фаза після фактичного deployment нового current source. Старий suspended result тут не застосовується. Рекомендований шлях `.local/light-bot-app/cutover/activation.json`:

| Об’єкт | Обов’язкові поля/значення |
|---|---|
| Activation | `kind:lba-canonical-activation-observation/1`, `outcome:confirmed`, `observedAt`, ті самі identity/source/schema/target поля, точні `operationId,controlEpoch`, `providerReadback:{path,sha256}`, `healthReadback:{path,sha256}` |
| Provider | Той самий wrapper/tool/exact arguments.replId; свіже actual `result.structuredContent` з `found:true,status:success`, непорожній **provider deploymentId**, exact URL |
| HTTPS observation | `kind:lba-https-release-health-observation/1`, `observer:Codex-root`, `url:https://power-ukraine.net/api/health/release`, `status:200`, `redirected:false`, `observedAt`, фактичне отримане JSON `body` |
| Health body | `releaseId` і `buildSha256` дорівнюють current frozen compiled source SHA; `configuredBotId:8577497098`, `origin:https://power-ukraine.net`, свіже `observedAt`, `mode:production`, `profileMode:active`, `status:process_serving`, `canonical.ready:true,started:true,stopped:false` |

noticeReleaseId і deploymentRef не потрібні: вони можуть бути null, коли кампанія вимкнена. configuredBotId — конфігураційне поле, не native getMe proof. Finalize явно повертає `nativeBotIdentityVerified:false`; native effect лишається відповідальністю dispatcher/getMe gate. Health контракт campaign worker SHA `be1773133a0ef5cd58562d9a1b7504c054e8144ddd2a41aac1f42c9a4266c1a0`; сам endpoint має відповідати поточному compiled build, а не старому paper receipt.

Provider observation, HTTPS observation, body та activation усі свіжі≤5хв; referenced bytes pinned. Epoch, own hold, full schema, immutable bootstrap proofs і current owner/session invariants перевіряються **безпосередньо в БД**. Не потрібно вигадувати третю serving-config «атестацію» чи epoch у public health. Production finalize перевіряє фактичний current build повторно і бере dispatcher/operator locks перед CAS. Якщо якогось поля/actual observation бракує — explicit blocker, hold лишається.

## Відновлення та довіра

Успіх bootstrap лишає власний hold. До запуску нової програми окремий fresh-fence ready може зняти лише свій hold; posthealthy finalize натомість потребує окремого validated activation. Вони не підміняють докази один одного. Втрата finalize COMMIT-відповіді веде до readback точного intent-marker; чужий/новий hold не знімається. Збережена finalized квитанція є історичним фактом цієї операції і не створює нового права на send/release/reset. Вона не підтверджує, що поточний provider або native bot зараз healthy.

Власний тестовий PG використовує окрему module-private authority factory, що механічно допускає лише `lba_test_*` на127.0.0.1:55430…55500. CLI не має такої опції; це synthetic доказ механізму, не accepted production fence. У цьому каталозі немає файла, який слід копіювати як «успішний» production fence/activation.
