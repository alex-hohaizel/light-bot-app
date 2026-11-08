import type { ProductPreferences } from './product-contract.ts';
import type { BotProfile } from './bot/types.ts';

export const NOTIFICATION_POLICY_VERSION = 'lba-notification-policy/1' as const;
export type NotificationChannel = 'telegram' | 'push';
export type ReminderEdge = 'starts' | 'ends';
export interface ChannelNotificationPolicy {
  enabled: boolean;
  remindersEnabled: boolean;
  beforeOffMinutes: number;
  beforeOnMinutes: number;
}
export interface NotificationPolicy {
  version: typeof NOTIFICATION_POLICY_VERSION;
  channels: Record<NotificationChannel, ChannelNotificationPolicy>;
}
export interface LocationChannelPolicy {
  enabled: boolean;
  /** Missing means inherit that channel's global value; explicit0 means off. */
  beforeOffMinutes?: number;
  beforeOnMinutes?: number;
}
export interface LocationNotificationPolicy {
  version: typeof NOTIFICATION_POLICY_VERSION;
  channels: Record<NotificationChannel, LocationChannelPolicy>;
}
export interface NotificationLocation {
  notifications: boolean;
  paused: boolean;
  notificationPolicy?: LocationNotificationPolicy;
}

const invalid = (): never => { throw new Error('INVALID_NOTIFICATION_POLICY'); };
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) return invalid();
  return result;
}
function flag(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }
function minutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1440) return invalid();
  return value;
}
export function parseNotificationPolicy(value: unknown): NotificationPolicy {
  const policy = record(value, ['version', 'channels']);
  if (policy.version !== NOTIFICATION_POLICY_VERSION) return invalid();
  const channels = record(policy.channels, ['telegram', 'push']);
  const channel = (name: NotificationChannel): ChannelNotificationPolicy => {
    const input = record(channels[name], ['enabled', 'remindersEnabled', 'beforeOffMinutes', 'beforeOnMinutes']);
    return { enabled: flag(input.enabled), remindersEnabled: flag(input.remindersEnabled),
      beforeOffMinutes: minutes(input.beforeOffMinutes), beforeOnMinutes: minutes(input.beforeOnMinutes) };
  };
  return { version: NOTIFICATION_POLICY_VERSION, channels: { telegram: channel('telegram'), push: channel('push') } };
}
export function parseLocationNotificationPolicy(value: unknown): LocationNotificationPolicy {
  const policy = record(value, ['version', 'channels']);
  if (policy.version !== NOTIFICATION_POLICY_VERSION) return invalid();
  const channels = record(policy.channels, ['telegram', 'push']);
  const channel = (name: NotificationChannel): LocationChannelPolicy => {
    const input = record(channels[name], ['enabled', 'beforeOffMinutes', 'beforeOnMinutes']);
    return { enabled: flag(input.enabled), ...(Object.hasOwn(input, 'beforeOffMinutes') ? { beforeOffMinutes: minutes(input.beforeOffMinutes) } : {}),
      ...(Object.hasOwn(input, 'beforeOnMinutes') ? { beforeOnMinutes: minutes(input.beforeOnMinutes) } : {}) };
  };
  return { version: NOTIFICATION_POLICY_VERSION, channels: { telegram: channel('telegram'), push: channel('push') } };
}
export function defaultNotificationPolicy(preferences: ProductPreferences): NotificationPolicy {
  if (typeof preferences.optedIn !== 'boolean' || typeof preferences.paused !== 'boolean' || typeof preferences.reminders !== 'boolean') return invalid();
  const lead = minutes(preferences.remindBeforeMinutes);
  return { version: NOTIFICATION_POLICY_VERSION, channels: {
    telegram: { enabled: preferences.optedIn, remindersEnabled: preferences.reminders, beforeOffMinutes: lead, beforeOnMinutes: lead },
    push: { enabled: false, remindersEnabled: false, beforeOffMinutes: 0, beforeOnMinutes: 0 },
  } };
}
export function globalNotificationPolicy(preferences: ProductPreferences, channel: NotificationChannel = 'telegram'): ChannelNotificationPolicy {
  if (!['telegram', 'push'].includes(channel) || typeof preferences.optedIn !== 'boolean' || typeof preferences.paused !== 'boolean' || typeof preferences.reminders !== 'boolean') return invalid();
  const policy = preferences.notificationPolicy === undefined ? defaultNotificationPolicy(preferences) : parseNotificationPolicy(preferences.notificationPolicy);
  const value = policy.channels[channel];
  return { ...value, enabled: value.enabled && !preferences.paused && (channel !== 'telegram' || preferences.optedIn),
    remindersEnabled: value.remindersEnabled && (channel !== 'telegram' || preferences.reminders) };
}
export function resolveNotificationPolicy(preferences: ProductPreferences, location: NotificationLocation, channel: NotificationChannel = 'telegram'): ChannelNotificationPolicy {
  if (typeof location.notifications !== 'boolean' || typeof location.paused !== 'boolean') return invalid();
  const global = globalNotificationPolicy(preferences, channel);
  const local = location.notificationPolicy === undefined ? undefined : parseLocationNotificationPolicy(location.notificationPolicy).channels[channel];
  const localEnabled = channel === 'telegram' ? location.notifications && (local?.enabled ?? true) : local?.enabled === true;
  return { ...global, enabled: global.enabled && localEnabled && !location.paused,
    beforeOffMinutes: local?.beforeOffMinutes ?? global.beforeOffMinutes,
    beforeOnMinutes: local?.beforeOnMinutes ?? global.beforeOnMinutes };
}
/** Returns0 when disabled. It never replaces an explicit0 with a default. */
export function reminderLeadMinutes(preferences: ProductPreferences, location: NotificationLocation, channel: NotificationChannel, edge: ReminderEdge): number {
  if (!['starts', 'ends'].includes(edge)) return 0;
  try {
    const policy = resolveNotificationPolicy(preferences, location, channel);
    return policy.enabled && policy.remindersEnabled ? (edge === 'starts' ? policy.beforeOffMinutes : policy.beforeOnMinutes) : 0;
  } catch { return 0; }
}
/** Legacy minimum was an hours-based before-off filter, never a before-on filter. */
export function reminderDurationEligible(preferences: { minimumOutageMinutes?: number }, edge: ReminderEdge, durationMinutes: number): boolean {
  if (!['starts', 'ends'].includes(edge) || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return false;
  if (edge === 'ends') return true;
  const minimum = preferences.minimumOutageMinutes ?? 0;
  return Number.isInteger(minimum) && minimum >= 0 && minimum <= 86400 && durationMinutes >= minimum;
}

/** Bridge old command intents to typed settings without restoring another channel. */
export function syncLegacyPolicyChanges(before: BotProfile, after: BotProfile): BotProfile {
  if (before.id !== after.id) throw new Error('PROFILE_POLICY_IDENTITY_MISMATCH');
  for (const profile of [before, after]) {
    flag(profile.preferences.optedIn); flag(profile.preferences.paused); flag(profile.preferences.reminders); minutes(profile.preferences.remindBeforeMinutes);
    for (const location of profile.locations) { flag(location.notifications); flag(location.paused); }
    if (profile.legacyNotificationPolicySourceHash !== undefined && !/^[a-f0-9]{64}$/.test(profile.legacyNotificationPolicySourceHash)) throw new Error('INVALID_LEGACY_POLICY_ORIGIN');
  }
  if (after.legacyNotificationPolicySourceHash !== undefined && after.legacyNotificationPolicySourceHash !== before.legacyNotificationPolicySourceHash) throw new Error('INVALID_LEGACY_POLICY_ORIGIN');
  const profile = structuredClone(after);
  if (before.legacyNotificationPolicySourceHash && profile.id === before.id && !profile.legacyNotificationPolicySourceHash) {
    profile.legacyNotificationPolicySourceHash = before.legacyNotificationPolicySourceHash;
  }
  if (profile.preferences.notificationPolicy !== undefined) {
    const policy = parseNotificationPolicy(profile.preferences.notificationPolicy);
    const prior = before.preferences.notificationPolicy === undefined ? undefined : parseNotificationPolicy(before.preferences.notificationPolicy);
    const explicitlyChanged = !prior || JSON.stringify(prior) !== JSON.stringify(policy);
    if (!explicitlyChanged) {
      if (before.preferences.optedIn !== profile.preferences.optedIn) policy.channels.telegram.enabled = flag(profile.preferences.optedIn);
      if (before.preferences.reminders !== profile.preferences.reminders) policy.channels.telegram.remindersEnabled = flag(profile.preferences.reminders);
      if (before.preferences.remindBeforeMinutes !== profile.preferences.remindBeforeMinutes) {
        policy.channels.telegram.beforeOffMinutes = minutes(profile.preferences.remindBeforeMinutes);
        policy.channels.telegram.beforeOnMinutes = minutes(profile.preferences.remindBeforeMinutes);
      }
    }
    profile.preferences.notificationPolicy = policy;
    profile.preferences.optedIn = policy.channels.telegram.enabled;
    profile.preferences.reminders = policy.channels.telegram.remindersEnabled;
    profile.preferences.remindBeforeMinutes = policy.channels.telegram.beforeOffMinutes;
  }
  for (const location of profile.locations) {
    if (location.notificationPolicy === undefined) continue;
    const policy = parseLocationNotificationPolicy(location.notificationPolicy);
    const previous = before.locations.find(item => item.address.id === location.address.id);
    const prior = previous?.notificationPolicy === undefined ? undefined : parseLocationNotificationPolicy(previous.notificationPolicy);
    const explicitlyChanged = !prior || JSON.stringify(prior) !== JSON.stringify(policy);
    if (!explicitlyChanged && previous && previous.notifications !== location.notifications) policy.channels.telegram.enabled = flag(location.notifications);
    location.notificationPolicy = policy;
    location.notifications = policy.channels.telegram.enabled;
  }
  return profile;
}
