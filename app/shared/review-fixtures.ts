import type { PlanInterval, ScheduleView, PlanStatus } from './product-contract';

export const REVIEW_INTERVALS: PlanInterval[] = [
  { startsAt: '2026-11-07T07:30:00+02:00', endsAt: '2026-11-07T11:00:00+02:00', startLocal: '07:30', endLocal: '11:00', kind: 'planned_outage' },
  { startsAt: '2026-11-07T15:00:00+02:00', endsAt: '2026-11-07T17:30:00+02:00', startLocal: '15:00', endLocal: '17:30', kind: 'planned_outage' },
  { startsAt: '2026-11-07T22:30:00+02:00', endsAt: '2026-11-08T00:00:00+02:00', startLocal: '22:30', endLocal: '24:00', kind: 'planned_outage' },
];
export const REVIEW_PLAN: ScheduleView = {
  contractVersion: 'lba-product/1', revisionId: 'fixture-plan-b', addressId: 'fixture-address-home',
  addressLabel: 'Дім', localityLabel: 'Тестовий приклад', operatorId: 'fixture-operator',
  serviceDate: '2026-11-07', timezone: 'Europe/Kyiv', status: 'published', dayCoverage: 'complete',
  intervals: REVIEW_INTERVALS, source: { id: 'fixture-source', name: 'Синтетичний приклад для огляду',
    url: null, revision: 'fixture-source-2', accessCost: 0, verifiedLevel: 'catalog' },
  publishedAt: '2026-11-07T08:12:00+02:00', observedAt: '2026-11-07T08:14:00+02:00',
  freshness: 'current', synthetic: true, deliveryEligible: false,
};
export function reviewPlan(status: PlanStatus = 'published'): ScheduleView {
  return { ...REVIEW_PLAN, revisionId: `fixture-${status}`, status,
    intervals: ['published', 'possible', 'stale'].includes(status) ? REVIEW_INTERVALS.map(i => ({ ...i, kind: status === 'possible' ? 'possible_outage' : i.kind })) : [],
    freshness: status === 'stale' ? 'stale' : ['unavailable', 'conflict', 'not_published', 'needs_confirmation'].includes(status) ? 'unknown' : 'current',
    dayCoverage: ['published', 'no_planned_outages', 'possible', 'stale'].includes(status) ? 'complete' : 'none',
  };
}
