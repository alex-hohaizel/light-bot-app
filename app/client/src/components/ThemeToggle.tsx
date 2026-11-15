import { useStore } from '@/lib/store';
import { useTheme } from '@/hooks/useTheme';
import { Sun, Moon } from 'lucide-react';
import { motion } from 'framer-motion';

interface ThemeToggleProps {
  compact?: boolean;
}

export function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const toggleTheme = useStore((s) => s.toggleTheme);
  const { isLight } = useTheme();

  if (compact) {
    return (
      <button
        onClick={toggleTheme}
        data-testid="button-theme-toggle"
        title={isLight ? 'Темна тема' : 'Світла тема'}
        className={
          "relative w-11 h-11 rounded-[14px] border flex items-center justify-center group overflow-hidden transition-all duration-300 " +
          (isLight
            ? "bg-amber-50 border-amber-300 hover:bg-amber-100 hover:border-amber-400 shadow-md shadow-amber-200/60 hover:shadow-lg hover:shadow-amber-300/50"
            : "bg-amber-500/[0.08] border-amber-500/20 shadow-[0_0_8px_rgba(245,158,11,0.12)] hover:bg-amber-500/15 hover:border-amber-400/30 hover:shadow-[0_0_16px_rgba(245,158,11,0.25)]")
        }
      >
        <motion.div
          key={isLight ? 'sun' : 'moon'}
          initial={{ rotate: -90, scale: 0, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          exit={{ rotate: 90, scale: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          {isLight ? (
            <Sun className="w-5 h-5 text-amber-500" />
          ) : (
            <Moon className="w-5 h-5 text-amber-400/80 group-hover:text-amber-300 transition-colors duration-300" />
          )}
        </motion.div>
      </button>
    );
  }

  return (
    <button
      onClick={toggleTheme}
      data-testid="button-theme-toggle"
      className={
        "flex items-center gap-3 w-full p-4 rounded-2xl border-2 transition-all duration-300 " +
        (isLight
          ? "bg-amber-50 border-amber-200 hover:border-amber-300"
          : "bg-zinc-900/40 border-white/10 hover:border-white/20")
      }
    >
      <div className={
        "w-12 h-12 rounded-xl flex items-center justify-center relative overflow-hidden " +
        (isLight
          ? "bg-gradient-to-br from-amber-100 to-orange-100"
          : "bg-gradient-to-br from-indigo-900/40 to-purple-900/40")
      }>
        <motion.div
          key={isLight ? 'sun' : 'moon'}
          initial={{ y: 20, opacity: 0, scale: 0.5 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: -20, opacity: 0, scale: 0.5 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          {isLight ? (
            <Sun className="w-6 h-6 text-amber-500" />
          ) : (
            <Moon className="w-6 h-6 text-indigo-300" />
          )}
        </motion.div>
      </div>

      <div className="flex-1 text-left">
        <div className={
          "text-sm font-bold " +
          (isLight ? "text-zinc-800" : "text-zinc-200")
        }>
          {isLight ? 'Світла тема' : 'Темна тема'}
        </div>
        <div className={
          "text-[10px] mt-0.5 " +
          (isLight ? "text-zinc-500" : "text-zinc-500")
        }>
          Натисніть щоб змінити оформлення
        </div>
      </div>

      <div className={
        "relative w-14 h-8 rounded-full transition-all duration-300 " +
        (isLight
          ? "bg-amber-400 shadow-inner shadow-amber-500/30"
          : "bg-zinc-700 shadow-inner shadow-zinc-900/50")
      }>
        <motion.div
          className={
            "absolute top-1 w-6 h-6 rounded-full shadow-md flex items-center justify-center " +
            (isLight
              ? "bg-white"
              : "bg-zinc-400")
          }
          animate={{ left: isLight ? '1.75rem' : '0.25rem' }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        >
          {isLight ? (
            <Sun className="w-3.5 h-3.5 text-amber-500" />
          ) : (
            <Moon className="w-3.5 h-3.5 text-zinc-700" />
          )}
        </motion.div>
      </div>
    </button>
  );
}
