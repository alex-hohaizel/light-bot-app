import type { PlanInterval, ScheduleView } from '@shared/product-contract';
import { PLAN_STATUS_COPY } from '../../../shared/product-contract.ts';
import { localParts, validInstant } from '../../../shared/schedule-core.ts';
import { displayTime, durationLabel, localDayBounds, validateView } from './schedule-model.ts';

export interface OperationalEvent {
  edge: 'off' | 'on'; time: string; instant: string;
  remainingMinutes: number; remainingLabel: string; label: string;
}
export interface OperationalState {
  phase: 'outage' | 'before' | 'complete' | 'unknown';
  phaseLabel: string; reason: string; possible: boolean;
  next: OperationalEvent | null; nextLaterOff: OperationalEvent | null;
  currentIndex: number; nextIndex: number; intervalsSafe: boolean;
  currentInterval: PlanInterval | null;
  elapsedMinutes: number | null; fullDurationMinutes: number | null;
}
const empty = (phaseLabel: string, reason: string): OperationalState => ({
  phase: 'unknown', phaseLabel, reason, possible: false, next: null, nextLaterOff: null,
  currentIndex: -1, nextIndex: -1, intervalsSafe: false, currentInterval: null,
  elapsedMinutes: null, fullDurationMinutes: null,
});

/** Presentation of the canonical ISO schedule only. It never infers physical power. */
export function deriveOperational(view: ScheduleView | null | undefined, asOf: string): OperationalState {
  if (!view) return empty('План поки недоступний', 'Для цієї адреси й дати ще немає підтвердженого плану.');
  try { validateView(view); } catch { return empty('Потрібно перевірити дані', 'Не вдалося підтвердити точність інтервалів цього плану.'); }
  if (!validInstant(asOf)) return empty('Потрібно перевірити час', 'Не вдалося визначити час для наступної події.');
  const copy = PLAN_STATUS_COPY[view.status], now = Date.parse(asOf);
  if (Date.parse(view.observedAt) > now || view.publishedAt && Date.parse(view.publishedAt) > now) return empty('Потрібно перевірити час', 'Час публікації або перевірки плану пізніший за час перегляду. Точну наступну подію поки не показуємо.');
  if (view.freshness !== 'current' || !['published', 'possible', 'no_planned_outages'].includes(view.status)) {
    return empty(view.freshness === 'stale' && view.status !== 'stale' ? 'Дані застаріли' : copy.title,
      view.freshness !== 'current' ? 'Час наступної події не підтверджено. Оновіть план.' : copy.detail);
  }
  if (view.status === 'no_planned_outages') return { ...empty(copy.title, copy.detail), phase: 'complete', intervalsSafe: true };
  if (view.dayCoverage === 'none') return empty('Потрібне уточнення плану', 'Опубліковані інтервали не мають підтвердженого обсягу доби. Точний час поки не показуємо.');
  const nextIndex = view.intervals.findIndex(i => Date.parse(i.endsAt) > now);
  if (nextIndex < 0) return view.dayCoverage === 'complete'
    ? { ...empty('Відомих наступних відключень немає', 'Усі опубліковані інтервали цієї доби завершилися. Фактичне живлення може відрізнятися.'), phase: 'complete', intervalsSafe: true }
    : empty('Очікуємо решту плану', 'Відомі інтервали завершилися. Для решти доби даних поки недостатньо.');
  const interval = view.intervals[nextIndex], active = Date.parse(interval.startsAt) <= now;
  const possible = view.status === 'possible' || interval.kind === 'possible_outage';
  const event = (i: PlanInterval, edge: 'on' | 'off'): OperationalEvent => {
    const instant = edge === 'on' ? i.endsAt : i.startsAt;
    const eventPossible = view.status === 'possible' || i.kind === 'possible_outage';
    const minutes = Math.max(0, Math.ceil((Date.parse(instant) - now) / 60000));
    return { edge, instant, time: edge === 'on' ? i.endLocal : i.startLocal,
      remainingMinutes: minutes, remainingLabel: durationLabel(minutes),
      label: eventPossible ? edge === 'on' ? 'Можливе завершення інтервалу' : 'Можливе вимкнення' : edge === 'on' ? 'Увімкнення за графіком' : 'Вимкнення за графіком' };
  };
  const later = active ? view.intervals.slice(nextIndex + 1).find(i => Date.parse(i.startsAt) > now) : undefined;
  return { phase: active ? 'outage' : 'before', phaseLabel: possible
    ? active ? 'Можливий інтервал зараз' : 'У плані є можливий інтервал'
    : active ? 'За графіком триває відключення' : 'Зараз поза плановим інтервалом',
    reason: view.dayCoverage === 'partial' ? 'Відомо лише частину плану. Інші проміжки доби мають невідомий статус.' : possible ? 'Можливий інтервал. Його виконання не підтверджено.' : 'План оператора не є виміром фактичного живлення.',
    possible, next: event(interval, active ? 'on' : 'off'), nextLaterOff: later ? event(later, 'off') : null,
    currentIndex: active ? nextIndex : -1, nextIndex, intervalsSafe: true, currentInterval: active ? interval : null,
    elapsedMinutes: active ? Math.max(0, Math.floor((now - Date.parse(interval.startsAt)) / 60000)) : null,
    fullDurationMinutes: active ? (Date.parse(interval.endsAt) - Date.parse(interval.startsAt)) / 60000 : null };
}

