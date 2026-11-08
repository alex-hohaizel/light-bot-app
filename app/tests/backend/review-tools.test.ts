import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { invalidatedReviewShareAddressIds, parseReviewToolsRequest, publicReviewPlace, reviewShareScopeFingerprint, validReviewServiceDate, validReviewShareToken } from '../../shared/review-tools.ts';
import { REVIEW_PLAN } from '../../shared/review-fixtures.ts';
import { REVIEW_ADDRESSES, returningReviewProfile } from '../../server/domain/review-context.ts';
import type { ScheduleView } from '../../shared/product-contract.ts';
const envelope = (action: unknown) => ({ id: 'tool-1', expectedSessionId: 'session-1', expectedRevision: 7, action });

test('tool boundary keeps request identity and exact address/date without accepting caller scope', () => {
  const request = envelope({ kind: 'share', addressIds: ['address-1', 'address-2'], ttlDays: 7, serviceDate: '2026-11-08' });
  assert.deepEqual(parseReviewToolsRequest(request), request);
  for (const extra of ['ownerId', 'profile', 'accounts', 'url']) {
    assert.throws(() => parseReviewToolsRequest({ ...request, [extra]: 'foreign' }), /INVALID_REVIEW_TOOLS_INPUT/);
    assert.throws(() => parseReviewToolsRequest({ ...request, action: { ...request.action as object, [extra]: 'foreign' } }), /INVALID_REVIEW_TOOLS_INPUT/);
  }
});
test('tool boundary rejects partial, duplicated or unbounded share inputs', () => {
  for (const action of [
    { kind: 'share', addressIds: [], ttlDays: 7, serviceDate: '2026-11-08' },
    { kind: 'share', addressIds: ['a', 'a'], ttlDays: 7, serviceDate: '2026-11-08' },
    { kind: 'share', addressIds: Array.from({ length: 21 }, (_, i) => String(i)), ttlDays: 7, serviceDate: '2026-11-08' },
    { kind: 'share', addressIds: ['a'], ttlDays: 2, serviceDate: '2026-11-08' },
    { kind: 'share', addressIds: ['a'], ttlDays: 7, serviceDate: '2026-02-30' },
    { kind: 'share', addressIds: ['a'], ttlDays: '7', serviceDate: '2026-11-08' },
    { kind: 'share', addressIds: ['a'], ttlDays: 7, serviceDate: '2026-11-08T00:00:00Z' },
  ]) assert.throws(() => parseReviewToolsRequest(envelope(action)), /INVALID_REVIEW_TOOLS_INPUT/);
  for (const revision of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7'])
    assert.throws(() => parseReviewToolsRequest({ ...envelope({ kind: 'report', addressId: 'a', value: 'off' }), expectedRevision: revision }), /INVALID_REVIEW_TOOLS_INPUT/);
});
test('tools allow intended report/account actions while rejecting ambiguous booleans/provider strings', () => {
  for (const value of ['on', 'off']) assert.equal(parseReviewToolsRequest(envelope({ kind: 'report', addressId: 'a', value })).action.kind, 'report');
  for (const kind of ['link_account', 'unlink_account']) for (const provider of ['Telegram', 'Replit'])
    assert.equal(parseReviewToolsRequest(envelope({ kind, provider })).action.kind, kind);
  for (const action of [
    { kind: 'report', addressId: 'a', value: true }, { kind: 'report', addressId: 'a', value: 'unknown' },
    { kind: 'link_account', provider: 'Google' }, { kind: 'unlink_account', provider: 'Telegram', confirmedOwner: true },
    { kind: 'revoke_share', token: '../../secret' }, { kind: 'delete_user', ownerId: 'foreign' },
  ]) assert.throws(() => parseReviewToolsRequest(envelope(action)), /INVALID_REVIEW_TOOLS_INPUT/);
});
test('public projection excludes private identities and every nested source/binding extension', () => {
  const privatePlan = { ...REVIEW_PLAN, synthetic: true, addressId: 'PRIVATE-ADDRESS-ID', addressLabel: 'PRIVATE-ADDRESS-LABEL',
    bindingRevisionId: 'PRIVATE-BINDING', namespace: 'PRIVATE-NAMESPACE', targetId: 'PRIVATE-QUEUE',
    street: 'PRIVATE-STREET', house: 'PRIVATE-HOUSE', ownerId: 'PRIVATE-OWNER', primary: true,
    source: { ...REVIEW_PLAN.source, url: 'https://private.example/token=PRIVATE-SECRET', revision: 'PRIVATE-SOURCE-REVISION' },
    intervals: REVIEW_PLAN.intervals.map(interval => ({ ...interval, private: 'PRIVATE-INTERVAL-FIELD' })),
  } as ScheduleView;
  const output = publicReviewPlace('Дім', 'Тестове місто', privatePlan.serviceDate, privatePlan);
  const raw = JSON.stringify(output);
  assert(!raw.includes('PRIVATE-')); assert.equal(output.label, 'Дім');
  assert.equal(output.intervals[0].startLocal, '07:30'); assert.equal(output.intervals[2].endLocal, '24:00');
  assert.deepEqual(Object.keys(output).sort(), ['dayCoverage', 'freshness', 'intervals', 'label', 'localityLabel', 'observedAt', 'serviceDate', 'sourceName', 'status', 'synthetic', 'timezone'].sort());
  assert.notEqual(output.intervals, privatePlan.intervals); assert.notEqual(output.intervals[0], privatePlan.intervals[0]);
});
test('public projection never substitutes a different service day or live data into a synthetic share', () => {
  for (const plan of [REVIEW_PLAN, { ...REVIEW_PLAN, serviceDate: '2026-11-08', synthetic: false }]) {
    const output = publicReviewPlace('Дім', 'Тестове місто', '2026-11-08', plan);
    assert.equal(output.serviceDate, '2026-11-08'); assert.equal(output.status, 'not_published');
    assert.equal(output.observedAt, null); assert.equal(output.freshness, 'unknown'); assert.deepEqual(output.intervals, []);
  }
});
test('service dates validate real calendar days and tokens accept only bounded random-hex identifiers', () => {
  for (const value of ['2024-02-29', '2026-03-29', '2026-10-25', '2026-12-31']) assert(validReviewServiceDate(value));
  for (const value of ['', '2026-02-29', '2026-13-01', '2026-01-00', '2026-1-01', null, {}, '99999-01-01']) assert(!validReviewServiceDate(value));
  assert(validReviewShareToken('a'.repeat(48)));
  for (const value of ['', 'a'.repeat(47), 'g'.repeat(48), 'a'.repeat(49), null, {}, '/'.repeat(48)]) assert(!validReviewShareToken(value));
});

test('inspecting routes and service without DATABASE_URL does not initialize a database graph', () => {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    "await import('./server/domain/review-tools-routes.ts'); await import('./server/domain/review-tools.ts'); console.log('IMPORT_ONLY_PASS')"],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { PATH: process.env.PATH, TZ: 'UTC' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert(child.stdout.includes('IMPORT_ONLY_PASS'));
});

test('publication invalidation catches delete and same-ID rebinding while preserving label/order/preferences', () => {
  const before = returningReviewProfile('lba-synthetic-user'), id = before.locations[0].address.id;
  const deleted = structuredClone(before); deleted.locations = []; deleted.primaryAddressId = null;
  assert.deepEqual(invalidatedReviewShareAddressIds(before, deleted), [id]);
  // Restoring the exact same catalog ID does not undo the tombstone returned for the deletion.
  assert.deepEqual(invalidatedReviewShareAddressIds(deleted, before), []);
  for (const edit of [
    location => { location.address.territoryId += '-changed'; },
    location => { location.address.locality += '-changed'; },
    location => { location.address.street += '-changed'; },
    location => { location.address.house.literal += '-changed'; },
    location => { location.address.house.letter = 'Б'; },
    location => { location.address.house.building = '2'; },
    location => { location.binding.operatorId += '-changed'; },
    location => { location.binding.namespace += '-changed'; },
    location => { location.binding.targetId += '-changed'; },
    location => { location.binding.revisionId += '-changed'; },
    location => { location.binding.status = 'needs_confirmation'; },
    location => { location.binding.kind = 'user_selected_group'; },
  ] as Array<(location: typeof before.locations[number]) => void>) {
    const after = structuredClone(before); edit(after.locations[0]);
    assert.deepEqual(invalidatedReviewShareAddressIds(before, after), [id]);
    assert.notEqual(reviewShareScopeFingerprint(before.locations[0]), reviewShareScopeFingerprint(after.locations[0]));
  }
  const presentation = structuredClone(before);
  presentation.locations[0].address.label = 'Нова мітка'; presentation.locations[0].paused = true;
  presentation.locations[0].notifications = !presentation.locations[0].notifications;
  presentation.preferences.paused = true; presentation.primaryAddressId = null;
  assert.deepEqual(invalidatedReviewShareAddressIds(before, presentation), []);
  assert.equal(reviewShareScopeFingerprint(before.locations[0]), reviewShareScopeFingerprint(presentation.locations[0]));
  const added = structuredClone(before); added.locations.push({ address: REVIEW_ADDRESSES[0].address, binding: REVIEW_ADDRESSES[0].binding, paused: false, notifications: false });
  assert.deepEqual(invalidatedReviewShareAddressIds(before, added), []);
  assert.deepEqual(invalidatedReviewShareAddressIds(added, { ...added, locations: [...added.locations].reverse() }), []);
  const duplicated = structuredClone(before); duplicated.locations.push(structuredClone(duplicated.locations[0]));
  assert.deepEqual(invalidatedReviewShareAddressIds(before, duplicated), [id]);
});
