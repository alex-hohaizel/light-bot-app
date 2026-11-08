import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'wouter';
import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks/useTheme';
import { fetchSchedule } from '@/lib/schedule-service';
import { ScheduleData, OutageSlot } from '@/lib/store';
import { RefreshCw, Zap, ZapOff } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';

interface SharedLocation {
  name: string;
  city: string;
  queueId: string;
  street?: string;
  houseNumber?: string;
}

interface LocationSchedule {
  location: SharedLocation;
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

const TD = 'duration-500';

function CompactTimeline({ slots, isToday, isLight, height = 44 }: { slots: OutageSlot[]; isToday: boolean; isLight: boolean; height?: number }) {
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
      };
    });
  }, [slots]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div className={cn(
        "relative w-full rounded-lg overflow-hidden border transition-all", TD,
        isLight ? "bg-zinc-100 border-zinc-200" : "bg-black/40 border-white/5"
      )} style={{ height }}>
        {segments.map((segment, idx) => (
          <div
            key={idx}
            className={cn(
              "absolute top-0 flex items-center justify-center transition-colors overflow-hidden", TD,
              segment.status === 'online' && (isLight ? "bg-emerald-200/80" : "bg-emerald-500/25"),
              segment.status === 'offline' && (isLight ? "bg-rose-200/80" : "bg-rose-500/40"),
              segment.status === 'possible' && (isLight ? "bg-amber-200/80" : "bg-amber-500/30")
            )}
            style={{ left: `${segment.left}%`, width: `${segment.width}%`, height: '100%' }}
          >
            {segment.width >= 5.5 && (
              <span className={cn(
                "font-mono font-bold leading-none whitespace-nowrap",
                segment.width >= 10 ? "text-[11px]" : "text-[9px]",
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
    <div className={cn("text-xs font-medium py-0.5", isLight ? "text-emerald-600" : "text-emerald-400")}>
      ✅ Відключень немає
    </div>
  );

  return (
    <div className="flex flex-wrap gap-1.5">
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
            "inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold",
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
        if (getStatusAtMinute(ls.schedule!.days[dayIndex].slots, minute) === 'online') onlineCount++;
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
          "relative w-full rounded-lg overflow-hidden border transition-all", TD,
          isLight ? "bg-zinc-100 border-zinc-300" : "bg-black/40 border-white/10"
        )} style={{ height: 36 }}>
          {segments.map((seg, idx) => (
            <div
              key={idx}
              className={cn(
                "absolute top-0 transition-colors", TD,
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

  const statuses = validSchedules.map(ls => ({
    loc: ls.location,
    status: getStatusAtMinute(ls.schedule!.days[0].slots, currentMinute),
  }));

  const onlineCount = statuses.filter(s => s.status === 'online').length;
  const allOnline = onlineCount === statuses.length;
  const noneOnline = onlineCount === 0;

  return (
    <div className={cn(
      "rounded-xl border p-4 space-y-3 transition-colors", TD,
      allOnline ? (isLight ? "bg-emerald-50 border-emerald-200" : "bg-emerald-500/10 border-emerald-500/20") :
      noneOnline ? (isLight ? "bg-rose-50 border-rose-200" : "bg-rose-500/10 border-rose-500/20") :
      (isLight ? "bg-amber-50 border-amber-200" : "bg-amber-500/10 border-amber-500/20")
    )}>
      <div className={cn("text-sm font-bold",
        allOnline ? (isLight ? "text-emerald-700" : "text-emerald-400") :
        noneOnline ? (isLight ? "text-rose-700" : "text-rose-400") :
        (isLight ? "text-amber-700" : "text-amber-400")
      )}>
        {allOnline ? '⚡ Зараз всюди є світло' : noneOnline ? '🔌 Зараз ніде немає світла' : `⚡ Світло є у ${onlineCount} з ${statuses.length}`}
      </div>
      <div className="flex flex-wrap gap-2">
        {statuses.map(({ loc, status }, idx) => {
          const emoji = getLocationEmoji(loc.name);
          return (
            <div key={idx} className={cn(
              "flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold",
              status === 'online' ? (isLight ? "bg-emerald-100 text-emerald-700" : "bg-emerald-500/20 text-emerald-400") :
              status === 'possible' ? (isLight ? "bg-amber-100 text-amber-700" : "bg-amber-500/20 text-amber-400") :
              (isLight ? "bg-rose-100 text-rose-700" : "bg-rose-500/20 text-rose-400")
            )}>
              <span>{emoji}</span>
              <span>{loc.name}</span>
              {status === 'online' ? <Zap className="w-3 h-3" /> : <ZapOff className="w-3 h-3" />}
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

  const { allOnlineWindows, totalAllOnline, longestAllOnline } = useMemo(() => {
    const resolution = 30;
    const allWindows: { start: number; end: number }[] = [];
    for (let minute = 0; minute < 24 * 60; minute += resolution) {
      let onlineCount = 0;
      for (const ls of validSchedules) {
        if (getStatusAtMinute(ls.schedule!.days[dayIndex].slots, minute) === 'online') onlineCount++;
      }
      if (onlineCount === validSchedules.length) {
        if (allWindows.length > 0 && allWindows[allWindows.length - 1].end === minute) {
          allWindows[allWindows.length - 1].end = minute + resolution;
        } else {
          allWindows.push({ start: minute, end: minute + resolution });
        }
      }
    }
    const futureWindows = isToday ? allWindows.filter(w => w.end > currentMinute) : allWindows;
    const total = isToday ? futureWindows.reduce((sum, w) => sum + Math.max(0, w.end - Math.max(w.start, currentMinute)), 0) : futureWindows.reduce((s, w) => s + w.end - w.start, 0);
    const longest = futureWindows.reduce((max, w) => Math.max(max, w.end - w.start), 0);
    return { allOnlineWindows: futureWindows, totalAllOnline: total, longestAllOnline: longest };
  }, [validSchedules, dayIndex, isToday, currentMinute]);

  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const fmtDuration = (m: number) => {
    const h = Math.floor(m / 60); const min = m % 60;
    if (h > 0 && min > 0) return `${h} год ${min} хв`;
    if (h > 0) return `${h} год`;
    return `${min} хв`;
  };

  const nextAllOnline = isToday ? allOnlineWindows.find(w => w.start > currentMinute) : allOnlineWindows[0];

  return (
    <div className={cn("rounded-xl border p-4 space-y-3 transition-colors", TD, isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/30 border-white/5")}>
      <div className="grid grid-cols-2 gap-3">
        <div className={cn("rounded-xl p-3 text-center", isLight ? "bg-emerald-50 border border-emerald-100" : "bg-emerald-500/10 border border-emerald-500/10")}>
          <div className={cn("text-lg font-black", isLight ? "text-emerald-700" : "text-emerald-400")}>
            {fmtDuration(totalAllOnline)}
          </div>
          <div className={cn("text-[10px] font-bold uppercase tracking-wider mt-0.5", isLight ? "text-emerald-600" : "text-emerald-500")}>
            {isToday ? 'Ще всюди є' : 'Всюди є'}
          </div>
        </div>
        <div className={cn("rounded-xl p-3 text-center", isLight ? "bg-blue-50 border border-blue-100" : "bg-blue-500/10 border border-blue-500/10")}>
          <div className={cn("text-lg font-black", isLight ? "text-blue-700" : "text-blue-400")}>
            {longestAllOnline > 0 ? fmtDuration(longestAllOnline) : '—'}
          </div>
          <div className={cn("text-[10px] font-bold uppercase tracking-wider mt-0.5", isLight ? "text-blue-600" : "text-blue-500")}>
            Макс. вікно
          </div>
        </div>
      </div>
      {allOnlineWindows.length > 0 && (
        <div className="space-y-1.5">
          <div className={cn("text-[11px] font-bold uppercase tracking-wider", isLight ? "text-zinc-400" : "text-zinc-500")}>
            {isToday ? 'Коли ще буде всюди:' : 'Коли всюди є:'}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {allOnlineWindows.map((w, idx) => {
              const isNow = isToday && currentMinute >= w.start && currentMinute < w.end;
              return (
                <span key={idx} className={cn(
                  "text-xs font-mono font-bold px-2.5 py-1 rounded-lg",
                  isNow ? (isLight ? "bg-emerald-200 text-emerald-800 ring-1 ring-emerald-400" : "bg-emerald-500/30 text-emerald-300 ring-1 ring-emerald-500/40")
                    : (isLight ? "bg-emerald-100 text-emerald-700" : "bg-emerald-500/15 text-emerald-400")
                )}>
                  {isNow && '● '}{fmt(w.start)}–{fmt(w.end)}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {nextAllOnline && isToday && currentMinute < nextAllOnline.start && (
        <div className={cn("rounded-lg px-3 py-2 text-xs", isLight ? "bg-blue-50 text-blue-700 border border-blue-100" : "bg-blue-500/10 text-blue-300 border border-blue-500/10")}>
          💡 Найближче вікно «всюди є» — о <b>{fmt(nextAllOnline.start)}</b> (через {fmtDuration(nextAllOnline.start - currentMinute)})
        </div>
      )}
      {allOnlineWindows.length === 0 && (
        <div className={cn("text-xs text-center py-1", isLight ? "text-zinc-400" : "text-zinc-500")}>
          {isToday ? 'Сьогодні більше не буде моменту, коли всюди є світло' : 'Немає часу, коли всюди є світло'}
        </div>
      )}
    </div>
  );
}

export function ComparePage() {
  const params = useParams<{ shareId: string }>();
  const shareId = params.shareId;
  const { isLight } = useTheme();
  const [locations, setLocations] = useState<SharedLocation[]>([]);
  const [schedules, setSchedules] = useState<LocationSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<'expired' | 'not_found' | 'generic' | null>(null);
  const [dayTab, setDayTab] = useState<'today' | 'tomorrow'>('today');

  useEffect(() => {
    if (!shareId) return;
    (async () => {
      try {
        const res = await fetch(`/api/compare/data/${encodeURIComponent(shareId)}`);
        if (res.status === 410) { setError('Термін дії цього посилання закінчився'); setErrorType('expired'); setLoading(false); return; }
        if (res.status === 404) { setError('Посилання не знайдено'); setErrorType('not_found'); setLoading(false); return; }
        if (!res.ok) { setError('Посилання недійсне'); setErrorType('generic'); setLoading(false); return; }
        const data = await res.json();
        const locs: SharedLocation[] = data.locations;
        setLocations(locs);
        const locScheds: LocationSchedule[] = locs.map(l => ({ location: l, schedule: null, loading: true, error: false }));
        setSchedules([...locScheds]);
        const results = await Promise.allSettled(locs.map(l => fetchSchedule(l.queueId, l.city)));
        setSchedules(locScheds.map((ls, idx) => ({
          ...ls,
          schedule: results[idx].status === 'fulfilled' ? results[idx].value : null,
          loading: false,
          error: results[idx].status === 'rejected',
        })));
      } catch { setError('Помилка завантаження'); setErrorType('generic'); }
      setLoading(false);
    })();
  }, [shareId]);

  const hasTomorrow = schedules.some(s => s.schedule && s.schedule.days.length > 1 && s.schedule.days[1]?.slots.length > 0);
  const dayIndex = dayTab === 'today' ? 0 : 1;
  const isToday = dayTab === 'today';
  const validCount = schedules.filter(s => s.schedule && !s.loading).length;

  if (loading) {
    return (
      <div className={cn("min-h-screen flex items-center justify-center transition-colors", TD, isLight ? "bg-zinc-50" : "bg-zinc-950")}>
        <RefreshCw className={cn("w-6 h-6 animate-spin", isLight ? "text-zinc-400" : "text-zinc-600")} />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("min-h-screen flex items-center justify-center transition-colors", TD, isLight ? "bg-zinc-50" : "bg-zinc-950")}>
        <div className={cn("rounded-2xl border p-6 text-center space-y-3 max-w-sm mx-4 transition-colors", TD,
          isLight ? "bg-white border-zinc-200" : "bg-zinc-900/20 border-white/5"
        )}>
          <div className="text-4xl">{errorType === 'expired' ? '⏰' : errorType === 'not_found' ? '🔍' : '⚠️'}</div>
          <p className={cn("text-sm font-semibold", isLight ? "text-zinc-600" : "text-zinc-300")}>{error}</p>
          {errorType === 'expired' && (
            <p className={cn("text-xs", isLight ? "text-zinc-400" : "text-zinc-500")}>
              Спробуйте попросити нове посилання у того, хто вам його надіслав
            </p>
          )}
          <a href="/" className={cn("inline-block mt-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-colors",
            isLight ? "bg-zinc-900 text-white hover:bg-zinc-800" : "bg-white text-zinc-900 hover:bg-zinc-100"
          )} data-testid="link-home">На головну</a>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("min-h-screen transition-colors", TD, isLight ? "bg-zinc-50" : "bg-zinc-950")}>
      <div className="max-w-lg mx-auto px-4 py-6 space-y-4">
        <header className="flex items-center justify-between">
          <h1 className={cn("text-lg font-bold", isLight ? "text-zinc-900" : "text-white")} data-testid="text-compare-title">
            Порівняння графіків
          </h1>
          <ThemeToggle compact />
        </header>

        <div className="flex gap-2">
          <button
            onClick={() => setDayTab('today')}
            className={cn(
              "flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all duration-300",
              dayTab === 'today'
                ? (isLight ? "bg-white text-zinc-900 shadow-sm border border-zinc-200" : "bg-white/10 text-white border border-white/10")
                : (isLight ? "text-zinc-400 hover:text-zinc-600" : "text-zinc-600 hover:text-zinc-400")
            )}
            data-testid="tab-compare-today"
          >
            Сьогодні
          </button>
          {hasTomorrow && (
            <button
              onClick={() => setDayTab('tomorrow')}
              className={cn(
                "flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all duration-300",
                dayTab === 'tomorrow'
                  ? (isLight ? "bg-white text-zinc-900 shadow-sm border border-zinc-200" : "bg-white/10 text-white border border-white/10")
                  : (isLight ? "text-zinc-400 hover:text-zinc-600" : "text-zinc-600 hover:text-zinc-400")
              )}
              data-testid="tab-compare-tomorrow"
            >
              Завтра
            </button>
          )}
        </div>

        {isToday && <CurrentStatusSummary schedules={schedules} isLight={isLight} />}

        <div className={cn(
          "rounded-xl border p-4 space-y-4 transition-colors", TD,
          isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/30 border-white/5"
        )}>
          <div className={cn(
            "flex justify-between text-[10px] font-black font-mono uppercase tracking-wider",
            isLight ? "text-zinc-400" : "text-zinc-500"
          )}>
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>00:00</span>
          </div>

          {schedules.map((ls, idx) => {
            const emoji = getLocationEmoji(ls.location.name);
            const slots = ls.schedule?.days[dayIndex]?.slots || [];
            return (
              <div key={idx} className="space-y-1.5" data-testid={`compare-loc-${idx}`}>
                <div className="flex items-center gap-1.5">
                  <span className="text-base">{emoji}</span>
                  <span className={cn("text-sm font-bold truncate", isLight ? "text-zinc-700" : "text-zinc-300")}>
                    {ls.location.name}
                  </span>
                  <span className={cn("text-[11px]", isLight ? "text-zinc-400" : "text-zinc-500")}>
                    {ls.location.queueId}
                  </span>
                </div>
                {ls.loading ? (
                  <div className={cn("h-11 rounded-lg animate-pulse", isLight ? "bg-zinc-100" : "bg-zinc-800/50")} />
                ) : slots.length > 0 ? (
                  <>
                    <CompactTimeline slots={slots} isToday={isToday} isLight={isLight} />
                    <ScheduleBlocks slots={slots} isLight={isLight} />
                  </>
                ) : (
                  <div className={cn("h-11 rounded-lg flex items-center justify-center text-xs", isLight ? "bg-zinc-50 text-zinc-400" : "bg-zinc-900/30 text-zinc-500")}>
                    Немає даних
                  </div>
                )}
              </div>
            );
          })}

          <CombinedTimeline schedules={schedules} dayIndex={dayIndex} isToday={isToday} isLight={isLight} />

          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 pt-1">
            <div className="flex items-center gap-1.5">
              <div className={cn("w-3.5 h-3.5 rounded", isLight ? "bg-emerald-300" : "bg-emerald-500/30")} />
              <span className={cn("text-[11px] font-medium", isLight ? "text-zinc-500" : "text-zinc-400")}>Всюди</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className={cn("w-3.5 h-3.5 rounded", isLight ? "bg-amber-200" : "bg-amber-500/25")} />
              <span className={cn("text-[11px] font-medium", isLight ? "text-zinc-500" : "text-zinc-400")}>Частково</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className={cn("w-3.5 h-3.5 rounded", isLight ? "bg-rose-200" : "bg-rose-500/40")} />
              <span className={cn("text-[11px] font-medium", isLight ? "text-zinc-500" : "text-zinc-400")}>Ніде</span>
            </div>
            {isToday && (
              <div className="flex items-center gap-1.5">
                <div className={cn("w-0.5 h-3.5 rounded-full", isLight ? "bg-zinc-800" : "bg-white")} />
                <span className={cn("text-[11px] font-medium", isLight ? "text-zinc-500" : "text-zinc-400")}>Зараз</span>
              </div>
            )}
          </div>
        </div>

        {validCount >= 2 && <PracticalInsights schedules={schedules} dayIndex={dayIndex} isToday={isToday} isLight={isLight} />}

        <div className={cn("text-center text-xs pt-2 pb-4", isLight ? "text-zinc-400" : "text-zinc-500")}>
          <a href="/" className="underline hover:no-underline">Світло Україна</a> — графіки відключень
        </div>
      </div>
    </div>
  );
}