export interface ScheduleDisplay {
  valid: boolean;
  intervals: PlanInterval[];
  operational: OperationalState;
  historical: boolean;
  possible: boolean;
}
/** The full-day renderer has the same validation fence as the next-event board. */
export function inspectScheduleForDisplay(view: ScheduleView | null | undefined, asOf: string): ScheduleDisplay {
  const operational = deriveOperational(view, asOf);
  try { if (!view) throw new Error('MISSING_PLAN'); validateView(view); }
  catch { return { valid: false, intervals: [], operational, historical: false, possible: false }; }
  return { valid: true, intervals: view.intervals, operational,
    historical: view.intervals.length > 0 && (operational.phase === 'unknown' || view.freshness !== 'current' || view.status === 'stale'),
    possible: view.status === 'possible' };
}

export interface DayAxis {
  start: number; end: number; minutes: number;
  ticks: { at: number; fraction: number; label: string }[];
}
/** An actual 23/24/25-hour local day; never a 1440-minute wall-clock substitute. */
export function createDayAxis(serviceDate: string): DayAxis {
  const bounds = localDayBounds(serviceDate), ticks: DayAxis['ticks'] = [];
  for (let at = bounds.start; at < bounds.end; at += 360 * 60000) {
    ticks.push({ at, fraction: (at - bounds.start) / (bounds.end - bounds.start), label: displayTime(new Date(at).toISOString()).slice(0, 2) });
  }
  ticks.push({ at: bounds.end, fraction: 1, label: '24' });
  return { ...bounds, ticks };
}
export function axisFraction(instant: string | number, axis: DayAxis): number {
  const at = typeof instant === 'number' ? instant : Date.parse(instant);
  return Number.isFinite(at) ? Math.max(0, Math.min(1, (at - axis.start) / (axis.end - axis.start))) : 0;
}
export interface SharedClearWindow { startsAt: string; endsAt: string; startLabel: string; endLabel: string; minutes: number }
/** null means unknown; [] means no common gap. Possible/partial plans never certify gaps. */
export function sharedClearWindows(views: ScheduleView[], asOf: string): SharedClearWindow[] | null {
  if (!views.length || !validInstant(asOf)) return null;
  try { views.forEach(validateView); } catch { return null; }
  const date = views[0].serviceDate;
  if (views.some(v => v.serviceDate !== date || v.freshness !== 'current' || v.dayCoverage !== 'complete' ||
    !['published', 'no_planned_outages'].includes(v.status) || Date.parse(v.observedAt) > Date.parse(asOf) || v.publishedAt !== null && Date.parse(v.publishedAt) > Date.parse(asOf) || v.intervals.some(i => i.kind !== 'planned_outage'))) return null;
  const axis = createDayAxis(date), from = Math.max(axis.start, Math.ceil(Date.parse(asOf) / 60000) * 60000);
  if (from >= axis.end) return [];
  const ranges = views.flatMap(v => v.intervals.map(i => [Math.max(from, Date.parse(i.startsAt)), Math.min(axis.end, Date.parse(i.endsAt))] as const))
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = []; let cursor = from;
  for (const [a, b] of ranges) { if (a > cursor) gaps.push([cursor, a]); cursor = Math.max(cursor, b); }
  if (cursor < axis.end) gaps.push([cursor, axis.end]);
  return gaps.map(([a, b]) => ({ startsAt: new Date(a).toISOString(), endsAt: new Date(b).toISOString(),
    startLabel: localParts(a).time, endLabel: b === axis.end ? '24:00' : localParts(b).time, minutes: (b - a) / 60000 }));
}
