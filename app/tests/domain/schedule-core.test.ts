import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayBounds, wallMinuteInstant, validateScheduleView, intervalMinutes, scheduleSemantics, canDeliver } from '../../shared/schedule-core.ts';
import { REVIEW_PLAN } from '../../shared/review-fixtures.ts';
import { normalizeYasno, normalizeYasnoRaw, type YasnoContext } from '../../server/domain/yasno-adapter.ts';
import type { AddressBinding, ProductPreferences } from '../../shared/product-contract.ts';

const context: YasnoContext = { namespace: 'yasno:3/301', operatorId: 'dtek-dnem', targetId: '1.1', addressId: 'a1',
  addressLabel: 'Обрана технічна група', localityLabel: 'Дніпро', serviceDate: '2026-11-07', observedAt: '2026-11-07T12:49:33Z',
  source: { id: 'yasno-dnem', name: 'YASNO captured candidate', url: null, revision: 'raw', accessCost: 0, verifiedLevel: 'catalog' }, freshness: 'current', synthetic: false };
const feed = JSON.parse(readFileSync(new URL('../../../docs/light-bot-app/p1/fixtures/yasno-dnem.json', import.meta.url), 'utf8'));

test('real captured WaitingForSchedule with NotPlanned24h remains unpublished', () => {
  const view = normalizeYasno(feed, 'tomorrow', { ...context, serviceDate: '2026-11-08' });
  assert.equal(view.status, 'not_published'); assert.deepEqual(view.intervals, []);
  assert.equal(view.dayCoverage, 'none'); assert.equal(view.deliveryEligible, false);
});
test('actual current feed normalizes exact minutes without certifying house or delivery', () => {
  const view = normalizeYasno(feed, 'today', context);
  assert.equal(view.status, 'published'); assert.equal(view.intervals[0].startLocal, '03:00');
  assert.equal(view.intervals[1].endLocal, '21:00'); assert.equal(view.deliveryEligible, false);
});
test('old Kharkiv-to-Kyiv substitution is rejected by operator namespace', () => {
  assert.throws(() => normalizeYasno(feed, 'today', { ...context, namespace: 'yasno:25/902', operatorId: 'kharkivoblenergo' }), /NAMESPACE/);
});
test('missing target, stale service day, empty active day and unknown enum fail closed', () => {
  assert.throws(() => normalizeYasno(feed, 'today', { ...context, targetId: '99.99' }), /TARGET/);
  assert.throws(() => normalizeYasno(feed, 'today', { ...context, serviceDate: '2025-12-14' }), /DATE/);
  const broken = structuredClone(feed); broken['1.1'].today.slots = [];
  assert.throws(() => normalizeYasno(broken, 'today', context), /NO_SLOTS/);
  broken['1.1'].today.slots = [{ start: 0, end: 1440, type: 'FutureUnknown' }];
  assert.throws(() => normalizeYasno(broken, 'today', context), /UNKNOWN_PROVIDER_SLOT/);
});
test('gaps, overlap and unknown day status never become online', () => {
  const broken = structuredClone(feed); broken['1.1'].today.slots[0].end = 170;
  assert.throws(() => normalizeYasno(broken, 'today', context), /INVALID_PROVIDER_INTERVALS/);
  broken['1.1'].today.status = 'FutureUnknown';
  assert.throws(() => normalizeYasno(broken, 'today', context), /DAY_STATUS/);
});
test('explicit full-day NotPlanned is different from missing/unpublished day', () => {
  const none = structuredClone(feed); none['1.1'].today.slots = [{ start: 0, end: 1440, type: 'NotPlanned' }];
  assert.equal(normalizeYasno(none, 'today', context).status, 'no_planned_outages');
});
test('23/25-hour local days and24:00 use actual calendar boundaries', () => {
  assert.equal(dayBounds('2026-03-29').minutes, 1380);
  assert.equal(dayBounds('2026-10-25').minutes, 1500);
  assert.equal(Date.parse(wallMinuteInstant('2026-03-29', 1440)), dayBounds('2026-03-30').start);
  assert.throws(() => wallMinuteInstant('2026-10-25', 210), /EXPLICIT_OFFSET/);
  assert.notEqual(Date.parse(wallMinuteInstant('2026-10-25', 210, '+03:00')), Date.parse(wallMinuteInstant('2026-10-25', 210, '+02:00')));
  assert.throws(() => wallMinuteInstant('2026-03-29', 210, '+02:00'), /NONEXISTENT/);
});
test('view validates exact half-hours,24:00 and rejects overlapping/mislabelled intervals', () => {
  validateScheduleView(REVIEW_PLAN); assert.equal(intervalMinutes(REVIEW_PLAN.intervals), 450);
  const broken = structuredClone(REVIEW_PLAN); broken.intervals[0].endLocal = '11:30';
  assert.throws(() => validateScheduleView(broken), /LABEL/);
  assert.throws(() => validateScheduleView({ ...REVIEW_PLAN, status: 'no_planned_outages' }), /STATUS_INTERVAL/);
});
test('provenance-only revisions are semantically equal; different targets are not', () => {
  assert.equal(scheduleSemantics(REVIEW_PLAN), scheduleSemantics({ ...REVIEW_PLAN, revisionId: 'new-source-revision', source: { ...REVIEW_PLAN.source, revision: 'new' } }));
  assert.notEqual(scheduleSemantics(REVIEW_PLAN), scheduleSemantics({ ...REVIEW_PLAN, addressId: 'other' }));
  assert.notEqual(scheduleSemantics(REVIEW_PLAN), scheduleSemantics({ ...REVIEW_PLAN, namespace: 'other-operator', targetId: 'another' }));
  const split = structuredClone(REVIEW_PLAN);
  split.intervals.splice(0, 1, { ...split.intervals[0], endsAt: '2026-11-07T08:00:00+02:00', endLocal: '08:00' },
    { ...REVIEW_PLAN.intervals[0], startsAt: '2026-11-07T08:00:00+02:00', startLocal: '08:00' });
  assert.equal(scheduleSemantics(REVIEW_PLAN), scheduleSemantics(split));
});

