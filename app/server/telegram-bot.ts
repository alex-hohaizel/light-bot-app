import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { fetchVoeData, parseScheduleForQueue } from './scraper';
import { fetchKyivPlannedData, parseKyivScheduleForQueue } from './scraper-kyiv';
import { fetchKharkivScheduleData, parseKharkivScheduleForQueue } from './scraper-kharkiv';
import { fetchOdesaScheduleData, parseOdesaScheduleForQueue } from './scraper-odesa';
import { getAllSubscribers as dbGetAllSubscribers, upsertSubscriber as dbUpsertSubscriber, getUserSettingsByTelegramChatId } from './storage';
import { isIsolatedMode } from './isolated-guard';
import { productionRuntimePolicy } from './runtime-policy';
const VALID_QUEUES_VINNYTSIA = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const VALID_QUEUES_KHARKIV = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const VALID_QUEUES_ODESA = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const VALID_QUEUES_KYIV = Array.from({ length: 60 }, (_, i) => `${i + 1}.1`);
const ALL_VALID_QUEUES = [...VALID_QUEUES_VINNYTSIA, ...VALID_QUEUES_KYIV, ...VALID_QUEUES_KHARKIV, ...VALID_QUEUES_ODESA];

function isValidQueue(queueId: string, city: string): boolean {
  if (city === 'Київ') return VALID_QUEUES_KYIV.includes(queueId);
  if (city === 'Харків') return VALID_QUEUES_KHARKIV.includes(queueId);
  if (city === 'Одеса') return VALID_QUEUES_ODESA.includes(queueId);
  return VALID_QUEUES_VINNYTSIA.includes(queueId);
}

export interface Subscriber {
  chatId: string;
  firstName?: string;
  username?: string;
  city?: string;
  queueId?: string;
  street?: string;
  houseNumber?: string;
  lookupMode?: 'queue' | 'address';
  notifyBeforeOff: number;
  notifyBeforeOn: number;
  enabled: boolean;
  lastNotifKey?: string;
  lastScheduleHash?: string;
  lastMsgIds?: number[];
  welcomeMsgId?: number;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  morningBriefingEnabled: boolean;
  morningBriefingHour: number;
  lastBriefingDate?: string;
  minOutageDuration: number;
  createdAt: number;
}

function getSubCity(sub: Subscriber): string {
  return sub.city || 'Вінниця';
}

function queueLabel(city: string): string {
  return city === 'Київ' ? 'Група' : 'Черга';
}

function queueLabelLower(city: string): string {
  return city === 'Київ' ? 'група' : 'черга';
}

function isInQuietHours(sub: Subscriber, kyivHour: number): boolean {
  if (!sub.quietHoursEnabled) return false;
  const start = sub.quietHoursStart;
  const end = sub.quietHoursEnd;
  if (start === end) return false;
  if (start < end) {
    return kyivHour >= start && kyivHour < end;
  }
  return kyivHour >= start || kyivHour < end;
}

function getOutageDurationHours(
  slots: { start: string; end: string; status: string }[],
  changeHour: number,
  tomorrowSlots?: { start: string; end: string; status: string }[]
): number {
  let total = 0;
  let counting = false;
  for (const slot of slots) {
    const startH = parseInt(slot.start.split(':')[0]);
    const endH = slot.end === '24:00' ? 24 : parseInt(slot.end.split(':')[0]);
    if (startH === changeHour && slot.status === 'offline') {
      counting = true;
    }
    if (counting && slot.status === 'offline') {
      total += endH - startH;
      if (endH < 24) return total;
    } else if (counting) {
      return total;
    }
  }
  if (counting && tomorrowSlots) {
    for (const slot of tomorrowSlots) {
      if (slot.status === 'offline') {
        const endH = slot.end === '24:00' ? 24 : parseInt(slot.end.split(':')[0]);
        total += endH - parseInt(slot.start.split(':')[0]);
        if (endH < 24) return total;
      } else {
        return total;
      }
    }
  }
  return total;
}

async function fetchScheduleForSub(sub: Subscriber): Promise<ReturnType<typeof parseScheduleForQueue> | null> {
  const city = getSubCity(sub);
  if (!sub.queueId) return null;
  try {
    if (city === 'Київ') {
      const data = await fetchKyivPlannedData();
      return parseKyivScheduleForQueue(data, sub.queueId);
    } else if (city === 'Харків') {
      const data = await fetchKharkivScheduleData();
      return parseKharkivScheduleForQueue(data, sub.queueId);
    } else if (city === 'Одеса') {
      const data = await fetchOdesaScheduleData();
      return parseOdesaScheduleForQueue(data, sub.queueId);
    } else {
      const data = await fetchVoeData();
      return parseScheduleForQueue(data, sub.queueId);
    }
  } catch (error: any) {
    console.error(`[TG Bot] Failed to fetch schedule for ${city}/${sub.queueId}:`, error.message);
    return null;
  }
}

interface UserState {
  step: string;
  data?: any;
}

let subscribers: Map<string, Subscriber> = new Map();
const userStates: Map<string, UserState> = new Map();
const lastBotMsgs: Map<string, number[]> = new Map();
let botActive = false;
let notifInterval: ReturnType<typeof setInterval> | null = null;

interface RecentStart {
  chatId: string;
  firstName?: string;
  username?: string;
  timestamp: number;
}
const recentStarts: RecentStart[] = [];

function getWelcomeMsgId(chatId: string): number | undefined {
  return subscribers.get(chatId)?.welcomeMsgId;
}

function setWelcomeMsgId(chatId: string, msgId: number | undefined) {
  const sub = subscribers.get(chatId);
  if (sub) {
    sub.welcomeMsgId = msgId;
    dbUpsertSubscriber(chatId, { welcomeMsgId: msgId ?? null } as any).catch(e =>
      console.error('[TG Bot] DB save welcomeMsgId error:', e.message));
  }
}

const SCHEDULE_CHANGE_COOLDOWN_MS = 0;
const lastScheduleChangeNotif = new Map<string, number>();


function trackBotMsg(chatId: string, msgId: number) {
  const arr = lastBotMsgs.get(chatId) || [];
  if (!arr.includes(msgId)) arr.push(msgId);
  lastBotMsgs.set(chatId, arr);
}

async function cleanupChat(chatId: string, newMsgId: number, isWelcome: boolean = false, extraDeleteIds?: number[]) {
  const oldWelcomeId = getWelcomeMsgId(chatId);
  const newWelcomeId = isWelcome ? newMsgId : oldWelcomeId;

  const keepIds = new Set<number>();
  if (newWelcomeId) keepIds.add(newWelcomeId);
  keepIds.add(newMsgId);

  const allTracked = new Set(lastBotMsgs.get(chatId) || []);
  if (oldWelcomeId) allTracked.add(oldWelcomeId);
  allTracked.add(newMsgId);
  if (extraDeleteIds) extraDeleteIds.forEach(id => allTracked.add(id));

  const toDelete = [...allTracked].filter(id => !keepIds.has(id));

  if (toDelete.length > 0) {
    if (toDelete.length === 1) {
      tgApi('deleteMessage', { chat_id: chatId, message_id: toDelete[0] }).catch(() => {});
    } else {
      for (let i = 0; i < toDelete.length; i += 100) {
        const batch = toDelete.slice(i, i + 100);
        if (batch.length === 1) {
          tgApi('deleteMessage', { chat_id: chatId, message_id: batch[0] }).catch(() => {});
        } else {
          tgApi('deleteMessages', { chat_id: chatId, message_ids: batch }).catch(() => {});
        }
      }
    }
  }

  const surviving = [newMsgId];
  if (newWelcomeId && newWelcomeId !== newMsgId) surviving.push(newWelcomeId);
  lastBotMsgs.set(chatId, surviving);

  if (isWelcome) setWelcomeMsgId(chatId, newMsgId);

  dbUpsertSubscriber(chatId, { lastBotMsgId: newMsgId } as any).catch(e =>
    console.error('[TG Bot] DB save lastBotMsgId error:', e.message));
}

function extractMsgId(result: any): number | undefined {
  return result?.result?.message_id;
}

async function sendAndClean(chatId: string, sendFn: () => Promise<any>, isWelcome: boolean = false, userMsgId?: number) {
  const result = await sendFn();
  const newId = extractMsgId(result);
  if (newId) {
    trackBotMsg(chatId, newId);
    if (isWelcome) {
      setWelcomeMsgId(chatId, newId);
    }
    const extraDelete = userMsgId ? [userMsgId] : undefined;
    await cleanupChat(chatId, newId, isWelcome, extraDelete);
  } else if (userMsgId) {
    trackBotMsg(chatId, userMsgId);
  }
  return result;
}

