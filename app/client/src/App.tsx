import { Switch, Route, Redirect, useLocation } from "wouter";
import { useState, useEffect, useRef, useCallback, Component, ErrorInfo, ReactNode } from "react";
import { Dashboard } from "./components/Dashboard";
import { Settings } from "./components/Settings";
import { LoginPage } from "./pages/LoginPage";
import { SharePage } from "./pages/SharePage";
import { ComparePage } from "./pages/ComparePage";
import ProductRuntime from './product-runtime/ProductRuntime';
import LiveProduct from './product-runtime/LiveProduct';
import {LocalPublicPlan} from './product-review/ProductTools';
import {LivePublicPlan} from './product-review/LiveProductTools';
import BotReview from './bot-review/BotReview';
import DataReview from './data-review/DataReview';

import { Toaster } from "@/components/ui/toaster";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useStore, capturedUrlParams, applyUrlParamsToStore, STORE_KEY, type AccentColor } from "@/lib/store";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import { applyAccentToDocument } from "@/hooks/useTheme";
import { syncSettingsToServer, syncSettingsToServerNow, enableSettingsSync, getLastLocalChangeTs, setApplyingServerData, setLastServerUpdatedAt, connectSettingsStream, disconnectSettingsStream } from "@/lib/settings-sync";
import { getTelegramWebApp, isTelegramMiniApp } from "@/lib/telegram-webapp";

const queryClient = new QueryClient();

const APP_VERSION_KEY = '__svitlo_build_version';

function startVersionPolling() {
  let currentVersion = localStorage.getItem(APP_VERSION_KEY) || '';
  
  function forceUpdate() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
        reg.update();
      });
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(reg => {
          if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
          reg.update();
        });
      });
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage('CLEAR_CACHE');
      }
    }
    setTimeout(() => window.location.reload(), 500);
  }
  
  function checkVersion() {
    fetch('/api/version', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (!currentVersion) {
          currentVersion = data.build;
          localStorage.setItem(APP_VERSION_KEY, currentVersion);
          return;
        }
        if (data.build !== currentVersion) {
          localStorage.setItem(APP_VERSION_KEY, data.build);
          forceUpdate();
        }
      })
      .catch(() => {});
  }
  
  setTimeout(checkVersion, 3000);
  setInterval(checkVersion, 60000);
}