test('YASNO provenance, future publication, explicit offsets and observation-day freshness are strict', () => {
  assert.throws(() => normalizeYasno(feed, 'today', { ...context, source: { ...context.source, id: 'voe-mirror-vn-progr' } }), /SOURCE_SCOPE/);
  assert.throws(() => normalizeYasnoRaw('{}', 'today', context), /HASH/);
  const future = structuredClone(feed); future['1.1'].updatedOn = '2030-01-01T00:00:00Z';
  assert.throws(() => normalizeYasno(future, 'today', context), /PUBLICATION_AFTER/);
  const noOffset = structuredClone(feed); noOffset['1.1'].today.date = '2026-11-07T00:00:00';
  assert.throws(() => normalizeYasno(noOffset, 'today', context), /DATE_OR_OFFSET/);
  assert.equal(normalizeYasno(feed, 'today', { ...context, observedAt: '2031-01-01T00:00:00Z' }).status, 'stale');
});
test('delivery requires exact certified binding, opt-in, freshness, date and quiet-hours policy', () => {
  const binding: AddressBinding = { addressId: REVIEW_PLAN.addressId, operatorId: REVIEW_PLAN.operatorId, namespace: 'operator:n1', targetId: 'house1', kind: 'building', revisionId: 'binding1', status: 'verified', verifiedAt: '2026-11-07T07:00:00+02:00', effectiveFrom: null, effectiveUntil: null };
  const preferences: ProductPreferences = { optedIn: true, paused: false, reminders: false, remindBeforeMinutes: 30, quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'Europe/Kyiv' } };
  const view = { ...REVIEW_PLAN, synthetic: false, deliveryEligible: true, source: { ...REVIEW_PLAN.source, verifiedLevel: 'integration' as const }, bindingRevisionId: 'binding1', namespace: 'operator:n1', targetId: 'house1' };
  assert(canDeliver(view, binding, preferences, '2026-11-07T12:00:00+02:00'));
  assert(!canDeliver({ ...view, synthetic: true, deliveryEligible: false }, binding, preferences, '2026-11-07T12:00:00+02:00'));
  assert(!canDeliver(view, { ...binding, targetId: 'house2' }, preferences, '2026-11-07T12:00:00+02:00'));
  assert(!canDeliver(view, binding, { ...preferences, paused: true }, '2026-11-07T12:00:00+02:00'));
  assert(!canDeliver(view, binding, { ...preferences, quietHours: { ...preferences.quietHours, enabled: true } }, '2026-11-07T23:00:00+02:00'));
  assert(!canDeliver(view, binding, preferences, '2026-11-09T12:00:00+02:00'));
  assert(!canDeliver(view, { ...binding, kind: 'FutureUnknown' as AddressBinding['kind'] }, preferences, '2026-11-07T12:00:00+02:00'));
  assert(!canDeliver({ ...view, observedAt: '2027-01-01T00:00:00Z' }, binding, preferences, '2026-11-07T12:00:00+02:00'));
  assert(canDeliver({ ...view, status: 'emergency', dayCoverage: 'none', intervals: [] }, binding, preferences, '2026-11-07T12:00:00+02:00'));
});