async function replySafe(chatId: string, text: string, kb: any, messageId?: number) {
  const welcomeId = getWelcomeMsgId(chatId);

  if (welcomeId) {
    const edited = await editMessageCaption(chatId, welcomeId, text, kb);
    if (edited?.ok) {
      trackBotMsg(chatId, welcomeId);
      if (messageId && messageId !== welcomeId) {
        tgApi('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
      }
      await cleanupChat(chatId, welcomeId);
      return edited;
    }
  }

  if (messageId) {
    tgApi('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  }
  return sendAndClean(chatId, () => sendPhoto(chatId, WELCOME_IMAGE_PATH, text, kb, true), true, messageId);
}

async function loadSubscribers() {
  try {
    const dbSubs = await dbGetAllSubscribers();
    subscribers = new Map(dbSubs.map(d => {
      const sub: Subscriber = {
        chatId: d.chatId,
        username: d.username || undefined,
        city: d.city || undefined,
        queueId: d.queueId || undefined,
        street: d.street || undefined,
        houseNumber: d.houseNumber || undefined,
        lookupMode: (d.lookupMode as 'queue' | 'address') || undefined,
        notifyBeforeOff: d.notifyBeforeOff,
        notifyBeforeOn: d.notifyBeforeOn,
        enabled: d.enabled,
        lastNotifKey: d.lastNotifKey || undefined,
        lastScheduleHash: d.lastScheduleHash || undefined,
        welcomeMsgId: (d as any).welcomeMsgId || undefined,
        quietHoursEnabled: (d as any).quietHoursEnabled || false,
        quietHoursStart: (d as any).quietHoursStart ?? 23,
        quietHoursEnd: (d as any).quietHoursEnd ?? 7,
        morningBriefingEnabled: (d as any).morningBriefingEnabled || false,
        morningBriefingHour: (d as any).morningBriefingHour ?? 7,
        lastBriefingDate: (d as any).lastBriefingDate || '',
        minOutageDuration: (d as any).minOutageDuration || 0,
        createdAt: d.createdAt ? d.createdAt.getTime() : Date.now(),
      };
      if (d.lastBotMsgId) {
        lastBotMsgs.set(d.chatId, [d.lastBotMsgId]);
      }
      return [d.chatId, sub];
    }));
    console.log(`[TG Bot] Loaded ${subscribers.size} subscribers from DB`);
  } catch (e: any) {
    console.error('[TG Bot] Failed to load subscribers from DB');
  }
}

function subscriberToDb(sub: Partial<Subscriber>): Record<string, any> {
  const data: Record<string, any> = {};
  if (sub.username !== undefined) data.username = sub.username || '';
  if (sub.city !== undefined) data.city = sub.city || 'Вінниця';
  if (sub.queueId !== undefined) data.queueId = sub.queueId || '';
  if (sub.street !== undefined) data.street = sub.street || '';
  if (sub.houseNumber !== undefined) data.houseNumber = sub.houseNumber || '';
  if (sub.lookupMode !== undefined) data.lookupMode = sub.lookupMode || 'queue';
  if (sub.notifyBeforeOff !== undefined) data.notifyBeforeOff = sub.notifyBeforeOff;
  if (sub.notifyBeforeOn !== undefined) data.notifyBeforeOn = sub.notifyBeforeOn;
  if (sub.enabled !== undefined) data.enabled = sub.enabled;
  if (sub.lastNotifKey !== undefined) data.lastNotifKey = sub.lastNotifKey || '';
  if (sub.lastScheduleHash !== undefined) data.lastScheduleHash = sub.lastScheduleHash || '';
  if (sub.welcomeMsgId !== undefined) data.welcomeMsgId = sub.welcomeMsgId || null;
  if (sub.quietHoursEnabled !== undefined) data.quietHoursEnabled = sub.quietHoursEnabled;
  if (sub.quietHoursStart !== undefined) data.quietHoursStart = sub.quietHoursStart;
  if (sub.quietHoursEnd !== undefined) data.quietHoursEnd = sub.quietHoursEnd;
  if (sub.morningBriefingEnabled !== undefined) data.morningBriefingEnabled = sub.morningBriefingEnabled;
  if (sub.morningBriefingHour !== undefined) data.morningBriefingHour = sub.morningBriefingHour;
  if (sub.lastBriefingDate !== undefined) data.lastBriefingDate = sub.lastBriefingDate || '';
  if (sub.minOutageDuration !== undefined) data.minOutageDuration = sub.minOutageDuration;
  data.updatedAt = new Date();
  return data;
}

function getSubscriber(chatId: string): Subscriber {
  if (!subscribers.has(chatId)) {
    const sub: Subscriber = {
      chatId,
      notifyBeforeOff: 30,
      notifyBeforeOn: 15,
      enabled: true,
      quietHoursEnabled: false,
      quietHoursStart: 23,
      quietHoursEnd: 7,
      morningBriefingEnabled: false,
      morningBriefingHour: 7,
      minOutageDuration: 0,
      createdAt: Date.now(),
    };
    subscribers.set(chatId, sub);
    dbUpsertSubscriber(chatId, subscriberToDb(sub)).catch(e =>
      console.error('[TG Bot] DB upsert error (new sub):', e.message));
  }
  return subscribers.get(chatId)!;
}

export function updateSubscriber(chatId: string, updates: Partial<Subscriber>, skipReverseSync = false) {
  if (isIsolatedMode()) return;
  const sub = getSubscriber(chatId);

  const cityChanged = 'city' in updates && updates.city !== sub.city;
  const queueChanged = 'queueId' in updates && updates.queueId !== sub.queueId;

  Object.assign(sub, updates);

  if (cityChanged || queueChanged) {
    sub.lastScheduleHash = undefined;
    sub.lastNotifKey = undefined;
    updates.lastScheduleHash = undefined;
    updates.lastNotifKey = undefined;
    console.log(`[TG Bot] Reset schedule hash for ${chatId} (address changed: city=${cityChanged}, queue=${queueChanged})`);
  }

  subscribers.set(chatId, sub);

  const dbUpdates: any = subscriberToDb(updates);
  if (cityChanged || queueChanged) {
    dbUpdates.lastScheduleHash = '';
    dbUpdates.lastNotifKey = '';
  }
  dbUpsertSubscriber(chatId, dbUpdates).catch(e =>
    console.error('[TG Bot] DB upsert error (update):', e.message));

  const addressFields = ['city', 'queueId', 'street', 'houseNumber', 'lookupMode'] as const;
  const hasAddressChange = addressFields.some(f => f in updates);

  if (hasAddressChange && skipReverseSync) {
    refreshWelcomeMessage(chatId).catch(e =>
      console.error(`[TG Bot] Welcome msg update error for ${chatId}:`, e.message));
  }

  if (!skipReverseSync) {
    const notifFields = ['enabled', 'notifyBeforeOff', 'notifyBeforeOn', 'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd', 'morningBriefingEnabled', 'morningBriefingHour', 'minOutageDuration'] as const;
    const hasNotifChange = notifFields.some(f => f in updates);
    if (hasAddressChange || hasNotifChange) {
      syncBotSettingsToUserSettings(chatId, updates).catch(e =>
        console.error(`[TG Bot] Reverse sync to user_settings error for ${chatId}:`, e.message));
    }
  }
}

async function syncBotSettingsToUserSettings(chatId: string, updates: Partial<Subscriber>) {
  try {
    const userSett = await getUserSettingsByTelegramChatId(chatId);
    if (!userSett) return;

    const { upsertUserSettings, getLinkedAccountsByUserId, getUserSettings } = await import('./storage');
    const settingsUpdates: Record<string, any> = {};
    if (updates.city !== undefined) settingsUpdates.city = updates.city || 'Вінниця';
    if (updates.queueId !== undefined) settingsUpdates.queueId = updates.queueId || '';
    if (updates.street !== undefined) settingsUpdates.street = updates.street || '';
    if (updates.houseNumber !== undefined) settingsUpdates.houseNumber = updates.houseNumber || '';
    if (updates.lookupMode !== undefined) settingsUpdates.lookupMode = updates.lookupMode || 'queue';
    if (updates.enabled !== undefined) settingsUpdates.telegramNotifications = updates.enabled;
    if (updates.notifyBeforeOff !== undefined) settingsUpdates.telegramNotifyBeforeOff = updates.notifyBeforeOff;
    if (updates.notifyBeforeOn !== undefined) settingsUpdates.telegramNotifyBeforeOn = updates.notifyBeforeOn;
    if (updates.quietHoursEnabled !== undefined) settingsUpdates.quietHoursEnabled = updates.quietHoursEnabled;
    if (updates.quietHoursStart !== undefined) settingsUpdates.quietHoursStart = updates.quietHoursStart;
    if (updates.quietHoursEnd !== undefined) settingsUpdates.quietHoursEnd = updates.quietHoursEnd;
    if (updates.morningBriefingEnabled !== undefined) settingsUpdates.morningBriefingEnabled = updates.morningBriefingEnabled;
    if (updates.morningBriefingHour !== undefined) settingsUpdates.morningBriefingHour = updates.morningBriefingHour;
    if (updates.minOutageDuration !== undefined) settingsUpdates.minOutageDuration = updates.minOutageDuration;

    if (Object.keys(settingsUpdates).length === 0) return;

    const savedSettings = await upsertUserSettings(userSett.userId, settingsUpdates);

    const { broadcastSettingsToUser } = await import('./routes');
    broadcastSettingsToUser(userSett.userId, savedSettings);

    const addressFields = ['city', 'queueId', 'street', 'houseNumber', 'lookupMode'];
    const addressData: Record<string, any> = {};
    for (const f of addressFields) {
      if (settingsUpdates[f] !== undefined) addressData[f] = settingsUpdates[f];
    }
    if (Object.keys(addressData).length === 0) return;

    try {
      const accounts = await getLinkedAccountsByUserId(userSett.userId);
      if (accounts.length > 1) {
        for (const acc of accounts) {
          const linkedUserId = acc.provider === 'telegram' ? `tg_${acc.providerId}` : acc.providerId;
          if (linkedUserId === userSett.userId) continue;

          const linkedSaved = await upsertUserSettings(linkedUserId, addressData);
          broadcastSettingsToUser(linkedUserId, linkedSaved);
          console.log(`[TG Bot] Propagated bot address change to linked account ${linkedUserId}`);
        }
      }
    } catch (linkErr: any) {
      console.error(`[TG Bot] Linked accounts sync error:`, linkErr.message);
    }
  } catch (e: any) {
    console.error(`[TG Bot] syncBotSettingsToUserSettings error:`, e.message);
  }
}

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';

async function tgApi(method: string, body?: any): Promise<any> {
  if (isIsolatedMode()) throw new Error('LBA_TELEGRAM_DISABLED');
  if (process.env.NODE_ENV === 'production' && !productionRuntimePolicy().telegramDeliveryEnabled) throw new Error('LBA_TELEGRAM_DELIVERY_PAUSED');
  const token = BOT_TOKEN();
  if (!token) return null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return await resp.json();
  } catch (e: any) {
    console.error(`[TG Bot] API ${method} error:`, e.message);
    return null;
  }
}

async function sendMessage(chatId: string, text: string, replyMarkup?: any) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function editMessage(chatId: string, messageId: number, text: string, replyMarkup?: any) {
  return tgApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function editMessageCaption(chatId: string, messageId: number, caption: string, replyMarkup?: any) {
  return tgApi('editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function refreshWelcomeMessage(chatId: string) {
  const sub = subscribers.get(chatId);
  if (!sub || !sub.welcomeMsgId) return;

  let text = `⚡ <b>Вітаю${sub.firstName ? `, ${sub.firstName}` : ''}!</b>\n\n`;
  text += `Я — бот <b>Світло Україна</b>.\n`;
  text += `Допоможу відстежувати графіки відключень електроенергії.\n\n`;

  let hasLocations = false;
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locations = await getUserLocations(linked.userId);
      if (locations.length > 0) {
        hasLocations = true;
        text += `📍 <b>Ваші локації</b> (${locations.length}):\n`;
        for (const loc of locations as any[]) {
          const locEmoji = getLocationEmoji(loc.name);
          const city = loc.city || 'Вінниця';
          const primary = loc.isPrimary ? ' ⭐' : '';
          const queue = loc.queueId ? ` · ${queueLabelLower(city)} ${loc.queueId}` : '';
          text += `${locEmoji} ${loc.name}${primary} — ${city}${queue}\n`;
        }
        text += `\n🔔 Сповіщення: ${sub.enabled ? '✅' : '❌'}\n`;
      }
    }
  } catch (e: any) {
    console.error('[TG Bot] refreshWelcomeMessage location lookup error:', e.message);
  }

  if (!hasLocations) {
    const city = getSubCity(sub);
    if (sub.queueId) {
      text += `${formatAddressLine(sub, city)}\n`;
      text += `${formatQueueLine(sub, city)}\n`;
      text += `🔔 Сповіщення: ${sub.enabled ? '✅ увімкнено' : '❌ вимкнено'}\n\n`;
    } else if (hasAddressButNoQueue(sub)) {
      text += `${formatAddressLine(sub, city)}\n`;
      text += `ℹ️ За цією адресою не знайдено графіків відключень.\n`;
      text += `Можливо, планових відключень не передбачено.\n\n`;
    } else {
      text += `👉 Для початку оберіть свою <b>чергу</b> або <b>адресу</b>.\n\n`;
    }
  }

  text += `Оберіть дію:`;

  const result = await editMessageCaption(chatId, sub.welcomeMsgId, text, mainMenuKeyboard(sub, hasLocations));
  if (!result?.ok) {
    const editText = await editMessage(chatId, sub.welcomeMsgId, text, mainMenuKeyboard(sub, hasLocations));
    if (!editText?.ok) {
      console.log(`[TG Bot] Could not update welcome message for ${chatId}, will re-send on next /start`);
    }
  }
}

async function answerCallback(callbackId: string, text?: string) {
  return tgApi('answerCallbackQuery', {
    callback_query_id: callbackId,
    text: text || '',
  });
}

async function sendPhoto(chatId: string, imagePath: string, caption: string, replyMarkup?: any, keepFile = false) {
  if (isIsolatedMode()) throw new Error('LBA_TELEGRAM_DISABLED');
  if (process.env.NODE_ENV === 'production' && !productionRuntimePolicy().telegramDeliveryEnabled) throw new Error('LBA_TELEGRAM_DELIVERY_PAUSED');
  const token = BOT_TOKEN();
  if (!token) return null;
  try {
    if (!existsSync(imagePath)) {
      console.error(`[TG Bot] sendPhoto: file not found: ${imagePath}`);
      return sendMessage(chatId, caption, replyMarkup);
    }
    const imgBuffer = readFileSync(imagePath);

    const boundary = '----TGBotBoundary' + Date.now();
    const parts: Buffer[] = [];

    function addField(name: string, value: string) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }

    addField('chat_id', chatId);
    addField('caption', caption);
    addField('parse_mode', 'HTML');
    if (replyMarkup) addField('reply_markup', JSON.stringify(replyMarkup));

    const isJpeg = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg');
    const mimeType = isJpeg ? 'image/jpeg' : 'image/png';
    const fileName = isJpeg ? 'image.jpg' : 'image.png';
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(imgBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const result = await resp.json() as any;
    if (!result.ok) {
      console.error('[TG Bot] sendPhoto API error:', result.error_code, result.description);
      return sendMessage(chatId, caption, replyMarkup);
    }
    if (!keepFile) { try { unlinkSync(imagePath); } catch {} }
    return result;
  } catch (e: any) {
    console.error('[TG Bot] sendPhoto error:', e.message);
    return sendMessage(chatId, caption, replyMarkup);
  }
}

const imageCache = new Map<string, { path: string; ts: number }>();
const IMAGE_CACHE_TTL = 120_000;

function getCachedImage(key: string): string | null {
  const entry = imageCache.get(key);
  if (entry && Date.now() - entry.ts < IMAGE_CACHE_TTL && existsSync(entry.path)) {
    return entry.path;
  }
  if (entry) imageCache.delete(key);
  return null;
}

function setCachedImage(key: string, path: string) {
  imageCache.set(key, { path, ts: Date.now() });
  const now = Date.now();
  const expired: string[] = [];
  imageCache.forEach((v, k) => { if (now - v.ts > IMAGE_CACHE_TTL) expired.push(k); });
  expired.forEach(k => imageCache.delete(k));
}

let fontsRegistered = false;
let canvasModule: any = null;
async function loadCanvas() {
  if (!canvasModule) {
    canvasModule = await import('canvas');
  }
  if (!fontsRegistered) {
    try {
      const { registerFont } = canvasModule;
      registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', { family: 'DSans', weight: 'bold' });
      registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', { family: 'DSans', weight: 'normal' });
      fontsRegistered = true;
    } catch (e: any) {
      console.error('[TG Bot] Font registration error:', e.message);
    }
  }
  return canvasModule;
}

if (!isIsolatedMode()) loadCanvas().catch(() => {});

async function generateNotificationImage(
  type: 'off' | 'on',
  minutesLeft: number,
  changeTime: string,
  queueId: string,
  currentHour: number,
  currentMinute: number,
  slots: { start: string; end: string; status: string }[],
  street?: string,
  houseNumber?: string,
): Promise<string> {
  const { createCanvas } = await loadCanvas();

  const S = 4;
  const W = 3200;
  const pad = 160;
  const contentW = 2880;
  const H = 1440;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const outPath = join('/tmp', `notif_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);

  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  const fillRoundRect = (x: number, y: number, w: number, h: number, r: number, color: string) => {
    roundRect(x, y, w, h, r);
    ctx.fillStyle = color;
    ctx.fill();
  };

  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#080c12');
  bgGrad.addColorStop(0.5, '#0c1018');
  bgGrad.addColorStop(1, '#080c12');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  roundRect(64, 48, W - 128, H - 96, 96);
  const cardGrad = ctx.createLinearGradient(0, 0, 0, H);
  cardGrad.addColorStop(0, '#111a24');
  cardGrad.addColorStop(1, '#0d1520');
  ctx.fillStyle = cardGrad;
  ctx.fill();
  ctx.strokeStyle = '#1a2636';
  ctx.lineWidth = 8;
  ctx.stroke();

  const isOff = type === 'off';
  const alertColor = isOff ? '#ff1744' : '#00e676';
  const alertColorDim = isOff ? '#ff174425' : '#00e67625';
  const alertLabel = isOff ? 'СВІТЛО ВИМКНУТЬ' : 'СВІТЛО ВВІМКНУТЬ';
  const alertIcon = isOff ? '⚠' : '⚡';

  let y = 176;

  const alertBgH = 352;
  const alertBgGrad = ctx.createLinearGradient(pad, y, pad + contentW, y);
  alertBgGrad.addColorStop(0, alertColorDim);
  alertBgGrad.addColorStop(1, '#00000000');
  fillRoundRect(pad, y, contentW, alertBgH, 72, 'transparent');
  roundRect(pad, y, contentW, alertBgH, 72);
  ctx.fillStyle = alertBgGrad;
  ctx.fill();
  ctx.strokeStyle = alertColor + '30';
  ctx.lineWidth = 8;
  ctx.stroke();

  const dotX = pad + 144;
  const dotY2 = y + 176;
  const glowSize1 = 700;
  const glowCenter1 = 350;
  const glowCanvas1 = createCanvas(glowSize1, glowSize1);
  const glowCtx1 = glowCanvas1.getContext('2d');
  glowCtx1.shadowColor = alertColor;
  glowCtx1.shadowBlur = 160;
  glowCtx1.beginPath();
  glowCtx1.arc(glowCenter1, glowCenter1, 64, 0, Math.PI * 2);
  glowCtx1.fillStyle = alertColor;
  glowCtx1.fill();
  glowCtx1.shadowBlur = 280;
  glowCtx1.fill();
  ctx.drawImage(glowCanvas1, dotX - glowCenter1, dotY2 - glowCenter1);

  ctx.font = `bold 88px DSans`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(alertIcon, dotX, dotY2 + 32);
  ctx.textAlign = 'left';

  ctx.font = `bold 120px DSans`;
  ctx.fillStyle = '#e8edf3';
  ctx.fillText(alertLabel, pad + 272, y + 144);

  ctx.font = `72px DSans`;
  ctx.fillStyle = '#5a7088';
  ctx.fillText('НЕЗАБАРОМ', pad + 272, y + 264);

  y += alertBgH + 64;

  const minutesStr = formatMinutes(minutesLeft);
  const changeLabel = isOff ? 'Вимкнення' : 'Увімкнення';

  roundRect(pad, y, contentW, 320, 64);
  const changeBgGrad = ctx.createLinearGradient(pad, y, pad, y + 320);
  changeBgGrad.addColorStop(0, '#0a1018');
  changeBgGrad.addColorStop(1, '#0d1520');
  ctx.fillStyle = changeBgGrad;
  ctx.fill();
  ctx.strokeStyle = alertColor + '25';
  ctx.lineWidth = 8;
  ctx.stroke();

  const iconBoxW = 192;
  fillRoundRect(pad + 64, y + 64, iconBoxW, iconBoxW, 48, alertColor + '18');
  ctx.strokeStyle = alertColor + '40';
  ctx.lineWidth = 8;
  roundRect(pad + 64, y + 64, iconBoxW, iconBoxW, 48);
  ctx.stroke();

  drawBolt(ctx, pad + 64 + iconBoxW / 2, y + 64 + iconBoxW / 2, 120, alertColor);

  ctx.font = `bold 80px DSans`;
  ctx.fillStyle = '#d0dae6';
  ctx.fillText(changeLabel, pad + 320, y + 152);

  ctx.font = `64px DSans`;
  ctx.fillStyle = '#5a7088';
  ctx.fillText(`через ${minutesStr}`, pad + 320, y + 248);

  ctx.font = `bold 128px DSans`;
  ctx.fillStyle = alertColor;
  ctx.textAlign = 'right';
  ctx.fillText(changeTime, W - pad - 64, y + 216);
  ctx.textAlign = 'left';

  y += 384;

  const queueLabel = `Черга ${queueId}`;
  const addressLine = street ? `${street}${houseNumber ? ', ' + houseNumber : ''}` : '';
  const infoLine = addressLine ? `${queueLabel}  ·  ${addressLine}` : queueLabel;
  ctx.font = `68px DSans`;
  ctx.fillStyle = '#5a7088';
  ctx.fillText(infoLine, pad + 16, y + 16);

  y += 96;

  const barX = pad;
  const barW = contentW;
  const barH = 160;
  const slotW = barW / 24;

  roundRect(barX, y, barW, barH, 32);
  ctx.fillStyle = '#0a0e14';
  ctx.fill();
  ctx.strokeStyle = '#1a2636';
  ctx.lineWidth = 8;
  ctx.stroke();

  ctx.save();
  roundRect(barX, y, barW, barH, 32);
  ctx.clip();

  const slotColors: string[] = [];
  for (let h = 0; h < 24; h++) {
    const st = getCurrentHourStatus(slots, h);
    if (st === 'online') slotColors.push('#16783a');
    else if (st === 'offline') slotColors.push('#a01525');
    else slotColors.push('#b56a00');
  }

  for (let h = 0; h < 24; h++) {
    ctx.fillStyle = slotColors[h];
    ctx.fillRect(barX + h * slotW, y, slotW + 1, barH);
  }

  const nowX = barX + (currentHour + currentMinute / 60) * slotW;
  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 32;
  ctx.strokeStyle = '#ffffffdd';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(nowX, y);
  ctx.lineTo(nowX, y + barH);
  ctx.stroke();
  ctx.restore();

  ctx.restore();

  y += barH + 40;
  ctx.font = `44px DSans`;
  ctx.fillStyle = '#3a5068';
  for (let h = 0; h <= 24; h += 6) {
    const lx = barX + h * slotW;
    ctx.textAlign = h === 24 ? 'right' : h === 0 ? 'left' : 'center';
    ctx.fillText(`${h}`, lx, y + 16);
  }
  ctx.textAlign = 'left';

  const buf = canvas.toBuffer('image/png', { compressionLevel: 1 });
  writeFileSync(outPath, buf);
  return outPath;
}

async function generateStatusImage(
  slots: { start: string; end: string; status: string }[],
  queueId: string,
  currentHour: number,
  currentMinute: number,
  street?: string,
  houseNumber?: string,
  nextChange?: { time: string; toStatus: string; minutesLeft: number } | null,
): Promise<string> {
  const { createCanvas } = await loadCanvas();

  const S = 4;
  const W = 3200;
  const pad = 160;
  const contentW = 2880;
  const hasNextChange = nextChange && nextChange.minutesLeft > 0;
  const H = 1360 + (hasNextChange ? 400 : 0);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const outPath = join('/tmp', `status_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);

  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  const fillRoundRect = (x: number, y: number, w: number, h: number, r: number, color: string) => {
    roundRect(x, y, w, h, r);
    ctx.fillStyle = color;
    ctx.fill();
  };

  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#080c12');
  bgGrad.addColorStop(0.5, '#0c1018');
  bgGrad.addColorStop(1, '#080c12');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  roundRect(64, 48, W - 128, H - 96, 96);
  const cardGrad = ctx.createLinearGradient(0, 0, 0, H);
  cardGrad.addColorStop(0, '#111a24');
  cardGrad.addColorStop(1, '#0d1520');
  ctx.fillStyle = cardGrad;
  ctx.fill();
  ctx.strokeStyle = '#1a2636';
  ctx.lineWidth = 8;
  ctx.stroke();

  const currentStatus = getCurrentHourStatus(slots, currentHour);
  const isOn = currentStatus === 'online';
  const isOff = currentStatus === 'offline';
  const statusColor = isOn ? '#00e676' : isOff ? '#ff1744' : '#ffab00';
  const statusColorDim = isOn ? '#00e67630' : isOff ? '#ff174430' : '#ffab0030';
  const statusLabel = isOn ? 'Є СВІТЛО' : isOff ? 'НЕМАЄ СВІТЛА' : 'МОЖЛИВЕ ВИМКНЕННЯ';

  let y = 176;

  const statusBgGrad = ctx.createLinearGradient(pad, y, pad + contentW, y);
  statusBgGrad.addColorStop(0, statusColorDim);
  statusBgGrad.addColorStop(1, '#00000000');
  fillRoundRect(pad, y, contentW, 288, 72, 'transparent');
  roundRect(pad, y, contentW, 288, 72);
  ctx.fillStyle = statusBgGrad;
  ctx.fill();
  ctx.strokeStyle = statusColor + '20';
  ctx.lineWidth = 8;
  ctx.stroke();

  const dotX = pad + 120;
  const dotY = y + 144;
  const glowSize2 = 600;
  const glowCenter2 = 300;
  const glowCanvas2 = createCanvas(glowSize2, glowSize2);
  const glowCtx2 = glowCanvas2.getContext('2d');
  glowCtx2.shadowColor = statusColor;
  glowCtx2.shadowBlur = 120;
  glowCtx2.beginPath();
  glowCtx2.arc(glowCenter2, glowCenter2, 48, 0, Math.PI * 2);
  glowCtx2.fillStyle = statusColor;
  glowCtx2.fill();
  glowCtx2.shadowBlur = 240;
  glowCtx2.fill();
  ctx.drawImage(glowCanvas2, dotX - glowCenter2, dotY - glowCenter2);

  ctx.beginPath();
  ctx.arc(dotX, dotY, 24, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.font = `bold 112px DSans`;
  ctx.fillStyle = '#e8edf3';
  ctx.fillText(statusLabel, pad + 224, y + 128);

  const timeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
  ctx.font = `bold 88px DSans`;
  ctx.fillStyle = statusColor;
  ctx.textAlign = 'right';
  ctx.fillText(timeStr, W - pad - 64, y + 136);
  ctx.textAlign = 'left';

  const queueLabel = `Черга ${queueId}`;
  const addressLine = street ? `${street}${houseNumber ? ', ' + houseNumber : ''}` : '';
  const infoLine = addressLine ? `${queueLabel}  ·  ${addressLine}` : queueLabel;
  ctx.font = `68px DSans`;
  ctx.fillStyle = '#5a7088';
  ctx.fillText(infoLine, pad + 224, y + 232);

  y += 368;

  if (hasNextChange && nextChange) {
    const changeColor = nextChange.toStatus === 'online' ? '#00e676' : nextChange.toStatus === 'offline' ? '#ff1744' : '#ffab00';
    const changeLabel = nextChange.toStatus === 'online' ? 'Увімкнення' : nextChange.toStatus === 'offline' ? 'Вимкнення' : 'Зміна';
    const minutesStr = formatMinutes(nextChange.minutesLeft);

    roundRect(pad, y, contentW, 320, 64);
    const changeBgGrad = ctx.createLinearGradient(pad, y, pad, y + 320);
    changeBgGrad.addColorStop(0, '#0a1018');
    changeBgGrad.addColorStop(1, '#0d1520');
    ctx.fillStyle = changeBgGrad;
    ctx.fill();
    ctx.strokeStyle = changeColor + '25';
    ctx.lineWidth = 8;
    ctx.stroke();

    const iconBoxW = 192;
    fillRoundRect(pad + 64, y + 64, iconBoxW, iconBoxW, 48, changeColor + '18');
    ctx.strokeStyle = changeColor + '40';
    ctx.lineWidth = 8;
    roundRect(pad + 64, y + 64, iconBoxW, iconBoxW, 48);
    ctx.stroke();

    drawBolt(ctx, pad + 64 + iconBoxW / 2, y + 64 + iconBoxW / 2, 120, changeColor);

    ctx.font = `bold 80px DSans`;
    ctx.fillStyle = '#d0dae6';
    ctx.fillText(changeLabel, pad + 320, y + 152);

    ctx.font = `64px DSans`;
    ctx.fillStyle = '#5a7088';
    ctx.fillText(`через ${minutesStr}`, pad + 320, y + 248);

    ctx.font = `bold 128px DSans`;
    ctx.fillStyle = changeColor;
    ctx.textAlign = 'right';
    ctx.fillText(nextChange.time, W - pad - 64, y + 216);
    ctx.textAlign = 'left';

    y += 384;
  }

  y += 32;
  ctx.font = `bold 56px DSans`;
  ctx.fillStyle = '#3a5068';
  ctx.fillText('ГРАФІК НА СЬОГОДНІ', pad + 16, y);
  y += 72;

  const barX = pad;
  const barW = contentW;
  const barH = 200;
  const slotW = barW / 24;

  roundRect(barX, y, barW, barH, 40);
  ctx.fillStyle = '#0a0e14';
  ctx.fill();
  ctx.strokeStyle = '#1a2636';
  ctx.lineWidth = 8;
  ctx.stroke();

  ctx.save();
  roundRect(barX, y, barW, barH, 40);
  ctx.clip();

  const slotStatuses: string[] = [];
  const slotColors: string[] = [];
  for (let h = 0; h < 24; h++) {
    const st = getCurrentHourStatus(slots, h);
    slotStatuses.push(st);
    if (st === 'online') slotColors.push('#16783a');
    else if (st === 'offline') slotColors.push('#a01525');
    else slotColors.push('#b56a00');
  }

  for (let h = 0; h < 24; h++) {
    const x1 = barX + h * slotW;
    ctx.fillStyle = slotColors[h];
    ctx.fillRect(x1, y, slotW + 1, barH);

    if (h > 0 && slotStatuses[h - 1] !== slotStatuses[h]) {
      ctx.strokeStyle = '#ffffff18';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x1, y + barH);
      ctx.stroke();
    }
  }

  const nowX = barX + (currentHour + currentMinute / 60) * slotW;
  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 32;
  ctx.strokeStyle = '#ffffffdd';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(nowX, y);
  ctx.lineTo(nowX, y + barH);
  ctx.stroke();
  ctx.restore();

  ctx.restore();

  y += barH + 40;
  ctx.font = `44px DSans`;
  ctx.fillStyle = '#3a5068';
  for (let h = 0; h <= 24; h += 6) {
    const lx = barX + h * slotW;
    ctx.textAlign = h === 24 ? 'right' : h === 0 ? 'left' : 'center';
    ctx.fillText(`${h}`, lx, y + 16);
  }
  ctx.textAlign = 'left';

  const buf = canvas.toBuffer('image/png', { compressionLevel: 1 });
  writeFileSync(outPath, buf);
  return outPath;
}

async function generateScheduleImage(
  slots: { start: string; end: string; status: string }[],
  queueId: string,
  currentHour: number,
  currentMinute: number,
  street?: string,
  houseNumber?: string,
  nextChange?: { time: string; toStatus: string; minutesLeft: number } | null,
): Promise<string> {
  try {
    const { createCanvas } = await loadCanvas();

    const S = 2;
    const W = 1600;
    const pad = 80;
    const contentW = 1440;

    const slotStatuses: string[] = [];
    for (let h = 0; h < 24; h++) {
      slotStatuses.push(getCurrentHourStatus(slots, h));
    }

    const mergedSlots: { startH: number; endH: number; status: string }[] = [];
    for (let h = 0; h < 24; h++) {
      const st = slotStatuses[h];
      if (mergedSlots.length > 0 && mergedSlots[mergedSlots.length - 1].status === st) {
        mergedSlots[mergedSlots.length - 1].endH = h + 1;
      } else {
        mergedSlots.push({ startH: h, endH: h + 1, status: st });
      }
    }

    const slotRowH = 92;
    const slotListH = mergedSlots.length * slotRowH;
    const hasNextChange = nextChange && nextChange.minutesLeft > 0;
    const H = 340 + (hasNextChange ? 170 : 0) + 180 + slotListH + 90;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const outPath = join('/tmp', `schedule_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);

    const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    const fillRoundRect = (x: number, y: number, w: number, h: number, r: number, color: string) => {
      roundRect(x, y, w, h, r);
      ctx.fillStyle = color;
      ctx.fill();
    };

    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#080c12');
    bgGrad.addColorStop(0.5, '#0c1018');
    bgGrad.addColorStop(1, '#080c12');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    roundRect(32, 24, W - 64, H - 48, 48);
    const cardGrad = ctx.createLinearGradient(0, 0, 0, H);
    cardGrad.addColorStop(0, '#111a24');
    cardGrad.addColorStop(1, '#0d1520');
    ctx.fillStyle = cardGrad;
    ctx.fill();
    ctx.strokeStyle = '#1a2636';
    ctx.lineWidth = 4;
    ctx.stroke();

    const currentStatus = getCurrentHourStatus(slots, currentHour);
    const isOn = currentStatus === 'online';
    const isOff = currentStatus === 'offline';
    const statusColor = isOn ? '#00e676' : isOff ? '#ff1744' : '#ffab00';
    const statusColorDim = isOn ? '#00e67630' : isOff ? '#ff174430' : '#ffab0030';
    const statusLabel = isOn ? 'Є СВІТЛО' : isOff ? 'НЕМАЄ СВІТЛА' : 'МОЖЛИВЕ ВИМКНЕННЯ';

    let y = 64;

    const statusBgGrad = ctx.createLinearGradient(pad, y, pad + contentW, y);
    statusBgGrad.addColorStop(0, statusColorDim);
    statusBgGrad.addColorStop(1, '#00000000');
    fillRoundRect(pad, y, contentW, 120, 36, 'transparent');
    roundRect(pad, y, contentW, 120, 36);
    ctx.fillStyle = statusBgGrad;
    ctx.fill();
    ctx.strokeStyle = statusColor + '20';
    ctx.lineWidth = 4;
    ctx.stroke();

    const dotX = pad + 60;
    const dotY = y + 60;
    const glowSize3 = 300;
    const glowCenter3 = 150;
    const glowCanvas3 = createCanvas(glowSize3, glowSize3);
    const glowCtx3 = glowCanvas3.getContext('2d');
    glowCtx3.shadowColor = statusColor;
    glowCtx3.shadowBlur = 60;
    glowCtx3.beginPath();
    glowCtx3.arc(glowCenter3, glowCenter3, 24, 0, Math.PI * 2);
    glowCtx3.fillStyle = statusColor;
    glowCtx3.fill();
    glowCtx3.shadowBlur = 120;
    glowCtx3.fill();
    ctx.drawImage(glowCanvas3, dotX - glowCenter3, dotY - glowCenter3);

    ctx.beginPath();
    ctx.arc(dotX, dotY, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.font = `bold 56px DSans`;
    ctx.fillStyle = '#e8edf3';
    ctx.fillText(statusLabel, pad + 112, y + 52);

    const timeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
    ctx.font = `bold 44px DSans`;
    ctx.fillStyle = statusColor;
    ctx.textAlign = 'right';
    ctx.fillText(timeStr, W - pad - 32, y + 56);
    ctx.textAlign = 'left';

    const queueLabel = `Черга ${queueId}`;
    const addressLine = street ? `${street}${houseNumber ? ', ' + houseNumber : ''}` : '';
    const infoLine = addressLine ? `${queueLabel}  ·  ${addressLine}` : queueLabel;
    ctx.font = `34px DSans`;
    ctx.fillStyle = '#5a7088';
    ctx.fillText(infoLine, pad + 112, y + 96);

    y += 144;

    if (hasNextChange && nextChange) {
      const changeColor = nextChange.toStatus === 'online' ? '#00e676' : nextChange.toStatus === 'offline' ? '#ff1744' : '#ffab00';
      const changeLabel = nextChange.toStatus === 'online' ? 'Увімкнення' : nextChange.toStatus === 'offline' ? 'Вимкнення' : 'Зміна';
      const minutesStr = formatMinutes(nextChange.minutesLeft);

      roundRect(pad, y, contentW, 140, 32);
      const changeBgGrad = ctx.createLinearGradient(pad, y, pad, y + 140);
      changeBgGrad.addColorStop(0, '#0a1018');
      changeBgGrad.addColorStop(1, '#0d1520');
      ctx.fillStyle = changeBgGrad;
      ctx.fill();
      ctx.strokeStyle = changeColor + '25';
      ctx.lineWidth = 4;
      ctx.stroke();

      const iconBoxW = 96;
      fillRoundRect(pad + 24, y + 24, iconBoxW, iconBoxW, 24, changeColor + '18');
      ctx.strokeStyle = changeColor + '40';
      ctx.lineWidth = 4;
      roundRect(pad + 24, y + 24, iconBoxW, iconBoxW, 24);
      ctx.stroke();

      drawBolt(ctx, pad + 24 + iconBoxW / 2, y + 24 + iconBoxW / 2, 60, changeColor);

      ctx.font = `bold 40px DSans`;
      ctx.fillStyle = '#d0dae6';
      ctx.fillText(changeLabel, pad + 144, y + 64);

      ctx.font = `32px DSans`;
      ctx.fillStyle = '#5a7088';
      ctx.fillText(`через ${minutesStr}`, pad + 144, y + 104);

      ctx.font = `bold 64px DSans`;
      ctx.fillStyle = changeColor;
      ctx.textAlign = 'right';
      ctx.fillText(nextChange.time, W - pad - 32, y + 88);
      ctx.textAlign = 'left';

      y += 160;
    }

    y += 16;
    ctx.font = `bold 28px DSans`;
    ctx.fillStyle = '#3a5068';
    ctx.fillText('ГРАФІК НА СЬОГОДНІ', pad + 8, y);
    y += 36;

    const barX = pad;
    const barW = contentW;
    const barH = 80;
    const slotW = barW / 24;

    roundRect(barX, y, barW, barH, 20);
    ctx.fillStyle = '#0a0e14';
    ctx.fill();
    ctx.strokeStyle = '#1a2636';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.save();
    roundRect(barX, y, barW, barH, 20);
    ctx.clip();

    const slotColors: string[] = [];
    for (let h = 0; h < 24; h++) {
      const st = slotStatuses[h];
      if (st === 'online') slotColors.push('#16783a');
      else if (st === 'offline') slotColors.push('#a01525');
      else slotColors.push('#b56a00');
    }

    for (let h = 0; h < 24; h++) {
      const x1 = barX + h * slotW;
      ctx.fillStyle = slotColors[h];
      ctx.fillRect(x1, y, slotW + 1, barH);

      if (h > 0) {
        if (slotStatuses[h - 1] !== slotStatuses[h]) {
          ctx.strokeStyle = '#ffffff18';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(x1, y + barH);
          ctx.stroke();
        } else {
          ctx.strokeStyle = '#00000030';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, y + 12);
          ctx.lineTo(x1, y + barH - 12);
          ctx.stroke();
        }
      }
    }

    const nowX = barX + (currentHour + currentMinute / 60) * slotW;
    ctx.save();
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 28;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(nowX, y);
    ctx.lineTo(nowX, y + barH);
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    const triSize = 16;
    ctx.beginPath();
    ctx.moveTo(nowX - triSize, y - 4);
    ctx.lineTo(nowX + triSize, y - 4);
    ctx.lineTo(nowX, y + 12);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.shadowBlur = 0;

    const labelsY = y + barH + 40;
    ctx.font = `26px DSans`;
    ctx.fillStyle = '#3a5068';
    ctx.textAlign = 'center';
    for (let h = 0; h <= 24; h += 3) {
      const x = barX + h * slotW;
      ctx.fillText(`${String(h === 24 ? 0 : h).padStart(2, '0')}:00`, x, labelsY);
    }
    ctx.textAlign = 'left';

    y = labelsY + 36;

    for (let i = 0; i < mergedSlots.length; i++) {
      const ms = mergedSlots[i];
      const rowY = y + i * slotRowH;
      const color = ms.status === 'online' ? '#00e676' : ms.status === 'offline' ? '#ff1744' : '#ffab00';
      const colorDim = ms.status === 'online' ? '#00e67612' : ms.status === 'offline' ? '#ff174412' : '#ffab0012';
      const statusText = ms.status === 'online' ? 'Є світло' : ms.status === 'offline' ? 'Немає світла' : 'Можливе';
      const startStr = `${String(ms.startH).padStart(2, '0')}:00`;
      const endStr = ms.endH === 24 ? '00:00' : `${String(ms.endH).padStart(2, '0')}:00`;
      const hours = ms.endH - ms.startH;
      const isCurrentSlot = currentHour >= ms.startH && currentHour < ms.endH;

      roundRect(pad, rowY, contentW, slotRowH - 12, 28);
      if (isCurrentSlot) {
        const slotBg = ctx.createLinearGradient(pad, rowY, pad + contentW, rowY);
        slotBg.addColorStop(0, colorDim);
        slotBg.addColorStop(1, '#00000000');
        ctx.fillStyle = slotBg;
        ctx.fill();
        ctx.strokeStyle = color + '30';
        ctx.lineWidth = 4;
        ctx.stroke();
      } else {
        ctx.fillStyle = '#0c1420';
        ctx.fill();
      }

      const rowContentH = slotRowH - 12;
      const rowCenterY = rowY + rowContentH / 2;

      fillRoundRect(pad + 28, rowY + 24, 16, rowContentH - 48, 8, color);

      if (isCurrentSlot) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 20;
        ctx.beginPath();
        ctx.arc(pad + 36, rowCenterY, 12, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(pad + 36, rowCenterY, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }

      ctx.font = `bold 38px DSans`;
      ctx.fillStyle = '#c8d6e4';
      const timeTextH = 38 * 0.35;
      ctx.fillText(`${startStr} \u2014 ${endStr}`, pad + 72, rowCenterY + timeTextH);

      ctx.font = `32px DSans`;
      ctx.fillStyle = color;
      const stW = ctx.measureText(statusText).width;
      const pillH = 60;
      const pillX = pad + 440;
      const pillY = rowCenterY - pillH / 2;
      fillRoundRect(pillX, pillY, stW + 48, pillH, 30, color + '15');
      ctx.fillStyle = color;
      const pillTextH = 32 * 0.35;
      ctx.fillText(statusText, pillX + 24, rowCenterY + pillTextH);

      ctx.font = `32px DSans`;
      ctx.fillStyle = '#3a5068';
      ctx.textAlign = 'right';
      const durText = isCurrentSlot
        ? `${hours} ${hours === 1 ? 'година' : hours < 5 ? 'години' : 'годин'}  ·  ЗАРАЗ`
        : `${hours} ${hours === 1 ? 'година' : hours < 5 ? 'години' : 'годин'}`;
      if (isCurrentSlot) ctx.fillStyle = color;
      ctx.fillText(durText, W - pad - 32, rowCenterY + pillTextH);
      ctx.textAlign = 'left';
    }

    y += slotListH + 32;

    ctx.font = `28px DSans`;
    ctx.fillStyle = '#2a3e52';
    ctx.textAlign = 'center';
    ctx.fillText('Світло Україна  \u00B7  t.me/PowerUkraineBot', W / 2, y);
    ctx.textAlign = 'left';

    const buf = canvas.toBuffer('image/png', { compressionLevel: 1 });
    writeFileSync(outPath, buf);
    return outPath;
  } catch (e: any) {
    console.error('[TG Bot] Image generation failed:', e.message);
    return '';
  }
}

function webAppUrl(sub?: Partial<Subscriber>): string {
  const base = 'https://power-ukraine.net';
  if (!sub?.chatId) return base;
  const token = generateAutoLoginToken(sub.chatId);
  return `${base}/api/auth/telegram-auto?token=${encodeURIComponent(token)}`;
}

function onlineButton(_sub?: Partial<Subscriber>) {
  return miniAppButton();
}

function notificationKeyboard(_sub?: Partial<Subscriber>) {
  return {
    inline_keyboard: [
      [miniAppButton()],
      [
        { text: '📊 Стан зараз', callback_data: 'menu_schedule' },
        { text: '📋 На весь день', callback_data: 'menu_full_schedule' },
      ],
      [
        { text: '↩️ Головне меню', callback_data: 'menu_main' },
        { text: '⚙️ Налаштування', callback_data: 'menu_settings' },
      ],
    ],
  };
}

function miniAppButton() {
  return { text: '📱 Відкрити додаток', web_app: { url: 'https://power-ukraine.net' } };
}

function mainMenuKeyboard(sub?: Partial<Subscriber>, hasLocations: boolean = false) {
  const rows: any[][] = [
    [miniAppButton()],
    [
      { text: '📊 Стан зараз', callback_data: 'menu_schedule' },
      { text: '📋 На весь день', callback_data: 'menu_full_schedule' },
    ],
  ];

  if (!hasLocations) {
    rows.push([{ text: '📍 Додати адресу', callback_data: 'loc_add_start' }]);
  } else {
    rows.push([{ text: '📊 Тижневий дайджест', callback_data: 'menu_digest' }]);
  }

  rows.push([
    { text: '🔔 Сповіщення', callback_data: 'menu_notifications' },
    { text: '⚙️ Налаштування', callback_data: 'menu_settings' },
  ]);

  return { inline_keyboard: rows };
}

function queueSelectionKeyboard(city: string = 'Вінниця', prefix: string = 'setqueue') {
  const rows: any[] = [];
  if (city === 'Київ') {
    for (let i = 1; i <= 60; i += 6) {
      const row = [];
      for (let j = i; j < i + 6 && j <= 60; j++) {
        row.push({ text: `${j}`, callback_data: `${prefix}_${j}.1` });
      }
      rows.push(row);
    }
  } else {
    for (let group = 1; group <= 6; group++) {
      rows.push([
        { text: `${group}.1`, callback_data: `${prefix}_${group}.1` },
        { text: `${group}.2`, callback_data: `${prefix}_${group}.2` },
      ]);
    }
  }
  rows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
  return { inline_keyboard: rows };
}

function notifSettingsKeyboard(sub: Subscriber) {
  const statusIcon = sub.enabled ? '🟢' : '🔴';
  const statusText = sub.enabled ? 'Увімкнено' : 'Вимкнено';
  const quietIcon = sub.quietHoursEnabled ? '🌙' : '🔇';
  const quietText = sub.quietHoursEnabled ? `${String(sub.quietHoursStart).padStart(2, '0')}:00–${String(sub.quietHoursEnd).padStart(2, '0')}:00` : 'Вимкнено';
  const briefIcon = sub.morningBriefingEnabled ? '☀️' : '📋';
  const briefText = sub.morningBriefingEnabled ? `о ${String(sub.morningBriefingHour).padStart(2, '0')}:00` : 'Вимкнено';
  const minDurText = sub.minOutageDuration > 0 ? `${sub.minOutageDuration} год` : 'Будь-яке';
  return {
    inline_keyboard: [
      [{ text: `${statusIcon} Сповіщення: ${statusText}`, callback_data: 'notif_toggle' }],
      [{ text: `⏱ До вимкнення: ${sub.notifyBeforeOff} хв`, callback_data: 'notif_off_threshold' }],
      [{ text: `⏱ До ввімкнення: ${sub.notifyBeforeOn} хв`, callback_data: 'notif_on_threshold' }],
      [{ text: `${quietIcon} Тиха година: ${quietText}`, callback_data: 'notif_quiet_hours' }],
      [{ text: `${briefIcon} Ранковий брифінг: ${briefText}`, callback_data: 'notif_briefing' }],
      [{ text: `⚡ Мін. тривалість: ${minDurText}`, callback_data: 'notif_min_duration' }],
      [{ text: '◀️ Назад', callback_data: 'menu_settings' }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
}

function thresholdKeyboard(type: 'off' | 'on') {
  const values = [5, 10, 15, 30, 45, 60, 90, 120];
  const rows = [];
  for (let i = 0; i < values.length; i += 4) {
    rows.push(values.slice(i, i + 4).map(v => ({
      text: `${v} хв`,
      callback_data: `threshold_${type}_${v}`,
    })));
  }
  rows.push([{ text: '◀️ Назад', callback_data: 'menu_notifications' }]);
  rows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
  return { inline_keyboard: rows };
}

function backToMenuKeyboard() {
  return {
    inline_keyboard: [
      [miniAppButton()],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
}

function getCurrentHourStatus(slots: { start: string; end: string; status: string }[], hour: number): string {
  for (const slot of slots) {
    const startH = parseInt(slot.start.split(':')[0]);
    const endH = slot.end === '24:00' ? 24 : parseInt(slot.end.split(':')[0]);
    if (hour >= startH && hour < endH) return slot.status;
  }
  return 'online';
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'online': return '🟢';
    case 'offline': return '🔴';
    case 'possible': return '🟡';
    default: return '⚪';
  }
}

function getStatusText(status: string): string {
  switch (status) {
    case 'online': return 'Є світло';
    case 'offline': return 'Немає світла';
    case 'possible': return 'Можливе вимкнення';
    default: return 'Невідомо';
  }
}

function formatTimelineBar(slots: { start: string; end: string; status: string }[]): string {
  const blocks: string[] = [];
  for (let h = 0; h < 24; h++) {
    const status = getCurrentHourStatus(slots, h);
    switch (status) {
      case 'online': blocks.push('🟩'); break;
      case 'offline': blocks.push('🟥'); break;
      case 'possible': blocks.push('🟨'); break;
      default: blocks.push('⬜'); break;
    }
  }
  return blocks.join('');
}

function formatTimelineNumbers(): string {
  return '0·  ·  ·  ·  ·  ·6·  ·  ·  ·  ·  ·12· ·  ·  ·  ·  ·18· ·  ·  ·  ·  ·24';
}

function findNextChange(slots: { start: string; end: string; status: string }[], nowHour: number, tomorrowSlots?: { start: string; end: string; status: string }[], nowMinute?: number): { time: string; toStatus: string; minutesLeft: number } | null {
  let currentMinute = nowMinute;
  if (currentMinute === undefined) {
    const now = new Date();
    currentMinute = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', minute: '2-digit' }));
  }

  for (const slot of slots) {
    const startH = parseInt(slot.start.split(':')[0]);
    const endH = slot.end === '24:00' ? 24 : parseInt(slot.end.split(':')[0]);

    if (nowHour >= startH && nowHour < endH) {
      if (endH < 24) {
        const nextSlot = slots.find(s => parseInt(s.start.split(':')[0]) === endH);
        const minutesLeft = (endH - nowHour) * 60 - currentMinute;
        return {
          time: `${String(endH).padStart(2, '0')}:00`,
          toStatus: nextSlot?.status || 'online',
          minutesLeft: Math.max(0, minutesLeft),
        };
      }
      if (endH === 24 && tomorrowSlots && tomorrowSlots.length > 0) {
        const tomorrowFirst = tomorrowSlots[0];
        if (tomorrowFirst && tomorrowFirst.status !== slot.status) {
          const minutesLeft = (24 - nowHour) * 60 - currentMinute;
          return {
            time: '00:00',
            toStatus: tomorrowFirst.status,
            minutesLeft: Math.max(0, minutesLeft),
          };
        }
        for (let i = 1; i < tomorrowSlots.length; i++) {
          if (tomorrowSlots[i].status !== slot.status) {
            const changeH = parseInt(tomorrowSlots[i].start.split(':')[0]);
            const minutesLeft = (24 - nowHour) * 60 - currentMinute + changeH * 60;
            return {
              time: `${String(changeH).padStart(2, '0')}:00`,
              toStatus: tomorrowSlots[i].status,
              minutesLeft: Math.max(0, minutesLeft),
            };
          }
        }
      }
    }
  }
  return null;
}

function findPeriodEndAfterChange(
  slots: { start: string; end: string; status: string }[],
  changeHour: number,
  changeToStatus: string,
  tomorrowSlots?: { start: string; end: string; status: string }[]
): { endTime: string; durationHours: number } | null {
  if (changeHour === 0 && tomorrowSlots && tomorrowSlots.length > 0) {
    let totalDuration = 0;
    for (const slot of tomorrowSlots) {
      const startH = parseInt(slot.start.split(':')[0]);
      const endH = slot.end === '24:00' ? 24 : parseInt(slot.end.split(':')[0]);
      if (startH === totalDuration && slot.status === changeToStatus) {
        totalDuration = endH;
      } else if (startH >= totalDuration) {
        break;
      }
    }
    if (totalDuration > 0) {
      const displayHour = totalDuration >= 24 ? 0 : totalDuration;
      return { endTime: `${String(displayHour).padStart(2, '0')}:00`, durationHours: totalDuration };
    }
    return null;
  }

  for (const slot of slots) {
    const startH = parseInt(slot.start.split(':')[0]);
    const endH = slot.end === '24:00' ? 24 : parseInt(slot.end.split(':')[0]);
    if (startH >= changeHour && slot.status === changeToStatus) {
      if (endH <= 24) {
        const duration = endH - startH;
        if (endH === 24) {
          if (tomorrowSlots && tomorrowSlots.length > 0) {
            if (tomorrowSlots[0].status === changeToStatus) {
              const tEndH = tomorrowSlots[0].end === '24:00' ? 24 : parseInt(tomorrowSlots[0].end.split(':')[0]);
              return { endTime: `${String(tEndH === 24 ? 0 : tEndH).padStart(2, '0')}:00`, durationHours: duration + tEndH };
            }
            return { endTime: '00:00', durationHours: duration };
          }
          return null;
        }
        return { endTime: `${String(endH).padStart(2, '0')}:00`, durationHours: duration };
      }
    }
  }
  return null;
}

function drawBolt(ctx: any, cx: number, cy: number, size: number, color: string) {
  const s = size / 24;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(-2 * s, -12 * s);
  ctx.lineTo(6 * s, -12 * s);
  ctx.lineTo(2 * s, -2 * s);
  ctx.lineTo(8 * s, -2 * s);
  ctx.lineTo(-4 * s, 12 * s);
  ctx.lineTo(-1 * s, 2 * s);
  ctx.lineTo(-7 * s, 2 * s);
  ctx.closePath();
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.5;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowBlur = 0;
  const grad = ctx.createLinearGradient(0, -12 * s, 0, 12 * s);
  grad.addColorStop(0, '#ffffff60');
  grad.addColorStop(0.5, '#ffffff00');
  grad.addColorStop(1, '#ffffff00');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
}

function formatMinutes(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h} год. ${m} хв.` : `${h} год.`;
  }
  return `${minutes} хв.`;
}

const WELCOME_IMAGE_PATH = join(process.cwd(), 'telegram-welcome-v3-compressed.jpg');

function formatFullAddress(sub: any, city: string, opts?: { bold?: boolean }): string {
  const b = opts?.bold !== false;
  const parts: string[] = [];
  parts.push(city);
  if (sub.street) {
    parts.push(`${sub.street}${sub.houseNumber ? ', ' + sub.houseNumber : ''}`);
  }
  const addr = parts.join(', ');
  return b ? `<b>${addr}</b>` : addr;
}

function formatAddressLine(sub: any, city: string): string {
  if (sub.street) {
    return `📍 ${city}, ${sub.street}${sub.houseNumber ? ', ' + sub.houseNumber : ''}`;
  }
  return `🏙 ${city}`;
}

function formatQueueLine(sub: any, city: string): string {
  const ql = queueLabel(city);
  return `⚡ ${ql}: <b>${sub.queueId}</b>`;
}

async function handleMainMenu(chatId: string, messageId?: number) {
  const sub = getSubscriber(chatId);
  let text = `⚡ <b>Світло Україна</b>\n\n`;

  let hasLocations = false;
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locations = await getUserLocations(linked.userId);
      if (locations.length > 0) {
        hasLocations = true;
        for (const loc of locations as any[]) {
          const locEmoji = getLocationEmoji(loc.name);
          const city = loc.city || 'Вінниця';
          const primary = loc.isPrimary ? ' ⭐' : '';
          const queue = loc.queueId ? ` · ${queueLabelLower(city)} ${loc.queueId}` : '';
          text += `${locEmoji} ${loc.name}${primary} — ${city}${queue}\n`;
        }
        text += `\n🔔 Сповіщення: ${sub.enabled ? '✅' : '❌'}\n`;
      }
    }
  } catch (e: any) {
    console.error('[TG Bot] handleMainMenu location lookup error:', e.message);
  }

  if (!hasLocations) {
    const city = getSubCity(sub);
    if (sub.queueId) {
      text += `${formatAddressLine(sub, city)}\n`;
      text += `${formatQueueLine(sub, city)}\n`;
      text += `🔔 Сповіщення: ${sub.enabled ? '✅' : '❌'}\n`;
    }
  }

  text += `\nОберіть дію:`;
  return replySafe(chatId, text, mainMenuKeyboard(sub, hasLocations), messageId);
}

async function handleStart(chatId: string, firstName?: string, username?: string, messageId?: number) {
  const sub = getSubscriber(chatId);
  if (firstName) updateSubscriber(chatId, { firstName, username });

  recentStarts.unshift({ chatId, firstName, username, timestamp: Date.now() });
  if (recentStarts.length > 50) recentStarts.length = 50;

  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked && sub.queueId) {
      const { migrateBotSubscriberToLocations } = await import('./storage-locations');
      await migrateBotSubscriberToLocations(linked.userId, chatId, sub);
    }
  } catch {}

  const name = firstName ? `, ${firstName}` : '';

  let text = `⚡ <b>Вітаю${name}!</b>\n\n`;
  text += `Я — бот <b>Світло Україна</b>.\n`;
  text += `Допоможу відстежувати графіки відключень електроенергії.\n\n`;

  let hasLocations = false;
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locations = await getUserLocations(linked.userId);
      if (locations.length > 0) {
        hasLocations = true;
        text += `📍 <b>Ваші локації</b> (${locations.length}):\n`;
        for (const loc of locations as any[]) {
          const locEmoji = getLocationEmoji(loc.name);
          const city = loc.city || 'Вінниця';
          const primary = loc.isPrimary ? ' ⭐' : '';
          const queue = loc.queueId ? ` · ${queueLabelLower(city)} ${loc.queueId}` : '';
          text += `${locEmoji} ${loc.name}${primary} — ${city}${queue}\n`;
        }
        text += `\n🔔 Сповіщення: ${sub.enabled ? '✅' : '❌'}\n`;
      }
    }
  } catch (e: any) {
    console.error('[TG Bot] handleStart location lookup error:', e.message);
  }

  if (!hasLocations) {
    const hasQueue = sub.queueId;
    const city = getSubCity(sub);
    if (hasQueue) {
      text += `${formatAddressLine(sub, city)}\n`;
      text += `${formatQueueLine(sub, city)}\n`;
      text += `🔔 Сповіщення: ${sub.enabled ? '✅ увімкнено' : '❌ вимкнено'}\n\n`;
    } else if (hasAddressButNoQueue(sub)) {
      text += `${formatAddressLine(sub, city)}\n`;
      text += `ℹ️ За цією адресою не знайдено графіків відключень.\n`;
      text += `Можливо, планових відключень не передбачено.\n\n`;
    } else {
      text += `👉 Додайте свою <b>адресу</b> щоб відстежувати графіки.\n\n`;
    }
  }

  text += `\nОберіть дію:`;

  return sendAndClean(chatId, () => sendPhoto(chatId, WELCOME_IMAGE_PATH, text, mainMenuKeyboard(sub, hasLocations), true), true, messageId);
}

