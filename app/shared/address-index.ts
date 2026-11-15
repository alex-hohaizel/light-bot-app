import type { AddressRecord } from './product-contract.ts';

export interface AddressSearch {
  territoryId: string;
  locality: string;
  street: string;
  house?: string;
}
export interface AddressCandidate {
  address: AddressRecord;
  matchedStreet: string;
  match: 'current_name' | 'historical_name';
  requiresConfirmation: true;
  bindingVerified: false;
}
/** Text normalization preserves street type, letter, slash, hyphen and corpus. */
export function normalizeAddressText(value: string): string {
  return value.normalize('NFC').replace(/[’‘`ʼ]/g, "'").replace(/[–—−]/g, '-').trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA');
}
export function normalizeHouse(value: string): string {
  // A space before an explicit house letter is presentation, not another house.
  // We do not merge Latin/Cyrillic lookalikes, fractions, suffixes or corpora.
  return normalizeAddressText(value).replace(/^(\d+)\s+([а-яіїєґ])(?=$|\s|[/-])/u, '$1$2');
}
export function searchAddressIndex(index: readonly AddressRecord[], query: AddressSearch): AddressCandidate[] {
  if (!query.territoryId || !normalizeAddressText(query.locality)) throw new Error('ADDRESS_TERRITORY_REQUIRED');
  const street = normalizeAddressText(query.street);
  if (street.length < 2) return [];
  const house = query.house === undefined ? undefined : normalizeHouse(query.house);
  const candidates: AddressCandidate[] = [];
  for (const address of index) {
    if (address.territoryId !== query.territoryId || normalizeAddressText(address.locality) !== normalizeAddressText(query.locality)) continue;
    const names = [{ name: address.street, match: 'current_name' as const }, ...address.aliases.map(name => ({ name, match: 'historical_name' as const }))];
    const matched = names.find(item => normalizeAddressText(item.name).includes(street));
    if (!matched || (house !== undefined && normalizeHouse(address.house.literal) !== house)) continue;
    candidates.push({ address, matchedStreet: matched.name, match: matched.match, requiresConfirmation: true, bindingVerified: false });
  }
  return candidates.sort((a, b) => a.address.street.localeCompare(b.address.street, 'uk') || a.address.house.literal.localeCompare(b.address.house.literal, 'uk', { numeric: true }));
}
export function confirmAddressCandidate(candidates: readonly AddressCandidate[], selectedId: string): AddressRecord {
  const matches = candidates.filter(c => c.address.id === selectedId);
  if (matches.length !== 1) throw new Error('EXACT_ADDRESS_SELECTION_REQUIRED');
  return matches[0].address;
}
/** Merge a rename by immutable registry UID; old/new names never create another address. */
export function applyAddressRevision(index: readonly AddressRecord[], incoming: AddressRecord): AddressRecord[] {
  const previous = index.find(item => item.id === incoming.id);
  if (previous && (previous.territoryId !== incoming.territoryId || normalizeHouse(previous.house.literal) !== normalizeHouse(incoming.house.literal))) {
    throw new Error('ADDRESS_ID_IDENTITY_CONFLICT');
  }
  const aliases = new Set([...(previous?.aliases || []), ...incoming.aliases]);
  if (previous && previous.street !== incoming.street) aliases.add(previous.street);
  aliases.delete(incoming.street);
  const merged = { ...incoming, aliases: [...aliases] };
  return [...index.filter(item => item.id !== incoming.id), merged];
}
