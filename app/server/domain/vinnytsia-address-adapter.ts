import { createHash } from 'node:crypto';
import { parseExpressionAt } from 'acorn';
import { load } from 'cheerio';
import type { PlanInterval } from '../../shared/product-contract.ts';
import { calendarDate, dayBounds, localParts, validInstant, wallMinuteInstant } from '../../shared/schedule-core.ts';

const AUTOCOMPLETE = 'https://disconnection.voe.com.ua/api/autocomplete.php';
const SEARCH = 'https://disconnection.voe.com.ua/api/search.php';
const EMERGENCY = 'https://voe.com.ua/disconnection/emergency';
const SOURCE = 'voe-disconnection-owner-snapshot';
/** Existing canonical scope from source-intake.ts; an operator identity, not source admission. */
export const VINNYTSIA_SCOPE = Object.freeze({ operatorId: 'vinnytsia-oe', namespace: 'voe:vinnytsia' } as const);
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export class VinnytsiaSourceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code === 'STALE_OR_FUTURE_INPUT' ? 'Ця копія даних застаріла або має некоректний час. Оновіть її.'
      : code.startsWith('EXACT_') || code === 'REQUEST_SELECTION_MISMATCH' ? 'Оберіть населений пункт, вулицю й будинок зі списку оператора.'
      : code === 'SERVICE_DATE_NOT_IN_PAYLOAD' ? 'У цій відповіді немає графіка на вибрану дату.'
      : code === 'SOURCE_APPLICATION_FALSE' || code === 'EMPTY_RESPONSE_NOT_DAY_PROOF' ? 'Оператор не повернув перевірений графік. Це не означає, що відключень немає.'
      : 'Не вдалося перевірити дані оператора. Спробуйте оновити їх пізніше.');
    this.name = 'VinnytsiaSourceError'; this.code = `VINNYTSIA_${code}`;
  }
}
function fail(code: string): never { throw new VinnytsiaSourceError(code); }
function keys(value: unknown, allowed: readonly string[], required = allowed): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('UNKNOWN_SOURCE_SCHEMA');
}
const privateIdentifier = /(?:62[A-Z0-9]{12,}|\b(?:EIC|account(?:_id|_number)?|csrf|sessionid|auth_token)\s*[:=]\s*\S+|(?:особов(?:ий|ого)\s+рахун(?:ок|ку)|о\/р)\s*[:№=]?\s*(?=[0-9A-Za-zА-Яа-яІіЇїЄєҐґ_-]*\d)[0-9A-Za-zА-Яа-яІіЇїЄєҐґ_-]{4,})/i;
function text(value: unknown, maximum = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) ||
      Buffer.from(value, 'utf8').toString('utf8') !== value || privateIdentifier.test(value)) return fail('INVALID_OR_PRIVATE_TEXT');
  return value;
}
function id(value: unknown): string {
  // IDs are opaque strings. Numeric spelling is the observed schema, never an integer conversion.
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return fail('UNKNOWN_PROVIDER_ID_FORMAT');
  return value;
}
function frozen<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const v of Object.values(value)) frozen(v); Object.freeze(value); }
  return value;
}
/** The existing YASNO strict-JSON method is private; reuse its Acorn boundary, not another schedule engine. */
function uniqueJson(raw: string): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 1_000_000) fail('RAW_BODY_LIMIT');
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return fail('INVALID_SOURCE_JSON'); }
  let depth = 0, quoted = false, escaped = false;
  for (const c of raw) {
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') { if (++depth > 20) fail('JSON_DEPTH_LIMIT'); }
    else if (c === ']' || c === '}') depth--;
  }
  let ast: unknown; try { ast = parseExpressionAt(raw, 0, { ecmaVersion: 2022 }); } catch { return fail('INVALID_SOURCE_JSON'); }
  const pending: any[] = [ast]; let visited = 0;
  while (pending.length) {
    if (++visited > 50_000) fail('JSON_COMPLEXITY_LIMIT');
    const node = pending.pop(); if (!node || typeof node !== 'object') continue;
    if (node.type === 'ObjectExpression') {
      const names = node.properties.map((p: any) => p.key.value);
      if (new Set(names).size !== names.length || names.some((k: unknown) => ['__proto__', 'constructor', 'prototype'].includes(String(k)))) fail('DUPLICATE_OR_UNSAFE_SOURCE_KEY');
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) pending.push(...child); else if (child && typeof child === 'object') pending.push(child);
  }
  const scan = [parsed]; let nodes = 0;
  while (scan.length) {
    if (++nodes > 20_000) fail('JSON_COMPLEXITY_LIMIT');
    const v = scan.pop();
    if (typeof v === 'string' && privateIdentifier.test(v)) fail('PRIVATE_SOURCE_TEXT_UNSUPPORTED');
    if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) { if (privateIdentifier.test(k)) fail('PRIVATE_SOURCE_TEXT_UNSUPPORTED'); scan.push(child); }
  }
  return parsed;
}

