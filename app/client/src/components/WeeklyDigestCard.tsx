import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';
import { BarChart3, TrendingDown, TrendingUp, Minus, Clock, Award, MapPin, ChevronDown, ChevronUp } from 'lucide-react';

interface DigestData {
  digest: {
    id: number;
    weekStart: string;
    city: string;
    queueId: string;
    hoursWithoutPower: number;
    deltaHours: number | null;
    totalReports: number;
    longestOutageMinutes: number | null;
    bestDay: string | null;
    queueAccuracyPct: number | null;
    queueTotalReports: number;
    locationDigests: Array<{
      locationId: number;
      name: string;
      city: string;
      queueId: string;
      hoursWithoutPower: number;
      totalReports: number;
    }>;
  };
  userStatus: { level: string; emoji: string };
  totalPoints: number;
}

export function WeeklyDigestCard() {
  const { isLight } = useTheme();
  const [data, setData] = useState<DigestData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const fetchDigest = useCallback(async () => {
    try {
      const resp = await fetch('/api/user/digest');
      if (resp.ok) {
        const result = await resp.json();
        setData(result);
      }
    } catch {}
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchDigest();
  }, [fetchDigest]);

  if (isLoading || !data) return null;

  const { digest } = data;
  const weekDate = new Date(digest.weekStart);
  const weekLabel = `${weekDate.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })} — ${new Date(weekDate.getTime() + 6 * 86400000).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })}`;

  const deltaIcon = digest.deltaHours === null || digest.deltaHours === 0
    ? <Minus className="w-3 h-3" />
    : digest.deltaHours < 0
    ? <TrendingDown className="w-3 h-3" />
    : <TrendingUp className="w-3 h-3" />;

  const deltaColor = digest.deltaHours === null || digest.deltaHours === 0
    ? 'text-zinc-400'
    : digest.deltaHours < 0
    ? (isLight ? 'text-emerald-600' : 'text-emerald-400')
    : (isLight ? 'text-red-600' : 'text-red-400');

  const deltaText = digest.deltaHours === null
    ? ''
    : digest.deltaHours === 0
    ? 'без змін'
    : digest.deltaHours > 0
    ? `+${digest.deltaHours} год`
    : `${digest.deltaHours} год`;

  return (
    <div className={cn(
      "rounded-[28px] overflow-hidden transition-all duration-300 border",
      isLight
        ? "bg-white border-zinc-200 shadow-sm"
        : "bg-zinc-900/30 border-white/5"
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-5 text-left"
        data-testid="btn-toggle-digest"
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className={cn("text-xs font-bold uppercase tracking-widest", isLight ? "text-zinc-500" : "text-zinc-500")}>
            <BarChart3 className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
            Тижневий дайджест
          </h3>
          <span className={cn("text-[10px] font-medium", isLight ? "text-zinc-400" : "text-zinc-600")}>
            {weekLabel}
            {expanded ? <ChevronUp className="w-3 h-3 inline ml-1" /> : <ChevronDown className="w-3 h-3 inline ml-1" />}
          </span>
        </div>

        <div className="flex items-end gap-3">
          <div>
            <span className={cn("text-3xl font-black tabular-nums", isLight ? "text-zinc-900" : "text-white")}>
              {digest.hoursWithoutPower}
            </span>
            <span className={cn("text-sm ml-1", isLight ? "text-zinc-400" : "text-zinc-500")}>год без світла</span>
          </div>
          {deltaText && (
            <div className={cn("flex items-center gap-0.5 text-xs font-semibold mb-1", deltaColor)}>
              {deltaIcon}
              {deltaText}
            </div>
          )}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5 space-y-3">
              <div className={cn("grid grid-cols-2 gap-2")}>
                <div className={cn("p-3 rounded-xl", isLight ? "bg-zinc-50" : "bg-white/5")}>
                  <div className={cn("text-[10px] font-medium mb-1", isLight ? "text-zinc-400" : "text-zinc-500")}>
                    <Clock className="w-3 h-3 inline mr-1 -mt-0.5" />
                    Найдовше відключення
                  </div>
                  <div className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-white")}>
                    {digest.longestOutageMinutes ? `${Math.floor(digest.longestOutageMinutes / 60)} год ${digest.longestOutageMinutes % 60} хв` : '—'}
                  </div>
                </div>
                <div className={cn("p-3 rounded-xl", isLight ? "bg-zinc-50" : "bg-white/5")}>
                  <div className={cn("text-[10px] font-medium mb-1", isLight ? "text-zinc-400" : "text-zinc-500")}>
                    Найкращий день
                  </div>
                  <div className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-white")}>
                    {digest.bestDay || '—'}
                  </div>
                </div>
                <div className={cn("p-3 rounded-xl", isLight ? "bg-zinc-50" : "bg-white/5")}>
                  <div className={cn("text-[10px] font-medium mb-1", isLight ? "text-zinc-400" : "text-zinc-500")}>
                    <Award className="w-3 h-3 inline mr-1 -mt-0.5" />
                    Ваші звіти
                  </div>
                  <div className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-white")}>
                    {digest.totalReports}
                  </div>
                </div>
                <div className={cn("p-3 rounded-xl", isLight ? "bg-zinc-50" : "bg-white/5")}>
                  <div className={cn("text-[10px] font-medium mb-1", isLight ? "text-zinc-400" : "text-zinc-500")}>
                    Точність графіку
                  </div>
                  <div className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-white")}>
                    {digest.queueAccuracyPct ? `${digest.queueAccuracyPct}%` : '—'}
                    {digest.queueTotalReports > 0 && (
                      <span className={cn("text-[10px] font-normal ml-1", isLight ? "text-zinc-400" : "text-zinc-500")}>
                        ({digest.queueTotalReports} звітів)
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {digest.locationDigests && digest.locationDigests.length > 0 && (
                <div className="space-y-1.5">
                  <p className={cn("text-[10px] font-bold uppercase tracking-widest", isLight ? "text-zinc-400" : "text-zinc-600")}>
                    <MapPin className="w-3 h-3 inline mr-1 -mt-0.5" />
                    По локаціях
                  </p>
                  {digest.locationDigests.map((loc, i) => (
                    <div key={i} className={cn("flex items-center justify-between p-2.5 rounded-xl text-xs",
                      isLight ? "bg-zinc-50" : "bg-white/5"
                    )}>
                      <span className={cn("font-semibold", isLight ? "text-zinc-700" : "text-zinc-300")}>
                        {loc.name}
                      </span>
                      <span className={cn("tabular-nums", isLight ? "text-zinc-500" : "text-zinc-400")}>
                        {loc.hoursWithoutPower} год
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-center gap-1.5 pt-1">
                <span className={cn("text-[10px]", isLight ? "text-zinc-400" : "text-zinc-600")}>
                  {data.userStatus.emoji} {data.userStatus.level} • {data.totalPoints} балів
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
