import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStore, ACCENT_COLORS, type AccentColor } from '@/lib/store';
import { requestNotificationPermission, getNotificationPermission } from '@/lib/notifications';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Bell, Send, Zap, Loader2, Home, CheckCircle2, ExternalLink, MessageCircle, Link2, Unlink, Shield, Plus, Mail, ChevronRight } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useToast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';
import { LocationManager } from './LocationManager';
import { isTelegramMiniApp, getTelegramWebApp } from '@/lib/telegram-webapp';

interface LinkedAccount {
  id: string;
  provider: string;
  providerId: string;
  displayName: string | null;
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
    </svg>
  );
}

function getProviderDisplay(displayName: string | null): { label: string; icon: React.ReactNode } {
  const dn = (displayName || '').toLowerCase();
  if (dn.includes('google') || dn.includes('gmail')) {
    return { label: 'Google', icon: <GoogleIcon className="w-4 h-4" /> };
  }
  if (dn.includes('apple') || dn.includes('icloud')) {
    return { label: 'Apple', icon: <AppleIcon className="w-4 h-4 text-white" /> };
  }
  if (dn.includes('github')) {
    return { label: 'GitHub', icon: <GitHubIcon className="w-4 h-4 text-white" /> };
  }
  return { label: 'Email', icon: <Mail className="w-4 h-4 text-zinc-400" /> };
}

