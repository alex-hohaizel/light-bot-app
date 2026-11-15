import { createHash } from 'node:crypto';
import type { ScheduleView, SourceReference } from '../../shared/product-contract.ts';
import { calendarDate, localParts, nextCalendarDate, validInstant, validateScheduleView } from '../../shared/schedule-core.ts';
import { normalizeYasnoRaw } from '../domain/yasno-adapter.ts';
import { normalizeHourMatrix } from '../domain/hour-matrix-adapter.ts';
import { normalizeKharkivRss } from '../domain/kharkiv-adapter.ts';

type Parser = 'yasno' | 'hour_matrix' | 'kharkiv_rss';
export interface SourceProfile {
  readonly sourceId: string;
  readonly name: string;
  readonly region: string;
  readonly operatorId: string;
  /** Electrical target scope, stable across equivalent transport mirrors. */
  readonly namespace: string;
  readonly parserNamespace: string;
  readonly parser: Parser;
  readonly endpoint: string;
  readonly researchBlocker: string;
  /** A known automation prohibition cannot be overridden by a caller-supplied grant. */
  readonly automationBlocked?: true;
}
/** Known parser/endpoint pairs only. This catalog grants no recurring access rights. */
export const SOURCE_PROFILES: readonly SourceProfile[] = Object.freeze([
  { sourceId: 'yasno-kem', name: 'YASNO · Київські електромережі', region: 'kyiv', operatorId: 'dtek-kem', namespace: 'yasno:25/902', parserNamespace: 'yasno:25/902', parser: 'yasno', endpoint: 'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages', researchBlocker: 'Systematic reuse/rate admission and exact binding pending.' },
  { sourceId: 'yasno-dnem', name: 'YASNO · Дніпровські електромережі', region: 'dnipropetrovsk', operatorId: 'dtek-dnem', namespace: 'yasno:3/301', parserNamespace: 'yasno:3/301', parser: 'yasno', endpoint: 'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/3/dsos/301/planned-outages', researchBlocker: 'Separate DSO; systematic reuse/rate admission and exact binding pending.' },
  { sourceId: 'yasno-cek', name: 'YASNO · ЦЕК', region: 'dnipropetrovsk', operatorId: 'cek', namespace: 'yasno:3/303', parserNamespace: 'yasno:3/303', parser: 'yasno', endpoint: 'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/3/dsos/303/planned-outages', researchBlocker: 'Separate DSO; systematic reuse/rate admission and exact binding pending.' },
  { sourceId: 'voe-mirror-vn-progr', name: 'Вінниця · громадське дзеркало', region: 'vinnytsia', operatorId: 'vinnytsia-oe', namespace: 'voe:vinnytsia', parserNamespace: 'voe:vn-progr', parser: 'hour_matrix', endpoint: 'https://raw.githubusercontent.com/vn-progr/gpv-voe-vinnytsia/main/data/Vinnytsiaoblenerho.json', researchBlocker: 'Unofficial mirror; reuse/rate and primary comparison pending.' },
  { sourceId: 'voe-mirror-olnet93', name: 'Вінниця · резервне дзеркало', region: 'vinnytsia', operatorId: 'vinnytsia-oe', namespace: 'voe:vinnytsia', parserNamespace: 'voe:olnet93', parser: 'hour_matrix', endpoint: 'https://raw.githubusercontent.com/olnet93/gpv-voe-vinnytsia/main/data/Vinnytsiaoblenerho.json', researchBlocker: 'Observed obsolete 2025 payload; not a current fallback. Reuse/rate pending.' },
  { sourceId: 'dtek-oem-official', name: 'ДТЕК Одеські електромережі', region: 'odesa', operatorId: 'dtek-oem', namespace: 'dtek:oem', parserNamespace: 'dtek:oem', parser: 'hour_matrix', endpoint: 'https://www.dtek-oem.com.ua/ua/shutdowns', researchBlocker: 'Robots disallows automation. No repeated scraping or challenge bypass.', automationBlocked: true },
  { sourceId: 'mirror-odesa', name: 'Одеса · відкрите дзеркало графіків', region: 'odesa', operatorId: 'dtek-oem', namespace: 'dtek:oem', parserNamespace: 'dtek:oem-mirror', parser: 'hour_matrix', endpoint: 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/odesa.json', researchBlocker: 'Current public payload and repository license observed8Nov; ongoing admission, independent fallback and exact binding remain separate.' },
  { sourceId: 'kharkiv-official-rss', name: 'Харківобленерго · офіційний RSS', region: 'kharkiv', operatorId: 'kharkiv-oe', namespace: 'kharkiv:rss', parserNamespace: 'kharkiv:rss', parser: 'kharkiv_rss', endpoint: 'https://oblenergo.kharkiv.ua/uk/rss.xml', researchBlocker: 'Single dated plan verified; systematic reuse/rate and exact binding pending.' },
].map(profile => Object.freeze(profile)) as SourceProfile[]);

export type SourceAdmission = {
  readonly sourceId: string;
  readonly state: 'blocked';
  readonly reason: string;
} | {
  readonly sourceId: string;
  readonly state: 'admitted';
  readonly revisionId: string;
  readonly reviewedAt: string;
  readonly validUntil: string;
  readonly accessCost: 0;
  readonly costEvidence: string;
  readonly license: { readonly systematicReuse: 'allowed'; readonly evidence: string };
  readonly automation: { readonly robots: 'allowed'; readonly evidence: string };
  readonly rate: { readonly allowed: true; readonly scope: 'origin'; readonly minIntervalMs: number; readonly evidence: string };
  readonly cacheTtlMs: number;
  readonly maxAgeMs: number;
};
/** Fresh positive evidence must be supplied by the integrating owner. No inferred approval. */
export function researchSourceRegistry(): SourceAdmission[] {
  return SOURCE_PROFILES.map(profile => ({ sourceId: profile.sourceId, state: 'blocked', reason: profile.researchBlocker }));
}
export function compatibleSourceFallback(primaryId: string, fallbackId: string): boolean {
  const a = SOURCE_PROFILES.find(p => p.sourceId === primaryId), b = SOURCE_PROFILES.find(p => p.sourceId === fallbackId);
  return Boolean(a && b && a.operatorId === b.operatorId && a.namespace === b.namespace);
}
export interface SourceIntakeRequest {
  sourceId: string;
  operatorId: string;
  namespace: string;
  targetId: string;
  serviceDate: string;
}
export interface SourceHttpRequest {
  url: string;
  method: 'GET';
  redirect: 'error';
  credentials: 'omit';
  headers: { readonly 'accept-encoding': 'identity' };
  signal: AbortSignal;
  maxBytes: number;
}
export interface SourceHttpResponse {
  /** Actual final response URL; redirect-following transports violate this contract. */
  url: string;
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Uint8Array>;
}
export type SourceHttpTransport = (request: SourceHttpRequest) => Promise<SourceHttpResponse>;
export type IntakeCode = 'UNKNOWN_SOURCE' | 'INVALID_REQUEST' | 'SOURCE_SCOPE_MISMATCH' |
  'SOURCE_NOT_ADMITTED' | 'SOURCE_ADMISSION_EXPIRED' | 'SOURCE_CLOCK_INVALID' |
  'SOURCE_BUSY' | 'SOURCE_RATE_LIMITED' | 'SOURCE_RATE_LIMIT_UNVERIFIED' |
  'SOURCE_TIMEOUT' | 'SOURCE_TRANSPORT_FAILED' | 'SOURCE_HTTP_REJECTED' |
  'SOURCE_ORIGIN_REJECTED' | 'SOURCE_BODY_LIMIT' | 'SOURCE_CONTENT_TYPE_REJECTED' |
  'SOURCE_UTF8_REJECTED' | 'SOURCE_ENCODING_REJECTED' | 'SOURCE_SCHEMA_REJECTED';
export interface IntakeProvenance {
  sourceId: string;
  admissionRevisionId: string;
  requestedUrl: string;
  responseUrl: string;
  rawSha256: string;
  rawBytes: number;
  observedAt: string;
  publishedAt: string;
  transport: 'injected_http';
}
export type SourceIntakeResult = {
  state: 'available';
  cache: 'miss' | 'fresh' | 'stale';
  view: ScheduleView;
  provenance: IntakeProvenance;
  /** A stale result never hides the failed refresh. */
  refreshFailure?: IntakeCode;
  addressBindingVerified: false;
  deliveryEligible: false;
} | {
  state: 'blocked' | 'unavailable';
  sourceId: string;
  code: IntakeCode;
  view: null;
  addressBindingVerified: false;
  deliveryEligible: false;
};
interface RawResponse { raw: string; rawSha256: string; rawBytes: number; observedAt: string; responseUrl: string }
type AllowedAdmission = Extract<SourceAdmission, { state: 'admitted' }>;
class IntakeFailure extends Error {
  readonly code: IntakeCode;
  constructor(code: IntakeCode) { super(code); this.code = code; }
}
const fail = (code: IntakeCode): never => { throw new IntakeFailure(code); };
const evidence = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= 2_048;
const integer = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const header = (headers: SourceHttpResponse['headers'], name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
function validateAdmission(entry: SourceAdmission): void {
  if (!SOURCE_PROFILES.some(p => p.sourceId === entry.sourceId)) throw new Error('UNKNOWN_SOURCE_ADMISSION');
  if (entry.state === 'blocked') { if (!evidence(entry.reason)) throw new Error('INVALID_SOURCE_ADMISSION'); return; }
  if (entry.state !== 'admitted' || !evidence(entry.revisionId) || !validInstant(entry.reviewedAt) || !validInstant(entry.validUntil) ||
      Date.parse(entry.validUntil) <= Date.parse(entry.reviewedAt) || entry.accessCost !== 0 || !evidence(entry.costEvidence) ||
      entry.license?.systematicReuse !== 'allowed' || !evidence(entry.license.evidence) ||
      entry.automation?.robots !== 'allowed' || !evidence(entry.automation.evidence) || entry.rate?.allowed !== true ||
      entry.rate.scope !== 'origin' || !evidence(entry.rate.evidence) || !integer(entry.rate.minIntervalMs, 1_000, 86_400_000) ||
      !integer(entry.cacheTtlMs, 1_000, 3_600_000) || !integer(entry.maxAgeMs, entry.cacheTtlMs, 86_400_000)) throw new Error('INVALID_SOURCE_ADMISSION');
}

/** No default fetch, file fixtures, database, jobs or import-time effects. One instance per process. */
export function createSourceIntake(options: {
  registry: readonly SourceAdmission[];
  transport: SourceHttpTransport;
  now: () => number;
  limits?: { timeoutMs?: number; maxBytes?: number; maxConcurrent?: number };
}): { load(request: SourceIntakeRequest): Promise<SourceIntakeResult> } {
  const timeoutMs = options.limits?.timeoutMs ?? 8_000, maxBytes = options.limits?.maxBytes ?? 2_000_000,
    maxConcurrent = options.limits?.maxConcurrent ?? 2;
  if (typeof options.transport !== 'function' || typeof options.now !== 'function' || !integer(timeoutMs, 1, 30_000) ||
      !integer(maxBytes, 1, 2_000_000) || !integer(maxConcurrent, 1, 4)) throw new Error('INVALID_SOURCE_INTAKE_LIMITS');
  // Copy admissions: caller mutation cannot change rights while work is running.
  const registry = new Map<string, SourceAdmission>(), originInterval = new Map<string, number>();
  for (const entry of options.registry) {
    validateAdmission(entry);
    if (registry.has(entry.sourceId)) throw new Error('DUPLICATE_SOURCE_ADMISSION');
    registry.set(entry.sourceId, structuredClone(entry));
    if (entry.state === 'admitted') {
      const origin = new URL(SOURCE_PROFILES.find(p => p.sourceId === entry.sourceId)!.endpoint).origin;
      originInterval.set(origin, Math.max(originInterval.get(origin) ?? 0, entry.rate.minIntervalMs));
    }
  }
  const cache = new Map<string, RawResponse>(), inFlight = new Map<string, Promise<RawResponse>>(),
    nextAttempt = new Map<string, number>();
  let active = 0, lastClock = -Infinity;
  function clock(): number {
    const time = options.now();
    if (!integer(time, 0, 8_640_000_000_000_000) || time < lastClock) return fail('SOURCE_CLOCK_INVALID');
    lastClock = time; return time;
  }
  function admitted(profile: SourceProfile, time: number): AllowedAdmission {
    if (profile.automationBlocked) return fail('SOURCE_NOT_ADMITTED');
    const entry = registry.get(profile.sourceId);
    if (!entry || entry.state !== 'admitted') return fail('SOURCE_NOT_ADMITTED');
    if (time < Date.parse(entry.reviewedAt) || time >= Date.parse(entry.validUntil)) return fail('SOURCE_ADMISSION_EXPIRED');
    return entry;
  }
  async function fetchRaw(profile: SourceProfile, entry: AllowedAdmission, time: number): Promise<RawResponse> {
    const flight = inFlight.get(profile.sourceId);
    if (flight) return flight;
    const rateKey = new URL(profile.endpoint).origin;
    const next = nextAttempt.get(rateKey) ?? 0;
    if (next === Infinity) return fail('SOURCE_RATE_LIMIT_UNVERIFIED');
    if (time < next) return fail('SOURCE_RATE_LIMITED');
    if (active >= maxConcurrent) return fail('SOURCE_BUSY');
    nextAttempt.set(rateKey, time + originInterval.get(rateKey)!);
    active++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Retain the slot and endpoint lock until the transport actually settles, even
    // if a nonconforming injected transport ignores abort. No timeout fan-out.
    const operation = Promise.resolve().then(async (): Promise<RawResponse> => {
      const response = await options.transport({ url: profile.endpoint, method: 'GET', redirect: 'error', credentials: 'omit', headers: { 'accept-encoding': 'identity' }, signal: controller.signal, maxBytes });
      if (controller.signal.aborted) return fail('SOURCE_TIMEOUT');
      if (response.url !== profile.endpoint) return fail('SOURCE_ORIGIN_REJECTED');
      if (response.status === 429) {
        const rawRetry = header(response.headers, 'retry-after');
        if (typeof rawRetry === 'string' && /^[1-9]\d{0,4}$/.test(rawRetry) && Number(rawRetry) <= 86_400)
          nextAttempt.set(rateKey, Math.max(nextAttempt.get(rateKey) ?? 0, clock() + Number(rawRetry) * 1_000));
        else nextAttempt.set(rateKey, Infinity);
        return fail(rawRetry && /^[1-9]\d{0,4}$/.test(rawRetry) && Number(rawRetry) <= 86_400 ? 'SOURCE_RATE_LIMITED' : 'SOURCE_RATE_LIMIT_UNVERIFIED');
      }
      if (response.status !== 200) return fail('SOURCE_HTTP_REJECTED');
      const encoding = header(response.headers, 'content-encoding');
      if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') return fail('SOURCE_ENCODING_REJECTED');
      const type = (header(response.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
      const accepted = profile.parser === 'yasno' || profile.parser === 'hour_matrix' && profile.parserNamespace !== 'dtek:oem'
        ? ['application/json'] : profile.parser === 'kharkiv_rss'
          ? ['application/rss+xml', 'application/xml', 'text/xml'] : ['text/html'];
      if (!accepted.includes(type)) return fail('SOURCE_CONTENT_TYPE_REJECTED');
      const size = header(response.headers, 'content-length');
      if (size !== undefined && (!/^\d+$/.test(size) || Number(size) > maxBytes)) return fail('SOURCE_BODY_LIMIT');
      const chunks: Uint8Array[] = []; let total = 0;
      for await (const chunk of response.body) {
        if (controller.signal.aborted) return fail('SOURCE_TIMEOUT');
        if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunks.length >= 4_096 || chunk.byteLength > maxBytes - total) return fail('SOURCE_BODY_LIMIT');
        total += chunk.byteLength; chunks.push(Uint8Array.from(chunk));
      }
      if (!total || size !== undefined && Number(size) !== total) return fail('SOURCE_BODY_LIMIT');
      const bytes = Buffer.concat(chunks, total);
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('SOURCE_UTF8_REJECTED'); }
      const observed = clock(); admitted(profile, observed);
      const output = { raw, rawSha256: sha(bytes), rawBytes: total, observedAt: new Date(observed).toISOString(), responseUrl: response.url };
      if (controller.signal.aborted) return fail('SOURCE_TIMEOUT');
      return output;
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new IntakeFailure('SOURCE_TIMEOUT')); }, timeoutMs);
    });
    const bounded = Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
    inFlight.set(profile.sourceId, bounded);
    const cleanup = () => { controller.abort(); active--; if (inFlight.get(profile.sourceId) === bounded) inFlight.delete(profile.sourceId); };
    void operation.then(cleanup, cleanup);
    return bounded;
  }
  function project(profile: SourceProfile, entry: AllowedAdmission, raw: RawResponse, request: SourceIntakeRequest,
    time: number, cacheState: 'miss' | 'fresh' | 'stale', refreshFailure?: IntakeCode): SourceIntakeResult {
    admitted(profile, time);
    const age = time - Date.parse(raw.observedAt);
    if (age < 0) return fail('SOURCE_CLOCK_INVALID');
    const currentDate = localParts(time).date;
    const freshness = cacheState === 'stale' || age > entry.maxAgeMs || ![currentDate, nextCalendarDate(currentDate)].includes(request.serviceDate)
      ? 'stale' as const : 'current' as const;
    const source: SourceReference = { id: profile.sourceId, name: profile.name, url: profile.endpoint, revision: raw.rawSha256, accessCost: 0, verifiedLevel: 'schedule' };
    const context = { operatorId: profile.operatorId, targetId: request.targetId, serviceDate: request.serviceDate,
      addressId: `unbound:${profile.operatorId}:${profile.namespace}:${request.targetId}`, addressLabel: `Технічна група ${request.targetId.replace(/^GPV/, '')}`,
      localityLabel: profile.region, source, observedAt: raw.observedAt, freshness, synthetic: false };
    let view: ScheduleView;
    try {
      if (profile.parser === 'yasno') {
        const payload = JSON.parse(raw.raw), target = Object.hasOwn(payload, request.targetId) ? payload[request.targetId] : null;
        const days = (['today', 'tomorrow'] as const).filter(day => target && validInstant(target[day]?.date) && target[day].date.slice(0, 10) === request.serviceDate);
        if (days.length !== 1) return fail('SOURCE_SCHEMA_REJECTED');
        view = normalizeYasnoRaw(raw.raw, days[0], { ...context, namespace: profile.parserNamespace as 'yasno:25/902' | 'yasno:3/301' | 'yasno:3/303' });
      } else if (profile.parser === 'hour_matrix') {
        view = normalizeHourMatrix(raw.raw, { ...context, namespace: profile.parserNamespace as 'voe:vn-progr' | 'voe:olnet93' | 'dtek:oem' | 'dtek:oem-mirror' });
      } else view = normalizeKharkivRss(raw.raw, { ...context, operatorId: 'kharkiv-oe', namespace: 'kharkiv:rss' });
      if (!view.publishedAt || view.operatorId !== request.operatorId || view.namespace !== request.namespace || view.targetId !== request.targetId ||
          view.serviceDate !== request.serviceDate || view.source.revision !== raw.rawSha256) return fail('SOURCE_SCHEMA_REJECTED');
      validateScheduleView(view);
    } catch { return fail('SOURCE_SCHEMA_REJECTED'); }
    return { state: 'available', cache: cacheState, view, provenance: { sourceId: profile.sourceId, admissionRevisionId: entry.revisionId,
      requestedUrl: profile.endpoint, responseUrl: raw.responseUrl, rawSha256: raw.rawSha256, rawBytes: raw.rawBytes,
      observedAt: raw.observedAt, publishedAt: view.publishedAt!, transport: 'injected_http' },
      ...(refreshFailure ? { refreshFailure } : {}), addressBindingVerified: false, deliveryEligible: false };
  }
  return Object.freeze({ async load(input: SourceIntakeRequest): Promise<SourceIntakeResult> {
    const request = { ...input };
    try {
      if (!request || typeof request.sourceId !== 'string') return fail('INVALID_REQUEST');
      const profile = SOURCE_PROFILES.find(p => p.sourceId === request.sourceId);
      if (!profile) return fail('UNKNOWN_SOURCE');
      if (request.operatorId !== profile.operatorId || request.namespace !== profile.namespace) return fail('SOURCE_SCOPE_MISMATCH');
      if (typeof request.serviceDate !== 'string' || typeof request.targetId !== 'string' ||
          !(profile.parser === 'hour_matrix' ? /^GPV[1-6]\.[12]$/ : profile.parser === 'kharkiv_rss' ? /^[1-6]\.[12]$/ : /^\d+\.\d+$/).test(request.targetId)) return fail('INVALID_REQUEST');
      try { calendarDate(request.serviceDate); } catch { return fail('INVALID_REQUEST'); }
      const time = clock(), entry = admitted(profile, time), existing = cache.get(profile.sourceId);
      if (existing && time - Date.parse(existing.observedAt) <= entry.cacheTtlMs)
        return project(profile, entry, existing, request, time, 'fresh');
      let raw: RawResponse;
      try { raw = await fetchRaw(profile, entry, time); }
      catch (error) {
        const code = error instanceof IntakeFailure ? error.code : 'SOURCE_TRANSPORT_FAILED';
        const checkedNow = clock(); admitted(profile, checkedNow);
        if (existing) return project(profile, entry, existing, request, checkedNow, 'stale', code);
        return fail(code);
      }
      try {
        const result = project(profile, entry, raw, request, clock(), 'miss');
        // A malformed/new response cannot destroy the previous parsed-good raw cache.
        cache.set(profile.sourceId, raw); return result;
      } catch (error) {
        if (existing) return project(profile, entry, existing, request, clock(), 'stale',
          error instanceof IntakeFailure ? error.code : 'SOURCE_SCHEMA_REJECTED');
        throw error;
      }
    } catch (error) {
      const code = error instanceof IntakeFailure ? error.code : 'SOURCE_TRANSPORT_FAILED';
      return { state: ['SOURCE_NOT_ADMITTED', 'SOURCE_ADMISSION_EXPIRED', 'SOURCE_SCOPE_MISMATCH'].includes(code) ? 'blocked' : 'unavailable',
        sourceId: typeof request.sourceId === 'string' ? request.sourceId : '', code, view: null, addressBindingVerified: false, deliveryEligible: false };
    }
  } });
}
