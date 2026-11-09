import type { AddressOption, BotLocation, BotState } from '../../shared/bot/types.ts';
import type { ProfileMutation, ProfilePreferences, ProfileRequest } from '../../shared/profile-mutation.ts';
import { parseLocationNotificationPolicy, parseNotificationPolicy, syncLegacyPolicyChanges } from '../../shared/notification-policy.ts';
import { MAX_PROFILE_ADDRESSES } from '../../shared/profile-constraints.ts';
import { addressOptionFingerprint } from '../../shared/address-selection.ts';

const invalid = () => { throw new Error('INVALID_PROFILE_INPUT'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function string(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) return invalid();
  return value.trim();
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return invalid();
  return value;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return invalid(); return value;
}
function preferencePatch(value: unknown): Partial<ProfilePreferences> {
  const patch = object(value);
  keys(patch, ['optedIn', 'paused', 'reminders', 'remindBeforeMinutes', 'quietHours', 'morningBriefing', 'minimumOutageMinutes', 'notificationPolicy']);
  if (!Object.keys(patch).length) invalid();
  const parsed: Partial<ProfilePreferences> = {};
  for (const field of ['optedIn', 'paused', 'reminders'] as const) if (Object.hasOwn(patch, field)) parsed[field] = boolean(patch[field]);
  if (Object.hasOwn(patch, 'remindBeforeMinutes')) parsed.remindBeforeMinutes = integer(patch.remindBeforeMinutes, 0, 1440);
  if (Object.hasOwn(patch, 'minimumOutageMinutes')) parsed.minimumOutageMinutes = integer(patch.minimumOutageMinutes, 0, 86400);
  if (Object.hasOwn(patch, 'notificationPolicy')) {
    try { parsed.notificationPolicy = parseNotificationPolicy(patch.notificationPolicy); } catch { invalid(); }
    const telegram = parsed.notificationPolicy!.channels.telegram;
    if ((parsed.optedIn !== undefined && parsed.optedIn !== telegram.enabled) ||
        (parsed.reminders !== undefined && parsed.reminders !== telegram.remindersEnabled) ||
        (parsed.remindBeforeMinutes !== undefined && parsed.remindBeforeMinutes !== telegram.beforeOffMinutes)) invalid();
  }
  if (Object.hasOwn(patch, 'quietHours')) {
    const quiet = object(patch.quietHours); keys(quiet, ['enabled', 'start', 'end', 'timezone']);
    if (quiet.timezone !== 'Europe/Kyiv') invalid();
    const start = time(quiet.start), end = time(quiet.end);
    const enabled = boolean(quiet.enabled);
    if (enabled && start === end) invalid();
    parsed.quietHours = { enabled, start, end, timezone: 'Europe/Kyiv' };
  }
  if (Object.hasOwn(patch, 'morningBriefing')) {
    const briefing = object(patch.morningBriefing); keys(briefing, ['enabled', 'time']);
    parsed.morningBriefing = { enabled: boolean(briefing.enabled), time: time(briefing.time) };
  }
  return parsed;
}
/** Explicit request boundary: callers cannot supply owner, binding or a complete profile. */
export function parseProfileRequest(value: unknown): ProfileRequest {
  const request = object(value); keys(request, ['id', 'expectedSessionId', 'expectedRevision', 'mutation']);
  const id = string(request.id, 96);
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) invalid();
  const expectedRevision = integer(request.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
  const expectedSessionId = string(request.expectedSessionId);
  const raw = object(request.mutation);
  let mutation: ProfileMutation;
  switch (raw.kind) {
    case 'add': case 'replace': {
      keys(raw, raw.kind === 'add' ? ['kind', 'optionId', 'bindingRevisionId', 'selectionFingerprint', 'label', 'confirmed'] : ['kind', 'addressId', 'optionId', 'bindingRevisionId', 'selectionFingerprint', 'label', 'confirmed']);
      if (raw.confirmed !== true) invalid();
      const fields = { optionId: string(raw.optionId), bindingRevisionId: string(raw.bindingRevisionId),
        ...(raw.selectionFingerprint !== undefined ? { selectionFingerprint: string(raw.selectionFingerprint, 32768) } : {}),
        label: string(raw.label, 60), confirmed: true as const };
      mutation = raw.kind === 'add' ? { kind: 'add', ...fields } : { kind: 'replace', addressId: string(raw.addressId), ...fields };
      break;
    }
    case 'rename': keys(raw, ['kind', 'addressId', 'label']); mutation = { kind: 'rename', addressId: string(raw.addressId), label: string(raw.label, 60) }; break;
    case 'delete': keys(raw, ['kind', 'addressId', 'confirmed']); if (raw.confirmed !== true) invalid(); mutation = { kind: 'delete', addressId: string(raw.addressId), confirmed: true }; break;
    case 'primary': keys(raw, ['kind', 'addressId']); mutation = { kind: 'primary', addressId: string(raw.addressId) }; break;
    case 'move': {
      keys(raw, ['kind', 'addressId', 'direction']);
      if (raw.direction !== 'up' && raw.direction !== 'down') invalid();
      mutation = { kind: 'move', addressId: string(raw.addressId), direction: raw.direction as 'up' | 'down' }; break;
    }
    case 'location': {
      keys(raw, ['kind', 'addressId', 'paused', 'notifications', 'notificationPolicy']);
      if (!Object.hasOwn(raw, 'paused') && !Object.hasOwn(raw, 'notifications') && !Object.hasOwn(raw, 'notificationPolicy')) invalid();
      let notificationPolicy;
      if (Object.hasOwn(raw, 'notificationPolicy')) {
        try { notificationPolicy = parseLocationNotificationPolicy(raw.notificationPolicy); } catch { invalid(); }
        if (Object.hasOwn(raw, 'notifications') && boolean(raw.notifications) !== notificationPolicy!.channels.telegram.enabled) invalid();
      }
      mutation = { kind: 'location', addressId: string(raw.addressId),
        ...(Object.hasOwn(raw, 'paused') ? { paused: boolean(raw.paused) } : {}),
        ...(Object.hasOwn(raw, 'notifications') ? { notifications: boolean(raw.notifications) } : {}),
        ...(notificationPolicy ? { notificationPolicy } : {}) };
      break;
    }
    case 'preferences': keys(raw, ['kind', 'patch']); mutation = { kind: 'preferences', patch: preferencePatch(raw.patch) }; break;
    default: return invalid();
  }
  return { id, expectedSessionId, expectedRevision, mutation };
}

export function applyProfileMutation(previous: BotState, request: ProfileRequest, catalog: AddressOption[]) {
  if (request.expectedSessionId !== previous.sessionId || request.expectedRevision !== previous.revision) throw new Error('PROFILE_REVISION_CONFLICT');
  const state = structuredClone(previous), mutation = request.mutation;
  const cancelledAddresses: Array<string | null> = [];
  const location = (id: string) => {
    const found = state.profile.locations.find(item => item.address.id === id);
    if (!found) throw new Error('PROFILE_ADDRESS_NOT_FOUND');
    return found;
  };
  const canSubscribe = (id: string) => {
    const found = location(id);
    if (found.binding.status !== 'verified' || !['building', 'connection', 'operator_group'].includes(found.binding.kind)) throw new Error('PROFILE_BINDING_NOT_VERIFIED');
  };
  if (mutation.kind === 'add' || mutation.kind === 'replace') {
    const options = catalog.filter(option => option.id === mutation.optionId);
    if (options.length !== 1) throw new Error('PROFILE_OPTION_NOT_FOUND');
    const option = options[0];
    if (option.binding.revisionId !== mutation.bindingRevisionId) throw new Error('PROFILE_BINDING_REVISION_CONFLICT');
    if (mutation.selectionFingerprint !== undefined && mutation.selectionFingerprint !== addressOptionFingerprint(option)) throw new Error('PROFILE_SELECTION_CHANGED');
    const duplicate = state.profile.locations.find(item => item.address.id === option.address.id &&
      (mutation.kind !== 'replace' || item.address.id !== mutation.addressId));
    if (duplicate) throw new Error('PROFILE_ADDRESS_ALREADY_SAVED');
    const replacement: BotLocation = { address: { ...structuredClone(option.address), label: mutation.label }, binding: structuredClone(option.binding), paused: false, notifications: false };
    if (mutation.kind === 'add') {
      if (state.profile.locations.length >= MAX_PROFILE_ADDRESSES) throw new Error('PROFILE_ADDRESS_LIMIT');
      state.profile.locations.push(replacement);
      if (!state.profile.primaryAddressId) state.profile.primaryAddressId = replacement.address.id;
    } else {
      const old = location(mutation.addressId);
      const sameBinding = old.address.id === option.address.id && option.binding.status === 'verified' &&
        ['building', 'connection', 'operator_group'].includes(option.binding.kind) &&
        (['addressId', 'operatorId', 'revisionId', 'namespace', 'targetId', 'kind', 'status', 'verifiedAt', 'effectiveFrom', 'effectiveUntil'] as const)
          .every(key => old.binding[key] === option.binding[key]);
      replacement.paused = old.paused; replacement.notifications = sameBinding ? old.notifications : false;
      if (old.notificationPolicy !== undefined) {
        replacement.notificationPolicy = parseLocationNotificationPolicy(old.notificationPolicy);
        if (!sameBinding) for (const channel of ['telegram', 'push'] as const) replacement.notificationPolicy.channels[channel].enabled = false;
      }
      state.profile.locations[state.profile.locations.indexOf(old)] = replacement;
      if (state.profile.primaryAddressId === old.address.id) state.profile.primaryAddressId = replacement.address.id;
      if (state.currentAddressId === old.address.id) state.currentAddressId = replacement.address.id;
      cancelledAddresses.push(old.address.id);
    }
  } else if (mutation.kind === 'rename') location(mutation.addressId).address.label = mutation.label;
  else if (mutation.kind === 'delete') {
    location(mutation.addressId);
    state.profile.locations = state.profile.locations.filter(item => item.address.id !== mutation.addressId);
    if (state.profile.primaryAddressId === mutation.addressId) state.profile.primaryAddressId = state.profile.locations[0]?.address.id || null;
    if (state.currentAddressId === mutation.addressId) state.currentAddressId = state.profile.primaryAddressId;
    cancelledAddresses.push(mutation.addressId);
  } else if (mutation.kind === 'primary') {
    location(mutation.addressId); state.profile.primaryAddressId = mutation.addressId; state.currentAddressId = mutation.addressId;
  } else if (mutation.kind === 'move') {
    const found = location(mutation.addressId), index = state.profile.locations.indexOf(found);
    const next = index + (mutation.direction === 'up' ? -1 : 1);
    if (next >= 0 && next < state.profile.locations.length) {
      [state.profile.locations[index], state.profile.locations[next]] = [state.profile.locations[next], state.profile.locations[index]];
    }
  } else if (mutation.kind === 'location') {
    const found = location(mutation.addressId);
    const explicitPolicy = state.profile.preferences.notificationPolicy !== undefined || state.profile.locations.some(item => item.notificationPolicy !== undefined) || mutation.notificationPolicy !== undefined;
    if (mutation.notifications === true && mutation.notificationPolicy === undefined) {
      canSubscribe(mutation.addressId);
      if (!explicitPolicy) state.profile.preferences.optedIn = true;
    }
    if (mutation.notificationPolicy !== undefined) {
      found.notificationPolicy = parseLocationNotificationPolicy(mutation.notificationPolicy);
      found.notifications = found.notificationPolicy.channels.telegram.enabled;
    }
    if (mutation.notifications !== undefined) found.notifications = mutation.notifications;
    if (mutation.paused !== undefined) found.paused = mutation.paused;
    if (found.paused || !found.notifications) cancelledAddresses.push(mutation.addressId);
  } else if (mutation.kind === 'preferences') {
    if (mutation.patch.notificationPolicy === undefined && mutation.patch.optedIn === true && !state.profile.locations.some(item => item.binding.status === 'verified' && ['building', 'connection', 'operator_group'].includes(item.binding.kind))) throw new Error('PROFILE_BINDING_NOT_VERIFIED');
    state.profile.preferences = { ...state.profile.preferences, ...mutation.patch };
    // Global consent/resume never changes any address's own opt-out.
    if (mutation.patch.optedIn === false || mutation.patch.paused === true || mutation.patch.reminders === false || mutation.patch.quietHours !== undefined || mutation.patch.notificationPolicy !== undefined) cancelledAddresses.push(null);
  }
  state.profile = syncLegacyPolicyChanges(previous.profile, state.profile);
  state.revision += 1;
  // Preserve the bot draft; old callbacks retain their old revision and are rejected.
  return { state, cancelledAddresses };
}