export interface VinnytsiaInputPolicy {
  asOf: string; maximumInputAgeMs: number;
  timezone: 'Europe/Kyiv'; timezoneProvenance: 'operator_geography_assumption_not_payload';
}
type ChoiceType = 'city' | 'street' | 'house';
interface SnapshotBase {
  kind: 'owner_browser_text_snapshot'; sourceId: typeof SOURCE;
  receivedAt: string; rawBody: string; rawSha256: string;
}
export interface VinnytsiaAutocompleteSnapshot extends SnapshotBase {
  request: { method: 'GET'; url: typeof AUTOCOMPLETE; operation: 'autocomplete'; query: { type: ChoiceType; q: string; ref: string } };
}
export interface VinnytsiaPublicAddressFields {
  type: 'address'; value: string;
  city_id: string; city_label: string; street_id: string; street_label: string; house_id: string; house_label: string;
}
export interface VinnytsiaScheduleSnapshot extends SnapshotBase {
  request: { method: 'POST'; url: typeof SEARCH; operation: 'address_schedule'; publicFields: VinnytsiaPublicAddressFields };
}
export interface VinnytsiaSnapshotProof {
  scope: typeof VINNYTSIA_SCOPE; sourceId: typeof SOURCE; operation: ChoiceType | 'address_schedule'; requestKey: string;
  receivedAt: string; rawTextSha256: string; rawRepresentation: 'decoded_owner_copy_response_text';
  queryProvenance: 'owner_or_caller_asserted_not_authenticated'; requestScopeEchoedByBody: false;
  nativeHttpStatusAndHeadersKnown: false; nativeTransportAuthenticated: false;
}
function age(receivedAt: string, policy: VinnytsiaInputPolicy) {
  keys(policy, ['asOf', 'maximumInputAgeMs', 'timezone', 'timezoneProvenance']);
  if (!validInstant(policy.asOf) || !validInstant(receivedAt) || !Number.isSafeInteger(policy.maximumInputAgeMs) ||
      policy.maximumInputAgeMs < 1 || policy.maximumInputAgeMs > 86_400_000 || policy.timezone !== 'Europe/Kyiv' ||
      policy.timezoneProvenance !== 'operator_geography_assumption_not_payload') fail('INVALID_INPUT_POLICY');
  const delta = Date.parse(policy.asOf) - Date.parse(receivedAt);
  if (delta < 0 || delta > policy.maximumInputAgeMs || localParts(Date.parse(policy.asOf)).date !== localParts(Date.parse(receivedAt)).date) fail('STALE_OR_FUTURE_INPUT');
}
function body(snapshot: SnapshotBase, policy: VinnytsiaInputPolicy) {
  keys(snapshot, ['kind', 'sourceId', 'receivedAt', 'rawBody', 'rawSha256', 'request']);
  if (snapshot.kind !== 'owner_browser_text_snapshot' || snapshot.sourceId !== SOURCE) fail('SNAPSHOT_PROVENANCE_MISMATCH');
  age(snapshot.receivedAt, policy);
  if (typeof snapshot.rawBody !== 'string' || typeof snapshot.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256) || sha(snapshot.rawBody) !== snapshot.rawSha256) fail('RAW_TEXT_HASH_MISMATCH');
  const parsed = uniqueJson(snapshot.rawBody);
  if (object(parsed) && parsed.ok === false) fail('SOURCE_APPLICATION_FALSE');
  return parsed;
}
function proof(snapshot: SnapshotBase, operation: VinnytsiaSnapshotProof['operation'], requestKey: string): VinnytsiaSnapshotProof {
  return { scope: VINNYTSIA_SCOPE, sourceId: SOURCE, operation, requestKey, receivedAt: snapshot.receivedAt, rawTextSha256: snapshot.rawSha256,
    rawRepresentation: 'decoded_owner_copy_response_text', queryProvenance: 'owner_or_caller_asserted_not_authenticated',
    requestScopeEchoedByBody: false, nativeHttpStatusAndHeadersKnown: false, nativeTransportAuthenticated: false };
}
export interface VinnytsiaChoice { id: string; label: string }
export function readVinnytsiaChoices(snapshot: VinnytsiaAutocompleteSnapshot, policy: VinnytsiaInputPolicy) {
  const parsed = body(snapshot, policy);
  keys(snapshot.request, ['method', 'url', 'operation', 'query']); keys(snapshot.request.query, ['type', 'q', 'ref']);
  const { request } = snapshot, query = request.query;
  if (request.method !== 'GET' || request.url !== AUTOCOMPLETE || request.operation !== 'autocomplete' || !['city', 'street', 'house'].includes(query.type)) fail('REQUEST_SCOPE_MISMATCH');
  const q = text(query.q, 100);
  if (q !== q.trim() || q.length < (query.type === 'house' ? 1 : 3) || (query.type === 'city' ? query.ref !== '' : id(query.ref) !== query.ref)) fail('INVALID_QUERY');
  keys(parsed, ['ok', 'items']);
  if (parsed.ok !== true || !Array.isArray(parsed.items) || parsed.items.length > 500) fail('UNKNOWN_CHOICE_SCHEMA');
  const seen = new Set<string>();
  const items = parsed.items.map(item => {
    keys(item, ['id', 'label']); const value = { id: id(item.id), label: text(item.label, 300) };
    if (seen.has(value.id)) fail('DUPLICATE_CHOICE_ID'); seen.add(value.id); return value;
  });
  return frozen({ scope: VINNYTSIA_SCOPE, type: query.type, parentRef: query.ref, items,
    completeness: 'unknown' as const, aliasesVerified: false as const,
    proof: proof(snapshot, query.type, sha(JSON.stringify(['GET', AUTOCOMPLETE, 'autocomplete', [['type', query.type], ['q', q], ['ref', query.ref]]]))) });
}

