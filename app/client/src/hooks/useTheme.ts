import { useStore, type AccentColor, ACCENT_COLORS } from '@/lib/store';

export const ACCENT_CSS: Record<AccentColor, { light: Record<string, string>; dark: Record<string, string> }> = {
  emerald: {
    light: {
      '--color-primary': 'hsl(160, 84%, 39%)',
      '--color-primary-foreground': 'hsl(0, 0%, 100%)',
      '--color-ring': 'hsl(160, 84%, 39%)',
      '--accent-hex': '#10b981',
      '--accent-hex-rgb': '16, 185, 129',
    },
    dark: {
      '--color-primary': 'hsl(160, 84%, 55%)',
      '--color-primary-foreground': 'hsl(240, 5.9%, 10%)',
      '--color-ring': 'hsl(160, 84%, 55%)',
      '--accent-hex': '#34d399',
      '--accent-hex-rgb': '52, 211, 153',
    },
  },
  blue: {
    light: {
      '--color-primary': 'hsl(217, 91%, 60%)',
      '--color-primary-foreground': 'hsl(0, 0%, 100%)',
      '--color-ring': 'hsl(217, 91%, 60%)',
      '--accent-hex': '#3b82f6',
      '--accent-hex-rgb': '59, 130, 246',
    },
    dark: {
      '--color-primary': 'hsl(217, 91%, 70%)',
      '--color-primary-foreground': 'hsl(240, 5.9%, 10%)',
      '--color-ring': 'hsl(217, 91%, 70%)',
      '--accent-hex': '#60a5fa',
      '--accent-hex-rgb': '96, 165, 250',
    },
  },
  purple: {
    light: {
      '--color-primary': 'hsl(263, 70%, 58%)',
      '--color-primary-foreground': 'hsl(0, 0%, 100%)',
      '--color-ring': 'hsl(263, 70%, 58%)',
      '--accent-hex': '#8b5cf6',
      '--accent-hex-rgb': '139, 92, 246',
    },
    dark: {
      '--color-primary': 'hsl(263, 70%, 72%)',
      '--color-primary-foreground': 'hsl(240, 5.9%, 10%)',
      '--color-ring': 'hsl(263, 70%, 72%)',
      '--accent-hex': '#a78bfa',
      '--accent-hex-rgb': '167, 139, 250',
    },
  },
  rose: {
    light: {
      '--color-primary': 'hsl(350, 89%, 60%)',
      '--color-primary-foreground': 'hsl(0, 0%, 100%)',
      '--color-ring': 'hsl(350, 89%, 60%)',
      '--accent-hex': '#f43f5e',
      '--accent-hex-rgb': '244, 63, 94',
    },
    dark: {
      '--color-primary': 'hsl(350, 89%, 72%)',
      '--color-primary-foreground': 'hsl(240, 5.9%, 10%)',
      '--color-ring': 'hsl(350, 89%, 72%)',
      '--accent-hex': '#fb7185',
      '--accent-hex-rgb': '251, 113, 133',
    },
  },
  amber: {
    light: {
      '--color-primary': 'hsl(38, 92%, 50%)',
      '--color-primary-foreground': 'hsl(0, 0%, 100%)',
      '--color-ring': 'hsl(38, 92%, 50%)',
      '--accent-hex': '#f59e0b',
      '--accent-hex-rgb': '245, 158, 11',
    },
    dark: {
      '--color-primary': 'hsl(43, 96%, 56%)',
      '--color-primary-foreground': 'hsl(240, 5.9%, 10%)',
      '--color-ring': 'hsl(43, 96%, 56%)',
      '--accent-hex': '#fbbf24',
      '--accent-hex-rgb': '251, 191, 36',
    },
  },
  cyan: {
    light: {
      '--color-primary': 'hsl(188, 94%, 43%)',
      '--color-primary-foreground': 'hsl(0, 0%, 100%)',
      '--color-ring': 'hsl(188, 94%, 43%)',
      '--accent-hex': '#06b6d4',
      '--accent-hex-rgb': '6, 182, 212',
    },
    dark: {
      '--color-primary': 'hsl(188, 94%, 56%)',
      '--color-primary-foreground': 'hsl(240, 5.9%, 10%)',
      '--color-ring': 'hsl(188, 94%, 56%)',
      '--accent-hex': '#22d3ee',
      '--accent-hex-rgb': '34, 211, 238',
    },
  },
  orange: {
    light: {
      '--color-primary': 'hsl(25, 95%, 53%)',
      '--color-primary-foreground': 'hsl(0, 0%, 100%)',
      '--color-ring': 'hsl(25, 95%, 53%)',
      '--accent-hex': '#f97316',
      '--accent-hex-rgb': '249, 115, 22',
    },
    dark: {
      '--color-primary': 'hsl(25, 95%, 64%)',
      '--color-primary-foreground': 'hsl(240, 5.9%, 10%)',
      '--color-ring': 'hsl(25, 95%, 64%)',
      '--accent-hex': '#fb923c',
      '--accent-hex-rgb': '251, 146, 60',
    },
  },
};

export function applyAccentToDocument(accent: AccentColor, themeMode: 'dark' | 'light') {
  const mode = themeMode === 'light' ? 'light' : 'dark';
  const vars = ACCENT_CSS[accent]?.[mode] || ACCENT_CSS.emerald[mode];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
  root.setAttribute('data-theme', themeMode);
  try {
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute('content', themeMode === 'light' ? '#f5f5f7' : '#18181b');
  } catch {}
}

export function useTheme() {
  const themeMode = useStore((s) => s.themeMode);
  const accentColor = useStore((s) => s.accentColor);
  const accent = ACCENT_COLORS.find(a => a.id === accentColor) || ACCENT_COLORS[0];
  return {
    theme: themeMode,
    isLight: themeMode === 'light',
    isDark: themeMode === 'dark',
    accentColor,
    accentHex: themeMode === 'light' ? accent.hex : accent.darkHex,
    accentLabel: accent.label,
  };
}
