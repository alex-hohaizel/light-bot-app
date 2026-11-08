import type { ParsedSchedule, DaySchedule, OutageSlot } from './scraper';

const YASNO_API_BASE = 'https://app.yasno.ua/api/blackout-service/public/shutdowns';
const KHARKIV_REGION_ID = 25;
const KHARKIV_DSO_ID = 902;

const VALID_QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

interface YasnoSlot {
  start: number;
  end: number;
  type: 'Definite' | 'NotPlanned';
}

interface YasnoDayData {
  slots: YasnoSlot[];
  date: string;
  status: string;
}

interface YasnoGroupData {
  today: YasnoDayData;
  tomorrow: YasnoDayData;
  updatedOn: string;
}

type YasnoPlannedResponse = Record<string, YasnoGroupData>;

export interface KharkivScheduleData {
  yasnoData: YasnoPlannedResponse;
  fetchedAt: number;
}

let cachedData: KharkivScheduleData | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function oblenergoQueueToYasnoGroup(queueId: string): string {
  const [qStr, subStr] = queueId.split('.');
  const q = parseInt(qStr);
  const sub = parseInt(subStr);
  if (isNaN(q) || isNaN(sub)) return queueId;
  const yasnoGroup = (q - 1) * 2 + sub;
  return `${yasnoGroup}.1`;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 24 && m === 0) return '24:00';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function mapYasnoStatus(type: string): 'offline' | 'online' | 'possible' {
  switch (type) {
    case 'Definite':
      return 'offline';
    case 'NotPlanned':
      return 'online';
    default:
      return 'possible';
  }
}

function convertYasnoDay(dayData: YasnoDayData): DaySchedule | null {
  if (!dayData.date || !dayData.slots || dayData.slots.length === 0) return null;

  const dateStr = dayData.date.split('T')[0];

  const rawSlots: OutageSlot[] = dayData.slots.map(slot => ({
    start: minutesToTime(slot.start),
    end: minutesToTime(slot.end),
    status: mapYasnoStatus(slot.type),
  }));

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
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error: any) {
      lastError = error;
      if (i < retries) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastError || new Error('Failed to fetch');
}

export async function fetchKharkivScheduleData(): Promise<KharkivScheduleData> {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime) < CACHE_TTL) {
    return cachedData;
  }

  const url = `${YASNO_API_BASE}/regions/${KHARKIV_REGION_ID}/dsos/${KHARKIV_DSO_ID}/planned-outages`;
  console.log(`[KHARKIV] Fetching schedule from YASNO API: ${url}`);

  try {
    const yasnoData = await fetchWithRetry(url) as YasnoPlannedResponse;

    if (!yasnoData || typeof yasnoData !== 'object' || Object.keys(yasnoData).length === 0) {
      throw new Error('No planned outage data in YASNO response for Kharkiv');
    }

    const data: KharkivScheduleData = { yasnoData, fetchedAt: now };
    cachedData = data;
    lastFetchTime = now;

    const firstKey = Object.keys(yasnoData)[0];
    const updatedOn = yasnoData[firstKey]?.updatedOn || 'unknown';
    console.log(`[KHARKIV] YASNO data fetched: ${Object.keys(yasnoData).length} groups, updatedOn: ${updatedOn}`);

    return data;
  } catch (error: any) {
    console.error('[KHARKIV] Failed to fetch YASNO data:', error.message);
    if (cachedData) {
      console.warn('[KHARKIV] Using stale cached data');
      return cachedData;
    }
    throw new Error('Failed to fetch Kharkiv schedule data from YASNO');
  }
}

export function parseKharkivScheduleForQueue(data: KharkivScheduleData, queueId: string): ParsedSchedule {
  const yasnoGroup = oblenergoQueueToYasnoGroup(queueId);
  const groupData = data.yasnoData[yasnoGroup];

  if (!groupData) {
    return {
      queue: queueId,
      queueName: `Черга ${queueId}`,
      days: [],
      lastUpdated: data.fetchedAt,
      updateTime: '',
    };
  }

  const days: DaySchedule[] = [];
  const today = convertYasnoDay(groupData.today);
  if (today) days.push(today);
  const tomorrow = convertYasnoDay(groupData.tomorrow);
  if (tomorrow) {
    days.push(tomorrow);
  } else if (today) {
    const [y, m, d] = today.date.split('-').map(Number);
    const todayDate = new Date(Date.UTC(y, m - 1, d));
    const tomorrowDate = new Date(todayDate.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getUTCDate()).padStart(2, '0')}`;
    days.push({ date: tomorrowStr, slots: [] });
  }

  const updatedOn = groupData.updatedOn ? new Date(groupData.updatedOn).getTime() : data.fetchedAt;
  const updateTimeStr = groupData.updatedOn
    ? new Date(groupData.updatedOn).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    : '';

  return {
    queue: queueId,
    queueName: `Черга ${queueId}`,
    days,
    lastUpdated: updatedOn,
    updateTime: updateTimeStr,
  };
}

export function getKharkivAvailableQueues(data: KharkivScheduleData): { id: string; name: string }[] {
  return VALID_QUEUES
    .filter(q => {
      const yasnoGroup = oblenergoQueueToYasnoGroup(q);
      return data.yasnoData[yasnoGroup] !== undefined;
    })
    .map(q => ({ id: q, name: `Черга ${q}` }));
}

export function getAllKharkivQueues(): { id: string; name: string }[] {
  return VALID_QUEUES.map(q => ({ id: q, name: `Черга ${q}` }));
}
