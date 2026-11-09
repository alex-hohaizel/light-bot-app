import type { ScheduleView } from '@shared/product-contract';
import { useId } from 'react';
import { PLAN_STATUS_COPY } from '@shared/product-contract';
import { cardTitle, displayDate, displayInstantDate, displayTime, durationLabel, intervalLabel, localDayBounds, nextPlanSummary, plannedMinutes, scheduleText, validateView, type CardVariant } from './schedule-model';
export { scheduleText } from './schedule-model';
export type { CardVariant } from './schedule-model';

export type CardTheme = 'light' | 'dark';

// Wrap long personal labels and source names without hiding semantic text.
function wrapText(text: string, maximum = 28): string[] {
  const units = (text: string) => [...text].reduce((sum, ch) => sum + (/[ШЩМЖ@W]/.test(ch) ? 1.1 : /[іІїЇ1l|!.,:]/.test(ch) ? .35 : /\s/.test(ch) ? .35 : .7), 0);
  const lines: string[] = []; let line = '';
  for (const word of text.split(/\s+/)) {
    if (units(`${line}${line ? ' ' : ''}${word}`) <= maximum) { line += `${line ? ' ' : ''}${word}`; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const char of word) {
      if (units(line + char) > maximum && line) { lines.push(line); line = ''; }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const xml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]!));

