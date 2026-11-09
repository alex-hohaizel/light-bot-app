import { createHash } from 'node:crypto';
import { parseExpressionAt } from 'acorn';
import type { AddressBinding, AddressRecord, ScheduleView, SourceReference } from '../../shared/product-contract.ts';
import { calendarDate, localParts, validInstant, wallMinuteInstant } from '../../shared/schedule-core.ts';
import { normalizeHourMatrix } from './hour-matrix-adapter.ts';

const AJAX = 'https://www.dtek-oem.com.ua/ua/ajax';
const PAGE = 'https://www.dtek-oem.com.ua/ua/shutdowns';
const SOURCE = 'dtek-oem-public-ajax';
export const ODESA_ADDRESS_ADAPTER_VERSION = 'odesa-house-report/3' as const;
export const ODESA_MAPPING_ADAPTER_VERSION = 'odesa-address-mapping/1' as const;
export type OdesaSelectionBasis = 'selected_query/1' | 'street_row/1';
export const ODESA_SCOPE = Object.freeze({ operatorId: 'dtek-oem', namespace: 'dtek:oem' } as const);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export class OdesaSourceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code === 'STALE_OR_FUTURE_CAPTURE' ? 'Дані оператора застаріли або мають некоректний час. Оновіть їх.'
      : code.startsWith('EXACT_') || code === 'REQUEST_SELECTION_MISMATCH' ? 'Оберіть населений пункт, вулицю й будинок з актуального списку оператора.'
      : code === 'SOURCE_APPLICATION_FALSE' ? 'Оператор не повернув дані. Спробуйте оновити їх пізніше.'
      : 'Не вдалося перевірити дані оператора. Спробуйте оновити їх пізніше.');
    this.name = 'OdesaSourceError'; this.code = `ODESA_${code}`;
  }
}
function fail(code: string): never { throw new OdesaSourceError(code); }
function keys(value: unknown, allowed: readonly string[], required = allowed): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('UNKNOWN_SOURCE_SCHEMA');
}
function literal(value: unknown, maximum = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) ||
      Buffer.from(value, 'utf8').toString('utf8') !== value) return fail('INVALID_LITERAL');
  // Provider labels are opaque keys, not normalized municipal identities.
  return value;
}
function uniqueJson(raw: string): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2_000_000) fail('RAW_BODY_LIMIT');
  let value: unknown; try { value = JSON.parse(raw); } catch { return fail('INVALID_JSON'); }
  let depth = 0, quoted = false, escaped = false;
  for (const c of raw) {
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') { if (++depth > 24) fail('JSON_DEPTH_LIMIT'); }
    else if (c === ']' || c === '}') depth--;
  }
  let ast: unknown; try { ast = parseExpressionAt(raw, 0, { ecmaVersion: 2022 }); } catch { return fail('INVALID_JSON'); }
  const pending: any[] = [ast]; let count = 0;
  while (pending.length) {
    if (++count > 100_000) fail('JSON_COMPLEXITY_LIMIT');
    const node = pending.pop(); if (!node || typeof node !== 'object') continue;
    if (node.type === 'ObjectExpression') {
      const names = node.properties.map((p: any) => p.key.value);
      if (new Set(names).size !== names.length || names.some((k: unknown) => ['__proto__', 'constructor', 'prototype'].includes(String(k)))) fail('DUPLICATE_OR_UNSAFE_SOURCE_KEY');
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) pending.push(...child); else if (child && typeof child === 'object') pending.push(child);
  }
  return value;
}

