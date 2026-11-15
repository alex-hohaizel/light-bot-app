import type { AddressRecord, ScheduleEvent, ScheduleView } from '../product-contract.ts';
import { canDeliver, validInstant } from '../schedule-core.ts';
import { normalizeHouse } from '../address-index.ts';
import { MAX_PROFILE_ADDRESSES, ADDRESS_PAGE_SIZE } from '../profile-constraints.ts';
import { BOT_COPY, COPY, NOTIFICATION_COPY, formatNotification, formatNotificationSettings, formatScheduleText } from './copy.ts';
import { defaultNotificationPolicy, parseNotificationPolicy, parseLocationNotificationPolicy, resolveNotificationPolicy,
  reminderLeadMinutes, reminderDurationEligible, syncLegacyPolicyChanges, type NotificationChannel, type ReminderEdge } from '../notification-policy.ts';
import type { AddressDraft, AddressOption, BotAction, BotContext, BotInput, BotLocation,
  BotMessage, BotProfile, BotStage, BotState, BotTurn, CallbackAction } from './types.ts';
export type * from './types.ts';
export { COPY, formatNotification, formatScheduleText } from './copy.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const textKey = (value: string) => value.trim().toLocaleLowerCase('uk-UA').replace(/[’`]/g, "'").replace(/\s+/g, ' ');
const streetKey = (value: string) => textKey(value).replace(/^(вул\.?|вулиця)\s+/u, '');
export { normalizeHouse } from '../address-index.ts';
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const localityKey = (option: AddressOption) => `${option.address.territoryId}|${option.address.locality}`;

export function createBotState(options: { ownerId?: string; sessionId?: string; profile?: BotProfile } = {}): BotState {
  const ownerId = options.ownerId || 'lba-review-user';
  if (options.profile && options.profile.id !== ownerId) throw new Error('BOT_PROFILE_OWNER_MISMATCH');
  const profile: BotProfile = options.profile ? clone(options.profile) : {
    id: ownerId, locations: [], primaryAddressId: null,
    preferences: { optedIn: false, paused: false, reminders: false, remindBeforeMinutes: 30,
      quietHours: { enabled: false, start: '22:00', end: '08:00', timezone: 'Europe/Kyiv' },
      morningBriefing: { enabled: false, time: '07:30' }, minimumOutageMinutes: 0 },
  };
  return { schemaVersion: 'lba-bot/1', ownerId, sessionId: options.sessionId || 'local-review', revision: 0,
    callbackSequence: 0, profile, stage: 'home', currentAddressId: profile.primaryAddressId, draft: null,
    callbacks: {}, processedInputIds: [], processedEventIds: [] };
}

export function restoreBotState(value: unknown, ownerId: string): BotState {
  const state = value as BotState;
  if (!state || state.schemaVersion !== 'lba-bot/1' || state.ownerId !== ownerId || state.profile?.id !== ownerId ||
      !Array.isArray(state.profile.locations) || !Array.isArray(state.processedInputIds) ||
      !Array.isArray(state.processedEventIds) || !state.callbacks || !Number.isInteger(state.revision) ||
      !state.profile.preferences || typeof state.sessionId !== 'string') throw new Error('BOT_STATE_INVALID');
  return clone(state);
}

function rejected(state: BotState, inputId: string, reason: NonNullable<BotTurn['rejected']>, text: string): BotTurn {
  return { state, messages: [{ id: `${inputId}:rejected`, kind: 'error', text, buttons: [], commitBarrier: 'none' }],
    actions: [], requiresCommit: false, rejected: reason };
}

