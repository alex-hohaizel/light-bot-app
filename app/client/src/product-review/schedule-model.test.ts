import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_PLAN, reviewPlan } from '../../../shared/review-fixtures.ts';
import { scheduleText, intervalLabel, localDayBounds, plannedMinutes, nextInterval, nextPlanSummary, CARD_VARIANTS, durationLabel, displayInstantDate } from './schedule-model.ts';
import { cardExample, houseIdentity, streetMatches } from './examples.ts';
test('next event qualifies possible and suppresses stale/emergency/conflict/noncurrent plans',()=>{
  const asOf='2026-11-07T14:00:00+02:00';assert.match(nextPlanSummary(reviewPlan('possible'),asOf).title,/Можливе/);
  assert.match(scheduleText(reviewPlan('possible'),'next',asOf),/Можливе відключення/);
  for(const status of ['stale','emergency','conflict','needs_confirmation','unavailable'] as const){const view={...reviewPlan(status),intervals:REVIEW_PLAN.intervals};assert.equal(nextInterval(view,asOf),undefined);assert.equal(nextPlanSummary(view,asOf).time,null);assert.doesNotMatch(scheduleText(reviewPlan(status),'next',asOf),/Початок інтервалу за планом о/);}
  assert.match(nextPlanSummary({...REVIEW_PLAN,dayCoverage:'partial'},'2026-11-08T00:00:00+02:00').description,/невідомий/);
  assert.equal(nextPlanSummary(REVIEW_PLAN,'2026-11-07T17:30:00+02:00').time,'22:30');
});

test('complete fallback preserves all exact minutes, midnight, source and revision', () => {
  const text = scheduleText(REVIEW_PLAN);
  for (const value of ['07:30–11:00', '15:00–17:30', '22:30–24:00', 'Europe/Kyiv', 'UTC+02:00', REVIEW_PLAN.source.name, REVIEW_PLAN.revisionId, '08:12', '08:14', 'Синтетичний']) assert.ok(text.includes(value), value);
  assert.equal(plannedMinutes(REVIEW_PLAN), 450);
  assert.equal(durationLabel(450), '7 год 30 хв');
});
test('half-open intervals do not report the finished interval as next', () => {
  assert.equal(nextInterval(REVIEW_PLAN, '2026-11-07T11:00:00+02:00')?.startLocal, '15:00');
  assert.equal(nextInterval(REVIEW_PLAN, '2026-11-08T00:00:00+02:00'), undefined);
});
test('no-data, explicit no-plan and emergency remain different semantic results', () => {
  assert.match(scheduleText(reviewPlan('no_planned_outages')), /явно повідомив/);
  assert.match(scheduleText(reviewPlan('not_published')), /Очікуємо публікацію/);
  assert.match(scheduleText(reviewPlan('unavailable')), /не означає відсутність відключень/);
  assert.match(scheduleText(reviewPlan('emergency')), /план може не діяти/);
  assert.match(scheduleText(reviewPlan('stale')), /Останній відомий план/);
  assert.match(scheduleText({ ...REVIEW_PLAN, dayCoverage: 'partial' }), /решта доби має невідомий статус/);
});
test('IANA day bounds are consumed without forcing every local day to 24 hours', () => {
  assert.equal(localDayBounds('2026-03-29').minutes, 1380);
  assert.equal(localDayBounds('2026-10-25').minutes, 1500);
  assert.equal(localDayBounds('2026-11-07').minutes, 1440);
  const repeated = { startsAt: '2026-10-25T03:30:00+03:00', endsAt: '2026-10-25T03:30:00+02:00', startLocal: '03:30', endLocal: '03:30', kind: 'planned_outage' as const };
  const view = { ...REVIEW_PLAN, serviceDate: '2026-10-25', intervals: [repeated] };
  assert.equal(plannedMinutes(view), 60);
  assert.equal(intervalLabel(repeated), '03:30–03:30 (UTC+03:00 → UTC+02:00)');
  assert.ok(scheduleText(view).includes('UTC+03:00 → UTC+02:00'));
});
test('all nine card recipes are concrete and change cards retain complete before and after', () => {
  for (const variant of CARD_VARIANTS) assert.ok(scheduleText(cardExample(variant.id), variant.id).length > 150);
  const changed = scheduleText(cardExample('changed'), 'changed');
  assert.match(changed, /Було:/); assert.match(changed, /07:30–10:30/); assert.match(changed, /Стало:/); assert.match(changed, /07:30–11:00/);
  const cancelled = scheduleText(cardExample('cancelled'), 'cancelled');
  assert.match(cancelled, /скасовано/); assert.match(cancelled, /Було:/); assert.match(cancelled, /явно повідомив/);
});
test('exact building identities and alias search never silently approximate a house', () => {
  assert.equal(houseIdentity('12'), '12'); assert.equal(houseIdentity('12А'), '12А');
  assert.notEqual(houseIdentity('12'), houseIdentity('12А'));
  assert.notEqual(houseIdentity('12/1'), houseIdentity('12-1'));
  assert.equal(houseIdentity('13'), null);
  assert.ok(streetMatches('Планова')); assert.ok(streetMatches('Тестова')); assert.ok(!streetMatches('невідома'));
});


test('publication and observation dates use Kyiv day even across UTC midnight', () => {
  assert.match(displayInstantDate('2026-11-07T23:30:00Z'), /8 листопада/);
  const text = scheduleText({ ...REVIEW_PLAN, publishedAt: '2026-11-06T23:30:00Z', observedAt: '2026-11-07T23:45:00Z' });
  assert.match(text, /Опубліковано: 7 листопада/);
  assert.match(text, /Перевірено: 8 листопада/);
});
