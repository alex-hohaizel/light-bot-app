import type { ParsedSchedule, DaySchedule, OutageSlot } from './scraper';

const YASNO_API_BASE = 'https://app.yasno.ua/api/blackout-service/public/shutdowns';
const KYIV_REGION_ID = 25;
const KYIV_DSO_ID = 902;

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

interface YasnoStreet {
  id: number;
  value: string;
}

interface YasnoHouse {
  id: number;
  value: string;
}

interface YasnoGroupResult {
  group: number;
  subgroup: number;
}

let cachedPlannedData: YasnoPlannedResponse | null = null;
let lastPlannedFetchTime = 0;
const PLANNED_CACHE_TTL = 5 * 60 * 1000;

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

export async function fetchKyivPlannedData(): Promise<YasnoPlannedResponse> {
  const now = Date.now();
  if (cachedPlannedData && (now - lastPlannedFetchTime) < PLANNED_CACHE_TTL) {
    return cachedPlannedData;
  }

  const url = `${YASNO_API_BASE}/regions/${KYIV_REGION_ID}/dsos/${KYIV_DSO_ID}/planned-outages`;
  console.log(`[YASNO] Fetching planned outages from ${url}...`);
  const data = await fetchWithRetry(url) as YasnoPlannedResponse;

  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    throw new Error('No planned outage data in YASNO response');
  }

  cachedPlannedData = data;
  lastPlannedFetchTime = now;
  const firstKey = Object.keys(data)[0];
  const updatedOn = data[firstKey]?.updatedOn || 'unknown';
  console.log(`[YASNO] Planned data fetched: ${Object.keys(data).length} groups, updatedOn: ${updatedOn}`);
  return data;
}

export function parseKyivScheduleForQueue(data: YasnoPlannedResponse, queueId: string): ParsedSchedule {
  const groupData = data[queueId];
  if (!groupData) {
    return {
      queue: queueId,
      queueName: `Група ${queueId}`,
      days: [],
      lastUpdated: Date.now(),
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

  const updatedOn = groupData.updatedOn ? new Date(groupData.updatedOn).getTime() : Date.now();
  const updateTimeStr = groupData.updatedOn
    ? new Date(groupData.updatedOn).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    : '';

  return {
    queue: queueId,
    queueName: `Група ${queueId}`,
    days,
    lastUpdated: updatedOn,
    updateTime: updateTimeStr,
  };
}

export function getKyivAvailableQueues(data: YasnoPlannedResponse): { id: string; name: string }[] {
  return Object.keys(data)
    .sort((a, b) => {
      const [aG, aS] = a.split('.').map(Number);
      const [bG, bS] = b.split('.').map(Number);
      return aG !== bG ? aG - bG : aS - bS;
    })
    .map(key => ({
      id: key,
      name: `Група ${key}`,
    }));
}

export async function searchKyivStreets(query: string): Promise<YasnoStreet[]> {
  if (!query || query.length < 2) return [];
  const url = `${YASNO_API_BASE}/addresses/v2/streets?regionId=${KYIV_REGION_ID}&dsoId=${KYIV_DSO_ID}&query=${encodeURIComponent(query)}`;
  try {
    const data = await fetchWithRetry(url, 1);
    if (!Array.isArray(data)) return [];
    return data as YasnoStreet[];
  } catch (error: any) {
    console.error('[YASNO] Street search failed:', error.message);
    return [];
  }
}

export async function searchKyivHouses(streetId: number, query: string = ''): Promise<YasnoHouse[]> {
  const url = `${YASNO_API_BASE}/addresses/v2/houses?regionId=${KYIV_REGION_ID}&dsoId=${KYIV_DSO_ID}&streetId=${streetId}&query=${encodeURIComponent(query)}`;
  try {
    const data = await fetchWithRetry(url, 1);
    if (!Array.isArray(data)) return [];
    return data as YasnoHouse[];
  } catch (error: any) {
    console.error('[YASNO] House search failed:', error.message);
    return [];
  }
}

export async function getKyivGroupByAddress(streetId: number, houseId: number): Promise<string | null> {
  const url = `${YASNO_API_BASE}/addresses/v2/group?regionId=${KYIV_REGION_ID}&dsoId=${KYIV_DSO_ID}&streetId=${streetId}&houseId=${houseId}`;
  try {
    const data = await fetchWithRetry(url, 1) as YasnoGroupResult;
    if (data && typeof data.group === 'number' && typeof data.subgroup === 'number') {
      return `${data.group}.${data.subgroup}`;
    }
    return null;
  } catch (error: any) {
    console.error('[YASNO] Group lookup failed:', error.message);
    return null;
  }
}

export async function resolveKyivAddressQueue(streetQuery: string, houseQuery: string): Promise<{ queueId: string | null; streetName: string | null; houseName: string | null }> {
  const streets = await searchKyivStreets(streetQuery);
  if (streets.length === 0) {
    return { queueId: null, streetName: null, houseName: null };
  }

  const street = streets[0];
  const houses = await searchKyivHouses(street.id, houseQuery);

  if (houses.length === 0) {
    return { queueId: null, streetName: street.value, houseName: null };
  }

  const exactHouse = houses.find(h => h.value.toLowerCase() === houseQuery.toLowerCase());
  const house = exactHouse || houses[0];

  const group = await getKyivGroupByAddress(street.id, house.id);
  return { queueId: group, streetName: street.value, houseName: house.value };
}
