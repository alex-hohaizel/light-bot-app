import type { AddressBinding, ProductPreferences, ScheduleView, PlanInterval } from './product-contract.ts';
import { globalNotificationPolicy, type NotificationChannel } from './notification-policy.ts';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
export function validInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !instantPattern.test(value) || !Number.isFinite(Date.parse(value))) return false;
  try { calendarDate(value.slice(0, 10)); return true; } catch { return false; }
}
export function calendarDate(value: string): string {
  if (!datePattern.test(value)) throw new Error('INVALID_SERVICE_DATE');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) throw new Error('INVALID_SERVICE_DATE');
  return value;
}
export function nextCalendarDate(value: string): string {
  const [year, month, day] = calendarDate(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
export function localParts(epoch: number): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epoch));
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
/** Find local midnight by actual runtime IANA rules, never add24h for the next day. */
export function dayBounds(serviceDate: string): { start: number; end: number; minutes: number } {
  calendarDate(serviceDate);
  const resolveMidnight = (date: string) => {
    let epoch = Date.parse(`${date}T00:00:00Z`);
    for (let i = 0; i < 4; i++) {
      const actual = localParts(epoch);
      const delta = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${actual.date}T${actual.time}:00Z`);
      if (!delta) return epoch;
      epoch += delta;
    }
    throw new Error('UNRESOLVED_LOCAL_MIDNIGHT');
  };
  const start = resolveMidnight(serviceDate), end = resolveMidnight(nextCalendarDate(serviceDate));
  return { start, end, minutes: (end - start) / 60000 };
}
/** Wall-clock provider minutes require an explicit offset/fold on ambiguous DST days. */
export function wallMinuteInstant(date: string, minute: number, offset?: string): string {
  if (!Number.isInteger(minute) || minute < 0 || minute > 1440) throw new Error('INVALID_LOCAL_MINUTE');
  const bounds = dayBounds(date);
  if (minute === 1440) return new Date(bounds.end).toISOString();
  const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  if (offset) {
    if (!/^[+-]\d{2}:\d{2}$/.test(offset)) throw new Error('INVALID_EXPLICIT_OFFSET');
    const value = `${date}T${time}:00${offset}`;
    const actual = localParts(Date.parse(value));
    if (actual.date !== date || actual.time !== time) throw new Error('NONEXISTENT_OR_WRONG_OFFSET_LOCAL_TIME');
    return value;
  }
  if (bounds.minutes !== 1440) throw new Error('DST_REQUIRES_EXPLICIT_OFFSET');
  const epoch = bounds.start + minute * 60000;
  const actual = localParts(epoch);
  if (actual.date !== date || actual.time !== time) throw new Error('NONEXISTENT_LOCAL_TIME');
  return new Date(epoch).toISOString();
}
export function validateScheduleView(view: ScheduleView): void {
  if (view.contractVersion !== 'lba-product/1' || view.timezone !== 'Europe/Kyiv') throw new Error('UNSUPPORTED_CONTRACT');
  const { start, end } = dayBounds(view.serviceDate);
  if (!['published', 'no_planned_outages', 'possible', 'emergency', 'not_published', 'stale', 'unavailable', 'conflict', 'needs_confirmation'].includes(view.status)) throw new Error('UNKNOWN_PLAN_STATUS');
  if (!['complete', 'partial', 'none'].includes(view.dayCoverage) || !['current', 'stale', 'unknown'].includes(view.freshness)) throw new Error('UNKNOWN_COVERAGE_OR_FRESHNESS');
  if (!view.revisionId || !view.addressId || !view.operatorId || view.source.accessCost !== 0 ||
      typeof view.synthetic !== 'boolean' || typeof view.deliveryEligible !== 'boolean' || !Array.isArray(view.intervals) ||
      !['catalog', 'schedule', 'address', 'integration', 'initial_launch'].includes(view.source.verifiedLevel)) throw new Error('INVALID_ID_OR_COST_OR_TYPE');
  if (!validInstant(view.observedAt)) throw new Error('INVALID_OBSERVED_AT');
  if (view.publishedAt !== null && !validInstant(view.publishedAt)) throw new Error('INVALID_PUBLISHED_AT');
  for (const intervals of [view.intervals, ...(view.previousIntervals ? [view.previousIntervals] : [])]) {
  let previousEnd = start;
  for (const interval of intervals) {
    if (!validInstant(interval.startsAt) || !validInstant(interval.endsAt)) throw new Error('EXPLICIT_OFFSET_REQUIRED');
    const a = Date.parse(interval.startsAt), b = Date.parse(interval.endsAt);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < start || b > end || b <= a || a < previousEnd) throw new Error('INVALID_OR_OVERLAPPING_INTERVAL');
    const localA = localParts(a), localB = localParts(b);
    const endLabel = b === end ? '24:00' : localB.time;
    if (localA.date !== view.serviceDate || localA.time !== interval.startLocal || endLabel !== interval.endLocal) throw new Error('INTERVAL_LABEL_MISMATCH');
    if (!['planned_outage', 'possible_outage'].includes(interval.kind)) throw new Error('UNKNOWN_INTERVAL_KIND');
    previousEnd = b;
  }
  }
  if (['published', 'possible'].includes(view.status) && !view.intervals.length) throw new Error('PUBLISHED_PLAN_REQUIRES_INTERVALS');
  if (['not_published', 'unavailable', 'needs_confirmation', 'no_planned_outages', 'emergency'].includes(view.status) && view.intervals.length) throw new Error('STATUS_INTERVAL_CONFLICT');
  if (view.status === 'no_planned_outages' && view.dayCoverage !== 'complete') throw new Error('EXPLICIT_NONE_REQUIRES_COMPLETE_DAY');
  if (view.deliveryEligible && (view.synthetic || view.freshness !== 'current' || !['published', 'possible', 'no_planned_outages', 'emergency'].includes(view.status))) throw new Error('UNSAFE_DELIVERY_CLAIM');
}
export function intervalMinutes(intervals: PlanInterval[]): number {
  return intervals.reduce((total, i) => total + (Date.parse(i.endsAt) - Date.parse(i.startsAt)) / 60000, 0);
}
/** Provenance and formatting changes do not create outage alerts. */
export function scheduleSemantics(view: ScheduleView): string {
  validateScheduleView(view);
  const intervals: [number, number, string][] = [];
  for (const interval of view.intervals) {
    const a = Date.parse(interval.startsAt), b = Date.parse(interval.endsAt), previous = intervals.at(-1);
    if (previous && previous[1] === a && previous[2] === interval.kind) previous[1] = b;
    else intervals.push([a, b, interval.kind]);
  }
  return JSON.stringify({ addressId: view.addressId, operatorId: view.operatorId,
    namespace: view.namespace || null, targetId: view.targetId || null, bindingRevisionId: view.bindingRevisionId || null, date: view.serviceDate,
    status: view.status, coverage: view.dayCoverage,
    intervals });
}
export function canDeliver(view: ScheduleView, binding: AddressBinding, preferences: ProductPreferences, now: string, channel: NotificationChannel = 'telegram'): boolean {
  validateScheduleView(view);
  const selectedGroup = view.source.verifiedLevel === 'initial_launch' && binding.status === 'needs_confirmation' &&
    ['user_selected_group', 'operator_group'].includes(binding.kind) && binding.verifiedAt === null;
  if (!validInstant(now) || typeof preferences.optedIn !== 'boolean' || typeof preferences.paused !== 'boolean' ||
      typeof preferences.reminders !== 'boolean' || typeof preferences.quietHours?.enabled !== 'boolean' ||
      (!selectedGroup && !validInstant(binding.verifiedAt)) || (binding.effectiveFrom !== null && !validInstant(binding.effectiveFrom)) ||
      (binding.effectiveUntil !== null && !validInstant(binding.effectiveUntil)) || !binding.namespace || !binding.targetId) return false;
  const epoch = Date.parse(now);
  if (!Number.isFinite(epoch) || Date.parse(view.observedAt) > epoch ||
      (view.publishedAt && (!instantPattern.test(view.publishedAt) || !Number.isFinite(Date.parse(view.publishedAt)) || Date.parse(view.publishedAt) > epoch))) return false;
  const localNow = localParts(epoch);
  let channelEnabled = false;
  try { channelEnabled = globalNotificationPolicy(preferences, channel).enabled; } catch { return false; }
  if (![localNow.date, nextCalendarDate(localNow.date)].includes(view.serviceDate)) return false;
  if (preferences.quietHours.enabled) {
    const minute = (time: string) => {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
      const [h, m] = time.split(':').map(Number); return h * 60 + m;
    };
    const start = minute(preferences.quietHours.start), end = minute(preferences.quietHours.end), actual = minute(localNow.time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end || preferences.quietHours.timezone !== 'Europe/Kyiv') return false;
    if (start < end ? actual >= start && actual < end : actual >= start || actual < end) return false;
  }
  return Number.isFinite(epoch) && !view.synthetic && view.deliveryEligible && view.freshness === 'current' &&
    (view.source.verifiedLevel === 'integration' || selectedGroup) &&
    (view.status === 'emergency' ? view.dayCoverage === 'none' && view.intervals.length === 0 :
      view.dayCoverage === 'complete' && ['published', 'possible', 'no_planned_outages'].includes(view.status)) &&
    (selectedGroup || binding.status === 'verified' && ['building', 'connection', 'operator_group'].includes(binding.kind)) && binding.addressId === view.addressId &&
    binding.operatorId === view.operatorId && (selectedGroup || Boolean(binding.verifiedAt)) &&
    view.bindingRevisionId === binding.revisionId && view.namespace === binding.namespace && view.targetId === binding.targetId &&
    (selectedGroup || Date.parse(binding.verifiedAt!) <= epoch) &&
    (!binding.effectiveFrom || Date.parse(binding.effectiveFrom) <= epoch) &&
    (!binding.effectiveUntil || epoch < Date.parse(binding.effectiveUntil)) && channelEnabled && !preferences.paused;
}