if (typeof window !== 'undefined') {
  startVersionPolling();
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[AppErrorBoundary] Caught error:', error, errorInfo);
  }

  handleReset = () => {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-6 text-center">
          <div className="text-4xl">⚡</div>
          <h1 className="text-xl font-bold text-zinc-100">Щось пішло не так</h1>
          <p className="text-sm text-zinc-400 max-w-sm">
            Виникла помилка при завантаженні додатку. Спробуйте скинути збережені дані.
          </p>
          <button
            onClick={this.handleReset}
            className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium transition-colors"
          >
            Скинути дані та перезавантажити
          </button>
          <p className="text-xs text-zinc-600 max-w-xs">
            Це видалить збережені налаштування (черга, адреса), але вирішить проблему з білим екраном.
          </p>
          {this.state.error && (
            <details className="text-left w-full max-w-sm mt-4">
              <summary className="text-xs text-zinc-500 cursor-pointer">Деталі помилки</summary>
              <pre className="text-[10px] text-red-400 mt-2 p-3 bg-zinc-900 rounded-lg overflow-auto max-h-40 whitespace-pre-wrap break-words">
                {this.state.error.message}
                {'\n\n'}
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

const hadUrlParams = !!capturedUrlParams;

function syncFromBot() {
  try {
    const state = useStore.getState();
    if (!state.telegramChatId) return;
    fetch(`/api/notify/telegram/subscriber?chatId=${encodeURIComponent(state.telegramChatId)}`)
      .then(r => { if (r.ok) return r.json(); return null; })
      .then(d => {
        if (!d || typeof d !== 'object') return;
        try {
          const store = useStore.getState();

          const tgOff = typeof d.notifyBeforeOff === 'number' && d.notifyBeforeOff > 0 ? d.notifyBeforeOff : store.telegramNotifyBeforeOff;
          const tgOn = typeof d.notifyBeforeOn === 'number' && d.notifyBeforeOn > 0 ? d.notifyBeforeOn : store.telegramNotifyBeforeOn;
          const tgEnabled = typeof d.enabled === 'boolean' ? d.enabled : store.telegramNotifications;

          store.setTelegramSettings(tgEnabled, store.telegramChatId, tgOff, tgOn);
        } catch (e) {
          console.error('[syncFromBot] Failed to apply bot data:', e);
        }
      })
      .catch(() => {});
  } catch (e) {
    console.error('[syncFromBot] Error:', e);
  }
}

function syncSettingsFromServer() {
  return fetch('/api/user/settings')
    .then(r => { if (r.ok) return r.json(); return null; })
    .then(data => {
      if (!data || typeof data !== 'object') {
        enableSettingsSync();
        return;
      }
      const store = useStore.getState();
      const recentlyChanged = (Date.now() - getLastLocalChangeTs()) < 10000;

      if (data.updatedAt) {
        setLastServerUpdatedAt(data.updatedAt);
      }

      setApplyingServerData(true);
      try {
        if (!recentlyChanged) {
          if (data.city && data.city !== store.city) {
            store.setCity(data.city);
          }
          if (data.queueId && data.queueId !== store.queueId) store.setQueueId(data.queueId);
          if (data.lookupMode && data.lookupMode !== store.lookupMode) store.setLookupMode(data.lookupMode as any);
          if (data.street !== undefined && (data.street !== store.street || data.houseNumber !== store.houseNumber)) {
            store.setAddress(data.city || store.city, data.street || '', data.houseNumber || '');
          }
          if (data.themeMode && (data.themeMode === 'dark' || data.themeMode === 'light') && data.themeMode !== store.themeMode) {
            store.setThemeMode(data.themeMode);
          } else if (data.themeMode === 'elegant' || data.themeMode === 'terrifier') {
            store.setThemeMode('dark');
          }
          const validAccents: AccentColor[] = ['emerald', 'blue', 'purple', 'rose', 'amber', 'cyan', 'orange'];
          if (data.accentColor && validAccents.includes(data.accentColor) && data.accentColor !== store.accentColor) {
            store.setAccentColor(data.accentColor);
          }
        }
        if (data.telegramChatId) {
          store.setTelegramSettings(
            data.telegramNotifications ?? store.telegramNotifications,
            data.telegramChatId,
            data.telegramNotifyBeforeOff ?? store.telegramNotifyBeforeOff,
            data.telegramNotifyBeforeOn ?? store.telegramNotifyBeforeOn
          );
        }
        if (data.hasSeenOnboarding && !store.hasSeenOnboarding) {
          store.setHasSeenOnboarding(true);
        }
        const restoreFields: Record<string, any> = {};
        if (!recentlyChanged) {
          if (typeof data.notificationsEnabled === 'boolean') restoreFields.notificationsEnabled = data.notificationsEnabled;
          if (typeof data.notifyBeforeOff === 'number') restoreFields.notifyBeforeOff = data.notifyBeforeOff;
          if (typeof data.notifyBeforeOn === 'number') restoreFields.notifyBeforeOn = data.notifyBeforeOn;
          if (data.queueAlternatives && Array.isArray(data.queueAlternatives)) restoreFields.queueAlternatives = data.queueAlternatives;
          if (data.addressQueueMemory && typeof data.addressQueueMemory === 'object') restoreFields.addressQueueMemory = data.addressQueueMemory;
        }
        if (Object.keys(restoreFields).length > 0) useStore.setState(restoreFields);
      } finally {
        setApplyingServerData(false);
      }
      setTimeout(() => enableSettingsSync(), 2000);
    })
    .catch(() => {
      enableSettingsSync();
    });
}

function AppRoutes() {
  const { hasSeenOnboarding } = useStore();
  const [hydrated, setHydrated] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialSyncDone = useRef(false);

  const resyncFromServer = useCallback(() => {
    const recentlyChanged = (Date.now() - getLastLocalChangeTs()) < 10000;
    if (recentlyChanged) return;
    syncSettingsFromServer();
  }, []);

  useEffect(() => {
    let active = true;
    const finishHydration = () => {
      if (capturedUrlParams) applyUrlParamsToStore();
      syncFromBot();
      connectSettingsStream();
      initialSyncDone.current = true;
      void syncSettingsFromServer().finally(() => {
        if (active) setHydrated(true);
      });
    };
    const unsub = useStore.persist.onFinishHydration(() => {
      finishHydration();
    });

    if (useStore.persist.hasHydrated()) {
      finishHydration();
      unsub();
    }

    return () => {
      active = false;
      unsub();
      disconnectSettingsStream();
    };
  }, []);

  useEffect(() => {
    if (!initialSyncDone.current) return;

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        resyncFromServer();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);

    pollRef.current = setInterval(resyncFromServer, 60000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [resyncFromServer]);

  // Wait for the existing server profile before deciding whether onboarding is
  // needed; a fresh browser otherwise redirects returning users to Settings.
  if (!hydrated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6">
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full border-4 border-zinc-800" />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-emerald-500 animate-spin" />
        </div>
        <div className="text-center space-y-2">
          <p className="text-lg font-semibold text-zinc-200 animate-pulse">Завантажуємо профіль...</p>
          <p className="text-sm text-zinc-500">Зачекайте кілька секунд</p>
        </div>
      </div>
    );
  }

  if (!hasSeenOnboarding && !hadUrlParams) {
    return (
      <>
        <Switch>
          <Route path="/settings" component={Settings} />
          <Route>
            <Redirect to="/settings" />
          </Route>
        </Switch>
      </>
    );
  }

  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/settings" component={Settings} />
      <Route path="/compare">{() => <Redirect to="/" />}</Route>
      <Route>
        <Dashboard />
      </Route>
    </Switch>
  );
}

function AuthGate() {
  const { user, isLoading, refetch } = useAuth();
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);
  const [miniAppAuthInProgress, setMiniAppAuthInProgress] = useState(false);

  useEffect(() => {
    const wa = getTelegramWebApp();
    if (wa && !user && !miniAppAuthInProgress && !autoLoginAttempted) {
      setMiniAppAuthInProgress(true);
      wa.ready();
      wa.expand();
      fetch('/api/auth/telegram-webapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: wa.initData }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.ok) {
            const store = useStore.getState();
            if (!store.hasSeenOnboarding) store.setHasSeenOnboarding(true);
            refetch();
          }
          setMiniAppAuthInProgress(false);
        })
        .catch(() => setMiniAppAuthInProgress(false));
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const tgToken = params.get('tgToken');
    if (tgToken && !user && !autoLoginAttempted) {
      setAutoLoginAttempted(true);
      window.location.href = `/api/auth/telegram-auto?token=${encodeURIComponent(tgToken)}`;
      return;
    }
    if (params.get('fromTelegram') === '1' && user) {
      const store = useStore.getState();
      const isFirstTime = params.get('firstTime') === '1';
      if (!isFirstTime && !store.hasSeenOnboarding) {
        store.setHasSeenOnboarding(true);
      }
      if (isFirstTime) {
        window.history.replaceState({}, '', '/settings');
      } else {
        window.history.replaceState({}, '', '/');
      }
    }
  }, [user, autoLoginAttempted]);

  useEffect(() => {
    if (!user) return;
    let prev = {
      city: useStore.getState().city,
      street: useStore.getState().street,
      houseNumber: useStore.getState().houseNumber,
      queueId: useStore.getState().queueId,
    };
    const unsub = useStore.subscribe(() => {
      const s = useStore.getState();
      const addressChanged =
        s.city !== prev.city || s.street !== prev.street ||
        s.houseNumber !== prev.houseNumber || s.queueId !== prev.queueId;
      prev = { city: s.city, street: s.street, houseNumber: s.houseNumber, queueId: s.queueId };
      if (addressChanged) {
        syncSettingsToServerNow();
      } else {
        syncSettingsToServer();
      }
    });
    return unsub;
  }, [user]);

  if (isLoading || miniAppAuthInProgress || (new URLSearchParams(window.location.search).get('tgToken') && !autoLoginAttempted)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ background: 'linear-gradient(180deg, #080c12 0%, #0c1018 100%)' }}>
        <div className="relative w-14 h-14">
          <div className="absolute inset-0 rounded-full border-4 border-zinc-800" />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-emerald-500 animate-spin" />
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <AppRoutes />;
}

