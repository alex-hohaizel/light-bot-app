import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dayBounds } from '../../shared/schedule-core.ts';
import { SOURCE_PROFILES, researchSourceRegistry, compatibleSourceFallback, createSourceIntake,
  type SourceAdmission, type SourceIntakeRequest, type SourceIntakeResult, type SourceHttpResponse,
  type SourceHttpTransport } from '../../server/production/source-intake.ts';

const date = '2026-11-08', initial = Date.parse('2026-11-08T10:00:00Z');
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const allowed = (sourceId = 'yasno-kem'): Extract<SourceAdmission, { state: 'admitted' }> => ({
  sourceId, state: 'admitted', revisionId: 'test-only-admission-not-real-rights',
  reviewedAt: '2026-11-08T00:00:00Z', validUntil: '2026-11-10T00:00:00Z', accessCost: 0,
  costEvidence: 'unit-test-only:zero-cost', license: { systematicReuse: 'allowed', evidence: 'unit-test-only:license' },
  automation: { robots: 'allowed', evidence: 'unit-test-only:robots' },
  rate: { allowed: true, scope: 'origin', minIntervalMs: 1_000, evidence: 'unit-test-only:rate' },
  cacheTtlMs: 1_000, maxAgeMs: 60_000,
});
const request = (sourceId = 'yasno-kem', targetId = '1.1', serviceDate = date): SourceIntakeRequest => {
  const profile = SOURCE_PROFILES.find(p => p.sourceId === sourceId)!;
  return { sourceId, operatorId: profile.operatorId, namespace: profile.namespace, targetId, serviceDate };
};
function yasno(status = 'ScheduleApplies', tomorrowStatus = 'WaitingForSchedule'): string {
  return JSON.stringify(Object.fromEntries(['1.1', '1.2'].map(key => [key, {
    updatedOn: '2026-11-08T08:00:00+02:00',
    today: { date: `${date}T00:00:00+02:00`, status, slots: [{ start: 0, end: 120, type: 'NotPlanned' }, { start: 120, end: 240, type: 'Definite' }, { start: 240, end: 1440, type: 'NotPlanned' }] },
    tomorrow: { date: '2026-11-09T00:00:00+02:00', status: tomorrowStatus, slots: [{ start: 0, end: 1440, type: 'NotPlanned' }] },
  }])));
}
function matrix(allYes = false): string {
  const groups = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`GPV${Math.floor(index / 2) + 1}.${index % 2 + 1}`,
    Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [String(hour + 1), !allYes && hour >= 9 && hour < 12 ? 'no' : 'yes']))]));
  const start = String(dayBounds(date).start / 1000);
  return JSON.stringify({ regionId: 'vinnytsia', fact: { today: Number(start), update: '08.11.2026 08:00', data: { [start]: groups } }, preset: {} });
}
function kharkiv(): string {
  const table = Array.from({ length: 12 }, (_, index) => `${Math.floor(index / 2) + 1}.${index % 2 + 1} 09:00 - 12:00`).join('<br/>');
  return `<rss><channel><item><title>У Харківській області 8 листопада діятимуть графіки погодинних відключень</title><link>https://oblenergo.kharkiv.ua/uk/node/123456</link><pubDate>Sun, 08 Nov 2026 08:00:00 +0200</pubDate><description><![CDATA[<p>у Харківській області будуть діяти графіки погодинних відключень у неділю, 8 листопада, з 00:00 до 24:00</p><p>Години відсутності електропостачання</p>${table}]]></description></item></channel></rss>`;
}
async function* body(raw: string | Uint8Array) { yield typeof raw === 'string' ? Buffer.from(raw) : raw; }
function response(sourceId: string, raw: string | Uint8Array, extra: Partial<SourceHttpResponse> = {}): SourceHttpResponse {
  const profile = SOURCE_PROFILES.find(p => p.sourceId === sourceId)!;
  return { url: profile.endpoint, status: 200, headers: { 'content-type': profile.parser === 'kharkiv_rss' ? 'application/rss+xml' : 'application/json' }, body: body(raw), ...extra };
}
function available(result: SourceIntakeResult) {
  assert.equal(result.state, 'available');
  if (result.state !== 'available') throw new Error('UNEXPECTED_TEST_RESULT');
  return result;
}
function failure(result: SourceIntakeResult, code: string) {
  assert.notEqual(result.state, 'available');
  if (result.state === 'available') throw new Error('UNEXPECTED_TEST_RESULT');
  assert.equal(result.code, code); assert.equal(result.view, null); assert.equal(result.deliveryEligible, false);
}

