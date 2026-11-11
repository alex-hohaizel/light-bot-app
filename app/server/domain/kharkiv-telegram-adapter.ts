import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { PlanInterval, ScheduleView } from '../../shared/product-contract.ts';
import { calendarDate, dayBounds, localParts, nextCalendarDate, validInstant, validateScheduleView } from '../../shared/schedule-core.ts';
import type { KharkivRssContext } from './kharkiv-adapter.ts';

export const KHARKIV_TELEGRAM_ENDPOINT = 'https://t.me/s/kharkivenergy';
export const KHARKIV_TELEGRAM_SOURCE = 'kharkiv-official-telegram';
export const KHARKIV_TELEGRAM_QUEUE_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 6 }, (_, index) => [`${index + 1}.1`, `${index + 1}.2`]).flat(),
);

const months = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const weekdays = ['неділю', 'понеділок', 'вівторок', 'середу', 'четвер', 'п’ятницю', 'суботу'];
const scheduleTopic = /(?:графік[\p{L}]* (?:погодинних )?відключень|погодинн[\p{L}]* відключ[\p{L}]*|гпв|години відсутності електропостачання)/iu;
const planChange = /(?:скасов[\p{L}]*|скасован[\p{L}]*|скасув[\p{L}]*|скасували|змін[\p{L}]*|оновл[\p{L}]*|коригув[\p{L}]*|скориг[\p{L}]*|уточнен[\p{L}]*|не діятим|не будуть діяти)/iu;
const planStart = /(?:будуть діяти|діятимуть|будуть застосовуватися|запроваджуються|запроваджено)/iu;
const planHeadline = /^[^\p{L}]*(?:графік[\p{L}]* (?:погодинних )?відключень|погодинн[\p{L}]* відключ[\p{L}]*|гпв)(?!\p{L})/iu;
const emergencyStart = /(?:діють|застосовано|запроваджено|введено|застосовуються|запроваджуються|вводяться)/iu;
const heading = /^години відсутності електропостачання по чергам\/підчергам з урахуванням часу на перемикання \(орієнтовно\):$/iu;
const hourlyPlan = /у харківській області (?:будуть діяти|діятимуть) графіки погодинних відключень/iu;
const planWithdrawal = /(?:скасовано|скасовані|скасовуються|скасували|не діятим|не будуть діяти|призупинен)/iu;
const emergency = /аварійн[\p{L}]*\s+(?:відключ|знеструм|режим|обмежен)/iu;
const publicFooter = [
  /^перелік адрес за чергами\s*[-–—]\s*тут\.?$/iu,
  /^[^\p{L}]*для промисловості та бізнесу з \d{2}:\d{2} до \d{2}:\d{2} діятимуть графіки обмеження потужності \(гоп\)\.?$/iu,
  /^[^\p{L}]*ситуація в енергосистемі постійно змінюється, тож слідкуйте за оновленнями на офіційних ресурсах ["«]харківобленерго["»]\.?$/iu,
];
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function matchingDate(text: string, serviceDate: string): boolean {
  const [year, month, day] = serviceDate.split('-');
  const textualDates = new RegExp('(?<!\\d)(\\d{1,2})\\s+(' + months.join('|') + ')(?!\\p{L})(?:\\s+(\\d{4})(?!\\d))?', 'gu');
  for (const match of text.matchAll(textualDates)) {
    if (Number(match[1]) === Number(day) && match[2] === months[Number(month) - 1] && (!match[3] || match[3] === year)) return true;
  }
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{4})(?!\d)/gu)) {
    if (Number(match[1]) === Number(day) && Number(match[2]) === Number(month) && match[3] === year) return true;
  }
  for (const match of text.matchAll(/(?:^|[^\p{L}])(?:на|за|від|відключень)\s+(\d{1,2})[./](\d{1,2})(?![./\d])/gu)) {
    if (Number(match[1]) === Number(day) && Number(match[2]) === Number(month)) return true;
  }
  return new RegExp('(?<!\\d)' + serviceDate + '(?!\\d)', 'u').test(text);
}

function toMinute(clock: string): number {
  if (clock === '24:00') return 1440;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error('TELEGRAM_INTERVAL_CLOCK');
  const [hour, minute] = clock.split(':').map(Number);
  return hour * 60 + minute;
}

