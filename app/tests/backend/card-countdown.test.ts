import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_PLAN, reviewPlan } from '../../shared/review-fixtures.ts';
import { nextInterval, nextPlanSummary, scheduleText } from '../../client/src/product-review/schedule-model.ts';
import { renderScheduleSvg } from '../../client/src/product-review/schedule-renderer.tsx';
import { deriveOperational } from '../../client/src/product-review/operational.ts';
import type { ScheduleView } from '../../shared/product-contract.ts';

const plan = (): ScheduleView => structuredClone(REVIEW_PLAN);
const visible = (svg: string) => svg.replace(/<desc\b[^>]*>[\s\S]*?<\/desc>/g, '').replace(/<title\b[^>]*>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, ' ');

test('ongoing cards name planned restoration and show remaining rather than the whole interval', () => {
  const view = plan(), asOf = '2026-11-07T15:10:00+02:00';
  const summary = nextPlanSummary(view, asOf);
  assert.equal(summary.title, 'Увімкнення за графіком');
  assert.equal(summary.time, '17:30');
  assert.equal(summary.remainingMinutes, 140);
  assert.equal(summary.remainingLabel, '2 год 20 хв');
  assert.equal(summary.remainingLabel, deriveOperational(view, asOf).next?.remainingLabel);
  for (const variant of ['now', 'next'] as const) {
    const text = scheduleText(view, variant, asOf);
    assert.match(text, /Увімкнення за графіком о 17:30 · через 2 год 20 хв/);
    assert.match(text, /Час перегляду:.*7 листопада 2026.*15:10/);
    for (const theme of ['light', 'dark'] as const) {
      const shown = visible(renderScheduleSvg(view, variant, theme, asOf));
      assert.match(shown, /Увімкнення за графіком.*17:30/);
      assert.match(shown, /через 2 год 20 хв/);
      assert.match(shown, /Час перегляду:.*7 листопада 2026.*15:10/);
      assert.doesNotMatch(shown, /через 150 хв|через 2 год 30 хв/);
    }
  }
});

test('before, start, end and subminute edges share the dashboard ISO countdown', () => {
  for (const [asOf, time, minutes, label] of [
    ['2026-11-07T14:00:00+02:00', '15:00', 60, '1 год'],
    ['2026-11-07T15:00:00+02:00', '17:30', 150, '2 год 30 хв'],
    ['2026-11-07T16:29:01+02:00', '17:30', 61, '1 год 1 хв'],
    ['2026-11-07T17:30:00+02:00', '22:30', 300, '5 год'],
  ] as const) {
    const summary = nextPlanSummary(plan(), asOf), dashboard = deriveOperational(plan(), asOf);
    assert.equal(summary.time, time); assert.equal(summary.remainingMinutes, minutes);
    assert.equal(summary.remainingLabel, label); assert.equal(summary.remainingLabel, dashboard.next?.remainingLabel);
  }
  assert.equal(nextPlanSummary(plan(), '2026-11-07T14:00:00+02:00').title, 'Вимкнення за графіком');
  const completed = nextPlanSummary(plan(), '2026-11-08T00:00:00+02:00');
  assert.equal(completed.time, null); assert.equal(completed.remainingMinutes, null); assert.equal(completed.remainingLabel, null);
});

test('DST repeated and skipped wall hours use elapsed instants, not wall subtraction', () => {
  for (const [date, start, end, startLocal, endLocal, asOf] of [
    ['2026-10-25', '2026-10-25T03:30:00+03:00', '2026-10-25T03:30:00+02:00', '03:30', '03:30', '2026-10-25T03:45:00+03:00'],
    ['2026-03-29', '2026-03-29T02:30:00+02:00', '2026-03-29T04:30:00+03:00', '02:30', '04:30', '2026-03-29T02:45:00+02:00'],
  ]) {
    const view: ScheduleView = { ...plan(), serviceDate: date, publishedAt: `${date}T01:00:00+02:00`, observedAt: `${date}T01:00:00+02:00`,
      intervals: [{ startsAt: start, endsAt: end, startLocal, endLocal, kind: 'planned_outage' }] };
    const summary = nextPlanSummary(view, asOf);
    assert.equal(summary.remainingMinutes, 45); assert.equal(summary.remainingLabel, '45 хв');
    assert.equal(summary.remainingLabel, deriveOperational(view, asOf).next?.remainingLabel);
  }
});

