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
  { sourceId: 'dtek-oem-official', name: 'ДТЕК Одеські електромережі', region: 'odesa', operatorId: 'dtek-oem', namespace: 'dtek:oem', parserNamespace: 'dtek:oem', parser: 'hour_matrix', endpoint: 'https://www.dtek-oem.com.ua/ua/shutdowns', researchBlocker: '9Nov current robots wildcardDisallow:/ confirmed by raw76c4269f170650b9c17b7abce80368d1331edc3434f5958edf9f7a53fe6dd991. HTML200 proves plan availability, not automation permission. No repeated scraping or challenge bypass.', automationBlocked: true },
  { sourceId: 'mirror-odesa', name: 'Одеса · відкрите дзеркало графіків', region: 'odesa', operatorId: 'dtek-oem', namespace: 'dtek:oem', parserNamespace: 'dtek:oem-mirror', parser: 'hour_matrix', endpoint: 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/odesa.json', researchBlocker: '9Nov official/mirror288cell point comparison admits only matched date/target semantics; changed plans need new comparison. Independent fallback,48h and exact binding remain unverified.' },
  { sourceId: 'kharkiv-official-rss', name: 'Харківобленерго · офіційний RSS', region: 'kharkiv', operatorId: 'kharkiv-oe', namespace: 'kharkiv:rss', parserNamespace: 'kharkiv:rss', parser: 'kharkiv_rss', endpoint: 'https://oblenergo.kharkiv.ua/uk/rss.xml', researchBlocker: 'Single dated plan verified; systematic reuse/rate and exact binding pending.' },
].map(profile => Object.freeze(profile)) as SourceProfile[]);

