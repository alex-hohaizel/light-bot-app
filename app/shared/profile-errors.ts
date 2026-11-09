/** Safe product copy. Unknown server/provider strings must not become UI text. */
export function profileErrorMessage(code: unknown): string {
  switch (code) {
    case 'PROFILE_ADDRESS_ALREADY_SAVED': return 'Цю адресу вже збережено. Відкрийте її у списку адрес.';
    case 'PROFILE_ADDRESS_LIMIT': return 'Досягнуто ліміту збережених адрес. Видаліть непотрібну адресу, щоб додати нову.';
    case 'PROFILE_ADDRESS_NOT_FOUND': return 'Цю адресу вже видалено або змінено. Оновіть список адрес.';
    case 'PROFILE_OPTION_NOT_FOUND': return 'Довідник адрес оновився. Знайдіть потрібну вулицю й будинок ще раз.';
    case 'PROFILE_BINDING_REVISION_CONFLICT':
    case 'PROFILE_SELECTION_CHANGED': return 'Дані обраного будинку змінилися. Перевірте адресу, оператора й підключення та підтвердьте вибір ще раз.';
    case 'PROFILE_SELECTION_REQUIRED': return 'Потрібне нове підтвердження адреси. Відкрийте пошук і оберіть точний будинок.';
    case 'PROFILE_BINDING_NOT_VERIFIED': return 'Для цієї адреси ще потрібно підтвердити відповідність графіку. Адресу можна зберегти без автоматичних сповіщень.';
    case 'PROFILE_REVISION_CONFLICT':
    case 'PRODUCTION_PROFILE_REVISION_CONFLICT': return 'Профіль уже змінився в іншому вікні або боті. Оновіть дані й перевірте свій вибір.';
    case 'PRODUCTION_INPUT_ID_CONFLICT': return 'Цей запит уже використано для іншої зміни. Перевірте збережений профіль перед наступною дією.';
    case 'PRODUCTION_COMMIT_UNKNOWN': return 'Підтвердження збереження ще немає. Перевірте результат того самого запиту — повторно додавати адресу не потрібно.';
    case 'PRODUCTION_TRANSACTION_RETRY_REQUIRED': return 'Збереження не завершено. Перевірте результат того самого запиту.';
    case 'LIVE_PROFILE_WRITER_NOT_READY': return 'Зміни профілю тимчасово недоступні. Ваші збережені адреси залишаються на місці.';
    case 'LIVE_PROFILE_AUTH_REQUIRED': return 'Увійдіть у свій акаунт, щоб відкрити адреси й налаштування.';
    case 'LIVE_PROFILE_INVALID_INPUT': return 'Перевірте введені дані. Адреса й налаштування не змінені.';
    default: return 'Не вдалося підтвердити дію. Перевірте з’єднання й результат попереднього запиту.';
  }
}
