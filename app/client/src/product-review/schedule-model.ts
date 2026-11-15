import type { PlanInterval, ScheduleView } from '@shared/product-contract';
import { dayBounds, localParts, validateScheduleView, intervalMinutes } from '../../../shared/schedule-core.ts';

export type CardVariant = 'day' | 'now' | 'next' | 'new' | 'changed' | 'moved' | 'cancelled' | 'emergency' | 'unknown';
export const CARD_VARIANTS: { id: CardVariant; title: string }[] = [
  { id: 'day', title: 'Повний день' }, { id: 'now', title: 'Плановий стан' },
  { id: 'next', title: 'Наступна подія' }, { id: 'new', title: 'Новий план' },
  { id: 'changed', title: 'Істотна зміна' }, { id: 'moved', title: 'Перенесення' },
  { id: 'cancelled', title: 'Скасування' }, { id: 'emergency', title: 'Аварійний режим' },
  { id: 'unknown', title: 'Дані недоступні' },
];

/** View wrappers consume the one parent-owned temporal/validation engine. */
export const localDayBounds = dayBounds;
export const validateView = validateScheduleView;

export function offsetLabel(instant: string): string {
  if (instant.endsWith('Z')) return 'UTC';
  return `UTC${instant.slice(-6)}`;
}
export function intervalLabel(interval: PlanInterval, offsets = false): string {
  const base = `${interval.startLocal}–${interval.endLocal}`;
  const fromOffset = offsetLabel(interval.startsAt), toOffset = offsetLabel(interval.endsAt);
  return offsets || fromOffset !== toOffset ? `${base} (${fromOffset}${fromOffset !== toOffset ? ` → ${toOffset}` : ''})` : base;
}
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} год` : '', rest ? `${rest} хв` : ''].filter(Boolean).join(' ') || '0 хв';
}
export function plannedMinutes(view: ScheduleView): number {
  return intervalMinutes(view.intervals.filter(i => i.kind === 'planned_outage'));
}
export function displayDate(date: string): string {
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
export function displayInstantDate(instant: string): string {
  return displayDate(localParts(Date.parse(instant)).date);
}
export function displayTime(instant: string): string {
  return new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv', hour12: false }).format(new Date(instant));
}
export function nextInterval(view: ScheduleView, asOf: string) {
  if (!['published', 'possible'].includes(view.status) || view.freshness !== 'current') return undefined;
  const instant = Date.parse(asOf);
  return [...view.intervals].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).find(i => Date.parse(i.endsAt) > instant);
}
export function nextPlanSummary(view: ScheduleView, asOf: string): { title: string; description: string; time: string | null } {
  const unavailable: Partial<Record<ScheduleView['status'], string>> = {
    stale: 'Потрібне оновлення плану', emergency: 'Аварійний режим', not_published: 'План ще не опублікований',
    unavailable: 'Джерело недоступне', conflict: 'Дані суперечливі', needs_confirmation: 'Потрібна точна прив’язка',
    no_planned_outages: 'Планових відключень немає',
  };
  if (unavailable[view.status] || view.freshness !== 'current') return { title: unavailable[view.status] || 'Потрібне оновлення плану',
    description: view.status === 'no_planned_outages' ? 'Так повідомив оператор. Це не вимір фактичного живлення.' : 'Час наступної події не підтверджено.', time: null };
  const next = nextInterval(view, asOf);
  if (!next) return { title: 'Відомих наступних інтервалів немає',
    description: view.dayCoverage === 'partial' ? 'Решта доби має невідомий статус.' : 'Це план оператора, а не вимір фактичного живлення.', time: null };
  const active = Date.parse(next.startsAt) <= Date.parse(asOf), possible = next.kind === 'possible_outage' || view.status === 'possible';
  return { title: possible ? active ? 'Можливе завершення інтервалу' : 'Можливе відключення' : active ? 'Завершення інтервалу за планом' : 'Початок інтервалу за планом',
    description: possible ? 'Можливий інтервал. Його виконання не підтверджено.' : 'За опублікованим планом оператора. Фактичне живлення може відрізнятися.',
    time: active ? next.endLocal : next.startLocal };
}

const titles: Record<CardVariant, string> = {
  day: 'План на день', now: 'Стан за планом', next: 'Наступна подія', new: 'Опубліковано новий план',
  changed: 'План оновлено', moved: 'Інтервали перенесено', cancelled: 'Планові відключення скасовано',
  emergency: 'Аварійний режим', unknown: 'Поки немає перевірених даних',
};
export function cardTitle(variant: CardVariant): string { return titles[variant]; }
export function scheduleText(view: ScheduleView, variant: CardVariant = 'day', asOf = view.observedAt): string {
  validateView(view);
  const lines = [cardTitle(variant), `${view.addressLabel} · ${displayDate(view.serviceDate)}`, 'Час: Europe/Kyiv. План оператора не є виміром живлення.'];
  if (view.synthetic) lines.push('Синтетичний приклад для огляду.');
  if (view.status === 'emergency') lines.push('Погодинний план може не діяти. Орієнтуйтеся на повідомлення оператора.');
  else if (view.status === 'no_planned_outages') lines.push('Оператор явно повідомив: у цьому обсязі планових відключень немає.');
  else if (['not_published', 'unavailable', 'conflict', 'needs_confirmation'].includes(view.status)) {
    lines.push(({ not_published: 'Очікуємо публікацію плану.', unavailable: 'Джерело недоступне. Це не означає відсутність відключень.',
      conflict: 'Джерела суперечать одне одному. Персональні сповіщення призупинено.', needs_confirmation: 'Профіль збережено. Потрібна точна прив’язка будинку.' } as Record<string, string>)[view.status]);
  }
  if (view.status === 'stale') lines.push('Останній відомий план; дані застаріли. Персональні сповіщення призупинено.');
  if (view.dayCoverage === 'partial') lines.push('Відомі лише частина інтервалів; решта доби має невідомий статус.');
  if (view.previousIntervals?.length) {
    lines.push('Було:', ...view.previousIntervals.map(i => `• ${intervalLabel(i, true)}`), 'Стало:');
  }
  if (view.intervals.length) lines.push(...view.intervals.map(i => `• ${intervalLabel(i, true)} · ${i.kind === 'planned_outage' ? 'планове відключення' : 'можливе відключення'}`));
  if (variant === 'now' || variant === 'next') {
    const summary = nextPlanSummary(view, asOf);
    lines.push(`Час у прикладі: ${displayTime(asOf)}.`, `${summary.title}${summary.time ? ` о ${summary.time}` : ''}.`, summary.description);
  }
  lines.push(`Джерело: ${view.source.name}.`, `Опубліковано: ${view.publishedAt ? `${displayInstantDate(view.publishedAt)}, ${displayTime(view.publishedAt)}` : 'час не підтверджено'}.`,
    `Перевірено: ${displayInstantDate(view.observedAt)}, ${displayTime(view.observedAt)}.`, `Ревізія: ${view.revisionId}.`);
  return lines.join('\n');
}
