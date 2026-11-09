import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeHourMatrix, type HourMatrixContext } from '../../server/domain/hour-matrix-adapter.ts';
import { normalizeKharkivRss, type KharkivRssContext } from '../../server/domain/kharkiv-adapter.ts';
import { dayBounds, intervalMinutes, scheduleSemantics } from '../../shared/schedule-core.ts';

const root = new URL('../../../docs/light-bot-app/p1/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), 'utf8');
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
const vn = read('fixtures/voe-mirror-vn-progr.json');
const oldVn = read('fixtures/voe-mirror-olnet93.json');
const oem = read('fixtures/dtek-oem-official.txt');
const oemFacts = JSON.parse(read('odesa-structured-evidence.json'));
const rss = read('fixtures/kharkiv-official-rss.txt');
const kharkivFacts = JSON.parse(read('kharkiv-plan-evidence.json'));
function matrixContext(raw = vn, namespace: HourMatrixContext['namespace'] = 'voe:vn-progr'): HourMatrixContext {
  return { namespace, operatorId: namespace === 'dtek:oem' ? 'dtek-oem' : 'vinnytsia-oe', targetId: 'GPV1.1',
    addressId: 'test-address-unconfirmed', addressLabel: 'Обрана технічна група', localityLabel: 'Offline fixture',
    serviceDate: '2026-11-07', observedAt: '2026-11-07T15:00:00+02:00',
    source: { id: namespace === 'dtek:oem' ? 'dtek-oem-official' : namespace === 'voe:olnet93' ? 'voe-mirror-olnet93' : 'voe-mirror-vn-progr',
      name: 'Captured public source', url: null, revision: sha(raw), accessCost: 0, verifiedLevel: 'catalog' },
    freshness: 'current', synthetic: false };
}
function kharkivContext(raw = rss): KharkivRssContext {
  return { namespace: 'kharkiv:rss', operatorId: 'kharkiv-oe', targetId: '1.1', addressId: 'test-address-unconfirmed',
    addressLabel: 'Обрана технічна група', localityLabel: 'Харківська область', serviceDate: '2026-11-07', observedAt: '2026-11-07T15:00:00+02:00',
    source: { id: 'kharkiv-official-rss', name: 'Харківобленерго RSS', url: 'https://oblenergo.kharkiv.ua/uk/rss.xml', revision: sha(raw), accessCost: 0, verifiedLevel: 'schedule' }, freshness: 'current', synthetic: false };
}
function mutateOem(change: (payload: any) => void): string {
  const payload = structuredClone(oemFacts); change(payload);
  return `DisconSchedule.preset = ${JSON.stringify(payload.preset)};\nDisconSchedule.fact = ${JSON.stringify(payload.fact)};`;
}

test('actual current VOE raw response preserves all exact intervals and independent source clocks', () => {
  assert.equal(sha(vn), 'f7fa56944c2074c905833da3d7e93fe83dcb22b6d5f21251914cedc623dc9df4');
  const view = normalizeHourMatrix(vn, matrixContext());
  assert.deepEqual(view.intervals.map(i => [i.startLocal, i.endLocal]), [['02:00', '04:00'], ['08:00', '10:00'], ['20:00', '22:00']]);
  assert.equal(view.publishedAt, '2026-11-07T12:46:00.000Z');
  assert.equal(view.source.revision, sha(vn)); assert.equal(view.observedAt, '2026-11-07T15:00:00+02:00');
  assert.equal(view.status, 'published'); assert.equal(view.dayCoverage, 'complete'); assert.equal(view.deliveryEligible, false);
  assert.equal(view.bindingRevisionId, undefined);
});
test('actual HTTP200 parsed/ok fallback from2025 cannot serve current2026 day', () => {
  assert.equal(sha(oldVn), '60c641528efd8c2ca924288b66917c721fe5673280f511131137ac188342130d');
  assert.throws(() => normalizeHourMatrix(oldVn, matrixContext(oldVn, 'voe:olnet93')), /SERVICE_DATE_NOT_IN_SOURCE_SCOPE/);
  const historical = normalizeHourMatrix(oldVn, { ...matrixContext(oldVn, 'voe:olnet93'), serviceDate: '2025-12-14' });
  assert.equal(historical.status, 'stale'); assert.equal(historical.freshness, 'stale'); assert.deepEqual(historical.intervals, []);
  assert.equal(historical.deliveryEligible, false);
});
test('provenance-only VOE mirror switch retains canonical target identity and semantics', () => {
  const a = normalizeHourMatrix(vn, matrixContext());
  // Simulates an equivalent newly captured response from the other mirror, not a current fallback claim.
  const b = normalizeHourMatrix(vn, matrixContext(vn, 'voe:olnet93'));
  assert.equal(a.namespace, 'voe:vinnytsia'); assert.equal(b.namespace, a.namespace);
  assert.notEqual(a.revisionId, b.revisionId); assert.equal(scheduleSemantics(a), scheduleSemantics(b));
});
test('actual OEM raw HTML is parsed without executing scripts and matches source-derived half-hours', () => {
  assert.equal(sha(oem), oemFacts.provenance.sha256);
  const view = normalizeHourMatrix(oem, matrixContext(oem, 'dtek:oem'));
  assert.deepEqual(view.intervals.map(i => [i.startLocal, i.endLocal, i.kind]), [['05:00', '09:00', 'planned_outage'], ['16:00', '22:30', 'planned_outage']]);
  assert.equal(intervalMinutes(view.intervals), 630); assert.equal(view.source.revision, oemFacts.provenance.sha256);
  assert.equal(view.publishedAt, '2026-11-07T12:41:00.000Z'); assert.equal(view.deliveryEligible, false);
});
test('all OEM legend half-hour enums preserve exactly defined minutes and possible status', () => {
  const raw = mutateOem(payload => {
    const hours = payload.fact.data['1794002400']['GPV1.1'];
    for (let i = 1; i <= 24; i++) hours[i] = 'yes';
    Object.assign(hours, { '1': 'first', '2': 'second', '3': 'mfirst', '4': 'msecond', '5': 'maybe', '24': 'second' });
  });
  const view = normalizeHourMatrix(raw, matrixContext(raw, 'dtek:oem'));
  assert.deepEqual(view.intervals.map(i => [i.startLocal, i.endLocal, i.kind]), [
    ['00:00', '00:30', 'planned_outage'], ['01:30', '02:00', 'planned_outage'], ['02:00', '02:30', 'possible_outage'],
    ['03:30', '05:00', 'possible_outage'], ['23:30', '24:00', 'planned_outage'],
  ]);
  assert.equal(Date.parse(view.intervals.at(-1)!.endsAt), dayBounds('2026-11-08').start);
  const onlyPossible = mutateOem(payload => {
    const hours = payload.fact.data['1794002400']['GPV1.1']; for (let i = 1; i <= 24; i++) hours[i] = 'yes'; hours['1'] = 'mfirst';
  });
  assert.equal(normalizeHourMatrix(onlyPossible, matrixContext(onlyPossible, 'dtek:oem')).status, 'possible');
});
test('missing hours, unknown enums, foreign legends and unproven VOE half-hours fail closed', () => {
  for (const change of [
    (payload: any) => { delete payload.fact.data['1794002400']['GPV1.1']['2']; },
    (payload: any) => { payload.fact.data['1794002400']['GPV1.1']['2'] = 'FutureUnknown'; },
    (payload: any) => { payload.preset.time_type.first = 'not a documented half hour'; },
  ]) {
    const raw = mutateOem(change); assert.throws(() => normalizeHourMatrix(raw, matrixContext(raw, 'dtek:oem')), /HOUR|LEGEND/);
  }
  const payload = JSON.parse(vn); payload.fact.data['1794002400']['GPV1.1']['2'] = 'first';
  // Half-hours require the separately pinned publisher contract metadata.
  delete payload.meta;
  const raw = JSON.stringify(payload); assert.throws(() => normalizeHourMatrix(raw, matrixContext(raw)), /UNKNOWN_(?:VOE|PROVIDER)_HOUR_ENUM/);
});
test('explicit complete all-yes day differs from missing day or missing target', () => {
  const raw = mutateOem(payload => { for (let i = 1; i <= 24; i++) payload.fact.data['1794002400']['GPV1.1'][i] = 'yes'; });
  assert.equal(normalizeHourMatrix(raw, matrixContext(raw, 'dtek:oem')).status, 'no_planned_outages');
  assert.throws(() => normalizeHourMatrix(oem, { ...matrixContext(oem, 'dtek:oem'), serviceDate: '2026-11-08' }), /SERVICE_DATE_NOT_IN_PAYLOAD/);
  const missing = mutateOem(payload => { delete payload.fact.data['1794002400']['GPV1.1']; });
  assert.throws(() => normalizeHourMatrix(missing, matrixContext(missing, 'dtek:oem')), /TARGET_NOT_FOUND/);
});
test('operator namespaces, raw hashes, publication clock and DST reject unsafe normalization', () => {
  assert.throws(() => normalizeHourMatrix(vn, { ...matrixContext(), operatorId: 'dtek-kem' }), /NAMESPACE/);
  assert.throws(() => normalizeHourMatrix(vn + ' ', matrixContext()), /HASH/);
  assert.throws(() => normalizeHourMatrix(vn, { ...matrixContext(), observedAt: '2026-11-07T12:00:00+02:00' }), /PUBLICATION_AFTER/);
  const payload = JSON.parse(vn); payload.regionId = 'odesa'; let raw = JSON.stringify(payload);
  assert.throws(() => normalizeHourMatrix(raw, matrixContext(raw)), /REGION/);
  payload.regionId = 'vinnytsia'; payload.fact.today = dayBounds('2026-10-25').start / 1000;
  payload.fact.data[String(payload.fact.today)] = payload.fact.data['1794002400']; raw = JSON.stringify(payload);
  assert.throws(() => normalizeHourMatrix(raw, { ...matrixContext(raw), serviceDate: '2026-10-25', observedAt: '2026-10-25T16:00:00+02:00' }), /DST_HOUR_MATRIX/);
});
test('actual official Kharkiv RSS normalizes its own full12-queue plan and exact source hash', () => {
  assert.equal(sha(rss), kharkivFacts.source_sha256);
  for (const [queue, facts] of Object.entries(kharkivFacts.intervals_offline) as [string, {start_minute:number;end_minute:number}[]][]) {
    const view = normalizeKharkivRss(rss, { ...kharkivContext(), targetId: queue });
    assert.deepEqual(view.intervals.map(i => [(Date.parse(i.startsAt) - dayBounds(view.serviceDate).start) / 60000, (Date.parse(i.endsAt) - dayBounds(view.serviceDate).start) / 60000]), facts.map(i => [i.start_minute, i.end_minute]));
    assert.equal(view.operatorId, 'kharkiv-oe'); assert.equal(view.source.url, kharkivFacts.source_url); assert.equal(view.deliveryEligible, false);
    assert.equal(view.publishedAt, '2026-11-06T18:00:03.000Z');
  }
});
test('Kharkiv cannot use Kyiv namespace, wrong day, wrong hash or unscoped foreign origin', () => {
  assert.throws(() => normalizeKharkivRss(rss, { ...kharkivContext(), operatorId: 'dtek-kem' as 'kharkiv-oe' }), /NAMESPACE/);
  assert.throws(() => normalizeKharkivRss(rss, { ...kharkivContext(), serviceDate: '2026-11-08' }), /DATED_PLAN/);
  assert.throws(() => normalizeKharkivRss(rss + ' ', kharkivContext()), /HASH/);
  const foreign = rss.replace(kharkivFacts.source_url, 'https://example.invalid/uk/node/13883458');
  assert.throws(() => normalizeKharkivRss(foreign, kharkivContext(foreign)), /ORIGIN/);
});
test('Kharkiv damaged tables, unknown clocks and duplicate rows never imply all-day power-on', () => {
  for (const [before, after, expected] of [
    ['1.1 03:30-06:00', '7.1 03:30-06:00', /QUEUE_DUPLICATE_OR_UNKNOWN/],
    ['1.1 03:30-06:00', '1.1 03:99-06:00', /INVALID_CLOCK/],
    ['1.1 03:30-06:00', '1.2 03:30-06:00', /QUEUE_DUPLICATE_OR_UNKNOWN/],
    ['1.1 03:30-06:00', '1.1 07:00-06:00', /INTERVAL_REVERSED/],
  ] as const) {
    const changed = rss.replace(before, after); assert.notEqual(changed, rss);
    assert.throws(() => normalizeKharkivRss(changed, kharkivContext(changed)), expected);
  }
});
test('Kharkiv historical preview stays stale and RFC date cannot lose its timezone', () => {
  assert.equal(normalizeKharkivRss(rss, { ...kharkivContext(), observedAt: '2026-11-10T15:00:00+02:00' }).status, 'stale');
  const noZone = rss.replace('Fri, 06 Nov 2026 18:00:03 +0000', 'Fri, 06 Nov 2026 18:00:03');
  assert.throws(() => normalizeKharkivRss(noZone, kharkivContext(noZone)), /PUBLICATION_FORMAT/);
  const normalizedBadDate = rss.replace('Fri, 06 Nov 2026 18:00:03 +0000', 'Fri, 00 Nov 2026 18:00:03 +0000');
  assert.throws(() => normalizeKharkivRss(normalizedBadDate, kharkivContext(normalizedBadDate)), /PUBLICATION_FORMAT|INVALID_SERVICE_DATE/);
});

test('actual all-yes VOE tomorrow matrix is not certified as no outages without publication evidence', () => {
  const view = normalizeHourMatrix(vn, { ...matrixContext(), serviceDate: '2026-11-08' });
  assert.equal(view.status, 'not_published'); assert.equal(view.dayCoverage, 'none'); assert.equal(view.freshness, 'unknown');
  const junk = JSON.parse(vn); junk.fact.data['1794088800'].unrecognized_foreign_queue = { not_an_hour: 'no' };
  const raw = JSON.stringify(junk);
  assert.throws(() => normalizeHourMatrix(raw, { ...matrixContext(raw), serviceDate: '2026-11-08' }), /QUEUE_TABLE/);
});
test('OEM assignments inside comments and quoted examples are not data', () => {
  const assignment = mutateOem(() => {});
  for (const raw of [`/* ${assignment} */`, JSON.stringify(assignment), `<div>${assignment}</div><script>const unused=1;</script>`,
    `<html><body><pre>${assignment}</pre></body></html>`, `<script type="application/json">${assignment}</script>`,
    `function unused(){${assignment}}`, `if(false){${assignment}}`]) {
    assert.throws(() => normalizeHourMatrix(raw, matrixContext(raw, 'dtek:oem')), /ASSIGNMENT/);
  }
});
test('edited RSS dates and withdrawal/overlay notices invalidate the hourly plan', () => {
  for (const raw of [rss.replace('у суботу, 7 листопада, з 00:00', 'у неділю, 8 листопада, з 00:00'),
    rss.replace('Години відсутності електропостачання', 'Цей графік скасовано. Діють аварійні відключення. Години відсутності електропостачання')]) {
    assert.notEqual(raw, rss); assert.throws(() => normalizeKharkivRss(raw, kharkivContext(raw)), /BODY_DATE_CONFLICT|WITHDRAWN/);
  }
});