export interface OdesaCapturePolicy { asOf: string; maximumCaptureAgeMs: number }
export interface OdesaAjaxCapture {
  sourceId: typeof SOURCE; operation: 'getStreets' | 'getHomeNum'; method: 'POST'; url: typeof AJAX;
  httpStatus: 200; contentType: string; observedAt: string; rawBody: string; rawSha256: string;
  /** Public business fields only. Never persist guest cookies or the CSRF nonce here. */
  request: {} | { city: string; street: string; house_num: string; updateFact: string };
}
export interface OdesaCaptureProof {
  sourceId: typeof SOURCE; operation: 'getStreets' | 'getHomeNum'; requestUrl: typeof AJAX;
  request: OdesaAjaxCapture['request']; observedAt: string; rawSha256: string;
  queryProvenance: 'collector_supplied_not_authenticated_by_adapter'; requestScopeEchoedBySource: false;
  transportAuthenticatedByAdapter: false;
}
function assertAge(observedAt: string, policy: OdesaCapturePolicy) {
  keys(policy, ['asOf', 'maximumCaptureAgeMs']);
  if (!validInstant(policy.asOf) || !Number.isSafeInteger(policy.maximumCaptureAgeMs) || policy.maximumCaptureAgeMs < 1 || policy.maximumCaptureAgeMs > 86_400_000 || !validInstant(observedAt)) fail('INVALID_CAPTURE_POLICY');
  const age = Date.parse(policy.asOf) - Date.parse(observedAt);
  if (age < 0 || age > policy.maximumCaptureAgeMs || localParts(Date.parse(policy.asOf)).date !== localParts(Date.parse(observedAt)).date) fail('STALE_OR_FUTURE_CAPTURE');
}
function capture(value: OdesaAjaxCapture, operation: OdesaAjaxCapture['operation'], policy: OdesaCapturePolicy,
  selection?: { city: string; street: string; house: string }) {
  keys(value, ['sourceId', 'operation', 'method', 'url', 'httpStatus', 'contentType', 'observedAt', 'rawBody', 'rawSha256', 'request']);
  if (value.sourceId !== SOURCE || value.operation !== operation || value.method !== 'POST' || value.url !== AJAX || value.httpStatus !== 200 ||
      typeof value.contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(value.contentType)) fail('CAPTURE_SCOPE_MISMATCH');
  assertAge(value.observedAt, policy);
  if (typeof value.rawBody !== 'string' || Buffer.byteLength(value.rawBody, 'utf8') > 2_000_000) fail('RAW_BODY_LIMIT');
  if (typeof value.rawBody !== 'string' || typeof value.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.rawSha256) || hash(value.rawBody) !== value.rawSha256) fail('RAW_HASH_MISMATCH');
  if (operation === 'getStreets') keys(value.request, []);
  else {
    keys(value.request, ['city', 'street', 'house_num', 'updateFact']);
    literal(value.request.city); literal(value.request.street);
    if (typeof value.request.house_num !== 'string' || value.request.house_num.length > 100 || /[\u0000-\u001f\u007f]/.test(value.request.house_num) ||
        typeof value.request.updateFact !== 'string' || value.request.updateFact.length > 40) fail('INVALID_REQUEST');
    if (value.request.updateFact !== '') {
      const publication = /^(\d{2}\.\d{2}\.\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(value.request.updateFact);
      if (!publication) fail('INVALID_REQUEST');
      houseInstant(`${publication[2]}:${publication[3]} ${publication[1]}`);
    }
    if (!selection || value.request.city !== selection.city || value.request.street !== selection.street || value.request.house_num !== selection.house) fail('REQUEST_SELECTION_MISMATCH');
  }
  const parsed = uniqueJson(value.rawBody);
  if (object(parsed) && parsed.result === false) fail('SOURCE_APPLICATION_FALSE');
  const proof: OdesaCaptureProof = { sourceId: SOURCE, operation, requestUrl: AJAX, request: { ...value.request }, observedAt: value.observedAt, rawSha256: value.rawSha256,
    queryProvenance: 'collector_supplied_not_authenticated_by_adapter', requestScopeEchoedBySource: false, transportAuthenticatedByAdapter: false };
  return { value: parsed, proof };
}
export interface OdesaStreetCatalog {
  scope: typeof ODESA_SCOPE; revisionId: string; proof: OdesaCaptureProof;
  localities: { key: string; streets: string[] }[];
  completeness: 'unknown'; aliasesVerified: false;
}
export function readOdesaStreetCatalog(raw: OdesaAjaxCapture, policy: OdesaCapturePolicy): OdesaStreetCatalog {
  const read = capture(raw, 'getStreets', policy); keys(read.value, ['result', 'streets']);
  if (read.value.result !== true || !object(read.value.streets) || !Object.keys(read.value.streets).length || Object.keys(read.value.streets).length > 10_000) fail('UNKNOWN_CATALOG_SCHEMA');
  let total = 0;
  const localities = Object.entries(read.value.streets).map(([city, values]) => {
    literal(city);
    if (!Array.isArray(values) || values.length > 20_000 || new Set(values).size !== values.length) fail('DUPLICATE_OR_UNKNOWN_STREET_KEYS');
    if ((total += values.length) > 100_000) fail('CATALOG_COMPLEXITY_LIMIT');
    return { key: city, streets: values.map(s => literal(s)) };
  });
  return { scope: ODESA_SCOPE, revisionId: `odesa-streets:${raw.rawSha256}`, localities, proof: read.proof, completeness: 'unknown', aliasesVerified: false };
}

