import { createHash } from 'node:crypto';
import type { ScheduleView, SourceReference, PlanInterval } from '../../shared/product-contract.ts';
import { dayBounds, localParts, nextCalendarDate, validateScheduleView, validInstant, wallMinuteInstant } from '../../shared/schedule-core.ts';

const PROVIDERS = {
  'yasno:25/902': 'dtek-kem',
  'yasno:3/301': 'dtek-dnem',
  'yasno:3/303': 'cek',
} as const;
export interface YasnoContext {
  namespace: keyof typeof PROVIDERS;
  operatorId: string;
  targetId: string;
  addressId: string;
  addressLabel: string;
  localityLabel: string;
  serviceDate: string;
  observedAt: string;
  source: SourceReference;
  freshness: 'current' | 'stale' | 'unknown';
  synthetic: boolean;
}
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const SOURCE_IDS = { 'yasno:25/902': 'yasno-kem', 'yasno:3/301': 'yasno-dnem', 'yasno:3/303': 'yasno-cek' } as const;

/** Raw intake binds provenance before the semantic parsed-payload function. */
export function normalizeYasnoRaw(raw: string, day: 'today' | 'tomorrow', context: YasnoContext): ScheduleView {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2_000_000 || createHash('sha256').update(raw).digest('hex') !== context.source.revision) throw new Error('RAW_SOURCE_HASH_MISMATCH');
  return normalizeYasno(JSON.parse(raw), day, context);
}

/** Pure parser of a captured public feed. It does not fetch, certify addresses or enable delivery. */
export function normalizeYasno(payload: unknown, day: 'today' | 'tomorrow', context: YasnoContext): ScheduleView {
  if (PROVIDERS[context.namespace] !== context.operatorId) throw new Error('OPERATOR_NAMESPACE_MISMATCH');
  if (SOURCE_IDS[context.namespace] !== context.source.id || !['catalog', 'schedule'].includes(context.source.verifiedLevel)) throw new Error('SOURCE_SCOPE_MISMATCH');
  if (!validInstant(context.observedAt)) throw new Error('INVALID_OBSERVED_AT');
  if (!/^\d+\.\d+$/.test(context.targetId) || !record(payload) || !Object.hasOwn(payload, context.targetId)) throw new Error('TARGET_NOT_FOUND');
  const target = payload[context.targetId];
  if (!record(target) || !record(target[day])) throw new Error('DAY_MISSING');
  const raw = target[day];
  if (validInstant(target.updatedOn) && Date.parse(target.updatedOn) > Date.parse(context.observedAt)) throw new Error('SOURCE_PUBLICATION_AFTER_OBSERVATION');
  const observedDate = localParts(Date.parse(context.observedAt)).date;
  const freshness = context.freshness === 'stale' || ![observedDate, nextCalendarDate(observedDate)].includes(context.serviceDate) ? 'stale' : context.freshness;
  const bounds = dayBounds(context.serviceDate);
  if (!validInstant(raw.date) || raw.date.slice(0, 10) !== context.serviceDate || Date.parse(raw.date) !== bounds.start) throw new Error('SERVICE_DATE_OR_OFFSET_MISMATCH');
  if (!['ScheduleApplies', 'WaitingForSchedule'].includes(raw.status)) throw new Error('UNKNOWN_PROVIDER_DAY_STATUS');
  const revision = createHash('sha256').update(JSON.stringify({ context: { namespace: context.namespace, target: context.targetId, date: context.serviceDate }, raw })).digest('hex');
  const view: ScheduleView = {
    contractVersion: 'lba-product/1', revisionId: `yasno:${revision}`, addressId: context.addressId,
    addressLabel: context.addressLabel, localityLabel: context.localityLabel, operatorId: context.operatorId,
    namespace: context.namespace, targetId: context.targetId, serviceDate: context.serviceDate, timezone: 'Europe/Kyiv',
    status: 'not_published', dayCoverage: 'none', intervals: [], source: context.source,
    publishedAt: validInstant(target.updatedOn) ? target.updatedOn : null,
    observedAt: context.observedAt, freshness, synthetic: context.synthetic, deliveryEligible: false,
    notice: 'Технічний ключ джерела; адресна прив’язка й допуск персональних сповіщень перевіряються окремо.',
  };
  // Real current DnEM/CEK responses contain a NotPlanned full-day slot WHILE
  // WaitingForSchedule. The explicit day status wins over that placeholder.
  if (raw.status === 'WaitingForSchedule') { if (freshness === 'stale') view.status = 'stale'; validateScheduleView(view); return view; }
  if (!Array.isArray(raw.slots) || !raw.slots.length) throw new Error('PUBLISHED_DAY_HAS_NO_SLOTS');
  let previousEnd = 0;
  const intervals: PlanInterval[] = [];
  for (const slot of raw.slots) {
    if (!record(slot) || !Number.isInteger(slot.start) || !Number.isInteger(slot.end) || slot.start !== previousEnd || slot.end <= slot.start || slot.end > 1440) throw new Error('INCOMPLETE_OR_INVALID_PROVIDER_INTERVALS');
    if (!['Definite', 'NotPlanned'].includes(slot.type)) throw new Error('UNKNOWN_PROVIDER_SLOT_ENUM');
    if (slot.type === 'Definite') {
      const startsAt = wallMinuteInstant(context.serviceDate, slot.start), endsAt = wallMinuteInstant(context.serviceDate, slot.end);
      intervals.push({ startsAt, endsAt, startLocal: localParts(Date.parse(startsAt)).time,
        endLocal: slot.end === 1440 ? '24:00' : localParts(Date.parse(endsAt)).time, kind: 'planned_outage' });
    }
    previousEnd = slot.end;
  }
  if (previousEnd !== 1440) throw new Error('INCOMPLETE_PROVIDER_DAY');
  view.dayCoverage = 'complete'; view.intervals = intervals;
  view.status = freshness === 'stale' ? 'stale' : intervals.length ? 'published' : 'no_planned_outages';
  validateScheduleView(view);
  return view;
}
