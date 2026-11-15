import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capturedAddressPreview, parseCapturedAddressBook } from '../../server/domain/captured-address-book.ts';
const raw = readFileSync(new URL('../../../docs/light-bot-app/p2/address-adapter/candidates.json', import.meta.url), 'utf8');
const book = JSON.parse(raw);

test('reviewed exact book projects12 minimal public candidates with no verified promotion', () => {
  const cases = parseCapturedAddressBook(raw);
  assert.equal(cases.length, 12); assert.equal(cases[0].targetId, '45.1');
  assert(cases.every(value => value.status === 'needs_confirmation'));
  assert.deepEqual(Object.keys(cases[0]).sort(), ['addressId', 'bindingRevisionId', 'id', 'label', 'observedAt', 'status', 'targetId']);
});
test('changed target or any changed book byte requires a newly reviewed pin', () => {
  const changed = structuredClone(book); changed.cases[0].binding.targetId = '1.1';
  assert.throws(() => parseCapturedAddressBook(JSON.stringify(changed)), /PROOF_INVALID/);
  assert.throws(() => parseCapturedAddressBook(raw + ' '), /PROOF_INVALID/);
});
test('foreign scope, stale proof and unsafe case objects cannot enter the display projection', () => {
  for (const change of [
    (c: any) => { c.proof.scope.operatorId = 'cek'; },
    (c: any) => { c.address.id = 'provisional:yasno:3/303:street:736:house:30823'; },
    (c: any) => { c.proof.observedAt = '2025-11-07T14:01:00Z'; },
    (c: any) => { c.case_id = { private: 'must not be returned' }; },
    (c: any) => { c.binding.status = 'verified'; },
    (c: any) => { c.binding.revisionId = 'another-house-proof'; },
  ]) {
    const value = structuredClone(book.cases[0]); change(value);
    assert.throws(() => capturedAddressPreview(value, book.capture_evaluation_clock), /PROOF_INVALID/);
  }
});
test('request URL house/operator scope stays attached to the selected address', () => {
  for (const change of [
    (c: any) => { c.source.url = c.source.url.replace('houseId=30823', 'houseId=30822'); },
    (c: any) => { c.source.url = c.source.url.replace('dsoId=902', 'dsoId=303'); },
    (c: any) => { c.source.url += '&houseId=30822'; },
    (c: any) => { c.source.url = c.source.url.replace('https:', 'http:'); },
  ]) { const value = structuredClone(book.cases[0]); change(value); assert.throws(() => capturedAddressPreview(value, book.capture_evaluation_clock), /PROOF_INVALID/); }
});
