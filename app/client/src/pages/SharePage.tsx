import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'wouter';
import { Timeline } from '@/components/Timeline';
import { fetchSchedule, getCurrentStatus, formatTimeRemaining } from '@/lib/schedule-service';
import type { ScheduleData } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Zap, ZapOff, MapPin, Calendar } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTheme } from '@/hooks/useTheme';
import { motion } from 'framer-motion';

interface SharedLocation {
  name: string;
  city: string;
  queueId: string;
  street?: string;
  houseNumber?: string;
}

function queueLabel(city: string) {
  return city === 'Київ' ? 'група' : 'черга';
}

const TD = 'duration-500';

export function SharePage() {
  const params = useParams<{ shareId: string }>();
  const shareId = params.shareId;
  const [location, setLocation] = useState<SharedLocation | null>(null);
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());

  const { isLight } = useTheme();

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!shareId) return;
    (async () => {
      try {
        const res = await fetch(`/api/share/${encodeURIComponent(shareId)}`);
        if (!res.ok) {
          if (res.status === 404) setError('Посилання не знайдено або було видалено');
          else setError('Помилка завантаження');
          return;
        }
        const loc: SharedLocation = await res.json();
        setLocation(loc);

        if (loc.queueId) {
          const sched = await fetchSchedule(loc.queueId, loc.city);
          setSchedule(sched);
        }
      } catch {
        setError('Помилка з\'єднання');
      } finally {
        setLoading(false);
      }
    })();
  }, [shareId]);

  useEffect(() => {
    if (!location || !schedule) return;
    const interval = setInterval(async () => {
      try {
        if (location.queueId) {
          const sched = await fetchSchedule(location.queueId, location.city);
          setSchedule(sched);
        }
      } catch {}
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [location, schedule]);

  const status = useMemo(() => getCurrentStatus(schedule), [schedule, now]);

  const hasTomorrow = schedule && schedule.days.length > 1;
  const tomorrowHasData = hasTomorrow && schedule.days[1].slots.length > 0;

  const formattedTime = status.totalDuration > 0 ? formatTimeRemaining(status.totalDuration) : '';

  const isApproachingChange = status.totalDuration > 0 && status.totalDuration < 30 * 60 * 1000;
  const changeProximity = (() => {
    if (!status.totalDuration || status.totalDuration <= 0) return 0;
    const thirtyMin = 30 * 60 * 1000;
    if (status.totalDuration >= thirtyMin) return 0;
    return 1 - (status.totalDuration / thirtyMin);
  })();
  const glowIntensity = Math.pow(changeProximity, 2.5);
  const glowPulseDuration = changeProximity > 0.8 ? 1.5 : changeProximity > 0.5 ? 3 : 5;

  if (loading) {
    return (
      <div className={cn(
        "min-h-screen flex flex-col items-center justify-center gap-4 font-sans transition-colors",
        TD,
        isLight ? "bg-[#f5f5f7]" : "bg-[#050505]"
      )}>
        <div className="relative w-14 h-14">
          <div className={cn("absolute inset-0 rounded-full border-4 transition-colors", TD, isLight ? "border-zinc-200" : "border-zinc-800")} />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-emerald-500 animate-spin" />
        </div>
        <p className={cn("text-sm transition-colors", TD, isLight ? "text-zinc-400" : "text-zinc-500")}>Завантаження...</p>
      </div>
    );
  }

  if (error || !location) {
    return (
      <div className={cn(
        "min-h-screen flex flex-col items-center justify-center gap-6 px-6 font-sans transition-colors",
        TD,
        isLight ? "bg-[#f5f5f7] text-zinc-900" : "bg-[#050505] text-white"
      )}>
        <div className="text-center space-y-3">
          <ZapOff className="w-12 h-12 mx-auto text-zinc-400" />
          <h1 className="text-xl font-bold">{error || 'Не знайдено'}</h1>
          <p className={cn("text-sm transition-colors", TD, isLight ? "text-zinc-500" : "text-zinc-400")}>
            Спробуйте отримати нове посилання від власника
          </p>
        </div>
        <a
          href="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-bold transition-all bg-emerald-500 text-white hover:bg-emerald-600 shadow-lg shadow-emerald-500/20"
        >
          <Zap className="w-4 h-4" />
          Відкрити Світло Україна
        </a>
      </div>
    );
  }

  return (
    <div className={cn(
      "min-h-screen transition-colors selection:bg-white/10 overflow-x-hidden relative font-sans antialiased",
      TD,
      isLight ? "bg-[#f5f5f7] text-zinc-900" : "bg-[#050505] text-white"
    )}>
      <div className="max-w-xl mx-auto px-5 pt-6 pb-10 space-y-8 relative z-10">

        {/* Header - identical to Dashboard */}
        <header className={cn("sticky top-0 z-20 -mx-5 px-5 py-3 backdrop-blur-xl border-b transition-colors", TD, isLight ? "bg-white/90 border-zinc-200" : "bg-[#050505]/80 border-white/[0.04]")}>
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3.5 min-w-0 flex-1 mr-3">
              <div className="relative shrink-0">
                <ThemeToggle compact />
              </div>

              <div className="flex flex-col min-w-0 flex-1">
                <h1 className={cn("text-lg font-bold tracking-tight leading-tight transition-colors", TD, isLight ? "text-zinc-900" : "text-white")} data-testid="text-share-title">
                  {location.name}
                </h1>
                <div className="flex flex-col gap-0 mt-0.5">
                  <div className="flex items-center gap-1.5">
                    <MapPin className="w-3 h-3 text-zinc-500 shrink-0" />
                    <span className="text-[11px] text-zinc-500 font-medium truncate">
                      {location.city}{location.street ? `, вулиця ${location.street}` : ''}{location.houseNumber ? `, ${location.houseNumber}` : ''}
                    </span>
                  </div>
                  {location.queueId && (
                    <div className="flex items-center gap-1.5 ml-[18px]">
                      <span className="text-[10px] text-zinc-600 font-medium">
                        {queueLabel(location.city)} {location.queueId}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </header>

        {location.queueId && schedule ? (
          <>
            {/* Status Card - identical to Dashboard */}
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
                "relative shadow-2xl overflow-hidden rounded-[48px] transition-colors z-[1]",
                TD,
                isLight ? "bg-white shadow-lg shadow-zinc-200/50 border-zinc-200" : "bg-zinc-900/40 backdrop-blur-3xl border-white/5",
                isApproachingChange && "border-amber-500/30"
              )}>
                <CardContent className="p-10 flex flex-col items-center text-center space-y-8">
                  
                  <div className="relative flex items-center justify-center w-32 h-32">
                    <div 
                      className={cn(
                        "w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-colors shrink-0 relative z-10 overflow-hidden",
                        TD,
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
                            status.isOnline ? "bg-amber-500" : "bg-emerald-500"
                          )}
                        />
                      )}

                      {/* Liquid fill animation */}
                      <motion.div 
                        className={cn(
                          "absolute bottom-0 left-0 right-0 z-0",
                          status.isOnline ? "bg-emerald-600/30" : "bg-emerald-500/40"
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
                        className={cn("transition-colors", TD, isLight ? "text-zinc-200" : "text-zinc-800/50")}
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
                      "text-3xl sm:text-4xl md:text-5xl font-black tracking-tighter uppercase transition-colors break-words",
                      TD,
                      status.isOnline ? "text-emerald-400" : "text-zinc-500"
                    )} data-testid="text-status">
                      {status.isOnline ? 'СВІТЛО Є' : 'БЕЗ СВІТЛА'}
                    </h2>
                  </div>

                  <div className={cn(
                    "px-4 sm:px-8 py-4 rounded-[28px] border transition-colors flex flex-col gap-1 items-center min-w-[180px] sm:min-w-[200px] relative overflow-hidden",
                    TD,
                    isLight ? "bg-zinc-50 border-zinc-200" : "bg-white/5 border-white/10 shadow-inner",
                    isApproachingChange && "border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.2)]",
                    !status.nextChange && "invisible"
                  )}>
                    <span className={cn(
                      "text-[9px] sm:text-[10px] font-bold uppercase tracking-widest relative z-10 whitespace-nowrap transition-colors",
                      TD,
                      isApproachingChange ? "text-amber-400" : "text-zinc-500"
                    )}>
                      {status.isOnline ? 'До вимкнення' : 'До ввімкнення'}
                    </span>
                    <span className={cn(
                      "text-2xl sm:text-3xl font-black font-mono tracking-tighter relative z-10 transition-colors",
                      TD,
                      isApproachingChange ? "text-amber-400" : (isLight ? "text-zinc-900" : "text-white")
                    )} data-testid="text-countdown">
                      {formattedTime || '—'}
                    </span>
                    
                    {status.nextChange && (
                      <div className={cn(
                        "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest relative z-10 mt-2 shadow-sm border transition-colors",
                        TD,
                        isLight ? "bg-zinc-100 text-zinc-600 border-zinc-200" : "bg-zinc-800/80 text-zinc-300 border-white/5"
                      )} data-testid="text-next-change-time">
                        {(status.nextChange as Date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    )}
                    
                    <motion.div 
                      className={cn(
                        "absolute left-0 top-0 bottom-0 z-0",
                        status.isOnline ? "bg-white/5" : "bg-emerald-500/10"
                      )}
                      initial={{ width: 0 }}
                      animate={{ width: `${status.isOnline ? (1 - status.progress) * 100 : status.progress * 100}%` }}
                    />
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* Schedule - identical to Dashboard */}
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
                    <span className={cn("text-[10px] font-bold uppercase tracking-[0.2em] ml-6", "text-zinc-500/60")}>
                      {now.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}
                    </span>
                  </div>
                  <TabsList className={cn(
                    "border p-1 rounded-2xl h-11 w-full sm:w-auto transition-colors",
                    TD,
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
                    "border rounded-[32px] p-4 sm:p-6 shadow-xl transition-colors",
                    TD,
                    isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/20 border-white/5 backdrop-blur-md"
                  )}>
                    <Timeline slots={schedule?.days[0]?.slots || []} isToday={true} />
                  </div>
                </TabsContent>

                {hasTomorrow && (
                  <TabsContent value="tomorrow" className="mt-0 outline-none">
                    <div className={cn(
                      "border rounded-[32px] p-4 sm:p-6 shadow-xl transition-colors",
                      TD,
                      isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/20 border-white/5 backdrop-blur-md"
                    )}>
                      {tomorrowHasData ? (
                        <Timeline slots={schedule?.days[1]?.slots || []} isToday={false} />
                      ) : (
                        <div className="flex flex-col items-center justify-center py-10 gap-3">
                          <div className="text-3xl">📅</div>
                          <p className={cn("text-sm font-semibold transition-colors", TD, isLight ? "text-zinc-600" : "text-zinc-300")}>
                            Графік на завтра ще не опубліковано
                          </p>
                          <p className={cn("text-xs text-center max-w-[260px] transition-colors", TD, isLight ? "text-zinc-400" : "text-zinc-500")}>
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
                  <div className={cn("w-0.5 h-3 rounded-full transition-colors", TD, isLight ? "bg-zinc-800" : "bg-white")} />
                  <span className="text-[10px] text-zinc-500">Зараз</span>
                </div>
              </div>
            </motion.div>

            {/* Update time - identical to Dashboard */}
            {schedule.updateTime && (
              <div className="flex flex-col items-center gap-1">
                <span className={cn("text-[8px] font-black uppercase tracking-[0.3em] transition-colors", TD, isLight ? "text-zinc-500" : "text-zinc-700")}>
                  {location.city === 'Київ' ? 'ДТЕК' : location.city === 'Харків' ? 'ХАРКІВОБЛЕНЕРГО' : location.city === 'Одеса' ? 'ДТЕК ОЕМ' : 'Вінобленерго'}
                </span>
                <span className={cn("text-[10px] font-mono font-bold", "text-zinc-500")}>
                  {schedule.updateTime}
                </span>
              </div>
            )}
          </>
        ) : (
          <Card className={cn(
            "rounded-[48px] overflow-hidden transition-colors",
            TD,
            isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/40 border-white/5"
          )}>
            <CardContent className="p-10 text-center">
              <ZapOff className={cn("w-10 h-10 mx-auto mb-3 transition-colors", TD, isLight ? "text-zinc-300" : "text-zinc-600")} />
              <p className={cn("text-sm transition-colors", TD, isLight ? "text-zinc-500" : "text-zinc-400")}>
                Немає даних про графік відключень
              </p>
            </CardContent>
          </Card>
        )}

        {/* CTA + Footer */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="text-center pt-4"
        >
          <a
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl text-sm font-bold transition-all bg-emerald-500 text-white hover:bg-emerald-600 shadow-lg shadow-emerald-500/20 hover:shadow-xl hover:shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98]"
            data-testid="link-open-app"
          >
            <Zap className="w-4 h-4" />
            Відкрити Світло Україна
          </a>
          <p className={cn("text-[10px] mt-3 font-bold uppercase tracking-widest transition-colors", TD, isLight ? "text-zinc-400" : "text-zinc-700")}>
            Відстежуйте графіки відключень у реальному часі
          </p>
        </motion.div>

        <div className="pt-2 pb-4 text-center">
          <p className={cn("text-[10px] font-bold uppercase tracking-widest transition-colors", TD, isLight ? "text-zinc-400" : "text-zinc-700")}>
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
    </div>
  );
}