const HOUSE_KEYS = ['sub_type', 'start_date', 'end_date', 'type', 'sub_type_reason', 'voluntarily', 'cek'] as const;
const FLAGS = ['showCurOutageParam', 'showCurSchedule', 'showTableSchedule', 'showTablePlan', 'showTableFact', 'showUserGroup'] as const;
type HouseReport = Pick<OdesaOperatorHouseNotice, 'state' | 'reportKind' | 'reportIssue' | 'groupPlanAdvisory' | 'window'>;
interface HouseRow { sub_type: string; start_date: string; end_date: string; type: string; sub_type_reason: string[]; voluntarily: null; cek: null; report: HouseReport }
interface HousesResponse { result: true; data: Record<string, HouseRow>; updateTimestamp: string; flags: Record<typeof FLAGS[number], boolean> }
const STABILIZATION = 'Стабілізаційне відключення (Згідно графіку погодинних відключень)';
const EMERGENCY = 'Екстренні відключення (Аварійне без застосування графіку погодинних відключень)';
/** Lexical conversion only; shared IANA helper supplies all calendar/DST rules. */
function houseInstant(raw: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d) (\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  if (!m) return fail('UNKNOWN_HOUSE_TIME_FORMAT');
  try { return wallMinuteInstant(calendarDate(`${m[5]}-${m[4]}-${m[3]}`), Number(m[1]) * 60 + Number(m[2])); }
  catch { return fail('INVALID_OR_AMBIGUOUS_HOUSE_TIME'); }
}
function houseReport(row: Omit<HouseRow, 'report'>, observedAt: string): HouseReport {
  const unverified = (reportIssue: NonNullable<HouseReport['reportIssue']>): HouseReport =>
    ({ state: 'unverified_report', reportKind: 'unverified', reportIssue, groupPlanAdvisory: 'house_report_unverified' });
  if (row.type === '') return row.sub_type === '' && row.start_date === '' && row.end_date === ''
    ? { state: 'not_reported', reportKind: 'not_reported', reportIssue: null, groupPlanAdvisory: 'none' }
    : unverified('conflicting_report_fields');
  if (row.type !== '2' || ![STABILIZATION, EMERGENCY].includes(row.sub_type)) return unverified('unknown_report_type');
  if (!row.start_date || !row.end_date) return unverified('missing_report_time');
  // A malformed notice belongs to this house, not another house's address
  // binding. Unknown current state never becomes a successful power-on claim.
  let start: string, end: string;
  try {
    start = houseInstant(row.start_date); end = houseInstant(row.end_date);
    if (Date.parse(end) <= Date.parse(start)) return unverified('invalid_report_time');
  } catch (error) { if (error instanceof OdesaSourceError) return unverified('invalid_report_time'); throw error; }
  const now = Date.parse(observedAt);
  return { state: 'operator_reported_window', reportKind: row.sub_type === EMERGENCY ? 'emergency' : 'stabilization',
    reportIssue: null, groupPlanAdvisory: row.sub_type === EMERGENCY ? 'operator_reports_schedule_not_applicable' : 'none',
    window: { startsAt: start, estimatedEndsAt: end, startLocal: localParts(Date.parse(start)).time,
      estimatedEndLocal: localParts(Date.parse(end)).time,
      phaseAtObservation: now < Date.parse(start) ? 'before_reported_window' : now < Date.parse(end) ? 'during_reported_window' : 'past_estimate', endIsEstimate: true } };
}
function houses(value: unknown, observedAt: string): HousesResponse {
  keys(value, ['result', 'data', ...FLAGS, 'updateTimestamp']);
  if (value.result !== true || !object(value.data) || Object.keys(value.data).length > 20_000 || FLAGS.some(f => typeof value[f] !== 'boolean')) fail('UNKNOWN_HOUSE_SCHEMA');
  const updatedAt = houseInstant(literal(value.updateTimestamp, 40));
  if (Date.parse(updatedAt) > Date.parse(observedAt)) fail('HOUSE_UPDATE_AFTER_OBSERVATION');
  const result: Record<string, HouseRow> = Object.create(null);
  for (const [name, row] of Object.entries(value.data)) {
    literal(name, 100); keys(row, HOUSE_KEYS);
    if (typeof row.type !== 'string' || row.type.length > 20 || row.voluntarily !== null || row.cek !== null ||
        !Array.isArray(row.sub_type_reason) || !row.sub_type_reason.length || row.sub_type_reason.length > 12 ||
        row.sub_type_reason.some(g => typeof g !== 'string' || !/^GPV[1-6]\.[12]$/.test(g)) || new Set(row.sub_type_reason).size !== row.sub_type_reason.length) fail('UNKNOWN_HOUSE_OR_GROUP_ENUM');
    for (const [field, max] of [['type',20],['sub_type',500],['start_date',40],['end_date',40]] as const)
      if (typeof row[field] !== 'string' || row[field].length > max || /[\u0000-\u001f\u007f]/.test(row[field]) || Buffer.from(row[field]).toString('utf8') !== row[field]) fail('UNKNOWN_HOUSE_SCHEMA');
    const raw: Omit<HouseRow, 'report'> = { sub_type: row.sub_type as string, start_date: row.start_date as string, end_date: row.end_date as string,
      type: row.type, sub_type_reason: [...row.sub_type_reason] as string[], voluntarily: null, cek: null };
    result[name] = { ...raw, report: houseReport(raw, observedAt) };
  }
  return { result: true, data: result, updateTimestamp: value.updateTimestamp as string, flags: Object.fromEntries(FLAGS.map(f => [f, value[f]])) as HousesResponse['flags'] };
}
export function readOdesaHouseChoices(raw: OdesaAjaxCapture, catalog: OdesaAjaxCapture,
  selection: { city: string; street: string }, policy: OdesaCapturePolicy) {
  keys(selection, ['city', 'street']);
  literal(selection.city); literal(selection.street);
  const streets = readOdesaStreetCatalog(catalog, policy), city = streets.localities.find(c => c.key === selection.city);
  if (!city || !city.streets.includes(selection.street)) fail('EXACT_STREET_REQUIRED');
  const read = capture(raw, 'getHomeNum', policy, { ...selection, house: '' });
  if (Date.parse(streets.proof.observedAt) > Date.parse(read.proof.observedAt)) fail('CAPTURE_CHAIN_ORDER');
  const response = houses(read.value, raw.observedAt);
  return { scope: ODESA_SCOPE, cityKey: selection.city, streetKey: selection.street,
    choices: Object.entries(response.data).map(([key, row]) => ({ key, groups: [...row.sub_type_reason],
      reportState: row.report.state, reportKind: row.report.reportKind, reportIssue: row.report.reportIssue })), proof: read.proof, completeness: 'unknown' as const };
}
export interface OdesaOperatorHouseNotice {
  scope: 'provider_house_record'; state: 'operator_reported_window' | 'not_reported' | 'unverified_report';
  reportKind: 'stabilization' | 'emergency' | 'not_reported' | 'unverified';
  reportIssue: 'unknown_report_type' | 'conflicting_report_fields' | 'missing_report_time' | 'invalid_report_time' | null;
  groupPlanAdvisory: 'none' | 'operator_reports_schedule_not_applicable' | 'house_report_unverified';
  sourceUpdatedAt: string; observedAt: string; providerDisplayEnabled: boolean; physicalPower: 'unknown';
  window?: { startsAt: string; estimatedEndsAt: string; startLocal: string; estimatedEndLocal: string;
    phaseAtObservation: 'before_reported_window' | 'during_reported_window' | 'past_estimate'; endIsEstimate: true };
}
export interface OdesaAddressCandidate {
  kind: 'odesa-address-candidate/3'; address: AddressRecord; bindingChoices: AddressBinding[];
  mappingFingerprint: string; reportRevisionId: string; evidenceRevisionId: string;
  selectionState: 'source_reported' | 'multiple_groups'; providerKeys: { city: string; street: string; house: string };
  operatorNotice: OdesaOperatorHouseNotice; source: SourceReference;
  proof: { kind: 'odesa-address-proof/3'; adapterVersion: typeof ODESA_ADDRESS_ADAPTER_VERSION;
    mappingAdapterVersion: typeof ODESA_MAPPING_ADAPTER_VERSION; selectionBasis: OdesaSelectionBasis;
    houseGroupEvidence: 'same_captured_street_row' | 'selected_query_compared_with_street_row';
    verdict: 'source_reported_binding_candidate'; scope: typeof ODESA_SCOPE; captures: OdesaCaptureProof[];
    observedAt: string; connectionId: null; physicalConnectionCount: null; municipalAddressId: null;
    providerEffectiveRevision: null; aliasesVerified: false; catalogCompleteness: 'unknown';
    identifierMeaning: 'hash of exact opaque provider labels; not a municipal ID or rename equivalence';
    rightsForSystematicReuse: 'unknown'; independentlyConfirmed: false; deliveryEligible: false };
}
export interface OdesaCandidateInput {
  selection: { city: string; street: string; house: string; label?: string };
  captures: { catalog: OdesaAjaxCapture; houses: OdesaAjaxCapture; selectedHouse: OdesaAjaxCapture }; policy: OdesaCapturePolicy;
}
export interface OdesaStreetRowInput {
  basis: 'street_row/1'; selection: OdesaCandidateInput['selection'];
  captures: { catalog: OdesaAjaxCapture; houses: OdesaAjaxCapture }; policy: OdesaCapturePolicy;
}
/** Legacy selected-query basis requires the real matching selected capture. */
export function buildOdesaAddressCandidate(input: OdesaCandidateInput): OdesaAddressCandidate {
  keys(input, ['selection', 'captures', 'policy']); validateSelection(input.selection);
  keys(input.captures, ['catalog', 'houses', 'selectedHouse']);
  const { selection, captures, policy } = input;
  const { city, street, house } = selection;
  const available = readOdesaHouseChoices(captures.houses, captures.catalog, { city, street }, policy);
  if (!available.choices.some(c => c.key === house)) fail('EXACT_HOUSE_REQUIRED');
  const selected = capture(captures.selectedHouse, 'getHomeNum', policy, { city, street, house });
  if (Date.parse(available.proof.observedAt) > Date.parse(selected.proof.observedAt)) fail('CAPTURE_CHAIN_ORDER');
  const response = houses(selected.value, captures.selectedHouse.observedAt), row = response.data[house];
  if (!row) fail('EXACT_HOUSE_REQUIRED');
  const previous = available.choices.find(c => c.key === house)!;
  if (JSON.stringify([...previous.groups].sort()) !== JSON.stringify([...row.sub_type_reason].sort())) fail('HOUSE_GROUP_CHANGED_DURING_SELECTION');
  return candidateFromRecord(selection, response, row,
    [readOdesaStreetCatalog(captures.catalog, policy).proof, available.proof, selected.proof], 'selected_query/1');
}
/** One real full-street body establishes both house membership and its groups.
 * Missing membership means this dataset cannot verify it, never nonexistence.
 */
