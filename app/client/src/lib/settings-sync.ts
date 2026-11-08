import { useStore } from './store';
import { isApplyingServerData, setApplyingServerData, getLastLocalChangeTs, setLastLocalChangeTs, isRecentLocalChange } from './sync-state';

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let suppressSync = true;
const SERVER_TS_KEY = '__svitlo_server_updated_at';

export { isApplyingServerData, setApplyingServerData, isRecentLocalChange };

const TAB_ID = typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2);

export function getTabId() { return TAB_ID; }

export function enableSettingsSync() {
  suppressSync = false;
}

export { getLastLocalChangeTs } from './sync-state';

export function getLastServerUpdatedAt(): string | null {
  try {
    return localStorage.getItem(SERVER_TS_KEY);
  } catch {
    return null;
  }
}

export function setLastServerUpdatedAt(ts: string | null) {
  try {
    if (ts) {
      localStorage.setItem(SERVER_TS_KEY, ts);
    } else {
      localStorage.removeItem(SERVER_TS_KEY);
    }
  } catch {}
}

function buildPayload() {
  const state = useStore.getState();
  return {
    lookupMode: state.lookupMode,
    city: state.city || 'Вінниця',
    street: state.street || '',
    houseNumber: state.houseNumber || '',
    queueId: state.queueId || '',
    queueAlternatives: state.queueAlternatives || [],
    addressQueueMemory: state.addressQueueMemory || {},
    notificationsEnabled: state.notificationsEnabled || false,
    notifyBeforeOff: state.notifyBeforeOff || 30,
    notifyBeforeOn: state.notifyBeforeOn || 15,
    telegramNotifications: state.telegramNotifications || false,
    telegramChatId: state.telegramChatId || '',
    telegramNotifyBeforeOff: state.telegramNotifyBeforeOff || 30,
    telegramNotifyBeforeOn: state.telegramNotifyBeforeOn || 15,
    quietHoursEnabled: state.quietHoursEnabled || false,
    quietHoursStart: state.quietHoursStart ?? 23,
    quietHoursEnd: state.quietHoursEnd ?? 7,
    morningBriefingEnabled: state.morningBriefingEnabled || false,
    morningBriefingHour: state.morningBriefingHour ?? 7,
    minOutageDuration: state.minOutageDuration || 0,
    themeMode: state.themeMode || 'dark',
    accentColor: state.accentColor || 'emerald',
    hasSeenOnboarding: state.hasSeenOnboarding || false,
    lastServerUpdatedAt: getLastServerUpdatedAt() || undefined,
    _tabId: TAB_ID,
  };
}

async function doSync() {
  try {
    const payload = buildPayload();
    const resp = await fetch('/api/user/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.updatedAt) {
        setLastServerUpdatedAt(data.updatedAt);
      }
      if (data && data.conflict) {
        applyConflictResolution(data);
      }
    }
  } catch (e) {
    console.error('[SettingsSync] Failed to sync to server:', e);
  }
}

function applyConflictResolution(serverData: any) {
  setApplyingServerData(true);
  try {
    const store = useStore.getState();
    if (serverData.city && serverData.city !== store.city) {
      store.setCity(serverData.city);
    }
    if (serverData.queueId && serverData.queueId !== store.queueId) {
      store.setQueueId(serverData.queueId);
    }
    if (serverData.street !== undefined && (serverData.street !== store.street || serverData.houseNumber !== store.houseNumber)) {
      store.setAddress(serverData.city || store.city, serverData.street || '', serverData.houseNumber || '');
    }
    if (serverData.lookupMode && serverData.lookupMode !== store.lookupMode) {
      store.setLookupMode(serverData.lookupMode);
    }
  } finally {
    setApplyingServerData(false);
  }
}

