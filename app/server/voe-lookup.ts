interface VoeLookupResult {
  queueId: string | null;
  queueName: string | null;
  isEnterprise?: boolean;
}

interface VoeCacheEntry {
  result: VoeLookupResult;
  timestamp: number;
}

const VALID_QUEUES = new Set(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']);
const cache = new Map<string, VoeCacheEntry>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getCacheKey(city: string, street: string, house: string): string {
  return `${city.toLowerCase().trim()}|${street.toLowerCase().trim()}|${house.toLowerCase().trim()}`;
}

export async function lookupQueueByAddress(
  city: string,
  street: string,
  house: string
): Promise<VoeLookupResult> {
  const cacheKey = getCacheKey(city, street, house);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }
  return { queueId: null, queueName: null };
}

export function getCachedQueue(city: string, street: string, house: string): VoeLookupResult | null {
  const cacheKey = getCacheKey(city, street, house);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }
  return null;
}

export function cacheQueueResult(city: string, street: string, house: string, queueId: string, isEnterprise?: boolean): void {
  const cacheKey = getCacheKey(city, street, house);
  cache.set(cacheKey, {
    result: { queueId, queueName: `Черга ${queueId}`, isEnterprise: isEnterprise || false },
    timestamp: Date.now(),
  });
}

export function invalidateCache(city: string, street: string, house: string): void {
  const cacheKey = getCacheKey(city, street, house);
  cache.delete(cacheKey);
}

export async function closeBrowser(): Promise<void> {
}
