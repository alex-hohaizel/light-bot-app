import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setApplyingServerData, isRecentLocalChange } from './sync-state';

export const STORE_KEY = 'voe-schedule-storage-v7';

const ADDRESS_FIELDS = ['city', 'street', 'houseNumber', 'queueId', 'lookupMode', 'queueAlternatives', 'addressQueueMemory'] as const;

const ADDRESS_CACHE_TTL = 30 * 60 * 1000;

export interface AddressCacheEntry {
  queueId: string;
  isEnterprise?: boolean;
  noOutagesExpected?: boolean;
  needsManualQueue?: boolean;
  alternatives?: string[];
  timestamp: number;
}

export interface OutageSlot {
  start: string;
  end: string;
  status: 'offline' | 'online' | 'possible';
}

export interface DaySchedule {
  date: string;
  slots: OutageSlot[];
}

export interface EmergencyAlert {
  message: string;
  cause?: string;
  startTime?: string;
  endTime?: string;
  isActive: boolean;
}

export interface ScheduleData {
  lastUpdated: number;
  city: string;
  address: string;
  queue: string | null;
  queueName: string;
  days: DaySchedule[];
  updateTime: string;
  gpvStatus?: string;
  alert?: EmergencyAlert;
}

export type AccentColor = 'emerald' | 'blue' | 'purple' | 'rose' | 'amber' | 'cyan' | 'orange';

export const ACCENT_COLORS: { id: AccentColor; label: string; hex: string; darkHex: string }[] = [
  { id: 'emerald', label: 'Смарагдовий', hex: '#10b981', darkHex: '#34d399' },
  { id: 'blue', label: 'Синій', hex: '#3b82f6', darkHex: '#60a5fa' },
  { id: 'purple', label: 'Фіолетовий', hex: '#8b5cf6', darkHex: '#a78bfa' },
  { id: 'rose', label: 'Рожевий', hex: '#f43f5e', darkHex: '#fb7185' },
  { id: 'amber', label: 'Бурштиновий', hex: '#f59e0b', darkHex: '#fbbf24' },
  { id: 'cyan', label: 'Бірюзовий', hex: '#06b6d4', darkHex: '#22d3ee' },
  { id: 'orange', label: 'Помаранчевий', hex: '#f97316', darkHex: '#fb923c' },
];

interface AppState {
  lookupMode: 'queue' | 'address';
  city: string;
  street: string;
  houseNumber: string;
  queueId: string;
  queueAlternatives: string[];
  addressQueueMemory: Record<string, string | AddressCacheEntry>;
  notificationsEnabled: boolean;
  notifyBeforeOff: number;
  notifyBeforeOn: number;
  telegramNotifications: boolean;
  telegramChatId: string;
  telegramNotifyBeforeOff: number;
  telegramNotifyBeforeOn: number;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  morningBriefingEnabled: boolean;
  morningBriefingHour: number;
  minOutageDuration: number;
  schedule: ScheduleData | null;
  isChecking: boolean;
  lastCheckAttempt: number;
  themeMode: 'dark' | 'light';
  accentColor: AccentColor;
  hasSeenOnboarding: boolean;

  setLookupMode: (mode: 'queue' | 'address') => void;
  setCity: (city: string) => void;
  setAddress: (city: string, street: string, houseNumber: string) => void;
  setQueueId: (queueId: string) => void;
  setQueueAlternatives: (alternatives: string[]) => void;
  rememberAddressQueue: (street: string, house: string, entry: AddressCacheEntry) => void;
  getRememberedQueue: (street: string, house: string) => AddressCacheEntry | null;
  setNotifications: (enabled: boolean, beforeOff?: number, beforeOn?: number) => void;
  setTelegramSettings: (enabled: boolean, chatId: string, beforeOff?: number, beforeOn?: number) => void;
  setQuietHours: (enabled: boolean, start?: number, end?: number) => void;
  setMorningBriefing: (enabled: boolean, hour?: number) => void;
  setMinOutageDuration: (duration: number) => void;
  setSchedule: (data: ScheduleData) => void;
  setIsChecking: (isChecking: boolean) => void;
  setThemeMode: (mode: 'dark' | 'light') => void;
  toggleTheme: () => void;
  setAccentColor: (color: AccentColor) => void;
  setHasSeenOnboarding: (seen: boolean) => void;
}

