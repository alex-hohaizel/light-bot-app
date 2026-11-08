import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '@/lib/store';
import { fetchSchedule, getCurrentStatus, formatTimeRemaining } from '@/lib/schedule-service';
import { startNotificationMonitor, stopNotificationMonitor } from '@/lib/notifications';
import { Timeline } from './Timeline';
import { Loader2, RefreshCw, Settings as SettingsIcon, Zap, ZapOff, MapPin, Calendar, AlertCircle, Info, LogOut, Plus, Share2, Check, ArrowUpDown, GitCompareArrows } from 'lucide-react';
import { LocationPrioritizer } from './LocationPrioritizer';
import { CompareSheet } from './CompareSheet';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';
import { PowerReportCard } from './PowerReportCard';
import { WeeklyDigestCard } from './WeeklyDigestCard';
import { isTelegramMiniApp, getTelegramWebApp, hapticFeedback } from '@/lib/telegram-webapp';

type ActiveLocation = { id: number; name: string; city: string; queueId: string; isPrimary: boolean; street?: string; houseNumber?: string } | null;

const QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

export function Dashboard() {
  const store = useStore();
  const { 
    schedule, 
    queueId,
    lookupMode,
    city,
    street,
    houseNumber,
    queueAlternatives,
    setSchedule, 
    setQueueId,
    setQueueAlternatives,
    rememberAddressQueue,
    isChecking, 
    setIsChecking, 
    lastCheckAttempt,
  } = store;
  
  const { toast } = useToast();
  const [now, setNow] = useState(new Date());
  const [detectionDone, setDetectionDone] = useState(!!queueId);
  const [needsManualQueue, setNeedsManualQueue] = useState(false);
  const [noOutagesExpected, setNoOutagesExpected] = useState(false);
  const [activeLocation, setActiveLocation] = useState<ActiveLocation>(null);
  const [userLocations, setUserLocations] = useState<NonNullable<ActiveLocation>[]>([]);
  const [locationsLoaded, setLocationsLoaded] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [prioritizerOpen, setPrioritizerOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const fetchingRef = useRef(false);
  const queueIdRef = useRef(queueId);
  queueIdRef.current = queueId;

  const effectiveCity = activeLocation ? activeLocation.city : city;
  const effectiveQueueId = activeLocation ? activeLocation.queueId : queueId;

  const doFetchSchedule = useCallback(async (targetQueueId: string, silent = true, targetCity?: string) => {
    if (fetchingRef.current || !targetQueueId) return;
    fetchingRef.current = true;
    setIsChecking(true);
    try {
      const data = await fetchSchedule(targetQueueId, targetCity || city);
      setSchedule(data);
      if (!silent) {
        toast({ title: "Оновлено", description: "Дані актуальні." });
      }
    } catch (error) {
      if (!silent) {
        toast({ variant: "destructive", title: "Помилка", description: "Не вдалося оновити графік." });
      }
    } finally {
      fetchingRef.current = false;
      setIsChecking(false);
    }
  }, [setSchedule, setIsChecking, toast, city]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch('/api/user/locations');
        if (resp.ok) {
          const locs = await resp.json();
          if (Array.isArray(locs)) {
            setUserLocations(locs);
            const primary = locs.find((l: any) => l.isPrimary);
            if (primary) {
              setActiveLocation(primary);
            }
          }
        }
      } catch {}
      setLocationsLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (activeLocation) {
      doFetchSchedule(activeLocation.queueId, true, activeLocation.city);
    }
  }, [activeLocation]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (lookupMode === 'address' && street && !queueId) {
      const cached = store.getRememberedQueue(street, houseNumber);
      if (cached && cached.queueId) {
        setQueueId(cached.queueId);
        setDetectionDone(true);
        return;
      }

      setDetectionDone(false);
      setNeedsManualQueue(false);
      setNoOutagesExpected(false);
      (async () => {
        try {
          const params = new URLSearchParams({ street, city });
          if (houseNumber) params.set('house', houseNumber);
          const response = await fetch(`/api/address-queue?${params}`);
          const data = await response.json();
          if (data.queueId) {
            setQueueId(data.queueId);
          } else if (queueId) {
            setQueueId('');
          }
          if (data.alternatives && data.alternatives.length > 0) {
            setQueueAlternatives(data.alternatives);
          } else if (data.noOutagesExpected) {
            setNoOutagesExpected(true);
          } else if (data.needsManualQueue) {
            setNeedsManualQueue(true);
          }
          rememberAddressQueue(street, houseNumber, {
            queueId: data.queueId || '',
            isEnterprise: data.isEnterprise || false,
            noOutagesExpected: data.noOutagesExpected || false,
            needsManualQueue: data.needsManualQueue || false,
            alternatives: data.alternatives || [],
            timestamp: Date.now(),
          });
        } catch (error) {
          console.error("Silent queue detection failed:", error);
        }
        setDetectionDone(true);
      })();
    } else {
      setDetectionDone(true);
    }
  }, [lookupMode, city, street, houseNumber, queueId, setQueueId, rememberAddressQueue, setQueueAlternatives]);

  useEffect(() => {
    if (queueId) {
      doFetchSchedule(queueId);
    }
  }, [queueId, doFetchSchedule]);

  useEffect(() => {
    if (!queueId) return;
    const autoUpdate = setInterval(() => {
      doFetchSchedule(queueIdRef.current);
    }, 60000);
    return () => clearInterval(autoUpdate);
  }, [queueId, doFetchSchedule]);

  useEffect(() => {
    if (queueId && !schedule) {
      const retryTimer = setTimeout(() => {
        if (!useStore.getState().schedule && queueIdRef.current) {
          doFetchSchedule(queueIdRef.current);
        }
      }, 2000);
      return () => clearTimeout(retryTimer);
    }
  }, [queueId, schedule, doFetchSchedule]);

  useEffect(() => {
    if (schedule && queueId) {
      stopNotificationMonitor();
      startNotificationMonitor();
    }
    return () => stopNotificationMonitor();
  }, [schedule, queueId]);

  const handleCheck = (silent = false) => {
    if (effectiveQueueId) {
      doFetchSchedule(effectiveQueueId, silent, activeLocation?.city);
    }
  };

  const handleShare = async () => {
    if (!activeLocation || sharing) return;
    setSharing(true);
    try {
      const res = await fetch(`/api/user/locations/${activeLocation.id}/share`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      const fullUrl = `${window.location.origin}${data.url}`;
      const shareText = `Світло Україна — стан електропостачання`;

      if (navigator.share) {
        try {
          await navigator.share({ title: 'Світло Україна', text: shareText, url: fullUrl });
          return;
        } catch (e: any) {
          if (e?.name === 'AbortError') return;
        }
      }

      const tgWebApp = (window as any).Telegram?.WebApp;
      if (tgWebApp) {
        const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(fullUrl)}&text=${encodeURIComponent(shareText)}`;
        tgWebApp.openTelegramLink(tgShareUrl);
        return;
      }

      try {
        await navigator.clipboard.writeText(fullUrl);
        setShareCopied(true);
        toast({ title: 'Посилання скопійовано', description: 'Поділіться ним з друзями' });
        setTimeout(() => setShareCopied(false), 2000);
      } catch {
        const textArea = document.createElement('textarea');
        textArea.value = fullUrl;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setShareCopied(true);
        toast({ title: 'Посилання скопійовано', description: 'Поділіться ним з друзями' });
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch {
      toast({ title: 'Помилка', description: 'Не вдалося створити посилання', variant: 'destructive' });
    } finally {
      setSharing(false);
    }
  };

  const status = getCurrentStatus(schedule);
  const formattedTime = status.totalDuration > 0 ? formatTimeRemaining(status.totalDuration) : '0 хв.';

  const { isLight } = useTheme();
  const hasTomorrow = schedule && schedule.days.length > 1;
  const tomorrowHasData = hasTomorrow && schedule.days[1].slots.length > 0;

  const isApproachingChange = status.totalDuration > 0 && status.totalDuration < 30 * 60 * 1000;

  const changeProximity = (() => {
    if (!status.totalDuration || status.totalDuration <= 0) return 0;
    const thirtyMin = 30 * 60 * 1000;
    if (status.totalDuration >= thirtyMin) return 0;
    return 1 - (status.totalDuration / thirtyMin);
  })();

  const glowIntensity = Math.pow(changeProximity, 2.5);
  const glowPulseDuration = changeProximity > 0.8 ? 1.5 : changeProximity > 0.5 ? 3 : 5;

  return (
    <div className={cn(
      "min-h-screen transition-colors duration-500 selection:bg-white/10 overflow-x-hidden relative",
      isLight ? "bg-[#f5f5f7] text-zinc-900 font-sans" : "bg-[#050505] text-white font-sans"
    )}>
      {/* Warning overlay removed - replaced by adaptive glow aura on status card */}

      <div className="max-w-xl mx-auto px-5 pt-6 pb-10 space-y-8 relative z-10">
        
        {/* Header */}
        <header className={cn("sticky top-0 z-20 -mx-5 px-5 py-3 backdrop-blur-xl border-b transition-colors duration-500", isLight ? "bg-white/90 border-zinc-200" : "bg-[#050505]/80 border-white/[0.04]")}>
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3.5 min-w-0 flex-1 mr-3">
              <div className="relative shrink-0">
                <ThemeToggle compact />
              </div>

              <div className="flex flex-col min-w-0 flex-1">
                <h1 className={cn("text-lg font-bold tracking-tight leading-tight", isLight ? "text-zinc-900" : "text-white")} data-testid="text-app-title">
                  Світло Україна
                </h1>
                {activeLocation ? (
                  <div className="flex flex-col gap-0 mt-0.5" data-testid="text-queue-name">
                    <div className="flex items-center gap-1.5">
                      <MapPin className="w-3 h-3 text-zinc-500 shrink-0" />
                      <span className="text-[11px] text-zinc-500 font-medium truncate">
                        {activeLocation.city}{activeLocation.street ? `, вулиця ${activeLocation.street}` : ''}{activeLocation.houseNumber ? `, ${activeLocation.houseNumber}` : ''}
                      </span>
                    </div>
                    {activeLocation.queueId && (
                      <div className="flex items-center gap-1.5 ml-[18px]">
                        <span className="text-[10px] text-zinc-600 font-medium">
                          {activeLocation.city === 'Київ' ? 'група' : 'черга'} {activeLocation.queueId}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (lookupMode === 'address' && street) ? (
                  <div className="flex flex-col gap-0 mt-0.5" data-testid="text-queue-name">
                    <div className="flex items-center gap-1.5">
                      <MapPin className="w-3 h-3 text-zinc-500 shrink-0" />
                      <span className="text-[11px] text-zinc-500 font-medium truncate">
                        {city}, {street}{houseNumber ? `, ${houseNumber}` : ''}
                      </span>
                    </div>
                    {queueId && (
                      <div className="flex items-center gap-1.5 ml-[18px]">
                        <span className="text-[10px] text-zinc-600 font-medium">
                          {city === 'Київ' ? 'група' : 'черга'} {queueId}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-0 mt-0.5" data-testid="text-queue-name">
                    {queueId && (
                      <>
                        <div className="flex items-center gap-1.5">
                          <MapPin className="w-3 h-3 text-zinc-500 shrink-0" />
                          <span className="text-[11px] text-zinc-500 font-medium">
                            {city}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 ml-[18px]">
                          <span className="text-[10px] text-zinc-600 font-medium">
                            {city === 'Київ' ? 'група' : 'черга'} {queueId}
                          </span>
                        </div>
                      </>
                    )}
                    {!queueId && (
                      <div className="flex items-center gap-1.5">
                        <MapPin className="w-3 h-3 text-zinc-500 shrink-0" />
                        <span className="text-[11px] text-zinc-500 font-medium">
                          Графік відключень
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link href="/settings">
                <Button variant="ghost" size="icon" className={cn(
                  "rounded-[12px] h-10 w-10 group overflow-hidden transition-all duration-300 border"
                )}
                style={{
                  background: isLight
                    ? `rgba(var(--accent-hex-rgb, 16,185,129), 0.08)`
                    : `rgba(var(--accent-hex-rgb, 16,185,129), 0.08)`,
                  borderColor: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.25' : '0.2'})`,
                  boxShadow: `0 ${isLight ? '1px 2px' : '0 8px'} rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.1' : '0.12'})`,
                }}
                data-testid="button-settings">
                  <SettingsIcon className="w-[18px] h-[18px] group-hover:rotate-90 transition-all duration-500" style={{ color: `var(--accent-hex, #10b981)` }} />
                </Button>
              </Link>
              {!isTelegramMiniApp() && (
              <a href="/api/logout" data-testid="button-logout">
                <Button variant="ghost" size="icon" className={cn(
                  "rounded-[12px] h-10 w-10 transition-all duration-300 group border",
                  isLight
                    ? "bg-red-50 border-red-200 hover:bg-red-100 hover:border-red-400 shadow-sm shadow-red-100 hover:shadow-md hover:shadow-red-200/60"
                    : "bg-red-500/[0.08] border-red-500/20 shadow-[0_0_8px_rgba(239,68,68,0.1)] hover:bg-red-500/15 hover:border-red-400/30 hover:shadow-[0_0_16px_rgba(239,68,68,0.2)]"
                )}>
                  <LogOut className={cn("w-[18px] h-[18px] transition-colors duration-300", isLight ? "text-red-500 group-hover:text-red-600" : "text-red-400/80 group-hover:text-red-300")} />
                </Button>
              </a>
              )}
            </div>
          </div>

          <div className={cn("min-h-[40px]", !locationsLoaded && "opacity-0")}>
          {locationsLoaded && userLocations.length >= 1 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
                >
                  <div
                    className="flex items-center gap-2 pt-2 pb-1 overflow-x-auto scrollbar-none"
                    style={{ WebkitOverflowScrolling: 'touch' }}
                    data-testid="location-switcher"
                  >
                    {userLocations.map((loc, index) => {
                      const isActive = activeLocation ? activeLocation.id === loc.id : loc.isPrimary;
                      return (
                        <motion.button
                          key={loc.id}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.25, delay: index * 0.04, ease: [0.4, 0, 0.2, 1] }}
                          layout
                          onClick={() => {
                            const currentlyActive = activeLocation ? activeLocation.id === loc.id : loc.isPrimary;
                            if (currentlyActive) return;
                            setActiveLocation(loc);
                          }}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0 transition-all duration-200 border hover:scale-[1.04] active:scale-[0.95]",
                            isActive
                              ? "text-white border-transparent"
                              : isLight
                                ? "bg-zinc-100 text-zinc-600 border-zinc-200 hover:bg-zinc-200"
                                : "bg-white/5 text-zinc-400 border-white/10 hover:bg-white/10"
                          )}
                          style={isActive ? {
                            background: 'var(--accent-hex, #10b981)',
                            borderColor: 'transparent',
                            boxShadow: `0 0 10px rgba(var(--accent-hex-rgb, 16,185,129), 0.3)`,
                          } : undefined}
                          data-testid={`location-pill-${loc.id}`}
                        >
                          {loc.name}
                        </motion.button>
                      );
                    })}
                    {userLocations.length >= 2 && (
                      <>
                        <div className={cn("w-px h-5 mx-0.5 shrink-0 rounded-full", isLight ? "bg-zinc-200" : "bg-white/10")} />
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.25, delay: (userLocations.length + 1) * 0.04 }}
                        >
                          <button
                            onClick={() => setPrioritizerOpen(true)}
                            className={cn(
                              "flex items-center justify-center w-7 h-7 rounded-full shrink-0 transition-all duration-200 border hover:scale-110 active:scale-90",
                              isLight
                                ? "bg-zinc-100 text-zinc-400 border-zinc-200 hover:bg-zinc-200 hover:text-zinc-600"
                                : "bg-white/5 text-zinc-500 border-white/10 hover:bg-white/10 hover:text-zinc-300"
                            )}
                            title="Змінити порядок"
                            data-testid="button-reorder-locations"
                          >
                            <ArrowUpDown className="w-3.5 h-3.5" />
                          </button>
                        </motion.div>
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.25, delay: (userLocations.length + 2) * 0.04 }}
                        >
                          <button
                            onClick={() => setCompareOpen(true)}
                            className={cn(
                              "flex items-center gap-1 px-2.5 h-7 rounded-full shrink-0 transition-all duration-200 border hover:scale-105 active:scale-95",
                              isLight
                                ? "bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100"
                                : "bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/20"
                            )}
                            data-testid="button-compare-locations"
                          >
                            <GitCompareArrows className="w-3 h-3" />
                            <span className="text-[10px] font-bold">Порівняти</span>
                          </button>
                        </motion.div>
                      </>
                    )}
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.25, delay: (userLocations.length + (userLocations.length >= 2 ? 3 : 0)) * 0.04 }}
                    >
                      <Link href="/settings">
                        <button
                          className={cn(
                            "flex items-center justify-center w-7 h-7 rounded-full shrink-0 transition-all duration-200 border hover:scale-110 active:scale-90",
                            isLight
                              ? "bg-zinc-100 text-zinc-500 border-zinc-200 hover:bg-zinc-200"
                              : "bg-white/5 text-zinc-500 border-white/10 hover:bg-white/10"
                          )}
                          data-testid="button-add-location"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </Link>
                    </motion.div>
                  </div>
                </motion.div>
          )}
          </div>
        </header>

        {/* Queue detection loading state */}
        <AnimatePresence>
          {lookupMode === 'address' && !queueId && !detectionDone && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
            >
              <Card className={cn(
                "border rounded-[32px] overflow-hidden backdrop-blur-xl shadow-lg",
                isLight ? "bg-white border-amber-500/20 shadow-amber-500/5" : "bg-zinc-900/40 border-amber-500/20 shadow-amber-500/5"
              )}>
                <CardContent className="p-6">
                  <div className="flex items-center justify-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
                    <p className="text-sm text-zinc-400">
                      Визначаємо вашу чергу...
                    </p>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline queue picker when alternatives exist */}
        {lookupMode === 'address' && !queueId && detectionDone && queueAlternatives.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Card className={cn(
              "border rounded-[32px] overflow-hidden backdrop-blur-xl shadow-lg",
              isLight ? "bg-white border-amber-500/20 shadow-amber-500/5" : "bg-zinc-900/40 border-amber-500/20 shadow-amber-500/5"
            )}>
              <CardContent className="p-6">
                <p className={cn("text-sm mb-4 text-center", isLight ? "text-zinc-500" : "text-zinc-400")}>
                  Ваша адреса може належати до кількох {city === 'Київ' ? 'груп' : 'черг'}. Оберіть вашу:
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {queueAlternatives.map((q) => (
                    <button
                      key={q}
                      data-testid={`btn-alt-queue-${q}`}
                      onClick={() => {
                        setQueueId(q);
                        rememberAddressQueue(street, houseNumber, { queueId: q, timestamp: Date.now() });
                      }}
                      className={cn(
                        "py-2 px-3 rounded-xl text-sm font-medium transition-all duration-200 border",
                        isLight
                          ? "bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100"
                          : "bg-amber-500/10 border-amber-500/20 text-amber-300 hover:bg-amber-500/20"
                      )}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {lookupMode === 'address' && !queueId && detectionDone && noOutagesExpected && queueAlternatives.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Card className={cn(
              "border rounded-[32px] overflow-hidden backdrop-blur-xl shadow-lg",
              isLight ? "bg-white border-emerald-500/20 shadow-emerald-500/5" : "bg-zinc-900/40 border-emerald-500/20 shadow-emerald-500/5"
            )}>
              <CardContent className="p-6 text-center">
                <div className={cn("text-4xl mb-3")}>💡</div>
                <p className={cn("text-base font-semibold mb-2", isLight ? "text-emerald-700" : "text-emerald-400")}>
                  Відключень не очікується
                </p>
                <p className={cn("text-sm", isLight ? "text-zinc-500" : "text-zinc-400")}>
                  Для вашої адреси наразі не заплановано відключень електроенергії
                </p>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {lookupMode === 'address' && !queueId && detectionDone && needsManualQueue && !noOutagesExpected && queueAlternatives.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Card className={cn(
              "border rounded-[32px] overflow-hidden backdrop-blur-xl shadow-lg",
              isLight ? "bg-white border-emerald-500/20 shadow-emerald-500/5" : "bg-zinc-900/40 border-emerald-500/20 shadow-emerald-500/5"
            )}>
              <CardContent className="p-6 text-center">
                <div className={cn("text-4xl mb-3")}>💡</div>
                <p className={cn("text-base font-semibold mb-2", isLight ? "text-emerald-700" : "text-emerald-400")}>
                  Відключень не очікується
                </p>
                <p className={cn("text-sm", isLight ? "text-zinc-500" : "text-zinc-400")}>
                  Для вашої адреси наразі не заплановано відключень електроенергії
                </p>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Emergency Alert Banner */}
        <AnimatePresence>
          {schedule?.alert && schedule.alert.isActive && (
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.98 }}
              transition={{ duration: 0.3 }}
              data-testid="alert-emergency"
            >
              <div className={cn(
                "rounded-3xl border-2 p-4 space-y-2",
                isLight
                  ? "bg-red-50 border-red-200"
                  : "bg-red-950/40 border-red-800/50"
              )}>
                <div className="flex items-start gap-3">
                  <div className={cn(
                    "shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-sm",
                    isLight ? "bg-red-100" : "bg-red-900/60"
                  )}>
                    ⚠️
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className={cn("text-xs font-bold uppercase tracking-wider", isLight ? "text-red-700" : "text-red-400")}>
                      {schedule.alert.cause || 'Увага'}
                    </p>
                    <p className={cn("text-[11px] leading-relaxed", isLight ? "text-red-800/80" : "text-red-300/80")}>
                      {schedule.alert.message}
                    </p>
                    {(schedule.alert.startTime || schedule.alert.endTime) && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                        {schedule.alert.startTime && (
                          <span className={cn("text-[10px] font-mono font-bold", isLight ? "text-red-600" : "text-red-400")}>
                            З {schedule.alert.startTime.replace('T', ' ')}
                          </span>
                        )}
                        {schedule.alert.endTime && (
                          <span className={cn("text-[10px] font-mono font-bold", isLight ? "text-red-600" : "text-red-400")}>
                            До {schedule.alert.endTime.replace('T', ' ')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <p className={cn("text-[9px] text-center italic", isLight ? "text-red-500/70" : "text-red-500/50")}>
                  Графіки відключень можуть не діяти
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Status Card */}
        <motion.div
          className="relative"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          {isApproachingChange && (
            <>
              <motion.div
                className="absolute -inset-3 rounded-[56px] pointer-events-none z-0"
                animate={{ opacity: [glowIntensity * 0.3, glowIntensity * 0.7, glowIntensity * 0.3] }}
                transition={{ repeat: Infinity, duration: glowPulseDuration, ease: "easeInOut" }}
                style={{
                  background: status.isOnline
                    ? `radial-gradient(ellipse at center, rgba(245,158,11,${glowIntensity * 0.35}) 0%, rgba(245,158,11,0) 70%)`
                    : `radial-gradient(ellipse at center, rgba(16,185,129,${glowIntensity * 0.35}) 0%, rgba(16,185,129,0) 70%)`,
                  filter: `blur(${8 + glowIntensity * 16}px)`,
                }}
              />
              <motion.div
                className="absolute -inset-6 rounded-[64px] pointer-events-none z-0"
                animate={{ opacity: [glowIntensity * 0.1, glowIntensity * 0.35, glowIntensity * 0.1] }}
                transition={{ repeat: Infinity, duration: glowPulseDuration * 1.3, ease: "easeInOut", delay: 0.5 }}
                style={{
                  background: status.isOnline
                    ? `radial-gradient(ellipse at center, rgba(245,158,11,${glowIntensity * 0.2}) 0%, transparent 60%)`
                    : `radial-gradient(ellipse at center, rgba(16,185,129,${glowIntensity * 0.2}) 0%, transparent 60%)`,
                  filter: `blur(${16 + glowIntensity * 24}px)`,
                }}
              />
            </>
          )}
          <Card className={cn(
            "relative shadow-2xl overflow-hidden rounded-[48px] transition-colors duration-500 z-[1]",
            isLight ? "bg-white shadow-lg shadow-zinc-200/50 border-zinc-200" : "bg-zinc-900/40 backdrop-blur-3xl border-white/5",
            isApproachingChange && "border-amber-500/30"
          )}>
            <CardContent className="p-10 flex flex-col items-center text-center space-y-8">
              
              <div className="relative flex items-center justify-center w-32 h-32">
                <div 
                  className={cn(
                    "w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-colors duration-500 shrink-0 relative z-10 overflow-hidden",
                    status.isOnline 
                      ? "bg-emerald-500 text-black shadow-emerald-500/30"
                      : (isLight ? "bg-zinc-200 text-zinc-400" : "bg-zinc-800/50 text-zinc-600 shadow-inner")
                  )}
                  data-testid="status-indicator"
                >
                  {isApproachingChange && (
                    <motion.div 
                      animate={{ opacity: [glowIntensity * 0.15, glowIntensity * 0.4, glowIntensity * 0.15] }}
                      transition={{ repeat: Infinity, duration: glowPulseDuration, ease: "easeInOut" }}
                      className={cn(
                        "absolute inset-0 z-0",
                        status.isOnline 
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                      )}
                    />
                  )}

                  {/* Liquid fill animation */}
                  <motion.div 
                    className={cn(
                      "absolute bottom-0 left-0 right-0 z-0",
                      status.isOnline 
                        ? "bg-emerald-600/30"
                        : "bg-emerald-500/40"
                    )}
                    initial={{ height: 0 }}
                    animate={{ height: `${status.isOnline ? (1 - status.progress) * 100 : status.progress * 100}%` }}
                    transition={{ duration: 0.5 }}
                  >
                    {/* Bubbles animation */}
                    {[...Array(5)].map((_, i) => (
                      <motion.div
                        key={i}
                        className="absolute rounded-full opacity-60 w-1 h-1 bg-emerald-300"
                        initial={{ bottom: 0, left: `${Math.random() * 100}%` }}
                        animate={{ 
                          bottom: '100%',
                          opacity: [0, 1, 0],
                          x: [0, (Math.random() - 0.5) * 20]
                        }}
                        transition={{ 
                          duration: 1.5 + Math.random(),
                          repeat: Infinity,
                          delay: Math.random()
                        }}
                      />
                    ))}
                  </motion.div>
                  
                  <motion.div 
                    animate={status.isOnline ? { 
                      scale: isApproachingChange ? [1, 1 + glowIntensity * 0.2, 1] : [1, 1.1, 1],
                      rotate: changeProximity > 0.7 ? [0, 3, -3, 0] : 0
                    } : {
                      scale: isApproachingChange ? [1, 1 + glowIntensity * 0.1, 1] : 1
                    }} 
                    transition={{ repeat: Infinity, duration: glowPulseDuration || 2, ease: "easeInOut" }}
                    className="relative z-10"
                  >
                    {status.isOnline ? <Zap className="w-10 h-10 fill-current" /> : <ZapOff className="w-10 h-10" />}
                  </motion.div>
                </div>

                {/* Progress Ring */}
                <svg className="absolute w-32 h-32 -rotate-90 pointer-events-none z-20">
                  <circle
                    cx="64"
                    cy="64"
                    r="60"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="transparent"
                    className={isLight ? "text-zinc-200" : "text-zinc-800/50"}
                  />
                  <motion.circle
                    cx="64"
                    cy="64"
                    r="60"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="transparent"
                    strokeDasharray="377"
                    initial={{ strokeDashoffset: 377 }}
                    animate={{ strokeDashoffset: 377 * (status.isOnline ? status.progress : (1 - status.progress)) }}
                    className="text-emerald-500"
                    style={{ filter: 'drop-shadow(0 0 8px rgba(16,185,129,0.5))' }}
                  />
                </svg>
              </div>

              <div className="space-y-1 w-full px-2">
                <span className="text-[10px] font-black text-zinc-600 uppercase tracking-[0.4em] mb-2 block">Система</span>
                <h2 className={cn(
                  "text-3xl sm:text-4xl md:text-5xl font-black tracking-tighter uppercase transition-colors duration-500 break-words",
                  status.isOnline ? "text-emerald-400" : "text-zinc-500"
                )} data-testid="text-status">
                  {status.isOnline ? 'СВІТЛО Є' : 'БЕЗ СВІТЛА'}
                </h2>
              </div>

              <div className={cn(
                "px-4 sm:px-8 py-4 rounded-[28px] border transition-colors duration-500 flex flex-col gap-1 items-center min-w-[180px] sm:min-w-[200px] relative overflow-hidden",
                isLight ? "bg-zinc-50 border-zinc-200" : "bg-white/5 border-white/10 shadow-inner",
                isApproachingChange && "border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.2)]",
                !status.nextChange && "invisible"
              )}>
                <span className={cn(
                  "text-[9px] sm:text-[10px] font-bold uppercase tracking-widest relative z-10 whitespace-nowrap transition-colors",
                  isApproachingChange ? "text-amber-400" : "text-zinc-500"
                )}>
                  {status.isOnline ? 'До вимкнення' : 'До ввімкнення'}
                </span>
                <span className={cn(
                  "text-2xl sm:text-3xl font-black font-mono tracking-tighter relative z-10",
                  isApproachingChange ? "text-amber-400" : (isLight ? "text-zinc-900" : "text-white")
                )} data-testid="text-countdown">
                  {formattedTime || '—'}
                </span>
                
                {status.nextChange && (
                  <div className={cn(
                    "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest relative z-10 mt-2 shadow-sm border",
                    isLight ? "bg-zinc-100 text-zinc-600 border-zinc-200" : "bg-zinc-800/80 text-zinc-300 border-white/5"
                  )} data-testid="text-next-change-time">
                    {(status.nextChange as Date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
                
                <motion.div 
                  className={cn(
                    "absolute left-0 top-0 bottom-0 z-0",
                    status.isOnline 
                      ? "bg-white/5"
                      : "bg-emerald-500/10"
                  )}
                  initial={{ width: 0 }}
                  animate={{ width: `${status.isOnline ? (1 - status.progress) * 100 : status.progress * 100}%` }}
                />
              </div>

              {activeLocation && (
                <button
                  onClick={handleShare}
                  disabled={sharing}
                  className={cn(
                    "flex items-center gap-1.5 px-4 py-2 rounded-full text-[11px] font-semibold transition-colors duration-500 border hover:scale-[1.04] active:scale-[0.95]",
                    shareCopied
                      ? (isLight ? "border-emerald-300 text-emerald-600 bg-emerald-50" : "border-emerald-500/40 text-emerald-400 bg-emerald-500/10")
                      : (isLight ? "border-zinc-200 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50 hover:border-zinc-300" : "border-white/10 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 hover:border-white/20")
                  )}
                  data-testid="button-share-status"
                >
                  {sharing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : shareCopied ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
                  {shareCopied ? 'Скопійовано' : 'Поділитися'}
                </button>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Schedule */}
        <motion.div
          className="space-y-4"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.15, ease: [0.4, 0, 0.2, 1] }}
        >
          <Tabs defaultValue="today" className="w-full">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-zinc-600" />
                    <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Графік</span>
                  </div>
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-[0.2em] ml-6",
                    "text-zinc-500/60"
                  )}>
                    {now.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}
                  </span>
                </div>
                <TabsList className={cn(
                "border p-1 rounded-2xl h-11 w-full sm:w-auto",
                isLight ? "bg-zinc-100 border-zinc-200" : "bg-zinc-900/60 border-white/5"
              )}>
                <TabsTrigger value="today" data-testid="tab-today" className={cn("flex-1 sm:flex-none text-[10px] font-black px-6 rounded-xl uppercase", isLight ? "data-[state=active]:bg-white data-[state=active]:text-zinc-900 data-[state=active]:shadow-sm text-zinc-500 data-[state=active]:border data-[state=active]:border-zinc-200" : "data-[state=active]:bg-white/10")}>Сьогодні</TabsTrigger>
                {hasTomorrow && (
                  <TabsTrigger value="tomorrow" data-testid="tab-tomorrow" className={cn("flex-1 sm:flex-none text-[10px] font-black px-6 rounded-xl uppercase", isLight ? "data-[state=active]:bg-white data-[state=active]:text-zinc-900 data-[state=active]:shadow-sm text-zinc-500 data-[state=active]:border data-[state=active]:border-zinc-200" : "data-[state=active]:bg-white/10")}>
                    Завтра ({new Date(now.getTime() + 24 * 60 * 60 * 1000).toLocaleDateString('uk-UA', { day: 'numeric', month: 'numeric' })})
                  </TabsTrigger>
                )}
              </TabsList>
            </div>
            
            <TabsContent value="today" className="mt-0 outline-none">
              <div className={cn(
                "border rounded-[32px] p-4 sm:p-6 shadow-xl transition-colors duration-500",
                isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/20 border-white/5 backdrop-blur-md"
              )}>
                <Timeline slots={schedule?.days[0]?.slots || []} isToday={true} />
              </div>
            </TabsContent>

            {hasTomorrow && (
              <TabsContent value="tomorrow" className="mt-0 outline-none">
                <div className={cn(
                  "border rounded-[32px] p-4 sm:p-6 shadow-xl transition-colors duration-500",
                  isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/20 border-white/5 backdrop-blur-md"
                )}>
                  {tomorrowHasData ? (
                    <Timeline slots={schedule?.days[1]?.slots || []} isToday={false} />
                  ) : (
                    <div className="flex flex-col items-center justify-center py-10 gap-3">
                      <div className="text-3xl">📅</div>
                      <p className={cn("text-sm font-semibold", isLight ? "text-zinc-600" : "text-zinc-300")}>
                        Графік на завтра ще не опубліковано
                      </p>
                      <p className={cn("text-xs text-center max-w-[260px]", isLight ? "text-zinc-400" : "text-zinc-500")}>
                        Зазвичай графік з'являється увечері. Перевірте пізніше.
                      </p>
                    </div>
                  )}
                </div>
              </TabsContent>
            )}
          </Tabs>

          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 pt-3 pb-1">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-emerald-500/20 border border-emerald-500/20" />
              <span className="text-[10px] text-zinc-500">Є світло</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-rose-500/50 border border-rose-500/30" />
              <span className="text-[10px] text-zinc-500">Немає світла</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-amber-500/40 border border-amber-500/30" />
              <span className="text-[10px] text-zinc-500">Можливе вимкнення</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className={cn("w-0.5 h-3 rounded-full", isLight ? "bg-zinc-800" : "bg-white")} />
              <span className="text-[10px] text-zinc-500">Зараз</span>
            </div>
          </div>
        </motion.div>

        {/* Community reports & gamification */}
        {effectiveQueueId && (
          <div className="space-y-4">
            <PowerReportCard city={effectiveCity} queueId={effectiveQueueId} scheduleIsOnline={status.isOnline} />
            <WeeklyDigestCard />
          </div>
        )}

        {/* Footer */}
        <footer className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6">
          <Button 
            variant="ghost" 
            onClick={() => handleCheck()}
            disabled={isChecking}
            data-testid="button-refresh"
            className={cn(
              "w-full sm:flex-1 rounded-2xl h-14 border transition-colors duration-500 gap-3 font-black text-xs uppercase tracking-widest shadow-lg",
              isLight 
                ? "bg-zinc-100 border-zinc-200 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-200" 
                : "bg-zinc-900/50 border-white/5 text-zinc-400 hover:text-white hover:bg-white/5"
            )}
          >
            {isChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Перевірити
          </Button>
          
          <div className="flex flex-col items-center sm:items-end shrink-0 gap-1">
            {schedule?.updateTime && (
              <div className="flex flex-col items-center sm:items-end">
                <span className={cn("text-[8px] font-black uppercase tracking-[0.3em]", isLight ? "text-zinc-500" : "text-zinc-700")} data-testid="label-voe-update">{effectiveCity === 'Київ' ? 'ДТЕК' : effectiveCity === 'Харків' ? 'ХАРКІВОБЛЕНЕРГО' : effectiveCity === 'Одеса' ? 'ДТЕК ОЕМ' : 'ВІНОБЛЕНЕРГО'}</span>
                <span className={cn(
                  "text-[10px] font-mono font-bold",
                  "text-zinc-500"
                )} data-testid="text-voe-update-time">
                  {schedule.updateTime}
                </span>
              </div>
            )}
            <div className="flex flex-col items-center sm:items-end">
              <span className={cn("text-[8px] font-black uppercase tracking-[0.3em]", isLight ? "text-zinc-500" : "text-zinc-700")}>Синхронізовано</span>
              <AnimatePresence mode="wait">
                <motion.span 
                  key={lastCheckAttempt as number}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "text-[10px] font-mono font-bold",
                    "text-zinc-500"
                  )}
                  data-testid="text-sync-time"
                >
                  {lastCheckAttempt ? new Date(lastCheckAttempt as number).toLocaleTimeString() : '---'}
                </motion.span>
              </AnimatePresence>
            </div>
          </div>
        </footer>

        {/* Telegram Bot Button */}
        <div className="pt-6 px-2">
          <a
            href="https://t.me/PowerUkraineBot?start=main"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between w-full py-3.5 px-5 rounded-2xl text-white transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
            style={{
              background: 'linear-gradient(135deg, #2AABEE, #229ED9)',
              boxShadow: '0 4px 24px rgba(42,171,238,0.2)',
            }}
            data-testid="button-telegram-bot"
          >
            <div className="flex items-center gap-3">
              <svg className="w-6 h-6 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
              <span className="text-sm font-bold">Telegram бот</span>
            </div>
            <svg className="w-4 h-4 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>

        {/* Credit Link */}
        <div className="pt-4 pb-4 text-center">
           <p className={cn("text-[10px] font-bold uppercase tracking-widest", isLight ? "text-zinc-400" : "text-zinc-700")}>
            Зроблено: <a 
              href="https://t.me/oleksandr_hohaizel" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-emerald-500 hover:text-emerald-400 underline decoration-emerald-500/30 transition-colors"
            >
              oleksandr_hohaizel
            </a>
          </p>
        </div>
      </div>


      <LocationPrioritizer
        open={prioritizerOpen}
        onOpenChange={setPrioritizerOpen}
        locations={userLocations}
        activeLocationId={activeLocation?.id ?? null}
        onReorder={(reordered) => {
          setUserLocations(reordered);
          if (activeLocation && !reordered.find(l => l.id === activeLocation.id)) {
            setActiveLocation(reordered[0] || null);
          }
        }}
      />

      <CompareSheet
        open={compareOpen}
        onOpenChange={setCompareOpen}
        locations={userLocations.filter(l => l.queueId)}
      />
    </div>
  );
}