function LinkedAccountsSection() {
  const { isLight } = useTheme();
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/linked-accounts');
      if (res.ok) {
        const data = await res.json();
        setAccounts(data);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const handleLinkReplit = () => {
    window.location.href = '/api/auth/link-replit';
  };

  const handleLinkTelegram = async () => {
    const store = useStore.getState();
    if (store.telegramChatId) {
      fetch('/api/auth/link-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: store.telegramChatId }),
      }).then(res => {
        if (res.ok) {
          toast({ title: 'Telegram прив\'язано' });
          loadAccounts();
        }
      }).catch(() => {});
    } else {
      try {
        const tokenRes = await fetch('/api/auth/telegram-link-token');
        const tokenData = await tokenRes.json();
        const linkToken = tokenData.token || '';
        const botUrl = linkToken
          ? `https://t.me/PowerUkraineBot?start=link_${linkToken}`
          : 'https://t.me/PowerUkraineBot';
        window.open(botUrl, '_blank');
        const pollInterval = setInterval(async () => {
          try {
            const r = await fetch('/api/notify/telegram/detect-chat');
            const d = await r.json();
            if (d.chatId) {
              clearInterval(pollInterval);
              const s = useStore.getState();
              s.setTelegramSettings(true, d.chatId, s.telegramNotifyBeforeOff, s.telegramNotifyBeforeOn);
              loadAccounts();
              toast({ title: 'Telegram прив\'язано' });
            }
          } catch {}
        }, 3000);
        setTimeout(() => clearInterval(pollInterval), 120000);
      } catch {
        window.open('https://t.me/PowerUkraineBot', '_blank');
      }
    }
  };

  const handleUnlink = async (provider: string, providerId: string) => {
    if (accounts.length <= 1) {
      toast({ title: 'Неможливо відв\'язати', description: 'Потрібен хоча б один метод входу' });
      return;
    }
    try {
      const res = await fetch('/api/auth/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, providerId }),
      });
      if (res.ok) {
        toast({ title: 'Акаунт відв\'язано' });
        loadAccounts();
      }
    } catch {}
  };

  const hasTelegram = accounts.some(a => a.provider === 'telegram');

  if (loading) return null;

  return (
    <Card className={cn("rounded-[32px] overflow-hidden backdrop-blur-xl transition-all duration-300", isLight ? "bg-white border-zinc-200 shadow-sm hover:border-zinc-400 hover:shadow-md" : "bg-zinc-900/20 border-white/5 hover:border-white/15")}>
      <CardHeader className="p-8 pb-4">
        <CardTitle className={cn("flex items-center gap-3 text-lg font-bold", isLight ? "text-zinc-800" : "text-white")}>
          <Link2 className="w-5 h-5 text-violet-500" />
          Прив'язані акаунти
        </CardTitle>
        <p className="text-xs text-zinc-500 mt-1">
          Входьте в додаток будь-яким прив'язаним методом
        </p>
      </CardHeader>
      <CardContent className="p-8 pt-0 space-y-3">
        {accounts.map(acc => {
          const isTg = acc.provider === 'telegram';
          const display = isTg
            ? { label: 'Telegram', icon: <TelegramIcon className="w-4 h-4 text-[#2AABEE]" /> }
            : getProviderDisplay(acc.displayName);
          const email = acc.displayName?.replace(/^Replit:\s*/, '') || '';

          return (
            <div key={acc.id} className={cn("flex items-center justify-between gap-3 p-4 rounded-2xl border", isLight ? "bg-zinc-50 border-zinc-200" : "bg-white/5 border-white/5")} data-testid={`linked-account-${acc.provider}-${acc.providerId}`}>
              <div className="flex items-center gap-3 min-w-0">
                <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shrink-0", isLight ? "bg-zinc-100" : "bg-white/5")}>
                  {display.icon}
                </div>
                <div className="min-w-0">
                  <p className={cn("text-sm font-medium truncate", isLight ? "text-zinc-700" : "text-zinc-200")}>{display.label}</p>
                  {email && <p className="text-[10px] text-zinc-500 truncate">{email}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                {accounts.length > 1 && (
                  <button
                    onClick={() => handleUnlink(acc.provider, acc.providerId)}
                    className={cn("text-zinc-600 hover:text-red-400 transition-colors p-1.5 rounded-lg", isLight ? "hover:bg-zinc-100" : "hover:bg-white/5")}
                    title="Відв'язати"
                    data-testid={`button-unlink-${acc.provider}`}
                  >
                    <Unlink className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <div className="space-y-2 pt-3">
          <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest">Прив'язати ще:</p>
          <button
            onClick={handleLinkReplit}
            className={cn("flex items-center justify-center gap-2.5 w-full px-4 py-3.5 rounded-xl text-xs font-medium border transition-all hover:scale-[1.01] active:scale-[0.99]", isLight ? "text-zinc-600 bg-zinc-50 hover:bg-zinc-100 border-zinc-200" : "text-zinc-300 bg-white/5 hover:bg-white/10 border-white/5")}
            data-testid="button-link-account"
          >
            <Plus className="w-4 h-4 text-zinc-500" />
            Google, Apple, GitHub або Email
          </button>
          {!hasTelegram && (
            <button
              onClick={handleLinkTelegram}
              className="flex items-center justify-center gap-2.5 w-full px-4 py-3.5 rounded-xl text-xs font-medium text-white border transition-all hover:opacity-90"
              style={{
                background: 'linear-gradient(135deg, rgba(42,171,238,0.15), rgba(34,158,217,0.1))',
                borderColor: 'rgba(42,171,238,0.3)',
              }}
              data-testid="button-link-telegram"
            >
              <TelegramIcon className="w-4 h-4 text-[#2AABEE]" />
              Telegram бот
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function WheelPicker({ items, value, onChange, accentHex, testId }: {
  items: { value: number; label: string }[];
  value: number;
  onChange: (v: number) => void;
  accentHex: string;
  testId: string;
}) {
  const { isLight } = useTheme();
  const listRef = useRef<HTMLDivElement>(null);
  const ITEM_H = 44;
  const VISIBLE = 5;
  const PAD = Math.floor(VISIBLE / 2);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userTouching = useRef(false);
  const didInitScroll = useRef(false);
  const lastValueRef = useRef(value);

  useEffect(() => {
    lastValueRef.current = value;
  }, [value]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const idx = items.findIndex(i => i.value === value);
    if (idx < 0) return;
    if (!didInitScroll.current) {
      el.scrollTop = idx * ITEM_H;
      didInitScroll.current = true;
    }
  }, [items]);

  const settleScroll = useCallback(() => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const el = listRef.current;
      if (!el || userTouching.current) return;
      const idx = Math.round(el.scrollTop / ITEM_H);
      const clamped = Math.max(0, Math.min(idx, items.length - 1));
      el.scrollTo({ top: clamped * ITEM_H, behavior: 'smooth' });
      if (items[clamped] && items[clamped].value !== lastValueRef.current) {
        onChange(items[clamped].value);
      }
    }, 120);
  }, [items, onChange]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onTouchStart = () => { userTouching.current = true; };
    const onTouchEnd = () => { userTouching.current = false; };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('mousedown', onTouchStart);
    el.addEventListener('mouseup', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('mousedown', onTouchStart);
      el.removeEventListener('mouseup', onTouchEnd);
    };
  }, []);

  const handleScroll = () => {
    settleScroll();
  };

  const scrollToIdx = (idx: number) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' });
    setTimeout(() => {
      if (items[idx] && items[idx].value !== lastValueRef.current) {
        onChange(items[idx].value);
      }
    }, 200);
  };

  const bgWhite = isLight ? 'rgba(255,255,255' : 'rgba(24,24,27';

  return (
    <div className="relative flex flex-col items-center" data-testid={testId} style={{ height: ITEM_H * VISIBLE }}>
      <div
        className="absolute left-0 right-0 rounded-xl pointer-events-none z-10 border"
        style={{
          top: ITEM_H * PAD,
          height: ITEM_H,
          background: `${accentHex}18`,
          borderColor: `${accentHex}40`,
        }}
      />
      <div
        className="absolute left-0 right-0 top-0 z-20 pointer-events-none"
        style={{ height: ITEM_H * PAD, background: `linear-gradient(to bottom, ${bgWhite},1), ${bgWhite},0))` }}
      />
      <div
        className="absolute left-0 right-0 bottom-0 z-20 pointer-events-none"
        style={{ height: ITEM_H * PAD, background: `linear-gradient(to top, ${bgWhite},1), ${bgWhite},0))` }}
      />
      <div
        ref={listRef}
        className="w-full overflow-y-auto no-scrollbar relative"
        style={{ height: ITEM_H * VISIBLE }}
        onScroll={handleScroll}
      >
        <div style={{ height: ITEM_H * PAD }} />
        {items.map((item, i) => {
          const isSelected = item.value === value;
          return (
            <div
              key={item.value}
              className={cn(
                "flex items-center justify-center cursor-pointer transition-all duration-150 select-none",
                isSelected ? "font-bold" : isLight ? "text-zinc-400" : "text-zinc-600"
              )}
              style={{
                height: ITEM_H,
                fontSize: isSelected ? '20px' : '15px',
                color: isSelected ? accentHex : undefined,
              }}
              onClick={() => scrollToIdx(i)}
              data-testid={`${testId}-${item.value}`}
            >
              {item.label}
            </div>
          );
        })}
        <div style={{ height: ITEM_H * PAD }} />
      </div>
    </div>
  );
}

function HourWheelPicker({ label, value, hours, onChange, color, testId }: {
  label: string;
  value: number;
  hours: number[];
  onChange: (h: number) => void;
  color: 'indigo' | 'amber';
  testId: string;
}) {
  const { isLight } = useTheme();
  const [open, setOpen] = useState(false);
  const accentHex = color === 'indigo' ? '#6366f1' : '#f59e0b';
  const items = hours.map(h => ({ value: h, label: `${String(h).padStart(2, '0')}:00` }));

  return (
    <div className="space-y-1" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all",
          isLight ? "bg-white border-zinc-200 hover:border-zinc-300" : "bg-white/[0.03] border-white/[0.06] hover:border-white/10"
        )}
      >
        <span className={cn("text-xs", isLight ? "text-zinc-500" : "text-zinc-500")}>{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold" style={{ color: accentHex }}>
            {String(value).padStart(2, '0')}:00
          </span>
          <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 60, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 60, scale: 0.95 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className={cn(
                "fixed left-4 right-4 bottom-4 z-50 rounded-3xl p-6 shadow-2xl border",
                isLight ? "bg-white border-zinc-200" : "bg-zinc-900 border-white/10"
              )}
              style={{ maxWidth: 400, margin: '0 auto' }}
            >
              <div className="text-center mb-4">
                <p className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-zinc-200")}>{label}</p>
              </div>
              <WheelPicker
                items={items}
                value={value}
                onChange={onChange}
                accentHex={accentHex}
                testId={`${testId}-wheel`}
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full mt-4 h-12 rounded-2xl text-sm font-bold text-white transition-all"
                style={{ background: accentHex }}
                data-testid={`${testId}-confirm`}
              >
                Готово
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function MinDurationPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const { isLight } = useTheme();
  const [open, setOpen] = useState(false);
  const accentHex = '#f59e0b';
  const items = [
    { value: 0, label: 'Будь-яке' },
    { value: 1, label: '1 година' },
    { value: 2, label: '2 години' },
    { value: 3, label: '3 години' },
    { value: 4, label: '4 години' },
  ];
  const displayLabel = value === 0 ? 'Будь-яке' : `${value} год`;

  return (
    <div className={cn("rounded-2xl border p-5", isLight ? "border-zinc-200 bg-white" : "border-white/5 bg-white/5")}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "w-full flex items-center justify-between transition-all"
        )}
        data-testid="btn-min-duration-open"
      >
        <div className="space-y-1 text-left">
          <label className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-zinc-200")}>⚡ Мін. тривалість</label>
          <p className="text-xs text-zinc-500">Ігнорувати короткі відключення</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs font-bold whitespace-nowrap" style={{ color: accentHex }}>{displayLabel}</span>
          <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 60, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 60, scale: 0.95 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className={cn(
                "fixed left-4 right-4 bottom-4 z-50 rounded-3xl p-6 shadow-2xl border",
                isLight ? "bg-white border-zinc-200" : "bg-zinc-900 border-white/10"
              )}
              style={{ maxWidth: 400, margin: '0 auto' }}
            >
              <div className="text-center mb-4">
                <p className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-zinc-200")}>Мін. тривалість відключення</p>
              </div>
              <WheelPicker
                items={items}
                value={value}
                onChange={onChange}
                accentHex={accentHex}
                testId="picker-min-duration-wheel"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full mt-4 h-12 rounded-2xl text-sm font-bold text-white transition-all"
                style={{ background: accentHex }}
                data-testid="btn-min-duration-confirm"
              >
                Готово
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

const THRESHOLD_PRESETS = [5, 10, 15, 30, 45, 60, 90, 120];

function TimePresetPicker({ value, onChange, label, testId, type }: { value: number; onChange: (v: number) => void; label: string; testId: string; type: 'off' | 'on' }) {
  const [open, setOpen] = useState(false);
  const { isLight } = useTheme();

  const dotColor = type === 'off' ? 'bg-red-500' : 'bg-emerald-500';
  const accentHex = type === 'off' ? '#ef4444' : '#10b981';
  const valueBg = type === 'off'
    ? (isLight ? 'bg-red-100 text-red-600' : 'bg-red-500/15 text-red-400')
    : (isLight ? 'bg-emerald-100 text-emerald-600' : 'bg-emerald-500/15 text-emerald-400');

  const formatTime = (mins: number) => {
    if (mins >= 60) return `${mins / 60} год`;
    return `${mins} хв`;
  };

  const items = THRESHOLD_PRESETS.map(p => ({ value: p, label: formatTime(p) }));

  return (
    <div className="space-y-0" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "w-full flex items-center justify-between p-4 rounded-2xl border transition-all",
          isLight ? "border-zinc-200 bg-zinc-50 hover:border-zinc-300" : "border-white/5 bg-white/[0.03] hover:border-white/10",
        )}
      >
        <div className="flex items-center gap-3">
          <span className={cn("w-2.5 h-2.5 rounded-full", dotColor)} />
          <span className={cn("text-sm", isLight ? "text-zinc-700" : "text-zinc-300")}>{label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn("text-sm font-bold px-3 py-1 rounded-lg", valueBg)}>
            {formatTime(value)}
          </span>
          <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 60, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 60, scale: 0.95 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className={cn(
                "fixed left-4 right-4 bottom-4 z-50 rounded-3xl p-6 shadow-2xl border",
                isLight ? "bg-white border-zinc-200" : "bg-zinc-900 border-white/10"
              )}
              style={{ maxWidth: 400, margin: '0 auto' }}
            >
              <div className="text-center mb-4">
                <p className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-zinc-200")}>{label}</p>
              </div>
              <WheelPicker
                items={items}
                value={value}
                onChange={onChange}
                accentHex={accentHex}
                testId={`${testId}-wheel`}
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full mt-4 h-12 rounded-2xl text-sm font-bold text-white transition-all"
                style={{ background: accentHex }}
                data-testid={`${testId}-confirm`}
              >
                Готово
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Settings() {
  const store = useStore();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { isLight } = useTheme();

  const [isTesting, setIsTesting] = useState(false);
  const [botUsername, setBotUsername] = useState('');
  const [telegramDialog, setTelegramDialog] = useState<'none' | 'not_found' | 'connected'>('none');
  const [notifPermission, setNotifPermission] = useState(getNotificationPermission());
  const [pendingTgConnect, setPendingTgConnect] = useState(false);
  const tgPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tgPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [accentExpanded, setAccentExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const isFirstTime = !store.hasSeenOnboarding;

  useEffect(() => {
    const wa = getTelegramWebApp();
    if (wa) {
      wa.BackButton.show();
      const onBack = () => navigate('/');
      wa.BackButton.onClick(onBack);
      return () => {
        wa.BackButton.offClick(onBack);
        wa.BackButton.hide();
      };
    }
  }, [navigate]);

  const syncToBot = useCallback(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      const s = useStore.getState();
      if (!s.telegramChatId) return;
      fetch('/api/notify/telegram/sync-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: s.telegramChatId,
          city: s.city,
          street: s.lookupMode === 'address' ? (s.street || '') : '',
          house: s.lookupMode === 'address' ? (s.houseNumber || '') : '',
          queueId: s.queueId || '',
          lookupMode: s.lookupMode,
          notifyBeforeOff: s.telegramNotifyBeforeOff,
          notifyBeforeOn: s.telegramNotifyBeforeOn,
          enabled: s.telegramNotifications,
          quietHoursEnabled: s.quietHoursEnabled,
          quietHoursStart: s.quietHoursStart,
          quietHoursEnd: s.quietHoursEnd,
          morningBriefingEnabled: s.morningBriefingEnabled,
          morningBriefingHour: s.morningBriefingHour,
          minOutageDuration: s.minOutageDuration,
        }),
      }).catch(() => {});
    }, 150);
  }, []);

  const tryAutoDetectChat = useCallback(async () => {
    const s = useStore.getState();
    if (s.telegramChatId) {
      setPendingTgConnect(false);
      if (tgPollRef.current) { clearInterval(tgPollRef.current); tgPollRef.current = null; }
      return;
    }
    try {
      const response = await fetch('/api/notify/telegram/detect-chat');
      const data = await response.json();
      if (data.chatId) {
        setPendingTgConnect(false);
        if (tgPollRef.current) { clearInterval(tgPollRef.current); tgPollRef.current = null; }
        const st = useStore.getState();
        st.setTelegramSettings(true, data.chatId, st.telegramNotifyBeforeOff, st.telegramNotifyBeforeOn);
        try {
          await fetch('/api/notify/telegram/sync-address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chatId: data.chatId,
              street: st.lookupMode === 'address' ? (st.street || '') : '',
              house: st.lookupMode === 'address' ? (st.houseNumber || '') : '',
              queueId: st.queueId || undefined,
              lookupMode: st.lookupMode,
              notifyBeforeOff: st.telegramNotifyBeforeOff,
              notifyBeforeOn: st.telegramNotifyBeforeOn,
              enabled: true,
            }),
          });
        } catch {}
        setTelegramDialog('none');
        toast({ title: "Telegram підключено!", description: "Сповіщення синхронізовано." });
      }
    } catch {}
  }, [toast]);

  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && pendingTgConnect) {
        tryAutoDetectChat();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (tgPollRef.current) { clearInterval(tgPollRef.current); tgPollRef.current = null; }
      if (tgPollTimeoutRef.current) { clearTimeout(tgPollTimeoutRef.current); tgPollTimeoutRef.current = null; }
    };
  }, [tryAutoDetectChat, pendingTgConnect]);

  const startTgPolling = useCallback(() => {
    if (pendingTgConnect) return;
    setPendingTgConnect(true);
    if (tgPollRef.current) clearInterval(tgPollRef.current);
    if (tgPollTimeoutRef.current) clearTimeout(tgPollTimeoutRef.current);
    tgPollRef.current = setInterval(() => {
      tryAutoDetectChat();
    }, 3000);
    tgPollTimeoutRef.current = setTimeout(() => {
      if (tgPollRef.current) { clearInterval(tgPollRef.current); tgPollRef.current = null; }
      setPendingTgConnect(false);
      tgPollTimeoutRef.current = null;
    }, 120000);
  }, [tryAutoDetectChat, pendingTgConnect]);

  useEffect(() => {
    if (store.telegramNotifications && !botUsername) {
      fetch('/api/notify/telegram/bot-info')
        .then(r => r.json())
        .then(d => { if (d.username) setBotUsername(d.username); })
        .catch(() => {});
    }
  }, [store.telegramNotifications, botUsername]);

  useEffect(() => {
    if (store.telegramChatId) {
      fetch(`/api/notify/telegram/subscriber?chatId=${encodeURIComponent(store.telegramChatId)}`)
        .then(r => { if (r.ok) return r.json(); return null; })
        .then(d => {
          if (!d || typeof d !== 'object') return;
          if (typeof d.city === 'string' && (d.city === 'Вінниця' || d.city === 'Київ' || d.city === 'Харків' || d.city === 'Одеса')) {
            if (d.city !== store.city) store.setCity(d.city);
          }
          if (typeof d.notifyBeforeOff === 'number' && d.notifyBeforeOff > 0) {
            store.setTelegramSettings(
              typeof d.enabled === 'boolean' ? d.enabled : store.telegramNotifications,
              store.telegramChatId,
              d.notifyBeforeOff,
              typeof d.notifyBeforeOn === 'number' && d.notifyBeforeOn > 0 ? d.notifyBeforeOn : store.telegramNotifyBeforeOn,
            );
          }
          const botMode = d.lookupMode || (d.street ? 'address' : 'queue');
          if (botMode === 'address' && d.street && typeof d.street === 'string') {
            if (d.street !== store.street || (d.houseNumber || '') !== store.houseNumber) {
              const botCity = d.city || store.city;
              store.setLookupMode('address');
              store.setAddress(botCity, d.street, d.houseNumber || '');
              if (d.queueId) store.setQueueId(d.queueId);
            }
          } else if (d.queueId && d.queueId !== store.queueId) {
            store.setQueueId(d.queueId);
          }
        })
        .catch(() => {});
    }
  }, [store.telegramChatId]);

  const handlePushToggle = async (checked: boolean) => {
    if (checked) {
      const granted = await requestNotificationPermission();
      if (!granted) {
        toast({ variant: "destructive", title: "Заблоковано", description: "Дозвольте сповіщення в налаштуваннях браузера." });
        return;
      }
      setNotifPermission('granted');
    }
    store.setNotifications(checked, store.notifyBeforeOff, store.notifyBeforeOn);
  };

  const handlePushThresholdOff = (val: number) => {
    store.setNotifications(store.notificationsEnabled, val, store.notifyBeforeOn);
  };

  const handlePushThresholdOn = (val: number) => {
    store.setNotifications(store.notificationsEnabled, store.notifyBeforeOff, val);
  };

  const handleTelegramToggle = (checked: boolean) => {
    store.setTelegramSettings(checked, store.telegramChatId, store.telegramNotifyBeforeOff, store.telegramNotifyBeforeOn);
    syncToBot();
  };

  const handleTelegramThresholdOff = (val: number) => {
    store.setTelegramSettings(store.telegramNotifications, store.telegramChatId, val, store.telegramNotifyBeforeOn);
    syncToBot();
  };

  const handleTelegramThresholdOn = (val: number) => {
    store.setTelegramSettings(store.telegramNotifications, store.telegramChatId, store.telegramNotifyBeforeOff, val);
    syncToBot();
  };

  const handleDisconnectTelegram = () => {
    store.setTelegramSettings(false, '', store.telegramNotifyBeforeOff, store.telegramNotifyBeforeOn);
  };

  return (
    <div className={cn("min-h-screen", isLight ? "bg-[#f5f5f7] text-zinc-900" : "bg-[#050505] text-white")}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="max-w-2xl mx-auto px-6 py-12 space-y-10"
      >
        <div className="flex items-center gap-6">
          {!isFirstTime && (
            <Button variant="ghost" size="icon" onClick={() => { window.scrollTo(0, 0); navigate('/'); }} className={cn("rounded-2xl border", isLight ? "bg-zinc-100 hover:bg-zinc-200 border-zinc-200" : "bg-zinc-900/50 hover:bg-white/10 border-white/5")} data-testid="button-back">
              <ArrowLeft className={cn("w-5 h-5", isLight ? "text-zinc-600" : "text-zinc-400")} />
            </Button>
          )}
          <div className="flex-1">
            <h1 className={cn("text-2xl font-bold tracking-tight", isLight ? "text-zinc-900" : "text-white")}>
              {isFirstTime ? 'Вітаємо!' : 'Налаштування'}
            </h1>
            {isFirstTime && (
              <p className="text-sm text-zinc-500 mt-1">Додайте вашу адресу для відстеження графіка</p>
            )}
          </div>
          <ThemeToggle compact />
        </div>

        <div className="space-y-8">
          <LocationManager onboardingMode={isFirstTime} />

          {!isFirstTime && (
            <Card className={cn("rounded-[32px] overflow-hidden backdrop-blur-xl transition-all duration-300", isLight ? "bg-white border-zinc-200 shadow-sm hover:border-zinc-400 hover:shadow-md" : "bg-zinc-900/20 border-white/5 hover:border-white/15")}>
              <CardHeader className="p-8 pb-4">
                <CardTitle className={cn("flex items-center gap-3 text-lg font-bold", isLight ? "text-zinc-800" : "text-white")}>
                  <Bell className={cn("w-5 h-5", isLight ? "text-amber-500" : "text-zinc-500")} />
                  Сповіщення
                </CardTitle>
              </CardHeader>
              <CardContent className="p-8 pt-0 space-y-8">
                <div className="space-y-3">
                  <div className={cn("flex flex-row items-center justify-between rounded-2xl border p-5", isLight ? "border-zinc-200 bg-zinc-50" : "border-white/5 bg-white/5")}>
                    <div className="space-y-1">
                      <label className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-zinc-200")}>Push-сповіщення</label>
                      <p className="text-xs text-zinc-500">Нагадування у браузері перед змінами</p>
                    </div>
                    <Switch
                      checked={store.notificationsEnabled}
                      onCheckedChange={handlePushToggle}
                      className={cn("data-[state=checked]:bg-emerald-500", isLight ? "data-[state=unchecked]:bg-zinc-300 data-[state=unchecked]:border data-[state=unchecked]:border-zinc-400" : "data-[state=unchecked]:bg-zinc-600")}
                      data-testid="switch-notifications"
                    />
                  </div>
                  {store.notificationsEnabled && notifPermission === 'denied' && (
                    <p className="text-xs text-red-400 px-2">Сповіщення заблоковані у браузері. Дозвольте їх в налаштуваннях сайту.</p>
                  )}
                  {store.notificationsEnabled && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-4 pl-1"
                    >
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Попереджати за:</p>
                      <TimePresetPicker
                        value={store.notifyBeforeOff}
                        onChange={handlePushThresholdOff}
                        label="до вимкнення"
                        testId="picker-notify-before-off"
                        type="off"
                      />
                      <TimePresetPicker
                        value={store.notifyBeforeOn}
                        onChange={handlePushThresholdOn}
                        label="до ввімкнення"
                        testId="picker-notify-before-on"
                        type="on"
                      />
                    </motion.div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className={cn("flex flex-row items-center justify-between rounded-2xl border p-5", isLight ? "border-zinc-200 bg-zinc-50" : "border-white/5 bg-white/5")}>
                    <div className="space-y-1">
                      <label className={cn("text-sm font-bold flex items-center gap-2", isLight ? "text-zinc-800" : "text-zinc-200")}>
                        <MessageCircle className="w-3.5 h-3.5" /> Telegram
                      </label>
                      <p className="text-xs text-zinc-500">Повідомлення у Telegram перед змінами</p>
                    </div>
                    <Switch
                      checked={store.telegramNotifications}
                      onCheckedChange={handleTelegramToggle}
                      className={cn("data-[state=checked]:bg-sky-500", isLight ? "data-[state=unchecked]:bg-zinc-300 data-[state=unchecked]:border data-[state=unchecked]:border-zinc-400" : "data-[state=unchecked]:bg-zinc-600")}
                      data-testid="switch-telegram"
                    />
                  </div>

                  {store.telegramNotifications && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-4"
                    >
                      {!store.telegramChatId ? (
                        <div className="space-y-4">
                          {pendingTgConnect ? (
                            <div className="w-full h-12 rounded-xl flex items-center justify-center" style={{ background: 'rgba(42,171,238,0.15)', border: '1px solid rgba(42,171,238,0.3)' }}>
                              <span className="flex items-center gap-2 text-xs font-bold text-[#2AABEE]">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Очікую підключення бота...
                              </span>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.preventDefault();
                                startTgPolling();
                                try {
                                  const tokenRes = await fetch('/api/auth/telegram-link-token');
                                  const tokenData = await tokenRes.json();
                                  const linkToken = tokenData.token || '';
                                  const botUrl = linkToken
                                    ? `https://t.me/PowerUkraineBot?start=link_${linkToken}`
                                    : 'https://t.me/PowerUkraineBot?start=main';
                                  window.open(botUrl, '_blank');
                                } catch {
                                  window.open('https://t.me/PowerUkraineBot?start=main', '_blank');
                                }
                              }}
                              className="flex items-center justify-center gap-2 w-full h-12 rounded-xl text-sm font-bold text-white transition-all hover:scale-[1.02] active:scale-[0.98]"
                              style={{
                                background: 'linear-gradient(135deg, #2AABEE, #229ED9)',
                                boxShadow: '0 4px 20px rgba(42,171,238,0.25)',
                              }}
                              data-testid="button-detect-telegram"
                            >
                              <TelegramIcon className="w-5 h-5" />
                              Підключити через Telegram бот
                            </button>
                          )}
                          <p className="text-[10px] text-zinc-600 text-center">Натисніть Start у боті — акаунт прив'яжеться автоматично</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className={cn("flex items-center justify-between rounded-xl border p-3", isLight ? "bg-zinc-50 border-zinc-200" : "bg-white/5 border-white/5")}>
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                              <span className={cn("text-xs", isLight ? "text-zinc-600" : "text-zinc-400")}>Chat ID: {store.telegramChatId}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                size="sm"
                                disabled={isTesting}
                                onClick={async () => {
                                  setIsTesting(true);
                                  try {
                                    const response = await fetch('/api/notify/telegram/test', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ chatId: store.telegramChatId }),
                                    });
                                    const data = await response.json();
                                    if (data.success) {
                                      toast({ title: "Надіслано!", description: "Перевірте Telegram — тестове повідомлення відправлено." });
                                    } else {
                                      toast({ variant: "destructive", title: "Помилка", description: data.error || "Не вдалося надіслати." });
                                    }
                                  } catch {
                                    toast({ variant: "destructive", title: "Помилка", description: "Не вдалося з'єднатися з сервером." });
                                  }
                                  setIsTesting(false);
                                }}
                                className="h-8 bg-sky-600 hover:bg-sky-500 text-white rounded-lg px-3 text-[10px] font-bold"
                                data-testid="button-test-telegram"
                              >
                                {isTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Тест'}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={handleDisconnectTelegram}
                                className="h-8 text-zinc-500 hover:text-red-400 rounded-lg px-2 text-[10px]"
                                data-testid="button-disconnect-telegram"
                              >
                                Відключити
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </motion.div>
                  )}

                  {store.telegramNotifications && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-4 pl-1"
                    >
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Попереджати за:</p>
                      <TimePresetPicker
                        value={store.telegramNotifyBeforeOff}
                        onChange={handleTelegramThresholdOff}
                        label="до вимкнення"
                        testId="picker-tg-notify-before-off"
                        type="off"
                      />
                      <TimePresetPicker
                        value={store.telegramNotifyBeforeOn}
                        onChange={handleTelegramThresholdOn}
                        label="до ввімкнення"
                        testId="picker-tg-notify-before-on"
                        type="on"
                      />
                    </motion.div>
                  )}
                </div>

                <div className={cn("rounded-2xl overflow-hidden transition-all duration-300 border mt-3",
                  isLight ? "bg-zinc-50 border-zinc-200" : "bg-white/[0.02] border-white/5"
                )}>
                  <button
                    type="button"
                    onClick={() => setAdvancedExpanded(!advancedExpanded)}
                    className={cn(
                      "w-full flex items-center justify-between px-5 py-4 rounded-2xl transition-all duration-150",
                      isLight
                        ? "hover:bg-zinc-100 active:bg-zinc-200/70"
                        : "hover:bg-white/[0.04] active:bg-white/[0.08]",
                      "cursor-pointer"
                    )}
                    data-testid="btn-toggle-advanced"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={cn("text-sm font-bold", isLight ? "text-zinc-700" : "text-zinc-300")}>Розширені налаштування</span>
                      {(() => {
                        const tags: string[] = [];
                        if (store.quietHoursEnabled) tags.push('🌙');
                        if (store.morningBriefingEnabled) tags.push('☀️');
                        if (store.minOutageDuration > 0) tags.push('⚡');
                        if (tags.length === 0) return null;
                        return (
                          <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-medium",
                            isLight ? "bg-zinc-200/70 text-zinc-600" : "bg-white/5 text-zinc-500"
                          )}>
                            {tags.join(' ')}
                          </span>
                        );
                      })()}
                    </div>
                    <motion.svg animate={{ rotate: advancedExpanded ? 180 : 0 }} transition={{ duration: 0.2 }} className={cn("w-4 h-4", isLight ? "text-zinc-400" : "text-zinc-600")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </motion.svg>
                  </button>
                  <AnimatePresence>
                    {advancedExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 space-y-3">
                          <div className={cn("rounded-2xl border p-5 space-y-4", isLight ? "border-zinc-200 bg-white" : "border-white/5 bg-white/5")}>
                            <div className="flex flex-row items-center justify-between">
                              <div className="space-y-1">
                                <label className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-zinc-200")}>🌙 Тиха година</label>
                                <p className="text-xs text-zinc-500">Не турбувати у нічний час</p>
                              </div>
                              <Switch
                                checked={store.quietHoursEnabled}
                                onCheckedChange={(checked) => {
                                  store.setQuietHours(checked);
                                  syncToBot();
                                }}
                                className={cn("data-[state=checked]:bg-indigo-500", isLight ? "data-[state=unchecked]:bg-zinc-300" : "data-[state=unchecked]:bg-zinc-600")}
                                data-testid="switch-quiet-hours"
                              />
                            </div>
                            {store.quietHoursEnabled && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                className="space-y-3"
                              >
                                <HourWheelPicker
                                  label="Початок"
                                  value={store.quietHoursStart}
                                  hours={[20, 21, 22, 23, 0, 1, 2]}
                                  onChange={(h) => { store.setQuietHours(true, h); syncToBot(); }}
                                  color="indigo"
                                  testId="picker-quiet-start"
                                />
                                <HourWheelPicker
                                  label="Кінець"
                                  value={store.quietHoursEnd}
                                  hours={[5, 6, 7, 8, 9, 10, 11]}
                                  onChange={(h) => { store.setQuietHours(true, undefined, h); syncToBot(); }}
                                  color="indigo"
                                  testId="picker-quiet-end"
                                />
                              </motion.div>
                            )}
                          </div>

                          <div className={cn("rounded-2xl border p-5 space-y-4", isLight ? "border-zinc-200 bg-white" : "border-white/5 bg-white/5")}>
                            <div className="flex flex-row items-center justify-between">
                              <div className="space-y-1">
                                <label className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-zinc-200")}>☀️ Ранковий брифінг</label>
                                <p className="text-xs text-zinc-500">Щоденний огляд графіка вранці</p>
                              </div>
                              <Switch
                                checked={store.morningBriefingEnabled}
                                onCheckedChange={(checked) => {
                                  store.setMorningBriefing(checked);
                                  syncToBot();
                                }}
                                className={cn("data-[state=checked]:bg-amber-500", isLight ? "data-[state=unchecked]:bg-zinc-300" : "data-[state=unchecked]:bg-zinc-600")}
                                data-testid="switch-morning-briefing"
                              />
                            </div>
                            {store.morningBriefingEnabled && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                              >
                                <HourWheelPicker
                                  label="Час"
                                  value={store.morningBriefingHour}
                                  hours={[5, 6, 7, 8, 9, 10, 11, 12]}
                                  onChange={(h) => { store.setMorningBriefing(true, h); syncToBot(); }}
                                  color="amber"
                                  testId="picker-briefing-hour"
                                />
                              </motion.div>
                            )}
                          </div>

                          <MinDurationPicker
                            value={store.minOutageDuration}
                            onChange={(v) => { store.setMinOutageDuration(v); syncToBot(); }}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </CardContent>
            </Card>
          )}

          {!isFirstTime && <LinkedAccountsSection />}

          {!isFirstTime && (
            <div className={cn("rounded-[32px] overflow-hidden transition-all duration-300 border",
              isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/20 border-white/5"
            )}>
              <button
                type="button"
                onClick={() => setAccentExpanded(!accentExpanded)}
                className="w-full flex items-center justify-between p-5"
                data-testid="btn-toggle-accent"
              >
                <div className="flex items-center gap-3">
                  <div className="flex -space-x-1">
                    {ACCENT_COLORS.slice(0, 4).map((c) => (
                      <div key={c.id} className="w-4 h-4 rounded-full border-2" style={{ background: isLight ? c.hex : c.darkHex, borderColor: isLight ? '#fff' : '#18181b' }} />
                    ))}
                  </div>
                  <span className={cn("text-sm font-bold", isLight ? "text-zinc-800" : "text-white")}>Оформлення</span>
                  <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-medium", isLight ? "bg-zinc-100 text-zinc-500" : "bg-white/5 text-zinc-500")}>
                    {ACCENT_COLORS.find(c => c.id === store.accentColor)?.label || 'Смарагдовий'}
                  </span>
                </div>
                <motion.svg animate={{ rotate: accentExpanded ? 180 : 0 }} transition={{ duration: 0.2 }} className={cn("w-4 h-4", isLight ? "text-zinc-400" : "text-zinc-600")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </motion.svg>
              </button>
              <AnimatePresence>
                {accentExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-5 pb-5">
                      <div className="grid grid-cols-7 gap-2">
                        {ACCENT_COLORS.map((color) => {
                          const isSelected = store.accentColor === color.id;
                          const displayHex = isLight ? color.hex : color.darkHex;
                          return (
                            <button
                              key={color.id}
                              onClick={() => {
                                store.setAccentColor(color.id);
                                syncToBot();
                              }}
                              data-testid={`btn-accent-${color.id}`}
                              aria-label={`${color.label}${isSelected ? ' (обрано)' : ''}`}
                              aria-pressed={isSelected}
                              title={color.label}
                              className={cn(
                                "relative aspect-square rounded-2xl border-2 transition-all duration-200 flex items-center justify-center group hover:scale-105 active:scale-95",
                                isSelected
                                  ? "border-white/50 shadow-lg scale-105"
                                  : (isLight ? "border-zinc-200 hover:border-zinc-400" : "border-white/10 hover:border-white/30")
                              )}
                              style={{
                                background: displayHex,
                                boxShadow: isSelected ? `0 0 20px ${displayHex}40, 0 0 8px ${displayHex}30` : undefined,
                              }}
                            >
                              {isSelected && (
                                <motion.div
                                  initial={{ scale: 0, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1 }}
                                  transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                >
                                  <CheckCircle2 className="w-5 h-5 text-white drop-shadow-md" />
                                </motion.div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {!isFirstTime && (
            <Button
              variant="outline"
              data-testid="button-go-home"
              onClick={() => { window.scrollTo(0, 0); navigate('/'); }}
              className="w-full h-12 rounded-2xl font-semibold transition-all border"
              style={{
                borderColor: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.35' : '0.3'})`,
                background: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.08' : '0.1'})`,
                color: `var(--accent-hex, #10b981)`,
              }}
            >
              <Home className="w-5 h-5 mr-2" />
              На головну
            </Button>
          )}

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
              data-testid="button-telegram-bot-settings"
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
      </motion.div>
    </div>
  );
}