function makeAddressKey(city: string, street: string, house: string): string {
  return `${city.toLowerCase().trim()}|${street.toLowerCase().trim()}|${(house || '').toLowerCase().trim()}`;
}

export interface CapturedUrlParams {
  queue?: string;
  street?: string;
  house?: string;
  mode?: string;
  chatId?: string;
  tgEnabled?: string;
  tgOff?: string;
  tgOn?: string;
}

export let capturedUrlParams: CapturedUrlParams | null = null;

if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  const queue = params.get('queue');
  const street = params.get('street');
  const chatId = params.get('chatId');
  if (queue || street || chatId) {
    capturedUrlParams = {
      queue: queue || undefined,
      street: street || undefined,
      house: params.get('house') || undefined,
      mode: params.get('mode') || undefined,
      chatId: chatId || undefined,
      tgEnabled: params.get('tgEnabled') || undefined,
      tgOff: params.get('tgOff') || undefined,
      tgOn: params.get('tgOn') || undefined,
    };
  }
}

export function applyUrlParamsToStore() {
  if (!capturedUrlParams) return false;
  const p = capturedUrlParams;
  capturedUrlParams = null;

  const store = useStore.getState();
  const isFreshStore = !store.hasSeenOnboarding;

  if (p.mode === 'address' || p.street) {
    if (isFreshStore || !store.street) {
      store.setLookupMode('address');
      if (p.street) store.setAddress(store.city, p.street, p.house || '');
    }
  } else if (isFreshStore) {
    store.setLookupMode('queue');
  }
  if (p.queue && (isFreshStore || !store.queueId)) {
    store.setQueueId(p.queue);
  }

  if (p.chatId && (isFreshStore || !store.telegramChatId)) {
    const tgEnabled = p.tgEnabled === '1';
    const tgOff = p.tgOff ? parseInt(p.tgOff, 10) : undefined;
    const tgOn = p.tgOn ? parseInt(p.tgOn, 10) : undefined;
    store.setTelegramSettings(
      tgEnabled,
      p.chatId,
      tgOff,
      tgOn,
    );
  }

  store.setHasSeenOnboarding(true);

  if (typeof window !== 'undefined') {
    window.history.replaceState({}, '', window.location.pathname);
  }
  return true;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      lookupMode: 'queue',
      city: 'Вінниця',
      street: '',
      houseNumber: '',
      queueId: '',
      queueAlternatives: [],
      addressQueueMemory: {},
      notificationsEnabled: false,
      notifyBeforeOff: 30,
      notifyBeforeOn: 15,
      telegramNotifications: false,
      telegramChatId: '',
      telegramNotifyBeforeOff: 30,
      telegramNotifyBeforeOn: 15,
      quietHoursEnabled: false,
      quietHoursStart: 23,
      quietHoursEnd: 7,
      morningBriefingEnabled: false,
      morningBriefingHour: 7,
      minOutageDuration: 0,
      schedule: null,
      isChecking: false,
      lastCheckAttempt: 0,
      themeMode: 'light' as const,
      accentColor: 'emerald' as AccentColor,
      hasSeenOnboarding: false,

      setLookupMode: (mode) => set({ lookupMode: mode }),
      setCity: (city) => set((state) => {
        if (state.city === city) return {};
        return { city, queueId: '', queueAlternatives: [], schedule: null, street: '', houseNumber: '' };
      }),
      setAddress: (city, street, houseNumber) => set({ city, street, houseNumber }),
      setQueueId: (queueId) => set({ queueId, schedule: null, ...(queueId ? { queueAlternatives: [] } : {}) }),
      setQueueAlternatives: (alternatives) => set({ queueAlternatives: alternatives }),
      rememberAddressQueue: (street, house, entry) => set((state) => ({
        addressQueueMemory: {
          ...state.addressQueueMemory,
          [makeAddressKey(state.city, street, house)]: entry,
        },
      })),
      getRememberedQueue: (street, house) => {
        const state = get();
        const key = makeAddressKey(state.city, street, house);
        const cached = state.addressQueueMemory[key];
        if (!cached) return null;
        if (typeof cached === 'string') {
          return null;
        }
        if (Date.now() - cached.timestamp > ADDRESS_CACHE_TTL) {
          return null;
        }
        return cached;
      },
      setNotifications: (enabled, beforeOff, beforeOn) => set((state) => ({
        notificationsEnabled: enabled,
        notifyBeforeOff: beforeOff ?? state.notifyBeforeOff,
        notifyBeforeOn: beforeOn ?? state.notifyBeforeOn,
      })),
      setTelegramSettings: (enabled, chatId, beforeOff, beforeOn) => set((state) => ({
        telegramNotifications: enabled,
        telegramChatId: chatId,
        telegramNotifyBeforeOff: beforeOff ?? state.telegramNotifyBeforeOff,
        telegramNotifyBeforeOn: beforeOn ?? state.telegramNotifyBeforeOn,
      })),
      setQuietHours: (enabled, start, end) => set((state) => ({
        quietHoursEnabled: enabled,
        quietHoursStart: start ?? state.quietHoursStart,
        quietHoursEnd: end ?? state.quietHoursEnd,
      })),
      setMorningBriefing: (enabled, hour) => set((state) => ({
        morningBriefingEnabled: enabled,
        morningBriefingHour: hour ?? state.morningBriefingHour,
      })),
      setMinOutageDuration: (duration) => set({ minOutageDuration: duration }),
      setSchedule: (data) => set({ schedule: data, lastCheckAttempt: Date.now() }),
      setIsChecking: (isChecking) => set({ isChecking }),
      setThemeMode: (mode) => {
        document.body.classList.add('theme-transitioning');
        set({ themeMode: mode });
        setTimeout(() => document.body.classList.remove('theme-transitioning'), 500);
      },
      toggleTheme: () => {
        document.body.classList.add('theme-transitioning');
        set((state) => ({ themeMode: state.themeMode === 'dark' ? 'light' : 'dark' }));
        setTimeout(() => document.body.classList.remove('theme-transitioning'), 500);
      },
      setAccentColor: (color) => {
        document.body.classList.add('theme-transitioning');
        set({ accentColor: color });
        setTimeout(() => document.body.classList.remove('theme-transitioning'), 500);
      },
      setHasSeenOnboarding: (seen) => set({ hasSeenOnboarding: seen }),
    }),
    {
      name: STORE_KEY,
      merge: (persistedState: any, currentState: AppState): AppState => {
        if (!persistedState || typeof persistedState !== 'object') {
          return currentState;
        }
        try {
          const safe: Partial<AppState> = {};
          if (typeof persistedState.lookupMode === 'string' && (persistedState.lookupMode === 'queue' || persistedState.lookupMode === 'address')) {
            safe.lookupMode = persistedState.lookupMode;
          }
          if (typeof persistedState.city === 'string') safe.city = persistedState.city;
          if (typeof persistedState.street === 'string') safe.street = persistedState.street;
          if (typeof persistedState.houseNumber === 'string') safe.houseNumber = persistedState.houseNumber;
          if (typeof persistedState.queueId === 'string') safe.queueId = persistedState.queueId;
          if (Array.isArray(persistedState.queueAlternatives)) safe.queueAlternatives = persistedState.queueAlternatives;
          if (persistedState.addressQueueMemory && typeof persistedState.addressQueueMemory === 'object' && !Array.isArray(persistedState.addressQueueMemory)) {
            safe.addressQueueMemory = persistedState.addressQueueMemory;
          }
          if (typeof persistedState.notificationsEnabled === 'boolean') safe.notificationsEnabled = persistedState.notificationsEnabled;
          if (typeof persistedState.notifyBeforeOff === 'number') safe.notifyBeforeOff = persistedState.notifyBeforeOff;
          if (typeof persistedState.notifyBeforeOn === 'number') safe.notifyBeforeOn = persistedState.notifyBeforeOn;
          if (typeof persistedState.telegramNotifications === 'boolean') safe.telegramNotifications = persistedState.telegramNotifications;
          if (typeof persistedState.telegramChatId === 'string') safe.telegramChatId = persistedState.telegramChatId;
          if (typeof persistedState.telegramNotifyBeforeOff === 'number') safe.telegramNotifyBeforeOff = persistedState.telegramNotifyBeforeOff;
          if (typeof persistedState.telegramNotifyBeforeOn === 'number') safe.telegramNotifyBeforeOn = persistedState.telegramNotifyBeforeOn;
          if (typeof persistedState.quietHoursEnabled === 'boolean') safe.quietHoursEnabled = persistedState.quietHoursEnabled;
          if (typeof persistedState.quietHoursStart === 'number') safe.quietHoursStart = persistedState.quietHoursStart;
          if (typeof persistedState.quietHoursEnd === 'number') safe.quietHoursEnd = persistedState.quietHoursEnd;
          if (typeof persistedState.morningBriefingEnabled === 'boolean') safe.morningBriefingEnabled = persistedState.morningBriefingEnabled;
          if (typeof persistedState.morningBriefingHour === 'number') safe.morningBriefingHour = persistedState.morningBriefingHour;
          if (typeof persistedState.minOutageDuration === 'number') safe.minOutageDuration = persistedState.minOutageDuration;
          const tgTheme = (typeof window !== 'undefined' && window.Telegram?.WebApp?.initData && window.Telegram.WebApp.initData.length > 0)
            ? (window.Telegram.WebApp.colorScheme === 'dark' ? 'dark' : 'light')
            : null;
          if (tgTheme) {
            safe.themeMode = tgTheme;
          } else if (typeof persistedState.themeMode === 'string' && (persistedState.themeMode === 'dark' || persistedState.themeMode === 'light')) {
            safe.themeMode = persistedState.themeMode;
          } else {
            safe.themeMode = 'light';
          }
          const validAccents: AccentColor[] = ['emerald', 'blue', 'purple', 'rose', 'amber', 'cyan', 'orange'];
          if (typeof persistedState.accentColor === 'string' && validAccents.includes(persistedState.accentColor as AccentColor)) {
            safe.accentColor = persistedState.accentColor as AccentColor;
          } else {
            safe.accentColor = 'emerald';
          }
          if (typeof persistedState.hasSeenOnboarding === 'boolean') safe.hasSeenOnboarding = persistedState.hasSeenOnboarding;
          return { ...currentState, ...safe };
        } catch (e) {
          console.error('[Store] Failed to merge persisted state, using defaults:', e);
          return currentState;
        }
      },
    }
  )
);

const CROSS_TAB_FIELDS = [
  ...ADDRESS_FIELDS,
  'themeMode', 'accentColor',
  'notificationsEnabled', 'notifyBeforeOff', 'notifyBeforeOn',
  'telegramNotifications', 'telegramChatId',
  'telegramNotifyBeforeOff', 'telegramNotifyBeforeOn',
  'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
  'morningBriefingEnabled', 'morningBriefingHour', 'minOutageDuration',
] as const;

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE_KEY || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue);
      const newState = parsed?.state;
      if (!newState || typeof newState !== 'object') return;

      const current = useStore.getState();
      const hasChange = CROSS_TAB_FIELDS.some(f => {
        const newVal = newState[f];
        const curVal = (current as any)[f];
        if (newVal === undefined) return false;
        return JSON.stringify(newVal) !== JSON.stringify(curVal);
      });

      if (hasChange && !isRecentLocalChange()) {
        setApplyingServerData(true);
        try {
          const updates: Record<string, any> = {};
          for (const f of CROSS_TAB_FIELDS) {
            if (newState[f] !== undefined) updates[f] = newState[f];
          }
          useStore.setState(updates);
        } finally {
          setApplyingServerData(false);
        }
      }
    } catch {}
  });
}