export interface VinnytsiaSelection {
  cityId: string; cityLabel: string; streetId: string; streetLabel: string; houseId: string; houseLabel: string;
}
export interface VinnytsiaSelectionInput {
  selection: VinnytsiaSelection;
  captures: { city: VinnytsiaAutocompleteSnapshot; street: VinnytsiaAutocompleteSnapshot; house: VinnytsiaAutocompleteSnapshot };
  policy: VinnytsiaInputPolicy;
}
function selectionFields(value: VinnytsiaSelection) {
  keys(value, ['cityId', 'cityLabel', 'streetId', 'streetLabel', 'houseId', 'houseLabel']);
  return { cityId: id(value.cityId), cityLabel: text(value.cityLabel), streetId: id(value.streetId), streetLabel: text(value.streetLabel), houseId: id(value.houseId), houseLabel: text(value.houseLabel, 100) };
}
export function buildVinnytsiaAddressSelection(input: VinnytsiaSelectionInput) {
  keys(input, ['selection', 'captures', 'policy']); keys(input.captures, ['city', 'street', 'house']);
  const selection = selectionFields(input.selection);
  const city = readVinnytsiaChoices(input.captures.city, input.policy), street = readVinnytsiaChoices(input.captures.street, input.policy), house = readVinnytsiaChoices(input.captures.house, input.policy);
  if (city.type !== 'city' || street.type !== 'street' || house.type !== 'house' || street.parentRef !== selection.cityId || house.parentRef !== selection.streetId) fail('REQUEST_PARENT_MISMATCH');
  for (const [choices, wantedId, wantedLabel] of [[city.items, selection.cityId, selection.cityLabel], [street.items, selection.streetId, selection.streetLabel], [house.items, selection.houseId, selection.houseLabel]] as const) {
    if (!choices.some(c => c.id === wantedId && c.label === wantedLabel)) fail('EXACT_SELECTION_REQUIRED');
  }
  if (Date.parse(city.proof.receivedAt) > Date.parse(street.proof.receivedAt) || Date.parse(street.proof.receivedAt) > Date.parse(house.proof.receivedAt)) fail('CAPTURE_CHAIN_ORDER');
  return frozen({ kind: 'vinnytsia-address-selection/1' as const, scope: VINNYTSIA_SCOPE, selection,
    provisionalId: `voe-address:${sha(JSON.stringify([selection.cityId, selection.streetId, selection.houseId]))}`,
    identifierMeaning: 'hash of exact provider ID tuple; not municipal identity or effective validity' as const,
    aliasVerification: 'none' as const, connectionId: null, physicalConnectionCount: null,
    proofs: [city.proof, street.proof, house.proof], sourceAdmission: false as const, deliveryEligible: false as const, independentlyConfirmed: false as const });
}

