import { createHash } from 'node:crypto';
import type { LegacyRow, MigratedAccount, JsonValue } from '../../shared/legacy-migration-contract.ts';
import { NOTIFICATION_POLICY_VERSION, parseNotificationPolicy, parseLocationNotificationPolicy } from '../../shared/notification-policy.ts';

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function archiveHash(value: unknown): string { return createHash('sha256').update(canonical(value as JsonValue)).digest('hex'); }
const invalid = (): never => { throw new Error('INVALID_LEGACY_NOTIFICATION_POLICY'); };
function flag(row: LegacyRow, field: string, absent = false): boolean {
  if (!Object.hasOwn(row, field)) return absent;
  if (typeof row[field] !== 'boolean') return invalid(); return row[field];
}
function integer(row: LegacyRow, field: string, absent: number, max = 1440): number {
  if (!Object.hasOwn(row, field)) return absent;
  const value = row[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) return invalid(); return value;
}
const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
type Carrier = 'location' | 'settings' | 'subscriber';
const commonRules = ['quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd', 'morningBriefingEnabled', 'morningBriefingHour', 'minOutageDuration'];
const knownPolicyFields: Record<Carrier, Set<string>> = {
  settings: new Set(['notificationsEnabled', 'notifyBeforeOff', 'notifyBeforeOn', 'telegramNotifications', 'telegramNotifyBeforeOff', 'telegramNotifyBeforeOn', ...commonRules]),
  subscriber: new Set(['notifyBeforeOff', 'notifyBeforeOn', ...commonRules]),
  location: new Set(['notifyEnabled', 'notifyBeforeOff', 'notifyBeforeOn', 'telegramNotify']),
};
/** Unknown policy meaning is retained for reconciliation, never silently enabled. */
function unmappedPolicyFields(row: LegacyRow, carrier: Carrier): string[] {
  return Object.keys(row).filter(key => /^(?:notif|telegramNotif|quietHours|morningBriefing|minOutage)/i.test(key) && !knownPolicyFields[carrier].has(key));
}
function unknownAffects(fields: string[], carrier: Carrier, channel: 'telegram' | 'push'): boolean {
  if (carrier === 'subscriber') return channel === 'telegram' && fields.length > 0;
  return fields.some(field => channel === 'push' ? !/^telegram/i.test(field) : carrier === 'location' || !/^notif/i.test(field));
}

/**
 * Initialize exact known policies once on a synthetic migration account. It has
 * no IO, runtime dependency on the migration planner, identity proof or sender.
 */
