import type { EmergencyAlert } from './scraper';

interface CachedAlert {
  alert: EmergencyAlert | null;
  fetchedAt: number;
}

const alertCache: Record<string, CachedAlert> = {};
const CACHE_TTL = 3 * 60 * 1000;

function getKyivNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
}

function parseUkrainianDateTime(text: string): string | undefined {
  const patterns = [
    /(\d{1,2}):(\d{2})\s+(\d{4})[.\-/](\d{2})[.\-/](\d{2})/,
    /(\d{1,2}):(\d{2})\s+(\d{2})[.\-/](\d{2})[.\-/](\d{4})/,
    /(\d{4})[.\-/](\d{2})[.\-/](\d{2})\s+(\d{1,2}):(\d{2})/,
    /(\d{2})[.\-/](\d{2})[.\-/](\d{4})\s+(\d{1,2}):(\d{2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let year: string, month: string, day: string, hour: string, minute: string;

      if (pattern === patterns[0]) {
        [, hour, minute, year, month, day] = match;
      } else if (pattern === patterns[1]) {
        [, hour, minute, day, month, year] = match;
      } else if (pattern === patterns[2]) {
        [, year, month, day, hour, minute] = match;
      } else {
        [, day, month, year, hour, minute] = match;
      }

      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    }
  }

  const timeOnly = text.match(/(\d{1,2}):(\d{2})/);
  if (timeOnly) {
    const now = getKyivNow();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}T${timeOnly[1].padStart(2, '0')}:${timeOnly[2]}`;
  }

  return undefined;
}

export function parseAlertText(text: string): EmergencyAlert | null {
  if (!text || text.trim().length < 10) return null;

  const lower = text.toLowerCase();

  const alertKeywords = [
    'відсутня електроенергія',
    'аварійне відключення',
    'аварійн',
    'відключення електроенергії',
    'електроенергію відключено',
    'відсутнє електропостачання',
    'припинено електропостачання',
    'порушен',
    'пошкоджен',
    'знеструмлен',
    'ремонтні роботи',
    'планові роботи',
    'планове відключення',
    'відновлювальні роботи',
    'обмеження електропостачання',
  ];

  const isAlert = alertKeywords.some(kw => lower.includes(kw));
  if (!isAlert) return null;

  let cause: string | undefined;
  const causePatterns = [
    /причина\s*(?:відключення)?\s*[:–—-]\s*(.+?)(?:\.|$)/im,
    /(?:через|у зв'язку з|внаслідок)\s+(.+?)(?:\.|$)/im,
  ];
  for (const pattern of causePatterns) {
    const m = text.match(pattern);
    if (m) {
      cause = m[1].trim();
      break;
    }
  }

  let startTime: string | undefined;
  let endTime: string | undefined;

  const startPatterns = [
    /(?:час початку|початок|розпочато|з)\s*(?:–|—|-|:)\s*(.+?)(?:\n|$)/im,
    /(?:відключен[оі]?\s+(?:з|о))\s*(.+?)(?:\n|$)/im,
  ];
  for (const pattern of startPatterns) {
    const m = text.match(pattern);
    if (m) {
      startTime = parseUkrainianDateTime(m[1].trim());
      break;
    }
  }

  const endPatterns = [
    /(?:орієнтовний час завершення|час завершення|завершення|до)\s*(?:–|—|-|:)?\s*(?:до\s+)?(.+?)(?:\n|$)/im,
    /(?:відновлення|планується відновити|буде відновлено)\s*(?:–|—|-|:)?\s*(?:до\s+)?(.+?)(?:\n|$)/im,
  ];
  for (const pattern of endPatterns) {
    const m = text.match(pattern);
    if (m) {
      const parsed = parseUkrainianDateTime(m[1].trim());
      if (parsed) {
        endTime = parsed;
        break;
      }
    }
  }

  if (!cause && !startTime && !endTime) {
    cause = text.length > 200 ? text.substring(0, 197) + '...' : text;
  }

  const now = getKyivNow();
  let isActive = true;

  if (endTime) {
    const endDate = new Date(endTime);
    if (!isNaN(endDate.getTime()) && endDate < now) {
      isActive = false;
    }
  }

  const messageParts: string[] = [];
  if (cause) messageParts.push(cause);
  if (!cause) {
    const firstLine = text.split('\n').find(l => l.trim().length > 0);
    if (firstLine) messageParts.push(firstLine.trim().substring(0, 150));
  }

  return {
    message: messageParts.join('. ') || text.substring(0, 150),
    cause,
    startTime,
    endTime,
    isActive,
  };
}

export async function fetchVinnytsiaAlert(): Promise<EmergencyAlert | null> {
  const key = 'vinnytsia';
  const cached = alertCache[key];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.alert;
  }

  try {
    const { fetchVoeEnergyStatus } = await import('./voe-status');
    const status = await fetchVoeEnergyStatus();

    if (!status.statusText || status.statusText === 'Невідомий статус' || status.statusText === 'Помилка перевірки') {
      alertCache[key] = { alert: null, fetchedAt: Date.now() };
      return null;
    }

    const alert = parseAlertText(status.statusText);
    if (alert && !alert.isActive) {
      alertCache[key] = { alert: null, fetchedAt: Date.now() };
      return null;
    }

    alertCache[key] = { alert, fetchedAt: Date.now() };
    return alert;
  } catch (err: any) {
    console.error('[EMERGENCY] Vinnytsia alert check failed:', err.message);
    return cached?.alert || null;
  }
}

export async function fetchOdesaAlert(): Promise<EmergencyAlert | null> {
  const key = 'odesa';
  const cached = alertCache[key];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.alert;
  }

  try {
    const { fetchOdesaScheduleData } = await import('./scraper-odesa');
    const data = await fetchOdesaScheduleData();

    if (!data.emergency) {
      alertCache[key] = { alert: null, fetchedAt: Date.now() };
      return null;
    }

    const alert: EmergencyAlert = {
      message: 'Можливі аварійні відключення у регіоні',
      cause: 'Аварійна ситуація в енергосистемі',
      isActive: true,
    };

    alertCache[key] = { alert, fetchedAt: Date.now() };
    return alert;
  } catch (err: any) {
    console.error('[EMERGENCY] Odesa alert check failed:', err.message);
    return cached?.alert || null;
  }
}

export async function fetchKyivAlert(): Promise<EmergencyAlert | null> {
  const key = 'kyiv';
  const cached = alertCache[key];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.alert;
  }

  try {
    const response = await fetch('https://app.yasno.ua/api/blackout-service/public/notifications?regionId=25', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      alertCache[key] = { alert: null, fetchedAt: Date.now() };
      return null;
    }

    const data = await response.json();
    if (!data || !Array.isArray(data) || data.length === 0) {
      alertCache[key] = { alert: null, fetchedAt: Date.now() };
      return null;
    }

    const recent = data[0];
    if (recent.text || recent.message || recent.title) {
      const text = recent.text || recent.message || recent.title || '';
      const alert = parseAlertText(text);
      if (alert && alert.isActive) {
        alertCache[key] = { alert, fetchedAt: Date.now() };
        return alert;
      }
    }

    alertCache[key] = { alert: null, fetchedAt: Date.now() };
    return null;
  } catch (err: any) {
    console.error('[EMERGENCY] Kyiv alert check failed:', err.message);
    alertCache[key] = { alert: null, fetchedAt: Date.now() };
    return null;
  }
}

export async function fetchAlertForCity(city: string): Promise<EmergencyAlert | null> {
  switch (city) {
    case 'Вінниця':
      return fetchVinnytsiaAlert();
    case 'Одеса':
      return fetchOdesaAlert();
    case 'Київ':
      return fetchKyivAlert();
    case 'Харків':
      return fetchKyivAlert();
    default:
      return null;
  }
}
