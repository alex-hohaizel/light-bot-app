import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressRecord } from '../../shared/product-contract.ts';
import { searchAddressIndex, confirmAddressCandidate, applyAddressRevision, normalizeHouse, normalizeAddressText,
  parseStreetName, streetMatchesQuery, localityMatchesQuery, houseMatchesQuery, houseLookalikeSuggestion,
  matchAddressRecord, placeNameMatchesQuery } from '../../shared/address-index.ts';

const make = (id: string, house: string, territoryId = 'fixture-kyiv'): AddressRecord => ({ id, territoryId,
  label: 'Дім', locality: 'Тестове місто', street: 'вулиця Нова', aliases: ['вулиця Стара'],
  house: { number: house, literal: house } });
const index = [make('a12', '12'), make('a12a', '12А'), make('a12slash', '12/1'), make('a12hyphen', '12-1'), make('a12corpus', '12 корпус 1'), make('other-city', '12А', 'other-territory')];
const query = { territoryId: 'fixture-kyiv', locality: 'Тестове місто', street: 'нова' };
test('12,12А,12/1,12-1 and corpus remain distinct; spacing around Cyrillic letter is normalized', () => {
  for (const [house, id] of [['12', 'a12'], ['12 а', 'a12a'], ['12/1', 'a12slash'], ['12-1', 'a12hyphen'], ['12 корпус 1', 'a12corpus']]) {
    assert.deepEqual(searchAddressIndex(index, { ...query, house }).map(x => x.address.id), [id]);
  }
  assert.notEqual(normalizeHouse('12A'), normalizeHouse('12А'));
});
test('old and new names resolve the same UID without auto-confirming binding', () => {
  const current = searchAddressIndex(index, { ...query, house: '12А' });
  const historic = searchAddressIndex(index, { ...query, street: 'стара', house: '12А' });
  assert.equal(current[0].address.id, historic[0].address.id);
  assert.equal(historic[0].match, 'historical_name');
  assert.equal(historic[0].requiresConfirmation, true); assert.equal(historic[0].bindingVerified, false);
});
test('ambiguous candidates require explicit exact selection and cannot cross territories', () => {
  const candidates = searchAddressIndex(index, query); assert.equal(candidates.length, 5);
  assert.throws(() => confirmAddressCandidate(candidates, 'other-city'), /SELECTION/);
  assert.equal(confirmAddressCandidate(candidates, 'a12a').house.literal, '12А');
  assert.throws(() => searchAddressIndex(index, { ...query, territoryId: '' }), /TERRITORY/);
});
test('renaming retains stable ID and source alias; identity change on sameUID is rejected', () => {
  const changed = applyAddressRevision(index, { ...index[0], street: 'вулиця Найновіша' });
  assert.equal(changed.length, index.length);
  assert.equal(searchAddressIndex(changed, { ...query, house: '12' })[0].address.id, 'a12');
  assert.throws(() => applyAddressRevision(changed, { ...index[0], house: { number: '99', literal: '99' } }), /IDENTITY_CONFLICT/);
});
test('NFC, apostrophe variants, nonbreaking hyphens and whitespace match without transliteration', () => {
  assert.equal(normalizeAddressText('  І\u0308вана‑Франка\u00a0  '), normalizeAddressText('Ївана-Франка'));
  for (const apostrophe of ['’', '‘', '`', 'ʼ', 'ʻ', '＇']) assert.equal(normalizeAddressText(`Сім${apostrophe}ї`), "сім'ї");
  assert(streetMatchesQuery('вулиця Північна', 'вул.Північна'));
  assert(streetMatchesQuery('вул. Івана–Франка', 'вулиця Івана-Франка', 'exact'));
  assert(!streetMatchesQuery('вулиця Північна', 'Pivnichna'));
});
test('typed street abbreviations preserve avenue/lane/boulevard identities', () => {
  assert.deepEqual(parseStreetName('пр-т Берестейський'), { type: 'avenue', name: 'берестейський', key: 'avenue:берестейський' });
  assert(streetMatchesQuery('проспект Берестейський', 'просп.Берестейський', 'exact'));
  assert(streetMatchesQuery('провулок Берестейський', 'пров. Берестейський', 'exact'));
  assert(!streetMatchesQuery('провулок Берестейський', 'просп. Берестейський'));
  assert(!streetMatchesQuery('проспект Берестейський', 'вул. Берестейський'));
  assert(!streetMatchesQuery('бульвар Шевченка', 'вул. Шевченка'));
  assert(streetMatchesQuery('проспект Берестейський', 'Берест'));
  assert(!streetMatchesQuery('вулиця Нова', 'вул.'));
});
test('house discovery prefix is separate from exact selection; punctuation and corpus remain distinct', () => {
  assert(houseMatchesQuery('12А', '12 а'));
  assert(houseMatchesQuery('12A', '12 A'));
  assert(houseMatchesQuery('12/1', '12 / 1'));
  assert(houseMatchesQuery('12 корпус 1', '12 корп.1'));
  for (const literal of ['12А', '12A', '12/1', '12-1', '12 корпус 1']) {
    assert(!houseMatchesQuery(literal, '12'));
    assert(houseMatchesQuery(literal, '12', 'prefix'));
  }
  assert(!houseMatchesQuery('12/1', '12-1'));
  assert(!houseMatchesQuery('12 корпус 1', '12/1'));
  assert(!houseMatchesQuery('012', '12'));
});
test('Latin/Cyrillic lookalikes are explicit suggestions only and never exact address candidates', () => {
  assert(houseLookalikeSuggestion('12А', '12A'));
  assert(houseLookalikeSuggestion('12A', '12А'));
  for (const [a, b] of [['12А', '12А'], ['12А', '12'], ['12А', '13A'], ['12/1', '12-1'], ['12А/1', '12A/1'], ['12Б', '12B']]) assert(!houseLookalikeSuggestion(a, b));
  assert.equal(searchAddressIndex(index, { ...query, house: '12A' }).length, 0);
  assert(!houseMatchesQuery('12А', '12A'));
});
test('same-named settlements and streets are scoped by source IDs without inventing registry geography', () => {
  const a = { ...make('one', '12'), locality: 'село Зелене', localityId: 'hromada-one:zelene', streetId: 'one:nova' };
  const b = { ...make('two', '12'), locality: 'село Зелене', localityId: 'hromada-two:zelene', streetId: 'two:nova' };
  const q = { ...query, locality: 'с.Зелене', house: '12' };
  assert.deepEqual(searchAddressIndex([a, b], q).map(v => v.address.id), ['one', 'two']);
  assert.deepEqual(searchAddressIndex([a, b], { ...q, localityId: 'hromada-two:zelene' }).map(v => v.address.id), ['two']);
  assert.equal(searchAddressIndex([a, b], { ...q, localityId: 'hromada-one:zelene', streetId: 'two:nova' }).length, 0);
  assert(!localityMatchesQuery('село Зелене', 'м. Зелене'));
  assert(localityMatchesQuery('місто Київ', 'м.Київ'));
});
test('only supplied locality/street aliases participate; no fuzzy spelling or near-name auto-binding', () => {
  const address = { ...make('renamed', '12'), locality: 'Самар', localityId: 'stable-locality', localityAliases: ['Новомосковськ'] };
  const hit = matchAddressRecord(address, { ...query, locality: 'Новомосковськ', house: '12', street: 'вул. Стара' });
  assert.equal(hit?.address.id, 'renamed'); assert.equal(hit?.match, 'historical_name');
  assert.equal(hit?.bindingVerified, false); assert.equal(hit?.requiresConfirmation, true);
  assert.equal(matchAddressRecord(address, { ...query, locality: 'Самар', street: 'Новва' }), null);
  assert.equal(matchAddressRecord(address, { ...query, locality: 'Ново-Московськ' }), null);
});
test('sameUID cannot move city; verified stable-locality rename and safe metadata enrichment preserve identity', () => {
  assert.throws(() => applyAddressRevision(index, { ...index[0], locality: 'Інше місто' }), /IDENTITY_CONFLICT/);
  const source = { ...index[0], localityId: 'city-id', locality: 'Стара назва' };
  const renamed = applyAddressRevision([source], { ...source, locality: 'Нова назва' });
  assert.deepEqual(renamed[0].localityAliases, ['Стара назва']);
  assert.throws(() => applyAddressRevision([source], { ...source, localityId: 'different-city-id' }), /IDENTITY_CONFLICT/);
  assert.throws(() => applyAddressRevision([source], { ...source, localityId: undefined }), /IDENTITY_CONFLICT/);
  assert.equal(applyAddressRevision(index, { ...index[0], localityId: 'newly-supplied-stable-id' }).find(a => a.id === 'a12')?.localityId, 'newly-supplied-stable-id');
});
test('invalid controls/oversized input fail deterministically and empty queries do not produce whole catalogs', () => {
  for (const bad of ['Нова\u0000', 'Нова\u202e', 'Нова\u200b', 'x'.repeat(501)]) {
    assert.throws(() => normalizeAddressText(bad), /ADDRESS_INVALID_TEXT/);
    assert(!streetMatchesQuery('вулиця Нова', bad));
    assert.throws(() => searchAddressIndex(index, { ...query, street: bad }), /ADDRESS_INVALID_QUERY/);
  }
  assert(!houseMatchesQuery('12', '')); assert(!localityMatchesQuery('Київ', ''));
  assert.deepEqual(searchAddressIndex(index, { ...query, street: ' ' }), []);
  assert.throws(() => searchAddressIndex(index, { ...query, streetId: '' }), /ADDRESS_INVALID_QUERY/);
  assert.throws(() => applyAddressRevision(index, { ...index[0], locality: '' }), /ADDRESS_INVALID_RECORD/);
  assert.equal(matchAddressRecord({ ...index[0], aliases: null as any }, query), null);
});
test('search/confirmation returns detached address values and never chooses one of duplicate IDs', () => {
  const candidates = searchAddressIndex(index, { ...query, house: '12' }); candidates[0].address.street = 'Changed by caller';
  assert.equal(index[0].street, 'вулиця Нова');
  const clean = searchAddressIndex(index, { ...query, house: '12' }), confirmed = confirmAddressCandidate(clean, 'a12');
  confirmed.house.literal = '999'; assert.equal(clean[0].address.house.literal, '12');
  assert.throws(() => confirmAddressCandidate([...clean, ...clean], 'a12'), /EXACT_ADDRESS_SELECTION/);
});
test('named commercial metadata supports discovery without inventing street aliases or provider binding', () => {
  assert(placeNameMatchesQuery('ТРЦ Lavina Mall', 'lavina'));
  assert(!placeNameMatchesQuery('ТРЦ Lavina Mall', 'Лавіна'));
  assert(!placeNameMatchesQuery('ТРЦ Lavina Mall', ''));
  const address = { ...make('trc', '6'), placeNames: ['ТРЦ Lavina Mall'], objectKind: 'commercial' as const };
  assert.equal(matchAddressRecord(address, { ...query, street: 'Lavina' }), null);
  assert.deepEqual(address.aliases, ['вулиця Стара']);
});
test('F1 known street ID change or removal cannot fabricate a rename alias under the same address UID', () => {
  const before = { ...make('street-bound', '12'), localityId: 'city-id', streetId: 'street-A' }, snapshot = structuredClone(before);
  for (const streetId of ['street-B', undefined]) {
    assert.throws(() => applyAddressRevision([before], { ...before, streetId, street: 'провулок Нова' }), /ADDRESS_ID_IDENTITY_CONFLICT/);
  }
  assert.deepEqual(before, snapshot);
  const renamed = applyAddressRevision([before], { ...before, street: 'вулиця Новітня' });
  assert.equal(renamed[0].streetId, 'street-A');assert(renamed[0].aliases.includes('вулиця Нова'));
});
test('F2 duplicate registry UIDs fail closed before any cross-territory row can be collapsed', () => {
  const first = { ...make('duplicated', '12'), localityId: 'city-A' };
  const foreign = { ...make('duplicated', '12', 'foreign-territory'), localityId: 'city-B' };
  for (const records of [[first, foreign], [foreign, first], [first, structuredClone(first)]]) {
    const before = structuredClone(records);
    assert.throws(() => applyAddressRevision(records, { ...first, street: 'вулиця Новітня' }), /ADDRESS_DUPLICATE_ID/);
    assert.deepEqual(records, before);
  }
});
test('F3 address and nested house are closed primitive DTOs before search or confirmation', () => {
  const good = make('safe', '12');
  const bad: any[] = [
    { ...good, label: { privateProvenance: 'private-marker' } },
    { ...good, house: { ...good.house, letter: { privateToken: 'private-marker' } } },
    { ...good, house: { ...good.house, building: ['private-marker'] } },
    { ...good, house: { ...good.house, extraPrivate: 'private-marker' } },
    { ...good, objectKind: 'untrusted-kind' },
    { ...good, extraPrivate: { token: 'private-marker' } },
    { ...good, placeNames: ['Known', { token: 'private-marker' }] },
    { ...good, aliases: Object.assign(['вулиця Стара'], { privateData: 'private-marker' }) },
  ];
  for (const address of bad) {
    assert.deepEqual(searchAddressIndex([address], { ...query, house: '12' }), []);
    assert.throws(() => confirmAddressCandidate([{ address, matchedStreet: good.street, match: 'current_name', requiresConfirmation: true, bindingVerified: false }], good.id), /EXACT_ADDRESS_SELECTION_REQUIRED/);
    assert.throws(() => applyAddressRevision([], address), /ADDRESS_INVALID_RECORD/);
  }
  const valid = { ...good, house: { ...good.house, letter: 'А', building: '1' }, objectKind: 'commercial' as const, placeNames: ['Перевірена назва'] };
  assert.equal(confirmAddressCandidate(searchAddressIndex([valid], query), good.id).objectKind, 'commercial');
});