type ProviderStage = 'preliminary_or_possible' | 'operator_applied' | 'operator_completed';
export interface VinnytsiaProviderInterval {
  stage: ProviderStage; sourceType: 'confirm_2' | 'confirm_3' | 'confirm_4'; sourceLevel: 2 | 3 | 4;
  startsAt: string; endsAt: string; startLocal: string; endLocal: string;
  physicalPower: 'unknown'; stageCodeObservedInPinnedPayload: boolean;
}
export interface VinnytsiaOperatorMessage { type: number; title: string; plainText: string; emergencyLink: typeof EMERGENCY | null; physicalPower: 'unknown' }
function message(value: unknown): VinnytsiaOperatorMessage | null {
  if (value === null) return null;
  keys(value, ['type', 'title', 'text']);
  if (!Number.isInteger(value.type) || ![0, 1, 2, 3].includes(value.type as number)) fail('UNKNOWN_MESSAGE_TYPE');
  const title = text(value.title, 300), raw = text(value.text, 2_000);
  if (/[<>]/.test(title)) fail('MESSAGE_HTML_UNSUPPORTED');
  const $ = load(raw, {}, false); let hasEmergency = false;
  for (const el of $('*').toArray()) {
    if (el.type !== 'tag' || el.name !== 'a' || Object.keys(el.attribs).some(k => !['href', 'rel'].includes(k)) ||
        el.attribs.href !== EMERGENCY || el.attribs.rel !== 'noopener noreferrer') fail('MESSAGE_HTML_UNSUPPORTED');
    hasEmergency = true;
  }
  const plainText = $.root().text().replace(/\s+/g, ' ').trim();
  if (!plainText || privateIdentifier.test(plainText)) fail('INVALID_OR_PRIVATE_TEXT');
  return { type: value.type as number, title, plainText, emergencyLink: hasEmergency ? EMERGENCY : null, physicalPower: 'unknown' };
}
const stageMap = { confirm_2: 'preliminary_or_possible', confirm_3: 'operator_applied', confirm_4: 'operator_completed' } as const;
function clock(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }
function hourLabel(hour: number) { return `${String(hour).padStart(2, '0')}-${String(hour + 1).padStart(2, '0')}`; }
function sourceInterval(date: string, start: number, end: number, type: keyof typeof stageMap): VinnytsiaProviderInterval {
  try { return { stage: stageMap[type], sourceType: type, sourceLevel: Number(type.slice(-1)) as 2 | 3 | 4,
    startsAt: wallMinuteInstant(date, start), endsAt: wallMinuteInstant(date, end), startLocal: clock(start), endLocal: clock(end),
    physicalPower: 'unknown', stageCodeObservedInPinnedPayload: type !== 'confirm_4' }; }
  catch { return fail('AMBIGUOUS_OR_INVALID_LOCAL_TIME'); }
}
export interface VinnytsiaProviderDay {
  scope: typeof VINNYTSIA_SCOPE; queueId: string; serviceDate: string; timezone: 'Europe/Kyiv'; timezoneProvenance: 'operator_geography_assumption_not_payload';
  cellCoverage: '24_ordered_hour_cells'; sourcePublishedAt: null; publicationFreshness: 'unknown';
  intervals: VinnytsiaProviderInterval[]; possibleIntervals: PlanInterval[];
  operatorAppliedIntervals: VinnytsiaProviderInterval[]; operatorCompletedIntervals: VinnytsiaProviderInterval[];
  message: VinnytsiaOperatorMessage | null; unmarkedHourCells: number;
  unmarkedCellMeaning: 'no segment in this GPV response; not physical power or emergency clearance';
  physicalPower: 'unknown'; deliveryEligible: false; sourceAdmission: false;
}
function parseDay(table: Record<string, unknown>, row: unknown, date: string, policy: VinnytsiaInputPolicy): VinnytsiaProviderDay {
  keys(row, ['date', 'label', 'class', 'cells']);
  const label = `${['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][new Date(`${date}T12:00:00Z`).getUTCDay()]} ${date.slice(8, 10)}.${date.slice(5, 7)}`;
  if (row.date !== date || row.label !== label || row.class !== 'current_day' || date !== localParts(Date.parse(policy.asOf)).date) fail('ROW_DATE_OR_LABEL_MISMATCH');
  if (!Array.isArray(row.cells) || row.cells.length !== 24) fail('INCOMPLETE_HOUR_CELLS');
  try { if (dayBounds(date).minutes !== 1440) fail('DST_DAY_NOT_SUPPORTED_WITHOUT_OFFSET'); }
  catch { return fail('DST_DAY_NOT_SUPPORTED_WITHOUT_OFFSET'); }
  const slices: { start: number; end: number; type: keyof typeof stageMap }[] = []; let unmarked = 0;
  row.cells.forEach((cell, h) => {
    keys(cell, ['hour', 'segments', 'class']);
    if (cell.hour !== hourLabel(h) || !Array.isArray(cell.segments) || cell.segments.length > 60) fail('HOUR_CELL_MISMATCH');
    if (!cell.segments.length) { if (cell.class !== 'no_disconnection') fail('CELL_CLASS_CONFLICT'); unmarked++; return; }
    const local: typeof slices = [];
    for (const segment of cell.segments) {
      keys(segment, ['start', 'size', 'type', 'level', 'label']);
      if (!Object.hasOwn(stageMap, String(segment.type)) || typeof segment.type !== 'string' || segment.level !== Number(segment.type.slice(-1))) fail('UNKNOWN_PROVIDER_STAGE');
      const type = segment.type as keyof typeof stageMap;
      if (typeof segment.start !== 'number' || typeof segment.size !== 'number' || !Number.isFinite(segment.start) || !Number.isFinite(segment.size) ||
          segment.start < 0 || segment.start >= 100 || segment.size <= 0 || segment.size > 100 || segment.start + segment.size > 100) fail('INVALID_PERCENT_SEGMENT');
      const start = h * 60 + segment.start * 60 / 100, end = start + segment.size * 60 / 100;
      if (!Number.isInteger(start) || !Number.isInteger(end)) fail('FRACTIONAL_MINUTE_NOT_SUPPORTED');
      if (segment.label !== `${clock(start)}-${clock(end - 1)}`) fail('SEGMENT_LABEL_MISMATCH');
      local.push({ start, end, type });
    }
    if (new Set(local.map(x => x.type)).size !== 1 || cell.class !== `has_disconnection ${local[0].type}`) fail('CELL_CLASS_CONFLICT');
    local.sort((a, b) => a.start - b.start);
    for (let n = 1; n < local.length; n++) if (local[n].start < local[n - 1].end) fail('OVERLAPPING_PERCENT_SEGMENTS');
    slices.push(...local);
  });
  const merged: typeof slices = [];
  for (const slice of slices) { const previous = merged.at(-1); if (previous && previous.end === slice.start && previous.type === slice.type) previous.end = slice.end; else merged.push({ ...slice }); }
  const intervals = merged.map(s => sourceInterval(date, s.start, s.end, s.type));
  return { scope: VINNYTSIA_SCOPE, queueId: table.listnum as string, serviceDate: date, timezone: 'Europe/Kyiv', timezoneProvenance: policy.timezoneProvenance,
    cellCoverage: '24_ordered_hour_cells', sourcePublishedAt: null, publicationFreshness: 'unknown', intervals,
    possibleIntervals: intervals.filter(i => i.stage === 'preliminary_or_possible').map(i => ({ startsAt: i.startsAt, endsAt: i.endsAt, startLocal: i.startLocal, endLocal: i.endLocal, kind: 'possible_outage' })),
    operatorAppliedIntervals: intervals.filter(i => i.stage === 'operator_applied'), operatorCompletedIntervals: intervals.filter(i => i.stage === 'operator_completed'),
    message: message(table.message), unmarkedHourCells: unmarked, unmarkedCellMeaning: 'no segment in this GPV response; not physical power or emergency clearance',
    physicalPower: 'unknown', deliveryEligible: false, sourceAdmission: false };
}
export interface VinnytsiaScheduleInput { selectionInput: VinnytsiaSelectionInput; schedule: VinnytsiaScheduleSnapshot; serviceDate: string }
export function readVinnytsiaAddressSchedule(input: VinnytsiaScheduleInput) {
  keys(input, ['selectionInput', 'schedule', 'serviceDate']);
  const selected = buildVinnytsiaAddressSelection(input.selectionInput), policy = input.selectionInput.policy;
  let date: string; try { date = calendarDate(input.serviceDate); } catch { return fail('INVALID_SERVICE_DATE'); }
  const parsed = body(input.schedule, policy);
  keys(input.schedule.request, ['method', 'url', 'operation', 'publicFields']);
  const request = input.schedule.request;
  if (request.method !== 'POST' || request.url !== SEARCH || request.operation !== 'address_schedule') fail('REQUEST_SCOPE_MISMATCH');
  const fieldNames = ['type', 'value', 'city_id', 'city_label', 'street_id', 'street_label', 'house_id', 'house_label'] as const;
  keys(request.publicFields, fieldNames);
  const wanted: VinnytsiaPublicAddressFields = { type: 'address', value: selected.selection.houseId, city_id: selected.selection.cityId, city_label: selected.selection.cityLabel,
    street_id: selected.selection.streetId, street_label: selected.selection.streetLabel, house_id: selected.selection.houseId, house_label: selected.selection.houseLabel };
  if (fieldNames.some(k => request.publicFields[k] !== wanted[k])) fail('REQUEST_SELECTION_MISMATCH');
  if (Date.parse(selected.proofs[2].receivedAt) > Date.parse(input.schedule.receivedAt)) fail('CAPTURE_CHAIN_ORDER');
  keys(parsed, ['ok', 'type', 'addresses', 'tables']);
  if (parsed.ok !== true || parsed.type !== 'address') fail('UNKNOWN_SCHEDULE_SCHEMA');
  if (!Array.isArray(parsed.addresses) || parsed.addresses.length) fail('PRIVATE_ADDRESS_MAP_UNSUPPORTED');
  if (!Array.isArray(parsed.tables) || !parsed.tables.length || parsed.tables.length > 12) fail('EMPTY_RESPONSE_NOT_DAY_PROOF');
  const queueIds = new Set<string>(), days: VinnytsiaProviderDay[] = [];
  for (const table of parsed.tables) {
    keys(table, ['listnum', 'header', 'rows', 'message', 'reserve', 'empty']);
    if (typeof table.listnum !== 'string' || !/^[1-6]\.[12]$/.test(table.listnum) || queueIds.has(table.listnum)) fail('DUPLICATE_OR_UNKNOWN_QUEUE'); queueIds.add(table.listnum);
    if (table.reserve !== 0) fail('RESERVE_STATE_UNSUPPORTED');
    if (table.empty !== false || !Array.isArray(table.rows) || !table.rows.length) fail('EMPTY_RESPONSE_NOT_DAY_PROOF');
    const expectedHeader = ['Часові проміжки', ...Array.from({ length: 24 }, (_, h) => hourLabel(h))];
    if (!Array.isArray(table.header) || table.header.length !== 25 || table.header.some((value, n) => value !== expectedHeader[n])) fail('HOUR_HEADER_MISMATCH');
    if (table.rows.length > 7) fail('ROW_LIMIT');
    const rowDates = new Set<string>();
    for (const row of table.rows) {
      keys(row, ['date', 'label', 'class', 'cells']); let rowDate: string;
      try { rowDate = calendarDate(row.date as string); } catch { return fail('INVALID_SERVICE_DATE'); }
      if (rowDates.has(rowDate)) fail('DUPLICATE_SERVICE_DATE'); rowDates.add(rowDate);
      if (rowDate === date) days.push(parseDay(table, row, date, policy));
    }
  }
  if (!days.length) fail('SERVICE_DATE_NOT_IN_PAYLOAD');
  const requestKey = sha(JSON.stringify(['POST', SEARCH, 'address_schedule', fieldNames.map(k => [k, wanted[k]])]));
  return frozen({ kind: 'vinnytsia-address-schedule-candidate/1' as const, scope: VINNYTSIA_SCOPE, selection: selected,
    requestedServiceDate: date, receivedAt: input.schedule.receivedAt, days,
    queueChoices: [...queueIds].map(queueId => ({ queueId, serviceDateAvailable: days.some(day => day.queueId === queueId),
      status: queueIds.size > 1 ? 'ambiguous' as const : 'needs_confirmation' as const })),
    proof: proof(input.schedule, 'address_schedule', requestKey),
    bindingMeaning: 'operator queues reported for an owner-asserted request; body does not authenticate the address selection' as const,
    sourcePublishedAt: null, publicationFreshness: 'unknown' as const, connectionId: null, physicalConnectionCount: null,
    physicalPower: 'unknown' as const, independentlyConfirmed: false as const, sourceAdmission: false as const, deliveryEligible: false as const });
}
