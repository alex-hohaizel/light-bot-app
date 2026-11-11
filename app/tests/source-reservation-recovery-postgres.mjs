import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withProofDatabase} from '../../../../../tools/local-runtime/disposable-proof-db.mjs';
import {createSourceIngestion,SOURCE_INGESTION_SCHEMA_SQL} from '../server/production/source-ingestion.ts';

const kharkiv = 'https://oblenergo.kharkiv.ua';
const kyiv = 'https://app.yasno.ua';
const odesa = 'https://www.dtek-oem.com.ua';
const github = 'https://raw.githubusercontent.com';
const kharkivSource = 'kharkiv-official-rss';
const kyivSource = 'yasno-kem';
const epoch = 1;
const intervalMs = 2_700_000;
const originHold = 'lba-public-source-origin-held:v1';
const workerHold = 'lba-public-source-worker-held:v1';
const now = () => Date.parse('2026-11-11T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
const emptyResponse = (url, status = 503) => ({
  url, status, headers: {}, body: {async *[Symbol.asyncIterator]() {}},
});

async function withTimeout(operation) {
  let timeout;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Synthetic transports did not enter concurrently')), 4000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

await withProofDatabase('source_recovery', 55493, async pool => {
  await pool.query('create table lba_production_control(id boolean primary key,control_epoch bigint,writer_mode text)');
  await pool.query("insert into lba_production_control values(true,1,'canonical')");
  await pool.query(SOURCE_INGESTION_SCHEMA_SQL);

  const requests = [];
  const createService = transport => createSourceIngestion({
    enabled: true, expectedControlEpoch: epoch, pool, now,
    transport: async request => {
      requests.push(new URL(request.url).origin);
      return transport(request);
    },
  });
  const createUnavailableService = () => createService(async request => emptyResponse(request.url));
  const service = createUnavailableService();
  const readWorker = async () => (await pool.query('select uncertain,hold_reason from lba_public_source_worker')).rows[0];
  const readOrigin = async origin => {
    const row = (await pool.query('select uncertain,hold_reason,next_attempt_at from lba_public_source_origin where origin=$1', [origin])).rows[0];
    return {...row, next_attempt_at: row.next_attempt_at.toISOString()};
  };
  const readRun = async token => (await pool.query(
    'select status,code,finished_at from lba_public_source_run where id=$1', [token],
  )).rows[0];

  async function reset() {
    await pool.query('truncate lba_public_source_worker,lba_public_source_origin,lba_public_source_state,lba_public_source_run,lba_public_source_raw,lba_public_source_plan');
    requests.length = 0;
  }

  async function seed({
    version = 1, age = 90_000, hops = 0, otherSource = null, raw = false, mismatch = false, workerOverride,
  } = {}) {
    await reset();
    const dbTime = Number((await pool.query('select floor(extract(epoch from clock_timestamp())*1000) as now')).rows[0].now);
    const reservedAtMs = dbTime - age;
    const reservedAt = iso(reservedAtMs);
    const next = iso(reservedAtMs + intervalMs);
    const token = randomUUID();
    const marker = JSON.stringify({
      kind: 'lba-public-source-reservation', version, token, epoch, origin: kharkiv, reservedAtMs,
      deadlineAtMs: reservedAtMs + 30_000, maxHops: 1, intervalMs, hops,
      nextHopAtMs: reservedAtMs + (hops ? intervalMs : 0),
    });
    const workerMarker = workerOverride === undefined ? (version === 1 ? marker : null) : workerOverride;
    const originMarker = mismatch ? originHold : marker;
    await pool.query('insert into lba_public_source_worker values(true,$1,$2)', [workerMarker !== null, workerMarker]);
    await pool.query('insert into lba_public_source_origin values($1,$2,true,$3),($4,$2,true,$5)',
      [kharkiv, next, originMarker, odesa, originHold]);
    await pool.query('insert into lba_public_source_state(source_id,last_attempt_at) values($1,$2)', [kharkivSource, reservedAt]);
    await pool.query("insert into lba_public_source_run(id,source_id,control_epoch,started_at,status) values($1,$2,$3,$4,'started')",
      [token, kharkivSource, epoch, reservedAt]);
    if (otherSource) {
      await pool.query("insert into lba_public_source_run(id,source_id,control_epoch,started_at,status) values($1,$2,$3,$4,'started')",
        [randomUUID(), otherSource, epoch, reservedAt]);
    }
    if (raw) {
      await pool.query('insert into lba_public_source_raw values($1,$2,$3,$4,$5::jsonb)',
        [randomUUID(), token, kharkivSource, reservedAt, '{}']);
    }
    return {
      token, reservedAt, next,
      worker: {uncertain: workerMarker !== null, hold_reason: workerMarker},
      origin: {uncertain: true, hold_reason: originMarker, next_attempt_at: next},
    };
  }

  async function assertPreserved(fixture, label) {
    assert.deepEqual(await readWorker(), fixture.worker, label);
    assert.deepEqual(await readOrigin(kharkiv), fixture.origin, label);
    assert.deepEqual(await readRun(fixture.token), {status: 'started', code: null, finished_at: null}, label);
  }

  async function assertRetired(fixture) {
    const run = await readRun(fixture.token);
    assert.equal(run.status, 'rejected');
    assert.equal(run.code, 'SOURCE_UPDATE_UNCONFIRMED');
    assert(run.finished_at);
    const {last_attempt_at, last_failure} = (await pool.query(
      'select last_attempt_at,last_failure from lba_public_source_state where source_id=$1', [kharkivSource],
    )).rows[0];
    assert.equal(last_attempt_at.toISOString(), fixture.reservedAt);
    assert.equal(last_failure, 'SOURCE_UPDATE_UNCONFIRMED');
    assert.deepEqual(await readWorker(), {uncertain: false, hold_reason: null});
    assert.deepEqual(await readOrigin(kharkiv), {uncertain: false, hold_reason: null, next_attempt_at: fixture.next});
    assert.deepEqual(await readOrigin(odesa), {uncertain: true, hold_reason: originHold, next_attempt_at: fixture.next});
  }

  for (const scenario of [
    {age: 1000},
    {hops: 1},
    {hops: 1, age: intervalMs + 60_000, otherSource: kharkivSource},
    {hops: 1, age: intervalMs + 60_000, raw: true},
    {hops: 1, age: intervalMs + 60_000, mismatch: true},
  ]) {
    const label = JSON.stringify(scenario);
    const fixture = await seed(scenario);
    assert.equal((await service.refreshOnce(kyivSource)).code, 'SOURCE_HTTP_REJECTED', label);
    assert.deepEqual(requests, [kyiv], label);
    await assertPreserved(fixture, label);
    assert.equal((await service.refreshOnce(kharkivSource)).code, 'SOURCE_ORIGIN_HELD', label);
    assert.deepEqual(requests, [kyiv], label);
    await assertPreserved(fixture, label);
  }
  console.log('Kyiv refresh is independent; unsafe legacy recoveries leave both holds and the original run intact');

  for (const workerOverride of [workerHold, '{"kind":"lba-public-source-reservation","version":1}']) {
    const fixture = await seed({workerOverride});
    assert.equal((await service.refreshOnce(kyivSource)).code, 'SOURCE_WORKER_HELD');
    assert.equal((await service.refreshOnce(kharkivSource)).code, 'SOURCE_ORIGIN_HELD');
    assert.deepEqual(requests, []);
    await assertPreserved(fixture, workerOverride);
  }
  console.log('Explicit global and unrecognized worker holds continue to block transport');

  for (const scenario of [
    {otherSource: kyivSource},
    {hops: 1, age: intervalMs + 60_000},
    {version: 2, hops: 1, age: intervalMs + 60_000},
  ]) {
    const fixture = await seed(scenario);
    const results = await Promise.all([
      service.refreshOnce(kharkivSource),
      createUnavailableService().refreshOnce(kharkivSource),
    ]);
    assert.equal(results.filter(result => result.code === 'SOURCE_RESERVATION_RECOVERED').length, 1);
    assert.deepEqual(requests, []);
    await assertRetired(fixture);
  }
  console.log('Exactly one caller retires each expired paired run as unconfirmed without moving provider cooldown');

  await reset();
  const origins = [kyiv, kharkiv, github];
  const gates = new Map(origins.map(origin => [origin, {
    entered: Promise.withResolvers(), finish: Promise.withResolvers(),
  }]));
  const concurrent = createService(async request => {
    const gate = gates.get(new URL(request.url).origin);
    assert(gate);
    gate.entered.resolve();
    await gate.finish.promise;
    return emptyResponse(request.url);
  });
  const results = [];
  const inflight = concurrent.refreshOrigins(new AbortController().signal, async result => { results.push(result); });
  try {
    await withTimeout(Promise.all([...gates.values()].map(gate => gate.entered.promise)));
    assert.deepEqual(await readWorker(), {uncertain: false, hold_reason: null});
    for (const origin of origins) {
      const row = await readOrigin(origin);
      const marker = JSON.parse(row.hold_reason);
      assert.equal(row.uncertain, true);
      assert.equal(marker.version, 2);
      assert.equal(marker.origin, origin);
      assert.equal(marker.hops, 1);
    }
    const otherService = createUnavailableService();
    assert.equal((await otherService.refreshOnce(kyivSource)).code, 'SOURCE_ORIGIN_HELD');
    assert.equal((await otherService.refreshOnce('voe-mirror-vn-progr')).code, 'SOURCE_ORIGIN_HELD');
    assert.deepEqual([...requests].sort(), origins);
  } finally {
    for (const gate of gates.values()) gate.finish.resolve();
    await inflight;
  }
  assert.deepEqual(results.map(result => result.code), origins.map(() => 'SOURCE_HTTP_REJECTED'));
  assert.deepEqual(results.map(result => result.sourceId).sort(), [kharkivSource, 'mirror-odesa', kyivSource]);
  for (const origin of origins) {
    const row = await readOrigin(origin);
    assert.equal(row.uncertain, false);
    assert.equal(row.hold_reason, null);
  }
  assert.deepEqual(await readWorker(), {uncertain: false, hold_reason: null});
  console.log('Separate origins reach transport concurrently with their own leases; same-origin refresh remains blocked');

  await reset();
  const forbidden = createService(async request => emptyResponse(request.url, 403));
  assert.equal((await forbidden.refreshOnce(kharkivSource)).code, 'SOURCE_HTTP_REJECTED');
  assert.equal((await readOrigin(kharkiv)).hold_reason, originHold);
  assert.equal((await forbidden.refreshOnce(kharkivSource)).code, 'SOURCE_ORIGIN_HELD');
  assert.equal((await service.refreshOnce(kyivSource)).code, 'SOURCE_HTTP_REJECTED');
  assert.deepEqual(requests, [kharkiv, kyiv]);
  assert.deepEqual(await readWorker(), {uncertain: false, hold_reason: null});
  console.log('HTTP 403 holds only the provider that returned it');
});
