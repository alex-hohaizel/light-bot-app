import { createHash } from 'node:crypto';
import { parseExpressionAt } from 'acorn';
import type { AddressBinding, AddressRecord, SourceReference } from '../../shared/product-contract.ts';
import { normalizeAddressText, normalizeHouse, parseStreetName, streetMatchesQuery, houseMatchesQuery } from '../../shared/address-index.ts';
import { localParts, validInstant } from '../../shared/schedule-core.ts';

const ORIGIN = 'https://app.yasno.ua';
const PREFIX = '/api/blackout-service/public/shutdowns/addresses/v2/';
const SOURCE = 'yasno-public-address-v2';
export interface YasnoKyivAddressScope {
  operatorId: 'dtek-kem'; namespace: 'yasno:25/902'; regionId: 25; dsoId: 902;
}
export const YASNO_KYIV_ADDRESS_SCOPE: YasnoKyivAddressScope = Object.freeze({ operatorId: 'dtek-kem', namespace: 'yasno:25/902', regionId: 25, dsoId: 902 });
export interface YasnoAddressCapture {
  sourceId: typeof SOURCE;
  method: 'GET'; url: string; httpStatus: 200; contentType: string;
  observedAt: string; rawBody: string; rawSha256: string;
}
export interface AddressCapturePolicy {
  /** Trusted collector clock and explicit local proof-age policy, not provider SLA. */
  asOf: string;
  maximumCaptureAgeMs: number;
}
export interface ProviderAddressItem { id: number; value: string }
export interface AddressCaptureProof {
  operation: 'streets' | 'houses' | 'group'; sourceId: typeof SOURCE;
  requestUrl: string; canonicalRequestUrl: string; observedAt: string; rawSha256: string;
}
export interface YasnoAddressCandidateInput {
  scope: YasnoKyivAddressScope;
  selection: { streetId: number; streetValue: string; houseId: number; houseLiteral: string; label?: string };
  captures: { streets: YasnoAddressCapture; houses: YasnoAddressCapture; group: YasnoAddressCapture };
  policy: AddressCapturePolicy;
}
export interface YasnoAddressCandidate {
  kind: 'yasno-address-candidate/1';
  address: AddressRecord;
  binding: AddressBinding;
  source: SourceReference;
  proof: {
    verdict: 'source_reported_binding_candidate';
    scope: YasnoKyivAddressScope;
    providerStreetId: number; providerStreetValue: string; streetTypeLiteral: string;
    providerHouseId: number; providerHouseLiteral: string;
    providerAddressId: string;
    canonicalMunicipalAddressId: null; katottg: null; connectionId: null;
    catalogCompleteness: 'unknown'; aliasesVerified: false;
    providerEffectiveRevision: null; validFrom: null; validUntil: null;
    clientRevisionMeaning: 'hash of exact selected provider scope and group response; not provider validity';
    observedAt: string; captures: AddressCaptureProof[];
    rightsForSystematicReuse: 'unknown'; independentlyConfirmed: false; deliveryEligible: false;
  };
}
function fail(code: string): never { throw new Error(`YASNO_ADDRESS_${code}`); }
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function clean(value: unknown, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return fail('INVALID_TEXT');
  try { normalizeAddressText(value); } catch { return fail('INVALID_TEXT'); }
  return value.normalize('NFC').trim();
}
function assertScope(scope: YasnoKyivAddressScope) {
  if (!scope || Object.keys(scope).length !== 4 || Object.keys(scope).some(key => !['operatorId', 'namespace', 'regionId', 'dsoId'].includes(key)) ||
      scope.operatorId !== 'dtek-kem' || scope.namespace !== 'yasno:25/902' || scope.regionId !== 25 || scope.dsoId !== 902) fail('OPERATOR_SCOPE_MISMATCH');
}
function parseUniqueJson(raw: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail('INVALID_SOURCE_JSON'); }
  // Bound depth before Acorn's recursive parser, including arrays the schema will
  // reject. Braces inside a quoted string do not count as structural nesting.
  let depth = 0, quoted = false, escaped = false;
  for (const c of raw) {
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') { if (++depth > 24) return fail('SOURCE_JSON_TOO_DEEP'); }
    else if (c === ']' || c === '}') depth--;
  }
  // JSON.parse alone silently keeps the final duplicate key. Ambiguous provider
  // fields are rejected; parsing an AST never executes the source.
  let ast: unknown; try { ast = parseExpressionAt(raw, 0, { ecmaVersion: 2022 }); } catch { return fail('INVALID_SOURCE_JSON'); }
  const pending: any[] = [ast]; let visited = 0;
  while (pending.length) {
    if (++visited > 30_000) return fail('SOURCE_JSON_TOO_COMPLEX');
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'ObjectExpression') {
      const keys = node.properties.map((property: any) => property.key.value);
      if (new Set(keys).size !== keys.length) fail('DUPLICATE_SOURCE_KEY');
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) pending.push(...value); else if (value && typeof value === 'object') pending.push(value);
  }
  return parsed;
}
function readCapture(capture: YasnoAddressCapture, operation: AddressCaptureProof['operation'], scope: YasnoKyivAddressScope,
  policy: AddressCapturePolicy, expected: { streetId?: number; houseId?: number } = {}) {
  assertScope(scope);
  if (!capture || capture.sourceId !== SOURCE || capture.method !== 'GET' || capture.httpStatus !== 200 ||
      typeof capture.contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(capture.contentType)) fail('SOURCE_ENVELOPE_MISMATCH');
  if (!validInstant(policy?.asOf) || !Number.isSafeInteger(policy.maximumCaptureAgeMs) || policy.maximumCaptureAgeMs < 1 || policy.maximumCaptureAgeMs > 86_400_000) fail('INVALID_CAPTURE_POLICY');
  if (!validInstant(capture.observedAt)) fail('INVALID_OBSERVATION');
  const age = Date.parse(policy.asOf) - Date.parse(capture.observedAt);
  if (age < 0 || age > policy.maximumCaptureAgeMs || localParts(Date.parse(policy.asOf)).date !== localParts(Date.parse(capture.observedAt)).date) fail('STALE_OR_FUTURE_CAPTURE');
  if (typeof capture.url !== 'string' || !capture.url.startsWith(`${ORIGIN}/`)) fail('UNTRUSTED_REQUEST_URL');
  let url: URL;
  try { url = new URL(capture.url); } catch { return fail('UNTRUSTED_REQUEST_URL'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.pathname !== `${PREFIX}${operation}`) fail('REQUEST_OPERATION_MISMATCH');
  const allowed = operation === 'streets' ? ['regionId', 'dsoId', 'query'] : operation === 'houses' ? ['regionId', 'dsoId', 'streetId', 'query'] : ['regionId', 'dsoId', 'streetId', 'houseId'];
  const keys = [...url.searchParams.keys()];
  if (keys.length !== allowed.length || new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) fail('REQUEST_FIELDS_MISMATCH');
  if (url.searchParams.get('regionId') !== '25' || url.searchParams.get('dsoId') !== '902') fail('OPERATOR_SCOPE_MISMATCH');
  if (expected.streetId !== undefined && url.searchParams.get('streetId') !== String(expected.streetId)) fail('STREET_REQUEST_SCOPE_MISMATCH');
  if (expected.houseId !== undefined && url.searchParams.get('houseId') !== String(expected.houseId)) fail('HOUSE_REQUEST_SCOPE_MISMATCH');
  const query = url.searchParams.get('query') || '';
  if (query.length > 100 || /[\u0000-\u001f\u007f]/.test(query) || (operation === 'streets' && normalizeAddressText(query).length < 2)) fail('INVALID_SOURCE_QUERY');
  if (typeof capture.rawBody !== 'string' || Buffer.byteLength(capture.rawBody) > 250_000 || typeof capture.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(capture.rawSha256) || sha(capture.rawBody) !== capture.rawSha256) fail('RAW_HASH_MISMATCH');
  const value = parseUniqueJson(capture.rawBody);
  url.searchParams.sort();
  const proof: AddressCaptureProof = { operation, sourceId: SOURCE, requestUrl: capture.url, canonicalRequestUrl: url.href, observedAt: capture.observedAt, rawSha256: capture.rawSha256 };
  return { value, proof, query };
}
function items(value: unknown): ProviderAddressItem[] {
  if (!Array.isArray(value) || value.length > 1000) return fail('UNKNOWN_CATALOG_SCHEMA');
  const result: ProviderAddressItem[] = [], ids = new Set<number>();
  for (const row of value) {
    if (!isObject(row) || Object.keys(row).length !== 2 || !Object.hasOwn(row, 'id') || !Object.hasOwn(row, 'value') || !positiveId(row.id)) fail('UNKNOWN_CATALOG_SCHEMA');
    const item = { id: row.id as number, value: clean(row.value) };
    if (ids.has(item.id)) fail('DUPLICATE_PROVIDER_ID');
    ids.add(item.id); result.push(item);
  }
  return result;
}
export function readYasnoStreetCandidates(capture: YasnoAddressCapture, policy: AddressCapturePolicy, scope = YASNO_KYIV_ADDRESS_SCOPE) {
  const read = readCapture(capture, 'streets', scope, policy);
  const catalog = items(read.value);
  if (catalog.some(row => !streetMatchesQuery(row.value, read.query))) fail('STREET_QUERY_RESPONSE_MISMATCH');
  return { scope: { ...scope }, items: catalog, proof: read.proof, catalogCompleteness: 'unknown' as const };
}
export function readYasnoHouseCandidates(capture: YasnoAddressCapture, streetId: number, policy: AddressCapturePolicy, scope = YASNO_KYIV_ADDRESS_SCOPE) {
  if (!positiveId(streetId)) fail('INVALID_STREET_ID');
  const read = readCapture(capture, 'houses', scope, policy, { streetId });
  const catalog = items(read.value), query = normalizeHouse(read.query);
  // Actual provider query1 also returns20/1А: its search is containment.
  // Selection below still requires the exact house ID and normalized literal.
  if (catalog.some(row => query && !normalizeHouse(row.value).includes(query))) fail('HOUSE_QUERY_RESPONSE_MISMATCH');
  return { scope: { ...scope }, streetId, items: catalog, proof: read.proof, catalogCompleteness: 'unknown' as const };
}

/** Pure candidate builder. A trusted collector supplies captures; this is not
 * transport authentication, consent, independent OSR QA or source admission. */
export function buildYasnoAddressCandidate(input: YasnoAddressCandidateInput): YasnoAddressCandidate {
  if (!isObject(input) || Object.keys(input).some(key => !['scope', 'selection', 'captures', 'policy'].includes(key)) ||
    !isObject(input.selection) || Object.keys(input.selection).some(key => !['streetId', 'streetValue', 'houseId', 'houseLiteral', 'label'].includes(key)) ||
    !isObject(input.captures) || Object.keys(input.captures).sort().join(',') !== 'group,houses,streets') fail('EXACT_SELECTION_REQUIRED');
  const { scope, selection, captures, policy } = input;
  assertScope(scope);
  if (!selection || !positiveId(selection.streetId) || !positiveId(selection.houseId)) fail('EXACT_SELECTION_REQUIRED');
  const selectedStreet = clean(selection.streetValue), selectedHouse = clean(selection.houseLiteral, 100);
  const streets = readYasnoStreetCandidates(captures.streets, policy, scope);
  const street = streets.items.find(row => row.id === selection.streetId);
  if (!street || parseStreetName(street.value).key !== parseStreetName(selectedStreet).key) fail('EXACT_STREET_SELECTION_REQUIRED');
  const streetType = parseStreetName(street.value).type;
  // Road is backed by the captured public Кільцева/985 chain (8 Nov).
  // Other kinds remain closed until an exact source example is checked.
  if (!['street', 'avenue', 'lane', 'road'].includes(streetType || '')) fail('UNSUPPORTED_SOURCE_STREET_TYPE');
  const type = /^(?:вулиця|вул|проспект|просп|пр-т|провулок|пров-к|пров|дорога)\.?/iu.exec(street.value)?.[0];
  if (!type) fail('UNSUPPORTED_SOURCE_STREET_TYPE');
  const houses = readYasnoHouseCandidates(captures.houses, street.id, policy, scope);
  const house = houses.items.find(row => row.id === selection.houseId);
  if (!house || normalizeHouse(house.value) !== normalizeHouse(selectedHouse)) fail('EXACT_HOUSE_SELECTION_REQUIRED');
  const group = readCapture(captures.group, 'group', scope, policy, { streetId: street.id, houseId: house.id });
  if (Date.parse(streets.proof.observedAt) > Date.parse(houses.proof.observedAt) || Date.parse(houses.proof.observedAt) > Date.parse(group.proof.observedAt)) fail('CAPTURE_CHAIN_REPLAY_OR_ORDER');
  if (!isObject(group.value) || Object.keys(group.value).length !== 2 || !Object.hasOwn(group.value, 'group') || !Object.hasOwn(group.value, 'subgroup') ||
      !Number.isInteger(group.value.group) || (group.value.group as number) < 1 || (group.value.group as number) > 60 || group.value.subgroup !== 1) fail('UNKNOWN_GROUP_ENUM');
  const targetId = `${group.value.group}.${group.value.subgroup}`;
  const providerAddressId = `${scope.namespace}:street:${street.id}:house:${house.id}`;
  const addressId = `provisional:${providerAddressId}`;
  const revision = sha(JSON.stringify({ operatorId: scope.operatorId, namespace: scope.namespace, regionId: scope.regionId, dsoId: scope.dsoId,
    streetId: street.id, streetValue: street.value, houseId: house.id, houseLiteral: house.value, targetId,
    captureChain: [streets.proof, houses.proof, group.proof].map(proof => ({ operation: proof.operation,
      request: proof.canonicalRequestUrl, response: proof.rawSha256 })) }));
  const letter = /^(\d+)\s*([а-яіїєґ])$/iu.exec(house.value);
  const address: AddressRecord = { id: addressId, label: selection.label === undefined ? 'Обрана адреса' : clean(selection.label, 60),
    territoryId: `source:${scope.namespace}`, locality: 'Київ', localityId: `source:${scope.namespace}:locality:kyiv`,
    street: street.value, streetId: `source:${scope.namespace}:street:${street.id}`,
    house: { number: letter?.[1] || house.value, ...(letter ? { letter: letter[2] } : {}), literal: house.value }, aliases: [] };
  const binding: AddressBinding = { addressId, operatorId: scope.operatorId, namespace: scope.namespace, targetId, kind: 'operator_group',
    revisionId: `yasno-address-candidate:${revision}`, status: 'needs_confirmation', verifiedAt: null, effectiveFrom: null, effectiveUntil: null };
  return { kind: 'yasno-address-candidate/1', address, binding,
    source: { id: SOURCE, name: 'YASNO · публічний адресний candidate', url: group.proof.requestUrl, revision, accessCost: 0, verifiedLevel: 'catalog' },
    proof: { verdict: 'source_reported_binding_candidate', scope: { ...scope }, providerStreetId: street.id, providerStreetValue: street.value,
      streetTypeLiteral: type, providerHouseId: house.id, providerHouseLiteral: house.value, providerAddressId,
      canonicalMunicipalAddressId: null, katottg: null, connectionId: null, catalogCompleteness: 'unknown', aliasesVerified: false,
      providerEffectiveRevision: null, validFrom: null, validUntil: null,
      clientRevisionMeaning: 'hash of exact selected provider scope and group response; not provider validity', observedAt: group.proof.observedAt,
      captures: [streets.proof, houses.proof, group.proof], rightsForSystematicReuse: 'unknown', independentlyConfirmed: false, deliveryEligible: false } };
}