export function buildOdesaStreetRowCandidate(input: OdesaStreetRowInput): OdesaAddressCandidate {
  keys(input, ['basis', 'selection', 'captures', 'policy']); validateSelection(input.selection);
  if (input.basis !== 'street_row/1') fail('UNKNOWN_SELECTION_BASIS');
  keys(input.captures, ['catalog', 'houses']);
  const { selection, captures, policy } = input, { city, street, house } = selection;
  const available = readOdesaHouseChoices(captures.houses, captures.catalog, { city, street }, policy);
  const read = capture(captures.houses, 'getHomeNum', policy, { city, street, house: '' });
  const response = houses(read.value, captures.houses.observedAt), row = response.data[house];
  if (!row) fail('EXACT_HOUSE_REQUIRED');
  return candidateFromRecord(selection, response, row,
    [readOdesaStreetCatalog(captures.catalog, policy).proof, available.proof], 'street_row/1');
}
function validateSelection(selection: OdesaCandidateInput['selection']) {
  keys(selection, ['city', 'street', 'house', 'label'], ['city', 'street', 'house']);
  literal(selection.city); literal(selection.street); literal(selection.house, 100);
  if (selection.label !== undefined) literal(selection.label, 60);
}
function candidateFromRecord(selection: OdesaCandidateInput['selection'], response: HousesResponse,
  row: HouseRow, proofs: OdesaCaptureProof[], basis: OdesaSelectionBasis): OdesaAddressCandidate {
  const { city, street, house } = selection;
  const mappingFingerprint = hash(JSON.stringify({ mappingAdapterVersion: ODESA_MAPPING_ADAPTER_VERSION,
    ...ODESA_SCOPE, city, street, house, groups: [...row.sub_type_reason].sort() }));
  const observedAt = proofs.at(-1)!.observedAt, updatedAt = houseInstant(response.updateTimestamp);
  const operatorNotice: OdesaOperatorHouseNotice = { scope: 'provider_house_record', ...row.report,
    sourceUpdatedAt: updatedAt, observedAt, providerDisplayEnabled: response.flags.showCurOutageParam, physicalPower: 'unknown' };
  const revision = hash(JSON.stringify({ adapterVersion: ODESA_ADDRESS_ADAPTER_VERSION, basis, city, street, house,
    captures: proofs.map(p => [p.operation, p.request, p.rawSha256, p.observedAt]) }));
  const evidenceRevisionId = 'odesa-address-evidence:' + revision;
  const reportRevisionId = 'odesa-house-report:' + hash(JSON.stringify({ adapterVersion: ODESA_ADDRESS_ADAPTER_VERSION,
    ...ODESA_SCOPE, city, street, house, operatorNotice }));
  const addressId = 'provisional:dtek:oem:' + hash(JSON.stringify([city, street, house]));
  const address: AddressRecord = { id: addressId, label: selection.label === undefined ? 'Обрана адреса' : selection.label,
    territoryId: 'source:dtek:oem', locality: city, localityId: 'source:dtek:oem:locality:' + hash(city),
    street, streetId: 'source:dtek:oem:street:' + hash(JSON.stringify([city, street])), house: { number: house, literal: house }, aliases: [] };
  const bindingChoices = row.sub_type_reason.map(targetId => ({ addressId, ...ODESA_SCOPE, targetId, kind: 'operator_group' as const,
    revisionId: 'odesa-address-mapping:' + mappingFingerprint, status: row.sub_type_reason.length > 1 ? 'ambiguous' as const : 'needs_confirmation' as const,
    verifiedAt: null, effectiveFrom: null, effectiveUntil: null }));
  return { kind: 'odesa-address-candidate/3', address, bindingChoices, mappingFingerprint, reportRevisionId, evidenceRevisionId,
    providerKeys: { city, street, house }, selectionState: bindingChoices.length > 1 ? 'multiple_groups' : 'source_reported', operatorNotice,
    source: { id: SOURCE, name: 'ДТЕК Одеські електромережі · адресний пошук', url: AJAX, revision, accessCost: 0, verifiedLevel: 'catalog' },
    proof: { kind: 'odesa-address-proof/3', adapterVersion: ODESA_ADDRESS_ADAPTER_VERSION,
      mappingAdapterVersion: ODESA_MAPPING_ADAPTER_VERSION, selectionBasis: basis,
      houseGroupEvidence: basis === 'street_row/1' ? 'same_captured_street_row' : 'selected_query_compared_with_street_row',
      verdict: 'source_reported_binding_candidate', scope: ODESA_SCOPE, captures: proofs, observedAt,
      connectionId: null, physicalConnectionCount: null, municipalAddressId: null, providerEffectiveRevision: null,
      aliasesVerified: false, catalogCompleteness: 'unknown', identifierMeaning: 'hash of exact opaque provider labels; not a municipal ID or rename equivalence',
      rightsForSystematicReuse: 'unknown', independentlyConfirmed: false, deliveryEligible: false } };
}