export function applyRemoteSettings(data: Record<string, any>) {
  if (data._sourceTabId === TAB_ID) return;
  if (isRecentLocalChange()) return;

  setApplyingServerData(true);
  try {
    const store = useStore.getState();
    const updates: Record<string, any> = {};

    if (data.city !== undefined && data.city !== store.city) updates.city = data.city;
    if (data.street !== undefined && data.street !== store.street) updates.street = data.street;
    if (data.houseNumber !== undefined && data.houseNumber !== store.houseNumber) updates.houseNumber = data.houseNumber;
    if (data.queueId !== undefined && data.queueId !== store.queueId) {
      updates.queueId = data.queueId;
      updates.schedule = null;
    }
    if (data.lookupMode !== undefined && data.lookupMode !== store.lookupMode) updates.lookupMode = data.lookupMode;
    if (data.queueAlternatives !== undefined) updates.queueAlternatives = data.queueAlternatives;

    if (data.themeMode !== undefined && (data.themeMode === 'dark' || data.themeMode === 'light') && data.themeMode !== store.themeMode) {
      document.body.classList.add('theme-transitioning');
      updates.themeMode = data.themeMode;
      setTimeout(() => document.body.classList.remove('theme-transitioning'), 500);
    }

    const validAccents = ['emerald', 'blue', 'purple', 'rose', 'amber', 'cyan', 'orange'];
    if (data.accentColor !== undefined && validAccents.includes(data.accentColor) && data.accentColor !== store.accentColor) {
      document.body.classList.add('theme-transitioning');
      updates.accentColor = data.accentColor;
      setTimeout(() => document.body.classList.remove('theme-transitioning'), 500);
    }

    if (typeof data.notificationsEnabled === 'boolean' && data.notificationsEnabled !== store.notificationsEnabled) updates.notificationsEnabled = data.notificationsEnabled;
    if (typeof data.notifyBeforeOff === 'number' && data.notifyBeforeOff !== store.notifyBeforeOff) updates.notifyBeforeOff = data.notifyBeforeOff;
    if (typeof data.notifyBeforeOn === 'number' && data.notifyBeforeOn !== store.notifyBeforeOn) updates.notifyBeforeOn = data.notifyBeforeOn;
    if (typeof data.telegramNotifications === 'boolean' && data.telegramNotifications !== store.telegramNotifications) updates.telegramNotifications = data.telegramNotifications;
    if (data.telegramChatId !== undefined && data.telegramChatId !== store.telegramChatId) updates.telegramChatId = data.telegramChatId;
    if (typeof data.telegramNotifyBeforeOff === 'number' && data.telegramNotifyBeforeOff !== store.telegramNotifyBeforeOff) updates.telegramNotifyBeforeOff = data.telegramNotifyBeforeOff;
    if (typeof data.telegramNotifyBeforeOn === 'number' && data.telegramNotifyBeforeOn !== store.telegramNotifyBeforeOn) updates.telegramNotifyBeforeOn = data.telegramNotifyBeforeOn;
    if (typeof data.quietHoursEnabled === 'boolean' && data.quietHoursEnabled !== store.quietHoursEnabled) updates.quietHoursEnabled = data.quietHoursEnabled;
    if (typeof data.quietHoursStart === 'number' && data.quietHoursStart !== store.quietHoursStart) updates.quietHoursStart = data.quietHoursStart;
    if (typeof data.quietHoursEnd === 'number' && data.quietHoursEnd !== store.quietHoursEnd) updates.quietHoursEnd = data.quietHoursEnd;
    if (typeof data.morningBriefingEnabled === 'boolean' && data.morningBriefingEnabled !== store.morningBriefingEnabled) updates.morningBriefingEnabled = data.morningBriefingEnabled;
    if (typeof data.morningBriefingHour === 'number' && data.morningBriefingHour !== store.morningBriefingHour) updates.morningBriefingHour = data.morningBriefingHour;
    if (typeof data.minOutageDuration === 'number' && data.minOutageDuration !== store.minOutageDuration) updates.minOutageDuration = data.minOutageDuration;

    if (data.updatedAt) {
      setLastServerUpdatedAt(data.updatedAt);
    }

    if (Object.keys(updates).length > 0) {
      useStore.setState(updates);
    }
  } finally {
    setApplyingServerData(false);
  }
}

export function syncSettingsToServer() {
  if (suppressSync || isApplyingServerData()) return;
  setLastLocalChangeTs(Date.now());
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(doSync, 150);
}

export function syncSettingsToServerNow() {
  if (suppressSync || isApplyingServerData()) return;
  setLastLocalChangeTs(Date.now());
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  doSync();
}

export function flushSettingsSync() {
  if (suppressSync) return;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const payload = buildPayload();
  try {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    navigator.sendBeacon('/api/user/settings-beacon', blob);
  } catch {
    doSync();
  }
}

let sseSource: EventSource | null = null;
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;

export function connectSettingsStream() {
  if (sseSource) return;

  try {
    const es = new EventSource('/api/user/settings-stream');
    sseSource = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        applyRemoteSettings(data);
      } catch {}
    };

    es.onerror = () => {
      es.close();
      sseSource = null;
      if (sseRetryTimer) clearTimeout(sseRetryTimer);
      sseRetryTimer = setTimeout(connectSettingsStream, 3000);
    };
  } catch {}
}

export function disconnectSettingsStream() {
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushSettingsSync);
  window.addEventListener('pagehide', flushSettingsSync);
}
