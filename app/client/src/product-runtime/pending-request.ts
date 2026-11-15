import type { ProfileRequest } from '../../../shared/profile-mutation.ts';

export const PENDING_PROFILE_KEY = 'lba:ux-a:pending-profile';
const MAX_AGE = 24 * 60 * 60 * 1000;
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const kinds = ['add', 'replace', 'rename', 'delete', 'primary', 'move', 'location', 'preferences'];
function validRequest(value: any): value is ProfileRequest {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['id', 'expectedSessionId', 'expectedRevision', 'mutation'].includes(key)) &&
    typeof value.id === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(value.id) &&
    typeof value.expectedSessionId === 'string' && value.expectedSessionId.length > 0 && value.expectedSessionId.length <= 128 &&
    Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 &&
    value.mutation && typeof value.mutation === 'object' && !Array.isArray(value.mutation) && kinds.includes(value.mutation.kind);
}
export function savePendingProfile(storage: StoragePort, ownerId: string, request: ProfileRequest, now = Date.now()): void {
  const json = JSON.stringify({ version: 1, ownerId, sessionId: request.expectedSessionId, savedAt: now, request });
  if (json.length > 65536 || !validRequest(request)) throw new Error('Не вдалося підготувати відновлення запиту.');
  storage.setItem(PENDING_PROFILE_KEY, json);
}
export function clearPendingProfile(storage: StoragePort): void { storage.removeItem(PENDING_PROFILE_KEY); }
export function loadPendingProfile(storage: StoragePort, ownerId: string, sessionId: string, now = Date.now()): ProfileRequest | null {
  try {
    const raw = storage.getItem(PENDING_PROFILE_KEY);
    if (!raw) return null;
    if (raw.length > 65536) throw new Error('size');
    const value = JSON.parse(raw);
    if (!value || Object.keys(value).some(key => !['version', 'ownerId', 'sessionId', 'savedAt', 'request'].includes(key)) ||
      value.version !== 1 || value.ownerId !== ownerId || value.sessionId !== sessionId ||
      !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt > MAX_AGE ||
      !validRequest(value.request) || value.request.expectedSessionId !== sessionId) throw new Error('scope');
    // Preserve the original revision and ID: current revision may already include this commit.
    return value.request;
  } catch { try { clearPendingProfile(storage); } catch {} return null; }
}
