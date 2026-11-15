import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks/useTheme';
import { RefreshCw, Zap, ZapOff, AlertTriangle, Check, Share2, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { fetchSchedule, getCurrentStatus } from '@/lib/schedule-service';
import { ScheduleData, OutageSlot } from '@/lib/store';
import { useToast } from '@/hooks/use-toast';

interface LocationData {
  id: number;
  name: string;
  city: string;
  queueId: string;
  isPrimary: boolean;
  street?: string;
  houseNumber?: string;
}

interface LocationSchedule {
  location: LocationData;
  schedule: ScheduleData | null;
  loading: boolean;
  error: boolean;
}

function getLocationEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('дім') || n.includes('дом') || n.includes('home')) return '🏠';
  if (n.includes('робот') || n.includes('офіс') || n.includes('work')) return '🏢';
  if (n.includes('батьк') || n.includes('мам') || n.includes('тат')) return '❤️';
  if (n.includes('навч') || n.includes('універ') || n.includes('школ')) return '🎓';
  if (n.includes('дач') || n.includes('село')) return '🏡';
  return '📍';
}

function getStatusAtMinute(slots: OutageSlot[], minute: number): string {
  for (const s of slots) {
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    if (minute >= sh * 60 + sm && minute < eh * 60 + em) return s.status;
  }
  return 'online';
}

function CompactTimeline({ slots, isToday, isLight, height = 40 }: { slots: OutageSlot[]; isToday: boolean; isLight: boolean; height?: number }) {
  const now = new Date();
  const kyivTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const currentMinutes = kyivTime.getHours() * 60 + kyivTime.getMinutes();
  const currentTimePercent = (currentMinutes / (24 * 60)) * 100;

  const segments = useMemo(() => {
    return slots.map((slot) => {
      const [startH, startM] = slot.start.split(':').map(Number);
      const [endH, endM] = slot.end.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      const widthPct = ((endMinutes - startMinutes) / (24 * 60)) * 100;
      return {
        ...slot,
        left: (startMinutes / (24 * 60)) * 100,
        width: widthPct,
        label: `${slot.start}–${slot.end === '24:00' ? '00:00' : slot.end}`,
        durationMin: endMinutes - startMinutes,
      };
    });
  }, [slots]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div className={cn(
        "relative w-full rounded-lg overflow-hidden border transition-all duration-500",
        isLight ? "bg-zinc-100 border-zinc-200" : "bg-black/40 border-white/5"
      )} style={{ height }}>
        {segments.map((segment, idx) => (
          <div
            key={idx}
            className={cn(
              "absolute top-0 flex items-center justify-center transition-colors duration-500 overflow-hidden",
              segment.status === 'online' && (isLight ? "bg-emerald-200/80" : "bg-emerald-500/25"),
              segment.status === 'offline' && (isLight ? "bg-rose-200/80" : "bg-rose-500/40"),
              segment.status === 'possible' && (isLight ? "bg-amber-200/80" : "bg-amber-500/30")
            )}
            style={{ left: `${segment.left}%`, width: `${segment.width}%`, height: '100%' }}
          >
            {segment.width >= 5.5 && (
              <span className={cn(
                "font-mono font-bold leading-none whitespace-nowrap",
                segment.width >= 10 ? "text-[10px]" : "text-[8px]",
                segment.status === 'online' && (isLight ? "text-emerald-800/70" : "text-emerald-300/80"),
                segment.status === 'offline' && (isLight ? "text-rose-800/70" : "text-rose-300/80"),
                segment.status === 'possible' && (isLight ? "text-amber-800/70" : "text-amber-300/80")
              )}>
                {segment.label}
              </span>
            )}
          </div>
        ))}
        {isToday && (
          <div
            className={cn("absolute top-0 bottom-0 w-0.5 z-10", isLight ? "bg-zinc-800" : "bg-white")}
            style={{ left: `${currentTimePercent}%` }}
          />
        )}
      </div>
    </div>
  );
}