type ContractSourceAdmission = {
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
/** Local operational decision for published factual group plans. This is explicitly
 * not a provider-issued license/quota, address certification, or delivery grant.
 */
export interface TechnicalDisplayAdmission {
  readonly sourceId:string;
  readonly state:'technical_display';
  readonly revisionId:string;readonly reviewedAt:string;readonly validUntil:string;
  readonly accessCost:0;readonly costEvidence:string;
  readonly publicationBasis:{readonly kind:'official_public_feed'|'publisher_public_syndication';readonly evidence:string};
  readonly formalPrimaryDataLicense:'not_observed';
  readonly robots:{readonly status:'not_disallowed'|'unreadable_html'|'not_checked';readonly evidence:string};
  readonly providerQuota:'not_published_in_reviewed_sources';
  readonly rate:{readonly kind:'local_operating_budget';readonly scope:'origin';readonly minIntervalMs:number;readonly evidence:string};
  readonly cacheTtlMs:number;readonly maxAgeMs:number;
  readonly addressBindingVerified:false;readonly deliveryEligible:false;
  readonly parallel48hAccepted:false;readonly independentFallbackVerified:false;
  /** A point comparison admits only the compared date/target semantics. Raw
   * collector metadata may change; a changed plan needs a new comparison. */
  readonly semanticScope?:{
    readonly serviceDate:string;
    readonly comparisonSha256:string;readonly officialRawSha256:string;readonly mirrorRawSha256:string;
    readonly targetPlanSha256s:Readonly<Record<string,string>>;
  };
  /** Reviewed official publication, not a permanent source-wide admission.
   * Unrelated RSS news may change the raw envelope without changing this item. */
  readonly publicationScope?:{
    readonly serviceDate:string;readonly itemUrl:string;readonly publishedAt:string;
    readonly rawCaptureSha256:string;readonly noticeSha256:string;
    readonly targetPlanSha256s:Readonly<Record<string,string>>;
  };
}
export type SourceAdmission=ContractSourceAdmission|TechnicalDisplayAdmission;
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
  operatingAdmission?:{scope:'technical_group_display';publicationBasis:TechnicalDisplayAdmission['publicationBasis']['kind'];formalPrimaryDataLicense:'not_observed';providerQuota:'not_published_in_reviewed_sources'};
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
/** HTTP-envelope validation alone is not semantic acceptance. Persist privately in
 * the public-source cache; only projectSnapshot successful views reach consumers. */
export interface CapturedPublicSourceRaw extends RawResponse {
  sourceId: string;
  admissionRevisionId: string;
  requestedUrl: string;
  semanticValidation: 'pending';
}
export interface SourceIntake {
  load(request: SourceIntakeRequest): Promise<SourceIntakeResult>;
  snapshotRaw(sourceId: string): CapturedPublicSourceRaw | null;
  projectSnapshot(request: SourceIntakeRequest, snapshot: CapturedPublicSourceRaw,
    options?: {stale?: boolean; refreshFailure?: IntakeCode}): SourceIntakeResult;
}
type AllowedAdmission = Exclude<SourceAdmission, { state: 'blocked' }>;
class IntakeFailure extends Error {
  readonly code: IntakeCode;
  constructor(code: IntakeCode) { super(code); this.code = code; }
}
const fail = (code: IntakeCode): never => { throw new IntakeFailure(code); };
const evidence = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= 2_048;
const integer = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** Excludes observation/publication/collector metadata and source attribution;
 * includes the complete normalized electrical plan for this exact target/day. */
export function technicalPlanSha256(view:ScheduleView):string {
  // Stale is an observation label, not a changed electrical matrix. This scope
  // is restricted to hour-matrix plans, whose underlying state is determined
  // by coverage and interval kinds; it never certifies an emergency overlay.
  const status=view.status==='stale'?(view.dayCoverage==='none'?'not_published':view.intervals.some(i=>i.kind==='planned_outage')?'published':view.intervals.length?'possible':'no_planned_outages'):view.status;
  return sha(JSON.stringify({operatorId:view.operatorId,namespace:view.namespace,targetId:view.targetId,serviceDate:view.serviceDate,
    status,dayCoverage:view.dayCoverage,intervals:view.intervals.map(i=>({startsAt:i.startsAt,endsAt:i.endsAt,kind:i.kind}))}));
}
const intakeCodes = new Set(['UNKNOWN_SOURCE','INVALID_REQUEST','SOURCE_SCOPE_MISMATCH','SOURCE_NOT_ADMITTED','SOURCE_ADMISSION_EXPIRED','SOURCE_CLOCK_INVALID','SOURCE_BUSY','SOURCE_RATE_LIMITED','SOURCE_RATE_LIMIT_UNVERIFIED','SOURCE_TIMEOUT','SOURCE_TRANSPORT_FAILED','SOURCE_HTTP_REJECTED','SOURCE_ORIGIN_REJECTED','SOURCE_BODY_LIMIT','SOURCE_CONTENT_TYPE_REJECTED','SOURCE_UTF8_REJECTED','SOURCE_ENCODING_REJECTED','SOURCE_SCHEMA_REJECTED']);
const header = (headers: SourceHttpResponse['headers'], name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
function validateAdmission(entry: SourceAdmission): void {
  if (!SOURCE_PROFILES.some(p => p.sourceId === entry.sourceId)) throw new Error('UNKNOWN_SOURCE_ADMISSION');
  if (entry.state === 'blocked') { if (!evidence(entry.reason)) throw new Error('INVALID_SOURCE_ADMISSION'); return; }
  if(entry.state==='technical_display'){
    const profile=SOURCE_PROFILES.find(p=>p.sourceId===entry.sourceId)!;
    const official=profile.parser==='yasno'||profile.parser==='kharkiv_rss';
    if(!evidence(entry.revisionId)||!validInstant(entry.reviewedAt)||!validInstant(entry.validUntil)||Date.parse(entry.validUntil)<=Date.parse(entry.reviewedAt)||
      entry.accessCost!==0||!evidence(entry.costEvidence)||entry.publicationBasis?.kind!==(official?'official_public_feed':'publisher_public_syndication')||!evidence(entry.publicationBasis.evidence)||
      entry.formalPrimaryDataLicense!=='not_observed'||entry.providerQuota!=='not_published_in_reviewed_sources'||
      !['not_disallowed','unreadable_html','not_checked'].includes(entry.robots?.status)||!evidence(entry.robots.evidence)||
      entry.robots.status==='unreadable_html'&&profile.parser!=='yasno'||entry.robots.status==='not_checked'&&official||
      entry.rate?.kind!=='local_operating_budget'||entry.rate.scope!=='origin'||!evidence(entry.rate.evidence)||!integer(entry.rate.minIntervalMs,1000,86400000)||
      !integer(entry.cacheTtlMs,1000,3600000)||!integer(entry.maxAgeMs,entry.cacheTtlMs,86400000)||entry.addressBindingVerified!==false||entry.deliveryEligible!==false||
      entry.parallel48hAccepted!==false||entry.independentFallbackVerified!==false)throw Error('INVALID_TECHNICAL_SOURCE_ADMISSION');
    const scope=entry.semanticScope,hash64=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
    if(entry.sourceId==='mirror-odesa'){
      const targets=Array.from({length:6},(_,i)=>[`GPV${i+1}.1`,`GPV${i+1}.2`]).flat();
      if(!scope||!/^\d{4}-\d{2}-\d{2}$/.test(scope.serviceDate)||!hash64(scope.comparisonSha256)||!hash64(scope.officialRawSha256)||!hash64(scope.mirrorRawSha256)||
        !scope.targetPlanSha256s||Object.keys(scope.targetPlanSha256s).length!==targets.length||targets.some(target=>!hash64(scope.targetPlanSha256s[target])))throw Error('INVALID_TECHNICAL_SOURCE_SCOPE');
      try{calendarDate(scope.serviceDate);}catch{throw Error('INVALID_TECHNICAL_SOURCE_SCOPE');}
    }else if(scope!==undefined)throw Error('INVALID_TECHNICAL_SOURCE_SCOPE');
    const publication=entry.publicationScope;
    if(entry.sourceId==='kharkiv-official-rss'){
      const targets=Array.from({length:6},(_,i)=>[`${i+1}.1`,`${i+1}.2`]).flat();
      if(!publication||!validInstant(publication.publishedAt)||!/^https:\/\/oblenergo\.kharkiv\.ua\/uk\/node\/\d+$/.test(publication.itemUrl)||
        !hash64(publication.rawCaptureSha256)||!hash64(publication.noticeSha256)||!publication.targetPlanSha256s||Object.keys(publication.targetPlanSha256s).length!==targets.length||targets.some(target=>!hash64(publication.targetPlanSha256s[target])))throw Error('INVALID_TECHNICAL_PUBLICATION_SCOPE');
      try{calendarDate(publication.serviceDate);}catch{throw Error('INVALID_TECHNICAL_PUBLICATION_SCOPE');}
      if(Date.parse(publication.publishedAt)>Date.parse(entry.reviewedAt))throw Error('INVALID_TECHNICAL_PUBLICATION_SCOPE');
    }else if(publication!==undefined)throw Error('INVALID_TECHNICAL_PUBLICATION_SCOPE');
    return;
  }
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
}): SourceIntake {
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
    if (entry.state !== 'blocked') {
      const origin = new URL(SOURCE_PROFILES.find(p => p.sourceId === entry.sourceId)!.endpoint).origin;
      originInterval.set(origin, Math.max(originInterval.get(origin) ?? 0, entry.rate.minIntervalMs));
    }
  }
  const captures = new Map<string, CapturedPublicSourceRaw>();
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
    if (!entry || entry.state === 'blocked') return fail('SOURCE_NOT_ADMITTED');
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
      const pinnedGithubJson = ['voe-mirror-vn-progr','voe-mirror-olnet93','mirror-odesa'].includes(profile.sourceId) &&
        profile.parser === 'hour_matrix' && new URL(profile.endpoint).hostname === 'raw.githubusercontent.com' && profile.endpoint.endsWith('.json');
      const accepted = pinnedGithubJson ? ['application/json', 'text/plain'] : profile.parser === 'yasno' || profile.parser === 'hour_matrix' && profile.parserNamespace !== 'dtek:oem'
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
      captures.set(profile.sourceId, { ...output, sourceId: profile.sourceId, admissionRevisionId: entry.revisionId,
        requestedUrl: profile.endpoint, semanticValidation: 'pending' });
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
      if(entry.state==='technical_display'&&entry.semanticScope){
        const scope=entry.semanticScope;
        if(request.serviceDate!==scope.serviceDate||!Object.hasOwn(scope.targetPlanSha256s,request.targetId)||
          technicalPlanSha256(view)!==scope.targetPlanSha256s[request.targetId])return fail('SOURCE_SCHEMA_REJECTED');
      }
      if(entry.state==='technical_display'&&entry.publicationScope){
        const scope=entry.publicationScope;
        if(request.serviceDate!==scope.serviceDate||view.source.url!==scope.itemUrl||view.publishedAt!==scope.publishedAt||
          !Object.hasOwn(scope.targetPlanSha256s,request.targetId)||technicalPlanSha256(view)!==scope.targetPlanSha256s[request.targetId]||sha(view.notice??'')!==scope.noticeSha256)
          return fail('SOURCE_SCHEMA_REJECTED');
      }
    } catch { return fail('SOURCE_SCHEMA_REJECTED'); }
    return { state: 'available', cache: cacheState, view, provenance: { sourceId: profile.sourceId, admissionRevisionId: entry.revisionId,
      requestedUrl: profile.endpoint, responseUrl: raw.responseUrl, rawSha256: raw.rawSha256, rawBytes: raw.rawBytes,
      observedAt: raw.observedAt, publishedAt: view.publishedAt!, transport: 'injected_http',
      ...(entry.state==='technical_display'?{operatingAdmission:{scope:'technical_group_display' as const,publicationBasis:entry.publicationBasis.kind,formalPrimaryDataLicense:'not_observed' as const,providerQuota:'not_published_in_reviewed_sources' as const}}:{}) },
      ...(refreshFailure ? { refreshFailure } : {}), addressBindingVerified: false, deliveryEligible: false };
  }
  function checkedRequest(request: SourceIntakeRequest): SourceProfile {
    if (!request || typeof request.sourceId !== 'string') return fail('INVALID_REQUEST');
    const profile = SOURCE_PROFILES.find(p => p.sourceId === request.sourceId);
    if (!profile) return fail('UNKNOWN_SOURCE');
    if (request.operatorId !== profile.operatorId || request.namespace !== profile.namespace) return fail('SOURCE_SCOPE_MISMATCH');
    if (typeof request.serviceDate !== 'string' || typeof request.targetId !== 'string' ||
        !(profile.parser === 'hour_matrix' ? /^GPV[1-6]\.[12]$/ : profile.parser === 'kharkiv_rss' ? /^[1-6]\.[12]$/ : /^\d+\.\d+$/).test(request.targetId)) return fail('INVALID_REQUEST');
    try { calendarDate(request.serviceDate); } catch { return fail('INVALID_REQUEST'); }
    return profile;
  }
  function rejected(request: SourceIntakeRequest, error: unknown): SourceIntakeResult {
    const code = error instanceof IntakeFailure ? error.code : 'SOURCE_TRANSPORT_FAILED';
    return {state: ['SOURCE_NOT_ADMITTED','SOURCE_ADMISSION_EXPIRED','SOURCE_SCOPE_MISMATCH'].includes(code) ? 'blocked' : 'unavailable',
      sourceId: typeof request?.sourceId === 'string' ? request.sourceId : '', code, view: null, addressBindingVerified: false, deliveryEligible: false};
  }
  return Object.freeze({
    snapshotRaw(sourceId: string) { const value = captures.get(sourceId); return value ? structuredClone(value) : null; },
    projectSnapshot(input: SourceIntakeRequest, snapshot: CapturedPublicSourceRaw, flags: {stale?: boolean; refreshFailure?: IntakeCode} = {}) {
      const request = {...input};
      try {
        const profile = checkedRequest(request), time = clock(), entry = admitted(profile, time);
        const allowed = ['raw','rawSha256','rawBytes','observedAt','responseUrl','sourceId','admissionRevisionId','requestedUrl','semanticValidation'];
        if (!snapshot || typeof snapshot !== 'object' || Object.keys(snapshot).length !== allowed.length || Object.keys(snapshot).some(k => !allowed.includes(k)) ||
          snapshot.sourceId !== profile.sourceId || snapshot.admissionRevisionId !== entry.revisionId || snapshot.requestedUrl !== profile.endpoint ||
          snapshot.responseUrl !== profile.endpoint || snapshot.semanticValidation !== 'pending' || typeof snapshot.raw !== 'string' ||
          !integer(snapshot.rawBytes,1,maxBytes) || Buffer.byteLength(snapshot.raw,'utf8') !== snapshot.rawBytes || snapshot.rawSha256 !== sha(snapshot.raw) ||
          !validInstant(snapshot.observedAt) || Date.parse(snapshot.observedAt) < Date.parse(entry.reviewedAt) || Date.parse(snapshot.observedAt) > time ||
          !flags || typeof flags !== 'object' || Object.keys(flags).some(k => !['stale','refreshFailure'].includes(k)) || flags.stale !== undefined && typeof flags.stale !== 'boolean' ||
          flags.refreshFailure !== undefined && (typeof flags.refreshFailure !== 'string' || !intakeCodes.has(flags.refreshFailure)))
          return fail('SOURCE_SCHEMA_REJECTED');
        return project(profile,entry,{...snapshot},request,time,flags.stale ? 'stale' : 'fresh',flags.refreshFailure);
      } catch (error) { return rejected(request,error); }
    },
    async load(input: SourceIntakeRequest): Promise<SourceIntakeResult> {
    const request = { ...input };
    try {
      const profile = checkedRequest(request);
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
      return rejected(request,error);
    }
  } });
}