/** Public extracted objects are retained; the complete original page was not.
 * The derived parser input is explicitly hashed separately from the native HTML.
 */
export interface OdesaBootstrapProjection {
  pageUrl: typeof PAGE; observedAt: string; nativeBodySha256: string; nativeBodyRetained: false;
  extraction: 'public_bootstrap_fact_preset'; factBody: string; factSha256: string; presetBody: string; presetSha256: string;
}
export function readOdesaGroupPlan(capture: OdesaBootstrapProjection, selectionInput: Omit<OdesaCandidateInput, 'policy'>,
  targetId: string, serviceDate: string, policy: OdesaCapturePolicy): { view: ScheduleView; proof: {
    extraction: OdesaBootstrapProjection['extraction']; nativeBodySha256: string; nativeBodyIndependentlyReverified: false;
    nativeBodyHashProvenance: 'collector_asserted_original_body_not_retained';
    factSha256: string; presetSha256: string; derivedParserInputSha256: string; addressRevisionId: string;
    transportAuthenticatedByAdapter: false } } {
  keys(capture, ['pageUrl', 'observedAt', 'nativeBodySha256', 'nativeBodyRetained', 'extraction', 'factBody', 'factSha256', 'presetBody', 'presetSha256']);
  if (capture.pageUrl !== PAGE || capture.nativeBodyRetained !== false || capture.extraction !== 'public_bootstrap_fact_preset' || !/^[a-f0-9]{64}$/.test(capture.nativeBodySha256)) fail('BOOTSTRAP_SCOPE_MISMATCH');
  assertAge(capture.observedAt, policy);
  keys(selectionInput, ['selection', 'captures']);
  // Rebuild from captures under this single clock policy, never trust a mutable
  // caller-created candidate or a status/target added after address selection.
  const candidate = buildOdesaAddressCandidate({ ...selectionInput, policy });
  if (!candidate.bindingChoices.some(b => b.targetId === targetId)) fail('EXACT_GROUP_REQUIRED');
  for (const [body, digest] of [[capture.factBody, capture.factSha256], [capture.presetBody, capture.presetSha256]]) {
    if (typeof body !== 'string' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || hash(body) !== digest || !object(uniqueJson(body))) fail('BOOTSTRAP_PROJECTION_HASH_MISMATCH');
  }
  // Parse and serialize JSON only; no publisher JavaScript is ever executed.
  const raw = `DisconSchedule.fact = ${JSON.stringify(uniqueJson(capture.factBody))};\nDisconSchedule.preset = ${JSON.stringify(uniqueJson(capture.presetBody))};`;
  const digest = hash(raw);
  let view: ScheduleView;
  try {
    view = normalizeHourMatrix(raw, { ...ODESA_SCOPE, targetId, addressId: candidate.address.id, addressLabel: candidate.address.label,
      localityLabel: candidate.address.locality, serviceDate, observedAt: capture.observedAt,
      source: { id: 'dtek-oem-official', name: 'ДТЕК Одеські електромережі · план групи', url: PAGE, revision: digest, accessCost: 0, verifiedLevel: 'schedule' },
      freshness: 'current', synthetic: false });
  } catch { return fail('GROUP_PLAN_REJECTED'); }
  return { view, proof: { extraction: capture.extraction, nativeBodySha256: capture.nativeBodySha256, nativeBodyIndependentlyReverified: false,
    nativeBodyHashProvenance: 'collector_asserted_original_body_not_retained',
    factSha256: capture.factSha256, presetSha256: capture.presetSha256, derivedParserInputSha256: digest,
    addressRevisionId: `odesa-address-candidate:${candidate.source.revision}`, transportAuthenticatedByAdapter: false } };
}