function noQueueKeyboard() {
  return {
    inline_keyboard: [
      [miniAppButton()],
      [{ text: '📍 Додати адресу', callback_data: 'loc_add_start' }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
}

function noDataForAddressKeyboard() {
  return {
    inline_keyboard: [
      [miniAppButton()],
      [{ text: '⚙️ Налаштування', callback_data: 'menu_settings' }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
}

function hasAddressButNoQueue(sub: any): boolean {
  return !sub.queueId && !!sub.street;
}

function noDataMessage(sub: any, city: string): string {
  return `ℹ️ <b>Немає даних про відключення</b>\n\n📍 ${city}, ${sub.street}${sub.houseNumber ? ', ' + sub.houseNumber : ''}\n\nЗа цією адресою не знайдено графіків відключень в офіційних джерелах. Можливо, планових відключень не передбачено.`;
}

async function handleScheduleNow(chatId: string, messageId?: number, forceLocId?: number) {
  const sub = getSubscriber(chatId);

  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations, getUserLocationById } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locations = await getUserLocations(linked.userId);
      const withQueue = locations.filter(l => l.queueId);
      if (withQueue.length > 1 && !forceLocId) {
        let text = `📊 <b>Стан зараз</b>\n\nОберіть локацію:`;
        const rows = withQueue.map(loc => {
          const e = getLocationEmoji(loc.name);
          const addrShort = loc.street ? `, ${loc.street.substring(0, 20)}${loc.street.length > 20 ? '…' : ''}` : '';
          return [{ text: `${e} ${loc.name}${addrShort} • ${loc.queueId}`, callback_data: `sched_loc_${loc.id}` }];
        });
        rows.push([{ text: '↩️ Меню', callback_data: 'menu_main' }]);
        return replySafe(chatId, text, { inline_keyboard: rows }, messageId);
      }
      const loc = forceLocId ? withQueue.find(l => l.id === forceLocId) : withQueue[0];
      if (loc && loc.queueId) {
        return handleScheduleForLocation(chatId, loc, sub, messageId);
      }
    }
  } catch {}

  if (!sub.queueId) {
    const city = getSubCity(sub);
    if (hasAddressButNoQueue(sub)) {
      return replySafe(chatId, noDataMessage(sub, city), noDataForAddressKeyboard(), messageId);
    }
    return replySafe(chatId, '⚠️ <b>Черга не обрана</b>\n\nСпочатку оберіть чергу або адресу.', noQueueKeyboard(), messageId);
  }

  return handleScheduleForSub(chatId, sub, messageId);
}

async function handleScheduleForLocation(chatId: string, loc: any, sub: Subscriber, messageId?: number) {
  const city = loc.city || 'Вінниця';
  const addrSub = { street: loc.street, houseNumber: loc.houseNumber, queueId: loc.queueId, city };
  try {
    const schedule = getScheduleForCity(city, loc.queueId, ...(await fetchAllScheduleData()));
    if (!schedule) return replySafe(chatId, '❌ Не вдалося отримати розклад.', backToMenuKeyboard(), messageId);
    const now = new Date();
    const kyivHour = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }));
    const kyivMinute = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', minute: '2-digit' }));
    const today = schedule.days[0];
    if (!today) return replySafe(chatId, '❌ Немає даних про розклад на сьогодні.', backToMenuKeyboard(), messageId);
    const currentStatus = getCurrentHourStatus(today.slots, kyivHour);
    const tomorrow = schedule.days[1];
    const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots);
    const updateTime = schedule.updateTime || new Date(schedule.lastUpdated).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
    const cacheKey = `status-${city}-${loc.queueId}-${kyivHour}-${kyivMinute}-${today.date}`;
    let imgPath = getCachedImage(cacheKey);
    if (!imgPath) {
      const loadingText = `⏳ <b>Генерую графік...</b>\n\n${getLocationEmoji(loc.name)} <b>${loc.name}</b>\n\n<i>Зачекайте кілька секунд</i>`;
      const lr = await sendMessage(chatId, loadingText);
      const loadingMsgId = lr?.result?.message_id;
      if (loadingMsgId) trackBotMsg(chatId, loadingMsgId);
      imgPath = await generateStatusImage(today.slots, loc.queueId, kyivHour, kyivMinute, loc.street, loc.houseNumber, nextChange);
      setCachedImage(cacheKey, imgPath);
    }
    const statusEmoji = currentStatus === 'online' ? '🟢' : currentStatus === 'offline' ? '🔴' : '🟡';
    const statusText = getStatusText(currentStatus);
    const locEmoji = getLocationEmoji(loc.name);
    const nextInfo = nextChange && nextChange.minutesLeft > 0
      ? `\n⏱ ${nextChange.toStatus === 'online' ? 'Увімкнення' : 'Вимкнення'} о ${nextChange.time} (через ${formatMinutes(nextChange.minutesLeft)})`
      : '';
    const caption = `${statusEmoji} <b>${statusText}</b>\n${locEmoji} <b>${loc.name}</b>\n${formatAddressLine(addrSub, city)}\n${formatQueueLine(addrSub, city)}${nextInfo}\n\n<i>Оновлено: ${updateTime}</i>`;
    const kb = {
      inline_keyboard: [
        [onlineButton(sub)],
        [
          { text: '🔄 Оновити', callback_data: `sched_loc_${loc.id}` },
          { text: '📋 На весь день', callback_data: `fullsched_loc_${loc.id}` },
        ],
        [{ text: '↩️ Меню', callback_data: 'menu_main' }],
      ],
    };
    return sendAndClean(chatId, () => sendPhoto(chatId, imgPath, caption, kb, true), false, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Schedule for location error:', e.message);
    return sendAndClean(chatId, () => sendMessage(chatId, '❌ Не вдалося отримати дані. Спробуйте пізніше.', backToMenuKeyboard()), false, messageId);
  }
}

async function handleScheduleForSub(chatId: string, sub: Subscriber, messageId?: number) {
  if (!sub.queueId) {
    const city = getSubCity(sub);
    if (hasAddressButNoQueue(sub)) return replySafe(chatId, noDataMessage(sub, city), noDataForAddressKeyboard(), messageId);
    return replySafe(chatId, '⚠️ <b>Черга не обрана</b>\n\nСпочатку оберіть чергу або адресу.', noQueueKeyboard(), messageId);
  }
  try {
    const schedule = await fetchScheduleForSub(sub);
    if (!schedule) {
      return replySafe(chatId, '❌ Не вдалося отримати розклад.', backToMenuKeyboard(), messageId);
    }

    const now = new Date();
    const kyivHour = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }));
    const kyivMinute = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', minute: '2-digit' }));

    const today = schedule.days[0];
    if (!today) {
      return replySafe(chatId, '❌ Немає даних про розклад на сьогодні.', backToMenuKeyboard(), messageId);
    }

    const city = getSubCity(sub);
    const currentStatus = getCurrentHourStatus(today.slots, kyivHour);
    const tomorrow = schedule.days[1];
    const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots);
    const updateTime = schedule.updateTime || new Date(schedule.lastUpdated).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    const cacheKey = `status-${city}-${sub.queueId}-${kyivHour}-${kyivMinute}-${today.date}`;
    let imgPath = getCachedImage(cacheKey);
    let loadingMsgId: number | undefined;
    if (!imgPath) {
      const addrLabel = formatFullAddress(sub, city, { bold: false });
      const loadingText = `⏳ <b>Генерую графік...</b>\n\n📍 ${addrLabel}\n\n<i>Зачекайте кілька секунд</i>`;
      const lr = await sendMessage(chatId, loadingText);
      loadingMsgId = lr?.result?.message_id;
      if (loadingMsgId) trackBotMsg(chatId, loadingMsgId);
      imgPath = await generateStatusImage(today.slots, sub.queueId!, kyivHour, kyivMinute, sub.street, sub.houseNumber, nextChange);
      setCachedImage(cacheKey, imgPath);
    }

    const statusEmoji = currentStatus === 'online' ? '🟢' : currentStatus === 'offline' ? '🔴' : '🟡';
    const statusText = getStatusText(currentStatus);
    const nextInfo = nextChange && nextChange.minutesLeft > 0
      ? `\n⏱ ${nextChange.toStatus === 'online' ? 'Увімкнення' : 'Вимкнення'} о ${nextChange.time} (через ${formatMinutes(nextChange.minutesLeft)})`
      : '';

    const caption = `${statusEmoji} <b>${statusText}</b>\n${formatAddressLine(sub, city)}\n${formatQueueLine(sub, city)}${nextInfo}\n\n<i>Оновлено: ${updateTime}</i>`;

    const kb = {
      inline_keyboard: [
        [onlineButton(sub)],
        [
          { text: '🔄 Оновити', callback_data: 'menu_schedule' },
          { text: '📋 На весь день', callback_data: 'menu_full_schedule' },
        ],
        [{ text: '↩️ Меню', callback_data: 'menu_main' }],
      ],
    };
    return sendAndClean(chatId, () => sendPhoto(chatId, imgPath, caption, kb, true), false, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Schedule error:', e.message);
    return sendAndClean(chatId, () => sendMessage(chatId, '❌ Не вдалося отримати дані. Спробуйте пізніше.', backToMenuKeyboard()), false, messageId);
  }
}

async function fetchAllScheduleData(): Promise<[any, any, any, any]> {
  const [voeResult, kyivResult, kharkivResult, odesaResult] = await Promise.allSettled([
    fetchVoeData(), fetchKyivPlannedData(), fetchKharkivScheduleData(), fetchOdesaScheduleData(),
  ]);
  return [
    voeResult.status === 'fulfilled' ? voeResult.value : null,
    kyivResult.status === 'fulfilled' ? kyivResult.value : null,
    kharkivResult.status === 'fulfilled' ? kharkivResult.value : null,
    odesaResult.status === 'fulfilled' ? odesaResult.value : null,
  ];
}

async function handleFullSchedule(chatId: string, messageId?: number, forceLocId?: number) {
  const sub = getSubscriber(chatId);

  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locations = await getUserLocations(linked.userId);
      const withQueue = locations.filter(l => l.queueId);
      if (withQueue.length > 1 && !forceLocId) {
        let text = `📋 <b>Графік на весь день</b>\n\nОберіть локацію:`;
        const rows = withQueue.map(loc => {
          const e = getLocationEmoji(loc.name);
          const addrShort = loc.street ? `, ${loc.street.substring(0, 20)}${loc.street.length > 20 ? '…' : ''}` : '';
          return [{ text: `${e} ${loc.name}${addrShort} • ${loc.queueId}`, callback_data: `fullsched_loc_${loc.id}` }];
        });
        rows.push([{ text: '↩️ Меню', callback_data: 'menu_main' }]);
        return replySafe(chatId, text, { inline_keyboard: rows }, messageId);
      }
      const loc = forceLocId ? withQueue.find(l => l.id === forceLocId) : withQueue[0];
      if (loc && loc.queueId) {
        return handleFullScheduleForLocation(chatId, loc, sub, messageId);
      }
    }
  } catch {}

  if (!sub.queueId) {
    const city = getSubCity(sub);
    if (hasAddressButNoQueue(sub)) {
      return replySafe(chatId, noDataMessage(sub, city), noDataForAddressKeyboard(), messageId);
    }
    return replySafe(chatId, '⚠️ <b>Черга не обрана</b>\n\nСпочатку оберіть чергу або адресу.', noQueueKeyboard(), messageId);
  }

  return handleFullScheduleForSub(chatId, sub, messageId);
}

