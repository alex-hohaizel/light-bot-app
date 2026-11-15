/** Synthetic review drafts stay in this tab and are never sent to a provider. */
export interface DraftScope { ownerId: string; sessionId: string }
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const PREFIX = 'lba:ux-a:draft:';
export const MAX_DRAFT_BYTES = 65536;
const scopeValid = (scope: DraftScope) => typeof scope.ownerId === 'string' && scope.ownerId.length > 0 && scope.ownerId.length <= 200 &&
  typeof scope.sessionId === 'string' && scope.sessionId.length > 0 && scope.sessionId.length <= 200;
export function draftStorage(): DraftStorage | undefined { try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; } }
export function clearDraft(kind: string, storage = draftStorage()): void { try { storage?.removeItem(PREFIX + kind); } catch { /* Storage can be unavailable; in-memory editing still works. */ } }
export function loadDraft<T>(kind: string, scope: DraftScope, parse: (value: unknown) => T, storage = draftStorage()): T | null {
  try {
    const raw = storage?.getItem(PREFIX + kind);
    if (!raw) return null;
    if (!scopeValid(scope) || raw.length > MAX_DRAFT_BYTES) throw new Error('INVALID_DRAFT');
    const value = JSON.parse(raw);
    if (!value || Object.keys(value).sort().join(',') !== 'ownerId,payload,sessionId,version' || value.version !== 1 ||
      value.ownerId !== scope.ownerId || value.sessionId !== scope.sessionId) throw new Error('DRAFT_SCOPE_CHANGED');
    return parse(value.payload);
  } catch { clearDraft(kind, storage); return null; }
}
export function saveDraft<T>(kind: string, scope: DraftScope, payload: T, storage = draftStorage()): boolean {
  try {
    if (!storage || !scopeValid(scope)) return false;
    const raw = JSON.stringify({ version: 1, ...scope, payload });
    if (raw.length > MAX_DRAFT_BYTES) return false;
    storage.setItem(PREFIX + kind, raw); return true;
  } catch { return false; }
}
export function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('INVALID_DRAFT');
  return value as Record<string, unknown>;
}
export function draftText(value: unknown, maximum = 200): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('INVALID_DRAFT');
  return value;
}
export function draftFlag(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('INVALID_DRAFT'); return value; }
export function draftInteger(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) throw new Error('INVALID_DRAFT');
  return value;
}

export interface AddressDraft {
  addressId: string | null; baselineFingerprint: string; baselineLabel: string;
  step: number; cityKey: string; query: string; street: string; house: string; label: string;
  confirmed: boolean; optionId: string; bindingRevisionId: string;
}
export function parseAddressDraft(input: unknown): AddressDraft {
  const v = exactKeys(input, ['addressId', 'baselineFingerprint', 'baselineLabel', 'step', 'cityKey', 'query', 'street', 'house', 'label', 'confirmed', 'optionId', 'bindingRevisionId']);
  return { addressId: v.addressId === null ? null : draftText(v.addressId), baselineFingerprint: draftText(v.baselineFingerprint, 4096), baselineLabel: draftText(v.baselineLabel, 32),
    step: draftInteger(v.step, 2), cityKey: draftText(v.cityKey, 600), query: draftText(v.query), street: draftText(v.street), house: draftText(v.house, 100), label: draftText(v.label, 32),
    confirmed: draftFlag(v.confirmed), optionId: draftText(v.optionId), bindingRevisionId: draftText(v.bindingRevisionId) };
}
export function loadAddressDraft(scope: DraftScope): AddressDraft | null { return loadDraft('address', scope, parseAddressDraft); }

/** Always include the open address; missing/deleted IDs never become another participant. */
export function compareParticipantIds(activeId: string, selectedIds: string[], availableIds: string[]): string[] {
  const available = new Set(availableIds);
  return [...new Set([activeId, ...selectedIds])].filter(id => available.has(id));
}