export function handleBotInput(previous: BotState, input: BotInput, context: BotContext): BotTurn {
  if (!previous || previous.schemaVersion !== 'lba-bot/1' || previous.profile?.id !== previous.ownerId) {
    return rejected(previous, input.id, 'invalid_state', BOT_COPY.engineText001);
  }
  if (context.actorId !== previous.ownerId) return rejected(previous, input.id, 'foreign_actor', COPY.foreignButton);
  if (!validInstant(context.now)) return rejected(previous, input.id, 'invalid_clock', COPY.unavailableAction);
  if (!input.id || input.id.length > 128) return rejected(previous, input.id || 'invalid', 'invalid_state', COPY.unavailableAction);
  if (!['command', 'text', 'callback'].includes(input.kind) ||
      (input.kind === 'callback' ? typeof input.callbackId !== 'string' : typeof input.text !== 'string')) {
    return rejected(previous, input.id, 'invalid_state', COPY.unavailableAction);
  }
  if (previous.processedInputIds.includes(input.id)) return { state: previous, messages: [], actions: [], requiresCommit: false, duplicate: true };

  let callback: CallbackAction | null = null;
  let callbackFailure: BotTurn['rejected'];
  let callbackFailureText = '';
  const invalidCallback = (reason: BotTurn['rejected'], text: string) => { callbackFailure = reason; callbackFailureText = text; };
  if (input.kind === 'callback') {
    const record = previous.callbacks[input.callbackId];
    if (!record) invalidCallback('unknown_callback', COPY.unknownButton);
    else if (record.ownerId !== context.actorId) return rejected(previous, input.id, 'foreign_actor', COPY.foreignButton);
    else if (record.consumed || record.stateRevision !== previous.revision) invalidCallback('stale_callback', COPY.staleButton);
    else if (!validInstant(record.expiresAt) || Date.parse(record.expiresAt) <= Date.parse(context.now)) invalidCallback('expired_callback', COPY.expiredButton);
    else callback = record.action;
  }
  const state = clone(previous);
  state.revision++;
  state.processedInputIds = [...state.processedInputIds, input.id].slice(-256);
  if (input.kind === 'callback' && callback) state.callbacks[input.callbackId].consumed = true;
  const messages: BotMessage[] = [];
  const actions: BotAction[] = [];
  let profileChanged = false;
  const action = (type: BotAction['type'], rest: Partial<BotAction> = {}) => {
    actions.push({ type, idempotencyKey: `${state.ownerId}:${input.id}:${type}:${actions.length}`, simulationOnly: true, ...rest });
  };
  const button = (label: string, next: CallbackAction) => {
    const token = `b${(++state.callbackSequence).toString(36)}_${state.sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)}`;
    state.callbacks[token] = { ownerId: state.ownerId, stateRevision: state.revision,
      expiresAt: new Date(Date.parse(context.now) + Math.min(Math.max(context.callbackTtlSeconds || 900, 1), 86400) * 1000).toISOString(), action: next, consumed: false };
    return { label, callbackId: token };
  };
  const commandButton = (label: string, value: string) => button(label, { kind: 'command', value });
  const message = (text: string, buttons: BotMessage['buttons'] = [], kind: BotMessage['kind'] = 'reply', view?: ScheduleView) => {
    const result: BotMessage = { id: `${input.id}:${messages.length}`, text, buttons, kind, commitBarrier: 'none' };
    if (view) result.scheduleRevisionId = view.revisionId;
    messages.push(result);
  };
  const mutate = () => { state.profile = syncLegacyPolicyChanges(previous.profile, state.profile); profileChanged = true; };
  const location = () => state.profile.locations.find(l => l.address.id === state.currentAddressId);
  const hasTypedPolicy = () => Boolean(state.profile.preferences.notificationPolicy || state.profile.locations.some(item => item.notificationPolicy));
  const navigation = () => [commandButton('Мій план', '/start'), commandButton('Меню', '/menu')];
  const addressLimit = Number.isInteger(context.maxAddresses) && context.maxAddresses! >= 0 ? Math.min(context.maxAddresses!, MAX_PROFILE_ADDRESSES) : MAX_PROFILE_ADDRESSES;
  const addressWizardStages: BotStage[] = ['locality', 'street', 'street_choice', 'house', 'connection', 'address_confirm'];
  const leadStages: BotStage[] = ['reminder_off_time', 'reminder_on_time', 'push_off_time', 'push_on_time'];
  const wizardNav = () => [commandButton(BOT_COPY.engineText005, '/back'), commandButton(BOT_COPY.engineText006, '/cancel')];
  const draftStage = (stage: BotStage) => { state.stage = stage; if (state.draft) state.draft.resumeStage = stage; };
  const scopedOptions = () => context.addresses.filter(o => !state.draft?.locality ||
    (o.address.locality === state.draft.locality && o.address.territoryId === state.draft.territoryId));
  const streetOptions = () => scopedOptions().filter(o => o.address.street === state.draft?.street);
  const confirmOption = (option: AddressOption) => {
    if (!state.draft) return;
    state.draft.optionId = option.id;
    state.draft.bindingRevision = option.binding.revisionId;
    draftStage('address_confirm');
    const a = option.address;
    message(`${COPY.confirm}\n\n${a.locality}, ${a.street}, ${a.house.literal}${option.connectionLabel ? `\n${option.connectionLabel}` : ''}\n${option.binding.status === 'verified' ? BOT_COPY.engineText007 : BOT_COPY.engineText008}`, [button(BOT_COPY.engineText009, { kind: 'confirm_address' }), ...wizardNav()]);
  };
  const pageButtons = (scope: 'addresses' | 'locality' | 'street' | 'manual_group' | 'connection', page: number, count: number) => [
    ...(page > 0 ? [button('Попередні', { kind: 'page', scope, value: page - 1 })] : []),
    ...((page + 1) * ADDRESS_PAGE_SIZE < count ? [button('Наступні', { kind: 'page', scope, value: page + 1 })] : []),
  ];
  const boundedPage = (page: number | undefined, count: number) => Math.max(0, Math.min(Number.isInteger(page) ? page! : 0, Math.max(0, Math.ceil(count / ADDRESS_PAGE_SIZE) - 1)));
  const renderHome = (welcome = false) => {
    state.stage = 'home';
    if (state.profile.locations.length) showSchedule();
    else message(COPY.welcome, [commandButton(BOT_COPY.engineText014, '/add'), commandButton(BOT_COPY.engineText015, '/help')]);
    if (state.draft) message('Незавершену адресу збережено як чернетку. Можна продовжити з того самого кроку.', [commandButton(BOT_COPY.engineText016, '/draft'), commandButton('Відкинути чернетку', '/discard_draft')]);
    if (welcome && context.migration?.status === 'needs_confirmation') message(BOT_COPY.engineText018, [commandButton(BOT_COPY.engineText019, '/addresses')]);
  };
  const renderMenu = () => {
    state.stage = 'menu';
    message('Меню. Оберіть потрібний розділ.', [commandButton('Адреси', '/addresses'), commandButton('Сповіщення', '/settings'), commandButton('Додаткові можливості', '/tools'), commandButton('Допомога', '/help'), commandButton('Мій план', '/start')]);
  };
  const renderAddresses = () => {
    state.stage = 'addresses';
    const count = state.profile.locations.length, page = boundedPage(state.addressPage, count); state.addressPage = page;
    message(count ? `${BOT_COPY.engineText020}\nСторінка ${page + 1} з ${Math.ceil(count / ADDRESS_PAGE_SIZE)}.` : COPY.noAddresses,
      [...state.profile.locations.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(l => button(`${l.address.id === state.profile.primaryAddressId ? BOT_COPY.engineText021 : ''}${l.address.label}${l.paused ? BOT_COPY.engineText022 : ''}`, { kind: 'location', value: l.address.id })),
        ...pageButtons('addresses', page, count), ...(count < addressLimit ? [commandButton(BOT_COPY.engineText023, '/add')] : []), commandButton('Назад', '/menu')]);
  };
  const locationSummary = (l: BotLocation) => BOT_COPY.engineText031(l.address.label, l.address.locality, l.address.street, l.address.house.literal ? ', ' + l.address.house.literal : '', l.binding.kind === 'user_selected_group' ? BOT_COPY.engineText025 : l.binding.status === 'verified' ? BOT_COPY.engineText026 : BOT_COPY.engineText027, l.paused ? BOT_COPY.engineText028 : l.notifications ? BOT_COPY.engineText029 : BOT_COPY.engineText030) + `\nPush для адреси: ${l.notificationPolicy?.channels.push.enabled ? 'увімкнено' : 'вимкнено'}.\nЗагальна згода, пауза й перевірка адреси діють окремо.`;
  const renderLocation = (stage: BotStage = 'location') => {
    const l = location(); if (!l) { renderAddresses(); return; }
    state.stage = stage;
    const back = commandButton('Назад', '/back');
    let buttons: BotMessage['buttons'];
    if (stage === 'location_manage') buttons = [button(BOT_COPY.engineText033, { kind: 'location_action', value: 'rename' }), button(BOT_COPY.engineText034, { kind: 'location_action', value: 'edit' }), commandButton('Основна адреса й порядок', '/location_order'), button(BOT_COPY.engineText042, { kind: 'location_action', value: 'delete' }), back];
    else if (stage === 'location_order') {
      const index = state.profile.locations.indexOf(l);
      buttons = [...(l.address.id !== state.profile.primaryAddressId ? [button(BOT_COPY.engineText035, { kind: 'location_action', value: 'primary' })] : []), ...(index > 0 ? [button(BOT_COPY.engineText036, { kind: 'location_action', value: 'up' })] : []), ...(index < state.profile.locations.length - 1 ? [button(BOT_COPY.engineText037, { kind: 'location_action', value: 'down' })] : []), back];
    } else if (stage === 'location_notifications') buttons = [commandButton('Telegram для адреси', '/location_telegram'), commandButton('Push для адреси', '/location_push'), button(l.paused ? BOT_COPY.engineText038 : BOT_COPY.engineText039, { kind: 'location_action', value: 'pause' }), back];
    else if (stage === 'location_telegram' || stage === 'location_push') {
      const push = stage === 'location_push';
      buttons = [push ? commandButton(l.notificationPolicy?.channels.push.enabled ? 'Вимкнути push для адреси' : 'Увімкнути push для адреси', l.notificationPolicy?.channels.push.enabled ? '/address_push_off' : '/address_push_on') : button(l.notifications ? COPY.addressNotificationsOff : COPY.addressNotificationsOn, { kind: 'location_action', value: 'notifications' }), commandButton(push ? NOTIFICATION_COPY.addressPushBeforeOff : NOTIFICATION_COPY.addressBeforeOff, push ? '/address_push_before_off' : '/address_before_off'), commandButton(push ? NOTIFICATION_COPY.addressPushBeforeOn : NOTIFICATION_COPY.addressBeforeOn, push ? '/address_push_before_on' : '/address_before_on'), back];
    } else if (stage === 'location_tools') buttons = [button(BOT_COPY.engineText040, { kind: 'location_action', value: 'share' }), button(BOT_COPY.engineText041, { kind: 'location_action', value: 'report' }), commandButton('Порівняти адреси', '/compare'), commandButton('Історія', '/history'), back];
    else buttons = [commandButton(BOT_COPY.engineText032, '/schedule'), commandButton('Керування адресою', '/location_manage'), commandButton('Сповіщення адреси', '/location_notifications'), commandButton('Інші дії з адресою', '/location_tools'), back];
    let summary = locationSummary(l);
    if (stage === 'location_telegram' || stage === 'location_push') {
      try {
        const channel = stage === 'location_push' ? 'push' : 'telegram', policy = resolveNotificationPolicy(state.profile.preferences, l, channel);
        const raw = l.notificationPolicy?.channels[channel];
        const lead = (field: 'beforeOffMinutes' | 'beforeOnMinutes') => `${policy[field] === 0 ? 'вимкнено' : `${policy[field]} хв`}${raw?.[field] === undefined ? ' · як у каналі' : ' · для цієї адреси'}`;
        summary += `\n\n${channel === 'push' ? 'Push' : 'Telegram'} · ${l.address.label}\nПеред вимкненням: ${lead('beforeOffMinutes')}\nПеред плановим відновленням: ${lead('beforeOnMinutes')}\nЧас не вмикає канал. Загальна згода та пауза діють окремо.`;
      } catch { summary += `\n${NOTIFICATION_COPY.invalid}`; }
    }
    message(summary, buttons);
  };
  const renderSettings = (stage: BotStage = 'settings') => {
    state.stage = stage; const prefs = state.profile.preferences;
    let policy;
    try { policy = prefs.notificationPolicy ? parseNotificationPolicy(prefs.notificationPolicy) : defaultNotificationPolicy(prefs); }
    catch { message(NOTIFICATION_COPY.invalid, navigation()); return; }
    const back = commandButton('Назад', '/back');
    const buttons = stage === 'telegram' || stage === 'push' ? (() => {
      const push = stage === 'push', channel = push ? policy.channels.push : policy.channels.telegram;
      return [commandButton(push ? (channel.enabled ? NOTIFICATION_COPY.pushOffButton : NOTIFICATION_COPY.pushOnButton) : (prefs.optedIn ? NOTIFICATION_COPY.telegramOffButton : NOTIFICATION_COPY.telegramOnButton), push ? (channel.enabled ? '/push_off' : '/push_on') : (prefs.optedIn ? '/notifications_off' : '/notifications_on')),
        commandButton(channel.remindersEnabled ? (push ? NOTIFICATION_COPY.pushRemindersOff : NOTIFICATION_COPY.telegramRemindersOff) : (push ? NOTIFICATION_COPY.pushRemindersOn : NOTIFICATION_COPY.telegramRemindersOn), `/${push ? 'push' : 'telegram'}_reminders_${channel.remindersEnabled ? 'off' : 'on'}`), commandButton(push ? NOTIFICATION_COPY.pushBeforeOff : NOTIFICATION_COPY.beforeOff, push ? '/push_before_off' : '/before_off'), commandButton(push ? NOTIFICATION_COPY.pushBeforeOn : NOTIFICATION_COPY.beforeOn, push ? '/push_before_on' : '/before_on'), back];
    })() : stage === 'timing' ? [commandButton(BOT_COPY.engineText057, '/quiet'), commandButton(BOT_COPY.engineText058, '/briefing'), commandButton(BOT_COPY.engineText059, '/minimum'), commandButton('Спільний час Telegram', '/reminders'), back] : [commandButton('Telegram', '/telegram'), commandButton('Push', '/push'), commandButton('Час і розклад повідомлень', '/timing'), commandButton(prefs.paused ? BOT_COPY.engineText052 : BOT_COPY.engineText053, prefs.paused ? '/resume' : '/pause'), back];
    message(formatNotificationSettings(prefs, policy), buttons);
  };
  const renderTools = (stage: BotStage = 'tools') => {
    state.stage = stage;
    const buttons = stage === 'account' ? [commandButton(COPY.openApp, '/app'), commandButton('Відновлення старого профілю', '/migration'), commandButton('Скинути профіль', '/reset'), commandButton('Про сервіс', '/about')] : [commandButton('Порівняти адреси', '/compare'), commandButton('Історія змін', '/history'), commandButton('Тижневий огляд', '/digest'), commandButton('Профіль і доступ', '/account')];
    message(stage === 'account' ? 'Профіль і доступ. Старі посилання перевіряє захищений адаптер; акаунти не об’єднуються автоматично.' : 'Додаткові можливості. Для кожної дії показуємо її фактичний стан.', [...buttons, commandButton('Назад', '/back')]);
  };
  const beginAddress = (edit = false) => {
    const existing = edit ? location() : null;
    if (!edit && state.profile.locations.length >= addressLimit) {
      message(BOT_COPY.engineText062(addressLimit), [commandButton(BOT_COPY.engineText063, '/addresses')]); return;
    }
    state.draft = { operation: edit ? 'edit' : 'add', originalAddressId: existing?.address.id,
      label: existing?.address.label, resumeStage: 'locality' };
    state.catalogPage = 0;
    renderWizard('locality');
  };
  const renderStreetMatches = () => {
    const seen = new Set<string>();
    const matches = scopedOptions().filter(o => [o.address.street, ...o.address.aliases].some(name => streetKey(name).includes(streetKey(state.draft?.streetQuery || ''))))
      .filter(o => { if (seen.has(o.address.street)) return false; seen.add(o.address.street); return true; });
    draftStage('street_choice'); const page = boundedPage(state.catalogPage, matches.length); state.catalogPage = page;
    message(matches.length ? `${BOT_COPY.engineText128}${matches.length > ADDRESS_PAGE_SIZE ? `\nСторінка ${page + 1} з ${Math.ceil(matches.length / ADDRESS_PAGE_SIZE)}.` : ''}` : COPY.noStreet,
      [...matches.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(o => button(o.address.street, { kind: 'street', value: o.id })), ...pageButtons('street', page, matches.length), ...wizardNav()]);
  };
  const renderConnections = () => {
    const matches = streetOptions().filter(o => normalizeHouse(o.address.house.literal) === normalizeHouse(state.draft?.house || ''));
    draftStage('connection'); const page = boundedPage(state.catalogPage, matches.length); state.catalogPage = page;
    message(COPY.connection, [...matches.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map((o, index) => button(o.connectionLabel || BOT_COPY.engineText129(page * ADDRESS_PAGE_SIZE + index + 1), { kind: 'connection', value: o.id })), ...pageButtons('connection', page, matches.length), ...wizardNav()]);
  };
  const renderWizard = (stage = state.draft?.resumeStage || 'locality') => {
    if (!state.draft) { renderHome(); return; }
    draftStage(stage);
    if (stage === 'locality') {
      const seen = new Set<string>();
      const choices = context.addresses.filter(o => { const key = localityKey(o); if (seen.has(key)) return false; seen.add(key); return true; });
      const page = boundedPage(state.catalogPage, choices.length); state.catalogPage = page;
      message(choices.length ? `${COPY.locality}${choices.length > ADDRESS_PAGE_SIZE ? `\nСторінка ${page + 1} з ${Math.ceil(choices.length / ADDRESS_PAGE_SIZE)}.` : ''}` : BOT_COPY.engineText064, [...choices.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(o => button(`${o.address.locality} · ${o.territoryLabel}`, { kind: 'locality', value: localityKey(o) })), ...pageButtons('locality', page, choices.length), ...wizardNav()]);
    } else if (stage === 'street_choice') renderStreetMatches();
    else if (stage === 'street') message(COPY.street, wizardNav());
    else if (stage === 'connection') renderConnections();
    else if (stage === 'house') message(`${state.draft.street || ''}\n${COPY.house}`, wizardNav());
    else if (stage === 'address_confirm') {
      const option = context.addresses.find(o => o.id === state.draft?.optionId);
      if (option) confirmOption(option); else { draftStage('house'); message(COPY.noHouse, wizardNav()); }
    } else renderHome();
  };
  const showSchedule = () => {
    if (!state.profile.locations.length) { renderAddresses(); return; }
    const l = location() || state.profile.locations.find(item => item.address.id === state.profile.primaryAddressId) || state.profile.locations[0];
    state.currentAddressId = l.address.id; state.stage = 'home';
    const buttons = [commandButton('Інша адреса', '/addresses'), commandButton('Нагадування', '/location_telegram'), commandButton('Меню', '/menu')];
    const plan = context.plans.find(plan => plan.addressId === l.address.id);
    const notices = `${state.profile.preferences.paused ? BOT_COPY.engineText017 : ''}${l.binding.status !== 'verified' ? '\n\nПрив’язка адреси потребує підтвердження.' : ''}`;
    if (!plan) { message(`${l.address.label}\n${COPY.noPlan}${notices}`, buttons); return; }
    const view: ScheduleView = { ...plan, addressLabel: l.address.label };
    message(formatScheduleText(view) + notices, buttons, 'schedule', view);
  };
  const parentStage = (): BotStage => {
    if (leadStages.includes(state.stage)) return state.returnStage || (typeof state.policyAddressId === 'string' ? (state.stage.startsWith('push') ? 'location_push' : 'location_telegram') : state.stage.startsWith('push') ? 'push' : 'telegram');
    const parents: Partial<Record<BotStage, BotStage>> = { addresses: 'menu', settings: 'menu', telegram: 'settings', push: 'settings', timing: 'settings', tools: 'menu', account: 'tools', help: 'menu', location: 'addresses', location_manage: 'location', location_order: 'location_manage', location_notifications: 'location', location_telegram: 'location_notifications', location_push: 'location_notifications', location_tools: 'location', rename: 'location_manage', delete_confirm: 'location_manage', report: 'location_tools', reminder_time: 'timing', minimum_duration: 'timing', quiet_hours: 'timing', briefing_time: 'timing', manual_group: 'help', reset_confirm: 'account' };
    return parents[state.stage] || 'home';
  };
  const renderStage = (stage: BotStage) => {
    if (stage === 'home') renderHome();
    else if (stage === 'menu') renderMenu();
    else if (stage === 'addresses') renderAddresses();
    else if (['settings', 'telegram', 'push', 'timing'].includes(stage)) renderSettings(stage);
    else if (['location', 'location_manage', 'location_order', 'location_notifications', 'location_telegram', 'location_push', 'location_tools'].includes(stage)) renderLocation(stage);
    else if (stage === 'tools' || stage === 'account') renderTools(stage);
    else if (addressWizardStages.includes(stage)) renderWizard(stage);
    else if (leadStages.includes(stage)) {
      const target = typeof state.policyAddressId === 'string' ? state.profile.locations.find(l => l.address.id === state.policyAddressId) : undefined;
      if (state.policyAddressId === undefined || (state.policyAddressId !== null && !target)) { state.policyAddressId = null; message(NOTIFICATION_COPY.missingAddress); renderHome(); }
      else { state.stage = stage; message(NOTIFICATION_COPY.edgePrompt(stage.startsWith('push') ? 'push' : 'telegram', stage.endsWith('off_time') ? 'starts' : 'ends', target?.address.label), wizardNav()); }
    } else {
      const prompts: Partial<Record<BotStage, string>> = { rename: BOT_COPY.engineText112, reminder_time: BOT_COPY.engineText077, quiet_hours: BOT_COPY.engineText079, briefing_time: BOT_COPY.engineText081, minimum_duration: BOT_COPY.engineText083 };
      if (prompts[stage]) { state.stage = stage; message(prompts[stage]!, wizardNav()); }
      else handleCommand(stage === 'help' ? '/help' : stage === 'manual_group' ? '/queue' : stage === 'report' ? '/report' : stage === 'delete_confirm' ? '/location_manage' : stage === 'reset_confirm' ? '/account' : '/start');
    }
  };
  const handleCommand = (raw: string) => {
    const [head, ...args] = raw.trim().split(/\s+/); const cmd = head.toLowerCase().split('@')[0];
    const leadCommands: Record<string, [BotStage, NotificationChannel, ReminderEdge, boolean]> = {
      '/before_off': ['reminder_off_time', 'telegram', 'starts', false], '/before_on': ['reminder_on_time', 'telegram', 'ends', false],
      '/push_before_off': ['push_off_time', 'push', 'starts', false], '/push_before_on': ['push_on_time', 'push', 'ends', false],
      '/address_before_off': ['reminder_off_time', 'telegram', 'starts', true], '/address_before_on': ['reminder_on_time', 'telegram', 'ends', true],
      '/address_push_before_off': ['push_off_time', 'push', 'starts', true], '/address_push_before_on': ['push_on_time', 'push', 'ends', true],
    };
    if (leadCommands[cmd]) {
      const [stage, channel, edge, local] = leadCommands[cmd], target = local ? location() : undefined;
      if (local && !target) { message(NOTIFICATION_COPY.missingAddress, navigation()); return; }
      state.stage = stage; state.policyAddressId = target?.address.id ?? null;
      state.returnStage = local ? (channel === 'push' ? 'location_push' : 'location_telegram') : channel;
      message(NOTIFICATION_COPY.edgePrompt(channel, edge, target?.address.label), wizardNav()); return;
    }
    if (['/push_on', '/push_off', '/push_reminders_on', '/push_reminders_off', '/telegram_reminders_on', '/telegram_reminders_off'].includes(cmd)) {
      const prefs = state.profile.preferences;
      const policy = prefs.notificationPolicy ? parseNotificationPolicy(prefs.notificationPolicy) : defaultNotificationPolicy(prefs);
      const channel = cmd.startsWith('/telegram') ? 'telegram' : 'push';
      if (cmd.includes('reminders')) policy.channels[channel].remindersEnabled = cmd.endsWith('_on');
      else policy.channels[channel].enabled = cmd.endsWith('_on');
      prefs.notificationPolicy = policy; mutate(); message(NOTIFICATION_COPY.saved); renderSettings(channel); return;
    }
    if (cmd === '/address_push_on' || cmd === '/address_push_off') {
      const target = location();
      if (!target) { message(NOTIFICATION_COPY.missingAddress, navigation()); return; }
      target.notificationPolicy = target.notificationPolicy ? parseLocationNotificationPolicy(target.notificationPolicy) : {
        version: 'lba-notification-policy/1', channels: { telegram: { enabled: target.notifications }, push: { enabled: false } },
      };
      target.notificationPolicy.channels.push.enabled = cmd.endsWith('_on');
      mutate(); message(NOTIFICATION_COPY.localSaved); renderLocation('location_push'); return;
    }
    if (cmd === '/start' && args.length && /^(link_|weblogin_|addr_)/.test(args[0])) {
      action('resolve_legacy_link', { value: args[0].split('_')[0], reason: 'Resolve opaque legacy payload in trusted auth adapter; never auto-merge accounts.' });
      message(BOT_COPY.engineText069, [commandButton(BOT_COPY.engineText070, '/start')]); return;
    }
    switch (cmd) {
      case '/start': renderHome(true); break;
      case '/menu': renderMenu(); break;
      case '/tools': renderTools(); break;
      case '/account': renderTools('account'); break;
      case '/telegram': case '/push': case '/timing': renderSettings(cmd.slice(1) as BotStage); break;
      case '/location_manage': case '/location_order': case '/location_notifications': case '/location_telegram': case '/location_push': case '/location_tools': renderLocation(cmd.slice(1) as BotStage); break;
      case '/help': state.stage = 'help'; message(COPY.help, [commandButton('Обрати чергу вручну', '/queue'), commandButton('Про сервіс', '/about'), commandButton('Профіль і доступ', '/account'), commandButton('Назад', '/back')]); break;
      case '/about': message(COPY.about, navigation()); break;
      case '/app': action('open_app', { value: 'home' }); message(COPY.appIntent, navigation()); break;
      case '/digest': case '/history': action('open_app', { value: 'history' }); message(COPY.historyUnavailable, navigation()); break;
      case '/schedule': case '/now': case '/full': showSchedule(); break;
      case '/addresses': renderAddresses(); break;
      case '/add': beginAddress(); break;
      case '/settings': renderSettings(); break;
      case '/discard_draft': state.draft = null; message('Чернетку адреси відкинуто. Збережені адреси залишилися без змін.'); renderHome(); break;
      case '/draft': if (state.draft) renderWizard(); else message(BOT_COPY.engineText071, navigation()); break;
      case '/cancel': {
        const parent = parentStage();
        if (addressWizardStages.includes(state.stage)) { message('Додавання або зміну адреси зупинено. Чернетку збережено для продовження.'); renderHome(); }
        else { state.policyAddressId = null; message(COPY.cancelled); renderStage(parent); }
        break;
      }
      case '/back': {
        if (state.draft && addressWizardStages.includes(state.stage)) {
          const earlier: Partial<Record<BotStage, BotStage>> = { address_confirm: 'house', connection: 'house', house: 'street', street_choice: 'street', street: 'locality' };
          if (earlier[state.stage]) renderWizard(earlier[state.stage]); else renderHome();
        } else { const parent = parentStage(); state.policyAddressId = null; renderStage(parent); }
        break;
      }
      case '/pause': case '/stop': state.profile.preferences.paused = true; mutate(); action('cancel_pending_delivery', { reason: 'profile_paused' }); message(COPY.paused, [commandButton(BOT_COPY.engineText072, '/resume'), commandButton(BOT_COPY.engineText073, '/schedule')]); break;
      case '/resume': state.profile.preferences.paused = false; mutate(); message(state.profile.preferences.optedIn ? COPY.resumed : BOT_COPY.engineText074, navigation()); break;
      case '/notifications_off': state.profile.preferences.optedIn = false; mutate(); action('cancel_pending_delivery', { reason: 'opt_out' }); message(NOTIFICATION_COPY.telegramOff); renderSettings('telegram'); break;
      case '/notifications_on': {
        const verified = state.profile.locations.filter(l => l.binding.status === 'verified' && l.binding.kind !== 'user_selected_group');
        if (!verified.length && !state.profile.preferences.notificationPolicy) message(COPY.needVerified, [commandButton(BOT_COPY.engineText075, '/addresses')]);
        else { state.profile.preferences.optedIn = true; mutate(); message(COPY.globalNotificationsEnabled); renderSettings('telegram'); }
        break;
      }
      case '/reminders': state.policyAddressId = null; state.stage = 'reminder_time'; message(BOT_COPY.engineText077, wizardNav()); break;
      case '/quiet': state.stage = 'quiet_hours'; message(BOT_COPY.engineText079, wizardNav()); break;
      case '/briefing': state.stage = 'briefing_time'; message(BOT_COPY.engineText081, wizardNav()); break;
      case '/minimum': state.stage = 'minimum_duration'; message(BOT_COPY.engineText083, wizardNav()); break;
      case '/queue': {
        state.stage = 'manual_group'; const groups = context.manualGroups || [], page = boundedPage(state.catalogPage, groups.length); state.catalogPage = page;
        message(`${BOT_COPY.engineText085}${groups.length > ADDRESS_PAGE_SIZE ? `\nСторінка ${page + 1} з ${Math.ceil(groups.length / ADDRESS_PAGE_SIZE)}.` : ''}`, [...groups.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE).map(g => button(`${g.locality} · ${g.label}`, { kind: 'manual_group', value: g.id })), ...pageButtons('manual_group', page, groups.length), commandButton(BOT_COPY.engineText086, '/add'), commandButton('Назад', '/back')]); break;
      }
      case '/share': { const l = location(); if (l) { action('prepare_share', { addressId: l.address.id }); message(BOT_COPY.engineText088, navigation()); } else renderAddresses(); break; }
      case '/compare': action('open_app', { value: 'compare' }); message(BOT_COPY.engineText089, navigation()); break;
      case '/report': { if (!location()) renderAddresses(); else { state.stage = 'report'; message(BOT_COPY.engineText090, [button(BOT_COPY.engineText091, { kind: 'power_report', value: 'on' }), button(BOT_COPY.engineText092, { kind: 'power_report', value: 'off' }), commandButton(BOT_COPY.engineText093, '/back')]); } break; }
      case '/migration': {
        const status = context.migration?.status;
        message(status === 'complete' ? BOT_COPY.engineText094 : status === 'in_progress' ? BOT_COPY.engineText095 : status === 'failed' ? BOT_COPY.engineText096 : BOT_COPY.engineText097, [commandButton(BOT_COPY.engineText098, '/addresses')]); break;
      }
      case '/reset': state.stage = 'reset_confirm'; message(BOT_COPY.engineText099, [button(BOT_COPY.engineText100, { kind: 'confirm_reset' }), commandButton(BOT_COPY.engineText101, '/start')]); break;
      default: message(BOT_COPY.engineText102, navigation());
    }
  };

  if (callbackFailure) {
    message(callbackFailureText, [], 'error');
    renderStage(state.stage);
  } else if (callback) {
    switch (callback.kind) {
      case 'command': handleCommand(callback.value); break;
      case 'page': {
        if (callback.scope === 'addresses') { state.addressPage = callback.value; renderAddresses(); }
        else { state.catalogPage = callback.value; if (callback.scope === 'manual_group') handleCommand('/queue'); else if (callback.scope === 'street') renderStreetMatches(); else if (callback.scope === 'connection') renderConnections(); else renderWizard('locality'); }
        break;
      }
      case 'locality': {
        const option = context.addresses.find(o => localityKey(o) === callback.value);
        if (!option || !state.draft) { message(COPY.unavailableAction, wizardNav()); break; }
        state.draft.locality = option.address.locality; state.draft.territoryId = option.address.territoryId; state.catalogPage = 0;
        renderWizard('street'); break;
      }
      case 'street': {
        if (!state.draft) { renderHome(); break; }
        const option = scopedOptions().find(o => o.id === callback.value);
        if (!option) { message(COPY.noStreet, wizardNav()); break; }
        state.draft.street = option.address.street; state.catalogPage = 0;
        draftStage('house');
        const alias = state.draft.streetQuery && streetKey(state.draft.streetQuery) !== streetKey(option.address.street);
        message(`${alias ? BOT_COPY.engineText103(option.address.street) : ''}${COPY.house}`, wizardNav()); break;
      }
      case 'connection': { const option = context.addresses.find(o => o.id === callback.value); if (option) confirmOption(option); else message(COPY.noHouse, wizardNav()); break; }
      case 'confirm_address': {
        const draft = state.draft;
        const option = context.addresses.find(o => o.id === draft?.optionId);
        if (!draft || !option || draft.bindingRevision !== option.binding.revisionId) { message(BOT_COPY.engineText104, wizardNav()); if (state.draft) draftStage('house'); break; }
        const duplicate = state.profile.locations.find(l => l.address.id === option.address.id && l.address.id !== draft.originalAddressId);
        if (duplicate) { state.currentAddressId = duplicate.address.id; state.draft = null; message(BOT_COPY.engineText105); renderLocation(); break; }
        if (draft.operation === 'add' && state.profile.locations.length >= addressLimit) { message(BOT_COPY.engineText062(addressLimit)); renderAddresses(); break; }
        const address: AddressRecord = { ...clone(option.address), label: draft.label || (state.profile.locations.length ? BOT_COPY.engineText106(state.profile.locations.length + 1) : BOT_COPY.engineText107) };
        const next: BotLocation = { address, binding: clone(option.binding), notifications: false, paused: false };
        if (draft.operation === 'edit') {
          const index = state.profile.locations.findIndex(l => l.address.id === draft.originalAddressId);
          if (index < 0) { message(COPY.unavailableAction, navigation()); break; }
          const wasPrimary = state.profile.primaryAddressId === draft.originalAddressId;
          state.profile.locations[index] = next;
          if (wasPrimary) state.profile.primaryAddressId = address.id;
          action('cancel_pending_delivery', { addressId: draft.originalAddressId, reason: 'binding_changed' });
        } else state.profile.locations.push(next);
        state.currentAddressId = address.id;
        if (!state.profile.primaryAddressId) state.profile.primaryAddressId = address.id;
        state.draft = null; mutate();
        if (next.binding.status === 'verified' && next.binding.kind !== 'user_selected_group') {
          state.stage = 'subscription'; message(COPY.saved, [button(BOT_COPY.engineText108, { kind: 'subscription', value: 'on' }), button(BOT_COPY.engineText109, { kind: 'subscription', value: 'off' })]);
        } else { message(COPY.savedUnverified, navigation()); state.stage = 'home'; }
        break;
      }
      case 'subscription': {
        const l = location();
        if (callback.value === 'on' && l && l.binding.status === 'verified' && l.binding.kind !== 'user_selected_group') {
          l.notifications = true;
          if (!hasTypedPolicy()) state.profile.preferences.optedIn = true;
          mutate(); message(NOTIFICATION_COPY.localSaved, navigation());
        } else { if (l) { l.notifications = false; mutate(); } message(callback.value === 'on' ? COPY.needVerified : BOT_COPY.engineText111, navigation()); }
        state.stage = 'home'; break;
      }
      case 'location': state.currentAddressId = callback.value; renderLocation(); break;
      case 'location_action': {
        const l = location(); if (!l) { renderAddresses(); break; }
        if (callback.value === 'rename') { state.stage = 'rename'; message(BOT_COPY.engineText112, wizardNav()); }
        else if (callback.value === 'edit') beginAddress(true);
        else if (callback.value === 'primary') { state.profile.primaryAddressId = l.address.id; mutate(); message(BOT_COPY.engineText114); renderLocation('location_order'); }
        else if (callback.value === 'up' || callback.value === 'down') {
          const index = state.profile.locations.indexOf(l), nextIndex = index + (callback.value === 'up' ? -1 : 1);
          if (nextIndex >= 0 && nextIndex < state.profile.locations.length) { [state.profile.locations[index], state.profile.locations[nextIndex]] = [state.profile.locations[nextIndex], state.profile.locations[index]]; mutate(); }
          renderLocation('location_order');
        } else if (callback.value === 'pause') { l.paused = !l.paused; mutate(); if (l.paused) action('cancel_pending_delivery', { addressId: l.address.id, reason: 'address_paused' }); message(l.paused ? BOT_COPY.engineText115 : BOT_COPY.engineText116); renderLocation('location_notifications'); }
        else if (callback.value === 'notifications') {
          if (!hasTypedPolicy() && !l.notifications && (l.binding.status !== 'verified' || l.binding.kind === 'user_selected_group')) message(COPY.needVerified);
          else {
            l.notifications = !l.notifications;
            if (l.notifications && !hasTypedPolicy()) state.profile.preferences.optedIn = true;
            if (!l.notifications) action('cancel_pending_delivery', { addressId: l.address.id, reason: 'address_opt_out' });
            mutate(); message(NOTIFICATION_COPY.localSaved);
          }
          renderLocation('location_telegram');
        }
        else if (callback.value === 'delete') { state.stage = 'delete_confirm'; message(BOT_COPY.engineText117(l.address.label), [button(BOT_COPY.engineText118, { kind: 'confirm_delete' }), commandButton(BOT_COPY.engineText119, '/back'), commandButton('Скасувати', '/cancel')]); }
        else if (callback.value === 'share') handleCommand('/share');
        else handleCommand('/report');
        break;
      }
      case 'confirm_delete': {
        const id = state.currentAddressId;
        if (!id || !location()) { renderAddresses(); break; }
        state.profile.locations = state.profile.locations.filter(l => l.address.id !== id);
        if (state.profile.primaryAddressId === id) state.profile.primaryAddressId = state.profile.locations[0]?.address.id || null;
        state.currentAddressId = state.profile.primaryAddressId;
        action('cancel_pending_delivery', { addressId: id, reason: 'address_deleted' }); mutate();
        message(BOT_COPY.engineText120); renderAddresses(); break;
      }
      case 'manual_group': {
        const group = context.manualGroups?.find(g => g.id === callback.value);
        if (!group) { message(COPY.unavailableAction, navigation()); break; }
        const id = `manual:${encodeURIComponent(JSON.stringify([group.operatorId, group.namespace, group.targetId]))}`;
        if (!state.profile.locations.some(l => l.address.id === id)) {
          if (state.profile.locations.length >= addressLimit) { message(BOT_COPY.engineText121, navigation()); break; }
          state.profile.locations.push({ address: { id, label: BOT_COPY.engineText122(group.label), territoryId: group.namespace,
            locality: group.locality, street: '', house: { number: '', literal: '' }, aliases: [] },
          binding: { addressId: id, operatorId: group.operatorId, namespace: group.namespace, targetId: group.targetId,
            kind: 'user_selected_group', revisionId: group.revisionId, status: 'needs_confirmation', verifiedAt: null, effectiveFrom: null, effectiveUntil: null }, notifications: false, paused: false });
          if (!state.profile.primaryAddressId) state.profile.primaryAddressId = id;
          mutate();
        }
        state.currentAddressId = id; state.stage = 'home';
        message(BOT_COPY.engineText123, navigation()); break;
      }
      case 'confirm_reset': state.profile = createBotState({ ownerId: state.ownerId }).profile; state.currentAddressId = null; state.draft = null; mutate(); action('cancel_pending_delivery', { reason: 'profile_reset' }); message(BOT_COPY.engineText124, [commandButton(BOT_COPY.engineText125, '/add')]); state.stage = 'home'; break;
      case 'power_report': {
        const l = location(); if (!l) { renderAddresses(); break; }
        action('record_power_report', { addressId: l.address.id, value: callback.value });
        message(BOT_COPY.engineText126, navigation()); state.stage = 'home'; break;
      }
    }
  } else {
    const text = input.kind === 'callback' ? '' : input.text.trim();
    const typedNavigation: Record<string, string> = { 'назад': '/back', 'скасувати': '/cancel' };
    if (typedNavigation[textKey(text)]) handleCommand(typedNavigation[textKey(text)]);
    else if (text.startsWith('/')) handleCommand(text);
    else if (state.stage === 'street' || state.stage === 'street_choice') {
      if (!state.draft) renderHome();
      else if (streetKey(text).length < 2) message(BOT_COPY.engineText127, wizardNav());
      else {
        state.draft.streetQuery = text;
        state.catalogPage = 0; renderStreetMatches();
      }
    } else if (state.stage === 'house' || state.stage === 'connection') {
      if (!state.draft) renderHome();
      else {
        state.draft.house = text;
        const matches = streetOptions().filter(o => normalizeHouse(o.address.house.literal) === normalizeHouse(text));
        if (matches.length === 1) confirmOption(matches[0]);
        else if (matches.length > 1) { state.catalogPage = 0; renderConnections(); }
        else message(COPY.noHouse, wizardNav());
      }
    } else if (state.stage === 'rename') {
      const l = location();
      if (!l) renderAddresses();
      else if (!text || text.length > 60 || /[\u0000-\u001f]/.test(text)) message(BOT_COPY.engineText130, wizardNav());
      else { l.address.label = text; mutate(); message(BOT_COPY.engineText132); renderLocation('location_manage'); }
    } else if (['reminder_off_time', 'reminder_on_time', 'push_off_time', 'push_on_time'].includes(state.stage)) {
      const channel: NotificationChannel = state.stage.startsWith('push') ? 'push' : 'telegram';
      const field = state.stage.endsWith('off_time') ? 'beforeOffMinutes' : 'beforeOnMinutes';
      const local = typeof state.policyAddressId === 'string';
      const target = local ? state.profile.locations.find(item => item.address.id === state.policyAddressId) : undefined;
      const inherit = textKey(text) === 'як у каналі';
      if ((state.policyAddressId !== null && !local) || (local && !target)) { state.policyAddressId = null; message(NOTIFICATION_COPY.missingAddress, navigation()); state.stage = 'home'; }
      else if (!(local && inherit) && (!/^\d{1,4}$/.test(text) || Number(text) > 1440)) message(NOTIFICATION_COPY.invalidLead, wizardNav());
      else {
        if (target) {
          target.notificationPolicy = target.notificationPolicy ? parseLocationNotificationPolicy(target.notificationPolicy) : {
            version: 'lba-notification-policy/1', channels: { telegram: { enabled: target.notifications }, push: { enabled: false } },
          };
          if (inherit) delete target.notificationPolicy.channels[channel][field];
          else target.notificationPolicy.channels[channel][field] = Number(text);
        } else {
          const prefs = state.profile.preferences;
          prefs.notificationPolicy = prefs.notificationPolicy ? parseNotificationPolicy(prefs.notificationPolicy) : defaultNotificationPolicy(prefs);
          prefs.notificationPolicy.channels[channel][field] = Number(text);
        }
        const parent = parentStage(); mutate(); state.policyAddressId = null; message(target ? NOTIFICATION_COPY.localSaved : NOTIFICATION_COPY.saved);
        if (target) state.currentAddressId = target.address.id; renderStage(parent);
      }
    } else if (['reminder_time', 'minimum_duration'].includes(state.stage)) {
      const maximum = state.stage === 'minimum_duration' ? 86400 : 1440;
      if (!/^\d{1,5}$/.test(text) || Number(text) > maximum) message(`Введіть ціле число від 0 до ${maximum} хвилин.`, wizardNav());
      else {
        const value = Number(text), prefs = state.profile.preferences;
        if (state.stage === 'reminder_time') {
          prefs.reminders = value > 0; prefs.remindBeforeMinutes = value;
          if (prefs.notificationPolicy) {
            prefs.notificationPolicy = parseNotificationPolicy(prefs.notificationPolicy);
            Object.assign(prefs.notificationPolicy.channels.telegram, { remindersEnabled: value > 0, beforeOffMinutes: value, beforeOnMinutes: value });
          }
        } else prefs.minimumOutageMinutes = value;
        mutate(); renderSettings('timing');
      }
    } else if (state.stage === 'quiet_hours') {
      if (textKey(text) === BOT_COPY.engineText135) { state.profile.preferences.quietHours.enabled = false; mutate(); renderSettings('timing'); }
      else {
        const range = text.replace(/\s/g, '').split(/[–—-]/);
        if (range.length !== 2 || !range.every(validTime) || range[0] === range[1]) message(BOT_COPY.engineText136, wizardNav());
        else { state.profile.preferences.quietHours = { enabled: true, start: range[0], end: range[1], timezone: 'Europe/Kyiv' }; mutate(); renderSettings('timing'); }
      }
    } else if (state.stage === 'briefing_time') {
      if (textKey(text) === BOT_COPY.engineText138) { state.profile.preferences.morningBriefing.enabled = false; mutate(); renderSettings('timing'); }
      else if (!validTime(text)) message(BOT_COPY.engineText139, wizardNav());
      else { state.profile.preferences.morningBriefing = { enabled: true, time: text }; mutate(); renderSettings('timing'); }
    } else {
      const shortcuts: Record<string, string> = { 'графік': '/schedule', 'адреси': '/addresses', 'налаштування': '/settings', 'допомога': '/help', 'пауза': '/pause', 'назад': '/back', 'скасувати': '/cancel' };
      if (textKey(text) === BOT_COPY.engineText141 && state.draft && state.profile.preferences.paused) message(BOT_COPY.engineText142, [commandButton(BOT_COPY.engineText143, '/draft'), commandButton(BOT_COPY.engineText144, '/resume')]);
      else if (textKey(text) === BOT_COPY.engineText145) handleCommand(state.draft ? '/draft' : '/resume');
      else handleCommand(shortcuts[textKey(text)] || '/unknown');
    }
  }

  if (profileChanged) {
    actions.push({ type: 'persist_profile', idempotencyKey: `${state.ownerId}:${input.id}:profile`, simulationOnly: true });
    for (const item of messages) item.commitBarrier = 'profile';
  }
  const callbackKeys = Object.keys(state.callbacks);
  for (const key of callbackKeys.slice(0, Math.max(0, callbackKeys.length - 128))) delete state.callbacks[key];
  return { state, messages, actions, requiresCommit: true, ...(callbackFailure ? { rejected: callbackFailure } : {}) };
}