async function handleFullScheduleForLocation(chatId: string, loc: any, sub: Subscriber, messageId?: number) {
  const city = loc.city || 'Вінниця';
  const addrSub = { street: loc.street, houseNumber: loc.houseNumber, queueId: loc.queueId, city };
  try {
    const schedule = getScheduleForCity(city, loc.queueId, ...(await fetchAllScheduleData()));
    if (!schedule) return replySafe(chatId, '❌ Не вдалося отримати розклад.', backToMenuKeyboard(), messageId);
    const now = new Date();
    const kyivHour = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }));
    const kyivMinute = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', minute: '2-digit' }));
    const today = schedule.days[0];
    if (!today) return replySafe(chatId, '❌ Немає даних про розклад на сьогодні.', backToMenuKeyboard(), messageId);
    const tomorrow = schedule.days[1];
    const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots);
    const fullCacheKey = `full-${city}-${loc.queueId}-${kyivHour}-${kyivMinute}-${today.date}`;
    let imgPath = getCachedImage(fullCacheKey);
    if (!imgPath) {
      const loadingText = `⏳ <b>Генерую повний графік...</b>\n\n${getLocationEmoji(loc.name)} <b>${loc.name}</b>\n\n<i>Зачекайте кілька секунд</i>`;
      const lr = await sendMessage(chatId, loadingText);
      const loadingMsgId = lr?.result?.message_id;
      if (loadingMsgId) trackBotMsg(chatId, loadingMsgId);
      imgPath = await generateScheduleImage(today.slots, loc.queueId, kyivHour, kyivMinute, loc.street, loc.houseNumber, nextChange);
      setCachedImage(fullCacheKey, imgPath);
    }
    const updateTime = schedule.updateTime || new Date(schedule.lastUpdated).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
    const currentStatus = getCurrentHourStatus(today.slots, kyivHour);
    const statusEmoji = currentStatus === 'online' ? '🟢' : currentStatus === 'offline' ? '🔴' : '🟡';
    const statusText = getStatusText(currentStatus);
    const locEmoji = getLocationEmoji(loc.name);
    const nextInfo = nextChange && nextChange.minutesLeft > 0
      ? `\n⏱ ${nextChange.toStatus === 'online' ? 'Увімкнення' : 'Вимкнення'} о ${nextChange.time} (через ${formatMinutes(nextChange.minutesLeft)})`
      : '';
    const caption = `${statusEmoji} <b>${statusText}</b>\n${locEmoji} <b>${loc.name}</b>\n${formatAddressLine(addrSub, city)}\n${formatQueueLine(addrSub, city)}${nextInfo}\n\n<i>Оновлено: ${updateTime}</i>`;
    const kb = {
      inline_keyboard: [
        [onlineButton(sub)],
        [
          { text: '🔄 Оновити', callback_data: `fullsched_loc_${loc.id}` },
          { text: '📊 Стан зараз', callback_data: `sched_loc_${loc.id}` },
        ],
        [{ text: '↩️ Меню', callback_data: 'menu_main' }],
      ],
    };
    if (imgPath) {
      return sendAndClean(chatId, () => sendPhoto(chatId, imgPath!, caption, kb, true), false, messageId);
    }
    return sendAndClean(chatId, () => sendMessage(chatId, caption, kb), false, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Full schedule for location error:', e.message);
    return sendAndClean(chatId, () => sendMessage(chatId, '❌ Не вдалося отримати дані. Спробуйте пізніше.', backToMenuKeyboard()), false, messageId);
  }
}

async function handleFullScheduleForSub(chatId: string, sub: Subscriber, messageId?: number) {
  if (!sub.queueId) {
    const city = getSubCity(sub);
    if (hasAddressButNoQueue(sub)) return replySafe(chatId, noDataMessage(sub, city), noDataForAddressKeyboard(), messageId);
    return replySafe(chatId, '⚠️ <b>Черга не обрана</b>\n\nСпочатку оберіть чергу або адресу.', noQueueKeyboard(), messageId);
  }
  try {
    const schedule = await fetchScheduleForSub(sub);
    if (!schedule) {
      return replySafe(chatId, '❌ Не вдалося отримати розклад.', backToMenuKeyboard(), messageId);
    }

    const now = new Date();
    const kyivHour = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }));
    const kyivMinute = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', minute: '2-digit' }));

    const today = schedule.days[0];
    if (!today) {
      return replySafe(chatId, '❌ Немає даних про розклад на сьогодні.', backToMenuKeyboard(), messageId);
    }

    const city = getSubCity(sub);
    const tomorrow = schedule.days[1];
    const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots);
    const fullCacheKey = `full-${city}-${sub.queueId}-${kyivHour}-${kyivMinute}-${today.date}`;
    let imgPath = getCachedImage(fullCacheKey);
    let loadingMsgId: number | undefined;
    if (!imgPath) {
      const addrLabel = formatFullAddress(sub, city, { bold: false });
      const loadingText = `⏳ <b>Генерую повний графік...</b>\n\n📍 ${addrLabel}\n\n<i>Зачекайте кілька секунд</i>`;
      const lr = await sendMessage(chatId, loadingText);
      loadingMsgId = lr?.result?.message_id;
      if (loadingMsgId) trackBotMsg(chatId, loadingMsgId);
      imgPath = await generateScheduleImage(today.slots, sub.queueId!, kyivHour, kyivMinute, sub.street, sub.houseNumber, nextChange);
      setCachedImage(fullCacheKey, imgPath);
    }

    const updateTime = schedule.updateTime || new Date(schedule.lastUpdated).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
    const currentStatus = getCurrentHourStatus(today.slots, kyivHour);
    const statusEmoji = currentStatus === 'online' ? '🟢' : currentStatus === 'offline' ? '🔴' : '🟡';
    const statusText = getStatusText(currentStatus);
    const nextInfo = nextChange && nextChange.minutesLeft > 0
      ? `\n⏱ ${nextChange.toStatus === 'online' ? 'Увімкнення' : 'Вимкнення'} о ${nextChange.time} (через ${formatMinutes(nextChange.minutesLeft)})`
      : '';
    const caption = `${statusEmoji} <b>${statusText}</b>\n${formatAddressLine(sub, city)}\n${formatQueueLine(sub, city)}${nextInfo}\n\n<i>Оновлено: ${updateTime}</i>`;

    const kb = {
      inline_keyboard: [
        [onlineButton(sub)],
        [
          { text: '🔄 Оновити', callback_data: 'menu_full_schedule' },
          { text: '📊 Стан зараз', callback_data: 'menu_schedule' },
        ],
        [{ text: '↩️ Меню', callback_data: 'menu_main' }],
      ],
    };

    if (loadingMsgId) {
      tgApi('deleteMessage', { chat_id: chatId, message_id: loadingMsgId }).catch(() => {});
    }
    if (imgPath) {
      return sendAndClean(chatId, () => sendPhoto(chatId, imgPath!, caption, kb, true), false, messageId);
    }

    const fallbackText = `${statusEmoji} <b>${statusText}</b>\n${formatAddressLine(sub, city)}\n${formatQueueLine(sub, city)}${nextInfo}\n\n<i>Оновлено: ${updateTime}</i>`;
    return sendAndClean(chatId, () => sendMessage(chatId, fallbackText, kb), false, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Full schedule error:', e.message);
    return sendAndClean(chatId, () => sendMessage(chatId, '❌ Не вдалося отримати дані. Спробуйте пізніше.', backToMenuKeyboard()), false, messageId);
  }
}

async function handleQueueSelection(chatId: string, messageId?: number) {
  const sub = getSubscriber(chatId);
  const city = getSubCity(sub);
  const ql = queueLabelLower(city);
  const current = sub.queueId ? `\n\n📌 Поточна ${ql}: <b>${sub.queueId}</b>` : '';
  const text = `⚡ <b>Оберіть ${ql} відключень</b>${current}\n\nОберіть номер вашої ${ql}:`;
  return replySafe(chatId, text, queueSelectionKeyboard(city), messageId);
}

async function handleSetQueue(chatId: string, queueId: string, messageId?: number) {
  updateSubscriber(chatId, { queueId, lookupMode: 'queue' });
  const sub = getSubscriber(chatId);
  const city = getSubCity(sub);
  const ql = queueLabelLower(city);
  const text = `✅ <b>${queueLabel(city)} встановлено: ${queueId}</b>\n\n🔔 Ви отримуватимете сповіщення для цієї ${ql}.`;
  const kb = {
    inline_keyboard: [
      [miniAppButton()],
      [{ text: '📊 Стан зараз', callback_data: 'menu_schedule' }],
      [{ text: '🔔 Налаштувати сповіщення', callback_data: 'menu_notifications' }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
  return replySafe(chatId, text, kb, messageId);
}

async function handleAddressMenu(chatId: string, messageId?: number) {
  userStates.set(chatId, { step: 'awaiting_street' });
  const text = `📍 <b>Пошук за адресою</b>\n\n🔤 Введіть назву вулиці (мінімум 2 символи).\n\n<i>Наприклад: Соборна, Космонавтів, Замостянська</i>`;
  const kb = {
    inline_keyboard: [[{ text: '↩️ Скасувати', callback_data: 'menu_main' }]],
  };
  return replySafe(chatId, text, kb, messageId);
}

async function handleStreetSearch(chatId: string, query: string) {
  try {
    const sub = getSubscriber(chatId);
    const city = getSubCity(sub);
    const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/geocode/streets?q=${encodeURIComponent(query)}&city=${encodeURIComponent(city)}`);
    const streets: string[] = await resp.json();

    if (streets.length === 0) {
      const text = `❌ Вулицю "<b>${query}</b>" не знайдено.\n\n🔤 Спробуйте ще раз:`;
      const kb = {
        inline_keyboard: [[{ text: '↩️ Скасувати', callback_data: 'menu_main' }]],
      };
      return sendAndClean(chatId, () => sendMessage(chatId, text, kb));
    }

    const displayStreets = streets.slice(0, 8);
    userStates.set(chatId, { step: 'pick_street', data: { streets: displayStreets } });

    const rows = displayStreets.map((s, i) => {
      const label = s.length > 35 ? s.substring(0, 32) + '...' : s;
      return [{ text: `📍 ${label}`, callback_data: `street_${i}` }];
    });
    rows.push([{ text: '🔄 Нова назва', callback_data: 'menu_address' }]);
    rows.push([{ text: '↩️ Скасувати', callback_data: 'menu_main' }]);

    const text = `🔍 <b>Знайдені вулиці для "${query}":</b>\n\nОберіть вашу вулицю:`;
    return sendAndClean(chatId, () => sendMessage(chatId, text, { inline_keyboard: rows }));
  } catch {
    userStates.delete(chatId);
    return sendAndClean(chatId, () => sendMessage(chatId, '❌ Помилка пошуку. Спробуйте пізніше.', backToMenuKeyboard()));
  }
}

async function handleStreetSelected(chatId: string, street: string, messageId?: number) {
  userStates.set(chatId, { step: 'awaiting_house', data: { street } });

  try {
    const sub = getSubscriber(chatId);
    const city = getSubCity(sub);
    const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/geocode/houses?street=${encodeURIComponent(street)}&city=${encodeURIComponent(city)}`);
    const houses: string[] = await resp.json();

    let text = `📍 Вулиця: <b>${street}</b>\n\n`;

    if (houses.length > 0) {
      text += `🏠 Оберіть номер будинку або введіть свій:`;
      const rows: any[] = [];
      const chunk = houses.slice(0, 24);
      for (let i = 0; i < chunk.length; i += 4) {
        rows.push(chunk.slice(i, i + 4).map(h => ({
          text: h,
          callback_data: `house_${h}`,
        })));
      }
      rows.push([{ text: '⏭ Без номера будинку', callback_data: 'house_skip' }]);
      rows.push([{ text: '↩️ Скасувати', callback_data: 'menu_main' }]);

      return replySafe(chatId, text, { inline_keyboard: rows }, messageId);
    } else {
      text += `🏠 Введіть номер будинку або натисніть "Пропустити":`;
      const kb = {
        inline_keyboard: [
          [{ text: '⏭ Пропустити', callback_data: 'house_skip' }],
          [{ text: '↩️ Скасувати', callback_data: 'menu_main' }],
        ],
      };
      return replySafe(chatId, text, kb, messageId);
    }
  } catch {
    userStates.delete(chatId);
    return sendAndClean(chatId, () => sendMessage(chatId, '❌ Помилка. Спробуйте пізніше.', backToMenuKeyboard()), false, messageId);
  }
}

async function handleHouseSelected(chatId: string, house: string, messageId?: number) {
  const state = userStates.get(chatId);
  if (!state?.data?.street) {
    userStates.delete(chatId);
    return sendAndClean(chatId, () => sendMessage(chatId, '⚠️ Помилка стану. Почніть спочатку.', backToMenuKeyboard()), false, messageId);
  }

  const street = state.data.street;
  userStates.delete(chatId);

  try {
    const sub = getSubscriber(chatId);
    const city = getSubCity(sub);
    const params = new URLSearchParams({ street, city });
    if (house) params.set('house', house);
    const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/address-queue?${params}`);
    const data = await resp.json();

    if (data.queueId) {
      updateSubscriber(chatId, {
        street,
        houseNumber: house,
        queueId: data.queueId,
        lookupMode: 'address',
      });

      const text = `✅ <b>Адресу збережено!</b>\n\n📍 ${city}, ${street}${house ? ', ' + house : ''}\n⚡ ${queueLabel(city)}: <b>${data.queueId}</b>\n\n🔔 Ви отримуватимете сповіщення для цієї адреси.`;
      const kb = {
        inline_keyboard: [
          [miniAppButton()],
          [{ text: '📊 Стан зараз', callback_data: 'menu_schedule' }],
          [{ text: '🔔 Налаштувати сповіщення', callback_data: 'menu_notifications' }],
          [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
        ],
      };
      return replySafe(chatId, text, kb, messageId);
    }

    if (data.alternatives && data.alternatives.length > 0) {
      userStates.set(chatId, { step: 'pick_queue', data: { street, house } });
      const rows = data.alternatives.map((q: string) => [
        { text: `⚡ Черга ${q}`, callback_data: `addrqueue_${q}` },
      ]);
      rows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);

      const text = `📍 ${city}, ${street}${house ? ', ' + house : ''}\n\n⚠️ Знайдено кілька черг для цієї адреси.\nОберіть вашу чергу:`;
      return replySafe(chatId, text, { inline_keyboard: rows }, messageId);
    }

    updateSubscriber(chatId, { street, houseNumber: house, lookupMode: 'address' });
    const text = `📍 Адресу збережено: <b>${city}, ${street}${house ? ', ' + house : ''}</b>\n\nℹ️ Графіків відключень для цієї адреси поки не знайдено. Як тільки з'являться — ми почнемо відстежувати.\n\nАбо оберіть чергу вручну:`;
    const kb = queueSelectionKeyboard(city, 'addrsetqueue');
    return replySafe(chatId, text, kb, messageId);
  } catch {
    return sendAndClean(chatId, () => sendMessage(chatId, '❌ Помилка визначення черги. Спробуйте пізніше.', backToMenuKeyboard()), false, messageId);
  }
}

async function handleNotifications(chatId: string, messageId?: number) {
  const sub = getSubscriber(chatId);

  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locations = await getUserLocations(linked.userId);
      if (locations.length > 0) {
        let text = `🔔 <b>Налаштування сповіщень</b>\n\n`;
        text += `${sub.enabled ? '✅ Telegram-сповіщення увімкнено' : '❌ Telegram-сповіщення вимкнено'}\n`;
        text += `⏱ Попередження: ${sub.notifyBeforeOff}/${sub.notifyBeforeOn} хв\n`;
        if (sub.quietHoursEnabled) {
          text += `🌙 Тиха година: ${String(sub.quietHoursStart).padStart(2, '0')}:00–${String(sub.quietHoursEnd).padStart(2, '0')}:00\n`;
        }
        if (sub.morningBriefingEnabled) {
          text += `☀️ Ранковий брифінг: о ${String(sub.morningBriefingHour).padStart(2, '0')}:00\n`;
        }
        if (sub.minOutageDuration > 0) {
          text += `⚡ Мін. тривалість: ${sub.minOutageDuration} год\n`;
        }
        text += `\n<b>Сповіщення по локаціях:</b>\n`;
        for (const loc of locations as any[]) {
          const locEmoji = getLocationEmoji(loc.name);
          const pushIcon = loc.notifyEnabled ? '✅' : '❌';
          const tgIcon = loc.telegramNotify ? '✅' : '❌';
          text += `${locEmoji} ${loc.name}\n    🔔 Push: ${pushIcon}  ·  📱 Telegram: ${tgIcon}\n`;
        }

        const quietIcon = sub.quietHoursEnabled ? '🌙' : '🔇';
        const quietText = sub.quietHoursEnabled ? `${String(sub.quietHoursStart).padStart(2, '0')}:00–${String(sub.quietHoursEnd).padStart(2, '0')}:00` : 'Вимкнено';
        const briefIcon = sub.morningBriefingEnabled ? '☀️' : '📋';
        const briefText = sub.morningBriefingEnabled ? `о ${String(sub.morningBriefingHour).padStart(2, '0')}:00` : 'Вимкнено';
        const minDurText = sub.minOutageDuration > 0 ? `${sub.minOutageDuration} год` : 'Будь-яке';

        const kbRows: any[][] = [
          [{ text: `${sub.enabled ? '🟢' : '🔴'} Telegram: ${sub.enabled ? 'Увімкнено' : 'Вимкнено'}`, callback_data: 'notif_toggle' }],
          [{ text: `⏱ До вимкнення: ${sub.notifyBeforeOff} хв`, callback_data: 'notif_off_threshold' }],
          [{ text: `⏱ До ввімкнення: ${sub.notifyBeforeOn} хв`, callback_data: 'notif_on_threshold' }],
          [{ text: `${quietIcon} Тиха година: ${quietText}`, callback_data: 'notif_quiet_hours' }],
          [{ text: `${briefIcon} Ранковий брифінг: ${briefText}`, callback_data: 'notif_briefing' }],
          [{ text: `⚡ Мін. тривалість: ${minDurText}`, callback_data: 'notif_min_duration' }],
        ];
        for (const loc of locations as any[]) {
          const locEmoji = getLocationEmoji(loc.name);
          kbRows.push([
            { text: `${locEmoji} ${loc.name}`, callback_data: `locmenu_${loc.id}` },
          ]);
          kbRows.push([
            { text: `🔔 Push: ${loc.notifyEnabled ? '✅' : '❌'}`, callback_data: `notifpush_${loc.id}` },
            { text: `📱 Telegram: ${loc.telegramNotify ? '✅' : '❌'}`, callback_data: `notiftg_${loc.id}` },
          ]);
        }
        kbRows.push([{ text: '◀️ Назад', callback_data: 'menu_settings' }]);
        kbRows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
        return replySafe(chatId, text, { inline_keyboard: kbRows }, messageId);
      }
    }
  } catch {}

  const city = getSubCity(sub);
  const ql = queueLabel(city);
  const notifAddr = sub.queueId
    ? `\n${formatAddressLine(sub, city)}\n${formatQueueLine(sub, city)}`
    : hasAddressButNoQueue(sub)
      ? `\n${formatAddressLine(sub, city)}\nℹ️ Графіків відключень не знайдено`
      : `\n⚠️ ${ql} не обрана`;
  let flexLines = '';
  if (sub.quietHoursEnabled) {
    flexLines += `\n🌙 Тиха година: ${String(sub.quietHoursStart).padStart(2, '0')}:00–${String(sub.quietHoursEnd).padStart(2, '0')}:00`;
  }
  if (sub.morningBriefingEnabled) {
    flexLines += `\n☀️ Ранковий брифінг: о ${String(sub.morningBriefingHour).padStart(2, '0')}:00`;
  }
  if (sub.minOutageDuration > 0) {
    flexLines += `\n⚡ Мін. тривалість: ${sub.minOutageDuration} год`;
  }
  const text = `🔔 <b>Налаштування сповіщень</b>\n\n${sub.enabled ? '✅ Сповіщення увімкнено' : '❌ Сповіщення вимкнено'}\n⏱ Попередження до вимкнення: <b>${sub.notifyBeforeOff} хв</b>\n⏱ Попередження до ввімкнення: <b>${sub.notifyBeforeOn} хв</b>${flexLines}\n${notifAddr}`;
  return replySafe(chatId, text, notifSettingsKeyboard(sub), messageId);
}

async function handleSettings(chatId: string, messageId?: number) {
  const sub = getSubscriber(chatId);
  let text = `⚙️ <b>Ваші налаштування</b>\n\n`;
  let hasLocations = false;
  let locCount = 0;

  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locations = await getUserLocations(linked.userId);
      if (locations.length > 0) {
        hasLocations = true;
        locCount = locations.length;
        for (const loc of locations) {
          const locEmoji = getLocationEmoji(loc.name);
          const primary = loc.isPrimary ? ' ⭐' : '';
          const city = (loc as any).city || 'Вінниця';
          const queue = loc.queueId ? ` · ${queueLabelLower(city)} ${loc.queueId}` : '';
          text += `${locEmoji} ${loc.name}${primary} — ${city}${queue}\n`;
        }
        text += `\n🔔 Сповіщення: ${sub.enabled ? '✅' : '❌'}  ⏱ ${sub.notifyBeforeOff}/${sub.notifyBeforeOn} хв`;
        if (sub.quietHoursEnabled) text += `\n🌙 Тиха: ${String(sub.quietHoursStart).padStart(2, '0')}:00–${String(sub.quietHoursEnd).padStart(2, '0')}:00`;
        if (sub.morningBriefingEnabled) text += `\n☀️ Брифінг: ${String(sub.morningBriefingHour).padStart(2, '0')}:00`;
        if (sub.minOutageDuration > 0) text += `\n⚡ Мін: ${sub.minOutageDuration} год`;
        text += '\n';
      }
    }
  } catch {}

  if (hasLocations) {
    const kb = {
      inline_keyboard: [
        [miniAppButton()],
        [{ text: '📍 Керувати локаціями', callback_data: 'menu_all_locations' }],
        [{ text: '🔔 Налаштувати сповіщення', callback_data: 'menu_notifications' }],
        [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
      ],
    };
    return replySafe(chatId, text, kb, messageId);
  }

  const city = getSubCity(sub);
  const ql = queueLabel(city);

  text += `${formatAddressLine(sub, city)}\n`;
  if (sub.queueId) {
    text += `${formatQueueLine(sub, city)}\n`;
  } else if (hasAddressButNoQueue(sub)) {
    text += `ℹ️ Графіків відключень не знайдено\n`;
  } else {
    text += `⚡ ${ql}: <i>не обрана</i>\n`;
  }
  text += `\n🔔 Сповіщення: ${sub.enabled ? '✅' : '❌'}\n`;
  text += `⏱ До вимкнення: <b>${sub.notifyBeforeOff} хв</b>\n`;
  text += `⏱ До ввімкнення: <b>${sub.notifyBeforeOn} хв</b>\n`;

  const kb = {
    inline_keyboard: [
      [miniAppButton()],
      [{ text: `🏙 Змінити місто (${city})`, callback_data: 'settings_city' }],
      [
        { text: `⚡ Змінити ${queueLabelLower(city)}`, callback_data: 'menu_queue' },
        { text: '📍 Змінити адресу', callback_data: 'menu_address' },
      ],
      [{ text: '🔔 Налаштувати сповіщення', callback_data: 'menu_notifications' }],
      [{ text: '🗑 Скинути все', callback_data: 'settings_reset' }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
  return replySafe(chatId, text, kb, messageId);
}

function getLocationEmoji(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('дім') || lower.includes('дом') || lower.includes('home')) return '🏠';
  if (lower.includes('робот') || lower.includes('офіс') || lower.includes('work') || lower.includes('office')) return '🏢';
  if (lower.includes('батьк') || lower.includes('мам') || lower.includes('тат')) return '👨‍👩‍👧';
  if (lower.includes('навчан') || lower.includes('універ') || lower.includes('школ')) return '🎓';
  if (lower.includes('дач') || lower.includes('село')) return '🏡';
  return '📍';
}

async function handleAbout(chatId: string, messageId?: number) {
  const text = `ℹ️ <b>Про бот «Світло Україна»</b>\n\n⚡ Бот відстежує графіки планових відключень електроенергії.\n\n🔹 Показує поточний стан світла\n🔹 Розклад на день у вигляді таймлайну\n🔹 Зворотній відлік до зміни стану\n🔹 Сповіщення перед вимкненням/ввімкненням\n🔹 Пошук за адресою або номером черги\n\n📊 Дані оновлюються кожні 10 хвилин з офіційних джерел.\n\n👨‍💻 Розробник: @oleksandr_hohaizel\n🌐 Веб-додаток: https://power-ukraine.net`;
  return replySafe(chatId, text, backToMenuKeyboard(), messageId);
}

async function handleSettingsReset(chatId: string, messageId?: number) {
  const text = `⚠️ <b>Скинути всі налаштування?</b>\n\nЦе видалить вашу чергу, адресу та налаштування сповіщень.`;
  const kb = {
    inline_keyboard: [
      [
        { text: '✅ Так, скинути', callback_data: 'confirm_reset' },
        { text: '❌ Скасувати', callback_data: 'menu_settings' },
      ],
    ],
  };
  return replySafe(chatId, text, kb, messageId);
}

async function handleReport(chatId: string) {
  const sub = getSubscriber(chatId);

  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locations = await getUserLocations(linked.userId);
      const withQueue = locations.filter(l => l.queueId);
      if (withQueue.length > 0) {
        if (withQueue.length === 1) {
          const loc = withQueue[0];
          const city = loc.city || 'Вінниця';
          const text = `⚡ <b>Повідомити про стан світла</b>\n\n📍 <b>${loc.name}</b> — ${city}, черга ${loc.queueId}\n\nОберіть поточний стан:`;
          const kb = {
            inline_keyboard: [
              [
                { text: '💡 Є світло', callback_data: `report_power_${city}_${loc.queueId}_true` },
                { text: '🔌 Немає світла', callback_data: `report_power_${city}_${loc.queueId}_false` },
              ],
              [{ text: '↩️ Назад', callback_data: 'menu_main' }],
            ],
          };
          return sendAndClean(chatId, () => sendMessage(chatId, text, kb));
        }
        let text = `⚡ <b>Повідомити про стан світла</b>\n\nОберіть локацію:`;
        const rows = withQueue.map(loc => {
          const city = loc.city || 'Вінниця';
          return [{ text: `📍 ${loc.name} (${city}, ${loc.queueId})`, callback_data: `report_loc_${loc.id}` }];
        });
        rows.push([{ text: '↩️ Назад', callback_data: 'menu_main' }]);
        return sendAndClean(chatId, () => sendMessage(chatId, text, { inline_keyboard: rows }));
      }
    }
  } catch {}

  if (!sub?.queueId) {
    const text = '⚠️ <b>Спочатку налаштуйте чергу</b>\n\nЩоб надсилати звіти, додайте локацію у веб-додатку.';
    return sendAndClean(chatId, () => sendMessage(chatId, text, {
      inline_keyboard: [[{ text: '⚙️ Налаштування', callback_data: 'menu_settings' }]]
    }));
  }
  const city = sub.city || 'Вінниця';
  const text = `⚡ <b>Повідомити про стан світла</b>\n\n📍 ${city}, черга ${sub.queueId}\n\nОберіть поточний стан:`;
  const kb = {
    inline_keyboard: [
      [
        { text: '💡 Є світло', callback_data: `report_power_${city}_${sub.queueId}_true` },
        { text: '🔌 Немає світла', callback_data: `report_power_${city}_${sub.queueId}_false` },
      ],
      [{ text: '↩️ Назад', callback_data: 'menu_main' }],
    ],
  };
  return sendAndClean(chatId, () => sendMessage(chatId, text, kb));
}

