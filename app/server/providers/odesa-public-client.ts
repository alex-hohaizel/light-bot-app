import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { load } from 'cheerio';
import {
  buildOdesaAddressCandidate, readOdesaHouseChoices, readOdesaStreetCatalog, OdesaSourceError,
  type OdesaAddressCandidate, type OdesaAjaxCapture, type OdesaStreetCatalog,
  ODESA_SCOPE,
} from '../domain/odesa-address-adapter.ts';
import {ODESA_PLAN_API_SOURCE,OdesaPlanApiError,odesaPlanUpdateInstant,readOdesaPlanApi,
  type OdesaPlanApiCapture,type OdesaPlanApiDataset} from '../domain/odesa-plan-api-adapter.ts';

const HOME = 'https://www.dtek-oem.com.ua/ua';
const AJAX = 'https://www.dtek-oem.com.ua/ua/ajax';
const ORIGIN = 'https://www.dtek-oem.com.ua';
const CSRF_PARAM = '_csrf-dtek-oem';
const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const plain = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)));
const only = (v: unknown, names: string[]) => plain(v) && Object.keys(v).every(k => names.includes(k));
const challenge = /cf-chl-|\/cdn-cgi\/challenge-platform|<title[^>]*>\s*(?:just a moment|attention required|checking your browser)|id=["']challenge-(?:form|running)|captcha-delivery\.com/i;
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export class OdesaTransportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(['CANCELLED', 'CLOSED'].includes(code) ? 'Отримання даних скасовано.'
      : code === 'BUSY' ? 'Дані вже оновлюються. Зачекайте завершення.'
      : code === 'LOCAL_RATE_LIMIT' ? 'Забагато запитів за короткий час. Спробуйте пізніше.'
      : code === 'SELECTION_INVALID' ? 'Оберіть населений пункт, вулицю й будинок зі списку оператора.'
      : 'Не вдалося отримати перевірені дані оператора. Спробуйте пізніше.');
    this.name = 'OdesaTransportError'; this.code = 'ODESA_TRANSPORT_' + code;
  }
}
function stop(code: string): never { throw new OdesaTransportError(code); }
function key(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v) || Buffer.from(v).toString('utf8') !== v) return stop('SELECTION_INVALID');
  return v;
}
function freeze<T>(v: T): Readonly<T> {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
type Mode = 'standard_fetch_https' | 'fixture_unverified';
type PublicFields = { city: string; street: string; house_num: string; updateFact: '' };
type PlanFields = { update: string };
type Stage = 'guest_home' | 'catalog' | 'houses' | 'selected_house' | 'plan_update';
export interface OdesaHopDescriptor {
  readonly stage: Stage; readonly method: 'GET' | 'POST'; readonly url: typeof HOME | typeof AJAX;
  readonly operation: 'guest_home' | 'getStreets' | 'getHomeNum' | 'checkDisconUpdate';
  readonly publicFields: Readonly<Record<string, string>>;
  readonly orderedPublicFields: readonly (readonly [string, string])[];
  /** Native trace identity only; SQL identity/versioning is the parent writer's responsibility. */
  readonly requestKey: string;
}
export type OdesaBeforeHop = (descriptor: Readonly<OdesaHopDescriptor>, signal: AbortSignal) => void | Promise<void>;
interface Limits {
  deadlineMs: number; homepageBytes: number; ajaxBytes: number; totalBytes: number;
  minimumSpacingMs: number; windowMs: number; maximumRequestsPerWindow: number;
}
// These are conservative local bounds, not a claim about provider quotas/rights.
const DEFAULTS: Limits = { deadlineMs: 30_000, homepageBytes: 1_000_000, ajaxBytes: 2_000_000,
  totalBytes: 6_000_000, minimumSpacingMs: 1_100, windowMs: 60_000, maximumRequestsPerWindow: 8 };
interface OriginState { active: boolean; lastStart: number; starts: number[]; halted: boolean; lastClock: number; lastMonotonic: number }
const productionOrigin: OriginState = { active: false, lastStart: -Infinity, starts: [], halted: false, lastClock: -Infinity, lastMonotonic: -Infinity };
const fixtureOrigins = new WeakMap<object, OriginState>();
export type OdesaFixtureFetch = (url: string, init: RequestInit) => Promise<Response>;
interface Cookie { name: string; value: string; domain: string; path: string; expires: number | null; sameSite: 'lax' | 'strict' | 'none' | null }
interface Session {
  controller: AbortController; cookies: Map<string, Cookie>; csrf: string; csrfParam: string;
  guestValues: Set<string>;
  receipts: OdesaRequestProof[]; bytes: number; requests: number;
}
export interface OdesaRequestProof {
  stage: Stage; method: 'GET' | 'POST'; url: typeof HOME | typeof AJAX;
  operation: 'guest_home' | 'getStreets' | 'getHomeNum' | 'checkDisconUpdate';
  publicFields: Record<string, string>; requestKey: string; startedAt: string; observedAt: string;
  responseSha256: string; responseBytes: number;
  responseScopeEchoed: false; queryBinding: 'internal_request_builder';
}
export interface OdesaTransportProof {
  kind: 'odesa-public-transport-proof/2';
  mode: Mode; requestBinding: 'internal_serialized_request_to_response';
  budgetHook: 'absent_local_only' | 'before_hop_process_port_not_sql_attestation';
  trustBoundary: 'process_integrity_required_not_tls_or_persisted_attestation';
  requests: readonly OdesaRequestProof[]; sourceRights: 'unknown'; providerQuota: 'unknown';
  scheduleIncluded: false; sourceAdmission: false; deliveryEligible: false;
}
export interface OdesaPlanTransportProof extends Omit<OdesaTransportProof,'kind'|'scheduleIncluded'> {
  kind:'odesa-public-plan-transport-proof/1';
  /** True only when the strict plan adapter found a complete dated matrix. */
  scheduleIncluded:boolean;
}
type HouseChoices = ReturnType<typeof readOdesaHouseChoices>;
export interface OdesaHouseListDataset {
  basis: 'street_row_dataset/1'; scope: typeof ODESA_SCOPE;
  cityKey: string; streetKey: string; observedAt: string; rawSha256: string;
  validation: 'json_capture_only'; applicationResult: boolean | null; bindingAuthority: false;
}
export type OdesaPublicResult =
  { kind: 'odesa-public-catalog/1'; catalog: OdesaStreetCatalog; transport: OdesaTransportProof } |
  { kind: 'odesa-public-houses/1'; houses: HouseChoices; transport: OdesaTransportProof } |
  { kind: 'odesa-public-house-list-dataset/1'; dataset: OdesaHouseListDataset; transport: OdesaTransportProof } |
  { kind: 'odesa-public-address/1'; candidate: OdesaAddressCandidate; transport: OdesaTransportProof } |
  { kind: 'odesa-public-plan-update/1'; plan: OdesaPlanApiDataset; transport: OdesaPlanTransportProof };
export interface OdesaInternalIntake {
  mode: Mode; basis: 'catalog_chain/1' | 'street_row_dataset/1' | 'plan_update/1';
  captures: { catalog?: OdesaAjaxCapture; houses?: OdesaAjaxCapture; selectedHouse?: OdesaAjaxCapture; plan?:OdesaPlanApiCapture };
}
const internalResults = new WeakMap<object, Readonly<OdesaInternalIntake>>();
/** A JSON/DTO copy cannot mint this in-process provenance. It is not a persisted attestation or source admission. */
export function isNativeOdesaPublicResult(value: unknown): value is OdesaPublicResult {
  return Boolean(value && typeof value === 'object' && internalResults.get(value)?.mode === 'standard_fetch_https');
}
/** Read-only internal adapter/issuer seam; never accepts caller-supplied capture overrides. */
export function getOdesaInternalIntake(value: unknown): Readonly<OdesaInternalIntake> | null {
  return value && typeof value === 'object' ? internalResults.get(value) ?? null : null;
}
export interface OdesaPublicClient {
  catalog(signal: AbortSignal): Promise<Readonly<OdesaPublicResult & { kind: 'odesa-public-catalog/1' }>>;
  houses(selection: { city: string; street: string }, signal: AbortSignal): Promise<Readonly<OdesaPublicResult & { kind: 'odesa-public-houses/1' }>>;
  /** Parent must validate catalog membership first; this method acquires a dataset, never a binding. */
  houseList(selection: { city: string; street: string }, signal: AbortSignal): Promise<Readonly<OdesaPublicResult & { kind: 'odesa-public-house-list-dataset/1' }>>;
  address(selection: { city: string; street: string; house: string; label?: string }, signal: AbortSignal): Promise<Readonly<OdesaPublicResult & { kind: 'odesa-public-address/1' }>>;
  /** The literal public cursor is not authentication or a claim of freshness. */
  planUpdate(lastKnownUpdate:string,signal:AbortSignal):Promise<Readonly<OdesaPublicResult&{kind:'odesa-public-plan-update/1'}>>;
  close(): void;
}
function productionEnvironment() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY'].some(k => Boolean(process.env[k])) ||
      /--use-env-proxy|--insecure-http-parser/.test(process.env.NODE_OPTIONS ?? '')) stop('UNSUPPORTED_NETWORK_CONFIGURATION');
}
/** No I/O until a method is explicitly called. No URL/header/auth/proxy/capture injection surface. */
export function createOdesaPublicClient(options: { beforeHop?: OdesaBeforeHop } = {}): OdesaPublicClient {
  if (arguments.length > 1 || !only(options, ['beforeHop']) || options.beforeHop !== undefined && typeof options.beforeHop !== 'function') stop('CONFIGURATION_INVALID');
  productionEnvironment();
  return create(realFetch, Date.now, () => performance.now(), DEFAULTS, productionOrigin, 'standard_fetch_https', options.beforeHop);
}
/** Fixture injection is visibly untrusted and can never yield isNativeOdesaPublicResult=true. */
export function createOdesaPublicClientForFixtureTests(options: {
  fetch: OdesaFixtureFetch; now: () => number; monotonic?: () => number; sharedScope: object; limits?: Partial<Limits>; beforeHop?: OdesaBeforeHop;
}): OdesaPublicClient {
  if (!only(options, ['fetch', 'now', 'monotonic', 'sharedScope', 'limits', 'beforeHop']) || typeof options.fetch !== 'function' ||
      typeof options.now !== 'function' || !options.sharedScope || typeof options.sharedScope !== 'object' ||
      options.monotonic !== undefined && typeof options.monotonic !== 'function' ||
      options.beforeHop !== undefined && typeof options.beforeHop !== 'function' ||
      options.limits !== undefined && !only(options.limits, Object.keys(DEFAULTS))) stop('CONFIGURATION_INVALID');
  let state = fixtureOrigins.get(options.sharedScope);
  if (!state) { state = { active: false, lastStart: -Infinity, starts: [], halted: false, lastClock: -Infinity, lastMonotonic: -Infinity }; fixtureOrigins.set(options.sharedScope, state); }
  const limits = { ...DEFAULTS, ...options.limits };
  for (const [name, v] of Object.entries(limits)) if (!Number.isSafeInteger(v) || v < (name === 'minimumSpacingMs' ? 0 : 1) || v > (name === 'minimumSpacingMs' ? DEFAULTS.minimumSpacingMs : DEFAULTS[name as keyof Limits])) stop('CONFIGURATION_INVALID');
  return create(options.fetch, options.now, options.monotonic ?? (() => performance.now()), limits, state, 'fixture_unverified', options.beforeHop);
}