/** Trusted adapter entry: never accept schedule events from a user's callback body. */
export function handleScheduleEvent(previous: BotState, event: ScheduleEvent, view: ScheduleView, context: BotContext): BotTurn {
  if (context.actorId !== previous.ownerId) return rejected(previous, event.id, 'foreign_actor', COPY.foreignButton);
  if (!validInstant(context.now)) return rejected(previous, event.id, 'invalid_clock', COPY.unavailableAction);
  const validKinds = ['new_plan', 'changed', 'moved', 'cancelled', 'emergency', 'reminder'];
  const validEvent = typeof event.id === 'string' && Boolean(event.id) && validKinds.includes(event.kind) &&
    validInstant(event.createdAt) && Date.parse(event.createdAt) <= Date.parse(context.now);
  const matchingStatus = event.kind === 'emergency' ? view.status === 'emergency' :
    event.kind === 'cancelled' ? view.status === 'no_planned_outages' :
    event.kind === 'moved' ? ['published', 'possible'].includes(view.status) :
    event.kind === 'reminder' ? ['published', 'possible'].includes(view.status) :
    ['published', 'possible', 'no_planned_outages'].includes(view.status);
  if (!validEvent || !matchingStatus) return { state: previous, messages: [], actions: [], requiresCommit: false };
  if (previous.processedEventIds.includes(event.id)) return { state: previous, messages: [], actions: [], requiresCommit: false, duplicate: true };
  const l = previous.profile.locations.find(item => item.address.id === event.addressId);
  // An adapter or provider fault must close this gate, not manufacture a notification.
  let deliverable = false;
  try { deliverable = Boolean(l && resolveNotificationPolicy(previous.profile.preferences, l, 'telegram').enabled && canDeliver(view, l.binding, previous.profile.preferences, context.now)); } catch { /* invalid provider contract */ }
  const reminder = event.reminder;
  const leadMinutes = l && reminder ? reminderLeadMinutes(previous.profile.preferences, l, 'telegram', reminder.edge) : 0;
  const reminderAllowed = event.kind !== 'reminder' || (
    Number.isInteger(leadMinutes) && leadMinutes >= 1 && leadMinutes <= 1440 && reminder &&
    ['starts', 'ends'].includes(reminder.edge) && validInstant(reminder.intervalStartsAt) && validInstant(reminder.intervalEndsAt) && view.intervals.some(interval => {
      if (Date.parse(interval.startsAt) !== Date.parse(reminder.intervalStartsAt) || Date.parse(interval.endsAt) !== Date.parse(reminder.intervalEndsAt)) return false;
      const edge = Date.parse(reminder.edge === 'starts' ? interval.startsAt : interval.endsAt);
      const due = edge - leadMinutes * 60000, now = Date.parse(context.now);
      return now >= due && now < due + 60000 &&
        reminderDurationEligible(previous.profile.preferences, reminder.edge, (Date.parse(interval.endsAt) - Date.parse(interval.startsAt)) / 60000);
    }));
  if (!l || !l.notifications || l.paused || event.addressId !== view.addressId || event.operatorId !== view.operatorId ||
      event.serviceDate !== view.serviceDate || event.toRevisionId !== view.revisionId ||
      !deliverable || !reminderAllowed) {
    return { state: previous, messages: [], actions: [], requiresCommit: false };
  }
  const state = clone(previous);
  state.processedEventIds = [...state.processedEventIds, event.id].slice(-512);
  const displayView: ScheduleView = { ...view, addressLabel: l.address.label };
  const message: BotMessage = { id: `event:${event.id}`, kind: 'notification', text: formatNotification(event.kind, displayView, reminder?.edge),
    buttons: [], commitBarrier: 'profile', scheduleRevisionId: view.revisionId };
  const actions: BotAction[] = [];
  if (event.kind === 'emergency') actions.push({ type: 'cancel_pending_delivery', idempotencyKey: `event:${event.id}:${state.ownerId}:cancel-planned`, addressId: view.addressId, eventId: event.id, reason: 'emergency_mode', simulationOnly: true });
  actions.push({ type: 'enqueue_simulated_delivery', idempotencyKey: `event:${event.id}:${state.ownerId}`, addressId: view.addressId, eventId: event.id, simulationOnly: true });
  return { state, messages: [message], actions, requiresCommit: true };
}