test('unsafe chronology, coverage and states cannot manufacture a countdown', () => {
  const asOf = '2026-11-07T15:10:00+02:00';
  const unsafe = [
    { ...plan(), observedAt: '2026-11-07T16:00:00+02:00' }, { ...plan(), publishedAt: '2026-11-07T16:00:00+02:00' },
    { ...plan(), dayCoverage: 'none' as const },
    ...(['stale', 'emergency', 'not_published', 'unavailable', 'conflict', 'needs_confirmation'] as const).map(reviewPlan),
    { ...plan(), freshness: 'unknown' as const },
  ];
  for (const view of unsafe) {
    assert.equal(nextInterval(view, asOf), undefined, view.status);
    const summary = nextPlanSummary(view, asOf);
    assert.equal(summary.time, null); assert.equal(summary.remainingMinutes, null); assert.equal(summary.remainingLabel, null);
    assert.doesNotMatch(scheduleText(view, 'now', asOf), /через \d/);
    assert.doesNotMatch(visible(renderScheduleSvg(view, 'now', 'light', asOf)), /через \d/);
  }
  for (const invalid of ['invalid-clock', '2026-11-07T15:10:00', '2026-02-30T15:10:00Z']) {
    assert.equal(nextPlanSummary(plan(), invalid).time, null);
    assert.equal(nextPlanSummary(plan(), invalid).remainingLabel, null);
    assert.doesNotThrow(() => scheduleText(plan(), 'now', invalid));
    assert.match(scheduleText(plan(), 'now', invalid), /Час перегляду не визначено/);
  }
});

test('possible intervals stay qualified and partial-day gaps stay unknown', () => {
  const asOf = '2026-11-07T15:10:00+02:00', possible = reviewPlan('possible');
  const summary = nextPlanSummary(possible, asOf);
  assert.match(summary.title, /Можливе/); assert.equal(summary.remainingLabel, '2 год 20 хв');
  assert.match(scheduleText(possible, 'now', asOf), /Можливе завершення інтервалу о 17:30 · через 2 год 20 хв/);
  assert.doesNotMatch(scheduleText(possible, 'now', asOf), /Увімкнення за графіком/);
  const partial = { ...plan(), dayCoverage: 'partial' as const };
  assert.equal(nextPlanSummary(partial, asOf).remainingLabel, '2 год 20 хв');
  const afterKnown = nextPlanSummary(partial, '2026-11-08T00:00:00+02:00');
  assert.equal(afterKnown.time, null); assert.equal(afterKnown.remainingLabel, null); assert.match(afterKnown.description, /невідомий/);
  assert.match(nextPlanSummary(reviewPlan('no_planned_outages'), asOf).title, /немає/);
  assert.match(nextPlanSummary(reviewPlan('not_published'), asOf).title, /ще не опублікований/);
});

test('long possible summary flows above the timeline in both themes without losing content', () => {
  const view = { ...reviewPlan('possible'), addressLabel: 'Довга навчальна назва будинку Ґанок Єдності Ініціативи Їжачок' };
  for (const theme of ['light', 'dark'] as const) {
    const svg = renderScheduleSvg(view, 'now', theme, '2026-11-07T15:10:00+02:00');
    const shown = visible(svg);
    for (const value of ['Можливе завершення інтервалу', '17:30', 'через 2 год 20 хв', '15:10']) assert.ok(shown.includes(value), value);
    const summaryY = [...svg.matchAll(/<text x="48" y="(\d+)" font-size="(?:17|18)"[^>]*data-schedule-summary="true"/g)].map(m => Number(m[1]));
    assert.ok(summaryY.length >= 3, 'event, remaining and viewing-time rows must be visible');
    const timelineY = Number(svg.match(/<rect x="48" y="(\d+)" width="624" height="36"/)?.[1]);
    assert.ok(Number.isFinite(timelineY)); assert.ok(Math.max(...summaryY) + 20 <= timelineY);
  }
});