function ScheduleBlocks({ slots, isLight }: { slots: OutageSlot[]; isLight: boolean }) {
  const offlineSlots = slots.filter(s => s.status === 'offline' || s.status === 'possible');
  if (offlineSlots.length === 0) return (
    <div className={cn("text-[11px] font-medium py-0.5", isLight ? "text-emerald-600" : "text-emerald-400")}>
      ✅ Відключень немає
    </div>
  );

  return (
    <div className="flex flex-wrap gap-1">
      {offlineSlots.map((slot, idx) => {
        const end = slot.end === '24:00' ? '00:00' : slot.end;
        const [sh, sm] = slot.start.split(':').map(Number);
        const [eh, em] = slot.end.split(':').map(Number);
        const dur = eh * 60 + em - sh * 60 - sm;
        const durH = Math.floor(dur / 60);
        const durM = dur % 60;
        const durStr = durH > 0 && durM > 0 ? `${durH}г${durM}хв` : durH > 0 ? `${durH}г` : `${durM}хв`;
        return (
          <span key={idx} className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold",
            slot.status === 'offline'
              ? (isLight ? "bg-rose-100 text-rose-700" : "bg-rose-500/15 text-rose-400")
              : (isLight ? "bg-amber-100 text-amber-700" : "bg-amber-500/15 text-amber-400")
          )}>
            {slot.status === 'offline' ? '🔴' : '🟡'} {slot.start}–{end}
            <span className="opacity-60">({durStr})</span>
          </span>
        );
      })}
    </div>
  );
}