function readQueueTable(lines: string[], startOfDay: number): Map<string, PlanInterval[]> {
  const table = new Map<string, PlanInterval[]>();
  let footer = false;
  for (const line of lines) {
    if (publicFooter.some(pattern => pattern.test(line))) {
      footer = true;
      continue;
    }
    const row = /^([1-6]\.[12])\s+(.+)$/u.exec(line);
    if (footer || !row || table.has(row[1])) throw new Error('TELEGRAM_QUEUE_DUPLICATE_OR_UNKNOWN');

    let previousEnd = 0;
    const intervals: PlanInterval[] = [];
    for (const range of row[2].split(';')) {
      const pair = /^(\d{2}:\d{2})\s*[-–—]\s*(\d{2}:\d{2})$/u.exec(range.trim());
      if (!pair) throw new Error('TELEGRAM_INTERVAL_FORMAT');
      const start = toMinute(pair[1]), end = toMinute(pair[2]);
      if (start >= end || start < previousEnd) throw new Error('TELEGRAM_INTERVAL_OVERLAP_OR_ORDER');
      intervals.push({
        startsAt: new Date(startOfDay + start * 60_000).toISOString(),
        endsAt: new Date(startOfDay + end * 60_000).toISOString(),
        startLocal: pair[1], endLocal: pair[2], kind: 'planned_outage',
      });
      previousEnd = end;
    }
    table.set(row[1], intervals);
  }
  if (table.size !== KHARKIV_TELEGRAM_QUEUE_IDS.length) throw new Error('TELEGRAM_INCOMPLETE_QUEUE_TABLE');
  return table;
}

type Bulletin = { link: string; publishedAt: string; lines: string[] };

function findLatestBulletin(rawBody: string, serviceDate: string, observedAt: number, dayStart: number, dayEnd: number): Bulletin {
  const feed = load(rawBody);
  const candidates: Bulletin[] = [];
  const seenIds = new Set<string>();

  for (const message of feed('.tgme_widget_message[data-post]').toArray()) {
    const post = feed(message);
    const id = /^kharkivenergy\/([1-9]\d{0,14})$/u.exec(post.attr('data-post') ?? '')?.[1];
    if (!id) continue;
    const body = post.find('.tgme_widget_message_text');
    if (!body.length) continue;
    body.find('script,style').remove();
    body.find('br').replaceWith('\n');
    body.find('p,div').append('\n');
    const lines = body.text().split('\n').map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean);
    const text = lines.join(' ').toLocaleLowerCase('uk-UA').replace(/['ʼ]/gu, '’');
    const operativePlan = hourlyPlan.test(text) || lines.some(line => heading.test(line) || planHeadline.test(line))
      || (scheduleTopic.test(text) && (planChange.test(text) || planStart.test(text)));
    const operativeEmergency = emergency.test(text) && emergencyStart.test(text);
    if (!operativePlan && !operativeEmergency) continue;

    const dateLink = post.find('.tgme_widget_message_date');
    const times = dateLink.find('time[datetime]');
    const timestamp = times.attr('datetime');
    const explicitlyDated = matchingDate(text, serviceDate);
    const relativeDay = /(?:^|[^\p{L}])завтра(?!\p{L})/u.test(text)
      ? 'tomorrow' : /(?:^|[^\p{L}])сьогодні(?!\p{L})/u.test(text) ? 'today' : null;
    if (!explicitlyDated && !(relativeDay && planChange.test(text))) continue;
    if (!validInstant(timestamp)) throw new Error('TELEGRAM_PUBLICATION_FORMAT');

    const published = Date.parse(timestamp);
    if (published < dayStart - 72 * 3600_000 || published >= dayEnd) continue;
    if (!explicitlyDated) {
      const publicationDate = localParts(published).date;
      const effectiveDate = relativeDay === 'tomorrow' ? nextCalendarDate(publicationDate) : publicationDate;
      if (effectiveDate !== serviceDate) continue;
    }

    const link = 'https://t.me/kharkivenergy/' + id;
    if (published > observedAt) throw new Error('TELEGRAM_PUBLICATION_AFTER_OBSERVATION');
    if (body.length !== 1 || dateLink.length !== 1 || times.length !== 1 || dateLink.attr('href') !== link
      || post.find('.tgme_widget_message_forwarded_from').length) throw new Error('TELEGRAM_UNTRUSTED_MESSAGE');
    if (seenIds.has(id)) throw new Error('TELEGRAM_DATED_PLAN_AMBIGUOUS');
    seenIds.add(id);
    candidates.push({ link, publishedAt: new Date(published).toISOString(), lines });
  }

  candidates.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!candidates.length) throw new Error('TELEGRAM_DATED_PLAN_MISSING');
  if (candidates[0].publishedAt === candidates[1]?.publishedAt) throw new Error('TELEGRAM_DATED_PLAN_AMBIGUOUS');
  return candidates[0];
}