export function projectLegacyNotificationPolicy(input: MigratedAccount): MigratedAccount {
  const account = structuredClone(input);
  if (!/^[a-f0-9]{64}$/.test(account.sourceHash) || archiveHash(account.archive) !== account.sourceHash) throw new Error('LEGACY_POLICY_SOURCE_HASH_MISMATCH');
  if (account.classification === 'conflict') {
    if (account.profile !== null) return invalid();
    return account;
  }
  if (!account.profile || account.profile.id !== account.accountId) return invalid();
  const profile = account.profile;
  if (profile.legacyNotificationPolicySourceHash !== undefined) {
    if (profile.legacyNotificationPolicySourceHash !== account.sourceHash) throw new Error('LEGACY_POLICY_RECONCILIATION_REQUIRED');
    // Preserve subsequent edits and even an intentional reset; never replay old consent.
    if (profile.preferences.notificationPolicy !== undefined) parseNotificationPolicy(profile.preferences.notificationPolicy);
    for (const location of profile.locations) if (location.notificationPolicy !== undefined) parseLocationNotificationPolicy(location.notificationPolicy);
    return account;
  }
  if (profile.preferences.notificationPolicy !== undefined || profile.locations.some(location => location.notificationPolicy !== undefined)) throw new Error('LEGACY_POLICY_ALREADY_CONFIGURED');
  if (profile.locations.some(location => location.binding.status === 'verified' || location.binding.verifiedAt !== null)) throw new Error('LEGACY_POLICY_CANNOT_VERIFY_BINDING');
  const settingsRows = account.archive.userSettings || [], subscribers = account.archive.telegramSubscribers || [];
  if (settingsRows.length > 1) return invalid();
  const settings = settingsRows[0], primary = settings || subscribers[0] || {};
  const addIssue = (code: string, fields: string[]) => {
    const existing = account.issues.find(issue => issue.code === code);
    if (existing) existing.sourceRefs = [...new Set([...existing.sourceRefs, ...fields])].sort();
    else account.issues.push({ code, sourceRefs: fields,
      nextAction: 'Keep the affected channel off; reconcile preserved source values with the authenticated owner before delivery.' });
  };
  const telegramOff = integer(primary, settings ? 'telegramNotifyBeforeOff' : 'notifyBeforeOff', 30);
  const telegramOn = integer(primary, settings ? 'telegramNotifyBeforeOn' : 'notifyBeforeOn', 15);
  const pushOff = settings ? integer(settings, 'notifyBeforeOff', 30) : 0;
  const pushOn = settings ? integer(settings, 'notifyBeforeOn', 15) : 0;
  const consent = [...(settings ? [flag(settings, 'telegramNotifications')] : []), ...subscribers.map(row => flag(row, 'enabled'))];
  let telegramEnabled = profile.preferences.optedIn && consent.length > 0 && consent.every(Boolean);
  let pushEnabled = settings ? flag(settings, 'notificationsEnabled') : false;
  if (settings) {
    const unknown = unmappedPolicyFields(settings, 'settings');
    if (unknown.length) {
      addIssue('legacy_policy_unmapped_notification_fields', unknown.map(field => `userSettings.${field}`));
      if (unknownAffects(unknown, 'settings', 'push')) pushEnabled = false;
      if (unknownAffects(unknown, 'settings', 'telegram')) telegramEnabled = false;
    }
  }
  const subscriberUnknown = subscribers.flatMap(row => unmappedPolicyFields(row, 'subscriber').map(field => `telegramSubscribers.${String(row.chatId)}.${field}`));
  if (subscriberUnknown.length) { telegramEnabled = false; addIssue('legacy_policy_unmapped_notification_fields', subscriberUnknown); }
  if (new Set(consent).size > 1) addIssue('legacy_policy_consent_disagrees', ['userSettings.telegramNotifications', 'telegramSubscribers.enabled']);
  // A single modern account policy cannot silently choose different endpoint rules.
  if ((settings || subscribers.length > 1) && subscribers.some(row => integer(row, 'notifyBeforeOff', 30) !== telegramOff || integer(row, 'notifyBeforeOn', 15) !== telegramOn)) {
    telegramEnabled = false;
    addIssue('legacy_policy_endpoint_thresholds_disagree', [
      ...(settings ? ['userSettings.telegramNotifyBeforeOff', 'userSettings.telegramNotifyBeforeOn'] : []),
      'telegramSubscribers.notifyBeforeOff', 'telegramSubscribers.notifyBeforeOn']);
  }
  const quietEnabled = flag(primary, 'quietHoursEnabled'), quietStart = integer(primary, 'quietHoursStart', 23, 23), quietEnd = integer(primary, 'quietHoursEnd', 7, 23);
  const briefingEnabled = flag(primary, 'morningBriefingEnabled'), briefingHour = integer(primary, 'morningBriefingHour', 7, 23);
  const minimumHours = integer(primary, 'minOutageDuration', 0);
  if (settings) {
    const comparable = ['quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd', 'morningBriefingEnabled', 'morningBriefingHour', 'minOutageDuration'];
    if (subscribers.some(row =>
      flag(row, 'quietHoursEnabled') !== quietEnabled || integer(row, 'quietHoursStart', 23, 23) !== quietStart || integer(row, 'quietHoursEnd', 7, 23) !== quietEnd ||
      flag(row, 'morningBriefingEnabled') !== briefingEnabled || integer(row, 'morningBriefingHour', 7, 23) !== briefingHour || integer(row, 'minOutageDuration', 0) !== minimumHours)) {
      telegramEnabled = false;
      addIssue('legacy_policy_global_rules_disagree', comparable.map(field => `userSettings/telegramSubscribers.${field}`));
    }
  } else if (subscribers.length > 1 && subscribers.some(row =>
    flag(row, 'quietHoursEnabled') !== quietEnabled || integer(row, 'quietHoursStart', 23, 23) !== quietStart || integer(row, 'quietHoursEnd', 7, 23) !== quietEnd ||
    flag(row, 'morningBriefingEnabled') !== briefingEnabled || integer(row, 'morningBriefingHour', 7, 23) !== briefingHour || integer(row, 'minOutageDuration', 0) !== minimumHours)) {
    telegramEnabled = false; addIssue('legacy_policy_endpoint_rules_disagree', ['telegramSubscribers.quietHours/morningBriefing/minOutageDuration']);
  }
  profile.preferences.notificationPolicy = parseNotificationPolicy({ version: NOTIFICATION_POLICY_VERSION, channels: {
    telegram: { enabled: telegramEnabled, remindersEnabled: telegramOff > 0 || telegramOn > 0, beforeOffMinutes: telegramOff, beforeOnMinutes: telegramOn },
    push: { enabled: pushEnabled, remindersEnabled: pushOff > 0 || pushOn > 0, beforeOffMinutes: pushOff, beforeOnMinutes: pushOn },
  } });
  profile.preferences.optedIn = telegramEnabled;
  profile.preferences.reminders = telegramOff > 0 || telegramOn > 0;
  profile.preferences.remindBeforeMinutes = telegramOff;
  profile.preferences.minimumOutageMinutes = minimumHours * 60;
  profile.preferences.quietHours = { enabled: quietEnabled && quietStart !== quietEnd, start: clock(quietStart), end: clock(quietEnd), timezone: 'Europe/Kyiv' };
  profile.preferences.morningBriefing = { enabled: briefingEnabled, time: clock(briefingHour) };
  const locationRows = account.archive.userLocations || [];
  for (const location of profile.locations) {
    const compat = account.locationCompatibility.filter(value => value.addressId === location.address.id);
    if (compat.length !== 1) return invalid();
    let row: LegacyRow, carrier: Carrier;
    if (locationRows.length) {
      const matches = locationRows.filter(value => value.id === compat[0].oldLocationId);
      if (matches.length !== 1) return invalid(); row = matches[0]; carrier = 'location';
    } else if (settings && settings.userId === compat[0].oldLocationId) { row = settings; carrier = 'settings'; }
    else {
      const matches = subscribers.filter(value => value.chatId === compat[0].oldLocationId);
      if (matches.length !== 1) return invalid(); row = matches[0]; carrier = 'subscriber';
    }
    let telegramLocal = carrier === 'location' ? flag(row, 'telegramNotify') : carrier === 'settings' ? flag(row, 'telegramNotifications') : flag(row, 'enabled');
    let pushLocal = carrier === 'location' ? flag(row, 'notifyEnabled') : carrier === 'settings' ? flag(row, 'notificationsEnabled') : false;
    const unknown = unmappedPolicyFields(row, carrier);
    if (unknown.length) {
      addIssue('legacy_policy_unmapped_notification_fields', unknown.map(field => `${carrier}.${String(compat[0].oldLocationId)}.${field}`));
      if (unknownAffects(unknown, carrier, 'telegram')) telegramLocal = false;
      if (unknownAffects(unknown, carrier, 'push')) pushLocal = false;
    }
    location.notificationPolicy = parseLocationNotificationPolicy({ version: NOTIFICATION_POLICY_VERSION, channels: {
      telegram: { enabled: telegramLocal, beforeOffMinutes: integer(row, carrier === 'settings' ? 'telegramNotifyBeforeOff' : 'notifyBeforeOff', 30),
        beforeOnMinutes: integer(row, carrier === 'settings' ? 'telegramNotifyBeforeOn' : 'notifyBeforeOn', 15) },
      push: { enabled: pushLocal, beforeOffMinutes: carrier === 'subscriber' ? 0 : integer(row, 'notifyBeforeOff', 30),
        beforeOnMinutes: carrier === 'subscriber' ? 0 : integer(row, 'notifyBeforeOn', 15) },
    } });
    location.notifications = telegramLocal;
  }
  // The old schema had edge thresholds, but no independent reminder master.
  // A positive linked-location override remained active even if global leads were0.
  for (const channel of ['telegram', 'push'] as const) {
    const global = profile.preferences.notificationPolicy.channels[channel];
    global.remindersEnabled ||= profile.locations.some(location => {
      const local = location.notificationPolicy!.channels[channel];
      return (local.beforeOffMinutes ?? global.beforeOffMinutes) > 0 || (local.beforeOnMinutes ?? global.beforeOnMinutes) > 0;
    });
  }
  profile.preferences.reminders = profile.preferences.notificationPolicy.channels.telegram.remindersEnabled;
  profile.legacyNotificationPolicySourceHash = account.sourceHash;
  return account;
}