test('partial scope stays visible while active and after the known intervals end', () => {
  const view = { ...plan(), dayCoverage: 'partial' as const };
  for (const asOf of ['2026-11-07T15:10:00+02:00', '2026-11-08T00:00:00+02:00']) {
    const active = asOf.includes('15:10');
    const summary = nextPlanSummary(view, asOf);
    assert.equal(summary.remainingLabel, active ? '2 год 20 хв' : null);
    for (const variant of ['day', 'now', 'next'] as const) for (const theme of ['light', 'dark'] as const) {
      const shown = visible(renderScheduleSvg(view, variant, theme, asOf));
      assert.match(shown, /частин[уа].*план|частин[уа].*інтервал/iu);
      assert.match(shown, /решта доби має невідомий статус|інші проміжки доби мають невідомий статус/iu);
      if (!active) assert.doesNotMatch(shown, /через \d/);
    }
  }
});

test('freshness precedes a historical complete-empty claim in summary, SVG and fallback', () => {
  const asOf = '2026-11-07T15:10:00+02:00';
  for (const freshness of ['stale', 'unknown'] as const) {
    const view = { ...reviewPlan('no_planned_outages'), freshness };
    const summary = nextPlanSummary(view, asOf);
    assert.match(summary.title, freshness === 'stale' ? /застарілі|застаріли/iu : /не підтверджено|оновлення/iu);
    assert.equal(summary.time, null); assert.equal(summary.remainingLabel, null);
    for (const variant of ['day', 'now', 'next'] as const) {
      const text = scheduleText(view, variant, asOf);
      assert.match(text, /останн.*повідомлен|історичн/iu);
      assert.match(text, /застаріл|не підтверджено/iu);
      assert.doesNotMatch(text, /Оператор явно повідомив: у цьому обсязі планових відключень немає\./);
      for (const theme of ['light', 'dark'] as const) {
        const shown = visible(renderScheduleSvg(view, variant, theme, asOf));
        assert.match(shown, freshness === 'stale' ? /застарілі|застаріли/iu : /не підтверджено|оновлення/iu);
        assert.doesNotMatch(shown, /Планових відключень немає/iu);
        assert.doesNotMatch(shown, /через \d/);
      }
    }
  }
});

