import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';
import { MapPin, Zap, ZapOff, Star, HelpCircle } from 'lucide-react';

interface LocationWithStatus {
  id: number;
  name: string;
  city: string;
  queueId: string;
  isPrimary: boolean;
  status?: {
    status: 'has_power' | 'no_power' | 'mixed' | 'unknown';
    confidence: number;
    totalReports: number;
  };
}

export function MultiLocationStatus() {
  const { isLight } = useTheme();
  const [locations, setLocations] = useState<LocationWithStatus[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const resp = await fetch('/api/user/locations');
      if (!resp.ok) return;
      const locs = await resp.json();
      if (!locs || locs.length === 0) return;

      const withStatus = await Promise.all(
        locs.map(async (loc: any) => {
          if (!loc.queueId) return { ...loc, status: null };
          try {
            const sr = await fetch(`/api/reports/queue-status?city=${encodeURIComponent(loc.city)}&queueId=${encodeURIComponent(loc.queueId)}`);
            if (sr.ok) {
              const status = await sr.json();
              return { ...loc, status };
            }
          } catch {}
          return { ...loc, status: null };
        })
      );

      setLocations(withStatus.filter((l: any) => !l.isPrimary));
    } catch {}
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 120000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (locations.length === 0) return null;

  return (
    <div className={cn(
      "rounded-[28px] overflow-hidden transition-all duration-300 border",
      isLight
        ? "bg-white border-zinc-200 shadow-sm"
        : "bg-zinc-900/30 border-white/5"
    )}>
      <div className="p-5">
        <h3 className={cn("text-xs font-bold uppercase tracking-widest mb-3", isLight ? "text-zinc-500" : "text-zinc-500")}>
          <MapPin className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" style={{ color: 'var(--accent-hex, #10b981)' }} />
          Інші локації
        </h3>
        <div className="space-y-1.5">
          {locations.map((loc) => {
            const st = loc.status;
            const statusIcon = st?.status === 'has_power'
              ? <Zap className="w-3.5 h-3.5 text-emerald-500" />
              : st?.status === 'no_power'
              ? <ZapOff className="w-3.5 h-3.5 text-red-500" />
              : <HelpCircle className="w-3.5 h-3.5 text-zinc-400" />;

            const statusText = st?.status === 'has_power'
              ? 'Є світло'
              : st?.status === 'no_power'
              ? 'Немає'
              : st?.totalReports ? 'Неоднозначно' : '—';

            return (
              <div
                key={loc.id}
                className={cn(
                  "flex items-center gap-3 p-2.5 rounded-xl transition-all",
                  isLight ? "bg-zinc-50 hover:bg-zinc-100" : "bg-white/[0.03] hover:bg-white/[0.05]"
                )}
                data-testid={`multi-loc-${loc.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className={cn("text-xs font-bold truncate", isLight ? "text-zinc-700" : "text-zinc-300")}>
                    {loc.name}
                  </div>
                  <div className={cn("text-[10px]", isLight ? "text-zinc-400" : "text-zinc-600")}>
                    {loc.city} • {loc.queueId}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {statusIcon}
                  <span className={cn("text-xs font-medium",
                    st?.status === 'has_power' ? (isLight ? "text-emerald-600" : "text-emerald-400") :
                    st?.status === 'no_power' ? (isLight ? "text-red-600" : "text-red-400") :
                    (isLight ? "text-zinc-400" : "text-zinc-500")
                  )}>
                    {statusText}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
