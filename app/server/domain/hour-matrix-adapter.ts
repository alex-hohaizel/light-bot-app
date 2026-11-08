import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { parse } from 'acorn';
import type { PlanInterval, ScheduleView, SourceReference } from '../../shared/product-contract.ts';
import { dayBounds, localParts, nextCalendarDate, validInstant, validateScheduleView, wallMinuteInstant } from '../../shared/schedule-core.ts';

const SOURCES = {
  'voe:vn-progr': { operatorId: 'vinnytsia-oe', sourceId: 'voe-mirror-vn-progr', regionId: 'vinnytsia', targetNamespace: 'voe:vinnytsia' },
  'voe:olnet93': { operatorId: 'vinnytsia-oe', sourceId: 'voe-mirror-olnet93', regionId: 'vinnytsia', targetNamespace: 'voe:vinnytsia' },
  'dtek:oem': { operatorId: 'dtek-oem', sourceId: 'dtek-oem-official', regionId: null, targetNamespace: 'dtek:oem' },
} as const;
export interface HourMatrixContext {
  /** Parser/source profile; returned target namespace is stable across equivalent VOE mirrors. */
  namespace: keyof typeof SOURCES;
  operatorId: string;
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
type ObjectValue = Record<string, unknown>;
const record = (value: unknown): value is ObjectValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const hash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
const OEM_LEGEND = {
  yes: 'Світло є', maybe: 'Можливо відключення', no: 'Світла немає',
  first: 'Світла не буде перші 30 хв.', second: 'Світла не буде другі 30 хв',
  mfirst: 'Світла можливо не буде перші 30 хв.', msecond: 'Світла можливо не буде другі 30 хв',
} as const;

/** Read only a JSON object following one exact assignment; never evaluate source scripts. */
function jsonAssignment(raw: string, name: 'fact' | 'preset'): unknown {
  // Parse syntax only. Never execute the page, including its inline scripts.
  const document = raw.trimStart().startsWith('<') ? load(raw) : null;
  const scripts = document ? document('script:not([src])').toArray().filter(node =>
    ['', 'text/javascript', 'application/javascript'].includes((document(node).attr('type') || '').trim().toLowerCase()))
    .map(node => document(node).html() || '') : [raw];
  const assignments: { script: string; node: any; topLevel: boolean }[] = [];
  for (const script of scripts) {
    const program = parse(script, { ecmaVersion: 'latest', sourceType: 'script' });
    const topLevel = new Set(program.body.filter(node => node.type === 'ExpressionStatement').map(node => (node as any).expression));
    const pending: any[] = [program];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression' &&
          !node.left.computed && node.left.object?.type === 'Identifier' && node.left.object.name === 'DisconSchedule' &&
          node.left.property?.type === 'Identifier' && node.left.property.name === name) {
        if (node.operator !== '=' || node.right?.type !== 'ObjectExpression') throw new Error('OEM_ASSIGNMENT_NOT_PLAIN_JSON');
        assignments.push({ script, node, topLevel: topLevel.has(node) });
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) pending.push(...value); else if (value && typeof value === 'object') pending.push(value);
    }
  }
  if (assignments.length !== 1 || !assignments[0].topLevel) throw new Error('OEM_ASSIGNMENT_MISSING_OR_AMBIGUOUS');
  const { script, node } = assignments[0];
  return JSON.parse(script.slice(node.right.start, node.right.end));
}

function publicationTime(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SOURCE_PUBLICATION_MISSING');
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) ((?:[01]\d|2[0-3])):([0-5]\d)$/.exec(value);
  if (!match) throw new Error('SOURCE_PUBLICATION_FORMAT');
  return wallMinuteInstant(`${match[3]}-${match[2]}-${match[1]}`, Number(match[4]) * 60 + Number(match[5]));
}
function midnightFromSeconds(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('INVALID_UNIX_SECONDS');
  const epoch = (value as number) * 1000;
  if (!Number.isFinite(epoch)) throw new Error('INVALID_UNIX_SECONDS');
  const date = localParts(epoch).date;
  if (dayBounds(date).start !== epoch) throw new Error('SOURCE_DATE_NOT_LOCAL_MIDNIGHT');
  return date;
}

