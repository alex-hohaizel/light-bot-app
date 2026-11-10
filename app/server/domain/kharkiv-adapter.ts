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
  /** Versioned owner scope: a general group plan, with unknown emergency overlay. */
  publicationPolicy?: 'dated_12_queue_recurring_v2';
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

/** Bounded recognition of an operative bulletin from this official feed. A
 * mention in advice, a different territory, and a publication timestamp alone
 * are not an effective emergency scope. Unknown overlay remains in the notice. */
function emergencyBulletinNeedsReview(title: string, description: string, publication: string, serviceDate: string): boolean {
  const plain = load(description).text().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA');
  const heading = title.toLocaleLowerCase('uk-UA'), publicationDate = localParts(Date.parse(publication)).date;
  const emergency = /аварійн[\p{L}]*\s+(?:відключ|знеструм|режим)/iu;
  const operative = /(?:застосовуються|застосовано|застосовані|запроваджуються|запроваджено|запроваджені|вводяться|введено|введені|діють|діятимуть|будуть\s+(?:діяти|застосовані|введені|запроваджені)|не\s+(?:(?:було|були)\s+)?скасован(?:о|і)|залишаються\s+(?:чинними|в\s+дії))/iu;
  const conditional = /(?:якщо|у разі|в разі|можуть|може|як підготуватися|що робити,? коли)/iu;
  const localTerritory = /харківськ[\p{L}]*|харківщин[\p{L}]*|(?:у|в) харкові|(?:^|[^\p{L}])харків(?:$|[^\p{L}])/iu;
  const otherTerritory = /ки(?:єв|їв)[\p{L}]*|одес[\p{L}]*|вінниц[\p{L}]*|дніпр[\p{L}]*|львів[\p{L}]*|полтав[\p{L}]*|сумськ[\p{L}]*|чернігів[\p{L}]*|житомир[\p{L}]*|черкас[\p{L}]*|хмельниц[\p{L}]*|тернопіл[\p{L}]*|івано-франків[\p{L}]*|закарпат[\p{L}]*|чернів[\p{L}]*|рівнен[\p{L}]*|волин[\p{L}]*|миколаїв[\p{L}]*|херсон[\p{L}]*|запорі[\p{L}]*|донецьк[\p{L}]*|луган[\p{L}]*|кіровоград[\p{L}]*|крим[\p{L}]*/iu;
  const sentences = plain.split(/[!?]\s*|\.(?!\d)\s*/u).filter(Boolean);
  for (const sentence of sentences) {
    if (!emergency.test(sentence) || !operative.test(sentence) || conditional.test(sentence)) continue;
    // "не скасовано" asserts continuation; negating "застосовуються" does
    // not. Keep this distinction before deciding whether scope needs review.
    const affirmative = [...sentence.matchAll(new RegExp(operative.source, 'giu'))].some(match => !/не(?:\s+(?:було|були|будуть|буде))?\s*$/u.test(sentence.slice(0, match.index)));
    if (!affirmative) continue;
    const scope = `${heading} ${sentence}`;
    if (!localTerritory.test(scope) && otherTerritory.test(scope)) continue;
    const dates: string[] = [];
    for (const match of scope.matchAll(new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`, 'gu'))) {
      const date = `${match[3] || serviceDate.slice(0, 4)}-${String(MONTHS.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      try { calendarDate(date); dates.push(date); } catch { /* Not an effective calendar date. */ }
    }
    for (const match of scope.matchAll(/(\d{2})\.(\d{2})\.(\d{4})/gu)) {
      const date = `${match[3]}-${match[2]}-${match[1]}`; try { calendarDate(date); dates.push(date); } catch { /* Invalid date. */ }
    }
    // An explicit effective day takes precedence over the posting day. A later
    // plan is not a cancellation of a dated emergency bulletin.
    if (dates.length) {
      if (dates.includes(serviceDate) || dates.length === 2 && /(?:^|\s)з\s.+\sдо\s/u.test(scope) && dates[0] < serviceDate && serviceDate < dates[1]) return true;
      continue;
    }
    if (/завтра/u.test(scope)) { if (nextCalendarDate(publicationDate) === serviceDate) return true; continue; }
    if (publicationDate === serviceDate) return true;
  }
  return false;
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
  if(context.publicationPolicy!==undefined&&context.publicationPolicy!=='dated_12_queue_recurring_v2')throw new Error('RSS_PUBLICATION_POLICY_UNKNOWN');
  const recurring=context.publicationPolicy==='dated_12_queue_recurring_v2';
  const acceptedTitles=recurring?[title,`У Харківській області ${Number(dayText)} ${MONTHS[Number(monthText) - 1]} діятимуть погодинні відключення`]:[title];
  const matches = feed('rss > channel > item').toArray().filter(item => acceptedTitles.includes(feed(item).children('title').text().trim()));
  if (matches.length !== 1) throw new Error('DATED_PLAN_MISSING_OR_AMBIGUOUS');
  const item = feed(matches[0]), link = item.children('link').text().trim();
  if (!/^https:\/\/oblenergo\.kharkiv\.ua\/uk\/node\/\d+$/.test(link)) throw new Error('RSS_UNTRUSTED_ITEM_ORIGIN');
  const publishedAt = rfcPublication(item.children('pubDate').text().trim());
  if (Date.parse(publishedAt) > Date.parse(context.observedAt) || Date.parse(publishedAt) < bounds.start - 72 * 3600_000 || Date.parse(publishedAt) >= bounds.end) throw new Error('RSS_PUBLICATION_OUTSIDE_SERVICE_WINDOW');
  // Keep announcement time separate from effective day and territory. This
  // historical policy holds projection for review. The initial-launch policy
  // retains the group plan with an explicit unknown-overlay caveat.
  let currentEmergencyBulletin=false;
  for (const candidate of feed('rss > channel > item').toArray()) {
    if (candidate === matches[0]) continue;
    const other = feed(candidate);
    let time: string; try { time = rfcPublication(other.children('pubDate').text().trim()); } catch { continue; }
    if (Date.parse(time) <= Date.parse(context.observedAt) && emergencyBulletinNeedsReview(other.children('title').text(), other.children('description').text(), time, context.serviceDate))
      {if(!recurring)throw new Error('RSS_CURRENT_EMERGENCY_REQUIRES_SCOPED_REVIEW');currentEmergencyBulletin=true;}
  }
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
  if (!text.includes('з урахуванням часу на перемикання (орієнтовно)')) throw new Error('RSS_PLAN_SWITCHING_CAVEAT_REQUIRES_REVIEW');
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
    notice: recurring ? (currentEmergencyBulletin?'ОСР опублікував повідомлення про аварійні обмеження. Їхній вплив на обрану групу та фактичне живлення не підтверджено. ':'')+'Загальний план групи; час орієнтовний через перемикання. Групу обрано вручну; відповідність будинку не підтверджена. Поточний аварійний стан групи не підтверджено; фактичне живлення може відрізнятися.' : 'Час у плані групи орієнтовний через перемикання; відповідність вашому будинку ще не підтверджена. Поточний аварійний стан групи не підтверджено; фактичне живлення може відрізнятися. Сповіщення про цей план поки недоступні.',
  };
  for (const intervals of table.values()) validateScheduleView({ ...base, intervals });
  return base;
}
