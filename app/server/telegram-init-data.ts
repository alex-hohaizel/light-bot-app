import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

export interface VerifiedTelegramUser {
  id: string;
  firstName: string;
  lastName?: string;
  photoUrl?: string;
  authDate: number;
}
const deny = (): never => { throw new Error('TELEGRAM_AUTH_INVALID'); };

/** The legacy Login Widget and mobile exchange use Telegram's separate SHA256-key algorithm. */
export function verifyTelegramLoginData(value: unknown, token: string, nowSeconds: number): VerifiedTelegramUser {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !token || !Number.isSafeInteger(nowSeconds)) return deny();
  const data = value as Record<string, unknown>;
  const entries = Object.entries(data);
  if (entries.length > 20 || entries.some(([key,item]) => !key || !['string','number'].includes(typeof item) ||
      String(item).length > 2048 || (typeof item === 'number' && !Number.isSafeInteger(item)))) return deny();
  if (typeof data.hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.hash)) return deny();
  const check = entries.filter(([key])=>key!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([key,item])=>`${key}=${item}`).join('\n');
  const secret = createHash('sha256').update(token).digest();
  const expected = createHmac('sha256',secret).update(check).digest();
  if (!timingSafeEqual(expected,Buffer.from(data.hash,'hex'))) return deny();
  const rawDate = String(data.auth_date), rawId = String(data.id);
  if (!/^\d{1,12}$/.test(rawDate) || !/^[1-9]\d{0,15}$/.test(rawId)) return deny();
  const authDate = Number(rawDate);
  if (!Number.isSafeInteger(Number(rawId)) || nowSeconds-authDate>86400 || authDate-nowSeconds>30 ||
      typeof data.first_name !== 'string' || !data.first_name.trim() || data.first_name.length>256) return deny();
  return {id:rawId,firstName:data.first_name,authDate,
    ...(typeof data.last_name==='string'?{lastName:data.last_name}:{}),
    ...(typeof data.photo_url==='string'?{photoUrl:data.photo_url}:{})};
}

/** Verifies Telegram's raw initData before identity lookup or any database write.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Never accepts initDataUnsafe. No IO, logging, or credential persistence.
 */
export function verifyTelegramInitData(raw: unknown, token: string, options: {
  nowSeconds: number; maxAgeSeconds?: number; futureSkewSeconds?: number;
}): VerifiedTelegramUser {
  const {nowSeconds, maxAgeSeconds = 3600, futureSkewSeconds = 30} = options;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0 ||
      !Number.isSafeInteger(futureSkewSeconds) || futureSkewSeconds < 0 || !token ||
      typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > 16384) return deny();
  const params = new URLSearchParams(raw), seen = new Set<string>();
  for (const [key] of params) {
    if (!key || seen.has(key)) return deny();
    seen.add(key);
  }
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return deny();
  params.delete('hash');
  const check = [...params.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash,'hex'))) return deny();
  const date = params.get('auth_date');
  if (!date || !/^\d{1,12}$/.test(date)) return deny();
  const authDate = Number(date);
  if (!Number.isSafeInteger(authDate) || nowSeconds - authDate > maxAgeSeconds || authDate - nowSeconds > futureSkewSeconds) return deny();
  let user: unknown;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return deny(); }
  if (!user || typeof user !== 'object' || Array.isArray(user)) return deny();
  const value = user as Record<string,unknown>;
  if (!Number.isSafeInteger(value.id) || Number(value.id) <= 0 || value.is_bot === true) return deny();
  if (typeof value.first_name !== 'string' || !value.first_name.trim() || value.first_name.length > 256) return deny();
  for (const field of ['last_name','photo_url']) if (value[field] !== undefined && (typeof value[field] !== 'string' || String(value[field]).length > 2048)) return deny();
  return {id:String(value.id), firstName:value.first_name, authDate,
    ...(typeof value.last_name === 'string' ? {lastName:value.last_name} : {}),
    ...(typeof value.photo_url === 'string' ? {photoUrl:value.photo_url} : {})};
}
