import { createHash } from 'node:crypto';
import { localParts, validInstant } from '../../shared/schedule-core.ts';

// Exact output of the separately reviewed producer. A new book needs repinning.
const BOOK_SHA256 = 'bfa5e98e7b4560ed08ec6e5266c0f98c735572f8615c7c118003351488b05c36';
export interface CapturedAddressPreview {
  id: string; label: string; addressId: string; bindingRevisionId: string; targetId: string;
  status: 'needs_confirmation'; observedAt: string;
}
const fail = (): never => { throw new Error('CAPTURED_ADDRESS_PROOF_INVALID'); };
const text = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);

/** Validate and project only public display fields, never the whole proof object. */
export function capturedAddressPreview(value: any, evaluatedAt: string): CapturedAddressPreview {
  const a = value?.address, b = value?.binding, p = value?.proof, s = value?.source;
  if (!text(value?.case_id) || !/^[a-z0-9-]+$/.test(value.case_id) || value.kind !== 'yasno-address-candidate/1' ||
      !a || !b || !p || !s || !text(a.id, 256) || !text(a.street) || !text(a.house?.literal, 32) ||
      a.locality !== 'Київ' || a.territoryId !== 'source:yasno:25/902' || !Array.isArray(a.aliases) || a.aliases.length ||
      b.addressId !== a.id || b.operatorId !== 'dtek-kem' || b.namespace !== 'yasno:25/902' ||
      b.kind !== 'operator_group' || b.status !== 'needs_confirmation' || b.verifiedAt !== null || b.effectiveFrom !== null || b.effectiveUntil !== null ||
      !text(b.targetId) || !/^(?:[1-9]|[1-5]\d|60)\.1$/.test(b.targetId) ||
      !text(s.revision) || !/^[a-f0-9]{64}$/.test(s.revision) || b.revisionId !== `yasno-address-candidate:${s.revision}` ||
      s.id !== 'yasno-public-address-v2' || s.verifiedLevel !== 'catalog' || s.accessCost !== 0 ||
      p.scope?.operatorId !== b.operatorId || p.scope?.namespace !== b.namespace || p.scope?.regionId !== 25 || p.scope?.dsoId !== 902 ||
      p.verdict !== 'source_reported_binding_candidate' || p.providerStreetValue !== a.street || p.providerHouseLiteral !== a.house.literal ||
      p.canonicalMunicipalAddressId !== null || p.katottg !== null || p.connectionId !== null || p.providerEffectiveRevision !== null ||
      p.aliasesVerified !== false || p.catalogCompleteness !== 'unknown' || p.independentlyConfirmed !== false || p.deliveryEligible !== false ||
      !validInstant(evaluatedAt) || !validInstant(p.observedAt)) return fail();
  const identity = /^provisional:yasno:25\/902:street:(\d+):house:(\d+)$/.exec(a.id);
  if (!identity || Number(identity[1]) !== p.providerStreetId || Number(identity[2]) !== p.providerHouseId ||
      p.providerAddressId !== a.id.replace('provisional:', '') || localParts(Date.parse(p.observedAt)).date !== localParts(Date.parse(evaluatedAt)).date ||
      Date.parse(p.observedAt) > Date.parse(evaluatedAt) || Date.parse(evaluatedAt) - Date.parse(p.observedAt) > 15 * 60_000) return fail();
  if (!text(s.url, 2048)) return fail();
  let url: URL;
  try { url = new URL(s.url); } catch { return fail(); }
  if (url.protocol !== 'https:' || url.hostname !== 'app.yasno.ua' || url.port || url.username || url.password || url.hash ||
      url.pathname !== '/api/blackout-service/public/shutdowns/addresses/v2/group' ||
      [...url.searchParams.keys()].sort().join(',') !== 'dsoId,houseId,regionId,streetId' ||
      url.searchParams.get('regionId') !== '25' || url.searchParams.get('dsoId') !== '902' ||
      url.searchParams.get('streetId') !== identity[1] || url.searchParams.get('houseId') !== identity[2]) return fail();
  return { id: value.case_id, label: `${a.street}, ${a.house.literal}`, addressId: a.id,
    bindingRevisionId: b.revisionId, targetId: b.targetId, status: 'needs_confirmation', observedAt: p.observedAt };
}
export function parseCapturedAddressBook(raw: string): CapturedAddressPreview[] {
  if (Buffer.byteLength(raw) > 150_000 || createHash('sha256').update(raw).digest('hex') !== BOOK_SHA256) return fail();
  const book = JSON.parse(raw);
  if (book.kind !== 'lba-offline-yasno-address-candidates/1' || book.count !== 12 || book.certified_addresses !== 0 ||
      book.notifications_enabled !== false || !Array.isArray(book.cases) || book.cases.length !== book.count) return fail();
  const cases = book.cases.map((value: unknown) => capturedAddressPreview(value, book.capture_evaluation_clock));
  if (new Set(cases.map((value: CapturedAddressPreview) => value.id)).size !== cases.length ||
      new Set(cases.map((value: CapturedAddressPreview) => value.addressId)).size !== cases.length) return fail();
  return cases;
}
