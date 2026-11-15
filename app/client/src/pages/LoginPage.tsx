import { motion } from 'framer-motion';
import { useState, useRef, useCallback, useEffect } from 'react';
import { Zap, Bell, Smartphone, RefreshCw, LogIn, Loader2, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { useStore } from '@/lib/store';

const features = [
  { icon: Zap, title: 'Графік відключень', desc: 'Актуальний розклад відключень світла' },
  { icon: Bell, title: 'Сповіщення', desc: 'Попередження перед змінами у графіку' },
  { icon: Smartphone, title: 'Telegram бот', desc: 'Керування прямо з месенджера' },
  { icon: RefreshCw, title: 'Синхронізація', desc: 'Ваші налаштування на всіх пристроях' },
];

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
    </svg>
  );
}

export function LoginPage() {
  const [tgLoading, setTgLoading] = useState(false);
  const [tgWaiting, setTgWaiting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isLight } = useTheme();
  const toggleTheme = useStore((s) => s.toggleTheme);

  const cleanup = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
  }, []);

  const openTelegramLink = useCallback((url: string) => {
    const tgWebApp = (window as any).Telegram?.WebApp;
    if (tgWebApp?.openTelegramLink) {
      try { tgWebApp.openTelegramLink(url); return; } catch {}
    }
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  }, []);

  const startPolling = useCallback((token: string) => {
    if (pollRef.current) return;
    setTgWaiting(true);
    pollRef.current = setInterval(async () => {
      try {
        const pollRes = await fetch(`/api/auth/telegram-login-poll?token=${encodeURIComponent(token)}`);
        const pollData = await pollRes.json();
        if (pollData.ready && pollData.redirectUrl) {
          cleanup();
          setTgWaiting(false);
          sessionStorage.removeItem('__tg_login_token');
          window.location.href = pollData.redirectUrl;
        }
      } catch {}
    }, 2000);
    timeoutRef.current = setTimeout(() => {
      cleanup();
      setTgWaiting(false);
      sessionStorage.removeItem('__tg_login_token');
    }, 300000);
  }, [cleanup]);

  useEffect(() => {
    const savedToken = sessionStorage.getItem('__tg_login_token');
    if (savedToken && !pollRef.current) {
      startPolling(savedToken);
    }
    return cleanup;
  }, [startPolling, cleanup]);

  const handleTelegramLogin = useCallback(async () => {
    if (tgLoading || tgWaiting) return;
    setTgLoading(true);

    const isTelegramBrowser = !!(window as any).Telegram?.WebApp;
    const popup = isTelegramBrowser ? null : window.open('about:blank', '_blank');

    try {
      const res = await fetch('/api/auth/telegram-login-request', { method: 'POST' });
      const data = await res.json();
      const botUrl = data.botUrl || 'https://t.me/PowerUkraineBot?start=main';

      if (popup && !popup.closed) {
        popup.location.href = botUrl;
      } else {
        if (popup) popup.close();
        openTelegramLink(botUrl);
      }

      if (data.token) {
        sessionStorage.setItem('__tg_login_token', data.token);
        setTgLoading(false);
        startPolling(data.token);
      } else {
        setTgLoading(false);
      }
    } catch {
      if (popup && !popup.closed) {
        popup.location.href = 'https://t.me/PowerUkraineBot?start=main';
      } else {
        openTelegramLink('https://t.me/PowerUkraineBot?start=main');
      }
      setTgLoading(false);
    }
  }, [tgLoading, tgWaiting, openTelegramLink, startPolling]);

  return (
    <div
      className="min-h-screen relative overflow-hidden flex flex-col"
      style={{
        background: isLight
          ? 'linear-gradient(180deg, #f5f5f7 0%, #eeeef0 100%)'
          : 'linear-gradient(180deg, #080c12 0%, #0c1018 100%)',
      }}
    >
      <button
        onClick={toggleTheme}
        className="absolute top-6 right-6 z-20 w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 hover:scale-110 active:scale-95"
        style={{
          background: isLight
            ? 'rgba(0,0,0,0.06)'
            : 'rgba(255,255,255,0.08)',
          border: isLight
            ? '1px solid rgba(0,0,0,0.08)'
            : '1px solid rgba(255,255,255,0.1)',
        }}
        data-testid="button-theme-toggle-login"
      >
        {isLight ? (
          <Sun className="w-4 h-4 text-zinc-700" />
        ) : (
          <Moon className="w-4 h-4 text-zinc-300" />
        )}
      </button>

      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full"
          style={{
            opacity: isLight ? 0.04 : 0.07,
            background: 'radial-gradient(circle, #00e676 0%, transparent 70%)',
          }}
        />
        <div
          className="absolute bottom-[-10%] right-[-10%] w-[400px] h-[400px] rounded-full"
          style={{
            opacity: isLight ? 0.03 : 0.05,
            background: 'radial-gradient(circle, #00e676 0%, transparent 70%)',
          }}
        />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center mb-10"
        >
          <div
            className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6"
            style={{
              background: isLight
                ? 'linear-gradient(135deg, rgba(0,200,83,0.18), rgba(0,200,83,0.08))'
                : 'linear-gradient(135deg, rgba(0,230,118,0.15), rgba(0,230,118,0.05))',
              border: isLight
                ? '1px solid rgba(0,200,83,0.3)'
                : '1px solid rgba(0,230,118,0.2)',
              boxShadow: isLight
                ? '0 4px 20px rgba(0,200,83,0.15)'
                : 'none',
            }}
          >
            <Zap className="w-10 h-10" style={{ color: isLight ? '#00a152' : '#00e676' }} />
          </div>
          <h1
            className={`text-3xl font-bold mb-2 tracking-tight ${isLight ? 'text-zinc-800' : 'text-white'}`}
            data-testid="text-app-title"
          >
            Світло Україна
          </h1>
          <p className={`text-base max-w-xs mx-auto ${isLight ? 'text-zinc-600' : 'text-zinc-400'}`}>
            Відстежуйте графік відключень електроенергії
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="w-full max-w-sm space-y-4 mb-6"
        >
          <a
            href="/api/login"
            className="flex items-center justify-center gap-3 w-full py-4 px-6 rounded-xl font-bold text-white transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
            style={{
              background: isLight
                ? 'linear-gradient(135deg, #00c853, #00e676)'
                : 'linear-gradient(135deg, rgba(0,230,118,0.2), rgba(0,230,118,0.08))',
              border: isLight
                ? '1px solid #00c853'
                : '1px solid rgba(0,230,118,0.3)',
              boxShadow: isLight
                ? '0 4px 24px rgba(0,200,83,0.35)'
                : '0 4px 24px rgba(0,230,118,0.15)',
            }}
            data-testid="button-login"
          >
            <LogIn className="w-5 h-5 text-white" />
            <span className="text-base">Увійти</span>
          </a>

          <div className="flex items-center gap-3">
            <div className={`flex-1 h-px ${isLight ? 'bg-black/[0.08]' : 'bg-white/[0.06]'}`} />
            <span className={`text-[10px] uppercase tracking-widest ${isLight ? 'text-zinc-400' : 'text-zinc-600'}`}>або</span>
            <div className={`flex-1 h-px ${isLight ? 'bg-black/[0.08]' : 'bg-white/[0.06]'}`} />
          </div>

          <button
            onClick={handleTelegramLogin}
            disabled={tgLoading}
            className="flex items-center justify-center gap-3 w-full py-4 px-6 rounded-xl font-bold text-white transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-70 disabled:scale-100"
            style={{
              background: 'linear-gradient(135deg, #2AABEE, #229ED9)',
              boxShadow: '0 4px 24px rgba(42,171,238,0.3)',
            }}
            data-testid="button-login-telegram"
          >
            {tgLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <TelegramIcon className="w-6 h-6 flex-shrink-0" />
            )}
            <span className="text-base">Увійти через Telegram бот</span>
          </button>
          {tgWaiting ? (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
              <p className="text-center text-[11px] text-sky-400">
                Натисніть Start у боті — вхід відбудеться автоматично
              </p>
            </div>
          ) : (
            <p className={`text-center text-[11px] ${isLight ? 'text-zinc-400' : 'text-zinc-500'}`}>
              Натисніть Start у боті — вхід відбудеться автоматично
            </p>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="grid grid-cols-2 gap-3 w-full max-w-sm"
        >
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.6 + i * 0.1 }}
              className="rounded-xl p-4"
              style={{
                background: isLight
                  ? 'rgba(255,255,255,0.8)'
                  : 'linear-gradient(135deg, rgba(17,26,36,0.8), rgba(13,21,32,0.6))',
                border: isLight
                  ? '1px solid rgba(0,0,0,0.06)'
                  : '1px solid rgba(255,255,255,0.06)',
              }}
              data-testid={`card-feature-${i}`}
            >
              <f.icon className="w-5 h-5 mb-2" style={{ color: '#00e676' }} />
              <div className={`text-sm font-medium ${isLight ? 'text-zinc-800' : 'text-zinc-200'}`}>{f.title}</div>
              <div className={`text-xs mt-0.5 ${isLight ? 'text-zinc-500' : 'text-zinc-500'}`}>{f.desc}</div>
            </motion.div>
          ))}
        </motion.div>
      </div>

      <div className="text-center py-4 relative z-10">
        <p className={`text-xs ${isLight ? 'text-zinc-500' : 'text-zinc-600'}`}>
          Розроблено для жителів України
        </p>
      </div>
    </div>
  );
}