function ThemeRoot() {
  const themeMode = useStore((s) => s.themeMode);
  const accentColor = useStore((s) => s.accentColor);
  const [loc] = useLocation();

  useEffect(() => {
    const wa = getTelegramWebApp();
    if (wa) {
      const tgTheme = wa.colorScheme === 'dark' ? 'dark' : 'light';
      if (tgTheme !== themeMode) {
        useStore.getState().setThemeMode(tgTheme);
      }
      try {
        wa.setHeaderColor(tgTheme === 'dark' ? '#09090b' : '#f5f5f7');
        wa.setBackgroundColor(tgTheme === 'dark' ? '#09090b' : '#f5f5f7');
      } catch {}
    }
  }, []);

  useEffect(() => {
    applyAccentToDocument(accentColor, themeMode);
  }, [accentColor, themeMode]);

  if (loc.startsWith('/s/')) {
    return <SharePage />;
  }

  return (
    <div className={cn(
      "min-h-screen font-sans antialiased text-foreground transition-colors duration-500",
      themeMode === 'light'
        ? "theme-light bg-[#f5f5f7] selection:bg-emerald-100 selection:text-emerald-900"
        : "bg-black selection:bg-zinc-800 selection:text-white"
    )}>
      <AuthGate />
      <Toaster />
    </div>
  );
}

function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Switch>
          {(window as Window & {__LBA_ISOLATED__?:boolean}).__LBA_ISOLATED__ && <Route path="/">{()=> <ProductRuntime/>}</Route>}
          {(window as Window & {__LBA_ISOLATED__?:boolean}).__LBA_ISOLATED__ && <Route path="/local-share/:token" component={LocalPublicPlan} />}
          {!(window as Window & {__LBA_ISOLATED__?:boolean}).__LBA_ISOLATED__ && <Route path="/shared-plan/:token" component={LivePublicPlan} />}
          {!(window as Window & {__LBA_ISOLATED__?:boolean}).__LBA_ISOLATED__ && <Route path="/next" component={LiveProduct} />}
          <Route path="/legacy" component={ThemeRoot} />
          <Route path="/review/data" component={DataReview} />
          <Route path="/review/bot" component={BotReview} />
          <Route path="/review">{()=> <ProductRuntime/>}</Route>
          <Route path="/s/:shareId" component={SharePage} />
          <Route path="/c/:shareId" component={ComparePage} />
          <Route>
            <LiveProduct />
          </Route>
        </Switch>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

export default App;
