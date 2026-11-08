import type { ParsedSchedule, DaySchedule, OutageSlot } from './scraper';

const BEZSVITLA_BASE = 'https://bezsvitla.com.ua/vinnytska-oblast';
const CACHE_TTL = 5 * 60 * 1000;

interface VoeScheduleCache {
  queues: Record<string, { slots: OutageSlot[]; updated: string }>;
  date: string;
  fetchedAt: number;
}

let todayCache: VoeScheduleCache | null = null;
let tomorrowCache: VoeScheduleCache | null = null;

function getKyivDate(offsetDays = 0): string {
  const now = new Date();
  const kyivTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  kyivTime.setDate(kyivTime.getDate() + offsetDays);
  const y = kyivTime.getFullYear();
  const m = String(kyivTime.getMonth() + 1).padStart(2, '0');
  const d = String(kyivTime.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseScheduleHtml(html: string): Record<string, { slots: OutageSlot[]; updated: string }> {
  const queues: Record<string, { slots: OutageSlot[]; updated: string }> = {};

  const queuePattern = new RegExp('Черга\\s*(\\d+\\.\\d+)\\s*<\\/a>.*?<div class="card-body[^>]*">(.*?)<\\/div>\\s*(?:<div class="card-footer[^>]*">.*?Оновлено:.*?(\\d{2}\\.\\d{2}\\.\\d{4}\\s+\\d{2}:\\d{2})\\s*<\\/div>)?', 'gs');
  let match;
  while ((match = queuePattern.exec(html)) !== null) {
    const queueId = match[1];
    const body = match[2];
    const updated = match[3] || '';

    const slots: OutageSlot[] = [];
    const slotPattern = /<span>(\d{2}:\d{2})\s*[–\-]\s*(\d{2}:\d{2})<\/span>\s*<span class="(icon-(?:on|off))"/g;
    let slotMatch;
    while ((slotMatch = slotPattern.exec(body)) !== null) {
      slots.push({
        start: slotMatch[1],
        end: slotMatch[2],
        status: slotMatch[3] === 'icon-on' ? 'online' : 'offline',
      });
    }

    queues[queueId] = { slots, updated };
  }

  return queues;
}

async function fetchBezsvitlaPage(dateStr: string): Promise<string> {
  const url = `${BEZSVITLA_BASE}/grafik-na-${dateStr}`;
  console.log(`[VOE-Direct] Fetching schedule from ${url}...`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.5',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return await response.text();
}

async function fetchDaySchedule(dateStr: string, cache: VoeScheduleCache | null): Promise<VoeScheduleCache | null> {
  if (cache && cache.date === dateStr && (Date.now() - cache.fetchedAt) < CACHE_TTL) {
    return cache;
  }

  try {
    const html = await fetchBezsvitlaPage(dateStr);

    const notPublished = html.includes('ще не опублікований') || html.includes('не знайдено');
    if (notPublished) {
      const titleMatch = html.match(/<title>([^<]+)/);
      const title = titleMatch ? titleMatch[1] : '';
      if (title.includes('не знайдено') || title.includes('404')) {
        console.log(`[VOE-Direct] No schedule available for ${dateStr}`);
        return null;
      }
    }

    const queues = parseScheduleHtml(html);
    const queueCount = Object.keys(queues).length;

    if (queueCount === 0) {
      console.log(`[VOE-Direct] No queue data found on page for ${dateStr} (schedule may not be published)`);
      return null;
    }

    console.log(`[VOE-Direct] Parsed ${queueCount} queues for ${dateStr}`);
    return { queues, date: dateStr, fetchedAt: Date.now() };
  } catch (error: any) {
    console.error(`[VOE-Direct] Failed to fetch schedule for ${dateStr}:`, error.message);
    if (cache && cache.date === dateStr) {
      console.warn(`[VOE-Direct] Using stale cache for ${dateStr}`);
      return cache;
    }
    return null;
  }
}

export async function fetchVoeDirectData(): Promise<{ today: VoeScheduleCache | null; tomorrow: VoeScheduleCache | null }> {
  const todayStr = getKyivDate(0);
  const tomorrowStr = getKyivDate(1);

  const [todayResult, tomorrowResult] = await Promise.allSettled([
    fetchDaySchedule(todayStr, todayCache),
    fetchDaySchedule(tomorrowStr, tomorrowCache),
  ]);

  if (todayResult.status === 'fulfilled') {
    todayCache = todayResult.value;
  }
  if (tomorrowResult.status === 'fulfilled') {
    tomorrowCache = tomorrowResult.value;
  }

  return { today: todayCache, tomorrow: tomorrowCache };
}

export async function parseVoeDirectScheduleForQueue(queueId: string): Promise<ParsedSchedule> {
  const { today, tomorrow } = await fetchVoeDirectData();

  const days: DaySchedule[] = [];
  let lastUpdated = Date.now();
  let updateTime = '';

  if (today && today.queues[queueId]) {
    const queueData = today.queues[queueId];
    days.push({
      date: today.date,
      slots: queueData.slots.length > 0 ? queueData.slots : [{ start: '00:00', end: '24:00', status: 'online' as const }],
    });
    lastUpdated = today.fetchedAt;
    updateTime = queueData.updated;
  }

  if (tomorrow && tomorrow.queues[queueId]) {
    const queueData = tomorrow.queues[queueId];
    days.push({
      date: tomorrow.date,
      slots: queueData.slots.length > 0 ? queueData.slots : [{ start: '00:00', end: '24:00', status: 'online' as const }],
    });
    if (!updateTime) {
      updateTime = queueData.updated;
    }
  }

  if (days.length === 0) {
    const todayStr = getKyivDate(0);
    days.push({
      date: todayStr,
      slots: [{ start: '00:00', end: '24:00', status: 'online' }],
    });
  }

  return {
    queue: queueId,
    queueName: `Черга ${queueId}`,
    days,
    lastUpdated,
    updateTime,
  };
}

export async function getVoeDirectAvailableQueues(): Promise<{ id: string; name: string }[]> {
  const { today, tomorrow } = await fetchVoeDirectData();
  const source = today || tomorrow;

  if (!source) {
    return ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'].map(id => ({
      id,
      name: `Черга ${id}`,
    }));
  }

  return Object.keys(source.queues)
    .sort((a, b) => {
      const [aG, aS] = a.split('.').map(Number);
      const [bG, bS] = b.split('.').map(Number);
      return aG !== bG ? aG - bG : aS - bS;
    })
    .map(id => ({ id, name: `Черга ${id}` }));
}

export async function getVoeDirectAllQueuesSchedule(): Promise<Record<string, ParsedSchedule>> {
  const { today, tomorrow } = await fetchVoeDirectData();
  const source = today || tomorrow;

  if (!source) return {};

  const result: Record<string, ParsedSchedule> = {};
  for (const queueId of Object.keys(source.queues)) {
    result[queueId] = await parseVoeDirectScheduleForQueue(queueId);
  }
  return result;
}

export function getVoeDirectLastUpdated(): { fetchedAt: number; updateTime: string } {
  const source = todayCache || tomorrowCache;
  if (!source) return { fetchedAt: 0, updateTime: '' };

  const firstQueue = Object.values(source.queues)[0];
  return {
    fetchedAt: source.fetchedAt,
    updateTime: firstQueue?.updated || '',
  };
}