function create(fetchPort: OdesaFixtureFetch, clock: () => number, monotonic: () => number, limits: Limits, origin: OriginState, mode: Mode, beforeHop?: OdesaBeforeHop): OdesaPublicClient {
  let closed = false, active: Session | null = null, cancelActive: (() => void) | null = null;
  function now() {
    const n = clock(), m = monotonic();
    if (!Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000_000 || n < origin.lastClock ||
        !Number.isFinite(m) || m < 0 || m < origin.lastMonotonic) return halt('CLOCK_INVALID');
    if (origin.lastClock !== -Infinity && Math.abs((n - origin.lastClock) - (m - origin.lastMonotonic)) > 5_000) return halt('CLOCK_DISCONTINUITY');
    origin.lastClock = n; origin.lastMonotonic = m; return n;
  }
  function check(s: Session) { if (s.controller.signal.aborted || closed) stop(closed ? 'CLOSED' : 'CANCELLED'); }
  function clear(s: Session) { s.cookies.clear(); s.guestValues.clear(); s.csrf = ''; s.csrfParam = ''; }
  function halt(code: string): never { origin.halted = true; return stop(code); }
  function cookies(s: Session, response: Response) {
    if (typeof response.headers.getSetCookie !== 'function') return stop('COOKIE_HEADERS_UNSUPPORTED');
    const values = response.headers.getSetCookie();
    if (values.length > 16 || values.reduce((n, v) => n + v.length, 0) > 16_384) stop('COOKIE_LIMIT');
    for (const line of values) {
      if (typeof line !== 'string' || /[\u0000-\u001f\u007f]/.test(line)) stop('COOKIE_INVALID');
      const [pair, ...attrs] = line.split(';'), split = pair.indexOf('=');
      const name = pair.slice(0, split).trim(), value = pair.slice(split + 1).trim();
      if (split < 1 || !/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]{1,128}$/.test(name) || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{0,4096}$/.test(value) ||
          /^(?:authorization|_identity|identity|auth_token|cf_clearance)$/i.test(name)) return halt('COOKIE_SCOPE_REJECTED');
      // Keep prior/rotated/deleted issued values until session cleanup. A
      // response cannot erase the privacy boundary by replacing its cookie.
      if (value) s.guestValues.add(value);
      let domain = 'www.dtek-oem.com.ua', path = '/', expires: number | null = null, maxAge: number | null = null;
      let sameSite: Cookie['sameSite'] = null;
      const seen = new Map<string, string | number>();
      for (const rawAttr of attrs) {
        const i = rawAttr.indexOf('='), attr = (i < 0 ? rawAttr : rawAttr.slice(0, i)).trim().toLowerCase(), val = i < 0 ? '' : rawAttr.slice(i + 1).trim();
        if (!['domain', 'path', 'max-age', 'expires', 'samesite', 'secure', 'httponly'].includes(attr)) stop('COOKIE_INVALID');
        let normalized: string | number = '';
        if (attr === 'domain') { domain = val.replace(/^\./, '').toLowerCase(); if (!['www.dtek-oem.com.ua', 'dtek-oem.com.ua'].includes(domain)) return halt('COOKIE_SCOPE_REJECTED'); }
        if (attr === 'path') { if (!val.startsWith('/') || val.length > 200 || /[^\x21-\x7e]/.test(val)) stop('COOKIE_INVALID'); path = val; }
        if (attr === 'max-age') { if (!/^-?\d{1,10}$/.test(val)) stop('COOKIE_INVALID'); maxAge = Number(val); }
        if (attr === 'expires') { expires = Date.parse(val); if (!Number.isFinite(expires)) stop('COOKIE_INVALID'); }
        if (attr === 'samesite') {
          if (!['lax', 'strict', 'none'].includes(val.toLowerCase())) stop('COOKIE_INVALID');
          sameSite = val.toLowerCase() as Cookie['sameSite'];
        }
        if (['secure', 'httponly'].includes(attr) && val !== '') stop('COOKIE_INVALID');
        if (attr === 'domain') normalized = domain;
        if (attr === 'path') normalized = path;
        if (attr === 'max-age') normalized = maxAge!;
        if (attr === 'expires') normalized = expires!;
        if (attr === 'samesite') normalized = sameSite!;
        // Repeated boolean flags are idempotent. Scope/expiry repeats must
        // agree after validation/normalization, never silently widen scope.
        // For valid SameSite repeats retain the last value. This client has
        // only fixed same-origin HTTPS requests and no cross-site navigation.
        if (seen.has(attr) && attr !== 'samesite' && seen.get(attr) !== normalized) stop('COOKIE_ATTRIBUTE_CONFLICT');
        seen.set(attr, normalized);
      }
      if (name.startsWith('__Secure-') && !seen.has('secure') || name.startsWith('__Host-') && (!seen.has('secure') || seen.has('domain') || path !== '/')) stop('COOKIE_INVALID');
      if (maxAge !== null) expires = now() + maxAge * 1000;
      const id = name + ':' + domain + ':' + path;
      if (expires !== null && expires <= now()) s.cookies.delete(id);
      else s.cookies.set(id, { name, value, domain, path, expires, sameSite });
      if (s.cookies.size > 16) stop('COOKIE_LIMIT');
    }
  }
  function rejectGuestEcho(s: Session, raw: string) {
    const sensitive = [...s.guestValues];
    const scan = (value: string) => { if (sensitive.some(secret => value.includes(secret))) stop('SENSITIVE_RESPONSE_REJECTED'); };
    scan(raw);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return stop('RESPONSE_JSON_INVALID'); }
    // JSON escapes can hide a guest value in either a key or a string value.
    // This scan never alters data or converts a rejected response to success.
    const pending = [{ value: parsed, depth: 0 }]; let nodes = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (++nodes > 100_000 || depth > 24) stop('RESPONSE_JSON_LIMIT');
      if (typeof value === 'string') scan(value);
      else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) {
        scan(name); pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
  function cookieHeader(s: Session) {
    const time = now();
    for (const [id, c] of s.cookies) if (c.expires !== null && c.expires <= time) s.cookies.delete(id);
    const selected = [...s.cookies.values()].filter(c => '/ua/ajax' === c.path || '/ua/ajax'.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')).sort((a, b) => b.path.length - a.path.length);
    if (new Set(selected.map(c => c.name)).size !== selected.length) stop('COOKIE_AMBIGUOUS');
    return selected.map(c => c.name + '=' + c.value).join('; ');
  }
  async function spacing(s: Session) {
    check(s);
    now();
    const wait = Math.max(0, origin.lastStart + limits.minimumSpacingMs - origin.lastMonotonic);
    if (wait) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new OdesaTransportError('CANCELLED')); };
      const timer = setTimeout(() => { s.controller.signal.removeEventListener('abort', abort); resolve(); }, wait);
      s.controller.signal.addEventListener('abort', abort, { once: true });
      if (s.controller.signal.aborted) abort();
    });
    check(s);
    now(); const time = origin.lastMonotonic; origin.starts = origin.starts.filter(n => time - n < limits.windowMs);
    if (origin.starts.length >= limits.maximumRequestsPerWindow) stop('LOCAL_RATE_LIMIT');
    if (s.requests >= 4) stop('SESSION_REQUEST_LIMIT');
  }
  async function request(s: Session, stage: Stage, fields?: PublicFields|PlanFields): Promise<{ raw: string; proof: OdesaRequestProof }> {
    await spacing(s); check(s);
    if (mode === 'standard_fetch_https') productionEnvironment();
    const home = stage === 'guest_home', url = home ? HOME : AJAX, method = home ? 'GET' : 'POST';
    const plan=stage==='plan_update';
    const operation = home ? 'guest_home' : plan ? 'checkDisconUpdate' : fields ? 'getHomeNum' : 'getStreets';
    const addressFields=fields as PublicFields|undefined;
    const publicEntries: [string, string][] = plan ? [['update',(fields as PlanFields).update]] : addressFields ? [['city', addressFields.city], ['street', addressFields.street], ['house_num', addressFields.house_num], ['updateFact', addressFields.updateFact]] : [];
    const publicFields = Object.fromEntries(publicEntries);
    const requestKey = sha(JSON.stringify([method, url, operation, publicEntries]));
    if (beforeHop) {
      const descriptor: OdesaHopDescriptor = freeze({ stage, method, url, operation, publicFields: { ...publicFields },
        orderedPublicFields: publicEntries.map(pair => [...pair] as [string, string]), requestKey });
      let decision: unknown;
      try { decision = await beforeHop(descriptor, s.controller.signal); } catch { check(s); return stop('BUDGET_HOOK_DENIED'); }
      check(s); if (decision !== undefined) stop('BUDGET_HOOK_INVALID');
    }
    check(s); now();
    if (mode === 'standard_fetch_https') productionEnvironment();
    // Timestamp/count the actual attempt after any hook wait, so the next hop
    // still observes spacing from the dispatch rather than from a reservation.
    const dispatchedAt = origin.lastMonotonic;
    origin.starts = origin.starts.filter(n => dispatchedAt - n < limits.windowMs);
    if (origin.starts.length >= limits.maximumRequestsPerWindow) stop('LOCAL_RATE_LIMIT');
    if (++s.requests > 4) stop('SESSION_REQUEST_LIMIT');
    origin.starts.push(dispatchedAt); origin.lastStart = dispatchedAt;
    const headers: Record<string, string> = { accept: home ? 'text/html' : 'application/json', 'accept-encoding': 'identity' };
    let body: string | undefined;
    if (!home) {
      if (!s.csrf || !s.csrfParam || !s.cookies.size) stop('GUEST_CONTEXT_MISSING');
      const form = new URLSearchParams([['method', operation]]);
      if(plan)publicEntries.forEach(([name,value])=>form.append(name,value));
      else publicEntries.forEach(([name, value], i) => { form.append('data[' + i + '][name]', name); form.append('data[' + i + '][value]', value); });
      form.append(s.csrfParam, s.csrf); body = form.toString();
      if (Buffer.byteLength(body) > 16_384) stop('REQUEST_LIMIT');
      Object.assign(headers, { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest', origin: ORIGIN, referer: HOME, cookie: cookieHeader(s) });
    }
    const startedAt = new Date(now()).toISOString();
    let response: Response;
    try { response = await fetchPort(url, { method, headers, ...(body === undefined ? {} : { body }),
      redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: s.controller.signal }); }
    catch { check(s); return stop('NETWORK_FAILURE'); }
    if (s.controller.signal.aborted || closed) { try { void response.body?.cancel().catch(() => {}); } catch { /* no output */ } check(s); }
    const discard = () => { try { void response.body?.cancel().catch(() => {}); } catch { /* no output */ } };
    if (response.url !== url || response.redirected || response.status >= 300 && response.status < 400 || response.type === 'opaqueredirect') { discard(); return halt('REDIRECT_OR_ORIGIN_REJECTED'); }
    if ([401, 403, 407, 429].includes(response.status) || response.headers.has('www-authenticate') || response.headers.has('proxy-authenticate') || response.headers.get('cf-mitigated') === 'challenge') { discard(); return halt('SOURCE_ACCESS_STOP'); }
    if (response.status !== 200) { discard(); return stop('HTTP_FAILURE'); }
    const contentType = response.headers.get('content-type') ?? '', cap = home ? limits.homepageBytes : limits.ajaxBytes;
    if (contentType.split(';')[0].trim().toLowerCase() !== (home ? 'text/html' : 'application/json') ||
        ![null, 'identity'].includes(response.headers.get('content-encoding'))) { discard(); return halt('RESPONSE_FORMAT_REJECTED'); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap) || !response.body) { discard(); return stop('BODY_LIMIT'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0, complete = false;
    const abortReader = () => { try { void reader.cancel().catch(() => {}); } catch { /* no output */ } };
    s.controller.signal.addEventListener('abort', abortReader, { once: true });
    try {
      while (true) {
        const next = await reader.read(); check(s);
        if (next.done) { complete = true; break; }
        if (!(next.value instanceof Uint8Array) || !next.value.byteLength || chunks.length >= 2_048 ||
            (size += next.value.byteLength) > cap || s.bytes + size > limits.totalBytes) stop('BODY_LIMIT');
        chunks.push(next.value.slice());
      }
      if (!size || length !== null && Number(length) !== size) stop('BODY_LENGTH_MISMATCH');
      s.bytes += size;
      let raw: string; try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size)); } catch { return stop('BODY_ENCODING_INVALID'); }
      if (challenge.test(raw)) return halt('CHALLENGE_STOP');
      // Merge before scanning so newly issued values are protected too.
      cookies(s, response); check(s);
      if (!home) rejectGuestEcho(s, raw);
      const observedAt = new Date(now()).toISOString();
      const proof: OdesaRequestProof = { stage, method, url, operation, publicFields, requestKey, startedAt, observedAt,
        responseSha256: sha(raw), responseBytes: size, responseScopeEchoed: false, queryBinding: 'internal_request_builder' };
      s.receipts.push(proof); return { raw, proof };
    } catch (e) { if (e instanceof OdesaTransportError) throw e; check(s); return stop('BODY_READ_FAILURE'); }
    finally { s.controller.signal.removeEventListener('abort', abortReader); if (!complete) abortReader(); try { reader.releaseLock(); } catch { /* pending reader stays bounded by the session slot */ } }
  }
  function bootstrap(s: Session, html: string) {
    const $ = load(html);
    const meta = (name: string) => { const e = $('meta[name="' + name + '"]'); if (e.length !== 1) stop('GUEST_META_INVALID'); return e.attr('content') ?? ''; };
    const param = meta('csrf-param'), token = meta('csrf-token'), ajax = meta('ajaxUrl');
    let endpoint: URL; try { endpoint = new URL(ajax, HOME); } catch { return stop('GUEST_META_INVALID'); }
    if (endpoint.href !== AJAX || endpoint.username || endpoint.password || param !== CSRF_PARAM || !/^[A-Za-z0-9_+/\-=]{16,2048}$/.test(token) || !s.cookies.size) stop('GUEST_META_INVALID');
    s.csrf = token; s.csrfParam = param; s.guestValues.add(token);
  }
  const policy = () => ({ asOf: new Date(now()).toISOString(), maximumCaptureAgeMs: limits.deadlineMs });
  async function ajax(s: Session, stage: 'catalog'|'houses'|'selected_house', fields?: PublicFields): Promise<OdesaAjaxCapture> {
    const result = await request(s, stage, fields);
    return { sourceId: 'dtek-oem-public-ajax', operation: fields ? 'getHomeNum' : 'getStreets', method: 'POST', url: AJAX,
      httpStatus: 200, contentType: 'application/json', observedAt: result.proof.observedAt,
      rawBody: result.raw, rawSha256: result.proof.responseSha256, request: fields ? { ...fields } : {} };
  }
  async function run(stage: 'catalog' | 'houses' | 'house_list' | 'address' | 'plan_update', rawSelection: unknown, signal: AbortSignal): Promise<Readonly<OdesaPublicResult>> {
    if (closed) stop('CLOSED');
    if (!signal || typeof signal.addEventListener !== 'function' || signal.aborted) stop('CANCELLED');
    let selection: { city: string; street: string; house?: string; label?: string } | undefined;
    let update:string|undefined;
    if(stage==='plan_update'){
      try{odesaPlanUpdateInstant(rawSelection,new Date(now()).toISOString());update=rawSelection as string;}
      catch(error){if(error instanceof OdesaTransportError)throw error;return stop('PLAN_CURSOR_INVALID');}
    }else if (stage !== 'catalog') {
      if (!only(rawSelection, stage === 'address' ? ['city', 'street', 'house', 'label'] : ['city', 'street'])) stop('SELECTION_INVALID');
      const v = rawSelection as Record<string, unknown>;
      selection = { city: key(v.city, 300), street: key(v.street, 300), ...(stage === 'address' ? { house: key(v.house, 100) } : {}),
        ...(v.label === undefined ? {} : { label: key(v.label, 60) }) };
    }
    if (origin.halted) stop('SOURCE_HALTED'); now(); if (origin.active) stop('BUSY');
    origin.active = true;
    const s: Session = { controller: new AbortController(), cookies: new Map(), guestValues: new Set(), csrf: '', csrfParam: '', receipts: [], bytes: 0, requests: 0 };
    active = s;
    let rejectStop!: (reason: OdesaTransportError) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    const cancel = (code: string) => { clear(s); s.controller.abort(); rejectStop(new OdesaTransportError(code)); };
    cancelActive = () => cancel('CLOSED');
    const abort = () => cancel(closed ? 'CLOSED' : 'CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    s.controller.signal.addEventListener('abort', () => clear(s), { once: true });
    const timer = setTimeout(() => cancel('TIMEOUT'), limits.deadlineMs);
    if (signal.aborted) abort();
    const operation = Promise.resolve().then(async () => {
      check(s); const home = await request(s, 'guest_home'); bootstrap(s, home.raw);
      const captures: OdesaInternalIntake['captures'] = {};
      let result: OdesaPublicResult;
      const transport: OdesaTransportProof = { kind: 'odesa-public-transport-proof/2', mode,
        budgetHook: beforeHop ? 'before_hop_process_port_not_sql_attestation' : 'absent_local_only',
        requestBinding: 'internal_serialized_request_to_response',
        trustBoundary: 'process_integrity_required_not_tls_or_persisted_attestation',
        requests: s.receipts, sourceRights: 'unknown', providerQuota: 'unknown', scheduleIncluded: false, sourceAdmission: false, deliveryEligible: false };
      if(stage==='plan_update'){
        const response=await request(s,'plan_update',{update:update!});
        captures.plan={kind:'odesa-plan-api-capture/1',sourceId:ODESA_PLAN_API_SOURCE,operation:'checkDisconUpdate',method:'POST',url:AJAX,
          httpStatus:200,contentType:'application/json',observedAt:response.proof.observedAt,rawBody:response.raw,rawSha256:response.proof.responseSha256,request:{update:update!}};
        const plan=readOdesaPlanApi(captures.plan,policy());
        result={kind:'odesa-public-plan-update/1',plan,transport:{...transport,kind:'odesa-public-plan-transport-proof/1',scheduleIncluded:plan.scheduleIncluded}};
      }else if (stage === 'house_list') {
        captures.houses = await ajax(s, 'houses', { city: selection!.city, street: selection!.street, house_num: '', updateFact: '' });
        const parsed = JSON.parse(captures.houses.rawBody);
        result = { kind: 'odesa-public-house-list-dataset/1', transport, dataset: {
          basis: 'street_row_dataset/1', scope: ODESA_SCOPE, cityKey: selection!.city, streetKey: selection!.street,
          observedAt: captures.houses.observedAt, rawSha256: captures.houses.rawSha256,
          validation: 'json_capture_only', applicationResult: parsed && typeof parsed.result === 'boolean' ? parsed.result : null,
          bindingAuthority: false } };
      } else {
        const catalogCapture = await ajax(s, 'catalog'), catalog = readOdesaStreetCatalog(catalogCapture, policy());
        captures.catalog = catalogCapture;
        if (stage === 'catalog') result = { kind: 'odesa-public-catalog/1', catalog, transport };
        else {
          if (!catalog.localities.some(l => l.key === selection!.city && l.streets.includes(selection!.street))) stop('SELECTION_INVALID');
          captures.houses = await ajax(s, 'houses', { city: selection!.city, street: selection!.street, house_num: '', updateFact: '' });
          const houses = readOdesaHouseChoices(captures.houses, catalogCapture, { city: selection!.city, street: selection!.street }, policy());
          if (stage === 'houses') result = { kind: 'odesa-public-houses/1', houses, transport };
          else {
            if (!houses.choices.some(h => h.key === selection!.house)) stop('SELECTION_INVALID');
            captures.selectedHouse = await ajax(s, 'selected_house', { city: selection!.city, street: selection!.street, house_num: selection!.house!, updateFact: '' });
            const candidate = buildOdesaAddressCandidate({ selection: selection as { city: string; street: string; house: string; label?: string },
              captures: { catalog: catalogCapture, houses: captures.houses, selectedHouse: captures.selectedHouse }, policy: policy() });
            result = { kind: 'odesa-public-address/1', candidate, transport };
          }
        }
      }
      check(s); freeze(result); internalResults.set(result, freeze({ mode, basis: stage==='plan_update'?'plan_update/1':stage === 'house_list' ? 'street_row_dataset/1' : 'catalog_chain/1', captures })); return result;
    });
    // If an injected fetch ignores abort, keep the shared slot until it really settles.
    void operation.finally(() => { clear(s); origin.active = false; if (active === s) { active = null; cancelActive = null; } }).catch(() => {});
    try { return await Promise.race([operation, stopped]); }
    catch (e) { if (e instanceof OdesaTransportError || e instanceof OdesaSourceError || e instanceof OdesaPlanApiError) throw e; return stop('OPERATION_FAILED'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); clear(s); }
  }
  return Object.freeze({
    catalog: (signal: AbortSignal) => run('catalog', undefined, signal) as ReturnType<OdesaPublicClient['catalog']>,
    houses: (selection: { city: string; street: string }, signal: AbortSignal) => run('houses', selection, signal) as ReturnType<OdesaPublicClient['houses']>,
    houseList: (selection: { city: string; street: string }, signal: AbortSignal) => run('house_list', selection, signal) as ReturnType<OdesaPublicClient['houseList']>,
    address: (selection: { city: string; street: string; house: string; label?: string }, signal: AbortSignal) => run('address', selection, signal) as ReturnType<OdesaPublicClient['address']>,
    planUpdate:(lastKnownUpdate:string,signal:AbortSignal)=>run('plan_update',lastKnownUpdate,signal) as ReturnType<OdesaPublicClient['planUpdate']>,
    close() { closed = true; cancelActive?.(); },
  });
}
