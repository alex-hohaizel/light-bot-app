import {createHash} from 'node:crypto';
import {types} from 'node:util';

const OEM = 'https://www.dtek-oem.com.ua/ua/ajax' as const;
const YASNO = 'https://app.yasno.ua';
const YASNO_PATH = '/api/blackout-service/public/shutdowns/addresses/v2/';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export class PublicAddressRequestIdentityError extends Error {
  readonly code = 'ADDRESS_PUBLIC_REQUEST_IDENTITY_INVALID';
  constructor() { super('ADDRESS_PUBLIC_REQUEST_IDENTITY_INVALID'); this.name = 'PublicAddressRequestIdentityError'; }
}
function invalid(): never { throw new PublicAddressRequestIdentityError(); }
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(k => typeof k !== 'string' || !keys.includes(k)) ||
      keys.some(k => !descriptors[k] || !('value' in descriptors[k]))) invalid();
}
function literal(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) ||
      /[\u0000-\u001f\u007f]/.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) invalid();
  return value;
}

/** Historical GET keys remain SHA(url), byte for byte. This does not validate
 * source facts or authorize a fetch; the existing YASNO decoder still does that. */
export function legacyYasnoAddressRequestKey(value: unknown): string {
  const raw = literal(value, 2048);
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  if (url.origin !== YASNO || url.username || url.password || url.hash ||
      !['streets', 'houses', 'group'].some(op => url.pathname === YASNO_PATH + op)) invalid();
  return hash(raw);
}

export type OdesaPublicAddressRequest =
  {method: 'POST'; url: typeof OEM; operation: 'getStreets'; fields: Record<string, never>} |
  {method: 'POST'; url: typeof OEM; operation: 'getHomeNum'; fields: {
    city: string; street: string; house_num: string; updateFact: string;
  }};

/** Cache identity only. Public fields are exact opaque provider keys: no NFC,
 * trimming, alias guessing, numeric casts, credentials or guest state. The key
 * proves neither TLS/source authenticity nor a verified address/delivery right.
 * SQL logical phases (streets/houses/group) stay separate from the upstream op. */
export function odesaPublicAddressRequestIdentity(value: unknown) {
  closed(value, ['method', 'url', 'operation', 'fields']);
  if (value.method !== 'POST' || value.url !== OEM || typeof value.operation !== 'string' ||
      !['getStreets', 'getHomeNum'].includes(value.operation)) invalid();
  let entries: ReadonlyArray<readonly [string, string]>;
  if (value.operation === 'getStreets') {
    closed(value.fields, []); entries = Object.freeze([]);
  } else {
    closed(value.fields, ['city', 'street', 'house_num', 'updateFact']);
    entries = Object.freeze([
      Object.freeze(['city', literal(value.fields.city, 300)] as const),
      Object.freeze(['street', literal(value.fields.street, 300)] as const),
      Object.freeze(['house_num', literal(value.fields.house_num, 100, true)] as const),
      Object.freeze(['updateFact', literal(value.fields.updateFact, 40, true)] as const),
    ]);
  }
  const operation = value.operation as 'getStreets' | 'getHomeNum';
  const tuple = ['lba-public-address-request/2', 'dtek:oem', 'POST', OEM, operation, entries] as const;
  return Object.freeze({
    kind: 'dtek-oem-public-address-request/1' as const,
    namespace: 'dtek:oem' as const, method: 'POST' as const, url: OEM, operation,
    publicEntries: entries, requestKey: hash(JSON.stringify(tuple)),
    keyRevision: 'lba-public-address-request/2' as const,
  });
}
