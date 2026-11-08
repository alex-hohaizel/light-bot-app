import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { PlanInterval, ScheduleView, SourceReference } from '../../shared/product-contract.ts';
import { calendarDate, dayBounds, localParts, nextCalendarDate, validInstant, validateScheduleView, wallMinuteInstant } from '../../shared/schedule-core.ts';

export interface KharkivRssContext {
  namespace: 'kharkiv:rss';
  operatorId: 'kharkiv-oe';
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
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const EXPECTED_QUEUES = Array.from({ length: 6 }, (_, i) => [`${i + 1}.1`, `${i + 1}.2`]).flat();
const sha256 = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
function rfcPublication(raw: string): string {
  // Explicit numeric timezone is mandatory. Do not parse browser/host-local timestamps.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d [+-](?:[01]\d|2[0-3])[0-5]\d$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error('RSS_PUBLICATION_FORMAT');
  const fields = raw.split(' '), month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(fields[2]) + 1;
  calendarDate(`${fields[3]}-${String(month).padStart(2, '0')}-${fields[1]}`);
  const result = new Date(Date.parse(raw)).toISOString();
  if (!validInstant(result)) throw new Error('RSS_PUBLICATION_INVALID');
  return result;
}
function minute(clock: string): number {
  if (clock === '24:00') return 1440;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error('RSS_INVALID_CLOCK');
  const [hour, minutes] = clock.split(':').map(Number); return hour * 60 + minutes;
}

/** Strict offline parser for the observed official dated 12-queue publication format. */
export function normalizeKharkivRss(rawBody: string, context: KharkivRssContext): ScheduleView {
  if (context.namespace !== 'kharkiv:rss' || context.operatorId !== 'kharkiv-oe' || context.source.id !== 'kharkiv-official-rss') throw new Error('OPERATOR_NAMESPACE_MISMATCH');
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(rawBody)) throw new Error('RSS_BODY_INVALID');
  const rawHash = sha256(rawBody);
  if (context.source.revision !== rawHash) throw new Error('RAW_SOURCE_HASH_MISMATCH');
  if (!['catalog', 'schedule'].includes(context.source.verifiedLevel)) throw new Error('PARSER_CANNOT_CERTIFY_ADDRESS_OR_INTEGRATION');
  if (!validInstant(context.observedAt)) throw new Error('INVALID_OBSERVED_AT');
  if (!EXPECTED_QUEUES.includes(context.targetId)) throw new Error('TARGET_NOT_FOUND');
  calendarDate(context.serviceDate);
  const bounds = dayBounds(context.serviceDate);
  if (bounds.minutes !== 1440) throw new Error('DST_RSS_CLOCK_REQUIRES_OFFSET_POLICY');
  const [, monthText, dayText] = context.serviceDate.split('-');
  const title = `У Харківській області ${Number(dayText)} ${MONTHS[Number(monthText) - 1]} діятимуть графіки погодинних відключень`;
  const feed = load(rawBody, { xmlMode: true });
  if (feed('rss > channel').length !== 1) throw new Error('RSS_CHANNEL_MISSING');
  const matches = feed('rss > channel > item').toArray().filter(item => feed(item).children('title').text().trim() === title);
  if (matches.length !== 1) throw new Error('DATED_PLAN_MISSING_OR_AMBIGUOUS');
  const item = feed(matches[0]), link = item.children('link').text().trim();
  if (!/^https:\/\/oblenergo\.kharkiv\.ua\/uk\/node\/\d+$/.test(link)) throw new Error('RSS_UNTRUSTED_ITEM_ORIGIN');
  const publishedAt = rfcPublication(item.children('pubDate').text().trim());
  if (Date.parse(publishedAt) > Date.parse(context.observedAt) || Date.parse(publishedAt) < bounds.start - 72 * 3600_000 || Date.parse(publishedAt) >= bounds.end) throw new Error('RSS_PUBLICATION_OUTSIDE_SERVICE_WINDOW');
  const body = load(item.children('description').text());
  body('script,style').remove();
  body('br').replaceWith('\n');
  body('p,div').append('\n');
  const text = body.root().text().split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  const weekdays = ['неділю', 'понеділок', 'вівторок', 'середу', 'четвер', "п’ятницю", 'суботу'];
  const weekday = weekdays[new Date(`${context.serviceDate}T12:00:00Z`).getUTCDay()];
  const expectedIntro = `у ${weekday}, ${Number(dayText)} ${MONTHS[Number(monthText) - 1]}, з 00:00 до 24:00`;
  if (!text.toLocaleLowerCase('uk-UA').replace(/'/g, '’').includes(expectedIntro)) throw new Error('RSS_BODY_DATE_CONFLICT');
  if (/скасован|аварійн|не діятим|не будуть діяти/iu.test(text)) throw new Error('RSS_PLAN_WITHDRAWN_OR_OVERLAY_REQUIRES_REVIEW');
  if (!text.includes('Години відсутності електропостачання') || !new RegExp(`у Харківській області будуть діяти графіки погодинних відключень`).test(text) || !text.includes('з 00:00 до 24:00')) throw new Error('RSS_PLAN_SEMANTICS_NOT_RECOGNIZED');
  const table = new Map<string, PlanInterval[]>();
  for (const line of text.split('\n')) {
    if (!/^\d+\.\d+\s/.test(line)) continue;
    const parsed = /^([1-6]\.[12])\s+(.+)$/.exec(line);
    if (!parsed || table.has(parsed[1])) throw new Error('RSS_QUEUE_DUPLICATE_OR_UNKNOWN');
    const intervals: PlanInterval[] = [];
    for (const range of parsed[2].split(';').map(value => value.trim()).filter(Boolean)) {
      const pair = /^(\d{2}:\d{2})\s*[-–—]\s*(\d{2}:\d{2})$/.exec(range);
      if (!pair) throw new Error('RSS_INTERVAL_FORMAT');
      const start = minute(pair[1]), end = minute(pair[2]);
      if (start >= end) throw new Error('RSS_INTERVAL_REVERSED');
      intervals.push({ startsAt: wallMinuteInstant(context.serviceDate, start), endsAt: wallMinuteInstant(context.serviceDate, end),
        startLocal: pair[1], endLocal: pair[2], kind: 'planned_outage' });
    }
    if (!intervals.length) throw new Error('RSS_EMPTY_QUEUE_NOT_EXPLICIT_NONE');
    table.set(parsed[1], intervals);
  }
  if (table.size !== EXPECTED_QUEUES.length || EXPECTED_QUEUES.some(key => !table.has(key))) throw new Error('RSS_INCOMPLETE_QUEUE_TABLE');
  // Validate every queue, not only the requested one: a damaged table invalidates this parser attempt.
  const observationDate = localParts(Date.parse(context.observedAt)).date;
  const freshness = context.freshness === 'stale' || ![observationDate, nextCalendarDate(observationDate)].includes(context.serviceDate) ? 'stale' : context.freshness;
  const base: ScheduleView = {
    contractVersion: 'lba-product/1', revisionId: `kharkiv-rss:${sha256(JSON.stringify({ rawHash, link, publishedAt, target: context.targetId, date: context.serviceDate }))}`,
    addressId: context.addressId, addressLabel: context.addressLabel, localityLabel: context.localityLabel,
    operatorId: context.operatorId, namespace: context.namespace, targetId: context.targetId,
    serviceDate: context.serviceDate, timezone: 'Europe/Kyiv', status: freshness === 'stale' ? 'stale' : 'published', dayCoverage: 'complete',
    intervals: table.get(context.targetId)!, source: { ...context.source, url: link, revision: rawHash },
    publishedAt, observedAt: context.observedAt, freshness, synthetic: context.synthetic, deliveryEligible: false,
    notice: 'Погодинний план Харківобленерго з орієнтовним часом перемикань. Аварійний режим має окрему ревізію. Будинок і доставка не сертифіковані.',
  };
  for (const intervals of table.values()) validateScheduleView({ ...base, intervals });
  return base;
}
