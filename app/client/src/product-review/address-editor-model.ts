import type { AddressOption } from '../../../shared/bot/types.ts';
import { houseLookalikeSuggestion, houseMatchesQuery, normalizeHouse, placeNameMatchesQuery, streetMatchesQuery } from '../../../shared/address-index.ts';
import { addressLocalityKey, addressOptionFingerprint, addressStreetKey } from '../../../shared/address-selection.ts';
import { profileErrorMessage } from '../../../shared/profile-errors.ts';

/** Bounded presentation only. Address matching belongs to the shared App/Bot index. */
export const ADDRESS_PAGE_SIZE = 8;
export type CatalogStatus = 'ready' | 'loading' | 'unavailable';
export interface CityChoice { key: string; name: string; territoryId: string; territoryLabel: string }
export interface StreetChoice { key: string; name: string; matchedAlias: string | null; matchedObject: string | null; houseExamples: string[] }
export interface HouseChoice { key: string; literal: string; options: AddressOption[] }
export const cityKeyFor = (option: AddressOption) => addressLocalityKey(option.address);
export function catalogCities(catalog: readonly AddressOption[]): CityChoice[] {
  const cities = new Map<string, CityChoice>();
  for (const option of catalog) {
    const key = cityKeyFor(option);
    if (!cities.has(key)) cities.set(key, { key, name: option.address.locality, territoryId: option.address.territoryId, territoryLabel: option.territoryLabel });
  }
  return [...cities.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk') || a.territoryLabel.localeCompare(b.territoryLabel, 'uk'));
}
export function belongsToCity(option: AddressOption, city: CityChoice): boolean {
  return addressLocalityKey(option.address) === city.key;
}
export function streetChoices(catalog: readonly AddressOption[], city: CityChoice | undefined, query: string): StreetChoice[] {
  if (!city) return [];
  const choices = new Map<string, StreetChoice>();
  for (const option of catalog) {
    if (!belongsToCity(option, city)) continue;
    const current = streetMatchesQuery(option.address.street, query);
    const alias = option.address.aliases.find(name => streetMatchesQuery(name, query));
    const object = option.address.placeNames?.find(name => placeNameMatchesQuery(name, query));
    if (!current && !alias && !object) continue;
    const key = addressStreetKey(option.address);
    if (!choices.has(key)) choices.set(key, { key, name: option.address.street, matchedAlias: current ? null : alias || null, matchedObject: !current && !alias ? object || null : null, houseExamples: [] });
    const examples = choices.get(key)!.houseExamples;
    if (examples.length < 3 && !examples.includes(option.address.house.literal)) examples.push(option.address.house.literal);
  }
  return [...choices.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}
export function houseChoices(catalog: readonly AddressOption[], city: CityChoice | undefined, streetKey: string, objectQuery = ''): HouseChoice[] {
  if (!city || !streetKey) return [];
  const choices = new Map<string, HouseChoice>();
  for (const option of catalog) {
    if (!belongsToCity(option, city) || addressStreetKey(option.address) !== streetKey) continue;
    const key = normalizeHouse(option.address.house.literal);
    if (!choices.has(key)) choices.set(key, { key, literal: option.address.house.literal, options: [] });
    choices.get(key)!.options.push(option);
  }
  // Object discovery narrows physical houses, never drops another connection to that house.
  return [...choices.values()].filter(choice => !objectQuery || choice.options.some(option => option.address.placeNames?.some(name => placeNameMatchesQuery(name, objectQuery))))
    .sort((a, b) => a.literal.localeCompare(b.literal, 'uk', { numeric: true }));
}
export function filterHouses(choices: readonly HouseChoice[], query: string): HouseChoice[] {
  return query.trim() ? choices.filter(h => houseMatchesQuery(h.literal, query, 'prefix')) : [...choices];
}
export function suggestedHouses(choices: readonly HouseChoice[], query: string): HouseChoice[] {
  return query.trim() ? choices.filter(h => houseLookalikeSuggestion(h.literal, query)) : [];
}
export function pageItems<T>(items: readonly T[], requestedPage: number): { items: T[]; page: number; pages: number; start: number; total: number } {
  const pages = Math.max(1, Math.ceil(items.length / ADDRESS_PAGE_SIZE));
  const page = Math.min(Math.max(0, Number.isInteger(requestedPage) ? requestedPage : 0), pages - 1);
  return { items: items.slice(page * ADDRESS_PAGE_SIZE, (page + 1) * ADDRESS_PAGE_SIZE), page, pages, start: page * ADDRESS_PAGE_SIZE, total: items.length };
}
/** Same canonical selection token as the server; a token is never authentication. */
export function optionConsentToken(option: AddressOption): string {
  try { return addressOptionFingerprint(option); } catch { return ''; }
}
export function selectedCatalogOption(catalog: readonly AddressOption[], selection: { optionId: string; cityKey: string; streetKey: string; street: string; house: string; bindingRevisionId: string }): AddressOption | undefined {
  const matches = catalog.filter(option => option.id === selection.optionId);
  if (matches.length !== 1) return undefined;
  const option = matches[0];
  return cityKeyFor(option) === selection.cityKey && addressStreetKey(option.address) === selection.streetKey && streetMatchesQuery(option.address.street, selection.street, 'exact') &&
    houseMatchesQuery(option.address.house.literal, selection.house) && option.binding.revisionId === selection.bindingRevisionId &&
    option.binding.addressId === option.address.id ? option : undefined;
}
export function hasCurrentConsent(option: AddressOption | undefined, token: string): boolean {
  return Boolean(option && token && optionConsentToken(option) === token && ['verified', 'needs_confirmation'].includes(option.binding.status));
}
/** Unknown server text can contain internals. Only named outcomes become UI copy. */
export function addressSaveError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown } : {};
  return profileErrorMessage(value.status === 401 ? 'LIVE_PROFILE_AUTH_REQUIRED' : value.code);
}
