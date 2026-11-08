import type { ParsedSchedule, DaySchedule, OutageSlot } from './scraper';

const DTEK_API_URL = 'https://dtek-api.svitlo-proxy.workers.dev/';
const ODESA_REGION_CPU = 'odeska-oblast';

const VALID_QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

type SlotValue = 1 | 2 | 3;

interface DtekDaySlots {
  [time: string]: SlotValue;
}

interface DtekQueueSchedule {
  [date: string]: DtekDaySlots;
}

interface DtekRegion {
  cpu: string;
  name_ua: string;
  name_ru?: string;
  name_en?: string;
  emergency?: boolean;
  schedule: Record<string, DtekQueueSchedule>;
}

interface DtekApiResponse {
  body?: string;
  regions?: DtekRegion[];
}

export interface OdesaScheduleData {
  schedules: Record<string, DtekQueueSchedule>;
  emergency: boolean;
  fetchedAt: number;
  regionName: string;
}

let cachedData: OdesaScheduleData | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function mapDtekStatus(value: SlotValue): 'offline' | 'online' | 'possible' {
  switch (value) {
    case 1: return 'online';
    case 2: return 'possible';
    case 3: return 'offline';
    default: return 'possible';
  }
}

function convertDtekDay(dateStr: string, daySlots: DtekDaySlots): DaySchedule {
  const times = Object.keys(daySlots).sort();
  if (times.length === 0) return { date: dateStr, slots: [] };

  const rawSlots: OutageSlot[] = [];
  for (let i = 0; i < times.length; i++) {
    const start = times[i];
    const status = mapDtekStatus(daySlots[start]);
    const nextTime = times[i + 1];
    let end: string;
    if (nextTime) {
      end = nextTime;
    } else {
      const [h, m] = start.split(':').map(Number);
      const endMin = h * 60 + m + 30;
      end = endMin >= 1440 ? '24:00' : `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    }
    rawSlots.push({ start, end, status });
  }

  const mergedSlots: OutageSlot[] = [];
  let current: OutageSlot | null = null;
  for (const slot of rawSlots) {
    if (current && current.status === slot.status) {
      current.end = slot.end;
    } else {
      if (current) mergedSlots.push(current);
      current = { ...slot };
    }
  }
  if (current) mergedSlots.push(current);

  return { date: dateStr, slots: mergedSlots };
}

async function fetchWithRetry(url: string, retries = 2): Promise<any> {
  let lastError: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'SvitloUkraine/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error: any) {
      lastError = error;
      if (i < retries) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastError || new Error('Failed to fetch');
}

export async function fetchOdesaScheduleData(): Promise<OdesaScheduleData> {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime) < CACHE_TTL) {
    return cachedData;
  }

  console.log(`[ODESA] Fetching schedule from DTEK proxy API...`);

  try {
    const raw: DtekApiResponse = await fetchWithRetry(DTEK_API_URL);

    let regions: DtekRegion[];
    if (raw.body && typeof raw.body === 'string') {
      const parsed = JSON.parse(raw.body);
      regions = parsed.regions || [];
    } else {
      regions = (raw as any).regions || [];
    }

    const odesa = regions.find(r => r.cpu === ODESA_REGION_CPU);
    if (!odesa || !odesa.schedule) {
      throw new Error('Odesa region not found in DTEK API response');
    }

    const data: OdesaScheduleData = {
      schedules: odesa.schedule,
      emergency: !!odesa.emergency,
      fetchedAt: now,
      regionName: odesa.name_ua || 'Одеська область',
    };

    cachedData = data;
    lastFetchTime = now;

    const queueCount = Object.keys(odesa.schedule).length;
    const firstQueue = Object.keys(odesa.schedule)[0];
    const dateCount = firstQueue ? Object.keys(odesa.schedule[firstQueue]).length : 0;
    console.log(`[ODESA] Data fetched: ${queueCount} queues, ${dateCount} days, emergency: ${odesa.emergency}`);

    return data;
  } catch (error: any) {
    console.error('[ODESA] Failed to fetch DTEK API data:', error.message);
    if (cachedData) {
      console.warn('[ODESA] Using stale cached data');
      return cachedData;
    }
    throw new Error('Failed to fetch Odesa schedule data');
  }
}

export function parseOdesaScheduleForQueue(data: OdesaScheduleData, queueId: string): ParsedSchedule {
  const queueSchedule = data.schedules[queueId];

  if (!queueSchedule) {
    return {
      queue: queueId,
      queueName: `Черга ${queueId}`,
      days: [],
      lastUpdated: data.fetchedAt,
      updateTime: '',
    };
  }

  const dates = Object.keys(queueSchedule).sort();
  const days: DaySchedule[] = dates.map(dateStr => convertDtekDay(dateStr, queueSchedule[dateStr]));

  if (days.length === 1) {
    const [y, m, d] = days[0].date.split('-').map(Number);
    const todayDate = new Date(Date.UTC(y, m - 1, d));
    const tomorrowDate = new Date(todayDate.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getUTCDate()).padStart(2, '0')}`;
    days.push({ date: tomorrowStr, slots: [] });
  }

  const updateTimeStr = new Date(data.fetchedAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  return {
    queue: queueId,
    queueName: `Черга ${queueId}`,
    days,
    lastUpdated: data.fetchedAt,
    updateTime: updateTimeStr,
  };
}

export function getOdesaAvailableQueues(data: OdesaScheduleData): { id: string; name: string }[] {
  return VALID_QUEUES
    .filter(q => data.schedules[q] !== undefined)
    .map(q => ({ id: q, name: `Черга ${q}` }));
}

export function getAllOdesaQueues(): { id: string; name: string }[] {
  return VALID_QUEUES.map(q => ({ id: q, name: `Черга ${q}` }));
}