function readTelegramPlan(rawBody: string, serviceDate: string, observedAt: number) {
  const bounds = dayBounds(serviceDate);
  if (bounds.minutes !== 1440) throw new Error('DST_TELEGRAM_CLOCK_REQUIRES_OFFSET_POLICY');

  const latest = findLatestBulletin(rawBody, serviceDate, observedAt, bounds.start, bounds.end);
  const text = latest.lines.join(' ').toLocaleLowerCase('uk-UA').replace(/['ʼ]/gu, '’');
  if (planWithdrawal.test(text)) throw new Error('TELEGRAM_PLAN_WITHDRAWN');
  if (emergency.test(text)) throw new Error('TELEGRAM_EMERGENCY_OVERLAY_REQUIRES_REVIEW');

  const [year, month, day] = serviceDate.split('-');
  const weekday = weekdays[new Date(serviceDate + 'T12:00:00Z').getUTCDay()];
  const date = 'у ' + weekday + ', ' + Number(day) + ' ' + months[Number(month) - 1];
  const fullDay = new RegExp(date + '(?: ' + year + '(?: року)?)?, з 00:00 до 24:00', 'u');
  if (!fullDay.test(text)) throw new Error('TELEGRAM_BODY_DATE_OR_COVERAGE_CONFLICT');
  const headingIndex = latest.lines.findIndex(line => heading.test(line));
  if (headingIndex < 1 || !hourlyPlan.test(latest.lines.slice(0, headingIndex).join(' '))) {
    throw new Error('TELEGRAM_PLAN_SEMANTICS_NOT_RECOGNIZED');
  }
  const table = readQueueTable(latest.lines.slice(headingIndex + 1), bounds.start);
  return { latest, table };
}

function normalize(rawBody: string, context: KharkivRssContext, readPlan: typeof readTelegramPlan): ScheduleView {
  if (context.namespace !== 'kharkiv:rss' || context.operatorId !== 'kharkiv-oe' ||
      context.source.id !== KHARKIV_TELEGRAM_SOURCE || context.source.url !== KHARKIV_TELEGRAM_ENDPOINT) {
    throw new Error('TELEGRAM_OPERATOR_NAMESPACE_OR_ORIGIN_MISMATCH');
  }
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > 2_000_000 || /<!ENTITY|<!DOCTYPE[^>]*\[/iu.test(rawBody)) {
    throw new Error('TELEGRAM_BODY_INVALID');
  }
  const rawHash = sha256(rawBody);
  if (context.source.revision !== rawHash) throw new Error('RAW_SOURCE_HASH_MISMATCH');
  if (!['catalog', 'schedule'].includes(context.source.verifiedLevel)) throw new Error('PARSER_CANNOT_CERTIFY_ADDRESS_OR_INTEGRATION');
  if (context.publicationPolicy !== undefined && context.publicationPolicy !== 'dated_12_queue_recurring_v2') throw new Error('TELEGRAM_PUBLICATION_POLICY_UNKNOWN');
  if (!validInstant(context.observedAt)) throw new Error('INVALID_OBSERVED_AT');
  if (!KHARKIV_TELEGRAM_QUEUE_IDS.includes(context.targetId)) throw new Error('TARGET_NOT_FOUND');
  const serviceDate = calendarDate(context.serviceDate);
  const observedAt = Date.parse(context.observedAt);
  const { latest, table } = readPlan(rawBody, serviceDate, observedAt);

  const observationDate = localParts(observedAt).date;
  const freshness = [observationDate, nextCalendarDate(observationDate)].includes(serviceDate) ? context.freshness : 'stale';
  const view: ScheduleView = {
    contractVersion: 'lba-product/1',
    revisionId: 'kharkiv-telegram:' + sha256(JSON.stringify([latest.link, latest.publishedAt, latest.lines, context.targetId, serviceDate])),
    addressId: context.addressId, addressLabel: context.addressLabel, localityLabel: context.localityLabel,
    operatorId: context.operatorId, namespace: context.namespace, targetId: context.targetId,
    serviceDate, timezone: 'Europe/Kyiv', status: freshness === 'stale' ? 'stale' : 'published',
    dayCoverage: 'complete', intervals: table.get(context.targetId)!.map(interval => ({ ...interval })),
    source: { ...context.source, url: latest.link, revision: rawHash },
    publishedAt: latest.publishedAt, observedAt: context.observedAt, freshness, synthetic: context.synthetic, deliveryEligible: false,
    notice: 'Загальний план групи. Час орієнтовний через перемикання. Групу обрано вручну. Відповідність будинку та поточні аварійні відключення не підтверджено.',
  };
  validateScheduleView(view);
  return view;
}

/** Normalizes the operator's dated public 12-queue Telegram bulletin. */
export function normalizeKharkivTelegram(rawBody: string, context: KharkivRssContext): ScheduleView {
  return normalize(rawBody, context, readTelegramPlan);
}

/** Reuse parsing across group projections within a source intake. */
export function createKharkivTelegramNormalizer(): typeof normalizeKharkivTelegram {
  let lastBody: string | undefined;
  let lastObservation: number | undefined;
  const byDate = new Map<string, ReturnType<typeof readTelegramPlan> | Error>();
  const readPlan: typeof readTelegramPlan = (rawBody, serviceDate, observedAt) => {
    if (rawBody !== lastBody || observedAt !== lastObservation) {
      byDate.clear();
      lastBody = rawBody;
      lastObservation = observedAt;
    }
    let result = byDate.get(serviceDate);
    if (!result) {
      try { result = readTelegramPlan(rawBody, serviceDate, observedAt); }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        result = error;
      }
      if (byDate.size === 2) byDate.delete(byDate.keys().next().value!);
      byDate.set(serviceDate, result);
    }
    if (result instanceof Error) throw new Error(result.message);
    return result;
  };
  return (rawBody, context) => normalize(rawBody, context, readPlan);
}