/** Offline raw-response adapter. This parser does not grant reuse, address or delivery rights. */
export function normalizeHourMatrix(rawBody: string, context: HourMatrixContext): ScheduleView {
  const config = SOURCES[context.namespace];
  if (!config || config.operatorId !== context.operatorId || config.sourceId !== context.source.id) throw new Error('OPERATOR_NAMESPACE_MISMATCH');
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > 2_000_000) throw new Error('RAW_BODY_INVALID');
  const rawHash = hash(rawBody);
  if (context.source.revision !== rawHash) throw new Error('RAW_SOURCE_HASH_MISMATCH');
  if (!['catalog', 'schedule'].includes(context.source.verifiedLevel)) throw new Error('PARSER_CANNOT_CERTIFY_ADDRESS_OR_INTEGRATION');
  if (!validInstant(context.observedAt)) throw new Error('INVALID_OBSERVED_AT');
  if (!/^GPV[1-6]\.[12]$/.test(context.targetId)) throw new Error('TARGET_NOT_FOUND');
  const payload: unknown = context.namespace === 'dtek:oem'
    ? { fact: jsonAssignment(rawBody, 'fact'), preset: jsonAssignment(rawBody, 'preset') }
    : JSON.parse(rawBody);
  if (!record(payload) || !record(payload.fact) || !record(payload.preset)) throw new Error('SOURCE_MATRIX_MISSING');
  if (config.regionId && payload.regionId !== config.regionId) throw new Error('SOURCE_REGION_MISMATCH');
  const fact = payload.fact, preset = payload.preset;
  const sourceDay = midnightFromSeconds(fact.today);
  const bounds = dayBounds(context.serviceDate);
  if (![sourceDay, nextCalendarDate(sourceDay)].includes(context.serviceDate)) throw new Error('SERVICE_DATE_NOT_IN_SOURCE_SCOPE');
  if (bounds.minutes !== 1440) throw new Error('DST_HOUR_MATRIX_REQUIRES_OFFSET_POLICY');
  const key = String(bounds.start / 1000);
  if (!record(fact.data) || !Object.hasOwn(fact.data, key) || !record(fact.data[key])) throw new Error('SERVICE_DATE_NOT_IN_PAYLOAD');
  const day = fact.data[key];
  const hours = day[context.targetId];
  if (!Object.hasOwn(day, context.targetId) || !record(hours)) throw new Error('TARGET_NOT_FOUND');
  if (Object.keys(hours).length !== 24 || Array.from({ length: 24 }, (_, i) => String(i + 1)).some(k => !Object.hasOwn(hours, k))) throw new Error('INCOMPLETE_OR_UNKNOWN_HOUR_KEYS');
  const queueIds = Array.from({ length: 6 }, (_, i) => [`GPV${i + 1}.1`, `GPV${i + 1}.2`]).flat();
  if (Object.keys(day).length !== queueIds.length || queueIds.some(id => !Object.hasOwn(day, id))) throw new Error('INCOMPLETE_OR_UNKNOWN_QUEUE_TABLE');
  for (const group of Object.values(day)) {
    if (!record(group) || Object.keys(group).length !== 24 || Array.from({ length: 24 }, (_, i) => String(i + 1)).some(key => !Object.hasOwn(group, key))) throw new Error('INCOMPLETE_OR_UNKNOWN_HOUR_KEYS');
    const allowed = context.namespace === 'dtek:oem' ? Object.keys(OEM_LEGEND) : ['yes', 'no'];
    if (Object.values(group).some(value => typeof value !== 'string' || !allowed.includes(value))) throw new Error('UNKNOWN_PROVIDER_HOUR_ENUM');
  }
  if (context.namespace === 'dtek:oem') {
    const legend = preset.time_type, zones = preset.time_zone;
    if (!record(legend) || Object.keys(legend).length !== Object.keys(OEM_LEGEND).length ||
        Object.entries(OEM_LEGEND).some(([code, label]) => legend[code] !== label)) throw new Error('UNKNOWN_OEM_LEGEND');
    if (!record(zones) || Object.keys(zones).length !== 24) throw new Error('UNKNOWN_OEM_HOUR_LAYOUT');
    for (let i = 1; i <= 24; i++) {
      const zone = zones[String(i)];
      const a = `${String(i - 1).padStart(2, '0')}:00`, b = `${String(i).padStart(2, '0')}:00`;
      if (!Array.isArray(zone) || zone[1] !== a || zone[2] !== b) throw new Error('UNKNOWN_OEM_HOUR_LAYOUT');
    }
  }
  const publishedAt = publicationTime(fact.update);
  if (Date.parse(publishedAt) > Date.parse(context.observedAt)) throw new Error('SOURCE_PUBLICATION_AFTER_OBSERVATION');
  const intervals: PlanInterval[] = [];
  function append(startMinute: number, endMinute: number, kind: PlanInterval['kind']) {
    const startsAt = wallMinuteInstant(context.serviceDate, startMinute), endsAt = wallMinuteInstant(context.serviceDate, endMinute);
    const previous = intervals.at(-1);
    if (previous?.endsAt === startsAt && previous.kind === kind) { previous.endsAt = endsAt; previous.endLocal = endMinute === 1440 ? '24:00' : localParts(Date.parse(endsAt)).time; }
    else intervals.push({ startsAt, endsAt, startLocal: localParts(Date.parse(startsAt)).time,
      endLocal: endMinute === 1440 ? '24:00' : localParts(Date.parse(endsAt)).time, kind });
  }
  for (let hour = 1; hour <= 24; hour++) {
    const code = hours[String(hour)], a = (hour - 1) * 60;
    if (code === 'yes') continue;
    if (code === 'no') { append(a, a + 60, 'planned_outage'); continue; }
    // VOE's captured schema proves only yes/no. Its adapter does not borrow OEM's legend.
    if (context.namespace !== 'dtek:oem') throw new Error('UNKNOWN_VOE_HOUR_ENUM');
    switch (code) {
      case 'maybe': append(a, a + 60, 'possible_outage'); break;
      case 'first': append(a, a + 30, 'planned_outage'); break;
      case 'second': append(a + 30, a + 60, 'planned_outage'); break;
      case 'mfirst': append(a, a + 30, 'possible_outage'); break;
      case 'msecond': append(a + 30, a + 60, 'possible_outage'); break;
      default: throw new Error('UNKNOWN_OEM_HOUR_ENUM');
    }
  }
  const observationDate = localParts(Date.parse(context.observedAt)).date;
  const freshness = context.freshness === 'stale' || ![observationDate, nextCalendarDate(observationDate)].includes(context.serviceDate) ? 'stale' : context.freshness;
  // These observed formats have no independent published flag per day. An
  // entirely all-yes matrix (actual VOE tomorrow) can be an unpublished default.
  const anyPublishedOutage = Object.values(day).some(group => record(group) && Object.values(group).some(code =>
    code === 'no' || (context.namespace === 'dtek:oem' && ['maybe', 'first', 'second', 'mfirst', 'msecond'].includes(String(code)))));
  const unconfirmedEmpty = !intervals.length && !anyPublishedOutage;
  const view: ScheduleView = {
    contractVersion: 'lba-product/1', revisionId: `hour-matrix:${hash(JSON.stringify({ rawHash, namespace: context.namespace, target: context.targetId, date: context.serviceDate }))}`,
    addressId: context.addressId, addressLabel: context.addressLabel, localityLabel: context.localityLabel,
    operatorId: context.operatorId, namespace: config.targetNamespace, targetId: context.targetId,
    serviceDate: context.serviceDate, timezone: 'Europe/Kyiv',
    status: freshness === 'stale' ? 'stale' : unconfirmedEmpty ? 'not_published' : intervals.some(i => i.kind === 'planned_outage') ? 'published' : intervals.length ? 'possible' : 'no_planned_outages',
    dayCoverage: unconfirmedEmpty ? 'none' : 'complete', intervals, source: { ...context.source, revision: rawHash },
    publishedAt, observedAt: context.observedAt, freshness: unconfirmedEmpty && freshness !== 'stale' ? 'unknown' : freshness, synthetic: context.synthetic, deliveryEligible: false,
    notice: 'План технічної групи, не вимір фактичного живлення. Адресна прив’язка, регулярне використання джерела та доставка не сертифіковані.',
  };
  validateScheduleView(view); return view;
}