/** Editable SVG and web card derive from the same view and text oracle. */
export function renderScheduleSvg(view: ScheduleView, variant: CardVariant = 'day', theme: CardTheme = 'light', asOf = view.observedAt, idPrefix = 'schedule'): string {
  validateView(view);
  const dark = theme === 'dark', ink = dark ? '#e1e7eb' : '#142d29', muted = dark ? '#b3bec7' : '#60756f';
  const paper = dark ? '#27323c' : '#ffffff', line = dark ? '#3e4c59' : '#e1e9e4';
  const warning = ['emergency', 'unavailable', 'conflict', 'needs_confirmation', 'stale'].includes(view.status);
  const accent = warning ? (dark ? '#f9c883' : '#986016') : (dark ? '#bbd6c8' : '#19734e');
  const intervals = view.intervals;
  const compare = Boolean(view.previousIntervals?.length);
  const technicalGroup = view.addressId.startsWith('unbound:') || Boolean(view.targetId && view.source.verifiedLevel !== 'integration');
  const addressLines = wrapText(`${view.addressLabel} · ${displayDate(view.serviceDate)}`);
  const extra = (addressLines.length - 1) * 26;
  const sourceLines = wrapText(view.source.name, 29), sourceExtra = (sourceLines.length - 1) * 26;
  const noticeLines = view.notice?.trim() ? wrapText(view.notice.trim(), 34) : [];
  const noticeHeight = noticeLines.length ? 42 + noticeLines.length * 28 : 0;
  const timelineY = 221 + extra, listY = 316 + extra;
  const beforeLines = wrapText(view.previousIntervals?.map(i => intervalLabel(i)).join(' · ') || '', 35);
  const height = Math.max(610 + extra, listY + intervals.length * 45 + (compare ? 92 + (beforeLines.length - 1) * 22 : 0) + 175) + sourceExtra + noticeHeight;
  const prefix = idPrefix.replace(/[^a-zA-Z0-9_-]/g, '') || 'schedule';
  const bounds = localDayBounds(view.serviceDate), width = 624;
  const range = (instant: string) => 48 + ((Date.parse(instant) - bounds.start) / (bounds.end - bounds.start)) * width;
  const ticks: string[] = [];
  for (let minutes = 0; minutes < bounds.minutes; minutes += 180) {
    const instant = new Date(bounds.start + minutes * 60_000).toISOString();
    const x = 48 + minutes / bounds.minutes * width;
    ticks.push(`<line x1="${x}" y1="${timelineY - 4}" x2="${x}" y2="${timelineY + 39}" stroke="${line}"/><text x="${x}" y="${timelineY + 61}" font-size="13" fill="${muted}" text-anchor="middle">${displayTime(instant)}</text>`);
  }
  ticks.push(`<text x="672" y="${timelineY + 61}" font-size="13" fill="${muted}" text-anchor="middle">24:00</text>`);
  const blocks = intervals.map(i => `<rect x="${range(i.startsAt)}" y="${timelineY}" width="${Math.max(0.1, range(i.endsAt) - range(i.startsAt))}" height="36" rx="5" stroke="${dark ? '#f2b577' : '#926331'}" stroke-width="1.5" fill="${i.kind === 'planned_outage' ? (dark ? '#f2b577' : '#f1be82') : `url(#${prefix}-possible)`}"><title>${xml(intervalLabel(i, true))}</title></rect>`).join('');
  const intervalRows = intervals.map((i, index) => `<rect x="48" y="${listY + index * 45}" width="7" height="7" rx="2" fill="${accent}"/><text x="69" y="${listY + 7 + index * 45}" font-size="25" font-weight="650" fill="${ink}">${xml(intervalLabel(i))}</text><text x="672" y="${listY + 7 + index * 45}" font-size="17" fill="${muted}" text-anchor="end">${i.kind === 'planned_outage' ? 'планове' : 'можливе'}</text>`).join('');
  const next = nextPlanSummary(view, asOf);
  const subtitle = variant === 'now' || variant === 'next' ? `${next.title}${next.time ? ` · ${next.time}` : ''}` :
    intervals.length ? `${view.status === 'stale' ? 'Останні відомі дані' : view.status === 'possible' ? 'Можливі відключення' : view.dayCoverage === 'partial' ? 'Відома частина доби' : `Інтервалів: ${intervals.length}`} · ${durationLabel(plannedMinutes(view))} за планом` : PLAN_STATUS_COPY[view.status].title;
  const empty = !intervals.length ? `<rect x="48" y="${timelineY}" width="624" height="130" rx="15" fill="${dark ? '#303b46' : '#f4f7f3'}"/><text x="70" y="${timelineY + 42}" font-size="23" font-weight="600" fill="${accent}">${xml(PLAN_STATUS_COPY[view.status].title)}</text><text x="70" y="${timelineY + 77}" font-size="16" fill="${muted}">${view.status === 'emergency' ? 'Погодинний план може не діяти.' : view.status === 'no_planned_outages' ? 'Це не телеметрія фактичного живлення.' : 'Порожній результат не означає «світло є».'}</text>` : '';
  const compareY = Math.max(listY + intervals.length * 45 + 13, intervals.length ? 0 : 365);
  const before = compare ? `<line x1="48" y1="${compareY}" x2="672" y2="${compareY}" stroke="${line}"/><text x="48" y="${compareY + 28}" font-size="13" fill="${muted}">БУЛО</text>${beforeLines.map((line, index) => `<text x="48" y="${compareY + 56 + index * 22}" font-size="17" fill="${muted}">${xml(line)}</text>`).join('')}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="${height}" viewBox="0 0 720 ${height}" role="img" aria-labelledby="${prefix}-title ${prefix}-desc"><title id="${prefix}-title">${xml(cardTitle(variant))}: ${xml(view.addressLabel)}</title><desc id="${prefix}-desc">${xml(scheduleText(view, variant, asOf))}</desc><defs><pattern id="${prefix}-possible" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="${dark ? '#42505a' : '#f6e7b6'}"/><line x1="0" y1="0" x2="0" y2="8" stroke="${dark ? '#d9c985' : '#b59c41'}" stroke-width="3"/></pattern></defs><rect width="720" height="${height}" rx="26" fill="${paper}"/><g font-family="Onest,sans-serif"><text x="48" y="53" font-size="16" font-weight="650" letter-spacing="1.5" fill="${accent}">${technicalGroup ? 'СВІТЛО · ПЛАН ГРУПИ' : 'СВІТЛО · ПЕРСОНАЛЬНИЙ ПЛАН'}</text><text x="672" y="52" text-anchor="end" font-size="13" fill="${muted}">${view.synthetic ? 'ПРИКЛАД' : 'ПЛАН ОПЕРАТОРА'}</text><text x="48" y="104" font-family="Manrope,Onest,sans-serif" font-size="34" font-weight="700" letter-spacing="-0.8" fill="${ink}">${xml(cardTitle(variant))}</text>${addressLines.map((line, index) => `<text x="48" y="${143 + index * 26}" font-size="21" fill="${muted}">${xml(line)}</text>`).join('')}<text x="48" y="${188 + extra}" font-size="18" font-weight="550" fill="${accent}">${xml(subtitle)}</text>${intervals.length ? `<rect x="48" y="${timelineY}" width="624" height="36" rx="6" fill="${dark ? '#34424c' : '#e5eee6'}"/>${ticks.join('')}${blocks}${intervalRows}` : empty}${before}${noticeLines.length ? `<g data-source-notice="true"><line x1="48" y1="${height - 157 - sourceExtra - noticeHeight}" x2="672" y2="${height - 157 - sourceExtra - noticeHeight}" stroke="${line}"/>${noticeLines.map((noticeLine, index) => `<text x="48" y="${height - 126 - sourceExtra - noticeHeight + index * 28}" font-size="22" fill="${ink}">${xml(noticeLine)}</text>`).join('')}</g>` : ''}<line x1="48" y1="${height - 157 - sourceExtra}" x2="672" y2="${height - 157 - sourceExtra}" stroke="${line}"/><text x="48" y="${height - 126 - sourceExtra}" font-size="20" fill="${muted}">Час за Києвом · ${bounds.minutes / 60} год</text>${sourceLines.map((line, index) => `<text x="48" y="${height - 98 - sourceExtra + index * 26}" font-size="20" fill="${muted}">${xml(line)}</text>`).join('')}<text x="48" y="${height - 70}" font-size="20" fill="${muted}">Опубліковано: ${view.publishedAt ? xml(`${displayInstantDate(view.publishedAt)}, ${displayTime(view.publishedAt)}`) : 'час не підтверджено'}</text><text x="48" y="${height - 43}" font-size="20" fill="${muted}">Перевірено: ${xml(displayInstantDate(view.observedAt))}, ${xml(displayTime(view.observedAt))}</text><text x="48" y="${height - 18}" font-size="18" fill="${muted}">Графік не показує, чи є світло зараз.</text></g></svg>`;
}

export function ScheduleCard({ view, variant = 'day', theme = 'light', asOf, showText = true }: {
  view: ScheduleView; variant?: CardVariant; theme?: CardTheme; asOf?: string; showText?: boolean;
}) {
  const id = useId();
  return <figure className="pr-schedule-card" data-testid={`schedule-card-${variant}`}>
    <div className="pr-svg-card" dangerouslySetInnerHTML={{ __html: renderScheduleSvg(view, variant, theme, asOf, id) }} />
    {showText && <figcaption><details><summary>Повний текстовий варіант</summary><pre>{scheduleText(view, variant, asOf)}</pre></details></figcaption>}
  </figure>;
}
