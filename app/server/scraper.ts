const DATA_URLS = [
  'https://raw.githubusercontent.com/vn-progr/gpv-voe-vinnytsia/main/data/Vinnytsiaoblenerho.json',
  'https://raw.githubusercontent.com/olnet93/gpv-voe-vinnytsia/main/data/Vinnytsiaoblenerho.json',
];

export interface VoeRawData {
  regionId: string;
  lastUpdated: number;
  fact: {
    data: Record<string, Record<string, Record<string, string>>>;
  };
  preset: {
    days?: Record<string, string>;
    sch_names?: Record<string, string>;
    updateFact?: string;
  };
  lastUpdateStatus: {
    status: string;
    ok: boolean;
    code: number;
    message: string | null;
    at: number;
  };
}

export interface OutageSlot {
  start: string;
  end: string;
  status: 'offline' | 'online' | 'possible';
}

export interface DaySchedule {
  date: string;
  slots: OutageSlot[];
}

export interface EmergencyAlert {
  message: string;
  cause?: string;
  startTime?: string;
  endTime?: string;
  isActive: boolean;
}

export interface ParsedSchedule {
  queue: string;
  queueName: string;
  days: DaySchedule[];
  lastUpdated: number;
  updateTime: string;
  alert?: EmergencyAlert;
}

let cachedData: VoeRawData | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function fetchVoeData(): Promise<VoeRawData> {
  const now = Date.now();
  if (cachedData && (now - lastFetchTime) < CACHE_TTL) {
    return cachedData;
  }

  let lastError: Error | null = null;

  for (const url of DATA_URLS) {
    try {
      console.log(`[VOE] Fetching data from ${url}...`);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'SvitloUkraine/1.0' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as VoeRawData;

      if (!data.fact?.data || Object.keys(data.fact.data).length === 0) {
        throw new Error('No schedule data in response');
      }

      cachedData = data;
      lastFetchTime = now;
      console.log(`[VOE] Data fetched successfully. Last updated: ${data.preset?.updateFact || new Date(data.lastUpdated * 1000).toISOString()}`);
      return data;
    } catch (error: any) {
      console.error(`[VOE] Failed to fetch from ${url}:`, error.message);
      lastError = error;
    }
  }

  if (cachedData) {
    console.warn('[VOE] Using stale cached data');
    return cachedData;
  }

  throw lastError || new Error('Failed to fetch VOE data from all sources');
}

function mapStatus(value: string): 'offline' | 'online' | 'possible' {
  switch (value) {
    case 'yes':
      return 'online';
    case 'no':
      return 'offline';
    case 'maybe':
      return 'possible';
    case 'first':
    case 'second':
      return 'possible';
    default:
      return 'online';
  }
}

export function parseScheduleForQueue(data: VoeRawData, queueId: string): ParsedSchedule {
  const queueKey = queueId.startsWith('GPV') ? queueId : `GPV${queueId}`;
  const queueName = data.preset?.sch_names?.[queueKey] || `Черга ${queueId.replace('GPV', '')}`;

  const days: DaySchedule[] = [];
  const timestamps = Object.keys(data.fact.data).sort((a, b) => Number(a) - Number(b));

  for (const timestamp of timestamps) {
    const dayData = data.fact.data[timestamp];
    const queueData = dayData[queueKey];

    if (!queueData) continue;

    const tsMs = Number(timestamp) * 1000;
    const kyivOffset = 2 * 60 * 60 * 1000;
    const date = new Date(tsMs + kyivOffset);
    const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

    const rawSlots: OutageSlot[] = [];
    for (let hour = 1; hour <= 24; hour++) {
      const value = queueData[String(hour)] || 'yes';
      const startHour = hour - 1;
      const endHour = hour;
      rawSlots.push({
        start: `${String(startHour).padStart(2, '0')}:00`,
        end: endHour === 24 ? '24:00' : `${String(endHour).padStart(2, '0')}:00`,
        status: mapStatus(value),
      });
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

    days.push({ date: dateStr, slots: mergedSlots });
  }

  if (days.length >= 2) {
    const tom = days[days.length - 1];
    if (tom.slots.length === 1 && tom.slots[0].start === '00:00' && tom.slots[0].end === '24:00' && tom.slots[0].status === 'online') {
      tom.slots = [];
    }
  }
  if (days.length === 1) {
    const [y, m, d] = days[0].date.split('-').map(Number);
    const todayDate = new Date(Date.UTC(y, m - 1, d));
    const tomorrowDate = new Date(todayDate.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getUTCDate()).padStart(2, '0')}`;
    days.push({ date: tomorrowStr, slots: [] });
  }

  return {
    queue: queueId.replace('GPV', ''),
    queueName,
    days,
    lastUpdated: data.lastUpdated * 1000,
    updateTime: data.preset?.updateFact || '',
  };
}

export function getAvailableQueues(data: VoeRawData): { id: string; name: string }[] {
  const timestamps = Object.keys(data.fact.data);
  if (timestamps.length === 0) return [];

  const firstDay = data.fact.data[timestamps[0]];
  return Object.keys(firstDay)
    .sort()
    .map(key => ({
      id: key.replace('GPV', ''),
      name: data.preset?.sch_names?.[key] || `Черга ${key.replace('GPV', '')}`,
    }));
}

export function getAllQueuesSchedule(data: VoeRawData): Record<string, ParsedSchedule> {
  const timestamps = Object.keys(data.fact.data);
  if (timestamps.length === 0) return {};

  const firstDay = data.fact.data[timestamps[0]];
  const result: Record<string, ParsedSchedule> = {};

  for (const queueKey of Object.keys(firstDay)) {
    result[queueKey.replace('GPV', '')] = parseScheduleForQueue(data, queueKey);
  }

  return result;
}
