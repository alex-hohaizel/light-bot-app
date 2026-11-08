import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressRecord } from '../../shared/product-contract.ts';
import { searchAddressIndex, confirmAddressCandidate, applyAddressRevision, normalizeHouse } from '../../shared/address-index.ts';

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
