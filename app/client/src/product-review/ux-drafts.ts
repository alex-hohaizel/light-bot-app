/** Private address drafts stay in this tab, scoped to the owner and session. */
export interface DraftScope { ownerId: string; sessionId: string }
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const PREFIX = 'lba:ux-a:draft:';
export const MAX_DRAFT_BYTES = 65536;
const scopeValid = (scope: DraftScope) => typeof scope.ownerId === 'string' && scope.ownerId.length > 0 && scope.ownerId.length <= 255 &&
  typeof scope.sessionId === 'string' && scope.sessionId.length > 0 && scope.sessionId.length <= 255;
export function draftStorage(): DraftStorage | undefined { try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; } }
export function clearDraft(kind: string, storage = draftStorage()): void { try { storage?.removeItem(PREFIX + kind); } catch { /* Storage can be unavailable; in-memory editing still works. */ } }
/** A finished asynchronous edit cannot delete a newer account/session draft. */
export function readScopedDraftToken(kind:string,scope:DraftScope,storage=draftStorage()):string|null {
  try {
    const raw=storage?.getItem(PREFIX+kind);if(!raw||raw.length>MAX_DRAFT_BYTES)return null;
    const value=JSON.parse(raw);
    return scopeValid(scope)&&value?.ownerId===scope.ownerId&&value?.sessionId===scope.sessionId?raw:null;
  }catch{return null;}
}
export function clearScopedDraft(kind:string,scope:DraftScope,storage=draftStorage(),expectedToken?:string|null):void {
  try {
    const current=readScopedDraftToken(kind,scope,storage);
    if(current!==null&&(expectedToken===undefined||expectedToken===current))storage?.removeItem(PREFIX+kind);
  }catch{/* Leave an unrecognized/newer draft untouched. */}
}
export function loadDraft<T>(kind: string, scope: DraftScope, parse: (value: unknown) => T, storage = draftStorage()): T | null {
  try {
    const raw = storage?.getItem(PREFIX + kind);
    if (!raw) return null;
    if (!scopeValid(scope) || raw.length > MAX_DRAFT_BYTES) throw new Error('INVALID_DRAFT');
    const value = JSON.parse(raw);
    if (!value || Object.keys(value).some(k=>!['ownerId','payload','sessionId','version','generation'].includes(k)) || value.version !== 1 ||
      value.generation!==undefined&&(typeof value.generation!=='string'||value.generation.length>128) ||
      value.ownerId !== scope.ownerId || value.sessionId !== scope.sessionId) throw new Error('DRAFT_SCOPE_CHANGED');
    return parse(value.payload);
  } catch { clearDraft(kind, storage); return null; }
}
export function saveDraft<T>(kind: string, scope: DraftScope, payload: T, storage = draftStorage()): boolean {
  try {
    if (!storage || !scopeValid(scope)) return false;
    const raw = JSON.stringify({ version: 1, ...scope, generation:crypto.randomUUID(),payload });
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
  streetKey?:string;
}
export function parseAddressDraft(input: unknown): AddressDraft {
  const v = exactKeys(input, ['addressId', 'baselineFingerprint', 'baselineLabel', 'step', 'cityKey', 'query', 'street', 'streetKey', 'house', 'label', 'confirmed', 'optionId', 'bindingRevisionId']);
  return { addressId: v.addressId === null ? null : draftText(v.addressId,255), baselineFingerprint: draftText(v.baselineFingerprint,32768), baselineLabel: draftText(v.baselineLabel,32),
    step: draftInteger(v.step,2), cityKey: draftText(v.cityKey,4096), query: draftText(v.query,500), street: draftText(v.street,8192), house: draftText(v.house,128), label: draftText(v.label,32),
    confirmed: draftFlag(v.confirmed), optionId: draftText(v.optionId,255), bindingRevisionId: draftText(v.bindingRevisionId,255),...(v.streetKey===undefined?{}:{streetKey:draftText(v.streetKey,8192)}) };
}
export function loadAddressDraft(scope: DraftScope): AddressDraft | null { return loadDraft('address', scope, parseAddressDraft); }

/** Always include the open address; missing/deleted IDs never become another participant. */
export function compareParticipantIds(activeId: string, selectedIds: string[], availableIds: string[]): string[] {
  const available = new Set(availableIds);
  return [...new Set([activeId, ...selectedIds])].filter(id => available.has(id));
}