async function handleAllLocations(chatId: string, messageId?: number) {
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (!linked) {
      const text = '⚠️ <b>Акаунт не прив\'язано</b>\n\nЩоб керувати локаціями, прив\'яжіть Telegram у веб-додатку.';
      return replySafe(chatId, text, { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_settings' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    const locations = await getUserLocations(linked.userId);
    if (!locations || locations.length === 0) {
      const text = '📍 <b>Немає збережених локацій</b>\n\nДодайте першу локацію:';
      return replySafe(chatId, text, {
        inline_keyboard: [
          [{ text: '➕ Додати локацію', callback_data: 'loc_add_start' }],
          [{ text: '◀️ Назад', callback_data: 'menu_settings' }],
          [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
        ],
      }, messageId);
    }
    let text = `📍 <b>Мої локації</b> (${locations.length}/5)\n\n`;
    for (const loc of locations as any[]) {
      const locEmoji = getLocationEmoji(loc.name);
      const primary = loc.isPrimary ? ' ⭐' : '';
      const city = loc.city || 'Вінниця';
      const queue = loc.queueId ? ` · ${queueLabelLower(city)} ${loc.queueId}` : '';
      const tgIcon = loc.telegramNotify ? '🔔' : '🔕';
      text += `${locEmoji} ${loc.name}${primary} — ${city}${queue} ${tgIcon}\n`;
    }
    text += '\nОберіть локацію для керування:';

    const kbRows: any[][] = [
      [miniAppButton()],
    ];
    for (const loc of locations as any[]) {
      const locEmoji = getLocationEmoji(loc.name);
      kbRows.push([
        { text: `${locEmoji} ${loc.name}`, callback_data: `locmenu_${loc.id}` },
        { text: loc.telegramNotify ? '🔔' : '🔕', callback_data: `loclisttg_${loc.id}` },
      ]);
    }
    if (locations.length < 5) {
      kbRows.push([{ text: '➕ Додати локацію', callback_data: 'loc_add_start' }]);
    }
    kbRows.push([{ text: '◀️ Назад', callback_data: 'menu_settings' }]);
    kbRows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
    return replySafe(chatId, text, { inline_keyboard: kbRows }, messageId);
  } catch (e: any) {
    console.error('[TG Bot] handleAllLocations error:', e.message);
    return replySafe(chatId, '❌ Помилка завантаження локацій', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_settings' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationMenu(chatId: string, locId: number, messageId?: number) {
  try {
    const { getUserLocationById } = await import('./storage-locations');
    const loc = await getUserLocationById(locId) as any;
    if (!loc) {
      return replySafe(chatId, '❌ Локацію не знайдено', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    const locEmoji = getLocationEmoji(loc.name);
    const city = loc.city || 'Вінниця';
    const tgNotify = loc.telegramNotify ? '🔔 увімкнено' : '🔕 вимкнено';
    let text = `${locEmoji} <b>${loc.name}</b>${loc.isPrimary ? ' ⭐' : ''}\n\n`;
    if (loc.street) {
      text += `📍 ${city}, ${loc.street}${loc.houseNumber ? ', ' + loc.houseNumber : ''}\n`;
    } else {
      text += `🏙 ${city}\n`;
    }
    if (loc.queueId) {
      text += `⚡ ${queueLabel(city)}: <b>${loc.queueId}</b>\n`;
    }
    const pushNotify = loc.notifyEnabled ? '✅' : '❌';
    text += `\n🔔 Push: ${pushNotify}  |  📱 Telegram: ${loc.telegramNotify ? '✅' : '❌'}\n`;
    text += `\nОберіть дію:`;

    const kbRows: any[][] = [
      [miniAppButton()],
      [
        { text: `🔔 Push: ${loc.notifyEnabled ? '✅' : '❌'}`, callback_data: `locpush_${loc.id}` },
        { text: `📱 Telegram: ${loc.telegramNotify ? '✅' : '❌'}`, callback_data: `loctg_${loc.id}` },
      ],
    ];
    kbRows.push([
      { text: '✏️ Змінити назву', callback_data: `locrename_${loc.id}` },
      { text: '📍 Змінити адресу', callback_data: `loceditaddr_${loc.id}` },
    ]);
    if (!loc.isPrimary) {
      kbRows.push([{ text: '⭐ Зробити основною', callback_data: `locprimary_${loc.id}` }]);
    }
    kbRows.push([{ text: '🗑 Видалити локацію', callback_data: `locdel_${loc.id}` }]);
    kbRows.push([{ text: '◀️ Назад до локацій', callback_data: 'menu_all_locations' }]);
    kbRows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
    return replySafe(chatId, text, { inline_keyboard: kbRows }, messageId);
  } catch (e: any) {
    console.error('[TG Bot] handleLocationMenu error:', e.message);
    return replySafe(chatId, '❌ Помилка', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationDelete(chatId: string, locId: number, messageId?: number) {
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocationById, getUserLocations } = await import('./storage-locations');
    const loc = await getUserLocationById(locId) as any;
    if (!loc) {
      return replySafe(chatId, '❌ Локацію не знайдено', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const allLocs = await getUserLocations(linked.userId);
      if (allLocs.length <= 1) {
        const text = `⚠️ <b>Не можна видалити єдину локацію</b>\n\nЦе ваша остання збережена локація. Щоб видалити її, спершу додайте іншу.\n\n💡 Ви можете вимкнути сповіщення для цієї локації замість видалення.`;
        return replySafe(chatId, text, {
          inline_keyboard: [
            [{ text: loc.telegramNotify ? '🔕 Вимкнути сповіщення' : '🔔 Увімкнути сповіщення', callback_data: `loctg_${loc.id}` }],
            [{ text: '◀️ Назад до локації', callback_data: `locmenu_${loc.id}` }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        }, messageId);
      }
    }
    const locEmoji = getLocationEmoji(loc.name);
    const text = `⚠️ <b>Видалити локацію "${loc.name}"?</b>\n\n${locEmoji} ${loc.city}${loc.street ? ', ' + loc.street : ''}${loc.houseNumber ? ', ' + loc.houseNumber : ''}\n\nЦю дію не можна скасувати.`;
    const kb = {
      inline_keyboard: [
        [{ text: '✅ Так, видалити', callback_data: `locdelconfirm_${loc.id}` }],
        [{ text: '❌ Скасувати', callback_data: `locmenu_${loc.id}` }],
        [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
      ],
    };
    return replySafe(chatId, text, kb, messageId);
  } catch {
    return replySafe(chatId, '❌ Помилка', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationDeleteConfirm(chatId: string, locId: number, messageId?: number) {
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { deleteUserLocation, getUserLocationById } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (!linked) {
      return replySafe(chatId, '❌ Акаунт не прив\'язано', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    const loc = await getUserLocationById(locId) as any;
    const locName = loc?.name || 'Локацію';
    await deleteUserLocation(locId, linked.userId);
    const text = `✅ <b>"${locName}" видалено</b>`;
    return replySafe(chatId, text, { inline_keyboard: [[miniAppButton()], [{ text: '📍 Мої локації', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Delete location error:', e.message);
    return replySafe(chatId, '❌ Помилка видалення', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationSetPrimary(chatId: string, locId: number, messageId?: number) {
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations, updateUserLocation } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (!linked) {
      return replySafe(chatId, '❌ Акаунт не прив\'язано', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    const locations = await getUserLocations(linked.userId);
    for (const loc of locations as any[]) {
      if (loc.id === locId) {
        await updateUserLocation(loc.id, linked.userId, { isPrimary: true, orderIndex: 0 });
      } else if (loc.isPrimary) {
        await updateUserLocation(loc.id, linked.userId, { isPrimary: false });
      }
    }
    return handleAllLocations(chatId, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Set primary error:', e.message);
    return replySafe(chatId, '❌ Помилка', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationRenameStart(chatId: string, locId: number, messageId?: number) {
  try {
    const { getUserLocationById } = await import('./storage-locations');
    const loc = await getUserLocationById(locId) as any;
    if (!loc) {
      return replySafe(chatId, '❌ Локацію не знайдено', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    userStates.set(chatId, { step: 'loc_rename', data: { locId } });
    const locEmoji = getLocationEmoji(loc.name);
    const text = `✏️ <b>Змінити назву</b>\n\n${locEmoji} Поточна назва: <b>${loc.name}</b>\n\nВведіть нову назву або оберіть:`;
    const presetKb = {
      inline_keyboard: [
        [
          { text: '🏠 Дім', callback_data: `locrenset_${locId}_Дім` },
          { text: '🏢 Робота', callback_data: `locrenset_${locId}_Робота` },
        ],
        [
          { text: '❤️ Батьки', callback_data: `locrenset_${locId}_Батьки` },
          { text: '🎓 Навчання', callback_data: `locrenset_${locId}_Навчання` },
        ],
        [{ text: '◀️ Назад', callback_data: `locmenu_${locId}` }],
        [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
      ],
    };
    return replySafe(chatId, text, presetKb, messageId);
  } catch {
    return replySafe(chatId, '❌ Помилка', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationRename(chatId: string, locId: number, newName: string, messageId?: number) {
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { updateUserLocation } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (!linked) {
      return replySafe(chatId, '❌ Акаунт не прив\'язано', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    await updateUserLocation(locId, linked.userId, { name: newName.trim() });
    userStates.delete(chatId);
    const locEmoji = getLocationEmoji(newName);
    const text = `✅ Назву змінено на <b>${locEmoji} ${newName.trim()}</b>`;
    return replySafe(chatId, text, { inline_keyboard: [[miniAppButton()], [{ text: '◀️ Назад до локації', callback_data: `locmenu_${locId}` }], [{ text: '📍 Мої локації', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Rename location error:', e.message);
    return replySafe(chatId, '❌ Помилка перейменування', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationEditAddress(chatId: string, locId: number, messageId?: number) {
  try {
    const { getUserLocationById } = await import('./storage-locations');
    const loc = await getUserLocationById(locId) as any;
    if (!loc) {
      return replySafe(chatId, '❌ Локацію не знайдено', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    const locEmoji = getLocationEmoji(loc.name);
    const city = loc.city || 'Вінниця';
    let currentAddr = `🏙 ${city}`;
    if (loc.street) currentAddr += `, ${loc.street}${loc.houseNumber ? ' ' + loc.houseNumber : ''}`;
    if (loc.queueId) currentAddr += `\n⚡ ${queueLabel(city)}: ${loc.queueId}`;

    const text = `📍 <b>Змінити адресу</b>\n\n${locEmoji} <b>${loc.name}</b>\n${currentAddr}\n\nОберіть нове місто:`;
    userStates.set(chatId, { step: 'loc_edit_addr', data: { locId, origCity: city } });
    const kb = {
      inline_keyboard: [
        [
          { text: `${city === 'Київ' ? '✅ ' : ''}Київ`, callback_data: `loceditcity_${locId}_Київ` },
          { text: `${city === 'Харків' ? '✅ ' : ''}Харків`, callback_data: `loceditcity_${locId}_Харків` },
        ],
        [
          { text: `${city === 'Одеса' ? '✅ ' : ''}Одеса`, callback_data: `loceditcity_${locId}_Одеса` },
          { text: `${city === 'Вінниця' ? '✅ ' : ''}Вінниця`, callback_data: `loceditcity_${locId}_Вінниця` },
        ],
        [{ text: '◀️ Назад', callback_data: `locmenu_${locId}` }],
        [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
      ],
    };
    return replySafe(chatId, text, kb, messageId);
  } catch {
    return replySafe(chatId, '❌ Помилка', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationEditMethod(chatId: string, locId: number, city: string, messageId?: number) {
  userStates.set(chatId, { step: 'loc_edit_method', data: { locId, city } });
  const text = `📍 <b>Змінити адресу</b>\n\n🏙 Місто: <b>${city}</b>\n\nОберіть спосіб:`;
  const kb = {
    inline_keyboard: [
      [{ text: '📍 За адресою', callback_data: `locedit_addr_${locId}` }],
      [{ text: `⚡ За ${queueLabelLower(city)}ю`, callback_data: `locedit_queue_${locId}` }],
      [{ text: '◀️ Назад', callback_data: `loceditaddr_${locId}` }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
  return replySafe(chatId, text, kb, messageId);
}

async function handleLocationEditSave(chatId: string, locId: number, updates: { city?: string; street?: string; houseNumber?: string; queueId?: string }, messageId?: number) {
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { updateUserLocation } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (!linked) {
      return replySafe(chatId, '❌ Акаунт не прив\'язано', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    await updateUserLocation(locId, linked.userId, updates);
    userStates.delete(chatId);
    locationNameCache.clear();
    const city = updates.city || 'Вінниця';
    let desc = `🏙 ${city}`;
    if (updates.street) desc += `, ${updates.street}${updates.houseNumber ? ' ' + updates.houseNumber : ''}`;
    if (updates.queueId) desc += `\n⚡ ${queueLabel(city)}: ${updates.queueId}`;
    const text = `✅ <b>Адресу оновлено</b>\n\n${desc}`;
    return replySafe(chatId, text, { inline_keyboard: [[miniAppButton()], [{ text: '◀️ Назад до локації', callback_data: `locmenu_${locId}` }], [{ text: '📍 Мої локації', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Edit location address error:', e.message);
    return replySafe(chatId, '❌ Помилка оновлення', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `locmenu_${locId}` }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleLocationAddStart(chatId: string, messageId?: number) {
  let hasLocations = false;
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locs = await getUserLocations(linked.userId);
      hasLocations = locs.length > 0;
    }
  } catch {}

  const text = '➕ <b>Додати нову локацію</b>\n\nОберіть місто:';
  const kb = {
    inline_keyboard: [
      [
        { text: 'Київ', callback_data: 'locadd_city_Київ' },
        { text: 'Харків', callback_data: 'locadd_city_Харків' },
      ],
      [
        { text: 'Одеса', callback_data: 'locadd_city_Одеса' },
        { text: 'Вінниця', callback_data: 'locadd_city_Вінниця' },
      ],
      [{ text: '◀️ Назад', callback_data: hasLocations ? 'menu_all_locations' : 'menu_main' }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
  return replySafe(chatId, text, kb, messageId);
}

async function handleLocationAddCity(chatId: string, city: string, messageId?: number) {
  userStates.set(chatId, { step: 'loc_add_name', data: { city } });
  const text = `🏙 Місто: <b>${city}</b>\n\nВведіть назву локації (наприклад: Дім, Робота, Батьки):`;
  const presetKb = {
    inline_keyboard: [
      [
        { text: '🏠 Дім', callback_data: 'locadd_name_Дім' },
        { text: '🏢 Робота', callback_data: 'locadd_name_Робота' },
      ],
      [
        { text: '❤️ Батьки', callback_data: 'locadd_name_Батьки' },
        { text: '🎓 Навчання', callback_data: 'locadd_name_Навчання' },
      ],
      [{ text: '◀️ Назад', callback_data: 'loc_add_start' }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
  return replySafe(chatId, text, presetKb, messageId);
}

async function handleLocationAddName(chatId: string, name: string, messageId?: number) {
  const state = userStates.get(chatId);
  const city = state?.data?.city || 'Вінниця';
  userStates.set(chatId, { step: 'loc_add_method', data: { city, name } });
  const text = `📍 <b>${name}</b> (${city})\n\nОберіть спосіб пошуку:`;
  const kb = {
    inline_keyboard: [
      [{ text: '🔍 За адресою', callback_data: 'locadd_method_address' }],
      [{ text: '⚡ За чергою', callback_data: 'locadd_method_queue' }],
      [{ text: '◀️ Назад', callback_data: `locadd_city_${city}` }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };
  return replySafe(chatId, text, kb, messageId);
}

async function handleLocationAddQueue(chatId: string, messageId?: number) {
  const state = userStates.get(chatId);
  const city = state?.data?.city || 'Вінниця';
  const name = state?.data?.name || 'Локація';
  userStates.set(chatId, { step: 'loc_add_queue_select', data: { city, name } });
  const text = `⚡ <b>Оберіть чергу для "${name}"</b>:`;
  const qkb = queueSelectionKeyboard(city, 'locaddqueue');
  qkb.inline_keyboard.pop();
  qkb.inline_keyboard.push([{ text: '◀️ Назад', callback_data: 'locadd_method_back' }]);
  qkb.inline_keyboard.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
  return replySafe(chatId, text, qkb, messageId);
}

async function handleLocationAddAddress(chatId: string, messageId?: number) {
  const state = userStates.get(chatId);
  const city = state?.data?.city || 'Вінниця';
  const name = state?.data?.name || 'Локація';
  userStates.set(chatId, { step: 'loc_add_street', data: { city, name } });
  const text = `🔍 <b>Пошук адреси для "${name}"</b>\n\n🏙 ${city}\n\nВведіть назву вулиці:`;
  return replySafe(chatId, text, { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'locadd_method_back' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
}

async function handleLocationAddSave(chatId: string, queueId: string, street?: string, house?: string, messageId?: number) {
  const state = userStates.get(chatId);
  const city = state?.data?.city || 'Вінниця';
  const name = state?.data?.name || 'Локація';
  console.log(`[TG Bot] handleLocationAddSave: chatId=${chatId}, city=${city}, name=${name}, queueId=${queueId}, street=${street}, house=${house}`);
  userStates.delete(chatId);
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { createUserLocation, getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (!linked) {
      return replySafe(chatId, '❌ Акаунт не прив\'язано', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_settings' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    const existing = await getUserLocations(linked.userId);
    if (existing.length >= 5) {
      return replySafe(chatId, '⚠️ Максимум 5 локацій. Видаліть одну, щоб додати нову.', { inline_keyboard: [[{ text: '📍 Мої локації', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
    }
    const sub = getSubscriber(chatId);
    await createUserLocation({
      userId: linked.userId,
      name,
      city,
      lookupMode: street ? 'address' : 'queue',
      street: street || '',
      houseNumber: house || '',
      queueId: queueId || '',
      isPrimary: existing.length === 0,
      orderIndex: existing.length,
      notifyEnabled: sub.enabled,
      notifyBeforeOff: sub.notifyBeforeOff,
      notifyBeforeOn: sub.notifyBeforeOn,
      telegramNotify: sub.enabled,
    });
    let text = `✅ <b>Локацію "${name}" додано!</b>\n\n📍 ${city}${street ? ', ' + street : ''}${house ? ', ' + house : ''}`;
    if (queueId) {
      text += `\n⚡ Черга: ${queueId}`;
    } else {
      text += `\n\nℹ️ Графіків поки немає. Як тільки з'являться — ми повідомимо.`;
    }
    return replySafe(chatId, text, { inline_keyboard: [[miniAppButton()], [{ text: '📍 Мої локації', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  } catch (e: any) {
    console.error('[TG Bot] Add location error:', e.message);
    return replySafe(chatId, '❌ Помилка додавання локації', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu_all_locations' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
  }
}

async function handleDigest(chatId: string) {
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (!linked) {
      const text = '⚠️ <b>Акаунт не прив\'язано</b>\n\nЩоб переглядати дайджест, прив\'яжіть Telegram у веб-додатку.';
      return sendAndClean(chatId, () => sendMessage(chatId, text, backToMenuKeyboard()));
    }
    const { generateDigestForUser } = await import('./routes-digest');
    const data = await generateDigestForUser(linked.userId);
    if (!data) {
      const text = '<b>Тижневий підсумок ще не готовий</b>\n\nДля нього поки недостатньо перевіреної історії. Ваші адреси й налаштування збережені.';
      return sendAndClean(chatId, () => sendMessage(chatId, text, backToMenuKeyboard()));
    }
    const d = data.digest;
    const deltaStr = d.deltaHours === null ? '' :
      d.deltaHours === 0 ? '(без змін)' :
      d.deltaHours > 0 ? `(+${d.deltaHours} год ↑)` : `(${d.deltaHours} год ↓)`;
    let locStr = '';
    if (d.locationDigests && d.locationDigests.length > 0) {
      locStr = '\n\n📍 <b>По локаціях:</b>\n' + d.locationDigests.map((l: any) =>
        `• ${l.name}: ${l.hoursWithoutPower} год`
      ).join('\n');
    }
    const text = `📊 <b>Тижневий дайджест</b>\n\n⏱ Без світла: <b>${d.hoursWithoutPower} год</b> ${deltaStr}\n📝 Ваших звітів: ${d.totalReports}\n⏰ Найдовше відключення: ${d.longestOutageMinutes ? `${Math.floor(d.longestOutageMinutes / 60)} год ${d.longestOutageMinutes % 60} хв` : '—'}\n📅 Найкращий день: ${d.bestDay || '—'}\n📈 Точність графіку: ${d.queueAccuracyPct ? `${d.queueAccuracyPct}%` : '—'}${locStr}\n\n${data.userStatus.emoji} ${data.userStatus.level} • ${data.totalPoints} балів`;
    return sendAndClean(chatId, () => sendMessage(chatId, text, backToMenuKeyboard()));
  } catch (e: any) {
    console.error('[TG Bot] handleDigest error:', e.message);
    return sendAndClean(chatId, () => sendMessage(chatId, '❌ Помилка генерації дайджесту', backToMenuKeyboard()));
  }
}

async function processUpdate(update: any) {
  if (update.message) {
    const msg = update.message;
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    const firstName = msg.from?.first_name || '';
    const username = msg.from?.username || '';
    const userMsgId = msg.message_id;

    tgApi('deleteMessage', { chat_id: chatId, message_id: userMsgId }).catch(() => {});

    if (text.startsWith('/')) {
      userStates.delete(chatId);
      if (text.startsWith('/start') || text === '/menu') {
        const startParam = text.replace(/^\/start\s*/, '');
        if (startParam.startsWith('addr_')) {
          try {
            const decoded = Buffer.from(startParam.slice(5), 'base64url').toString('utf-8');
            const [queue, street, house] = decoded.split('|');
            if (queue && ALL_VALID_QUEUES.includes(queue)) {
              updateSubscriber(chatId, {
                queueId: queue,
                street: street || undefined,
                houseNumber: house || undefined,
                lookupMode: street ? 'address' : 'queue',
              });
            }
          } catch {}
        }
        if (startParam.startsWith('weblogin_')) {
          const webToken = startParam.slice(9);
          const fulfilled = fulfillWebLoginToken(webToken, chatId);
          if (fulfilled) {
            console.log(`[TG Bot] Web login fulfilled for chatId ${chatId}`);
            await handleStart(chatId, firstName, username);
            const name = firstName ? `, ${firstName}` : '';
            const text = `✅ <b>Вхід виконано${name}!</b>\n\nПерейдіть у додаток або залишіться тут і налаштуйте бота.\n\n💡 <i>Увійти у додаток можна у будь-який момент через меню бота.</i>`;
            const keyboard = {
              inline_keyboard: [
                [{ text: '📱 Перейти в додаток', web_app: { url: 'https://power-ukraine.net' } }],
                [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
              ],
            };
            await sendAndClean(chatId, () => sendMessage(chatId, text, keyboard));
            return;
          }
          return handleStart(chatId, firstName, username);
        }
        if (startParam.startsWith('link_')) {
          const linkToken = startParam.slice(5);
          const linkData = consumeLinkToken(linkToken);
          if (linkData) {
            try {
              const { addLinkedAccount, getUserSettings, upsertUserSettings, getLinkedAccountByProvider, migrateUserSettings } = await import('./storage');
              const existing = await getLinkedAccountByProvider('telegram', chatId);
              if (existing && existing.userId !== linkData.userId) {
                await migrateUserSettings(existing.userId, linkData.userId);
              }
              const sub = getSubscriber(chatId);
              const displayName = firstName ? `Telegram: ${firstName}` : `Telegram: ${chatId}`;
              await addLinkedAccount(linkData.userId, 'telegram', chatId, displayName);
              await upsertUserSettings(linkData.userId, { telegramChatId: chatId });
              if (sub) {
                const current = await getUserSettings(linkData.userId);
                const settingsFromBot: Record<string, any> = {};
                if (sub.queueId) settingsFromBot.queueId = sub.queueId;
                if (sub.street) {
                  settingsFromBot.street = sub.street;
                  settingsFromBot.houseNumber = sub.houseNumber || '';
                  settingsFromBot.lookupMode = sub.lookupMode || 'address';
                } else if (sub.lookupMode) {
                  settingsFromBot.lookupMode = sub.lookupMode;
                }
                if (sub.notifyBeforeOff) settingsFromBot.telegramNotifyBeforeOff = sub.notifyBeforeOff;
                if (sub.notifyBeforeOn) settingsFromBot.telegramNotifyBeforeOn = sub.notifyBeforeOn;
                if (typeof sub.enabled === 'boolean') settingsFromBot.telegramNotifications = sub.enabled;
                if (typeof sub.quietHoursEnabled === 'boolean') settingsFromBot.quietHoursEnabled = sub.quietHoursEnabled;
                if (typeof sub.quietHoursStart === 'number') settingsFromBot.quietHoursStart = sub.quietHoursStart;
                if (typeof sub.quietHoursEnd === 'number') settingsFromBot.quietHoursEnd = sub.quietHoursEnd;
                if (typeof sub.morningBriefingEnabled === 'boolean') settingsFromBot.morningBriefingEnabled = sub.morningBriefingEnabled;
                if (typeof sub.morningBriefingHour === 'number') settingsFromBot.morningBriefingHour = sub.morningBriefingHour;
                if (typeof sub.minOutageDuration === 'number') settingsFromBot.minOutageDuration = sub.minOutageDuration;
                if (!current?.queueId && !current?.street) {
                  if (Object.keys(settingsFromBot).length > 0) {
                    await upsertUserSettings(linkData.userId, settingsFromBot);
                  }
                } else {
                  const notifFields: Record<string, any> = {};
                  if (settingsFromBot.telegramNotifyBeforeOff) notifFields.telegramNotifyBeforeOff = settingsFromBot.telegramNotifyBeforeOff;
                  if (settingsFromBot.telegramNotifyBeforeOn) notifFields.telegramNotifyBeforeOn = settingsFromBot.telegramNotifyBeforeOn;
                  if (typeof settingsFromBot.telegramNotifications === 'boolean') notifFields.telegramNotifications = settingsFromBot.telegramNotifications;
                  if (typeof settingsFromBot.quietHoursEnabled === 'boolean') notifFields.quietHoursEnabled = settingsFromBot.quietHoursEnabled;
                  if (typeof settingsFromBot.quietHoursStart === 'number') notifFields.quietHoursStart = settingsFromBot.quietHoursStart;
                  if (typeof settingsFromBot.quietHoursEnd === 'number') notifFields.quietHoursEnd = settingsFromBot.quietHoursEnd;
                  if (typeof settingsFromBot.morningBriefingEnabled === 'boolean') notifFields.morningBriefingEnabled = settingsFromBot.morningBriefingEnabled;
                  if (typeof settingsFromBot.morningBriefingHour === 'number') notifFields.morningBriefingHour = settingsFromBot.morningBriefingHour;
                  if (typeof settingsFromBot.minOutageDuration === 'number') notifFields.minOutageDuration = settingsFromBot.minOutageDuration;
                  if (Object.keys(notifFields).length > 0) {
                    await upsertUserSettings(linkData.userId, notifFields);
                  }
                }
              }
              console.log(`[TG Bot] Linked chatId ${chatId} to userId ${linkData.userId} via link token`);
            } catch (e: any) {
              console.error('[TG Bot] Link token processing failed:', e.message);
            }
          }
        }
        return handleStart(chatId, firstName, username);
      }
      if (text === '/schedule' || text === '/status') {
        return handleScheduleNow(chatId);
      }
      if (text === '/settings') {
        return handleSettings(chatId);
      }
      if (text === '/help') {
        const helpText = `📋 <b>Доступні команди:</b>\n\n/start — Головне меню\n/schedule — Поточний стан світла\n/report — Повідомити про стан світла\n/all — Всі мої локації\n/digest — Тижневий дайджест\n/settings — Ваші налаштування\n/help — Ця довідка`;
        return sendAndClean(chatId, () => sendMessage(chatId, helpText, backToMenuKeyboard()));
      }
      if (text === '/report') {
        return handleReport(chatId);
      }
      if (text === '/all') {
        return handleAllLocations(chatId);
      }
      if (text === '/digest') {
        return handleDigest(chatId);
      }
      return;
    }

    if (!text) return;

    const state = userStates.get(chatId);

    if (state?.step === 'loc_rename') {
      const newName = text.trim().slice(0, 100);
      if (!newName) {
        return sendAndClean(chatId, () => sendMessage(chatId, '⚠️ Введіть нову назву.'));
      }
      return handleLocationRename(chatId, state.data.locId, newName);
    }

    if (state?.step === 'loc_edit_street') {
      if (text.length < 2) {
        return sendAndClean(chatId, () => sendMessage(chatId, '⚠️ Введіть мінімум 2 символи для пошуку вулиці.'));
      }
      const locId = state.data?.locId;
      const city = state.data?.city || 'Вінниця';
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/geocode/streets?q=${encodeURIComponent(text)}&city=${encodeURIComponent(city)}`);
        const streets: string[] = await resp.json();
        if (!streets || streets.length === 0) {
          return sendAndClean(chatId, () => sendMessage(chatId, `❌ Вулицю не знайдено. Спробуйте інший запит.`, { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `locedit_addr_${locId}` }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }));
        }
        const displayStreets = streets.slice(0, 8);
        userStates.set(chatId, { step: 'loc_edit_pick_street', data: { ...state.data, streets: displayStreets } });
        const streetButtons = displayStreets.map((s: string, i: number) => {
          const label = s.length > 35 ? s.substring(0, 32) + '...' : s;
          return [{ text: `📍 ${label}`, callback_data: `loceditstrt_${locId}_${i}` }];
        });
        streetButtons.push([{ text: '◀️ Назад', callback_data: `locedit_addr_${locId}` }]);
        streetButtons.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
        return sendAndClean(chatId, () => sendMessage(chatId, `🔍 <b>Знайдені вулиці:</b>\n\nОберіть вулицю:`, { inline_keyboard: streetButtons }));
      } catch (e: any) {
        console.error('[TG Bot] Edit street search error:', e.message);
        return sendAndClean(chatId, () => sendMessage(chatId, '❌ Помилка пошуку. Спробуйте пізніше.', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `loceditaddr_${locId}` }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }));
      }
    }

    if (state?.step === 'loc_edit_house') {
      const house = text.trim();
      const locId = state.data?.locId;
      const street = state.data?.selectedStreet || '';
      const city = state.data?.city || 'Вінниця';
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/address-queue?street=${encodeURIComponent(street)}&house=${encodeURIComponent(house)}&city=${encodeURIComponent(city)}`);
        if (resp.ok) {
          const d = await resp.json();
          if (d.queueId) {
            return handleLocationEditSave(chatId, locId, { city, queueId: d.queueId, street, houseNumber: house });
          }
        }
        return handleLocationEditSave(chatId, locId, { city, street, houseNumber: house });
      } catch {
        return handleLocationEditSave(chatId, locId, { city, street, houseNumber: house });
      }
    }

    if (state?.step === 'loc_add_name') {
      const name = text.trim().slice(0, 100);
      if (!name) {
        return sendAndClean(chatId, () => sendMessage(chatId, '⚠️ Введіть назву локації.'));
      }
      userStates.set(chatId, { step: 'loc_add_method', data: { ...state.data, name } });
      return handleLocationAddName(chatId, name);
    }

    if (state?.step === 'loc_add_street') {
      if (text.length < 2) {
        return sendAndClean(chatId, () => sendMessage(chatId, '⚠️ Введіть мінімум 2 символи для пошуку вулиці.'));
      }
      const city = state.data?.city || 'Вінниця';
      const name = state.data?.name || 'Локація';
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/geocode/streets?q=${encodeURIComponent(text)}&city=${encodeURIComponent(city)}`);
        const streets: string[] = await resp.json();
        if (!streets || streets.length === 0) {
          return sendAndClean(chatId, () => sendMessage(chatId, `❌ Вулицю не знайдено. Спробуйте інший запит.`, { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'locadd_method_address' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }));
        }
        const displayStreets = streets.slice(0, 8);
        userStates.set(chatId, { step: 'loc_add_pick_street', data: { ...state.data, streets: displayStreets } });
        const streetButtons = displayStreets.map((s: string, i: number) => {
          const label = s.length > 35 ? s.substring(0, 32) + '...' : s;
          return [{ text: `📍 ${label}`, callback_data: `locaddstreet_${i}` }];
        });
        streetButtons.push([{ text: '◀️ Назад', callback_data: 'locadd_method_address' }]);
        streetButtons.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
        return sendAndClean(chatId, () => sendMessage(chatId, `🔍 <b>Знайдені вулиці:</b>\n\nОберіть вулицю для "${name}":`, { inline_keyboard: streetButtons }));
      } catch (e: any) {
        console.error('[TG Bot] Street search error:', e.message);
        return sendAndClean(chatId, () => sendMessage(chatId, '❌ Помилка пошуку. Спробуйте пізніше.', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'locadd_method_back' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }));
      }
    }

    if (state?.step === 'loc_add_house') {
      const house = text.trim();
      const street = state.data?.selectedStreet || '';
      const city = state.data?.city || 'Вінниця';
      console.log(`[TG Bot] loc_add_house: city=${city}, street=${street}, house=${house}`);
      try {
        const apiUrl = `http://localhost:${process.env.PORT || 5000}/api/address-queue?street=${encodeURIComponent(street)}&house=${encodeURIComponent(house)}&city=${encodeURIComponent(city)}`;
        console.log(`[TG Bot] Fetching queue: ${apiUrl}`);
        const resp = await fetch(apiUrl);
        console.log(`[TG Bot] Queue response status: ${resp.status}`);
        if (resp.ok) {
          const data2 = await resp.json();
          console.log(`[TG Bot] Queue result: queueId=${data2.queueId}`);
          if (data2.queueId) {
            return handleLocationAddSave(chatId, data2.queueId, street, house);
          }
        }
        const text2 = `📍 ${city}, ${street}${house ? ', ' + house : ''}\n\nℹ️ Графіків відключень для цієї адреси поки не знайдено.\n\nМожливо, для вашого району ще не опубліковано графік. Ви можете зберегти адресу — як тільки графік з'явиться, ми почнемо відстежувати.`;
        const noQueueKb = {
          inline_keyboard: [
            [{ text: '✅ Зберегти без черги', callback_data: `locadd_save_noqueue` }],
            [{ text: '⚡ Обрати чергу вручну', callback_data: `locadd_manual_queue` }],
            [{ text: '◀️ Назад', callback_data: 'locadd_method_address' }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        };
        userStates.set(chatId, { step: 'loc_add_queue_manual', data: { ...state.data, house, street } });
        return sendAndClean(chatId, () => sendMessage(chatId, text2, noQueueKb));
      } catch (e: any) {
        console.error('[TG Bot] loc_add_house error:', e.message, e.stack);
        return sendAndClean(chatId, () => sendMessage(chatId, '❌ Помилка. Спробуйте пізніше.', { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'locadd_method_address' }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }));
      }
    }

    if (state?.step === 'awaiting_house') {
      return handleHouseSelected(chatId, text);
    }

    if (state?.step === 'awaiting_street' || state?.step === 'pick_street') {
      if (text.length < 2) {
        return sendAndClean(chatId, () => sendMessage(chatId, '⚠️ Введіть мінімум 2 символи для пошуку вулиці.'));
      }
      return handleStreetSearch(chatId, text);
    }

    return;
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = String(cb.message.chat.id);
    const messageId = cb.message.message_id;
    const data = cb.data || '';

    answerCallback(cb.id).catch(() => {});

    if (data === 'menu_main') {
      userStates.delete(chatId);
      return handleMainMenu(chatId, messageId);
    }
    if (data === 'menu_schedule') { userStates.delete(chatId); return handleScheduleNow(chatId, messageId); }
    if (data === 'menu_full_schedule') { userStates.delete(chatId); return handleFullSchedule(chatId, messageId); }
    if (data === 'menu_queue') { userStates.delete(chatId); return handleQueueSelection(chatId, messageId); }
    if (data === 'menu_address') { userStates.delete(chatId); return handleAddressMenu(chatId, messageId); }
    if (data === 'menu_notifications') { userStates.delete(chatId); return handleNotifications(chatId, messageId); }
    if (data === 'menu_settings') { userStates.delete(chatId); return handleSettings(chatId, messageId); }
    if (data === 'menu_digest') { userStates.delete(chatId); return handleDigest(chatId); }
    if (data === 'menu_about') { userStates.delete(chatId); return handleAbout(chatId, messageId); }
    if (data === 'menu_all_locations') { userStates.delete(chatId); return handleAllLocations(chatId, messageId); }

    if (data.startsWith('locmenu_')) {
      const locId = parseInt(data.replace('locmenu_', ''));
      if (!isNaN(locId)) { userStates.delete(chatId); return handleLocationMenu(chatId, locId, messageId); }
    }
    if (data.startsWith('locdel_')) {
      const locId = parseInt(data.replace('locdel_', ''));
      if (!isNaN(locId)) return handleLocationDelete(chatId, locId, messageId);
    }
    if (data.startsWith('locdelconfirm_')) {
      const locId = parseInt(data.replace('locdelconfirm_', ''));
      if (!isNaN(locId)) return handleLocationDeleteConfirm(chatId, locId, messageId);
    }
    if (data.startsWith('locprimary_')) {
      const locId = parseInt(data.replace('locprimary_', ''));
      if (!isNaN(locId)) return handleLocationSetPrimary(chatId, locId, messageId);
    }
    if (data.startsWith('locrename_')) {
      const locId = parseInt(data.replace('locrename_', ''));
      if (!isNaN(locId)) return handleLocationRenameStart(chatId, locId, messageId);
    }
    if (data.startsWith('locrenset_')) {
      const parts = data.replace('locrenset_', '').split('_');
      const locId = parseInt(parts[0]);
      const name = parts.slice(1).join('_');
      if (!isNaN(locId) && name) { userStates.delete(chatId); return handleLocationRename(chatId, locId, name, messageId); }
    }
    if (data.startsWith('loceditaddr_')) {
      const locId = parseInt(data.replace('loceditaddr_', ''));
      if (!isNaN(locId)) return handleLocationEditAddress(chatId, locId, messageId);
    }
    if (data.startsWith('loceditcity_')) {
      const parts = data.replace('loceditcity_', '').split('_');
      const locId = parseInt(parts[0]);
      const city = parts.slice(1).join('_');
      if (!isNaN(locId) && city) return handleLocationEditMethod(chatId, locId, city, messageId);
    }
    if (data.startsWith('locedit_addr_')) {
      const locId = parseInt(data.replace('locedit_addr_', ''));
      const state = userStates.get(chatId);
      const city = state?.data?.city || 'Вінниця';
      if (!isNaN(locId)) {
        userStates.set(chatId, { step: 'loc_edit_street', data: { locId, city } });
        const text = `📍 <b>Введіть назву вулиці</b>\n\n🏙 ${city}\n\nВведіть назву вулиці для пошуку:`;
        return replySafe(chatId, text, { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `loceditcity_${locId}_${city}` }], [{ text: '↩️ Головне меню', callback_data: 'menu_main' }]] }, messageId);
      }
    }
    if (data.startsWith('locedit_queue_')) {
      const locId = parseInt(data.replace('locedit_queue_', ''));
      const state = userStates.get(chatId);
      const city = state?.data?.city || 'Вінниця';
      if (!isNaN(locId)) {
        userStates.set(chatId, { step: 'loc_edit_queue', data: { locId, city } });
        const qkb = queueSelectionKeyboard(city, `loceditsq_${locId}`);
        qkb.inline_keyboard.pop();
        qkb.inline_keyboard.push([{ text: '◀️ Назад', callback_data: `loceditcity_${locId}_${city}` }]);
        qkb.inline_keyboard.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
        return replySafe(chatId, `⚡ Оберіть ${queueLabelLower(city)}:`, { inline_keyboard: qkb.inline_keyboard }, messageId);
      }
    }
    if (data.startsWith('loceditsq_')) {
      const parts = data.replace('loceditsq_', '').split('_');
      const locId = parseInt(parts[0]);
      const queueId = parts.slice(1).join('_');
      const state = userStates.get(chatId);
      const city = state?.data?.city || 'Вінниця';
      if (!isNaN(locId) && queueId && isValidQueue(queueId, city)) {
        return handleLocationEditSave(chatId, locId, { city, queueId, street: undefined, houseNumber: undefined }, messageId);
      }
    }
    if (data.startsWith('loceditstrt_')) {
      const parts = data.replace('loceditstrt_', '').split('_');
      const locId = parseInt(parts[0]);
      const idx = parseInt(parts[1]);
      const state = userStates.get(chatId);
      const streets = state?.data?.streets;
      if (streets && idx >= 0 && idx < streets.length) {
        const selectedStreet = streets[idx];
        const city = state?.data?.city || 'Вінниця';
        userStates.set(chatId, { step: 'loc_edit_house', data: { ...state.data, selectedStreet } });
        const text = `📍 <b>${selectedStreet}</b> (${city})\n\nВведіть номер будинку (або натисніть "Пропустити"):`;
        return replySafe(chatId, text, {
          inline_keyboard: [
            [{ text: '⏭ Пропустити', callback_data: `locedithskip_${locId}` }],
            [{ text: '◀️ Назад', callback_data: `locedit_addr_${locId}` }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        }, messageId);
      }
    }
    if (data.startsWith('locedithskip_')) {
      const locId = parseInt(data.replace('locedithskip_', ''));
      const state = userStates.get(chatId);
      const street = state?.data?.selectedStreet || '';
      const city = state?.data?.city || 'Вінниця';
      if (!isNaN(locId)) {
        try {
          const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/address-queue?street=${encodeURIComponent(street)}&house=&city=${encodeURIComponent(city)}`);
          if (resp.ok) {
            const d = await resp.json();
            if (d.queueId) return handleLocationEditSave(chatId, locId, { city, queueId: d.queueId, street, houseNumber: '' }, messageId);
          }
        } catch {}
        return handleLocationEditSave(chatId, locId, { city, street, houseNumber: '' }, messageId);
      }
    }
    if (data === 'locadd_save_noqueue') {
      const st = userStates.get(chatId);
      const street2 = st?.data?.selectedStreet || st?.data?.street || '';
      const house2 = st?.data?.house || '';
      return handleLocationAddSave(chatId, '', street2 || undefined, house2 || undefined, messageId);
    }
    if (data === 'locadd_manual_queue') {
      const st = userStates.get(chatId);
      const city2 = st?.data?.city || 'Вінниця';
      const qkb = queueSelectionKeyboard(city2, 'locaddqueue');
      qkb.inline_keyboard.pop();
      qkb.inline_keyboard.push([{ text: '◀️ Назад', callback_data: 'locadd_method_address' }]);
      qkb.inline_keyboard.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
      return editMessage(chatId, messageId, `⚡ Оберіть чергу вручну:`, qkb);
    }
    if (data === 'loc_add_start') { return handleLocationAddStart(chatId, messageId); }
    if (data.startsWith('locadd_city_')) {
      const city = data.replace('locadd_city_', '');
      return handleLocationAddCity(chatId, city, messageId);
    }
    if (data.startsWith('locadd_name_')) {
      const name = data.replace('locadd_name_', '');
      const state = userStates.get(chatId);
      if (state?.data?.city) {
        userStates.set(chatId, { step: 'loc_add_method', data: { ...state.data, name } });
      }
      return handleLocationAddName(chatId, name, messageId);
    }
    if (data === 'locadd_method_address') { return handleLocationAddAddress(chatId, messageId); }
    if (data === 'locadd_method_queue') { return handleLocationAddQueue(chatId, messageId); }
    if (data === 'locadd_method_back') {
      const state = userStates.get(chatId);
      const city = state?.data?.city || 'Вінниця';
      const name = state?.data?.name || '';
      if (name) return handleLocationAddName(chatId, name, messageId);
      return handleLocationAddCity(chatId, city, messageId);
    }
    if (data.startsWith('locaddstreet_')) {
      const idx = parseInt(data.replace('locaddstreet_', ''));
      const state2 = userStates.get(chatId);
      const streets2 = state2?.data?.streets;
      if (streets2 && idx >= 0 && idx < streets2.length) {
        const selectedStreet = streets2[idx];
        const city2 = state2?.data?.city || 'Вінниця';
        const name2 = state2?.data?.name || 'Локація';
        userStates.set(chatId, { step: 'loc_add_house', data: { ...state2.data, selectedStreet } });
        const text2 = `📍 <b>${selectedStreet}</b> (${city2})\n\nВведіть номер будинку (або натисніть "Пропустити"):`;
        return editMessage(chatId, messageId, text2, {
          inline_keyboard: [
            [{ text: '⏭ Пропустити', callback_data: 'locaddhouse_skip' }],
            [{ text: '◀️ Назад', callback_data: 'locadd_method_address' }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        });
      }
    }
    if (data === 'locaddhouse_skip') {
      const state2 = userStates.get(chatId);
      const street2 = state2?.data?.selectedStreet || '';
      const city2 = state2?.data?.city || 'Вінниця';
      try {
        const resp2 = await fetch(`http://localhost:${process.env.PORT || 5000}/api/address-queue?street=${encodeURIComponent(street2)}&house=&city=${encodeURIComponent(city2)}`);
        if (resp2.ok) {
          const d2 = await resp2.json();
          if (d2.queueId) return handleLocationAddSave(chatId, d2.queueId, street2, '', messageId);
        }
      } catch {}
      userStates.set(chatId, { step: 'loc_add_queue_manual', data: { ...state2?.data, house: '', street: street2 } });
      const noQText = `📍 ${city2}, ${street2}\n\nℹ️ Графіків відключень для цієї адреси поки не знайдено.\n\nМожливо, для вашого району ще не опубліковано графік. Ви можете зберегти адресу — як тільки графік з'явиться, ми почнемо відстежувати.`;
      const noQKb = {
        inline_keyboard: [
          [{ text: '✅ Зберегти без черги', callback_data: `locadd_save_noqueue` }],
          [{ text: '⚡ Обрати чергу вручну', callback_data: `locadd_manual_queue` }],
          [{ text: '◀️ Назад', callback_data: 'locadd_method_address' }],
          [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
        ],
      };
      return editMessage(chatId, messageId, noQText, noQKb);
    }
    if (data.startsWith('locaddqueue_')) {
      const queueId = data.replace('locaddqueue_', '');
      const state2 = userStates.get(chatId);
      const city2 = state2?.data?.city || 'Вінниця';
      const street2 = state2?.data?.selectedStreet || state2?.data?.street || '';
      const house2 = state2?.data?.house || '';
      if (isValidQueue(queueId, city2)) {
        return handleLocationAddSave(chatId, queueId, street2 || undefined, house2 || undefined, messageId);
      }
    }

    if (data.startsWith('sched_loc_')) {
      const locId = parseInt(data.replace('sched_loc_', ''));
      if (!isNaN(locId)) {
        userStates.delete(chatId);
        return handleScheduleNow(chatId, messageId, locId);
      }
    }
    if (data.startsWith('fullsched_loc_')) {
      const locId = parseInt(data.replace('fullsched_loc_', ''));
      if (!isNaN(locId)) {
        userStates.delete(chatId);
        return handleFullSchedule(chatId, messageId, locId);
      }
    }

    if (data.startsWith('locpush_')) {
      const locId = parseInt(data.replace('locpush_', ''));
      try {
        const { getLinkedAccountByProvider } = await import('./storage');
        const { getUserLocationById, updateUserLocation } = await import('./storage-locations');
        const linked = await getLinkedAccountByProvider('telegram', chatId);
        if (linked) {
          const loc = await getUserLocationById(locId);
          if (loc && loc.userId === linked.userId) {
            const newVal = !loc.notifyEnabled;
            await updateUserLocation(locId, linked.userId, { notifyEnabled: newVal });
            locationNameCache.clear();
            return handleLocationMenu(chatId, locId, messageId);
          }
        }
      } catch {}
      return handleAllLocations(chatId, messageId);
    }

    if (data.startsWith('loclisttg_')) {
      const locId = parseInt(data.replace('loclisttg_', ''));
      try {
        const { getLinkedAccountByProvider } = await import('./storage');
        const { getUserLocationById, updateUserLocation } = await import('./storage-locations');
        const linked = await getLinkedAccountByProvider('telegram', chatId);
        if (linked) {
          const loc = await getUserLocationById(locId);
          if (loc && loc.userId === linked.userId) {
            const newVal = !loc.telegramNotify;
            await updateUserLocation(locId, linked.userId, { telegramNotify: newVal });
            locationNameCache.clear();
            return handleAllLocations(chatId, messageId);
          }
        }
      } catch {}
      return handleAllLocations(chatId, messageId);
    }

    if (data.startsWith('loctg_')) {
      const locId = parseInt(data.replace('loctg_', ''));
      try {
        const { getLinkedAccountByProvider } = await import('./storage');
        const { getUserLocationById, updateUserLocation } = await import('./storage-locations');
        const linked = await getLinkedAccountByProvider('telegram', chatId);
        if (linked) {
          const loc = await getUserLocationById(locId);
          if (loc && loc.userId === linked.userId) {
            const newVal = !loc.telegramNotify;
            await updateUserLocation(locId, linked.userId, { telegramNotify: newVal });
            locationNameCache.clear();
            return handleLocationMenu(chatId, locId, messageId);
          }
        }
      } catch {}
      return handleAllLocations(chatId, messageId);
    }

    if (data.startsWith('notifpush_')) {
      const locId = parseInt(data.replace('notifpush_', ''));
      try {
        const { getLinkedAccountByProvider } = await import('./storage');
        const { getUserLocationById, updateUserLocation } = await import('./storage-locations');
        const linked = await getLinkedAccountByProvider('telegram', chatId);
        if (linked) {
          const loc = await getUserLocationById(locId);
          if (loc && loc.userId === linked.userId) {
            const newVal = !loc.notifyEnabled;
            await updateUserLocation(locId, linked.userId, { notifyEnabled: newVal });
            locationNameCache.clear();
            return handleNotifications(chatId, messageId);
          }
        }
      } catch {}
      return handleNotifications(chatId, messageId);
    }

    if (data.startsWith('notiftg_')) {
      const locId = parseInt(data.replace('notiftg_', ''));
      try {
        const { getLinkedAccountByProvider } = await import('./storage');
        const { getUserLocationById, updateUserLocation } = await import('./storage-locations');
        const linked = await getLinkedAccountByProvider('telegram', chatId);
        if (linked) {
          const loc = await getUserLocationById(locId);
          if (loc && loc.userId === linked.userId) {
            const newVal = !loc.telegramNotify;
            await updateUserLocation(locId, linked.userId, { telegramNotify: newVal });
            locationNameCache.clear();
            return handleNotifications(chatId, messageId);
          }
        }
      } catch {}
      return handleNotifications(chatId, messageId);
    }

    if (data.startsWith('report_loc_')) {
      const locId = parseInt(data.replace('report_loc_', ''));
      try {
        const { getUserLocationById } = await import('./storage-locations');
        const loc = await getUserLocationById(locId);
        if (loc && loc.queueId) {
          const city = loc.city || 'Вінниця';
          const text = `⚡ <b>Звіт для: ${loc.name}</b>\n\n📍 ${city}, черга ${loc.queueId}\n\nОберіть поточний стан:`;
          const kb = {
            inline_keyboard: [
              [
                { text: '💡 Є світло', callback_data: `report_power_${city}_${loc.queueId}_true` },
                { text: '🔌 Немає світла', callback_data: `report_power_${city}_${loc.queueId}_false` },
              ],
              [{ text: '↩️ Назад', callback_data: 'menu_report' }],
            ],
          };
          return editMessage(chatId, messageId, text, kb);
        }
      } catch {}
      return editMessage(chatId, messageId, '❌ Локацію не знайдено', backToMenuKeyboard());
    }
    if (data.startsWith('report_power_')) {
      const parts = data.replace('report_power_', '').split('_');
      const hasPower = parts.pop() === 'true';
      const queueId = parts.pop()!;
      const city = parts.join('_');
      try {
        const { getLinkedAccountByProvider } = await import('./storage');
        const linked = await getLinkedAccountByProvider('telegram', chatId);
        let userId = linked?.userId || `tg_${chatId}`;
        const { createPowerReport, getUserTotalReportCount, getUserStatus, getLastUserReport } = await import('./storage-reports');

        const last = await getLastUserReport(userId, city, queueId);
        if (last && Date.now() - new Date(last.reportedAt).getTime() < 2 * 60 * 1000) {
          const remaining = Math.ceil((2 * 60 * 1000 - (Date.now() - new Date(last.reportedAt).getTime())) / 1000);
          const text = `⏱ <b>Зачекайте ще ${remaining} сек</b>\n\nЗвіти можна надсилати раз на 2 хвилини.`;
          return editMessage(chatId, messageId, text, backToMenuKeyboard());
        }

        await createPowerReport({ userId, city, queueId, hasPower, source: 'telegram' });
        const total = await getUserTotalReportCount(userId);
        const status = getUserStatus(total);
        const icon = hasPower ? '💡' : '🔌';
        const label = hasPower ? 'Є світло' : 'Немає світла';
        const text = `✅ <b>Звіт надіслано!</b>\n\n${icon} <b>${label}</b>\n📍 ${city}, черга ${queueId}\n\n🏆 +5 балів! Всього: ${total * 5} б.\n${status.emoji} Статус: <b>${status.level}</b>`;
        return editMessage(chatId, messageId, text, {
          inline_keyboard: [
            [miniAppButton()],
            [{ text: '⚡ Ще один звіт', callback_data: 'menu_report' }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        });
      } catch (e: any) {
        console.error('[TG Bot] Report error:', e.message);
        return editMessage(chatId, messageId, '❌ Помилка надсилання звіту', backToMenuKeyboard());
      }
    }
    if (data === 'menu_report') {
      userStates.delete(chatId);
      return handleReport(chatId);
    }

    if (data.startsWith('setqueue_')) {
      const queueId = data.replace('setqueue_', '');
      const sub = getSubscriber(chatId);
      const city = getSubCity(sub);
      if (isValidQueue(queueId, city)) {
        return handleSetQueue(chatId, queueId, messageId);
      }
    }

    if (data.startsWith('addrsetqueue_')) {
      const queueId = data.replace('addrsetqueue_', '');
      const sub = getSubscriber(chatId);
      const city = getSubCity(sub);
      if (isValidQueue(queueId, city)) {
        userStates.delete(chatId);
        updateSubscriber(chatId, { queueId });
        const text = `✅ <b>Збережено!</b>\n\n📍 ${city}, ${sub.street || ''}${sub.houseNumber ? ', ' + sub.houseNumber : ''}\n⚡ ${queueLabel(city)}: <b>${queueId}</b>`;
        const kb = {
          inline_keyboard: [
            [miniAppButton()],
            [{ text: '📊 Стан зараз', callback_data: 'menu_schedule' }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        };
        cleanupChat(chatId, messageId);
        return editMessage(chatId, messageId, text, kb);
      }
    }

    if (data.startsWith('addrqueue_')) {
      const queueId = data.replace('addrqueue_', '');
      const sub = getSubscriber(chatId);
      const city = getSubCity(sub);
      if (isValidQueue(queueId, city)) {
        const state = userStates.get(chatId);
        const street = state?.data?.street || sub.street || '';
        const house = state?.data?.house || '';
        userStates.delete(chatId);
        updateSubscriber(chatId, { queueId, street: street || undefined, houseNumber: house || undefined, lookupMode: 'address' });
        const text = `✅ <b>Збережено!</b>\n\n📍 ${street}${house ? ', ' + house : ''}\n⚡ ${queueLabel(city)}: <b>${queueId}</b>`;
        const kb = {
          inline_keyboard: [
            [{ text: '📊 Стан зараз', callback_data: 'menu_schedule' }],
            [{ text: '🔔 Налаштувати сповіщення', callback_data: 'menu_notifications' }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        };
        cleanupChat(chatId, messageId);
        return editMessage(chatId, messageId, text, kb);
      }
    }

    if (data.startsWith('street_')) {
      const idx = parseInt(data.replace('street_', ''));
      const state = userStates.get(chatId);
      const streetsList = state?.data?.streets;
      if (streetsList && idx >= 0 && idx < streetsList.length) {
        return handleStreetSelected(chatId, streetsList[idx], messageId);
      }
      userStates.delete(chatId);
      cleanupChat(chatId, messageId);
      return editMessage(chatId, messageId, '⚠️ Сесія закінчилась. Почніть пошук заново.', {
        inline_keyboard: [
          [{ text: '⚙️ Налаштування', callback_data: 'menu_settings' }],
          [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
        ],
      });
    }

    if (data.startsWith('house_')) {
      const state = userStates.get(chatId);
      if (!state || state.step !== 'awaiting_house') {
        userStates.delete(chatId);
        cleanupChat(chatId, messageId);
        return editMessage(chatId, messageId, '⚠️ Сесія закінчилась. Почніть пошук заново.', {
          inline_keyboard: [
            [{ text: '⚙️ Налаштування', callback_data: 'menu_settings' }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        });
      }
      const house = data.replace('house_', '');
      if (house === 'skip') {
        return handleHouseSelected(chatId, '', messageId);
      }
      return handleHouseSelected(chatId, house, messageId);
    }

    if (data === 'notif_toggle') {
      const sub = getSubscriber(chatId);
      updateSubscriber(chatId, { enabled: !sub.enabled });
      return handleNotifications(chatId, messageId);
    }

    if (data === 'notif_off_threshold') {
      const text = `⏱ <b>Попереджати до вимкнення за:</b>\n\nОберіть час:`;
      cleanupChat(chatId, messageId);
      return editMessage(chatId, messageId, text, thresholdKeyboard('off'));
    }
    if (data === 'notif_on_threshold') {
      const text = `⏱ <b>Попереджати до ввімкнення за:</b>\n\nОберіть час:`;
      cleanupChat(chatId, messageId);
      return editMessage(chatId, messageId, text, thresholdKeyboard('on'));
    }

    if (data.startsWith('threshold_')) {
      const parts = data.replace('threshold_', '').split('_');
      const type = parts[0];
      const value = parseInt(parts[1]);
      if (type === 'off') {
        updateSubscriber(chatId, { notifyBeforeOff: value });
      } else {
        updateSubscriber(chatId, { notifyBeforeOn: value });
      }
      return handleNotifications(chatId, messageId);
    }

    if (data === 'notif_quiet_hours') {
      const sub = getSubscriber(chatId);
      const currentStart = String(sub.quietHoursStart).padStart(2, '0');
      const currentEnd = String(sub.quietHoursEnd).padStart(2, '0');
      const text = `🌙 <b>Тиха година</b>\n\nПід час тихої години сповіщення не надсилаються.\n\n${sub.quietHoursEnabled ? `✅ Увімкнено: ${currentStart}:00 – ${currentEnd}:00` : '❌ Вимкнено'}\n\nОберіть дію:`;
      const kb = {
        inline_keyboard: [
          [{ text: sub.quietHoursEnabled ? '❌ Вимкнути' : '✅ Увімкнути', callback_data: 'quiet_toggle' }],
          ...(sub.quietHoursEnabled ? [
            [{ text: `🕐 Початок: ${currentStart}:00`, callback_data: 'quiet_start' }],
            [{ text: `🕐 Кінець: ${currentEnd}:00`, callback_data: 'quiet_end' }],
          ] : []),
          [{ text: '◀️ Назад', callback_data: 'menu_notifications' }],
          [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
        ],
      };
      return replySafe(chatId, text, kb, messageId);
    }

    if (data === 'quiet_toggle') {
      const sub = getSubscriber(chatId);
      updateSubscriber(chatId, { quietHoursEnabled: !sub.quietHoursEnabled });
      return handleNotifications(chatId, messageId);
    }

    if (data === 'quiet_start' || data === 'quiet_end') {
      const isStart = data === 'quiet_start';
      const text = `🕐 <b>Оберіть ${isStart ? 'початок' : 'кінець'} тихої години:</b>`;
      const hours = [20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const rows = [];
      for (let i = 0; i < hours.length; i += 5) {
        rows.push(hours.slice(i, i + 5).map(h => ({
          text: `${String(h).padStart(2, '0')}:00`,
          callback_data: `quietset_${isStart ? 'start' : 'end'}_${h}`,
        })));
      }
      rows.push([{ text: '◀️ Назад', callback_data: 'notif_quiet_hours' }]);
      rows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
      return replySafe(chatId, text, { inline_keyboard: rows }, messageId);
    }

    if (data.startsWith('quietset_')) {
      const parts = data.replace('quietset_', '').split('_');
      const field = parts[0];
      const value = parseInt(parts[1]);
      if (field === 'start') {
        updateSubscriber(chatId, { quietHoursStart: value });
      } else {
        updateSubscriber(chatId, { quietHoursEnd: value });
      }
      return handleNotifications(chatId, messageId);
    }

    if (data === 'notif_briefing') {
      const sub = getSubscriber(chatId);
      const text = `☀️ <b>Ранковий брифінг</b>\n\nЩоденний огляд графіка на день.\n\n${sub.morningBriefingEnabled ? `✅ Увімкнено о ${String(sub.morningBriefingHour).padStart(2, '0')}:00` : '❌ Вимкнено'}\n\nОберіть дію:`;
      const kb = {
        inline_keyboard: [
          [{ text: sub.morningBriefingEnabled ? '❌ Вимкнути' : '✅ Увімкнути', callback_data: 'briefing_toggle' }],
          ...(sub.morningBriefingEnabled ? [
            [{ text: `🕐 Час: ${String(sub.morningBriefingHour).padStart(2, '0')}:00`, callback_data: 'briefing_hour' }],
          ] : []),
          [{ text: '◀️ Назад', callback_data: 'menu_notifications' }],
          [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
        ],
      };
      return replySafe(chatId, text, kb, messageId);
    }

    if (data === 'briefing_toggle') {
      const sub = getSubscriber(chatId);
      updateSubscriber(chatId, { morningBriefingEnabled: !sub.morningBriefingEnabled });
      return handleNotifications(chatId, messageId);
    }

    if (data === 'briefing_hour') {
      const text = `🕐 <b>Оберіть час ранкового брифінгу:</b>`;
      const hours = [5, 6, 7, 8, 9, 10, 11, 12];
      const rows = [];
      for (let i = 0; i < hours.length; i += 4) {
        rows.push(hours.slice(i, i + 4).map(h => ({
          text: `${String(h).padStart(2, '0')}:00`,
          callback_data: `briefset_${h}`,
        })));
      }
      rows.push([{ text: '◀️ Назад', callback_data: 'notif_briefing' }]);
      rows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
      return replySafe(chatId, text, { inline_keyboard: rows }, messageId);
    }

    if (data.startsWith('briefset_')) {
      const hour = parseInt(data.replace('briefset_', ''));
      updateSubscriber(chatId, { morningBriefingHour: hour });
      return handleNotifications(chatId, messageId);
    }

    if (data === 'notif_min_duration') {
      const sub = getSubscriber(chatId);
      const text = `⚡ <b>Мінімальна тривалість відключення</b>\n\nСповіщення про вимкнення надсилатимуться тільки якщо заплановане відключення триватиме не менше вказаного часу.\n\n📊 Поточне: <b>${sub.minOutageDuration > 0 ? `${sub.minOutageDuration} год` : 'Будь-яке (без фільтра)'}</b>\n\nОберіть мінімальну тривалість:`;
      const values = [0, 1, 2, 3, 4];
      const labels = ['Будь-яке', '1 год', '2 год', '3 год', '4 год'];
      const rows = [values.map((v, i) => ({
        text: labels[i],
        callback_data: `mindur_${v}`,
      }))];
      rows.push([{ text: '◀️ Назад', callback_data: 'menu_notifications' }]);
      rows.push([{ text: '↩️ Головне меню', callback_data: 'menu_main' }]);
      return replySafe(chatId, text, { inline_keyboard: rows }, messageId);
    }

    if (data.startsWith('mindur_')) {
      const value = parseInt(data.replace('mindur_', ''));
      updateSubscriber(chatId, { minOutageDuration: value });
      return handleNotifications(chatId, messageId);
    }

    if (data === 'settings_city') {
      const sub = getSubscriber(chatId);
      const city = getSubCity(sub);
      const text = `🏙 <b>Оберіть місто</b>\n\nПоточне: <b>${city}</b>`;
      const kb = {
        inline_keyboard: [
          [
            { text: `${city === 'Київ' ? '✅ ' : ''}Київ`, callback_data: 'setcity_Київ' },
            { text: `${city === 'Харків' ? '✅ ' : ''}Харків`, callback_data: 'setcity_Харків' },
          ],
          [
            { text: `${city === 'Одеса' ? '✅ ' : ''}Одеса`, callback_data: 'setcity_Одеса' },
            { text: `${city === 'Вінниця' ? '✅ ' : ''}Вінниця`, callback_data: 'setcity_Вінниця' },
          ],
          [{ text: '↩️ Назад', callback_data: 'menu_settings' }],
        ],
      };
      return replySafe(chatId, text, kb, messageId);
    }

    if (data.startsWith('setcity_')) {
      const newCity = data.replace('setcity_', '');
      if (newCity === 'Вінниця' || newCity === 'Київ' || newCity === 'Харків' || newCity === 'Одеса') {
        updateSubscriber(chatId, { city: newCity, queueId: '', street: '', houseNumber: '', lookupMode: 'queue' });
        const text = `✅ <b>Місто змінено на ${newCity}</b>\n\nДодайте адресу через налаштування.`;
        const kb = {
          inline_keyboard: [
            [miniAppButton()],
            [{ text: '⚙️ Налаштування', callback_data: 'menu_settings' }],
            [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
          ],
        };
        return replySafe(chatId, text, kb, messageId);
      }
    }

    if (data === 'settings_reset') return handleSettingsReset(chatId, messageId);
    if (data === 'confirm_reset') {
      userStates.delete(chatId);
      updateSubscriber(chatId, {
        queueId: '',
        street: '',
        houseNumber: '',
        lookupMode: 'queue',
        notifyBeforeOff: 30,
        notifyBeforeOn: 15,
        enabled: true,
        lastNotifKey: '',
      });
      const text = `✅ <b>Налаштування скинуто</b>\n\nДодайте адресу для початку:`;
      const kb = {
        inline_keyboard: [
          [miniAppButton()],
          [{ text: '📍 Додати адресу', callback_data: 'loc_add_start' }],
          [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
        ],
      };
      cleanupChat(chatId, messageId);
      return editMessage(chatId, messageId, text, kb);
    }
  }
}

export async function handleWebhookUpdate(update: any) {
  if (isIsolatedMode()) throw new Error('LBA_TELEGRAM_DISABLED');
  if (process.env.NODE_ENV === 'production' && !productionRuntimePolicy().telegramUpdatesEnabled) throw new Error('LBA_TELEGRAM_UPDATES_PAUSED');
  try {
    await processUpdate(update);
  } catch (e: any) {
    console.error('[TG Bot] Error processing webhook update');
    throw new Error('LBA_TELEGRAM_UPDATE_UNCONFIRMED');
  }
}

function computeDaySlotsHash(slots: { start: string; end: string; status: string }[], dateStr: string): string {
  const allData = slots
    .map(s => `${s.start}-${s.end}-${s.status}`)
    .join('|');
  return createHash('md5').update(`${dateStr}:${allData}`).digest('hex').slice(0, 16);
}

type Slot = { start: string; end: string; status: string };
const previousSlotsCache = new Map<string, Slot[]>();

function describeSlotsChange(prevSlots: Slot[], newSlots: Slot[], kyivHour: number): string {
  const getOfflineRanges = (slots: Slot[]): { start: number; end: number }[] =>
    slots.filter(s => s.status === 'offline').map(s => ({
      start: parseInt(s.start.split(':')[0]),
      end: s.end === '24:00' ? 24 : parseInt(s.end.split(':')[0]),
    }));

  const prevOff = getOfflineRanges(prevSlots);
  const newOff = getOfflineRanges(newSlots);

  const toHourSet = (ranges: { start: number; end: number }[]) => {
    const s = new Set<number>();
    for (const r of ranges) for (let h = r.start; h < r.end; h++) s.add(h);
    return s;
  };
  const prevHours = toHourSet(prevOff);
  const newHours = toHourSet(newOff);

  const addedHours = [...newHours].filter(h => !prevHours.has(h) && h >= kyivHour).sort((a, b) => a - b);
  const removedHours = [...prevHours].filter(h => !newHours.has(h) && h >= kyivHour).sort((a, b) => a - b);

  if (addedHours.length === 0 && removedHours.length === 0) {
    const addedPast = [...newHours].filter(h => !prevHours.has(h)).length;
    const removedPast = [...prevHours].filter(h => !newHours.has(h)).length;
    if (addedPast > 0 || removedPast > 0) {
      return '📋 Зміни стосуються минулих годин.';
    }
    return '';
  }

  const groupConsecutive = (hours: number[]): string[] => {
    if (hours.length === 0) return [];
    const groups: string[] = [];
    let start = hours[0], end = hours[0];
    for (let i = 1; i < hours.length; i++) {
      if (hours[i] === end + 1) { end = hours[i]; }
      else { groups.push(start === end ? `${start}:00` : `${start}:00–${end + 1}:00`); start = hours[i]; end = hours[i]; }
    }
    groups.push(start === end ? `${start}:00–${start + 1}:00` : `${start}:00–${end + 1}:00`);
    return groups;
  };

  const lines: string[] = [];
  if (addedHours.length > 0) {
    lines.push(`🔴 Додано відключення: ${groupConsecutive(addedHours).join(', ')}`);
  }
  if (removedHours.length > 0) {
    lines.push(`🟢 Знято відключення: ${groupConsecutive(removedHours).join(', ')}`);
  }
  return lines.join('\n');
}

const locationNameCache = new Map<string, { name: string | null; ts: number }>();
async function getSubscriberLocationName(chatId: string, queueId: string): Promise<string | null> {
  const key = `${chatId}:${queueId}`;
  const cached = locationNameCache.get(key);
  if (cached && Date.now() - cached.ts < 300000) return cached.name;
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const locs = await getUserLocations(linked.userId);
      const match = locs.find(l => l.queueId === queueId);
      const name = match?.name || null;
      locationNameCache.set(key, { name, ts: Date.now() });
      return name;
    }
  } catch {}
  locationNameCache.set(key, { name: null, ts: Date.now() });
  return null;
}

let notifCheckRunning = false;
let lastNotifLogTime = 0;
let lastNotifCheckTime = 0;

export async function triggerNotifCheckIfNeeded() {
  if (isIsolatedMode()) return;
  if (process.env.NODE_ENV !== 'production' || !productionRuntimePolicy().notificationSchedulerEnabled) return;
  const now = Date.now();
  if (now - lastNotifCheckTime < 25000) return;
  lastNotifCheckTime = now;
  checkAndNotifySubscribers().catch(e => {
    console.error('[TG Bot] Piggybacked notif check error:', e.message);
  });
}

const linkedAccountCache = new Map<string, { userId: string | null; ts: number }>();
async function getCachedLinkedUserId(chatId: string): Promise<string | null> {
  const cached = linkedAccountCache.get(chatId);
  if (cached && Date.now() - cached.ts < 600000) return cached.userId;
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    const userId = linked?.userId || null;
    linkedAccountCache.set(chatId, { userId, ts: Date.now() });
    return userId;
  } catch {
    return null;
  }
}

function getScheduleForCity(city: string, queueId: string, voeData: any, kyivData: any, kharkivData: any, odesaData?: any) {
  if (city === 'Київ') {
    if (!kyivData) return null;
    return parseKyivScheduleForQueue(kyivData, queueId);
  } else if (city === 'Харків') {
    if (!kharkivData) return null;
    return parseKharkivScheduleForQueue(kharkivData, queueId);
  } else if (city === 'Одеса') {
    if (!odesaData) return null;
    return parseOdesaScheduleForQueue(odesaData, queueId);
  } else {
    if (!voeData) return null;
    return parseScheduleForQueue(voeData, queueId);
  }
}

async function sendMorningBriefing(
  chatId: string,
  sub: Subscriber,
  voeData: any,
  kyivData: any,
  kharkivData: any,
  odesaData: any,
  dateStr: string,
) {
  const kyivNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const kyivHour = kyivNow.getHours();
  const kyivMinute = kyivNow.getMinutes();

  let locSummaries: string[] = [];
  let primarySchedule: { slots: any[]; queueId: string; city: string; street?: string | null; houseNumber?: string | null; tomorrow?: any } | null = null;

  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { getUserLocations } = await import('./storage-locations');
    const linked = await getLinkedAccountByProvider('telegram', chatId);

    if (linked) {
      const locations = await getUserLocations(linked.userId);
      const tgLocs = locations.filter((l: any) => l.telegramNotify && l.queueId);

      for (const loc of tgLocs as any[]) {
        const city = loc.city || 'Вінниця';
        const schedule = getScheduleForCity(city, loc.queueId!, voeData, kyivData, kharkivData, odesaData);
        if (!schedule) continue;
        const today = schedule.days[0];
        if (!today) continue;
        const tomorrow = schedule.days[1];

        const offlineSlots = today.slots.filter((s: any) => s.status === 'offline');
        const totalOfflineH = offlineSlots.reduce((sum: number, s: any) => {
          const startH = parseInt(s.start.split(':')[0]);
          const endH = s.end === '24:00' ? 24 : parseInt(s.end.split(':')[0]);
          return sum + (endH - startH);
        }, 0);

        const locEmoji = getLocationEmoji(loc.name);
        const currentStatus = getCurrentHourStatus(today.slots, kyivHour);
        const statusIcon = currentStatus === 'online' ? '🟢' : '🔴';
        const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots, kyivMinute);

        let summary = `${locEmoji} <b>${loc.name}</b> — ${city}, ${queueLabelLower(city)} ${loc.queueId}\n`;
        summary += `${statusIcon} Зараз: ${currentStatus === 'online' ? 'є світло' : 'немає світла'}\n`;
        summary += `⚡ Відключень: ${totalOfflineH} год за день`;
        if (offlineSlots.length > 0) {
          const periods = offlineSlots.map((s: any) => `${s.start}–${s.end}`).join(', ');
          summary += `\n🕐 ${periods}`;
        }
        if (nextChange && nextChange.minutesLeft > 0) {
          summary += `\n⏱ ${nextChange.toStatus === 'online' ? 'Увімкнення' : 'Вимкнення'} о ${nextChange.time} (через ${formatMinutes(nextChange.minutesLeft)})`;
        }
        locSummaries.push(summary);

        if (!primarySchedule || (loc as any).isPrimary) {
          primarySchedule = { slots: today.slots, queueId: loc.queueId!, city, street: loc.street, houseNumber: loc.houseNumber, tomorrow };
        }
      }
    }
  } catch (e: any) {
    console.error('[TG Bot] Briefing locations error:', e.message);
  }

  if (locSummaries.length === 0 && sub.queueId) {
    const city = getSubCity(sub);
    const schedule = getScheduleForCity(city, sub.queueId, voeData, kyivData, kharkivData, odesaData);
    if (schedule) {
      const today = schedule.days[0];
      if (today) {
        const tomorrow = schedule.days[1];
        const offlineSlots = today.slots.filter((s: any) => s.status === 'offline');
        const totalOfflineH = offlineSlots.reduce((sum: number, s: any) => {
          const startH = parseInt(s.start.split(':')[0]);
          const endH = s.end === '24:00' ? 24 : parseInt(s.end.split(':')[0]);
          return sum + (endH - startH);
        }, 0);
        const currentStatus = getCurrentHourStatus(today.slots, kyivHour);
        const statusIcon = currentStatus === 'online' ? '🟢' : '🔴';
        const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots, kyivMinute);

        let summary = `${formatAddressLine(sub, city)}\n${formatQueueLine(sub, city)}\n`;
        summary += `${statusIcon} Зараз: ${currentStatus === 'online' ? 'є світло' : 'немає світла'}\n`;
        summary += `⚡ Відключень: ${totalOfflineH} год за день`;
        if (offlineSlots.length > 0) {
          const periods = offlineSlots.map((s: any) => `${s.start}–${s.end}`).join(', ');
          summary += `\n🕐 ${periods}`;
        }
        if (nextChange && nextChange.minutesLeft > 0) {
          summary += `\n⏱ ${nextChange.toStatus === 'online' ? 'Увімкнення' : 'Вимкнення'} о ${nextChange.time} (через ${formatMinutes(nextChange.minutesLeft)})`;
        }
        locSummaries.push(summary);
        primarySchedule = { slots: today.slots, queueId: sub.queueId, city, street: sub.street, houseNumber: sub.houseNumber, tomorrow };
      }
    }
  }

  if (locSummaries.length === 0) return;

  const text = `☀️ <b>Доброго ранку! Огляд на сьогодні</b>\n📅 ${dateStr}\n\n${locSummaries.join('\n\n')}\n\n<i>Гарного дня!</i>`;
  const notifKb = notificationKeyboard(sub);

  if (primarySchedule) {
    try {
      const nextChange = findNextChange(primarySchedule.slots, kyivHour, primarySchedule.tomorrow?.slots, kyivMinute);
      const imgPath = await generateScheduleImage(primarySchedule.slots, primarySchedule.queueId, kyivHour, kyivMinute, primarySchedule.street || undefined, primarySchedule.houseNumber || undefined, nextChange);
      if (imgPath) {
        await sendAndClean(chatId, () => sendPhoto(chatId, imgPath!, text, notifKb, true));
        console.log(`[TG Bot] Morning briefing sent to ${chatId} (${locSummaries.length} locations)`);
        return;
      }
    } catch {}
  }

  await sendAndClean(chatId, () => sendMessage(chatId, text, notifKb));
  console.log(`[TG Bot] Morning briefing sent to ${chatId} (text only, ${locSummaries.length} locations)`);
}

async function sendLocationNotification(
  chatId: string,
  type: 'schedule_change' | 'power_change',
  params: {
    locName: string;
    city: string;
    queueId: string;
    street?: string | null;
    houseNumber?: string | null;
    slots: any[];
    kyivHour: number;
    kyivMinute: number;
    today: any;
    tomorrow?: any;
    isOnline?: boolean;
    nextChange?: any;
    timeStr?: string;
    currentHash?: string;
    sub: Subscriber;
    changeDescription?: string;
  }
) {
  const locEmoji = getLocationEmoji(params.locName);
  const locLabel = `\n${locEmoji} <b>${params.locName}</b>`;
  const addrSub = { street: params.street, houseNumber: params.houseNumber, queueId: params.queueId };

  if (type === 'schedule_change') {
    try {
      const nextChange = findNextChange(params.slots, params.kyivHour, params.tomorrow?.slots, params.kyivMinute);
      const schCacheKey = `full-${params.city}-${params.queueId}-${params.kyivHour}-${params.kyivMinute}-${params.today.date}`;
      let imgPath = getCachedImage(schCacheKey);
      if (!imgPath) {
        imgPath = await generateScheduleImage(params.slots, params.queueId, params.kyivHour, params.kyivMinute, params.street || undefined, params.houseNumber || undefined, nextChange);
        if (imgPath) setCachedImage(schCacheKey, imgPath);
      }
      let nextChangeLine = '';
      if (nextChange && nextChange.minutesLeft > 0) {
        const chHour = parseInt(nextChange.time.split(':')[0]);
        const chStatus = nextChange.toStatus === 'online' ? 'online' : 'offline';
        const pInfo = findPeriodEndAfterChange(params.slots, chHour, chStatus, params.tomorrow?.slots);
        nextChangeLine = `\n\n⏱ ${nextChange.toStatus === 'online' ? 'Увімкнення' : 'Вимкнення'} о <b>${nextChange.time}</b> (через ${formatMinutes(nextChange.minutesLeft)})`;
        if (pInfo) {
          nextChangeLine += `\n⏳ Тривалість: <b>${pInfo.durationHours} год</b>, ${chStatus === 'offline' ? 'увімкнення' : 'вимкнення'} о <b>${pInfo.endTime}</b>`;
        }
      }
      const changeLine = params.changeDescription ? `\n\n${params.changeDescription}` : '';
      const caption = `📢 <b>Графік на сьогодні змінився!</b>${locLabel}\n${formatAddressLine(addrSub, params.city)}\n${formatQueueLine(addrSub, params.city)}${changeLine}${nextChangeLine}\n\n<i>Перевірте оновлений розклад нижче.</i>`;
      const notifKb = notificationKeyboard(params.sub);
      if (imgPath) {
        await sendAndClean(chatId, () => sendPhoto(chatId, imgPath!, caption, notifKb, true));
      } else {
        await sendAndClean(chatId, () => sendMessage(chatId, caption, notifKb));
      }
    } catch (imgErr: any) {
      console.error(`[TG Bot] Schedule change img error for ${chatId}:`, imgErr.message);
      const changeLineErr = params.changeDescription ? `\n\n${params.changeDescription}` : '';
      const caption = `📢 <b>Графік на сьогодні змінився!</b>${locLabel}\n${formatAddressLine(addrSub, params.city)}\n${formatQueueLine(addrSub, params.city)}${changeLineErr}\n\nНатисніть кнопку нижче, щоб переглянути.`;
      await sendAndClean(chatId, () => sendMessage(chatId, caption, notificationKeyboard(params.sub)));
    }
  } else {
    const { isOnline, nextChange, timeStr } = params;
    if (!nextChange || !timeStr) return;
    const notifType = isOnline ? 'off' : 'on';
    const changeHour = parseInt(nextChange.time.split(':')[0]);
    const nextStatus = nextChange.toStatus === 'online' ? 'online' : 'offline';
    const periodInfo = findPeriodEndAfterChange(params.slots, changeHour, nextStatus, params.tomorrow?.slots);
    const durationLine = periodInfo
      ? `\n⏳ Тривалість: <b>${periodInfo.durationHours} год</b>, ${nextStatus === 'offline' ? 'увімкнення' : 'вимкнення'} о <b>${periodInfo.endTime}</b>`
      : '';
    try {
      const imgPath = await generateNotificationImage(
        notifType, nextChange.minutesLeft, nextChange.time,
        params.queueId, params.kyivHour, params.kyivMinute, params.slots,
        params.street || undefined, params.houseNumber || undefined,
      );
      const emoji = isOnline ? '🔴' : '🟢';
      const label = isOnline ? 'Світло вимкнуть незабаром' : 'Світло ввімкнуть незабаром';
      const caption = `${emoji} <b>${label}</b>${locLabel}\n⏱ Через <b>${timeStr}</b> — о <b>${nextChange.time}</b>${durationLine}\n${formatAddressLine(addrSub, params.city)}\n${formatQueueLine(addrSub, params.city)}`;
      await sendAndClean(chatId, () => sendPhoto(chatId, imgPath, caption, notificationKeyboard(params.sub)));
    } catch (imgErr: any) {
      console.error(`[TG Bot] Notif img error for ${chatId}:`, imgErr.message);
      const emoji = isOnline ? '🔴' : '🟢';
      const label = isOnline ? 'Світло вимкнуть незабаром' : 'Світло ввімкнуть незабаром';
      let text = `${emoji} <b>${label}</b>${locLabel}\n\n⏱ Через <b>${timeStr}</b> — о <b>${nextChange.time}</b>${durationLine}`;
      text += `\n${formatAddressLine(addrSub, params.city)}`;
      text += `\n${formatQueueLine(addrSub, params.city)}`;
      await sendAndClean(chatId, () => sendMessage(chatId, text, notificationKeyboard(params.sub)));
    }
  }
}

async function checkAndNotifySubscribers() {
  if (notifCheckRunning) return;
  notifCheckRunning = true;
  const token = BOT_TOKEN();
  if (!token) { notifCheckRunning = false; return; }

  try {
    const [voeResult, kyivResult, kharkivResult, odesaResult] = await Promise.allSettled([
      fetchVoeData(),
      fetchKyivPlannedData(),
      fetchKharkivScheduleData(),
      fetchOdesaScheduleData(),
    ]);
    const voeData = voeResult.status === 'fulfilled' ? voeResult.value : null;
    const kyivData = kyivResult.status === 'fulfilled' ? kyivResult.value : null;
    const kharkivData = kharkivResult.status === 'fulfilled' ? kharkivResult.value : null;
    const odesaData = odesaResult.status === 'fulfilled' ? odesaResult.value : null;

    const now = new Date();
    const kyivHour = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }));
    const kyivMinute = parseInt(now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', minute: '2-digit' }));
    const kyivDateParts = now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).split('.');
    const dateStr = `${kyivDateParts[2]}-${kyivDateParts[1]}-${kyivDateParts[0]}`;

    const shouldLog = Date.now() - lastNotifLogTime > 300000;
    if (shouldLog) {
      lastNotifLogTime = Date.now();
      const subCount = subscribers.size;
      const enabledCount = Array.from(subscribers.values()).filter(s => s.enabled && s.queueId).length;
      console.log(`[TG Bot] Notif check: ${subCount} subs (${enabledCount} enabled), data: VOE-GH=${!!voeData} Kyiv=${!!kyivData} Kharkiv=${!!kharkivData} Odesa=${!!odesaData}, time=${kyivHour}:${String(kyivMinute).padStart(2, '0')}`);
    }

    const { getUserLocations } = await import('./storage-locations');
    const { updateLocationNotifTracking } = await import('./storage-locations');

    for (const [chatId, sub] of Array.from(subscribers.entries())) {
      if (!sub.enabled) continue;

      try {
        if (sub.morningBriefingEnabled) {
          const briefingDate = `${dateStr}`;
          if (sub.lastBriefingDate !== briefingDate && kyivHour === sub.morningBriefingHour && kyivMinute < 10) {
            try {
              await sendMorningBriefing(chatId, sub, voeData, kyivData, kharkivData, odesaData, dateStr);
              updateSubscriber(chatId, { lastBriefingDate: briefingDate });
            } catch (briefErr: any) {
              console.error(`[TG Bot] Morning briefing error for ${chatId}:`, briefErr.message);
            }
          }
        }

        const linkedUserId = await getCachedLinkedUserId(chatId);

        if (linkedUserId) {
          const locations = await getUserLocations(linkedUserId);
          const tgLocations = locations.filter(l => l.telegramNotify && l.queueId);

          if (tgLocations.length > 0) {
            for (const loc of tgLocations) {
              try {
                const city = loc.city || 'Вінниця';
                const schedule = getScheduleForCity(city, loc.queueId!, voeData, kyivData, kharkivData, odesaData);
                if (!schedule) continue;

                const today = schedule.days[0];
                if (!today) continue;
                const tomorrow = schedule.days[1];

                const currentHash = computeDaySlotsHash(today.slots, dateStr);
                const prevHash = loc.lastScheduleHash || '';
                const slotsCacheKey = `${city}-${loc.queueId}-${dateStr}`;

                if (!previousSlotsCache.has(slotsCacheKey)) {
                  previousSlotsCache.set(slotsCacheKey, [...today.slots]);
                  if (!prevHash) {
                    await updateLocationNotifTracking(loc.id, { lastScheduleHash: currentHash });
                  }
                }

                if (prevHash && prevHash !== currentHash) {
                  const changeNotifKey = `schchange-${dateStr}-${currentHash}`;
                  if (loc.lastNotifKey !== changeNotifKey) {
                    await updateLocationNotifTracking(loc.id, { lastScheduleHash: currentHash, lastNotifKey: changeNotifKey });

                    const cooldownKey = `loc_${loc.id}`;
                    const lastSent = lastScheduleChangeNotif.get(cooldownKey) || 0;
                    const now = Date.now();
                    if (now - lastSent < SCHEDULE_CHANGE_COOLDOWN_MS) {
                      console.log(`[TG Bot] Schedule changed for ${chatId} loc "${loc.name}" (${city}, ${loc.queueId}) — skipped (cooldown ${Math.round((SCHEDULE_CHANGE_COOLDOWN_MS - (now - lastSent)) / 1000)}s remaining)`);
                      previousSlotsCache.set(slotsCacheKey, [...today.slots]);
                      continue;
                    }
                    lastScheduleChangeNotif.set(cooldownKey, now);

                    const prevSlots = previousSlotsCache.get(slotsCacheKey);
                    const changeDescription = prevSlots ? describeSlotsChange(prevSlots, today.slots, kyivHour) : '';
                    previousSlotsCache.set(slotsCacheKey, [...today.slots]);

                    console.log(`[TG Bot] Schedule changed for ${chatId} loc "${loc.name}" (${city}, ${loc.queueId})${changeDescription ? ': ' + changeDescription.replace(/\n/g, '; ') : ''}`);

                    await sendLocationNotification(chatId, 'schedule_change', {
                      locName: loc.name, city, queueId: loc.queueId!, street: loc.street, houseNumber: loc.houseNumber,
                      slots: today.slots, kyivHour, kyivMinute, today, tomorrow, sub, changeDescription,
                    });
                    continue;
                  }
                } else if (!prevHash) {
                  await updateLocationNotifTracking(loc.id, { lastScheduleHash: currentHash });
                }

                const currentStatus = getCurrentHourStatus(today.slots, kyivHour);
                const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots, kyivMinute);
                if (!nextChange || nextChange.minutesLeft <= 0) continue;

                if (isInQuietHours(sub, kyivHour)) continue;

                const isOnline = currentStatus === 'online';
                const threshold = isOnline ? (loc.notifyBeforeOff || 30) : (loc.notifyBeforeOn || 15);

                if (nextChange.minutesLeft <= threshold) {
                  if (isOnline && sub.minOutageDuration > 0) {
                    const changeH = parseInt(nextChange.time.split(':')[0]);
                    const outageDur = getOutageDurationHours(today.slots, changeH, tomorrow?.slots);
                    if (outageDur < sub.minOutageDuration) continue;
                  }

                  const notifKey = `${dateStr}-${isOnline ? 'off' : 'on'}-${nextChange.time}`;
                  if (loc.lastNotifKey === notifKey) continue;

                  await updateLocationNotifTracking(loc.id, { lastNotifKey: notifKey });
                  const timeStr = formatMinutes(nextChange.minutesLeft);
                  console.log(`[TG Bot] Sending ${isOnline ? 'off' : 'on'} notification to ${chatId} loc "${loc.name}" (${city}, ${loc.queueId}): ${timeStr} until ${nextChange.time}`);

                  await sendLocationNotification(chatId, 'power_change', {
                    locName: loc.name, city, queueId: loc.queueId!, street: loc.street, houseNumber: loc.houseNumber,
                    slots: today.slots, kyivHour, kyivMinute, today, tomorrow, isOnline, nextChange, timeStr, sub,
                  });
                }
              } catch (locErr: any) {
                console.error(`[TG Bot] Location ${loc.id} notif error for ${chatId}:`, locErr.message);
              }
            }
            continue;
          }
        }

        if (!sub.queueId) continue;

        const city = getSubCity(sub);
        const schedule = getScheduleForCity(city, sub.queueId, voeData, kyivData, kharkivData, odesaData);
        if (!schedule) continue;

        const today = schedule.days[0];
        if (!today) continue;
        const tomorrow = schedule.days[1];

        const currentHash = computeDaySlotsHash(today.slots, dateStr);
        const prevHash = sub.lastScheduleHash;
        const slotsCacheKey = `${city}-${sub.queueId}-${dateStr}`;

        if (!previousSlotsCache.has(slotsCacheKey)) {
          previousSlotsCache.set(slotsCacheKey, [...today.slots]);
          if (!prevHash) {
            updateSubscriber(chatId, { lastScheduleHash: currentHash });
          }
        }

        if (prevHash && prevHash !== currentHash) {
          const changeNotifKey = `schchange-${dateStr}-${currentHash}`;
          if (sub.lastNotifKey !== changeNotifKey) {
            updateSubscriber(chatId, { lastScheduleHash: currentHash, lastNotifKey: changeNotifKey });

            const cooldownKey = `sub_${chatId}_${sub.queueId}`;
            const lastSent = lastScheduleChangeNotif.get(cooldownKey) || 0;
            const nowMs = Date.now();
            if (nowMs - lastSent < SCHEDULE_CHANGE_COOLDOWN_MS) {
              console.log(`[TG Bot] Schedule changed for ${chatId} (${city}, ${sub.queueId}) — skipped (cooldown ${Math.round((SCHEDULE_CHANGE_COOLDOWN_MS - (nowMs - lastSent)) / 1000)}s remaining)`);
              previousSlotsCache.set(slotsCacheKey, [...today.slots]);
              continue;
            }
            lastScheduleChangeNotif.set(cooldownKey, nowMs);

            const prevSlots = previousSlotsCache.get(slotsCacheKey);
            const changeDescription = prevSlots ? describeSlotsChange(prevSlots, today.slots, kyivHour) : '';
            previousSlotsCache.set(slotsCacheKey, [...today.slots]);

            console.log(`[TG Bot] Schedule changed for ${chatId} (${city}, ${sub.queueId})${changeDescription ? ': ' + changeDescription.replace(/\n/g, '; ') : ''}`);

            const locName = await getSubscriberLocationName(chatId, sub.queueId);
            const locLabel = locName ? `\n🏠 <b>${locName}</b>` : '';
            const subChangeLine = changeDescription ? `\n\n${changeDescription}` : '';
            try {
              const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots, kyivMinute);
              const schCacheKey = `full-${city}-${sub.queueId}-${kyivHour}-${kyivMinute}-${today.date}`;
              let imgPath = getCachedImage(schCacheKey);
              if (!imgPath) {
                imgPath = await generateScheduleImage(today.slots, sub.queueId, kyivHour, kyivMinute, sub.street, sub.houseNumber, nextChange);
                if (imgPath) setCachedImage(schCacheKey, imgPath);
              }
              let subNextChangeLine = '';
              if (nextChange && nextChange.minutesLeft > 0) {
                const scHour = parseInt(nextChange.time.split(':')[0]);
                const scStatus = nextChange.toStatus === 'online' ? 'online' : 'offline';
                const scPInfo = findPeriodEndAfterChange(today.slots, scHour, scStatus, tomorrow?.slots);
                subNextChangeLine = `\n\n⏱ ${nextChange.toStatus === 'online' ? 'Увімкнення' : 'Вимкнення'} о <b>${nextChange.time}</b> (через ${formatMinutes(nextChange.minutesLeft)})`;
                if (scPInfo) {
                  subNextChangeLine += `\n⏳ Тривалість: <b>${scPInfo.durationHours} год</b>, ${scStatus === 'offline' ? 'увімкнення' : 'вимкнення'} о <b>${scPInfo.endTime}</b>`;
                }
              }
              const caption = `📢 <b>Графік на сьогодні змінився!</b>${locLabel}\n${formatAddressLine(sub, city)}\n${formatQueueLine(sub, city)}${subChangeLine}${subNextChangeLine}\n\n<i>Перевірте оновлений розклад нижче.</i>`;
              const notifKb = notificationKeyboard(sub);
              if (imgPath) {
                await sendAndClean(chatId, () => sendPhoto(chatId, imgPath!, caption, notifKb, true));
              } else {
                await sendAndClean(chatId, () => sendMessage(chatId, caption, notifKb));
              }
            } catch (imgErr: any) {
              console.error(`[TG Bot] Schedule change img error for ${chatId}:`, imgErr.message);
              await sendAndClean(chatId, () => sendMessage(chatId, `📢 <b>Графік на сьогодні змінився!</b>${locLabel}\n${formatAddressLine(sub, city)}\n${formatQueueLine(sub, city)}${subChangeLine}\n\nНатисніть кнопку нижче, щоб переглянути.`, notificationKeyboard(sub)));
            }
            continue;
          }
        } else if (!prevHash) {
          updateSubscriber(chatId, { lastScheduleHash: currentHash });
        }

        const currentStatus = getCurrentHourStatus(today.slots, kyivHour);
        const nextChange = findNextChange(today.slots, kyivHour, tomorrow?.slots, kyivMinute);
        if (!nextChange || nextChange.minutesLeft <= 0) continue;

        if (isInQuietHours(sub, kyivHour)) continue;

        const isOnline = currentStatus === 'online';
        const threshold = isOnline ? sub.notifyBeforeOff : sub.notifyBeforeOn;

        if (nextChange.minutesLeft <= threshold) {
          if (isOnline && sub.minOutageDuration > 0) {
            const changeH = parseInt(nextChange.time.split(':')[0]);
            const outageDur = getOutageDurationHours(today.slots, changeH, tomorrow?.slots);
            if (outageDur < sub.minOutageDuration) continue;
          }

          const notifKey = `${dateStr}-${isOnline ? 'off' : 'on'}-${nextChange.time}`;
          if (sub.lastNotifKey === notifKey) continue;

          updateSubscriber(chatId, { lastNotifKey: notifKey });
          const notifType = isOnline ? 'off' : 'on';
          const timeStr = formatMinutes(nextChange.minutesLeft);
          console.log(`[TG Bot] Sending ${notifType} notification to ${chatId} (${city}, ${sub.queueId}): ${timeStr} until ${nextChange.time}`);

          const subChangeHour = parseInt(nextChange.time.split(':')[0]);
          const subNextStatus = nextChange.toStatus === 'online' ? 'online' : 'offline';
          const subPeriodInfo = findPeriodEndAfterChange(today.slots, subChangeHour, subNextStatus, tomorrow?.slots);
          const subDurationLine = subPeriodInfo
            ? `\n⏳ Тривалість: <b>${subPeriodInfo.durationHours} год</b>, ${subNextStatus === 'offline' ? 'увімкнення' : 'вимкнення'} о <b>${subPeriodInfo.endTime}</b>`
            : '';
          try {
            const imgPath = await generateNotificationImage(
              notifType, nextChange.minutesLeft, nextChange.time,
              sub.queueId, kyivHour, kyivMinute, today.slots,
              sub.street, sub.houseNumber,
            );
            const locName = await getSubscriberLocationName(chatId, sub.queueId);
            const locLabel = locName ? `\n🏠 <b>${locName}</b>` : '';
            const emoji = isOnline ? '🔴' : '🟢';
            const label = isOnline ? 'Світло вимкнуть незабаром' : 'Світло ввімкнуть незабаром';
            const caption = `${emoji} <b>${label}</b>${locLabel}\n⏱ Через <b>${timeStr}</b> — о <b>${nextChange.time}</b>${subDurationLine}\n${formatAddressLine(sub, city)}\n${formatQueueLine(sub, city)}`;
            await sendAndClean(chatId, () => sendPhoto(chatId, imgPath, caption, notificationKeyboard(sub)));
          } catch (imgErr: any) {
            console.error(`[TG Bot] Notif img error for ${chatId}:`, imgErr.message);
            const locName2 = await getSubscriberLocationName(chatId, sub.queueId);
            const locLabel2 = locName2 ? `\n🏠 <b>${locName2}</b>` : '';
            let text = isOnline
              ? `🔴 <b>Світло вимкнуть незабаром</b>${locLabel2}\n\n⏱ Через <b>${timeStr}</b> — о <b>${nextChange.time}</b>${subDurationLine}`
              : `🟢 <b>Світло ввімкнуть незабаром</b>${locLabel2}\n\n⏱ Через <b>${timeStr}</b> — о <b>${nextChange.time}</b>${subDurationLine}`;
            text += `\n${formatAddressLine(sub, city)}`;
            text += `\n${formatQueueLine(sub, city)}`;
            await sendAndClean(chatId, () => sendMessage(chatId, text, notificationKeyboard(sub)));
          }
        }
      } catch (e: any) {
        console.error(`[TG Bot] Subscriber ${chatId} notif error:`, e.message);
      }
    }
  } catch (e: any) {
    console.error('[TG Bot] Notification check error:', e.message);
  } finally {
    notifCheckRunning = false;
  }
}

export function getWebhookSecret() {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (!secret || /LOCAL[-_]TEST/i.test(secret)) throw new Error('LBA_WEBHOOK_SECRET_REQUIRED');
  return secret;
}

async function initSubscriberHashes() {
  try {
    const [voeResult, kyivResult, kharkivResult, odesaResult] = await Promise.allSettled([
      fetchVoeData(),
      fetchKyivPlannedData(),
      fetchKharkivScheduleData(),
      fetchOdesaScheduleData(),
    ]);
    const voeData = voeResult.status === 'fulfilled' ? voeResult.value : null;
    const kyivPlannedData = kyivResult.status === 'fulfilled' ? kyivResult.value : null;
    const kharkivData = kharkivResult.status === 'fulfilled' ? kharkivResult.value : null;
    const odesaData = odesaResult.status === 'fulfilled' ? odesaResult.value : null;
    console.log(`[TG Bot] initHashes data: VOE-GH=${!!voeData} Kyiv=${!!kyivPlannedData} Kharkiv=${!!kharkivData} Odesa=${!!odesaData}`);

    const now = new Date();
    const kyivDateParts = now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).split('.');
    const dateStr = `${kyivDateParts[2]}-${kyivDateParts[1]}-${kyivDateParts[0]}`;
    let updated = 0;

    for (const [chatId, sub] of Array.from(subscribers.entries())) {
      if (!sub.enabled || !sub.queueId) continue;
      try {
        const city = getSubCity(sub);
        const schedule = getScheduleForCity(city, sub.queueId, voeData, kyivPlannedData, kharkivData, odesaData);
        if (!schedule) continue;
        const today = schedule.days[0];
        if (!today) continue;
        const currentHash = computeDaySlotsHash(today.slots, dateStr);
        if (sub.lastScheduleHash !== currentHash) {
          sub.lastScheduleHash = currentHash;
          subscribers.set(chatId, sub);
          updated++;
        }
      } catch {}
    }
    if (updated > 0) {
      for (const [chatId, sub] of Array.from(subscribers.entries())) {
        if (sub.lastScheduleHash) {
          dbUpsertSubscriber(chatId, { lastScheduleHash: sub.lastScheduleHash }).catch(e =>
            console.error('[TG Bot] DB upsert error (hash init):', e.message));
        }
      }
      console.log(`[TG Bot] Initialized schedule hashes for ${updated} subscribers (no notifications sent)`);
    }
  } catch (e: any) {
    console.error('[TG Bot] Failed to init subscriber hashes:', e.message);
  }
}

async function reconcileSubscribersWithUserSettings() {
  let reconciled = 0;
  for (const [chatId, sub] of Array.from(subscribers.entries())) {
    try {
      const userSett = await getUserSettingsByTelegramChatId(chatId);
      if (!userSett) continue;

      const updates: Partial<Subscriber> = {};
      if (userSett.city && userSett.city !== (sub.city || 'Вінниця')) updates.city = userSett.city;
      if (userSett.queueId !== undefined && userSett.queueId !== (sub.queueId || '')) updates.queueId = userSett.queueId || '';
      if (userSett.street !== undefined && userSett.street !== (sub.street || '')) updates.street = userSett.street || '';
      if (userSett.houseNumber !== undefined && userSett.houseNumber !== (sub.houseNumber || '')) updates.houseNumber = userSett.houseNumber || '';
      if (userSett.lookupMode && userSett.lookupMode !== (sub.lookupMode || 'queue')) updates.lookupMode = userSett.lookupMode as any;

      if (Object.keys(updates).length > 0) {
        Object.assign(sub, updates);
        subscribers.set(chatId, sub);
        dbUpsertSubscriber(chatId, subscriberToDb(updates)).catch(e =>
          console.error(`[TG Bot] Reconcile DB error for ${chatId}:`, e.message));
        reconciled++;
      }
    } catch (e: any) {
      console.error(`[TG Bot] Reconcile error for ${chatId}:`, e.message);
    }
  }
  if (reconciled > 0) {
    console.log(`[TG Bot] Reconciled ${reconciled} subscriber(s) with user_settings`);
  }
}

async function migrateAllBotSubscribersToLocations() {
  let migrated = 0;
  try {
    const { getLinkedAccountByProvider } = await import('./storage');
    const { migrateBotSubscriberToLocations } = await import('./storage-locations');
    for (const [chatId, sub] of Array.from(subscribers.entries())) {
      if (!sub.queueId) continue;
      try {
        const linked = await getLinkedAccountByProvider('telegram', chatId);
        if (linked) {
          const ok = await migrateBotSubscriberToLocations(linked.userId, chatId, sub);
          if (ok) migrated++;
        }
      } catch {}
    }
    if (migrated > 0) {
      console.log(`[TG Bot] Migrated ${migrated} subscriber(s) to user_locations`);
    }
  } catch (e: any) {
    console.error('[TG Bot] Bulk migration error:', e.message);
  }
}

export async function startTelegramBot() {
  if (isIsolatedMode()) return;
  // Boot preserves the current Telegram control plane and never rotates its webhook,
  // commands, name, description or menu. These are explicit reviewed release actions.
  if (process.env.NODE_ENV !== 'production') return;
  const policy = productionRuntimePolicy();
  if (policy.loadSubscribersOnStart) await loadSubscribers();
  if (policy.reconcileSubscribersOnStart) await reconcileSubscribersWithUserSettings();
  if (policy.migrateSubscribersOnStart) await migrateAllBotSubscribersToLocations();
  if (policy.initializeSubscriberHashesOnStart) await initSubscriberHashes();
  if (!policy.notificationSchedulerEnabled || notifInterval) return;
  notifInterval = setInterval(() => {
    lastNotifCheckTime = Date.now();
    checkAndNotifySubscribers().catch(() => console.error('[TG Bot] Scheduled notification check failed'));
  }, 30000);
  console.log('[TG Bot] Explicitly enabled notification scheduler started; webhook preserved');
}

const autoLoginTokens = new Map<string, { chatId: string; firstName?: string; username?: string; ts: number }>();
const AUTO_LOGIN_TTL = 5 * 60 * 1000;

export function generateAutoLoginToken(chatId: string): string {
  const sub = subscribers.get(chatId);
  const token = randomBytes(32).toString('hex');
  autoLoginTokens.set(token, {
    chatId,
    firstName: sub?.firstName,
    username: sub?.username,
    ts: Date.now(),
  });
  const now = Date.now();
  for (const [k, v] of autoLoginTokens) {
    if (now - v.ts > AUTO_LOGIN_TTL) autoLoginTokens.delete(k);
  }
  return token;
}

export function peekAutoLoginToken(token: string): { chatId: string; firstName?: string; username?: string } | null {
  const entry = autoLoginTokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.ts > AUTO_LOGIN_TTL) {
    autoLoginTokens.delete(token);
    return null;
  }
  return { chatId: entry.chatId, firstName: entry.firstName, username: entry.username };
}

export function consumeAutoLoginToken(token: string): { chatId: string; firstName?: string; username?: string } | null {
  const entry = autoLoginTokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.ts > AUTO_LOGIN_TTL) {
    autoLoginTokens.delete(token);
    return null;
  }
  autoLoginTokens.delete(token);
  return { chatId: entry.chatId, firstName: entry.firstName, username: entry.username };
}

const linkTokens = new Map<string, { userId: string; ts: number }>();
const LINK_TOKEN_TTL = 10 * 60 * 1000;

export function generateLinkToken(userId: string): string {
  const token = randomBytes(16).toString('hex');
  linkTokens.set(token, { userId, ts: Date.now() });
  const now = Date.now();
  for (const [k, v] of linkTokens) {
    if (now - v.ts > LINK_TOKEN_TTL) linkTokens.delete(k);
  }
  return token;
}

export function consumeLinkToken(token: string): { userId: string } | null {
  const entry = linkTokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.ts > LINK_TOKEN_TTL) {
    linkTokens.delete(token);
    return null;
  }
  linkTokens.delete(token);
  return { userId: entry.userId };
}

const webLoginTokens = new Map<string, { ts: number; autoLoginToken?: string; chatId?: string }>();
const WEB_LOGIN_TTL = 5 * 60 * 1000;

export function generateWebLoginToken(): string {
  const token = randomBytes(16).toString('hex');
  webLoginTokens.set(token, { ts: Date.now() });
  const now = Date.now();
  for (const [k, v] of webLoginTokens) {
    if (now - v.ts > WEB_LOGIN_TTL) webLoginTokens.delete(k);
  }
  return token;
}

export function resolveWebLoginToken(token: string): { ready: boolean; autoLoginToken?: string } {
  const entry = webLoginTokens.get(token);
  if (!entry) return { ready: false };
  if (Date.now() - entry.ts > WEB_LOGIN_TTL) {
    webLoginTokens.delete(token);
    return { ready: false };
  }
  if (entry.autoLoginToken) {
    webLoginTokens.delete(token);
    return { ready: true, autoLoginToken: entry.autoLoginToken };
  }
  return { ready: false };
}

export function fulfillWebLoginToken(webToken: string, chatId: string): boolean {
  const entry = webLoginTokens.get(webToken);
  if (!entry) return false;
  if (Date.now() - entry.ts > WEB_LOGIN_TTL) {
    webLoginTokens.delete(webToken);
    return false;
  }
  const autoToken = generateAutoLoginToken(chatId);
  entry.autoLoginToken = autoToken;
  entry.chatId = chatId;
  return true;
}

export function stopTelegramBot() {
  botActive = false;
  if (notifInterval) {
    clearInterval(notifInterval);
    notifInterval = null;
  }
  console.log('[TG Bot] Stopped');
}

export function getSubscribers(): Subscriber[] {
  return Array.from(subscribers.values());
}

export async function broadcastAnnouncement(text: string): Promise<{ sent: number; failed: number }> {
  if (isIsolatedMode()) throw new Error('LBA_TELEGRAM_DISABLED');
  const allSubs = Array.from(subscribers.values()).filter(s => s.enabled);
  let sent = 0;
  let failed = 0;
  const kb = {
    inline_keyboard: [
      [miniAppButton()],
      [{ text: '🔔 Налаштувати', callback_data: 'menu_notifications' }],
      [{ text: '↩️ Головне меню', callback_data: 'menu_main' }],
    ],
  };

  for (const sub of allSubs) {
    try {
      await sendAndClean(sub.chatId, () => sendMessage(sub.chatId, text, kb));
      sent++;
      await new Promise(r => setTimeout(r, 50));
    } catch (e: any) {
      console.error(`[TG Bot] Broadcast failed for ${sub.chatId}:`, e.message);
      failed++;
    }
  }
  console.log(`[TG Bot] Broadcast complete: ${sent} sent, ${failed} failed out of ${allSubs.length} subscribers`);
  return { sent, failed };
}

export function getRecentStarts() {
  const recent = recentStarts.filter(s => Date.now() - s.timestamp < 10 * 60 * 1000);
  if (recent.length > 0) return recent;
  const allSubs = Array.from(subscribers.values())
    .filter(s => s.createdAt && Date.now() - s.createdAt < 10 * 60 * 1000)
    .sort((a, b) => b.createdAt - a.createdAt);
  return allSubs.map(s => ({ chatId: s.chatId, firstName: s.firstName, username: s.username, timestamp: s.createdAt }));
}
