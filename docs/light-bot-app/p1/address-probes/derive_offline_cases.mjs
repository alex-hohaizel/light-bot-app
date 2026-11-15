import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { normalizeYasnoRaw } from '../../../../app/server/domain/yasno-adapter.ts';
const input = JSON.parse(await readFile(new URL('binding-candidates.json', import.meta.url)));
const raw = await readFile(new URL('../fixtures/yasno-kem.json', import.meta.url), 'utf8');
const hash = createHash('sha256').update(raw).digest('hex');
const results = input.cases.map(candidate => {
  assert.equal(candidate.captured_schedule_cross_reference.sha256, hash);
  const view = normalizeYasnoRaw(raw, 'today', { namespace: 'yasno:25/902', operatorId: 'dtek-kem', targetId: candidate.target_id,
    addressId: candidate.provider_address_id, addressLabel: `Публічний зразок · ${candidate.house_literal}`,
    localityLabel: 'Київ · точковий source-reported candidate', serviceDate: '2026-11-07',
    observedAt: candidate.captured_schedule_cross_reference.observed_at_utc,
    source: { id: 'yasno-kem', name: 'YASNO · зафіксована публічна відповідь', url: 'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages', revision: hash, accessCost: 0, verifiedLevel: 'catalog' },
    freshness: 'current', synthetic: false });
  assert.equal(view.deliveryEligible, false);
  assert.equal(view.bindingRevisionId, undefined);
  assert.equal(view.targetId, candidate.target_id);
  return { case_id: candidate.case_id, binding_verdict: candidate.verdict, view };
});
await writeFile(new URL('offline-contract-cases.json', import.meta.url), JSON.stringify({ actor: '/root/public_address_probe', result: 'pass', executed_at_utc: new Date().toISOString(), adapter: 'normalizeYasnoRaw', count: results.length, limits: ['Existing captured plan plus later public binding candidate, same upstream; no simultaneous revision guarantee, independentOSR or final address admission.'], cases: results }, null, 2) + '\n');
console.log(JSON.stringify({ result: 'pass', candidates: results.length, notifications_enabled: false }));
