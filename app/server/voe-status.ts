const VOE_STATUS_URL = 'https://www.voe.com.ua/news';
const STATUS_CHECK_INTERVAL = 3 * 60 * 1000;

interface VoeEnergyStatus {
  isGpvActive: boolean;
  statusText: string;
  lastChecked: number;
  imageFile: string;
}

let cachedStatus: VoeEnergyStatus | null = null;
let lastCheckTime = 0;
let checkInProgress = false;

const NORMAL_STATUS_PATTERNS = [
  'звичайному режимі',
  'звичайному режим',
  'нормальному режим',
];

const GPV_ACTIVE_PATTERNS = [
  'графік',
  'ГПВ',
  'GPV',
  'відключен',
  'обмежте',
  'обмеження',
  'економте',
  'економ',
];

function parseGpvActive(description: string, imageFile: string): boolean {
  const lowerDesc = description.toLowerCase();

  for (const pattern of NORMAL_STATUS_PATTERNS) {
    if (lowerDesc.includes(pattern)) {
      return false;
    }
  }

  for (const pattern of GPV_ACTIVE_PATTERNS) {
    if (lowerDesc.includes(pattern.toLowerCase())) {
      return true;
    }
  }

  if (imageFile.includes('lightning1') || imageFile.includes('lightning3')) {
    return true;
  }

  return false;
}

export async function fetchVoeEnergyStatus(): Promise<VoeEnergyStatus> {
  const now = Date.now();

  if (cachedStatus && (now - lastCheckTime) < STATUS_CHECK_INTERVAL) {
    return cachedStatus;
  }

  if (checkInProgress && cachedStatus) {
    return cachedStatus;
  }

  checkInProgress = true;

  try {
    console.log('[VOE-STATUS] Checking energy system status...');
    const response = await fetch(VOE_STATUS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'uk-UA,uk;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();

    const descMatch = html.match(/accident-image[^>]*data-description="([^"]+)"/);
    const imgMatch = html.match(/accident-image[^>]*src="([^"]+)"/);

    if (!descMatch) {
      const altDescMatch = html.match(/class="popup-info"[^>]*>([^<]+)</);
      if (!altDescMatch) {
        console.warn('[VOE-STATUS] Could not find energy status on page');
        if (cachedStatus) return cachedStatus;
        return {
          isGpvActive: true,
          statusText: 'Невідомий статус',
          lastChecked: now,
          imageFile: '',
        };
      }
      const statusText = altDescMatch[1].trim();
      const imageFile = imgMatch ? imgMatch[1] : '';
      const isGpvActive = parseGpvActive(statusText, imageFile);

      cachedStatus = { isGpvActive, statusText, lastChecked: now, imageFile };
      lastCheckTime = now;
      console.log(`[VOE-STATUS] Status: "${statusText}" → GPV active: ${isGpvActive}`);
      return cachedStatus;
    }

    const statusText = descMatch[1].trim();
    const imageFile = imgMatch ? imgMatch[1] : '';
    const isGpvActive = parseGpvActive(statusText, imageFile);

    cachedStatus = { isGpvActive, statusText, lastChecked: now, imageFile };
    lastCheckTime = now;

    console.log(`[VOE-STATUS] Status: "${statusText}" (image: ${imageFile}) → GPV active: ${isGpvActive}`);
    return cachedStatus;

  } catch (error: any) {
    console.error('[VOE-STATUS] Failed to check status:', error.message);
    if (cachedStatus) {
      return cachedStatus;
    }
    return {
      isGpvActive: true,
      statusText: 'Помилка перевірки',
      lastChecked: now,
      imageFile: '',
    };
  } finally {
    checkInProgress = false;
  }
}

export function getLastKnownStatus(): VoeEnergyStatus | null {
  return cachedStatus;
}

export function invalidateStatusCache(): void {
  lastCheckTime = 0;
  cachedStatus = null;
}
