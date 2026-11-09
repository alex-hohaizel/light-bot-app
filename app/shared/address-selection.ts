import type { AddressRecord,AddressBinding } from './product-contract.ts';
import type { AddressOption } from './bot/types.ts';
import { normalizeAddressText } from './address-index.ts';

/** Keys distinguish identities; names are a compatibility fallback, never proof. */
export function addressLocalityKey(address: AddressRecord): string {
  return JSON.stringify([address.territoryId, address.localityId
    ? ['id', address.localityId] : ['name', normalizeAddressText(address.locality)]]);
}
export function addressStreetKey(address: AddressRecord): string {
  return JSON.stringify([addressLocalityKey(address), address.streetId
    ? ['id', address.streetId] : ['name', normalizeAddressText(address.street)]]);
}

/** Exact, portable, collision-free comparison of what the person confirms.
 * This is a comparison token, not authorization or a provider verification grant.
 * Personal labels are deliberately excluded; connection/scope changes are not.
 */
export function addressOptionFingerprint(option: AddressOption): string {
  const a=option.address,b=option.binding;
  const value=JSON.stringify([option.id,a.id,a.territoryId,a.localityId??null,a.locality,
    [...(a.localityAliases??[])].sort(),a.streetId??null,a.street,a.house.number,
    a.house.letter??null,a.house.building??null,a.house.literal,[...a.aliases].sort(),
    [...(a.placeNames??[])].sort(),a.objectKind??null,b.addressId,b.operatorId,
    b.namespace,b.targetId,b.kind,b.revisionId,b.status,b.verifiedAt,b.effectiveFrom,
    b.effectiveUntil,option.territoryLabel,option.connectionLabel??null]);
  if(value.length>32768)throw new Error('ADDRESS_SELECTION_TOO_LARGE');
  return value;
}

/** Choosing one of several operator-listed groups records the person's choice,
 * without resolving the building's electrical ambiguity or granting delivery.
 * Call only AFTER exact option/fingerprint and explicit owner confirmation.
 */
export function isManualDtekGroupChoice(binding:AddressBinding):boolean {
  return binding.operatorId==='dtek-oem'&&binding.namespace==='dtek:oem'&&binding.kind==='operator_group'&&binding.status==='ambiguous'&&
    /^GPV[1-6]\.[12]$/.test(binding.targetId??'')&&binding.verifiedAt===null&&binding.effectiveFrom===null&&binding.effectiveUntil===null;
}
export function confirmedAddressBinding(binding:AddressBinding):AddressBinding {
  const copy=structuredClone(binding);
  return isManualDtekGroupChoice(binding)?{...copy,kind:'user_selected_group',status:'needs_confirmation',verifiedAt:null,effectiveFrom:null,effectiveUntil:null}:copy;
}
