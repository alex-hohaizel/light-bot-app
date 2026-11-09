import type { AddressRecord } from './product-contract.ts';

export interface AddressSearch {
  territoryId: string;
  locality: string;
  /** Stable catalog identifiers, when available, narrow same-name localities/streets. */
  localityId?: string;
  streetId?: string;
  street: string;
  house?: string;
}
export interface AddressCandidate {
  address: AddressRecord;
  matchedStreet: string;
  match: 'current_name' | 'historical_name';
  requiresConfirmation: true;
  bindingVerified: false;
}
export type AddressMatchMode = 'exact' | 'prefix' | 'contains';
export type StreetType = 'street' | 'avenue' | 'lane' | 'boulevard' | 'square' | 'embankment' |
  'road' | 'highway' | 'passage' | 'descent' | 'dead_end';
export interface ParsedStreetName { type: StreetType | null; name: string; key: string }
const invalidText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const validText = (value: unknown, maximum = 500): value is string => typeof value === 'string' && value.length <= maximum && !invalidText.test(value);
const nonemptyText = (value: unknown, maximum = 500): value is string => validText(value, maximum) && Boolean(value.trim());
function closedRecord(value: unknown, allowed: readonly string[], required: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key) && Object.hasOwn(fields[key], 'value')) &&
    required.every(key => Object.hasOwn(fields, key));
}
function names(value: unknown): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 100 ||
    Reflect.ownKeys(value).length !== value.length + 1) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, i) => String(i)).every(key =>
    Object.hasOwn(fields, key) && Object.hasOwn(fields[key], 'value') && nonemptyText(fields[key].value));
}
function usableAddress(address: AddressRecord): boolean {
  return Boolean(closedRecord(address, ['id', 'label', 'territoryId', 'locality', 'localityId', 'localityAliases',
    'street', 'streetId', 'house', 'aliases', 'placeNames', 'objectKind'], ['id', 'label', 'territoryId', 'locality', 'street', 'house', 'aliases']) &&
    nonemptyText(address.id, 255) && nonemptyText(address.label) && nonemptyText(address.territoryId, 255) &&
    nonemptyText(address.locality) && nonemptyText(address.street) &&
    closedRecord(address.house, ['number', 'letter', 'building', 'literal'], ['number', 'literal']) &&
    nonemptyText(address.house.number, 100) && nonemptyText(address.house.literal, 100) &&
    [address.house.letter, address.house.building].every(value => value === undefined || nonemptyText(value, 100)) &&
    names(address.aliases) &&
    [address.localityId, address.streetId].every(value => value === undefined || nonemptyText(value, 255)) &&
    [address.localityAliases, address.placeNames].every(value => value === undefined || names(value)) &&
    (address.objectKind === undefined || ['residential', 'commercial', 'public', 'other'].includes(address.objectKind)));
}
/** Presentation normalization only: no transliteration, spelling repair or invented aliases. */
export function normalizeAddressText(value: string): string {
  if (!validText(value)) throw new Error('ADDRESS_INVALID_TEXT');
  return value.normalize('NFC').replace(/[’‘`ʼʻ＇]/g, "'").replace(/[‐‑‒–—−﹘﹣－]/g, '-').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('uk-UA');
}
export function normalizeHouse(value: string): string {
  return normalizeAddressText(value)
    .replace(/^(?:будинок|буд)\.?\s+(?=\d)/u, '')
    .replace(/^(\d+)\s+([a-zа-яіїєґ])(?=$|\s|[/-])/u, '$1$2')
    .replace(/\s*([/-])\s*/gu, '$1')
    .replace(/\s+(?:корпус|корп)\.?\s*(?=\d)/gu, ' корпус ');
}
const streetTypes: ReadonlyArray<readonly [StreetType, RegExp]> = [
  ['street', /^(?:вулиця|вул)(?:\.\s*|\s+)/u],
  ['avenue', /^(?:проспект|просп|пр-т)(?:\.\s*|\s+)/u],
  ['lane', /^(?:провулок|пров|пров-к)(?:\.\s*|\s+)/u],
  ['boulevard', /^(?:бульвар|бульв|бул|б-р)(?:\.\s*|\s+)/u],
  ['square', /^(?:площа|пл)(?:\.\s*|\s+)/u],
  ['embankment', /^(?:набережна|наб)(?:\.\s*|\s+)/u],
  ['highway', /^(?:шосе|ш)(?:\.\s*|\s+)/u],
  ['road', /^(?:дорога|дор)(?:\.\s*|\s+)/u],
  ['passage', /^(?:проїзд|пр-д)(?:\.\s*|\s+)/u],
  ['descent', /^(?:узвіз|узв)(?:\.\s*|\s+)/u],
  ['dead_end', /^(?:тупик|туп)(?:\.\s*|\s+)/u],
];
/** A typed query cannot turn an avenue into a lane. Untyped input remains discovery. */
export function parseStreetName(value: string): ParsedStreetName {
  const normalized = normalizeAddressText(value);
  for (const [type, pattern] of streetTypes) {
    const prefix = pattern.exec(normalized);
    if (prefix) { const name = normalized.slice(prefix[0].length).trim(); return { type, name, key: `${type}:${name}` }; }
  }
  return { type: null, name: normalized, key: normalized };
}
const matchText = (candidate: string, query: string, mode: AddressMatchMode) => mode === 'exact' ? candidate === query :
  mode === 'prefix' ? candidate.startsWith(query) : mode === 'contains' ? candidate.includes(query) : false;
export function streetMatchesQuery(candidate: string, query: string, mode: AddressMatchMode = 'contains'): boolean {
  if (!validText(candidate) || !validText(query)) return false;
  const a = parseStreetName(candidate), q = parseStreetName(query);
  return Boolean(q.name && (!q.type || q.type === a.type) && matchText(a.name, q.name, mode));
}
function localityName(value: string) {
  const normalized = normalizeAddressText(value), m = /^(місто|м|село|с|селище|с-ще|смт)(?:\.\s*|\s+)(.+)$/u.exec(normalized);
  return m ? { type: ['місто', 'м'].includes(m[1]) ? 'city' : ['село', 'с'].includes(m[1]) ? 'village' : 'settlement', name: m[2] } : { type: null, name: normalized };
}
export function localityMatchesQuery(candidate: string, query: string, mode: AddressMatchMode = 'exact'): boolean {
  if (!validText(candidate) || !validText(query)) return false;
  const a = localityName(candidate), q = localityName(query);
  return Boolean(q.name && (!q.type || a.type === null || q.type === a.type) && matchText(a.name, q.name, mode));
}
/** Names of explicitly cataloged buildings/businesses; this creates no address or binding. */
export function placeNameMatchesQuery(candidate: string, query: string, mode: AddressMatchMode = 'contains'): boolean {
  if (!validText(candidate) || !validText(query)) return false;
  const q = normalizeAddressText(query);
  return q.length >= 2 && matchText(normalizeAddressText(candidate), q, mode);
}
export function houseMatchesQuery(candidate: string, query: string, mode: 'exact' | 'prefix' = 'exact'): boolean {
  if (!validText(candidate, 100) || !validText(query, 100)) return false;
  const a = normalizeHouse(candidate), q = normalizeHouse(query);
  return Boolean(q && matchText(a, q, mode));
}
/** Discovery hint only. It never changes the exact house matcher or provider selection. */
export function houseLookalikeSuggestion(candidate: string, query: string): boolean {
  if (!validText(candidate, 100) || !validText(query, 100) || houseMatchesQuery(candidate, query, 'prefix')) return false;
  const a = /^(\d+)([a-zа-яіїєґ])$/u.exec(normalizeHouse(candidate)), q = /^(\d+)([a-zа-яіїєґ])$/u.exec(normalizeHouse(query));
  if (!a || !q || a[1] !== q[1] || /[a-z]/u.test(a[2]) === /[a-z]/u.test(q[2])) return false;
  const map: Record<string, string> = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
  return (map[a[2]] || a[2]) === (map[q[2]] || q[2]);
}
function assertQuery(query: AddressSearch) {
  if (!query || !validText(query.territoryId, 255) || !query.territoryId.trim() || !validText(query.locality) || !normalizeAddressText(query.locality)) throw new Error('ADDRESS_TERRITORY_REQUIRED');
  if (!validText(query.street) || query.house !== undefined && !validText(query.house, 100) ||
    query.localityId !== undefined && (!validText(query.localityId, 255) || !query.localityId.trim()) ||
    query.streetId !== undefined && (!validText(query.streetId, 255) || !query.streetId.trim())) throw new Error('ADDRESS_INVALID_QUERY');
}
/** Supplied aliases are catalog evidence, never names synthesized by this matcher. */
export function matchAddressRecord(address: AddressRecord, query: AddressSearch): AddressCandidate | null {
  assertQuery(query);
  if (!usableAddress(address)) return null;
  const q = parseStreetName(query.street);
  if (q.name.length < 2 || address.territoryId !== query.territoryId || query.localityId !== undefined && address.localityId !== query.localityId ||
    query.streetId !== undefined && address.streetId !== query.streetId) return null;
  if (![address.locality, ...(address.localityAliases || [])].some(name => localityMatchesQuery(name, query.locality))) return null;
  const names = [{ name: address.street, match: 'current_name' as const }, ...address.aliases.map(name => ({ name, match: 'historical_name' as const }))];
  const matched = names.find(item => streetMatchesQuery(item.name, query.street));
  if (!matched || query.house !== undefined && !houseMatchesQuery(address.house.literal, query.house)) return null;
  return { address: structuredClone(address), matchedStreet: matched.name, match: matched.match, requiresConfirmation: true, bindingVerified: false };
}
export function searchAddressIndex(index: readonly AddressRecord[], query: AddressSearch): AddressCandidate[] {
  assertQuery(query);
  const candidates = index.flatMap(address => { const candidate = matchAddressRecord(address, query); return candidate ? [candidate] : []; });
  return candidates.sort((a, b) => a.address.street.localeCompare(b.address.street, 'uk') || a.address.house.literal.localeCompare(b.address.house.literal, 'uk', { numeric: true }));
}
export function confirmAddressCandidate(candidates: readonly AddressCandidate[], selectedId: string): AddressRecord {
  if (!Array.isArray(candidates) || !nonemptyText(selectedId, 255)) throw new Error('EXACT_ADDRESS_SELECTION_REQUIRED');
  const matches = candidates.filter(c => c?.address?.id === selectedId);
  if (matches.length !== 1 || !usableAddress(matches[0].address)) throw new Error('EXACT_ADDRESS_SELECTION_REQUIRED');
  return structuredClone(matches[0].address);
}
/** Merge a rename by immutable registry UID; old/new names never create another address. */
export function applyAddressRevision(index: readonly AddressRecord[], incoming: AddressRecord): AddressRecord[] {
  if (!usableAddress(incoming)) throw new Error('ADDRESS_INVALID_RECORD');
  if (!Array.isArray(index) || index.some(item => !usableAddress(item))) throw new Error('ADDRESS_INVALID_RECORD');
  const ids = new Set<string>();
  for (const address of index) {
    if (ids.has(address.id)) throw new Error('ADDRESS_DUPLICATE_ID');
    ids.add(address.id);
  }
  const previous = index.find(item => item.id === incoming.id);
  if (previous && (previous.territoryId !== incoming.territoryId || previous.localityId && previous.localityId !== incoming.localityId ||
    previous.streetId && previous.streetId !== incoming.streetId ||
    !previous.localityId && !localityMatchesQuery(previous.locality, incoming.locality) ||
    normalizeHouse(previous.house.literal) !== normalizeHouse(incoming.house.literal))) {
    throw new Error('ADDRESS_ID_IDENTITY_CONFLICT');
  }
  const aliases = new Set([...(previous?.aliases || []), ...incoming.aliases]);
  if (previous && previous.street !== incoming.street) aliases.add(previous.street);
  aliases.delete(incoming.street);
  const localityAliases = new Set([...(previous?.localityAliases || []), ...(incoming.localityAliases || [])]);
  if (previous?.localityId && previous.localityId === incoming.localityId && previous.locality !== incoming.locality) localityAliases.add(previous.locality);
  localityAliases.delete(incoming.locality);
  const merged = { ...incoming, aliases: [...aliases], ...(localityAliases.size ? { localityAliases: [...localityAliases] } : {}) };
  if (!usableAddress(merged)) throw new Error('ADDRESS_INVALID_RECORD');
  return [...index.filter(item => item.id !== incoming.id), merged];
}
