import { useMemo } from 'react';
import { OutageSlot } from '@/lib/store';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { useStore } from '@/lib/store';
import { useTheme } from '@/hooks/useTheme';

interface TimelineProps {
  slots: OutageSlot[];
  isToday: boolean;
}

export function Timeline({ slots, isToday }: TimelineProps) {
  const { isLight } = useTheme();
  
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentTimePercent = (currentMinutes / (24 * 60)) * 100;

  const segments = useMemo(() => {
    return slots.map((slot, idx) => {
      const [startH, startM] = slot.start.split(':').map(Number);
      const [endH, endM] = slot.end.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      const duration = endMinutes - startMinutes;
      
      return {
        ...slot,
        left: (startMinutes / (24 * 60)) * 100,
        width: (duration / (24 * 60)) * 100,
      };
    });
  }, [slots]);

  return (
    <div className="w-full space-y-4 py-2" data-testid="timeline-container">
      <div className="relative">
        <div className={cn(
          "relative h-16 w-full rounded-2xl overflow-hidden flex border transition-all duration-500",
          isLight ? "bg-zinc-100 border-zinc-200 shadow-inner" : "bg-black/40 border-white/5 shadow-inner"
        )}>
          {[6, 12, 18].map(hour => (
            <div 
              key={hour}
              className={cn(
                "absolute top-0 bottom-0 w-px z-0",
                isLight ? "bg-zinc-400 opacity-30" : "bg-white opacity-20"
              )}
              style={{ left: `${(hour / 24) * 100}%` }}
            />
          ))}

          {segments.map((segment, idx) => (
            <motion.div
              key={idx}
              initial={{ opacity: 0, scaleY: 0.8 }}
              animate={{ opacity: 1, scaleY: 1 }}
              className={cn(
                "h-full relative flex items-center justify-center transition-colors duration-500",
                segment.status === 'online' && (isLight ? "bg-emerald-100" : "bg-emerald-500/10"),
                segment.status === 'offline' && (isLight ? "bg-rose-200" : "bg-rose-500/40"),
                segment.status === 'possible' && (isLight ? "bg-amber-100" : "bg-amber-500/30")
              )}
              style={{ 
                position: 'absolute',
                left: `${segment.left}%`,
                width: `${segment.width}%`
              }}
            >
              {segment.status === 'offline' && segment.width > 4 && (
                <div className={cn(
                  "w-1 h-1 rounded-full animate-pulse",
                  isLight ? "bg-rose-500" : "bg-rose-400"
                )} />
              )}
            </motion.div>
          ))}

          {isToday && (
            <motion.div 
              className={cn(
                "absolute top-0 bottom-0 w-0.5 z-20",
                isLight ? "bg-zinc-800 shadow-[0_0_10px_rgba(0,0,0,0.3)]" : "bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]"
              )}
              style={{ left: `${currentTimePercent}%` }}
            >
              <div className={cn(
                "absolute -top-1 -left-[3.5px] w-2 h-2 rounded-full",
                isLight ? "bg-zinc-800" : "bg-white"
              )} />
            </motion.div>
          )}
        </div>

        {segments.map((segment, idx) => (
          <div
            key={`hover-${idx}`}
            className="absolute top-0 h-16 group cursor-default"
            style={{
              left: `${segment.left}%`,
              width: `${segment.width}%`,
            }}
          >
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-30 pointer-events-none">
              <span className={cn(
                "text-[9px] font-bold px-2 py-0.5 rounded shadow-lg",
                isLight ? "text-white bg-zinc-800" : "text-white bg-zinc-900"
              )}>
                {segment.start}–{segment.end}
              </span>
            </div>
          </div>
        ))}
      </div>
      
      <div className={cn(
        "flex justify-between text-[8px] font-black font-mono px-1 uppercase tracking-[0.2em]",
        isLight ? "text-zinc-400" : "text-zinc-600"
      )}>
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>00:00</span>
      </div>
    </div>
  );
}
