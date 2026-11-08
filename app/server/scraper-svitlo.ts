import type { ParsedSchedule, DaySchedule, OutageSlot } from './scraper';

const SVITLO_API_URL = 'https://svitlo-proxy.svitlo-proxy.workers.dev';
const VINNYTSIA_CPU = 'vinnitska-oblast';

interface SvitloRegion {
  cpu: string;
  name_ua: string;
  schedule: Record<string, Record<string, Record<string, number>>> | null;
}

interface SvitloResponse {
  date_today: string;
  regions: SvitloRegion[];
}

let cachedData: { response: SvitloResponse; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

function mapSvitloStatus(value: number): 'offline' | 'online' | 'possible' {
  switch (value) {
    case 2: return 'offline';
    case 1: return 'online';
    case 0: return 'possible';
    default: return 'online';
  }
}

export async function fetchSvitloData(): Promise<SvitloResponse> {
  const now = Date.now();
  if (cachedData && (now - cachedData.fetchedAt) < CACHE_TTL) {
    return cachedData.response;
  }

  console.log(`[SVITLO] Fetching data from ${SVITLO_API_URL}...`);
  const response = await fetch(SVITLO_API_URL, {
    headers: { 'User-Agent': 'SvitloUkraine/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json() as SvitloResponse;

  if (!data.regions || !Array.isArray(data.regions)) {
    throw new Error('Invalid svitlo.live API response');
  }

  cachedData = { response: data, fetchedAt: now };
  console.log(`[SVITLO] Data fetched: ${data.regions.length} regions, date_today: ${data.date_today}`);
  return data;
}

function getVinnytsiaRegion(data: SvitloResponse): SvitloRegion | null {
  return data.regions.find(r => r.cpu === VINNYTSIA_CPU) || null;
}

function convertSvitloDay(dateStr: string, slots: Record<string, number>): DaySchedule {
  const sortedTimes = Object.keys(slots).sort((a, b) => {
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    return (ah * 60 + am) - (bh * 60 + bm);
  });

  const allUnknown = Object.values(slots).every(v => v === 0);

  const rawSlots: OutageSlot[] = [];
  for (let i = 0; i < sortedTimes.length; i++) {
    const timeStr = sortedTimes[i];
    const [h, m] = timeStr.split(':').map(Number);
    const startMin = h * 60 + m;
    const endMin = startMin + 30;
    const endH = Math.floor(endMin / 60);
    const endM = endMin % 60;

    const start = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const end = endH === 24 ? '24:00' : `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;

    let status: 'offline' | 'online' | 'possible';
    if (allUnknown) {
      status = 'online';
    } else {
      status = mapSvitloStatus(slots[timeStr]);
    }

    rawSlots.push({ start, end, status });
  }

  if (rawSlots.length === 0) {
    for (let h = 0; h < 24; h++) {
      rawSlots.push({
        start: `${String(h).padStart(2, '0')}:00`,
        end: `${String(h + 1 === 24 ? 24 : h + 1).padStart(2, '0')}:00`,
        status: 'online',
      });
    }
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

export function parseSvitloScheduleForQueue(data: SvitloResponse, queueId: string): ParsedSchedule {
  const region = getVinnytsiaRegion(data);
  if (!region || !region.schedule) {
    return {
      queue: queueId,
      queueName: `Черга ${queueId}`,
      days: [],
      lastUpdated: Date.now(),
      updateTime: '',
    };
  }

  const queueData = region.schedule[queueId];
  if (!queueData) {
    return {
      queue: queueId,
      queueName: `Черга ${queueId}`,
      days: [],
      lastUpdated: Date.now(),
      updateTime: '',
    };
  }

  const days: DaySchedule[] = [];
  const dates = Object.keys(queueData).sort();

  for (const dateStr of dates) {
    const slots = queueData[dateStr];
    if (!slots || Object.keys(slots).length === 0) continue;

    const allUnknown = Object.values(slots).every(v => v === 0);
    if (allUnknown) continue;

    days.push(convertSvitloDay(dateStr, slots));
  }

  const fetchedAt = cachedData?.fetchedAt || Date.now();
  const updateTimeStr = new Date(fetchedAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  return {
    queue: queueId,
    queueName: `Черга ${queueId}`,
    days,
    lastUpdated: fetchedAt,
    updateTime: updateTimeStr,
  };
}

export function getSvitloAvailableQueues(data: SvitloResponse): { id: string; name: string }[] {
  const region = getVinnytsiaRegion(data);
  if (!region || !region.schedule) return [];

  return Object.keys(region.schedule)
    .sort((a, b) => {
      const [aG, aS] = a.split('.').map(Number);
      const [bG, bS] = b.split('.').map(Number);
      return aG !== bG ? aG - bG : aS - bS;
    })
    .map(key => ({
      id: key,
      name: `Черга ${key}`,
    }));
}

export function getSvitloAllQueuesSchedule(data: SvitloResponse): Record<string, ParsedSchedule> {
  const region = getVinnytsiaRegion(data);
  if (!region || !region.schedule) return {};

  const result: Record<string, ParsedSchedule> = {};
  for (const queueId of Object.keys(region.schedule)) {
    result[queueId] = parseSvitloScheduleForQueue(data, queueId);
  }
  return result;
}