test('default research registry keeps four regions and additional known DSOs blocked; construction performs no transport', async () => {
  let calls = 0;
  const intake = createSourceIntake({ registry: researchSourceRegistry(), now: () => initial, transport: async () => { calls++; throw new Error('MUST_NOT_RUN'); } });
  for (const region of ['kyiv', 'vinnytsia', 'odesa', 'kharkiv']) assert(SOURCE_PROFILES.some(p => p.region === region));
  for (const profile of SOURCE_PROFILES) failure(await intake.load(request(profile.sourceId, profile.parser === 'hour_matrix' ? 'GPV1.1' : '1.1')), 'SOURCE_NOT_ADMITTED');
  assert.equal(calls, 0);
});
test('admission is explicit zero-cost/license/robots/rate, copied, unique, and expires before HTTP', async () => {
  for (const patch of [{ accessCost: 1 }, { costEvidence: '' }, { license: { systematicReuse: 'pending', evidence: 'unit' } },
    { automation: { robots: 'disallowed', evidence: 'unit' } }, { rate: { allowed: true, minIntervalMs: 1_000, evidence: 'unit' } }, { cacheTtlMs: 0 }]) {
    assert.throws(() => createSourceIntake({ registry: [{ ...allowed(), ...patch } as SourceAdmission], transport: async () => response('yasno-kem', yasno()), now: () => initial }), /INVALID_SOURCE_ADMISSION/);
  }
  assert.throws(() => createSourceIntake({ registry: [allowed(), allowed()], transport: async () => response('yasno-kem', yasno()), now: () => initial }), /DUPLICATE/);
  let calls = 0;
  const admission = allowed(), intake = createSourceIntake({ registry: [admission], transport: async () => { calls++; return response('yasno-kem', yasno()); }, now: () => Date.parse('2026-11-11T00:00:00Z') });
  (admission as { validUntil: string }).validUntil = '2027-01-01T00:00:00Z';
  failure(await intake.load(request()), 'SOURCE_ADMISSION_EXPIRED'); assert.equal(calls, 0);
});
test('known Odesa robots prohibition stays blocked even if a caller invents a generic positive admission', async () => {
  let calls = 0;
  const intake = createSourceIntake({ registry: [allowed('dtek-oem-official')], now: () => initial,
    transport: async () => { calls++; throw new Error('MUST_NOT_SCRAPE'); } });
  failure(await intake.load(request('dtek-oem-official', 'GPV1.1')), 'SOURCE_NOT_ADMITTED'); assert.equal(calls, 0);
});
test('source/operator/namespace/target/date is exact; fallback never crosses a DSO', async () => {
  let calls = 0;
  const intake = createSourceIntake({ registry: [allowed()], now: () => initial, transport: async () => { calls++; return response('yasno-kem', yasno()); } });
  for (const patch of [{ operatorId: 'kharkiv-oe' }, { namespace: 'yasno:3/301' }]) failure(await intake.load({ ...request(), ...patch }), 'SOURCE_SCOPE_MISMATCH');
  for (const patch of [{ targetId: '1.1/../../x' }, { serviceDate: '2026-02-30' }, { serviceDate: '' }]) failure(await intake.load({ ...request(), ...patch }), 'INVALID_REQUEST');
  assert.equal(calls, 0); assert.equal(compatibleSourceFallback('voe-mirror-vn-progr', 'voe-mirror-olnet93'), true);
  for (const other of ['yasno-dnem', 'yasno-cek', 'kharkiv-official-rss', 'dtek-oem-official']) assert.equal(compatibleSourceFallback('yasno-kem', other), false);
});
test('YASNO raw response yields exact hashed provenance and current technical schedule, never personal delivery', async () => {
  const raw = yasno(); let calls = 0;
  const intake = createSourceIntake({ registry: [allowed()], now: () => initial, transport: async input => {
    calls++; assert.equal(input.method, 'GET'); assert.equal(input.redirect, 'error'); assert.equal(input.credentials, 'omit'); assert.equal(input.maxBytes, 2_000_000);
    return response('yasno-kem', raw);
  } });
  const result = available(await intake.load(request()));
  assert.equal(result.cache, 'miss'); assert.equal(result.view.status, 'published'); assert.equal(result.view.freshness, 'current');
  assert.equal(result.provenance.rawSha256, hash(raw)); assert.equal(result.view.source.revision, hash(raw));
  assert.equal(result.provenance.rawBytes, Buffer.byteLength(raw)); assert.equal(result.provenance.observedAt, '2026-11-08T10:00:00.000Z');
  assert.equal(result.provenance.publishedAt, '2026-11-08T08:00:00+02:00'); assert(result.view.addressId.startsWith('unbound:'));
  assert.equal(result.view.deliveryEligible, false); assert.equal(result.addressBindingVerified, false); assert.equal(result.view.synthetic, false);
  result.view.intervals.length = 0;
  const cached = available(await intake.load(request())); assert.equal(cached.cache, 'fresh'); assert.equal(cached.view.intervals.length, 1); assert.equal(calls, 1);
});
test('tomorrow WaitingForSchedule placeholder and absent future dates never become fake no-outages', async () => {
  const intake = createSourceIntake({ registry: [allowed()], now: () => initial, transport: async () => response('yasno-kem', yasno()) });
  const tomorrow = available(await intake.load(request('yasno-kem', '1.1', '2026-11-09')));
  assert.equal(tomorrow.view.status, 'not_published'); assert.equal(tomorrow.view.dayCoverage, 'none'); assert.deepEqual(tomorrow.view.intervals, []);
  failure(await intake.load(request('yasno-kem', '1.1', '2026-11-10')), 'SOURCE_SCHEMA_REJECTED');
  failure(await intake.load(request('yasno-kem', '99.9')), 'SOURCE_SCHEMA_REJECTED');
});
test('strict VOE hour matrix and Kharkiv RSS adapters retain their own electrical scope', async () => {
  for (const [sourceId, raw, target] of [['voe-mirror-vn-progr', matrix(), 'GPV1.1'], ['kharkiv-official-rss', kharkiv(), '1.1']] as const) {
    const intake = createSourceIntake({ registry: [allowed(sourceId)], now: () => initial, transport: async () => response(sourceId, raw) });
    const result = available(await intake.load(request(sourceId, target)));
    assert.equal(result.view.namespace, request(sourceId, target).namespace); assert.equal(result.view.operatorId, request(sourceId, target).operatorId);
    assert.equal(result.view.status, 'published'); assert.equal(result.view.intervals.length, 1); assert.equal(result.provenance.rawSha256, hash(raw));
  }
  const empty = createSourceIntake({ registry: [allowed('voe-mirror-vn-progr')], now: () => initial, transport: async () => response('voe-mirror-vn-progr', matrix(true)) });
  assert.equal(available(await empty.load(request('voe-mirror-vn-progr', 'GPV1.1'))).view.status, 'not_published');
});
test('same endpoint concurrent different targets share one bounded fetch but receive separate projections', async () => {
  let release!: (response: SourceHttpResponse) => void, calls = 0;
  const intake = createSourceIntake({ registry: [allowed()], now: () => initial, transport: async () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const a = intake.load(request()), b = intake.load(request('yasno-kem', '1.2'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release(response('yasno-kem', yasno()));
  const [one, two] = await Promise.all([a, b]); assert.equal(available(one).view.targetId, '1.1'); assert.equal(available(two).view.targetId, '1.2');
});
test('failed refresh and malformed replacement retain prior exact-date snapshot as stale, without overwriting its raw hash', async () => {
  let now = initial, mode = 0;
  const intake = createSourceIntake({ registry: [allowed()], now: () => now, transport: async () => {
    if (mode === 1) throw new Error('private transport details MUST NOT LEAK');
    return response('yasno-kem', mode === 2 ? '{}' : yasno());
  } });
  const first = available(await intake.load(request()));
  for (mode of [1, 2]) {
    now += 2_000; const stale = available(await intake.load(request()));
    assert.equal(stale.cache, 'stale'); assert.equal(stale.view.status, 'stale'); assert.equal(stale.view.freshness, 'stale');
    assert.equal(stale.provenance.rawSha256, first.provenance.rawSha256); assert.equal(stale.provenance.observedAt, first.provenance.observedAt);
    assert.equal(stale.refreshFailure, mode === 1 ? 'SOURCE_TRANSPORT_FAILED' : 'SOURCE_SCHEMA_REJECTED');
    assert(!JSON.stringify(stale).includes('private transport'));
  }
  failure(await intake.load(request('yasno-kem', '1.1', '2026-11-10')), 'SOURCE_SCHEMA_REJECTED');
});
test('current-day rollover is evaluated against current clock, never the cached observation date', async () => {
  let now = initial;
  const admission = { ...allowed(), cacheTtlMs: 3_600_000, maxAgeMs: 86_400_000 };
  const intake = createSourceIntake({ registry: [admission], now: () => now, transport: async () => response('yasno-kem', yasno()) });
  available(await intake.load(request())); now = Date.parse('2026-11-09T00:00:00Z');
  const yesterday = available(await intake.load(request())); assert.equal(yesterday.view.status, 'stale'); assert.equal(yesterday.view.freshness, 'stale');
});
test('HTTP origins, status and media types fail closed, without consuming a rejected body', async () => {
  for (const [extra, code] of [[{ url: 'https://evil.example/data' }, 'SOURCE_ORIGIN_REJECTED'],
    [{ url: SOURCE_PROFILES[0].endpoint + '?new=1' }, 'SOURCE_ORIGIN_REJECTED'],
    [{ status: 302 }, 'SOURCE_HTTP_REJECTED'], [{ status: 403 }, 'SOURCE_HTTP_REJECTED'],
    [{ headers: { 'content-type': 'text/html' } }, 'SOURCE_CONTENT_TYPE_REJECTED'],
    [{ headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, 'SOURCE_ENCODING_REJECTED']] as const) {
    let consumed = false;
    const rejected = { ...response('yasno-kem', ''), ...extra, body: (async function* () { consumed = true; yield Buffer.from(yasno()); })() };
    const intake = createSourceIntake({ registry: [allowed()], now: () => initial, transport: async () => rejected });
    failure(await intake.load(request()), code); assert.equal(consumed, false);
  }
});
test('byte cap applies to actual streaming chunks; malformed UTF-8 and length metadata are rejected', async () => {
  let returned = false;
  const oversize = (async function* () { try { yield new Uint8Array(9); yield new Uint8Array(9); } finally { returned = true; } })();
  const cap = createSourceIntake({ registry: [allowed()], now: () => initial, limits: { maxBytes: 10 }, transport: async () => response('yasno-kem', '', { body: oversize }) });
  failure(await cap.load(request()), 'SOURCE_BODY_LIMIT'); assert.equal(returned, true);
  let tinyChunks = 0;
  const tiny = createSourceIntake({ registry: [allowed()], now: () => initial, transport: async () => response('yasno-kem', '', {
    body: (async function* () { while (true) { tinyChunks++; yield new Uint8Array([32]); } })(),
  }) });
  failure(await tiny.load(request()), 'SOURCE_BODY_LIMIT'); assert.equal(tinyChunks, 4_097);
  for (const [raw, headers, code] of [[new Uint8Array([0xc3, 0x28]), { 'content-type': 'application/json' }, 'SOURCE_UTF8_REJECTED'],
    [yasno(), { 'content-type': 'application/json', 'content-length': '999999999' }, 'SOURCE_BODY_LIMIT'],
    [yasno(), { 'content-type': 'application/json', 'content-length': '1' }, 'SOURCE_BODY_LIMIT']] as const) {
    const intake = createSourceIntake({ registry: [allowed()], now: () => initial, transport: async () => response('yasno-kem', raw, { headers }) });
    failure(await intake.load(request()), code);
  }
});
test('origin-wide rate gate and verified 429 delay cannot be bypassed with a different DSO', async () => {
  let now = initial, calls = 0;
  const intake = createSourceIntake({ registry: [allowed(), allowed('yasno-dnem')], now: () => now, transport: async () => {
    calls++; return response('yasno-kem', '', { status: 429, headers: { 'retry-after': '20' } });
  } });
  failure(await intake.load(request()), 'SOURCE_RATE_LIMITED'); now += 2_000;
  failure(await intake.load(request('yasno-dnem')), 'SOURCE_RATE_LIMITED'); assert.equal(calls, 1);
  now += 19_000; failure(await intake.load(request()), 'SOURCE_RATE_LIMITED'); assert.equal(calls, 2);
});
test('different per-source rates resolve to the strictest admitted interval for their shared origin', async () => {
  let now = initial, calls = 0;
  const slow = allowed('yasno-dnem');
  const intake = createSourceIntake({ registry: [allowed(), { ...slow, rate: { ...slow.rate, minIntervalMs: 60_000 } }], now: () => now,
    transport: async input => { calls++; return response(input.url.includes('/301/') ? 'yasno-dnem' : 'yasno-kem', yasno()); } });
  available(await intake.load(request())); now += 1_000;
  failure(await intake.load(request('yasno-dnem')), 'SOURCE_RATE_LIMITED'); assert.equal(calls, 1);
  now += 59_000; available(await intake.load(request('yasno-dnem'))); assert.equal(calls, 2);
});
test('unverified 429 quarantines the origin for this instance instead of inventing cooldown or immediate retry', async () => {
  for (const retry of [undefined, '0', '-1', 'garbage', '999999']) {
    let now = initial, calls = 0;
    const intake = createSourceIntake({ registry: [allowed(), allowed('yasno-dnem')], now: () => now, transport: async () => {
      calls++; return response('yasno-kem', '', { status: 429, headers: { 'retry-after': retry } });
    } });
    failure(await intake.load(request()), 'SOURCE_RATE_LIMIT_UNVERIFIED'); now += 86_400_000;
    failure(await intake.load(request('yasno-dnem')), 'SOURCE_RATE_LIMIT_UNVERIFIED'); assert.equal(calls, 1);
  }
});
test('timeout aborts and retains an ignored-abort transport slot, preventing hidden concurrency growth or late cache writes', async () => {
  let release!: (response: SourceHttpResponse) => void, calls = 0, signal: AbortSignal | undefined, now = initial;
  const transport: SourceHttpTransport = async input => { calls++; signal = input.signal; return new Promise(resolve => { release = resolve; }); };
  const intake = createSourceIntake({ registry: [allowed(), allowed('kharkiv-official-rss')], now: () => now, transport,
    limits: { timeoutMs: 10, maxConcurrent: 1 } });
  failure(await intake.load(request()), 'SOURCE_TIMEOUT'); assert.equal(signal?.aborted, true);
  now += 2_000; failure(await intake.load(request()), 'SOURCE_TIMEOUT');
  failure(await intake.load(request('kharkiv-official-rss')), 'SOURCE_BUSY'); assert.equal(calls, 1);
  release(response('yasno-kem', yasno())); await new Promise(resolve => setImmediate(resolve));
  const next = intake.load(request()); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  release(response('yasno-kem', yasno())); assert.equal(available(await next).cache, 'miss');
});
test('admission expiry during transport and clock rollback reject output without blessing cached data', async () => {
  let now = initial;
  const intake = createSourceIntake({ registry: [{ ...allowed(), validUntil: '2026-11-08T10:00:01Z' }], now: () => now, transport: async () => {
    now += 2_000; return response('yasno-kem', yasno());
  } });
  failure(await intake.load(request()), 'SOURCE_ADMISSION_EXPIRED');
  now = initial;
  const backwards = createSourceIntake({ registry: [allowed()], now: () => now, transport: async () => { now--; return response('yasno-kem', yasno()); } });
  failure(await backwards.load(request()), 'SOURCE_CLOCK_INVALID');
});
test('admission that expires between observation and final projection cannot escape the guard', async () => {
  const ticks = [initial, initial + 999, initial + 1_001];
  const intake = createSourceIntake({ registry: [{ ...allowed(), validUntil: new Date(initial + 1_000).toISOString() }],
    now: () => ticks.shift() ?? initial + 1_001, transport: async () => response('yasno-kem', yasno()) });
  failure(await intake.load(request()), 'SOURCE_ADMISSION_EXPIRED');
});
test('schema changes, source date offsets, publication after observation, incomplete days and altered RSS dates are rejected', async () => {
  const base = JSON.parse(yasno());
  const cases = [
    (p: any) => { p['1.1'].today.status = 'ProviderNewEnum'; },
    (p: any) => { p['1.1'].today.date = `${date}T00:00:00Z`; },
    (p: any) => { p['1.1'].updatedOn = '2026-11-08T23:00:00+02:00'; },
    (p: any) => { p['1.1'].today.slots[2].end = 1439; },
    (p: any) => { p['1.1'].today.slots[1].type = 'NewProviderState'; },
  ];
  for (const corrupt of cases) {
    const p = structuredClone(base); corrupt(p);
    const intake = createSourceIntake({ registry: [allowed()], now: () => initial, transport: async () => response('yasno-kem', JSON.stringify(p)) });
    failure(await intake.load(request()), 'SOURCE_SCHEMA_REJECTED');
  }
  for (const raw of [kharkiv().replace('у неділю, 8 листопада', 'у понеділок, 9 листопада'),
    kharkiv().replace('https://oblenergo.kharkiv.ua/uk/node/123456', 'https://untrusted.example/uk/node/123456')]) {
    const intake = createSourceIntake({ registry: [allowed('kharkiv-official-rss')], now: () => initial, transport: async () => response('kharkiv-official-rss', raw) });
    failure(await intake.load(request('kharkiv-official-rss')), 'SOURCE_SCHEMA_REJECTED');
  }
});
