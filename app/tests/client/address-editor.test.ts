import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressOption } from '../../shared/bot/types.ts';
import { addressStreetKey, addressOptionFingerprint } from '../../shared/address-selection.ts';
import { addressSaveError, catalogCities, cityKeyFor, filterHouses, hasCurrentConsent, houseChoices, optionConsentToken, pageItems, selectedCatalogOption, streetChoices, suggestedHouses } from '../../client/src/product-review/address-editor-model.ts';

function option(id = 'one', literal = '12А', extra: Partial<AddressOption> = {}): AddressOption {
  return { id, address: { id: `${id}:address`, label: '', territoryId: 'fixture-territory', localityId: 'fixture-locality', locality: 'Тестове місто', streetId: 'fixture-street', street: 'вулиця Нова', aliases: ['вул. Стара'], house: { number: literal, literal } },
    binding: { addressId: `${id}:address`, operatorId: 'fixture-operator', namespace: 'fixture-namespace', targetId: `${id}:target`, kind: 'connection', revisionId: 'fixture-binding', status: 'verified', verifiedAt: null, effectiveFrom: null, effectiveUntil: null }, territoryLabel: 'Тестова область', ...extra };
}
const select = (o: AddressOption) => ({ optionId: o.id, cityKey: cityKeyFor(o), streetKey: addressStreetKey(o.address), street: o.address.street, house: o.address.house.literal, bindingRevisionId: o.binding.revisionId });
test('street aliases use shared abbreviation, apostrophe, dash and case matching', () => {
  const a = option(); a.address.street = 'проспект Лесі-Українки'; a.address.aliases = ['просп. П’ятого Травня'];
  const cities = catalogCities([a]);
  assert.equal(streetChoices([a], cities[0], 'П\'ЯТОГО')[0].matchedAlias, 'просп. П’ятого Травня');
  assert.equal(streetChoices([a], cities[0], 'просп. Лесі—Українки').length, 1);
  assert.equal(streetChoices([a], cities[0], 'вул. Лесі-Українки').length, 0);
});
test('same-name localities with different catalog IDs stay separate', () => {
  const a=option(), b=option('two'); b.address.localityId='another-locality';
  assert.equal(catalogCities([a,b]).length,2);
  assert.equal(streetChoices([a,b],catalogCities([a,b]).find(c=>c.key===cityKeyFor(a)),'нова').length,1);
  assert.equal(selectedCatalogOption([a],{...select(a),cityKey:cityKeyFor(b)}),undefined);
});
test('same-name streets with separate stable IDs never combine their houses', () => {
  const a=option(), b=option('two','99'); b.address.streetId='other-street';
  const city=catalogCities([a,b])[0], streets=streetChoices([a,b],city,'нова');
  assert.equal(streets.length,2);
  assert.deepEqual(houseChoices([a,b],city,addressStreetKey(a.address)).map(h=>h.literal),['12А']);
  assert.equal(selectedCatalogOption([a],{...select(a),streetKey:addressStreetKey(b.address)}),undefined);
});
test('house fractions, suffixes, corpus and script remain distinct', () => {
  const choices=['12','12А','12A','12/1','12-1','12 корпус 1'].map((h,i)=>option(`a${i}`,h));
  const houses=houseChoices(choices,catalogCities(choices)[0],addressStreetKey(choices[0].address));
  assert.equal(houses.length,6);
  assert.deepEqual(filterHouses(houses,'12 а').map(h=>h.literal),['12А']);
  assert.deepEqual(filterHouses(houses,'12A').map(h=>h.literal),['12A']);
  assert.deepEqual(suggestedHouses(houses,'12A').map(h=>h.literal),['12А']);
  assert.equal(suggestedHouses(houses,'12/1').length,0);
});
test('all lists page to at most eight and retain every result across pages', () => {
  const input=Array.from({length:97},(_,i)=>i);
  const pages=Array.from({length:13},(_,page)=>pageItems(input,page));
  assert(pages.every(p=>p.items.length<=8));assert.deepEqual(pages.flatMap(p=>p.items),input);
  assert.equal(pageItems(input,999).page,12); assert.equal(pageItems([],0).pages,1);
});
test('multiple operators/connections stay explicit options beneath one house', () => {
  const a=option(), b=option('two'); b.binding.operatorId='second-operator';b.connectionLabel='Другий ввід';
  const houses=houseChoices([a,b],catalogCities([a,b])[0],addressStreetKey(a.address));
  assert.equal(houses.length,1);assert.equal(houses[0].options.length,2);
  assert.equal(selectedCatalogOption([a,b],{...select(a),optionId:''}),undefined);
  assert.equal(selectedCatalogOption([a,b],select(b))?.id,'two');
});
test('duplicate option IDs, disappeared options and changed revision fail closed', () => {
  const a=option();assert.equal(selectedCatalogOption([a,a],select(a)),undefined);
  assert.equal(selectedCatalogOption([],select(a)),undefined);
  assert.equal(selectedCatalogOption([a],{...select(a),bindingRevisionId:'old'}),undefined);
});
test('confirmation uses exact shared fingerprint and no persisted boolean can substitute', () => {
  const a=option();assert.equal(optionConsentToken(a),addressOptionFingerprint(a));
  assert.equal(hasCurrentConsent(a,''),false); assert.equal(hasCurrentConsent(a,optionConsentToken(a)),true);
});
test('same option ID/revision with changed binding or display metadata invalidates consent', () => {
  const a=option(), token=optionConsentToken(a);
  for(const update of [
    (v:AddressOption)=>{v.binding.operatorId='other';},(v:AddressOption)=>{v.binding.namespace='other';},
    (v:AddressOption)=>{v.binding.targetId='other';},(v:AddressOption)=>{v.binding.status='stale';},
    (v:AddressOption)=>{v.connectionLabel='Інший ввід';},(v:AddressOption)=>{v.territoryLabel='Інша область';},
    (v:AddressOption)=>{v.address.streetId='other';},(v:AddressOption)=>{v.address.placeNames=['Магазин'];},
  ]) { const changed=structuredClone(a);update(changed);assert.equal(changed.id,a.id);assert.equal(changed.binding.revisionId,a.binding.revisionId);assert.equal(hasCurrentConsent(changed,token),false); }
});
test('ambiguous/stale bindings cannot be approved; unverified address is not upgraded', () => {
  for(const status of ['ambiguous','stale'] as const){const a=option();a.binding.status=status;assert.equal(hasCurrentConsent(a,optionConsentToken(a)),false);}
  const a=option();a.binding.status='needs_confirmation';assert.equal(hasCurrentConsent(a,optionConsentToken(a)),true);assert.equal(a.binding.status,'needs_confirmation');
});
test('broken address-to-binding identity cannot become selected', () => {
  const a=option();a.binding.addressId='foreign';assert.equal(selectedCatalogOption([a],select(a)),undefined);
});
test('known errors map to human copy; unknown messages never reach the UI', () => {
  assert.match(addressSaveError({code:'PROFILE_SELECTION_CHANGED'}),/змінилися/);
  assert.match(addressSaveError({code:'PRODUCTION_COMMIT_UNKNOWN'}),/того самого запиту/);
  assert.match(addressSaveError({status:401}),/Увійдіть/);
  assert.doesNotMatch(addressSaveError(new Error('privateToken=secret SQL stack')),/secret|SQL|privateToken/);
});
test('supplied commercial names discover the real street without becoming aliases or losing another connection', () => {
  const a=option(), b=option('two');a.address.placeNames=['Крамниця «Промінь»'];
  const city=catalogCities([a,b])[0],streets=streetChoices([a,b],city,'промінь');
  assert.equal(streets.length,1);assert.equal(streets[0].name,'вулиця Нова');assert.equal(streets[0].matchedObject,'Крамниця «Промінь»');
  assert.equal(a.address.aliases.includes('Крамниця «Промінь»'),false);
  assert.equal(houseChoices([a,b],city,streets[0].key,'промінь')[0].options.length,2);
  assert.equal(streetChoices([a,b],city,'неіснуючий об’єкт').length,0);
});

test('safe server error copy makes no browser-persistence claim', () => {
  for (const code of ['PROFILE_OPTION_NOT_FOUND','PROFILE_REVISION_CONFLICT','PRODUCTION_COMMIT_UNKNOWN','PRODUCTION_TRANSACTION_RETRY_REQUIRED','UNKNOWN']) {
    assert.doesNotMatch(addressSaveError({code}),/чернетку збережено/iu);
  }
  assert.doesNotMatch(addressSaveError(new Error('rawPrivateToken')),/rawPrivateToken/);
});