function CombinedTimeline({ schedules, dayIndex, isToday, isLight }: {
  schedules: LocationSchedule[];
  dayIndex: number;
  isToday: boolean;
  isLight: boolean;
}) {
  const now = new Date();
  const kyivTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const currentMinutes = kyivTime.getHours() * 60 + kyivTime.getMinutes();
  const currentTimePercent = (currentMinutes / (24 * 60)) * 100;

  const validSchedules = schedules.filter(s => s.schedule && s.schedule.days[dayIndex]?.slots.length > 0);

  const segments = useMemo(() => {
    const resolution = 30;
    const result: { start: number; end: number; type: 'all' | 'some' | 'none' }[] = [];

    for (let minute = 0; minute < 24 * 60; minute += resolution) {
      let onlineCount = 0;
      for (const ls of validSchedules) {
        const slots = ls.schedule!.days[dayIndex].slots;
        const status = getStatusAtMinute(slots, minute);
        if (status === 'online') onlineCount++;
      }

      const type = onlineCount === validSchedules.length ? 'all' : onlineCount > 0 ? 'some' : 'none';

      if (result.length > 0 && result[result.length - 1].type === type && result[result.length - 1].end === minute) {
        result[result.length - 1].end = minute + resolution;
      } else {
        result.push({ start: minute, end: minute + resolution, type });
      }
    }
    return result;
  }, [validSchedules, dayIndex]);

  if (validSchedules.length < 2) return null;

  return (
    <div className="space-y-1">
      <div className={cn("text-[11px] font-bold uppercase tracking-wider", isLight ? "text-zinc-500" : "text-zinc-400")}>
        Зведений
      </div>
      <div className="relative w-full" style={{ height: 36 }}>
        <div className={cn(
          "relative w-full rounded-lg overflow-hidden border transition-all duration-500",
          isLight ? "bg-zinc-100 border-zinc-300" : "bg-black/40 border-white/10"
        )} style={{ height: 36 }}>
          {segments.map((seg, idx) => (
            <div
              key={idx}
              className={cn(
                "absolute top-0 transition-colors duration-500",
                seg.type === 'all' && (isLight ? "bg-emerald-300" : "bg-emerald-500/30"),
                seg.type === 'some' && (isLight ? "bg-amber-200" : "bg-amber-500/25"),
                seg.type === 'none' && (isLight ? "bg-rose-200" : "bg-rose-500/40")
              )}
              style={{
                left: `${(seg.start / (24 * 60)) * 100}%`,
                width: `${((seg.end - seg.start) / (24 * 60)) * 100}%`,
                height: '100%',
              }}
            />
          ))}
          {isToday && (
            <div
              className={cn("absolute top-0 bottom-0 w-0.5 z-10", isLight ? "bg-zinc-800" : "bg-white")}
              style={{ left: `${currentTimePercent}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CurrentStatusSummary({ schedules, isLight }: { schedules: LocationSchedule[]; isLight: boolean }) {
  const validSchedules = schedules.filter(s => s.schedule && s.schedule.days[0]?.slots.length > 0);
  if (validSchedules.length < 2) return null;

  const now = new Date();
  const kyivTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const currentMinute = kyivTime.getHours() * 60 + kyivTime.getMinutes();

  const statuses = validSchedules.map(ls => {
    const status = getStatusAtMinute(ls.schedule!.days[0].slots, currentMinute);
    return { loc: ls.location, status };
  });

  const onlineCount = statuses.filter(s => s.status === 'online').length;
  const allOnline = onlineCount === statuses.length;
  const noneOnline = onlineCount === 0;

  return (
    <div className={cn(
      "rounded-xl p-3 space-y-2 transition-colors duration-500",
      allOnline ? (isLight ? "bg-emerald-50 border border-emerald-200" : "bg-emerald-500/10 border border-emerald-500/20") :
      noneOnline ? (isLight ? "bg-rose-50 border border-rose-200" : "bg-rose-500/10 border border-rose-500/20") :
      (isLight ? "bg-amber-50 border border-amber-200" : "bg-amber-500/10 border border-amber-500/20")
    )}>
      <div className={cn("text-xs font-bold", 
        allOnline ? (isLight ? "text-emerald-700" : "text-emerald-400") :
        noneOnline ? (isLight ? "text-rose-700" : "text-rose-400") :
        (isLight ? "text-amber-700" : "text-amber-400")
      )}>
        {allOnline ? '⚡ Зараз всюди є світло' : noneOnline ? '🔌 Зараз ніде немає світла' : `⚡ Світло є у ${onlineCount} з ${statuses.length}`}
      </div>
      <div className="flex flex-wrap gap-2">
        {statuses.map(({ loc, status }) => {
          const emoji = getLocationEmoji(loc.name);
          return (
            <div key={loc.id} className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold",
              status === 'online' ? (isLight ? "bg-emerald-100 text-emerald-700" : "bg-emerald-500/20 text-emerald-400") :
              status === 'possible' ? (isLight ? "bg-amber-100 text-amber-700" : "bg-amber-500/20 text-amber-400") :
              (isLight ? "bg-rose-100 text-rose-700" : "bg-rose-500/20 text-rose-400")
            )}>
              <span>{emoji}</span>
              <span>{loc.name}</span>
              {status === 'online' ? <Zap className="w-2.5 h-2.5" /> : <ZapOff className="w-2.5 h-2.5" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PracticalInsights({ schedules, dayIndex, isToday, isLight }: {
  schedules: LocationSchedule[];
  dayIndex: number;
  isToday: boolean;
  isLight: boolean;
}) {
  const validSchedules = schedules.filter(s => s.schedule && s.schedule.days[dayIndex]?.slots.length > 0);
  if (validSchedules.length < 2) return null;

  const now = new Date();
  const kyivTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const currentMinute = isToday ? kyivTime.getHours() * 60 + kyivTime.getMinutes() : 0;

  const { allOnlineWindows, totalAllOnline, totalAnyOnline, longestAllOnline } = useMemo(() => {
    const resolution = 30;
    const allWindows: { start: number; end: number }[] = [];
    let totalAll = 0;
    let totalAny = 0;

    for (let minute = 0; minute < 24 * 60; minute += resolution) {
      let onlineCount = 0;
      for (const ls of validSchedules) {
        const slots = ls.schedule!.days[dayIndex].slots;
        if (getStatusAtMinute(slots, minute) === 'online') onlineCount++;
      }
      if (onlineCount === validSchedules.length) {
        totalAll += resolution;
        if (allWindows.length > 0 && allWindows[allWindows.length - 1].end === minute) {
          allWindows[allWindows.length - 1].end = minute + resolution;
        } else {
          allWindows.push({ start: minute, end: minute + resolution });
        }
      }
      if (onlineCount > 0) totalAny += resolution;
    }

    const futureWindows = isToday ? allWindows.filter(w => w.end > currentMinute) : allWindows;
    const longest = futureWindows.reduce((max, w) => Math.max(max, w.end - w.start), 0);

    return {
      allOnlineWindows: futureWindows,
      totalAllOnline: isToday ? futureWindows.reduce((sum, w) => sum + Math.max(0, w.end - Math.max(w.start, currentMinute)), 0) : totalAll,
      totalAnyOnline: totalAny,
      longestAllOnline: longest,
    };
  }, [validSchedules, dayIndex, isToday, currentMinute]);

  const fmt = (m: number) => {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  const fmtDuration = (m: number) => {
    const h = Math.floor(m / 60);
    const min = m % 60;
    if (h > 0 && min > 0) return `${h} год ${min} хв`;
    if (h > 0) return `${h} год`;
    return `${min} хв`;
  };

  const nextAllOnline = isToday ? allOnlineWindows.find(w => w.start > currentMinute) : allOnlineWindows[0];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className={cn("rounded-xl p-2.5 text-center", isLight ? "bg-emerald-50 border border-emerald-100" : "bg-emerald-500/10 border border-emerald-500/10")}>
          <div className={cn("text-base font-black", isLight ? "text-emerald-700" : "text-emerald-400")} data-testid="text-all-online-time">
            {fmtDuration(totalAllOnline)}
          </div>
          <div className={cn("text-[9px] font-bold uppercase tracking-wider mt-0.5", isLight ? "text-emerald-600" : "text-emerald-500")}>
            {isToday ? 'Ще всюди є' : 'Всюди є'}
          </div>
        </div>
        <div className={cn("rounded-xl p-2.5 text-center", isLight ? "bg-blue-50 border border-blue-100" : "bg-blue-500/10 border border-blue-500/10")}>
          <div className={cn("text-base font-black", isLight ? "text-blue-700" : "text-blue-400")} data-testid="text-longest-window">
            {longestAllOnline > 0 ? fmtDuration(longestAllOnline) : '—'}
          </div>
          <div className={cn("text-[9px] font-bold uppercase tracking-wider mt-0.5", isLight ? "text-blue-600" : "text-blue-500")}>
            Макс. вікно
          </div>
        </div>
      </div>

      {allOnlineWindows.length > 0 && (
        <div className="space-y-1.5">
          <div className={cn("text-[9px] font-bold uppercase tracking-wider", isLight ? "text-zinc-400" : "text-zinc-500")}>
            {isToday ? 'Коли ще буде всюди:' : 'Коли всюди є:'}
          </div>
          <div className="flex flex-wrap gap-1">
            {allOnlineWindows.map((w, idx) => {
              const isNow = isToday && currentMinute >= w.start && currentMinute < w.end;
              return (
                <span
                  key={idx}
                  className={cn(
                    "text-[10px] font-mono font-bold px-2 py-0.5 rounded-md",
                    isNow ? (isLight ? "bg-emerald-200 text-emerald-800 ring-1 ring-emerald-400" : "bg-emerald-500/30 text-emerald-300 ring-1 ring-emerald-500/40") :
                    (isLight ? "bg-emerald-100 text-emerald-700" : "bg-emerald-500/15 text-emerald-400")
                  )}
                  data-testid={`window-slot-${idx}`}
                >
                  {isNow && '● '}{fmt(w.start)}–{fmt(w.end)}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {nextAllOnline && isToday && currentMinute < nextAllOnline.start && (
        <div className={cn(
          "rounded-lg px-3 py-2 text-[11px]",
          isLight ? "bg-blue-50 text-blue-700 border border-blue-100" : "bg-blue-500/10 text-blue-300 border border-blue-500/10"
        )}>
          💡 Найближче вікно «всюди є» — о <b>{fmt(nextAllOnline.start)}</b> (через {fmtDuration(nextAllOnline.start - currentMinute)})
        </div>
      )}

      {allOnlineWindows.length === 0 && (
        <div className={cn("text-[11px] text-center py-2", isLight ? "text-zinc-400" : "text-zinc-500")}>
          {isToday ? 'Сьогодні більше не буде моменту, коли всюди є світло' : 'Немає часу, коли всюди є світло'}
        </div>
      )}
    </div>
  );
}

export function CompareSheet({ open, onOpenChange, locations }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locations: LocationData[];
}) {
  const { isLight } = useTheme();
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allSchedules, setAllSchedules] = useState<LocationSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [dayTab, setDayTab] = useState<'today' | 'tomorrow'>('today');
  const [sharing, setSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [ttlDays, setTtlDays] = useState(7);
  const fetchedRef = useRef(false);

  const locIdsKey = locations.map(l => l.id).sort().join(',');

  useEffect(() => {
    if (open && locations.length >= 2) {
      if (!fetchedRef.current) {
        fetchedRef.current = true;
        setSelected(new Set(locations.map(l => l.id)));
        (async () => {
          setLoading(true);
          const locSchedules: LocationSchedule[] = locations.map(loc => ({
            location: loc, schedule: null, loading: true, error: false,
          }));
          setAllSchedules([...locSchedules]);
          const results = await Promise.allSettled(
            locations.map(loc => fetchSchedule(loc.queueId, loc.city))
          );
          setAllSchedules(locSchedules.map((ls, idx) => ({
            ...ls,
            schedule: results[idx].status === 'fulfilled' ? results[idx].value : null,
            loading: false,
            error: results[idx].status === 'rejected',
          })));
          setLoading(false);
        })();
      }
    }
    if (!open) {
      fetchedRef.current = false;
    }
  }, [open, locIdsKey]);

  const schedules = useMemo(() =>
    allSchedules.filter(s => selected.has(s.location.id)),
    [allSchedules, selected]
  );

  const toggleLocation = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleShare = async () => {
    if (sharing || schedules.length < 2) return;
    setSharing(true);
    try {
      const selectedLocs = schedules.map(s => ({
        name: s.location.name,
        city: s.location.city,
        queueId: s.location.queueId,
        street: s.location.street,
        houseNumber: s.location.houseNumber,
      }));
      const res = await fetch('/api/compare/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: selectedLocs, ttlDays }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      const fullUrl = `${window.location.origin}${data.url}`;
      const shareText = `Порівняння графіків — Світло Україна`;
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Порівняння графіків', text: shareText, url: fullUrl });
          return;
        } catch (e: any) {
          if (e?.name === 'AbortError') return;
        }
      }
      const tgWebApp = (window as any).Telegram?.WebApp;
      if (tgWebApp) {
        tgWebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(fullUrl)}&text=${encodeURIComponent(shareText)}`);
        return;
      }
      try {
        await navigator.clipboard.writeText(fullUrl);
        setShareCopied(true);
        toast({ title: 'Посилання скопійовано', description: 'Поділіться ним з друзями' });
        setTimeout(() => setShareCopied(false), 2000);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = fullUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
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

  const hasTomorrow = schedules.some(s => s.schedule && s.schedule.days.length > 1 && s.schedule.days[1]?.slots.length > 0);
  const dayIndex = dayTab === 'today' ? 0 : 1;
  const isToday = dayTab === 'today';
  const validCount = schedules.filter(s => s.schedule && !s.loading).length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn(
          "rounded-t-3xl max-h-[85vh] overflow-hidden flex flex-col border-t",
          isLight ? "bg-zinc-50 border-zinc-200" : "bg-zinc-950 border-white/10"
        )}
      >
        <div className="w-10 h-1 rounded-full bg-zinc-400/40 mx-auto mb-2 mt-1 shrink-0" />

        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle className={cn("text-base font-bold text-center", isLight ? "text-zinc-900" : "text-white")}>
            Порівняння графіків
          </SheetTitle>
          <SheetDescription className={cn("text-xs text-center", isLight ? "text-zinc-500" : "text-zinc-400")}>
            Оберіть локації для порівняння
          </SheetDescription>
        </SheetHeader>

        {locations.length >= 2 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-2 shrink-0">
            {locations.map(loc => {
              const isChecked = selected.has(loc.id);
              const emoji = getLocationEmoji(loc.name);
              return (
                <button
                  key={loc.id}
                  onClick={() => toggleLocation(loc.id)}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all duration-200",
                    isChecked
                      ? (isLight ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-900 border-white")
                      : (isLight ? "bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400" : "bg-zinc-800 text-zinc-400 border-white/10 hover:border-white/30")
                  )}
                  data-testid={`compare-toggle-${loc.id}`}
                >
                  <span>{emoji}</span>
                  <span>{loc.name}</span>
                  {isChecked && <Check className="w-3 h-3" />}
                </button>
              );
            })}
          </div>
        )}

        {schedules.length >= 2 && (
          <div className="flex gap-1.5 px-1 pb-2 shrink-0">
            <button
              onClick={() => setDayTab('today')}
              className={cn(
                "flex-1 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all duration-300",
                dayTab === 'today'
                  ? (isLight ? "bg-white text-zinc-900 shadow-sm border border-zinc-200" : "bg-white/10 text-white border border-white/10")
                  : (isLight ? "text-zinc-400 hover:text-zinc-600" : "text-zinc-600 hover:text-zinc-400")
              )}
              data-testid="compare-tab-today"
            >
              Сьогодні
            </button>
            {hasTomorrow && (
              <button
                onClick={() => setDayTab('tomorrow')}
                className={cn(
                  "flex-1 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all duration-300",
                  dayTab === 'tomorrow'
                    ? (isLight ? "bg-white text-zinc-900 shadow-sm border border-zinc-200" : "bg-white/10 text-white border border-white/10")
                    : (isLight ? "text-zinc-400 hover:text-zinc-600" : "text-zinc-600 hover:text-zinc-400")
                )}
                data-testid="compare-tab-tomorrow"
              >
                Завтра
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-1 pb-4 space-y-3">
          {schedules.length < 2 ? (
            <div className={cn("text-center py-8 space-y-2", isLight ? "text-zinc-400" : "text-zinc-500")}>
              <p className="text-sm">{selected.size === 0 ? 'Оберіть локації для порівняння' : selected.size === 1 ? 'Оберіть ще хоча б одну локацію' : 'Оберіть мінімум 2 локації'}</p>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className={cn("w-5 h-5 animate-spin", isLight ? "text-zinc-400" : "text-zinc-600")} />
            </div>
          ) : (
            <>
              {isToday && <CurrentStatusSummary schedules={schedules} isLight={isLight} />}

              <div className={cn(
                "rounded-xl border p-3 space-y-3 transition-colors duration-500",
                isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/30 border-white/5"
              )}>
                <div className={cn(
                  "flex justify-between text-[9px] font-black font-mono uppercase tracking-wider",
                  isLight ? "text-zinc-400" : "text-zinc-500"
                )}>
                  <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>00:00</span>
                </div>

                {schedules.map((ls) => {
                  const emoji = getLocationEmoji(ls.location.name);
                  const slots = ls.schedule?.days[dayIndex]?.slots || [];
                  return (
                    <div key={ls.location.id} className="space-y-1" data-testid={`compare-loc-${ls.location.id}`}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm">{emoji}</span>
                        <span className={cn("text-xs font-bold truncate", isLight ? "text-zinc-700" : "text-zinc-300")}>
                          {ls.location.name}
                        </span>
                        <span className={cn("text-[10px]", isLight ? "text-zinc-400" : "text-zinc-500")}>
                          {ls.location.queueId}
                        </span>
                      </div>
                      {ls.loading ? (
                        <div className={cn("h-10 rounded-lg animate-pulse", isLight ? "bg-zinc-100" : "bg-zinc-800/50")} />
                      ) : slots.length > 0 ? (
                        <>
                          <CompactTimeline slots={slots} isToday={isToday} isLight={isLight} />
                          <ScheduleBlocks slots={slots} isLight={isLight} />
                        </>
                      ) : (
                        <div className={cn("h-10 rounded-lg flex items-center justify-center text-[11px]", isLight ? "bg-zinc-50 text-zinc-400" : "bg-zinc-900/30 text-zinc-500")}>
                          Немає даних
                        </div>
                      )}
                    </div>
                  );
                })}

                <CombinedTimeline schedules={schedules} dayIndex={dayIndex} isToday={isToday} isLight={isLight} />

                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1">
                  <div className="flex items-center gap-1.5">
                    <div className={cn("w-3 h-3 rounded", isLight ? "bg-emerald-300" : "bg-emerald-500/30")} />
                    <span className={cn("text-[10px] font-medium", isLight ? "text-zinc-500" : "text-zinc-400")}>Всюди</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className={cn("w-3 h-3 rounded", isLight ? "bg-amber-200" : "bg-amber-500/25")} />
                    <span className={cn("text-[10px] font-medium", isLight ? "text-zinc-500" : "text-zinc-400")}>Частково</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className={cn("w-3 h-3 rounded", isLight ? "bg-rose-200" : "bg-rose-500/40")} />
                    <span className={cn("text-[10px] font-medium", isLight ? "text-zinc-500" : "text-zinc-400")}>Ніде</span>
                  </div>
                  {isToday && (
                    <div className="flex items-center gap-1.5">
                      <div className={cn("w-0.5 h-3 rounded-full", isLight ? "bg-zinc-800" : "bg-white")} />
                      <span className={cn("text-[10px] font-medium", isLight ? "text-zinc-500" : "text-zinc-400")}>Зараз</span>
                    </div>
                  )}
                </div>
              </div>

              <PracticalInsights schedules={schedules} dayIndex={dayIndex} isToday={isToday} isLight={isLight} />

              {validCount >= 2 && (
                <div className={cn(
                  "rounded-xl border p-3 space-y-2 transition-colors duration-500",
                  isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/30 border-white/5"
                )}>
                  <div className="flex items-center justify-between">
                    <span className={cn("text-[10px] font-bold", isLight ? "text-zinc-500" : "text-zinc-400")}>
                      Посилання дійсне:
                    </span>
                    <div className="flex gap-1">
                      {[1, 3, 7, 14, 30].map(d => (
                        <button
                          key={d}
                          onClick={() => setTtlDays(d)}
                          className={cn(
                            "px-2 py-0.5 rounded-md text-[9px] font-bold transition-all duration-200",
                            ttlDays === d
                              ? (isLight ? "bg-zinc-900 text-white" : "bg-white text-zinc-900")
                              : (isLight ? "bg-zinc-100 text-zinc-500 hover:bg-zinc-200" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700")
                          )}
                          data-testid={`ttl-${d}`}
                        >
                          {d === 1 ? '1д' : d === 3 ? '3д' : d === 7 ? '7д' : d === 14 ? '2т' : '30д'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={handleShare}
                    disabled={sharing}
                    className={cn(
                      "w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold border transition-all duration-200 active:scale-95",
                      shareCopied
                        ? (isLight ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20")
                        : (isLight ? "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50 shadow-sm" : "bg-zinc-800 text-zinc-300 border-white/10 hover:bg-zinc-700")
                    )}
                    data-testid="button-share-compare"
                  >
                    {sharing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : shareCopied ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
                    {shareCopied ? 'Скопійовано' : 'Поділитися порівнянням'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
