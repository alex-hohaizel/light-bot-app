import type { BotProfile } from '../../../shared/bot/types.ts';
import { defaultNotificationPolicy, parseLocationNotificationPolicy, parseNotificationPolicy,
  type LocationNotificationPolicy, type NotificationPolicy } from '../../../shared/notification-policy.ts';
import { draftFlag, draftInteger, draftText, exactKeys } from './ux-drafts.ts';

export type NotificationForm = { policy: NotificationPolicy; paused: boolean; quiet: BotProfile['preferences']['quietHours'];
  briefing: BotProfile['preferences']['morningBriefing']; minimum: number };
export const sameDraftValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function readNotificationForm(profile: BotProfile): NotificationForm {
  const p = profile.preferences;
  return { policy: p.notificationPolicy ? parseNotificationPolicy(p.notificationPolicy) : defaultNotificationPolicy(p),
    paused: p.paused, quiet: { ...p.quietHours }, briefing: { ...p.morningBriefing }, minimum: p.minimumOutageMinutes };
}
export function readNotificationLocations(profile: BotProfile): Record<string, LocationNotificationPolicy> {
  return Object.fromEntries(profile.locations.map(location => [location.address.id, location.notificationPolicy
    ? parseLocationNotificationPolicy(location.notificationPolicy) : { version: 'lba-notification-policy/1' as const,
      channels: { telegram: { enabled: location.notifications }, push: { enabled: false } } }]));
}
const time = (input: unknown) => { const value = draftText(input, 5); if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('INVALID_DRAFT_TIME'); return value; };
export function parseNotificationForm(input: unknown): NotificationForm {
  const v = exactKeys(input, ['policy', 'paused', 'quiet', 'briefing', 'minimum']);
  const quiet = exactKeys(v.quiet, ['enabled', 'start', 'end', 'timezone']);
  const briefing = exactKeys(v.briefing, ['enabled', 'time']);
  if (quiet.timezone !== 'Europe/Kyiv') throw new Error('INVALID_DRAFT_ZONE');
  return { policy: parseNotificationPolicy(v.policy), paused: draftFlag(v.paused),
    quiet: { enabled: draftFlag(quiet.enabled), start: time(quiet.start), end: time(quiet.end), timezone: 'Europe/Kyiv' },
    briefing: { enabled: draftFlag(briefing.enabled), time: time(briefing.time) },
    minimum: draftInteger(v.minimum, 86400) };
}
function parseLocations(input: unknown): Record<string, LocationNotificationPolicy> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 20) throw new Error('INVALID_DRAFT_LOCATIONS');
  return Object.fromEntries(Object.entries(input).map(([id, policy]) => [draftText(id), parseLocationNotificationPolicy(policy)]));
}
export interface NotificationDraft {
  form: NotificationForm; locations: Record<string, LocationNotificationPolicy>;
  baselineForm: NotificationForm; baselineLocations: Record<string, LocationNotificationPolicy>; baselineRevision: number;
}
export function parseNotificationDraft(input: unknown): NotificationDraft {
  const v = exactKeys(input, ['form', 'locations', 'baselineForm', 'baselineLocations', 'baselineRevision']);
  return { form: parseNotificationForm(v.form), baselineForm: parseNotificationForm(v.baselineForm), locations: parseLocations(v.locations),
    baselineLocations: parseLocations(v.baselineLocations), baselineRevision: draftInteger(v.baselineRevision, Number.MAX_SAFE_INTEGER) };
}
/** A restored dirty value retains its original baseline even when the remote revision advanced. */
export function draftConflict(local: unknown, baseline: unknown, remote: unknown): boolean {
  return !sameDraftValue(local, baseline) && !sameDraftValue(local, remote) && !sameDraftValue(baseline, remote);
}