test('axis end labels stay separated on a25hday without moving gridlines or normal24h labels', () => {
  const view: ScheduleView = { ...plan(), serviceDate: '2026-10-25', publishedAt: '2026-10-25T01:00:00+03:00', observedAt: '2026-10-25T01:00:00+03:00',
    intervals: [{ startsAt: '2026-10-25T03:30:00+03:00', endsAt: '2026-10-25T03:30:00+02:00', startLocal: '03:30', endLocal: '03:30', kind: 'planned_outage' }] };
  const axisLabels = (svg: string) => [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" font-size="13"[^>]*text-anchor="middle">(\d\d:\d\d)<\/text>/g)].map(m => ({ x: Number(m[1]), text: m[2] }));
  for (const theme of ['light', 'dark'] as const) {
    const svg = renderScheduleSvg(view, 'now', theme, '2026-10-25T03:45:00+03:00');
    const labels = axisLabels(svg), last = labels.at(-1)!, previous = labels.at(-2)!;
    assert.equal(last.text, '24:00'); assert.equal(last.x, 672);
    assert.ok(last.x - previous.x >= 40, '13px HH:mm labels need breathing room; actual old PNG overlapped at25px');
    const vertical = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
      .filter(m => m[1] === m[3] && Number(m[4]) - Number(m[2]) === 43).map(m => Number(m[1]));
    assert.equal(vertical.length, 9, 'all actual180minute gridlines remain');
    for (let n = 0; n < 9; n++) assert.ok(Math.abs(vertical[n] - (48 + n * 180 / 1500 * 624)) < 1e-9);
    assert.deepEqual(axisLabels(renderScheduleSvg(plan(), 'day', theme)).map(l => l.text), ['00:00','03:00','06:00','09:00','12:00','15:00','18:00','21:00','24:00']);
  }
});

test('clock changes are explained in visible and full now-next output only while ahead', () => {
  for (const [date, start, end, startLocal, endLocal, asOf, direction, afterTransition] of [
    ['2026-10-25', '2026-10-25T03:30:00+03:00', '2026-10-25T03:30:00+02:00', '03:30', '03:30', '2026-10-25T03:45:00+03:00', 'назад', '2026-10-25T03:15:00+02:00'],
    ['2026-03-29', '2026-03-29T02:30:00+02:00', '2026-03-29T04:30:00+03:00', '02:30', '04:30', '2026-03-29T02:45:00+02:00', 'вперед', '2026-03-29T04:00:00+03:00'],
  ]) {
    const view: ScheduleView = { ...plan(), serviceDate: date, publishedAt: `${date}T01:00:00+02:00`, observedAt: `${date}T01:00:00+02:00`,
      intervals: [{ startsAt: start, endsAt: end, startLocal, endLocal, kind: 'planned_outage' }] };
    const summary = nextPlanSummary(view, asOf);
    assert.equal(summary.time, endLocal); assert.equal(summary.remainingLabel, '45 хв');
    const explanation = `Час події вказано після переведення годинника ${direction}.`;
    for (const variant of ['now', 'next'] as const) {
      assert.ok(scheduleText(view, variant, asOf).includes(explanation));
      for (const theme of ['light', 'dark'] as const) assert.ok(visible(renderScheduleSvg(view, variant, theme, asOf)).includes(explanation));
      assert.doesNotMatch(scheduleText(view, variant, afterTransition), /переведення годинника/);
      const stale = { ...view, status: 'stale' as const, freshness: 'stale' as const };
      assert.equal(nextPlanSummary(stale, asOf).time, null);
      assert.doesNotMatch(scheduleText(stale, variant, asOf), /через \d|переведення годинника/);
      assert.doesNotMatch(visible(renderScheduleSvg(stale, variant, 'light', asOf)), /через \d|переведення годинника/);
    }
  }
  assert.doesNotMatch(scheduleText(plan(), 'now', '2026-11-07T15:10:00+02:00'), /переведення годинника/);
});

test('empty cards show their status once with a plain reason and retain source/date/uncertainty', () => {
  for (const [status, variant, title] of [
    ['emergency', 'emergency', 'Аварійний режим'],
    ['no_planned_outages', 'day', 'Планових відключень немає'],
    ['not_published', 'day', 'Очікуємо план'],
  ] as const) for (const theme of ['light', 'dark'] as const) {
    const view = reviewPlan(status), svg = renderScheduleSvg(view, variant, theme), shown = visible(svg);
    assert.equal(shown.split(title).length - 1, 1, `${status} must not repeat the same status in heading/subtitle/emptybox`);
    assert.doesNotMatch(shown, /телеметрія/iu); assert.doesNotMatch(shown, /через \d/);
    for (const text of ['7 листопада 2026', view.source.name, 'Опубліковано:', 'Перевірено:']) assert.ok(shown.includes(text), text);
    assert.equal(Number(svg.match(/<svg[^>]*height="(\d+)"/)?.[1]), 610, 'removing repetitions does not redesign the canvas');
    if (status === 'emergency') assert.match(shown, /Погодинний план може не діяти/);
    if (status === 'not_published') assert.match(shown, /План на цю дату ще не опублікований/);
    if (status === 'no_planned_outages') {
      assert.match(shown, /План не підтверджує, чи є світло зараз/);
      assert.equal((shown.match(/чи є світло зараз/g) || []).length, 1, 'plain physicalpower caveat need not appear twice');
    }
  }
});
