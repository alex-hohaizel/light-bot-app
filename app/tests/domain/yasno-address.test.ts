import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildYasnoAddressCandidate, readYasnoHouseCandidates, readYasnoStreetCandidates, YASNO_KYIV_ADDRESS_SCOPE,
  type YasnoAddressCapture, type YasnoAddressCandidateInput } from '../../server/domain/yasno-address-adapter.ts';
import { normalizeYasnoRaw } from '../../server/domain/yasno-adapter.ts';
import { searchAddressIndex } from '../../shared/address-index.ts';

const directory = new URL('../../../docs/light-bot-app/p1/address-probes/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), 'utf8');
const observations = JSON.parse(read('observations.json')).requests;
const cases = JSON.parse(read('binding-candidates.json')).cases;
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const policy = { asOf: '2026-11-07T14:05:00Z', maximumCaptureAgeMs: 600_000 };
function capture(name: string): YasnoAddressCapture {
  const row = observations.find((row: any) => row.name === name);
  assert(row?.body_file);
  return { sourceId: 'yasno-public-address-v2', method: 'GET', url: row.url, httpStatus: row.http_status,
    contentType: row.headers['Content-Type'], observedAt: row.observed_at_utc, rawBody: read(row.body_file), rawSha256: row.response_sha256 };
}
function input(caseId = 'kyiv-revutskogo-12a-group'): YasnoAddressCandidateInput {
  const row = cases.find((row: any) => row.case_id === caseId);
  return { scope: { ...YASNO_KYIV_ADDRESS_SCOPE }, policy: { ...policy }, selection: { streetId: row.street_id, streetValue: row.street_value,
    houseId: row.house_id, houseLiteral: row.house_literal, label: 'Публічний test candidate' },
    captures: { streets: capture(row.street_id === 736 ? 'kyiv-revutskogo-street' : 'kyiv-beresteiskyi-street'),
      houses: capture(row.street_id === 1211 ? 'kyiv-beresteiskyi-avenue-houses-12' : ['12А', '12/1'].includes(row.house_literal) ? 'kyiv-revutskogo-houses-12' : 'kyiv-revutskogo-all-houses'),
      group: capture(row.case_id) } };
}
function mutateRaw(capture: YasnoAddressCapture, rawBody: string) {
  return { ...capture, rawBody, rawSha256: hash(rawBody) };
}

test('all12 actual public cases retain exact provider IDs, current technical groups and candidate-only admission', () => {
  assert.equal(cases.length, 12);
  const plan = readFileSync(new URL('../../../docs/light-bot-app/p1/fixtures/yasno-kem.json', import.meta.url), 'utf8');
  const ids = new Set<string>();
  for (const row of cases) {
    const candidate = buildYasnoAddressCandidate(input(row.case_id));
    assert.equal(candidate.proof.providerHouseId, row.house_id);
    assert.equal(candidate.address.house.literal, row.house_literal);
    assert.equal(candidate.binding.targetId, row.target_id);
    assert.equal(candidate.binding.status, 'needs_confirmation');
    assert.equal(candidate.binding.verifiedAt, null); assert.equal(candidate.source.verifiedLevel, 'catalog');
    assert.deepEqual(candidate.address.aliases, []); assert.equal(candidate.proof.canonicalMunicipalAddressId, null);
    assert.equal(candidate.proof.katottg, null); assert.equal(candidate.proof.deliveryEligible, false);
    ids.add(candidate.address.id);
    const view = normalizeYasnoRaw(plan, 'today', { namespace: 'yasno:25/902', operatorId: 'dtek-kem', targetId: candidate.binding.targetId,
      addressId: candidate.address.id, addressLabel: candidate.address.label, localityLabel: candidate.address.locality,
      serviceDate: '2026-11-07', observedAt: '2026-11-07T12:49:33.806503+00:00',
      source: { id: 'yasno-kem', name: 'Captured public plan', url: null, revision: hash(plan), accessCost: 0, verifiedLevel: 'catalog' }, freshness: 'current', synthetic: false });
    assert.equal(view.targetId, row.target_id); assert.equal(view.deliveryEligible, false); assert.equal(view.bindingRevisionId, undefined);
  }
  assert.equal(ids.size, 12);
  assert.equal(buildYasnoAddressCandidate(input()).binding.targetId, '45.1');
  assert.equal(buildYasnoAddressCandidate(input('kyiv-revutskogo-2v-group')).binding.targetId, '57.1');
});
test('actual query12 with no exact12 rejects instead of falling back to12/1 or12А', () => {
  const value = input(); value.selection.houseLiteral = '12';
  assert.throws(() => buildYasnoAddressCandidate(value), /EXACT_HOUSE_SELECTION/);
  const missing = input(); missing.selection.houseId = 999999;
  assert.throws(() => buildYasnoAddressCandidate(missing), /EXACT_HOUSE_SELECTION/);
});
test('same raw group body cannot collapse12А and12/1 address identity or binding revision', () => {
  const a = input(), b = input('kyiv-revutskogo-12slash1-group');
  assert.equal(a.captures.group.rawSha256, b.captures.group.rawSha256);
  const left = buildYasnoAddressCandidate(a), right = buildYasnoAddressCandidate(b);
  assert.equal(left.binding.targetId, right.binding.targetId);
  assert.notEqual(left.address.id, right.address.id); assert.notEqual(left.binding.revisionId, right.binding.revisionId);
  assert.equal(left.address.house.number, '12'); assert.equal(left.address.house.letter, 'А');
  assert.equal(right.address.house.number, '12/1'); assert.equal(right.address.house.letter, undefined);
});
test('same street actual house1 and12А have different targets; no street-only inference exists', () => {
  const first = buildYasnoAddressCandidate(input('kyiv-revutskogo-house1-group'));
  const other = buildYasnoAddressCandidate(input());
  assert.equal(first.address.street, other.address.street);
  assert.equal(first.binding.targetId, '47.1'); assert.equal(other.binding.targetId, '45.1');
});
test('exact letter spacing normalization is shared; Latin lookalike and slash/hyphen remain different', () => {
  const value = input(); value.selection.houseLiteral = '12 а';
  assert.equal(buildYasnoAddressCandidate(value).address.house.literal, '12А');
  for (const wrong of ['12A', '12/1', '12-1', '12 корпус 1']) {
    const changed = input(); changed.selection.houseLiteral = wrong;
    assert.throws(() => buildYasnoAddressCandidate(changed), /EXACT_HOUSE_SELECTION/);
  }
});
test('street type/ID and historical-looking query results cannot silently alias a different avenue', () => {
  const values = readYasnoStreetCandidates(capture('kyiv-beresteiskyi-street'), policy);
  assert.deepEqual(values.items.map(row => [row.id, row.value]), [[1211, 'просп. Берестейський'], [2301, 'пров. Берестейський']]);
  const wrongType = input('kyiv-beresteiskyi-12-group'); wrongType.selection.streetValue = 'пров. Берестейський';
  assert.throws(() => buildYasnoAddressCandidate(wrongType), /EXACT_STREET_SELECTION/);
  const alias = input('kyiv-beresteiskyi-12-group'); alias.captures.streets = capture('kyiv-old-peremohy-street');
  assert.throws(() => buildYasnoAddressCandidate(alias), /EXACT_STREET_SELECTION/);
  const candidate = buildYasnoAddressCandidate(input('kyiv-beresteiskyi-12-group'));
  assert.deepEqual(searchAddressIndex([candidate.address], { territoryId: candidate.address.territoryId, locality: 'Київ', street: 'Перемоги' }), []);
});
test('actual20row empty-query response is never advertised as full address coverage', () => {
  const broad = readYasnoHouseCandidates(capture('kyiv-revutskogo-all-houses'), 736, policy);
  const prefix = readYasnoHouseCandidates(capture('kyiv-revutskogo-houses-12'), 736, policy);
  assert.equal(broad.items.length, 20); assert.equal(broad.catalogCompleteness, 'unknown');
  assert(prefix.items.every(row => !broad.items.some(existing => existing.id === row.id)));
});
test('wrong operator, source, request method, origin and DSO cannot reuse captured data', () => {
  const changes: Array<(value: YasnoAddressCandidateInput) => void> = [
    value => { value.scope.operatorId = 'kharkiv-oe' as any; },
    value => { value.scope.namespace = 'yasno:3/301' as any; },
    value => { value.captures.group.sourceId = 'another-source' as any; },
    value => { value.captures.group.method = 'POST' as any; },
    value => { value.captures.group.url = value.captures.group.url.replace('app.yasno.ua', 'untrusted.invalid'); },
    value => { value.captures.group.url = value.captures.group.url.replace('dsoId=902', 'dsoId=301'); },
    value => { value.captures.group.url += '&houseId=30823'; },
    value => { value.captures.group.url += '&token=never-accepted'; },
  ];
  for (const change of changes) { const value = input(); change(value); assert.throws(() => buildYasnoAddressCandidate(value), /SCOPE|ENVELOPE|UNTRUSTED|FIELDS/); }
});
test('same body with wrong house/street request scope or unscoped body cannot establish a binding', () => {
  const wrongHouse = input(); wrongHouse.captures.group = capture('kyiv-revutskogo-12slash1-group');
  assert.throws(() => buildYasnoAddressCandidate(wrongHouse), /HOUSE_REQUEST_SCOPE/);
  const wrongStreet = input(); wrongStreet.captures.houses.url = wrongStreet.captures.houses.url.replace('streetId=736', 'streetId=1211');
  assert.throws(() => buildYasnoAddressCandidate(wrongStreet), /STREET_REQUEST_SCOPE/);
  const unscoped = input(); unscoped.captures.group.url = 'https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/group';
  assert.throws(() => buildYasnoAddressCandidate(unscoped), /FIELDS/);
});
test('body tampering, duplicate keys, duplicate IDs and unknown provider enums fail closed', () => {
  const staleHash = input(); staleHash.captures.group.rawBody = '{"group":57,"subgroup":1}';
  assert.throws(() => buildYasnoAddressCandidate(staleHash), /RAW_HASH/);
  for (const raw of ['{"group":45,"group":57,"subgroup":1}', '{"group":45,"subgroup":2}', '{"group":61,"subgroup":1}', '{"group":"45","subgroup":1}', '{"group":45,"subgroup":1,"status":"FutureUnknown"}']) {
    const value = input(); value.captures.group = mutateRaw(value.captures.group, raw);
    assert.throws(() => buildYasnoAddressCandidate(value), /DUPLICATE|UNKNOWN_GROUP_ENUM/);
  }
  const duplicates = input(); duplicates.captures.houses = mutateRaw(duplicates.captures.houses, '[{"id":30823,"value":"12А"},{"id":30823,"value":"12/1"}]');
  assert.throws(() => buildYasnoAddressCandidate(duplicates), /DUPLICATE_PROVIDER_ID/);
});
test('capture replay across dates, future timestamps, old proofs and inverted chain order are rejected', () => {
  for (const observedAt of ['2026-11-08T14:00:00Z', '2026-11-06T14:00:00Z', '2026-11-07T13:00:00Z', '2026-11-07']) {
    const value = input(); value.captures.group.observedAt = observedAt;
    assert.throws(() => buildYasnoAddressCandidate(value), /OBSERVATION|STALE_OR_FUTURE/);
  }
  const reversed = input(); reversed.captures.streets.observedAt = '2026-11-07T14:04:00Z';
  assert.throws(() => buildYasnoAddressCandidate(reversed), /CHAIN_REPLAY_OR_ORDER/);
  const noPolicy = input(); noPolicy.policy.maximumCaptureAgeMs = 0;
  assert.throws(() => buildYasnoAddressCandidate(noPolicy), /INVALID_CAPTURE_POLICY/);
});
test('input is unchanged and canonical request ordering keeps deterministic candidate identity', () => {
  const value = input(), before = structuredClone(value);
  const first = buildYasnoAddressCandidate(value);
  assert.deepEqual(value, before);
  const reordered = input(); const url = new URL(reordered.captures.group.url);
  reordered.captures.group.url = `${url.origin}${url.pathname}?houseId=30823&streetId=736&dsoId=902&regionId=25`;
  const again = buildYasnoAddressCandidate(reordered);
  assert.equal(first.binding.revisionId, again.binding.revisionId); assert.equal(first.address.id, again.address.id);
});
