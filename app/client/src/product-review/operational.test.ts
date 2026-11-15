import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleView } from '../../../shared/product-contract.ts';
import { REVIEW_PLAN, reviewPlan } from '../../../shared/review-fixtures.ts';
import { axisFraction, createDayAxis, deriveOperational, inspectScheduleForDisplay, sharedClearWindows } from './operational.ts';

const now = '2026-11-07T15:10:00+02:00';
const clone = (): ScheduleView => structuredClone(REVIEW_PLAN);
test('ongoing outage prioritises restoration and distinguishes remaining from elapsed/full duration', () => {
  const s = deriveOperational(clone(), now);
  assert.equal(s.phase, 'outage'); assert.equal(s.next?.edge, 'on'); assert.equal(s.next?.time, '17:30');
  assert.equal(s.next?.remainingMinutes, 140); assert.equal(s.next?.remainingLabel, '2 год 20 хв');
  assert.equal(s.elapsedMinutes, 10); assert.equal(s.fullDurationMinutes, 150);
  assert.equal(s.nextLaterOff?.time, '22:30');
});
test('half-open boundaries move from current restoration to next off without negative countdown', () => {
  const start = deriveOperational(clone(), '2026-11-07T15:00:00+02:00');
  assert.equal(start.currentIndex, 1); assert.equal(start.elapsedMinutes, 0); assert.equal(start.next?.remainingMinutes, 150);
  const end = deriveOperational(clone(), '2026-11-07T17:30:00+02:00');
  assert.equal(end.phase, 'before'); assert.equal(end.next?.edge, 'off'); assert.equal(end.next?.time, '22:30');
  assert.equal(deriveOperational(clone(), '2026-11-08T00:00:00+02:00').phase, 'complete');
});
test('missing, stale, emergency, conflict and unconfirmed data cannot manufacture next ETA', () => {
  for (const status of ['not_published', 'stale', 'emergency', 'unavailable', 'conflict', 'needs_confirmation'] as const) {
    const state = deriveOperational(reviewPlan(status), now);
    assert.equal(state.phase, 'unknown', status); assert.equal(state.next, null, status);
  }
  assert.equal(deriveOperational(undefined, now).next, null);
  assert.equal(deriveOperational({ ...clone(), freshness: 'unknown' }, now).next, null);
  assert.equal(deriveOperational({ ...clone(), dayCoverage: 'none' }, now).next, null);
  assert.equal(deriveOperational({ ...clone(), observedAt: '2026-11-07T16:00:00+02:00' }, now).next, null);
  assert.equal(deriveOperational(clone(), 'invalid-clock').next, null);
  assert.equal(deriveOperational({ ...clone(), intervals: [] }, now).phase, 'unknown');
  assert.equal(deriveOperational(reviewPlan('no_planned_outages'), now).phase, 'complete');
});
test('possible data stay qualified and do not become a confirmed common gap', () => {
  const plan = reviewPlan('possible'), state = deriveOperational(plan, now);
  assert.equal(state.possible, true); assert.match(state.next?.label || '', /Можливе/);
  assert.equal(sharedClearWindows([plan], now), null);
  const mixed = clone(); mixed.intervals[2].kind = 'possible_outage';
  assert.match(deriveOperational(mixed, now).nextLaterOff?.label || '', /Можливе/);
  assert.equal(sharedClearWindows([mixed], now), null);
});
test('common windows intersect all selected exact schedules; incomplete/different dates are unknown', () => {
  const a = clone(), b = clone(); b.addressId = 'other';
  b.intervals = [{ startsAt: '2026-11-07T16:30:00+02:00', endsAt: '2026-11-07T18:30:00+02:00', startLocal: '16:30', endLocal: '18:30', kind: 'planned_outage' }];
  const windows = sharedClearWindows([a, b], now)!;
  assert.deepEqual(windows.map(w => [w.startLabel, w.endLabel, w.minutes]), [['18:30', '22:30', 240]]);
  assert.equal(sharedClearWindows([], now), null);
  assert.equal(sharedClearWindows([{ ...a, dayCoverage: 'partial' }, b], now), null);
  assert.equal(sharedClearWindows([{ ...a, freshness: 'stale' }, b], now), null);
  assert.equal(sharedClearWindows([{ ...a, observedAt: '2026-11-07T16:00:00+02:00' }, b], now), null);
  assert.deepEqual(sharedClearWindows([a, b], '2026-11-08T00:00:00+02:00'), []);
});
test('IANA DST day axes and repeated-hour countdown use instants rather than wall-minute subtraction', () => {
  assert.equal(createDayAxis('2026-03-29').minutes, 1380); assert.equal(createDayAxis('2026-10-25').minutes, 1500);
  const fall = { ...clone(), serviceDate: '2026-10-25', observedAt: '2026-10-25T01:00:00+03:00', publishedAt: '2026-10-25T01:00:00+03:00',
    intervals: [{ startsAt: '2026-10-25T03:30:00+03:00', endsAt: '2026-10-25T03:30:00+02:00', startLocal: '03:30', endLocal: '03:30', kind: 'planned_outage' as const }] };
  const s = deriveOperational(fall, '2026-10-25T03:45:00+03:00');
  assert.equal(s.phase, 'outage'); assert.equal(s.next?.remainingMinutes, 45); assert.equal(s.elapsedMinutes, 15); assert.equal(s.fullDurationMinutes, 60);
  const axis = createDayAxis(fall.serviceDate);
  assert.equal(Math.round((axisFraction(fall.intervals[0].endsAt, axis) - axisFraction(fall.intervals[0].startsAt, axis)) * axis.minutes), 60);
  assert.ok(axis.ticks.every((t, i) => i === 0 || t.at > axis.ticks[i - 1].at));
});

test('full-day display rejects invalid intervals and qualifies retained history or global possibility', () => {
  const stale = inspectScheduleForDisplay(reviewPlan('stale'), now);
  assert.equal(stale.valid, true); assert.equal(stale.historical, true);
  assert.equal(stale.intervals.length, 3); assert.equal(stale.operational.next, null);
  const unknown = inspectScheduleForDisplay({ ...clone(), freshness: 'unknown' }, now);
  assert.equal(unknown.valid, true); assert.equal(unknown.historical, true); assert.equal(unknown.operational.currentIndex, -1);
  const possible = inspectScheduleForDisplay({ ...clone(), status: 'possible' }, now);
  assert.equal(possible.possible, true); assert.equal(possible.intervals[0].kind, 'planned_outage');
  const invalid = clone(); invalid.intervals[1].startsAt = 'not-an-instant';
  const rejected = inspectScheduleForDisplay(invalid, now);
  assert.equal(rejected.valid, false); assert.deepEqual(rejected.intervals, []); assert.equal(rejected.operational.next, null);
});
