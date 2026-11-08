import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { getUserSettings, upsertUserSettings, getLinkedAccountsByUserId, getLinkedAccountByProvider, addLinkedAccount, removeLinkedAccount, migrateUserSettings } from "./storage";
import { fetchVoeData, parseScheduleForQueue, getAvailableQueues } from "./scraper";
import { fetchKyivPlannedData, parseKyivScheduleForQueue, getKyivAvailableQueues, searchKyivStreets, searchKyivHouses, resolveKyivAddressQueue } from "./scraper-kyiv";
import { fetchKharkivScheduleData, parseKharkivScheduleForQueue, getKharkivAvailableQueues, getAllKharkivQueues } from "./scraper-kharkiv";
import { fetchOdesaScheduleData, parseOdesaScheduleForQueue, getOdesaAvailableQueues, getAllOdesaQueues } from "./scraper-odesa";
import { isAuthenticated } from "./replit_integrations/auth";
import { readFileSync } from "fs";
import { join } from "path";
import { createHash, createHmac } from "crypto";
import { getCachedQueue, cacheQueueResult } from "./voe-lookup";
import { getRecentStarts, updateSubscriber, getSubscribers, consumeAutoLoginToken, generateAutoLoginToken, generateLinkToken, generateWebLoginToken, resolveWebLoginToken, triggerNotifCheckIfNeeded, broadcastAnnouncement } from "./telegram-bot";
import { authStorage } from "./replit_integrations/auth";
import { authLimiter, scheduleLimiter } from "./middleware";
import { generateMobileToken, isAuthenticatedMobileOrSession } from "./mobile-auth";
import { isIsolatedMode } from "./isolated-guard";
import { registerIsolatedFixtureRoutes } from "./isolated-routes";
import { createAuthReplayGuard } from "./production/auth-replay";
import { createTelegramAuthFlow } from "./production/telegram-auth-flow";
import { createTelegramIdentityResolver } from "./production/telegram-identity";
import { registerTelegramProofRoutes } from "./production/telegram-auth-http";
import { pool } from "./db";
import { PRODUCT_TELEGRAM_IDENTITY } from "./production/product-identity";
import { createTelegramInbox } from "./production/telegram-inbox";
import { registerTelegramInboxRoute } from "./production/telegram-inbox-http";
import { productionRuntimePolicy } from "./runtime-policy";
import { BUILD_SOURCE_SHA256 } from "./release/build-identity";

function buildBotUpdates(data: Record<string, any>): Record<string, any> {
  const botUpdates: Record<string, any> = {};
  if (data.city !== undefined) botUpdates.city = data.city;
  if (data.queueId !== undefined) botUpdates.queueId = data.queueId;
  if (data.street !== undefined) botUpdates.street = data.street;
  if (data.houseNumber !== undefined) botUpdates.houseNumber = data.houseNumber;
  if (data.lookupMode !== undefined) botUpdates.lookupMode = data.lookupMode;
  if (data.telegramNotifications !== undefined) botUpdates.enabled = data.telegramNotifications;
  if (data.telegramNotifyBeforeOff !== undefined) botUpdates.notifyBeforeOff = data.telegramNotifyBeforeOff;
  if (data.telegramNotifyBeforeOn !== undefined) botUpdates.notifyBeforeOn = data.telegramNotifyBeforeOn;
  if (data.quietHoursEnabled !== undefined) botUpdates.quietHoursEnabled = data.quietHoursEnabled;
  if (data.quietHoursStart !== undefined) botUpdates.quietHoursStart = data.quietHoursStart;
  if (data.quietHoursEnd !== undefined) botUpdates.quietHoursEnd = data.quietHoursEnd;
  if (data.morningBriefingEnabled !== undefined) botUpdates.morningBriefingEnabled = data.morningBriefingEnabled;
  if (data.morningBriefingHour !== undefined) botUpdates.morningBriefingHour = data.morningBriefingHour;
  if (data.minOutageDuration !== undefined) botUpdates.minOutageDuration = data.minOutageDuration;
  return botUpdates;
}

function syncSettingsToBotByChatId(chatId: string, data: Record<string, any>) {
  const subs = getSubscribers();
  const sub = subs.find(s => s.chatId === chatId);
  if (sub) {
    const botUpdates = buildBotUpdates(data);
    if (Object.keys(botUpdates).length > 0) {
      updateSubscriber(chatId, botUpdates, true);
    }
  }
}

function syncSettingsToBot(settings: any, data: Record<string, any>) {
  if (!settings.telegramChatId) return;
  try {
    syncSettingsToBotByChatId(settings.telegramChatId, data);
  } catch (e: any) {
    console.error('[API] Bot sync error:', e.message);
  }
}

async function syncSettingsAcrossLinkedAccounts(userId: string, data: Record<string, any>, settings: any) {
  try {
    const accounts = await getLinkedAccountsByUserId(userId);
    if (accounts.length <= 1) return;

    const addressFields = ['city', 'queueId', 'street', 'houseNumber', 'lookupMode'];
    const addressData: Record<string, any> = {};
    for (const f of addressFields) {
      if (data[f] !== undefined) addressData[f] = data[f];
    }
    if (Object.keys(addressData).length === 0) return;

    let telegramChatId = settings.telegramChatId;

    for (const acc of accounts) {
      const linkedUserId = acc.provider === 'telegram' ? `tg_${acc.providerId}` : acc.providerId;
      if (linkedUserId === userId) continue;

      await upsertUserSettings(linkedUserId, addressData);
      console.log(`[Sync] Propagated address from ${userId} to linked account ${linkedUserId}`);

      if (acc.provider === 'telegram' && !telegramChatId) {
        telegramChatId = acc.providerId;
      }
    }

    if (telegramChatId && !settings.telegramChatId) {
      try {
        syncSettingsToBotByChatId(telegramChatId, data);
        console.log(`[Sync] Synced to bot via linked Telegram account ${telegramChatId} for user ${userId}`);
      } catch (e: any) {
        console.error('[Sync] Bot sync via linked account error:', e.message);
      }
    }
  } catch (e: any) {
    console.error('[Sync] Cross-account sync error:', e.message);
  }
}

const sseClients = new Map<string, Set<Response>>();

export function broadcastSettingsToUser(userId: string, settings: Record<string, any>, sourceTabId?: string) {
  const clients = sseClients.get(userId);
  if (!clients || clients.size === 0) return;

  const payload = JSON.stringify({ ...settings, _sourceTabId: sourceTabId });
  const message = `data: ${payload}\n\n`;

  Array.from(clients).forEach(client => {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  });
}

async function broadcastToAllLinkedUsers(userId: string, settings: Record<string, any>, sourceTabId?: string) {
  broadcastSettingsToUser(userId, settings, sourceTabId);

  try {
    const accounts = await getLinkedAccountsByUserId(userId);
    if (accounts.length <= 1) return;
    for (const acc of accounts) {
      const linkedUserId = acc.provider === 'telegram' ? `tg_${acc.providerId}` : acc.providerId;
      if (linkedUserId === userId) continue;
      broadcastSettingsToUser(linkedUserId, settings, sourceTabId);
    }
  } catch {}
}

interface StreetQueueEntry {
  s: string;
  q: string[];
}

interface HouseEntry {
  house: string;
  queue: string;
}

interface OldNameCacheEntry {
  oldName: string | null;
  timestamp: number;
}

const oldNameCache = new Map<string, OldNameCacheEntry>();
const OLD_NAME_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

async function lookupOldStreetName(streetName: string): Promise<string | null> {
  const cacheKey = streetName.toLowerCase().trim();
  const cached = oldNameCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < OLD_NAME_CACHE_TTL) {
    return cached.oldName;
  }

  try {
    const query = `${streetName}, Вінниця, Україна`;
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&namedetails=1&limit=3&accept-language=uk`,
      {
        headers: { 'User-Agent': 'SvitloUkraine/1.0 (outage-tracker-app)' },
        signal: AbortSignal.timeout(8000),
      }
    );
    const data = await response.json() as any[];

    for (const item of data) {
      const oldName = item?.namedetails?.old_name;
      if (oldName) {
        const cleaned = oldName
          .replace(/^вулиця\s+/i, '')
          .replace(/^провулок\s+/i, '')
          .replace(/^проїзд\s+/i, '')
          .replace(/^бульвар\s+/i, '')
          .replace(/^проспект\s+/i, '')
          .replace(/^площа\s+/i, '')
          .replace(/^шосе\s+/i, '')
          .trim();
        if (cleaned.length > 1) {
          console.log(`[VOE] Old name for "${streetName}": "${cleaned}" (from Nominatim)`);
          oldNameCache.set(cacheKey, { oldName: cleaned, timestamp: Date.now() });
          return cleaned;
        }
      }
    }

    oldNameCache.set(cacheKey, { oldName: null, timestamp: Date.now() });
    return null;
  } catch (error: any) {
    console.error(`[VOE] Old name lookup failed for "${streetName}":`, error.message);
    return null;
  }
}

const VALID_QUEUES = new Set(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']);

let streetQueueData: StreetQueueEntry[] | null = null;
let houseQueueData: Record<string, HouseEntry[]> | null = null;
let streetFullNames: Record<string, string> | null = null;
let kharkivStreetQueueData: StreetQueueEntry[] | null = null;
let kharkivHouseQueueData: Record<string, HouseEntry[]> | null = null;
let kharkivEnterprises: { name: string; address: string; queue?: string }[] | null = null;

function loadStreetFullNames(): Record<string, string> {
  if (!streetFullNames) {
    try {
      const filePath = join(process.cwd(), 'server', 'data', 'street-full-names.json');
      const raw = readFileSync(filePath, 'utf-8');
      streetFullNames = JSON.parse(raw);
      console.log(`[VOE] Loaded ${Object.keys(streetFullNames!).length} full street name mappings`);
    } catch (error: any) {
      console.error('[VOE] Failed to load street full names:', error.message);
      streetFullNames = {};
    }
  }
  return streetFullNames!;
}

function getFullStreetName(bareName: string): string {
  const fullNames = loadStreetFullNames();
  return fullNames[bareName] || bareName;
}

function bareFromFull(fullName: string): string {
  return stripStreetType(fullName).trim();
}

function loadStreetQueueData(): StreetQueueEntry[] {
  if (!streetQueueData) {
    try {
      const filePath = join(process.cwd(), 'server', 'data', 'street-queues.json');
      const raw = readFileSync(filePath, 'utf-8');
      streetQueueData = JSON.parse(raw);
      console.log(`[VOE] Loaded ${streetQueueData!.length} street-to-queue mappings`);
    } catch (error: any) {
      console.error('[VOE] Failed to load street-queue mapping:', error.message);
      streetQueueData = [];
    }
  }
  return streetQueueData!;
}

function loadHouseQueueData(): Record<string, HouseEntry[]> {
  if (!houseQueueData) {
    try {
      const filePath = join(process.cwd(), 'server', 'data', 'house-queues.json');
      const raw = readFileSync(filePath, 'utf-8');
      houseQueueData = JSON.parse(raw);
      const totalEntries = Object.values(houseQueueData!).reduce((sum, arr) => sum + arr.length, 0);
      console.log(`[VOE] Loaded house-level queue data: ${Object.keys(houseQueueData!).length} streets, ${totalEntries} entries`);
    } catch (error: any) {
      console.error('[VOE] Failed to load house-queue data:', error.message);
      houseQueueData = {};
    }
  }
  return houseQueueData!;
}

function loadKharkivStreetQueueData(): StreetQueueEntry[] {
  if (!kharkivStreetQueueData) {
    try {
      const filePath = join(process.cwd(), 'server', 'data', 'kharkiv-street-queues.json');
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { s: string; q: string }[];
      kharkivStreetQueueData = parsed.map(e => ({ s: e.s, q: Array.isArray(e.q) ? e.q : [e.q] }));
      console.log(`[KHARKIV] Loaded ${kharkivStreetQueueData.length} street-to-queue mappings`);
    } catch (error: any) {
      console.error('[KHARKIV] Failed to load street-queue mapping:', error.message);
      kharkivStreetQueueData = [];
    }
  }
  return kharkivStreetQueueData;
}

function loadKharkivEnterprises(): { name: string; address: string; queue?: string }[] {
  if (!kharkivEnterprises) {
    try {
      const filePath = join(process.cwd(), 'server', 'data', 'kharkiv-enterprises.json');
      const raw = readFileSync(filePath, 'utf-8');
      kharkivEnterprises = JSON.parse(raw);
      console.log(`[KHARKIV] Loaded ${kharkivEnterprises!.length} enterprise entries`);
    } catch (error: any) {
      console.error('[KHARKIV] Failed to load enterprises:', error.message);
      kharkivEnterprises = [];
    }
  }
  return kharkivEnterprises!;
}

function loadKharkivHouseQueueData(): Record<string, HouseEntry[]> {
  if (!kharkivHouseQueueData) {
    try {
      const filePath = join(process.cwd(), 'server', 'data', 'kharkiv-house-queues.json');
      const raw = readFileSync(filePath, 'utf-8');
      kharkivHouseQueueData = JSON.parse(raw);
      const totalEntries = Object.values(kharkivHouseQueueData!).reduce((sum, arr) => sum + arr.length, 0);
      console.log(`[KHARKIV] Loaded house-level queue data: ${Object.keys(kharkivHouseQueueData!).length} streets, ${totalEntries} entries`);
    } catch (error: any) {
      console.error('[KHARKIV] Failed to load house-queue data:', error.message);
      kharkivHouseQueueData = {};
    }
  }
  return kharkivHouseQueueData!;
}

function stripStreetType(s: string): string {
  return s
    .replace(/(?:^|\s)(вулиця|вул\.?|провулок|пров\.?|бульвар|бульв\.?|бул\.?|проспект|просп\.?|пр\.?|площа|пл\.?|шосе|набережна|наб\.?|узвіз|тупик|алея|ж\/м)(?:\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ukrStem(word: string): string {
  let w = word.toLowerCase().trim();
  if (w.length < 4) return w;
  w = w
    .replace(/(ський|ської|ському|ським|ськім|ськом|ська|ське|ські|ських|ськими)$/i, 'ськ')
    .replace(/(зький|зької|зькому|зьким|зькім|зьком|зька|зьке|зькі|зьких|зькими)$/i, 'зьк')
    .replace(/(цький|цької|цькому|цьким|цькім|цьком|цька|цьке|цькі|цьких|цькими)$/i, 'цьк')
    .replace(/(ний|ного|ному|ним|нім|ном|на|не|ні|них|ними)$/i, 'н')
    .replace(/(ова|ове|ові|ового|овому|овим|овім|овом|ових|овими|овий)$/i, 'ов')
    .replace(/(ева|еве|еві|евого|евому|евим|евім|евом|евих|евими|евий)$/i, 'ев');
  return w;
}

function stemMatch(a: string, b: string): boolean {
  const sa = ukrStem(a);
  const sb = ukrStem(b);
  if (sa === sb) return true;
  if (sa.length >= 4 && sb.length >= 4) {
    if (sa.startsWith(sb) || sb.startsWith(sa)) {
      const ratio = Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length);
      return ratio > 0.75;
    }
  }
  return false;
}

function stemMatchWords(query: string, name: string): boolean {
  const qWords = query.split(/\s+/).filter(w => w.length >= 3);
  const nWords = name.split(/\s+/).filter(w => w.length >= 3);
  if (qWords.length === 0 || nWords.length === 0) return false;
  return qWords.every(qw => nWords.some(nw => stemMatch(qw, nw)));
}

const STREET_TYPE_PATTERNS: [RegExp, string][] = [
  [/(?:^|\s)(вулиця|вул\.?)(?:\s|$)/i, 'вулиця'],
  [/(?:^|\s)(провулок|пров\.?)(?:\s|$)/i, 'провулок'],
  [/(?:^|\s)(проспект|просп\.?)(?:\s|$)/i, 'проспект'],
  [/(?:^|\s)(бульвар|бульв\.?)(?:\s|$)/i, 'бульвар'],
  [/(?:^|\s)(площа|пл\.?)(?:\s|$)/i, 'площа'],
  [/(?:^|\s)(шосе)(?:\s|$)/i, 'шосе'],
  [/(?:^|\s)(набережна|наб\.?)(?:\s|$)/i, 'набережна'],
  [/(?:^|\s)(узвіз)(?:\s|$)/i, 'узвіз'],
  [/(?:^|\s)(тупик)(?:\s|$)/i, 'тупик'],
  [/(?:^|\s)(проїзд)(?:\s|$)/i, 'проїзд'],
  [/(?:^|\s)(алея)(?:\s|$)/i, 'алея'],
];

function extractStreetType(name: string): string | null {
  for (const [pattern, type] of STREET_TYPE_PATTERNS) {
    if (pattern.test(name)) return type;
  }
  return null;
}

function streetTypesCompatible(queryType: string | null, dataType: string | null): boolean {
  if (!queryType || !dataType) return true;
  return queryType === dataType;
}

function findQueueByHouse(streetName: string, houseNumber: string, city: string = 'Вінниця'): { queue: string | null; allQueues: string[] } {
  const houseData = city === 'Харків' ? loadKharkivHouseQueueData() : loadHouseQueueData();
  const normalize = (s: string) =>
    stripStreetType(s.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim());
  const normalizedStreet = normalize(streetName);
  const normalizedHouse = houseNumber.replace(/\s/g, '').toLowerCase();

  const fullNames = city === 'Харків' ? {} : loadStreetFullNames();
  const queryType = extractStreetType(streetName);

  for (const [street, entries] of Object.entries(houseData)) {
    const normStreet = normalize(street);
    const isExact = normStreet === normalizedStreet;
    if (!isExact) {
      if (!stemMatch(normStreet, normalizedStreet)) continue;
      const dataFullName = (fullNames as Record<string, string>)[street] || street;
      const dataType = extractStreetType(dataFullName);
      if (!streetTypesCompatible(queryType, dataType)) continue;
    }

    const exactMatches = entries.filter(e =>
      e.house.toLowerCase() === normalizedHouse && VALID_QUEUES.has(e.queue)
    );
    if (exactMatches.length === 1) {
      return { queue: exactMatches[0].queue, allQueues: [exactMatches[0].queue] };
    }
    if (exactMatches.length > 1) {
      const queues = [...new Set(exactMatches.map(e => e.queue))];
      if (queues.length === 1) return { queue: queues[0], allQueues: queues };
      return { queue: null, allQueues: queues };
    }

    const numOnly = normalizedHouse.replace(/[^0-9]/g, '');
    if (numOnly) {
      const numMatches = entries.filter(e =>
        e.house.replace(/[^0-9]/g, '') === numOnly && VALID_QUEUES.has(e.queue)
      );
      if (numMatches.length >= 1) {
        const queues = [...new Set(numMatches.map(e => e.queue))];
        if (queues.length === 1) return { queue: queues[0], allQueues: queues };
        return { queue: null, allQueues: queues };
      }
    }

    if (numOnly) {
      const targetNum = parseInt(numOnly);
      if (!isNaN(targetNum)) {
        const targetParity = targetNum % 2;
        const numericHouses: { num: number; queue: string }[] = [];
        for (const e of entries) {
          const n = parseInt(e.house.replace(/[^0-9]/g, ''));
          if (!isNaN(n) && VALID_QUEUES.has(e.queue)) {
            numericHouses.push({ num: n, queue: e.queue });
          }
        }
        numericHouses.sort((a, b) => a.num - b.num);

        const sameParityHouses = numericHouses.filter(h => h.num % 2 === targetParity);
        const searchList = sameParityHouses.length >= 3 ? sameParityHouses : numericHouses;

        let below: { num: number; queue: string } | null = null;
        let above: { num: number; queue: string } | null = null;
        for (const h of searchList) {
          if (h.num <= targetNum) below = h;
          if (h.num >= targetNum && !above) above = h;
        }

        if (below && above && below.queue === above.queue) {
          console.log(`[VOE] Nearest-neighbor: house ${targetNum} between ${below.num} and ${above.num} → ${below.queue}`);
          return { queue: below.queue, allQueues: [below.queue] };
        }

        if (below && above && below.queue !== above.queue) {
          const allStreetQueues = [...new Set(numericHouses.map(h => h.queue))].sort();
          console.log(`[VOE] Nearest-neighbor: house ${targetNum} between different queues (${below.num}→${below.queue}, ${above.num}→${above.queue}) → alternatives`);
          return { queue: null, allQueues: allStreetQueues };
        }

        if (below && !above && (targetNum - below.num) <= 6) {
          const allStreetQueues = [...new Set(numericHouses.map(h => h.queue))];
          if (allStreetQueues.length === 1) {
            return { queue: below.queue, allQueues: [below.queue] };
          }
          return { queue: null, allQueues: allStreetQueues.sort() };
        }
        if (!below && above && (above.num - targetNum) <= 6) {
          const allStreetQueues = [...new Set(numericHouses.map(h => h.queue))];
          if (allStreetQueues.length === 1) {
            return { queue: above.queue, allQueues: [above.queue] };
          }
          return { queue: null, allQueues: allStreetQueues.sort() };
        }
      }
    }
  }
  return { queue: null, allQueues: [] };
}

function findQueuesForStreet(streetName: string): { street: string; queues: string[] }[] {
  const data = loadStreetQueueData();
  const query = streetName.toLowerCase().trim();

  const cleanQuery = query
    .replace(/вулиця\s*/i, '')
    .replace(/провулок\s*/i, '')
    .replace(/бульвар\s*/i, '')
    .replace(/проспект\s*/i, '')
    .replace(/площа\s*/i, '')
    .replace(/шосе\s*/i, '')
    .trim();

  if (cleanQuery.length < 2) return [];

  const normalize = (s: string) =>
    s.toLowerCase()
      .replace(/[.'`'\u2019\u0027]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const normalizedQuery = normalize(cleanQuery);
  const results: { street: string; queues: string[]; score: number }[] = [];

  for (const entry of data) {
    const entryNorm = normalize(entry.s);

    if (entryNorm === normalizedQuery) {
      results.push({ street: entry.s, queues: entry.q, score: 100 });
      continue;
    }

    if (entryNorm.startsWith(normalizedQuery + ' ') || entryNorm.startsWith(normalizedQuery)) {
      const lenRatio = Math.min(normalizedQuery.length, entryNorm.length) / Math.max(normalizedQuery.length, entryNorm.length);
      results.push({ street: entry.s, queues: entry.q, score: lenRatio > 0.5 ? 85 : 60 });
      continue;
    }

    if (normalizedQuery.startsWith(entryNorm)) {
      const lenRatio = entryNorm.length / normalizedQuery.length;
      if (lenRatio > 0.5) {
        results.push({ street: entry.s, queues: entry.q, score: 85 });
      }
      continue;
    }

    const entryWords = entryNorm.split(/\s+/).filter(w => w.length > 1);
    const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);

    if (queryWords.length > 0 && entryWords.length > 0) {
      const fwdMatchCount = queryWords.filter(qw =>
        entryWords.some(ew => ew === qw || (qw.length >= 4 && ew.startsWith(qw)))
      ).length;

      if (fwdMatchCount === queryWords.length) {
        results.push({ street: entry.s, queues: entry.q, score: 75 });
        continue;
      }

      if (entryWords.length === 1 && entryWords[0].length >= 4) {
        const ew = entryWords[0];
        const lastQueryWord = queryWords[queryWords.length - 1];
        if (lastQueryWord && (lastQueryWord === ew || lastQueryWord.startsWith(ew) || ew.startsWith(lastQueryWord))) {
          results.push({ street: entry.s, queues: entry.q, score: 65 });
        }
      } else if (entryWords.length > 1) {
        const revMatchCount = entryWords.filter(ew =>
          ew.length >= 4 && queryWords.some(qw => ew === qw)
        ).length;
        if (revMatchCount === entryWords.length) {
          results.push({ street: entry.s, queues: entry.q, score: 70 });
        }
      }

      if (!results.some(r => r.street === entry.s) && stemMatchWords(normalizedQuery, entryNorm)) {
        const fullNamesData = loadStreetFullNames();
        const entryFullName = fullNamesData[entry.s] || entry.s;
        const entryType = extractStreetType(entryFullName);
        const qType = extractStreetType(query);
        if (streetTypesCompatible(qType, entryType)) {
          results.push({ street: entry.s, queues: entry.q, score: 55 });
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, 5);

  const merged: Map<string, Set<string>> = new Map();
  for (const r of topResults) {
    const existing = merged.get(r.street);
    if (existing) {
      r.queues.forEach(q => existing.add(q));
    } else {
      merged.set(r.street, new Set(r.queues));
    }
  }

  return Array.from(merged.entries()).map(([street, queues]) => ({
    street,
    queues: Array.from(queues).filter(q => VALID_QUEUES.has(q)).sort(),
  })).filter(r => r.queues.length > 0);
}

function searchLocalStreets(query: string): string[] {
  const data = loadStreetQueueData();
  const houseData = loadHouseQueueData();
  const fullNames = loadStreetFullNames();
  const q = query.toLowerCase().trim();
  const cleanQ = stripStreetType(q).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();

  if (cleanQ.length < 2) return [];

  const allStreetNamesSet = new Set<string>();
  for (const entry of data) {
    allStreetNamesSet.add(entry.s);
  }
  for (const street of Object.keys(houseData)) {
    allStreetNamesSet.add(street);
  }
  const allStreetNames = Array.from(allStreetNamesSet);

  const scored: { name: string; fullName: string; score: number }[] = [];
  for (const name of allStreetNames) {
    const nameLower = name.toLowerCase();
    const nameClean = nameLower.replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
    const full = fullNames[name] || name;
    const fullClean = full.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();

    let score = 0;
    if (nameClean === cleanQ || fullClean === cleanQ) {
      score = 100;
    } else if (nameClean.startsWith(cleanQ) || fullClean.startsWith(cleanQ)) {
      score = 90 - Math.min(nameClean.length - cleanQ.length, 20);
    } else if (cleanQ.length >= 3 && (nameClean.includes(cleanQ) || fullClean.includes(cleanQ))) {
      const idx = Math.min(
        nameClean.includes(cleanQ) ? nameClean.indexOf(cleanQ) : 999,
        fullClean.includes(cleanQ) ? fullClean.indexOf(cleanQ) : 999
      );
      score = 60 - Math.min(idx, 10);
    } else {
      const queryWords = cleanQ.split(/\s+/);
      const nameWords = [...nameClean.split(/\s+/), ...fullClean.split(/\s+/)];
      const uniqueWords = [...new Set(nameWords)];
      const matchCount = queryWords.filter((qw: string) =>
        uniqueWords.some((nw: string) => nw.startsWith(qw) || (qw.length >= 3 && nw.includes(qw)))
      ).length;
      if (matchCount > 0 && matchCount === queryWords.length) {
        score = 50 + matchCount * 5;
      } else if (matchCount > 0) {
        score = 30 + matchCount * 5;
      }

      if (score === 0 && stemMatchWords(cleanQ, nameClean + ' ' + fullClean)) {
        const qType = extractStreetType(q);
        const nType = extractStreetType(full);
        if (streetTypesCompatible(qType, nType)) {
          score = 40;
        }
      }
    }

    if (score > 0) {
      scored.push({ name, fullName: full, score });
    }
  }

  const houseDataNorms = new Set(
    Object.keys(houseData).map(s =>
      stripStreetType(s.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim())
    )
  );
  for (const item of scored) {
    const norm = stripStreetType(item.name.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim());
    if (houseDataNorms.has(norm)) {
      item.score += 5;
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const results: string[] = [];
  for (const s of scored) {
    const key = s.fullName.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(s.fullName);
      if (results.length >= 15) break;
    }
  }
  return results;
}

function searchLocalHouses(streetName: string, query: string): string[] {
  const houseData = loadHouseQueueData();
  const normalize = (s: string) =>
    stripStreetType(s.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim());
  const normalizedStreet = normalize(bareFromFull(streetName));
  const q = query.trim().toLowerCase();

  const queryType = extractStreetType(streetName);
  const fullNamesData = loadStreetFullNames();

  const allHouses: string[] = [];
  for (const [street, entries] of Object.entries(houseData)) {
    const normalizedKey = normalize(street);
    const isExactish = normalizedKey === normalizedStreet
      || normalizedStreet.endsWith(normalizedKey)
      || normalizedKey.endsWith(normalizedStreet)
      || normalizedStreet.includes(normalizedKey)
      || normalizedKey.includes(normalizedStreet);

    if (!isExactish) {
      if (!stemMatch(normalizedKey, normalizedStreet)) continue;
      const dataFullName = fullNamesData[street] || street;
      const dataType = extractStreetType(dataFullName);
      if (!streetTypesCompatible(queryType, dataType)) continue;
    }

    for (const e of entries) {
      allHouses.push(e.house);
    }
  }

  if (allHouses.length > 0) {
    const unique = Array.from(new Set(allHouses));
    unique.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    if (!q) return unique;
    return unique.filter(h => h.toLowerCase().startsWith(q));
  }

  const streetData = loadStreetQueueData();
  for (const entry of streetData) {
    const entryNorm = normalize(entry.s);
    const isExact = entryNorm === normalizedStreet;
    if (isExact) return [];
    if (stemMatch(entryNorm, normalizedStreet)) {
      const dataFullName = fullNamesData[entry.s] || entry.s;
      const dataType = extractStreetType(dataFullName);
      if (streetTypesCompatible(queryType, dataType)) return [];
    }
  }
  return [];
}

let kharkivAllStreets: string[] | null = null;
let kharkivAllStreetsFetching = false;
let odesaAllStreets: string[] | null = null;
let odesaAllStreetsFetching = false;

async function fetchAllKharkivStreets(): Promise<string[]> {
  if (kharkivAllStreets) return kharkivAllStreets;
  if (kharkivAllStreetsFetching) return [];
  kharkivAllStreetsFetching = true;

  try {
    const overpassQuery = `[out:json][timeout:30];
area["name"="Харків"]["boundary"="administrative"]["admin_level"~"^(6|7|8)$"]->.searchArea;
(way["highway"]["name"](area.searchArea););
out tags;`;

    console.log('[KHARKIV] Fetching all streets from Overpass API...');
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(overpassQuery)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SvitloUkraine/1.0' },
      signal: AbortSignal.timeout(35000),
    });

    if (!response.ok) {
      throw new Error(`Overpass API returned ${response.status}`);
    }

    const data = await response.json() as { elements?: { tags?: { name?: string } }[] };
    const streetNames = new Set<string>();
    for (const el of data.elements || []) {
      if (el.tags?.name) {
        streetNames.add(el.tags.name);
      }
    }

    kharkivAllStreets = Array.from(streetNames).sort((a, b) => a.localeCompare(b, 'uk'));
    console.log(`[KHARKIV] Loaded ${kharkivAllStreets.length} streets from Overpass API`);
    return kharkivAllStreets;
  } catch (error: any) {
    console.error('[KHARKIV] Failed to fetch streets from Overpass:', error.message);
    try {
      const backupResponse = await fetch('https://lz4.overpass-api.de/api/interpreter', {
        method: 'POST',
        body: `data=${encodeURIComponent(`[out:json][timeout:30];area["name"="Харків"]["boundary"="administrative"]["admin_level"~"^(6|7|8)$"]->.a;(way["highway"]["name"](area.a););out tags;`)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SvitloUkraine/1.0' },
        signal: AbortSignal.timeout(35000),
      });
      if (backupResponse.ok) {
        const data = await backupResponse.json() as { elements?: { tags?: { name?: string } }[] };
        const streetNames = new Set<string>();
        for (const el of data.elements || []) {
          if (el.tags?.name) streetNames.add(el.tags.name);
        }
        kharkivAllStreets = Array.from(streetNames).sort((a, b) => a.localeCompare(b, 'uk'));
        console.log(`[KHARKIV] Loaded ${kharkivAllStreets.length} streets from backup Overpass API`);
        return kharkivAllStreets;
      }
    } catch (backupError: any) {
      console.error('[KHARKIV] Backup Overpass also failed:', backupError.message);
    }
    return [];
  } finally {
    kharkivAllStreetsFetching = false;
  }
}

async function fetchAllOdesaStreets(): Promise<string[]> {
  if (odesaAllStreets) return odesaAllStreets;
  if (odesaAllStreetsFetching) return [];
  odesaAllStreetsFetching = true;

  const overpassQuery = `[out:json][timeout:90];
(way["highway"~"^(residential|living_street|pedestrian|primary|secondary|tertiary|unclassified)$"]["name"](46.36,30.61,46.55,30.82););
out tags;`;

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
  ];

  for (const endpoint of endpoints) {
    try {
      console.log(`[ODESA] Fetching streets from ${endpoint}...`);
      const response = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(overpassQuery)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SvitloUkraine/1.0' },
        signal: AbortSignal.timeout(95000),
      });

      if (!response.ok) {
        console.warn(`[ODESA] ${endpoint} returned ${response.status}, trying next...`);
        continue;
      }

      const data = await response.json() as { elements?: { tags?: { name?: string } }[] };
      const streetNames = new Set<string>();
      for (const el of data.elements || []) {
        if (el.tags?.name) {
          streetNames.add(el.tags.name);
        }
      }

      if (streetNames.size > 0) {
        odesaAllStreets = Array.from(streetNames).sort((a, b) => a.localeCompare(b, 'uk'));
        odesaAllStreetsFetching = false;
        console.log(`[ODESA] Loaded ${odesaAllStreets.length} streets from Overpass API`);
        return odesaAllStreets;
      }
      console.warn(`[ODESA] ${endpoint} returned 0 streets, trying next...`);
    } catch (error: any) {
      console.warn(`[ODESA] ${endpoint} failed: ${error.message}, trying next...`);
    }
  }

  console.error('[ODESA] All Overpass endpoints failed, no streets loaded');
  odesaAllStreetsFetching = false;
  return [];
}

function searchOdesaStreets(query: string): string[] {
  const q = query.toLowerCase().trim();
  const cleanQ = stripStreetType(q).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
  if (cleanQ.length < 2) return [];
  if (!odesaAllStreets) return [];

  const scored: { name: string; score: number }[] = [];
  for (const name of odesaAllStreets) {
    const nameClean = name.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
    const cleanName = stripStreetType(nameClean);
    const score = scoreMatch(cleanName, cleanQ) || scoreMatch(nameClean, cleanQ);
    if (score > 0) {
      scored.push({ name, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 20).map(s => s.name);
}

// ============ DTEK OEM Address-to-Queue API ============
interface DtekOemSession {
  cookies: string;
  csrfToken: string;
  timestamp: number;
  streets: Record<string, string[]>;
}
let dtekOemSession: DtekOemSession | null = null;
const DTEK_OEM_SESSION_TTL = 25 * 60 * 1000; // 25 minutes (session expires in 30min)

async function getDtekOemSession(): Promise<DtekOemSession | null> {
  if (dtekOemSession && Date.now() - dtekOemSession.timestamp < DTEK_OEM_SESSION_TTL) {
    return dtekOemSession;
  }

  try {
    console.log('[DTEK-OEM] Fetching new session...');
    const response = await fetch('https://www.dtek-oem.com.ua/ua/shutdowns', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'uk-UA,uk;q=0.9',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      console.error(`[DTEK-OEM] Page returned ${response.status}`);
      return null;
    }

    const cookieHeaders = response.headers.getSetCookie?.() || [];
    const cookies = cookieHeaders.map(c => c.split(';')[0]).join('; ');
    const html = await response.text();

    const csrfMatch = html.match(/name="_csrf-dtek-oem"\s+value="([^"]+)"/);
    const csrfToken = csrfMatch?.[1] || '';
    if (!csrfToken) {
      console.error('[DTEK-OEM] No CSRF token found');
      return null;
    }

    let streets: Record<string, string[]> = {};
    const streetsStart = html.indexOf('DisconSchedule.streets = ');
    if (streetsStart >= 0) {
      const jsonStart = streetsStart + 'DisconSchedule.streets = '.length;
      let depth = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
      try {
        streets = JSON.parse(html.slice(jsonStart, jsonEnd));
        console.log(`[DTEK-OEM] Loaded streets for ${Object.keys(streets).length} cities`);
      } catch {}
    }

    dtekOemSession = { cookies, csrfToken, timestamp: Date.now(), streets };
    return dtekOemSession;
  } catch (error: any) {
    console.error('[DTEK-OEM] Session fetch error:', error.message);
    return null;
  }
}

async function resolveOdesaAddressQueue(city: string, street: string, house: string): Promise<{ queueId: string | null; houses: Record<string, string> }> {
  const session = await getDtekOemSession();
  if (!session) return { queueId: null, houses: {} };

  try {
    const body = `method=getHomeNum` +
      `&data%5B0%5D%5Bname%5D=city` +
      `&data%5B0%5D%5Bvalue%5D=${encodeURIComponent(city)}` +
      `&data%5B1%5D%5Bname%5D=street` +
      `&data%5B1%5D%5Bvalue%5D=${encodeURIComponent(street)}` +
      `&data%5B2%5D%5Bname%5D=house_num` +
      `&data%5B2%5D%5Bvalue%5D=${encodeURIComponent(house)}`;

    const response = await fetch('https://www.dtek-oem.com.ua/ua/ajax', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': session.csrfToken,
        'Referer': 'https://www.dtek-oem.com.ua/ua/shutdowns',
        'Origin': 'https://www.dtek-oem.com.ua',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Cookie': session.cookies,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      if (response.status === 400) {
        dtekOemSession = null;
      }
      console.warn(`[DTEK-OEM] API returned ${response.status}`);
      return { queueId: null, houses: {} };
    }

    const data = await response.json() as any;
    if (!data.result || !data.data) {
      return { queueId: null, houses: {} };
    }

    const houseQueues: Record<string, string> = {};
    let matchedQueue: string | null = null;
    const normalizedHouse = house.trim().toLowerCase();

    for (const [houseNum, info] of Object.entries(data.data)) {
      const reasons = (info as any).sub_type_reason as string[];
      if (reasons && reasons.length > 0) {
        const queueRaw = reasons[0].replace(/^GPV/, '');
        houseQueues[houseNum] = queueRaw;
        if (normalizedHouse && houseNum.trim().toLowerCase() === normalizedHouse) {
          matchedQueue = queueRaw;
        }
      }
    }

    if (!matchedQueue && normalizedHouse) {
      for (const [houseNum, queue] of Object.entries(houseQueues)) {
        if (houseNum.trim().toLowerCase().replace(/\s+/g, '') === normalizedHouse.replace(/\s+/g, '')) {
          matchedQueue = queue;
          break;
        }
      }
    }

    if (!matchedQueue && !normalizedHouse) {
      const allQueues = [...new Set(Object.values(houseQueues))];
      if (allQueues.length === 1) {
        matchedQueue = allQueues[0];
      }
    }

    return { queueId: matchedQueue, houses: houseQueues };
  } catch (error: any) {
    console.error('[DTEK-OEM] API call error:', error.message);
    return { queueId: null, houses: {} };
  }
}

function findDtekStreetName(userStreet: string, dtekCity: string = 'м. Одеса'): string | null {
  if (!dtekOemSession?.streets) return null;
  const cityStreets = dtekOemSession.streets[dtekCity];
  if (!cityStreets) return null;

  const userClean = stripStreetType(userStreet).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
  if (!userClean) return null;

  for (const dtekName of cityStreets) {
    const dtekClean = stripStreetType(dtekName).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
    if (dtekClean === userClean) return dtekName;
  }

  const userLower = userStreet.toLowerCase().trim();
  for (const dtekName of cityStreets) {
    if (dtekName.toLowerCase().trim() === userLower) return dtekName;
  }

  return null;
}

function searchDtekOemStreets(query: string, dtekCity: string = 'м. Одеса'): string[] {
  if (!dtekOemSession?.streets) return [];
  const cityStreets = dtekOemSession.streets[dtekCity];
  if (!cityStreets) return [];

  const q = query.toLowerCase().trim();
  const cleanQ = stripStreetType(q).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
  if (cleanQ.length < 2) return [];

  const scored: { name: string; score: number }[] = [];
  for (const name of cityStreets) {
    const nameClean = name.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
    const cleanName = stripStreetType(nameClean);
    const score = scoreMatch(cleanName, cleanQ) || scoreMatch(nameClean, cleanQ);
    if (score > 0) {
      scored.push({ name, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 20).map(s => s.name);
}

const overpassHouseCache = new Map<string, { houses: string[]; timestamp: number }>();
const OVERPASS_HOUSE_CACHE_TTL = 12 * 60 * 60 * 1000;

async function fetchOverpassHouses(cityName: string, streetName: string): Promise<string[]> {
  const cacheKey = `${cityName.toLowerCase()}|${streetName.toLowerCase().trim()}`;
  const cached = overpassHouseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < OVERPASS_HOUSE_CACHE_TTL) {
    return cached.houses;
  }

  const cleanStreet = stripStreetType(streetName).trim();
  if (!cleanStreet || cleanStreet.length < 2) return [];

  const overpassQuery = `[out:json][timeout:10];area["name"="${cityName}"]["boundary"="administrative"]->.a;nwr["addr:street"~"${cleanStreet}",i]["addr:housenumber"](area.a);out tags;`;

  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter'];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(overpassQuery)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SvitloUkraine/1.0' },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) continue;

      const data = await response.json() as { elements?: { tags?: { 'addr:housenumber'?: string; 'addr:street'?: string } }[] };
      const houses = new Set<string>();
      for (const el of data.elements || []) {
        const h = el.tags?.['addr:housenumber'];
        const s = el.tags?.['addr:street'] || '';
        if (h && stripStreetType(s).toLowerCase().trim() === cleanStreet.toLowerCase()) {
          houses.add(h);
        }
      }

      const sorted = Array.from(houses).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      );

      overpassHouseCache.set(cacheKey, { houses: sorted, timestamp: Date.now() });
      console.log(`[OVERPASS] Houses for "${streetName}" in ${cityName}: ${sorted.length} found`);
      return sorted;
    } catch (error: any) {
      console.error(`[OVERPASS] Houses fetch error (${endpoint}):`, error.message);
    }
  }

  overpassHouseCache.set(cacheKey, { houses: [], timestamp: Date.now() });
  return [];
}

function scoreMatch(nameClean: string, cleanQ: string): number {
  if (nameClean === cleanQ) return 100;
  if (nameClean.startsWith(cleanQ)) return 90 - Math.min(nameClean.length - cleanQ.length, 20);
  if (cleanQ.length >= 3 && nameClean.includes(cleanQ)) return 60;
  const queryWords = cleanQ.split(/\s+/);
  const nameWords = nameClean.split(/\s+/);
  const matchCount = queryWords.filter((qw: string) =>
    nameWords.some((nw: string) => nw.startsWith(qw) || (qw.length >= 3 && nw.includes(qw)))
  ).length;
  if (matchCount > 0 && matchCount === queryWords.length) return 50 + matchCount * 5;
  return 0;
}

function searchKharkivStreets(query: string): string[] {
  const data = loadKharkivStreetQueueData();
  const houseData = loadKharkivHouseQueueData();
  const enterprises = loadKharkivEnterprises();
  const q = query.toLowerCase().trim();
  const cleanQ = stripStreetType(q).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();

  if (cleanQ.length < 2) return [];

  const allStreetNamesSet = new Set<string>();
  for (const entry of data) {
    allStreetNamesSet.add(entry.s);
  }
  for (const street of Object.keys(houseData)) {
    allStreetNamesSet.add(street);
  }

  if (kharkivAllStreets) {
    for (const street of kharkivAllStreets) {
      allStreetNamesSet.add(street);
    }
  }

  const scored: { name: string; score: number; hasQueue: boolean }[] = [];
  const queueStreets = new Set<string>();
  for (const entry of data) queueStreets.add(entry.s.toLowerCase());
  for (const street of Object.keys(houseData)) queueStreets.add(street.toLowerCase());

  for (const name of allStreetNamesSet) {
    const nameClean = name.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
    const cleanName = stripStreetType(nameClean);
    const score = scoreMatch(cleanName, cleanQ) || scoreMatch(nameClean, cleanQ);
    if (score > 0) {
      scored.push({ name, score, hasQueue: queueStreets.has(name.toLowerCase()) });
    }
  }

  for (const ent of enterprises) {
    const entName = ent.name.toLowerCase();
    const entClean = entName.replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
    const score = scoreMatch(entClean, cleanQ);
    if (score > 0) {
      scored.push({ name: ent.name, score: score + 5, hasQueue: !!ent.queue });
    }
  }

  scored.sort((a, b) => {
    if (a.hasQueue !== b.hasQueue) return a.hasQueue ? -1 : 1;
    return b.score - a.score;
  });
  return scored.slice(0, 20).map(s => s.name);
}

function searchKharkivHouses(streetName: string, query: string): string[] {
  const houseData = loadKharkivHouseQueueData();
  const normalize = (s: string) =>
    stripStreetType(s.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim());
  const normalizedStreet = normalize(streetName);
  const q = query.trim().toLowerCase();

  for (const [street, entries] of Object.entries(houseData)) {
    if (normalize(street) !== normalizedStreet) continue;

    const houses = Array.from(new Set(entries.map(e => e.house)));
    houses.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    if (!q) return houses;
    return houses.filter(h => h.toLowerCase().startsWith(q));
  }
  return [];
}

function findKharkivQueuesForStreet(streetName: string): { street: string; queues: string[] }[] {
  const data = loadKharkivStreetQueueData();
  const query = streetName.toLowerCase().trim();
  const cleanQuery = stripStreetType(query).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();

  if (cleanQuery.length < 2) return [];

  const results: { street: string; queues: string[]; score: number }[] = [];

  for (const entry of data) {
    const entryNorm = entry.s.toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();

    if (entryNorm === cleanQuery) {
      results.push({ street: entry.s, queues: entry.q, score: 100 });
    } else if (entryNorm.startsWith(cleanQuery) || cleanQuery.startsWith(entryNorm)) {
      results.push({ street: entry.s, queues: entry.q, score: 80 });
    } else if (cleanQuery.length >= 3 && entryNorm.includes(cleanQuery)) {
      results.push({ street: entry.s, queues: entry.q, score: 60 });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5).map(r => ({ street: r.street, queues: r.queues }));
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  if (isIsolatedMode()) {
    registerIsolatedFixtureRoutes(app);
  } else {
    loadStreetQueueData();
    loadHouseQueueData();
    loadStreetFullNames();
    loadKharkivStreetQueueData();
    loadKharkivHouseQueueData();
  }

  async function getVinnytsiaSchedule(queueId: string) {
    const data = await fetchVoeData();
    return parseScheduleForQueue(data, queueId);
  }

  // Public sources are fetched by the admitted source adapter on demand.
  // No DTEK session/challenge, geocoder, or remote source prefetch runs at startup.

  const BUILD_TIME = new Date().toISOString();

  app.get('/api/version', (_req, res) => {
    triggerNotifCheckIfNeeded();
    res.json({ version: BUILD_SOURCE_SHA256||BUILD_TIME, build: BUILD_SOURCE_SHA256||'v7-local',
      ...(BUILD_SOURCE_SHA256?{sourceSha256:BUILD_SOURCE_SHA256,channel:'v8-preparation'}:{}) });
  });

  app.get('/api/queues', async (req, res) => {
    const city = (req.query.city as string) || 'Вінниця';
    try {
      if (city === 'Київ') {
        const data = await fetchKyivPlannedData();
        const queues = getKyivAvailableQueues(data);
        const firstKey = Object.keys(data)[0];
        const updatedOn = data[firstKey]?.updatedOn || '';
        res.json({ queues, lastUpdated: Date.now(), updateTime: updatedOn });
      } else if (city === 'Харків') {
        try {
          const data = await fetchKharkivScheduleData();
          const queues = getKharkivAvailableQueues(data);
          res.json({ queues, lastUpdated: data.fetchedAt, updateTime: new Date(data.fetchedAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) });
        } catch {
          const queues = getAllKharkivQueues();
          res.json({ queues, lastUpdated: Date.now(), updateTime: '' });
        }
      } else if (city === 'Одеса') {
        try {
          const data = await fetchOdesaScheduleData();
          const queues = getOdesaAvailableQueues(data);
          res.json({ queues, lastUpdated: data.fetchedAt, updateTime: new Date(data.fetchedAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) });
        } catch {
          const queues = getAllOdesaQueues();
          res.json({ queues, lastUpdated: Date.now(), updateTime: '' });
        }
      } else {
        const data = await fetchVoeData();
        const queues = getAvailableQueues(data);
        res.json({ queues, lastUpdated: data.lastUpdated * 1000, updateTime: data.preset?.updateFact || '' });
      }
    } catch (error: any) {
      console.error('[API] Queue list error:', error.message);
      res.status(500).json({ error: 'Failed to fetch queue list', details: error.message });
    }
  });

  app.get('/api/schedule/:queueId', async (req, res) => {
    const { queueId } = req.params;
    const city = (req.query.city as string) || 'Вінниця';

    if (!queueId) {
      return res.status(400).json({ error: 'Missing queue ID' });
    }

    try {
      let schedule;
      if (city === 'Київ') {
        const data = await fetchKyivPlannedData();
        schedule = parseKyivScheduleForQueue(data, queueId);
      } else if (city === 'Харків') {
        const data = await fetchKharkivScheduleData();
        schedule = parseKharkivScheduleForQueue(data, queueId);
      } else if (city === 'Одеса') {
        const data = await fetchOdesaScheduleData();
        schedule = parseOdesaScheduleForQueue(data, queueId);
      } else {
        schedule = await getVinnytsiaSchedule(queueId);
      }

      try {
        const { fetchAlertForCity } = await import('./emergency-alerts');
        const alert = await fetchAlertForCity(city);
        if (alert) schedule.alert = alert;
      } catch {}

      res.json(schedule);
    } catch (error: any) {
      console.error('[API] Schedule fetch error:', error.message);
      res.status(500).json({ error: 'Failed to fetch schedule', details: error.message });
    }
  });

  app.get('/api/schedule', async (req, res) => {
    const { queue, city: cityParam } = req.query;
    const city = (cityParam as string) || 'Вінниця';

    if (!queue) {
      return res.status(400).json({ error: 'Missing queue parameter' });
    }

    try {
      let schedule;
      if (city === 'Київ') {
        const data = await fetchKyivPlannedData();
        schedule = parseKyivScheduleForQueue(data, queue as string);
      } else if (city === 'Харків') {
        const data = await fetchKharkivScheduleData();
        schedule = parseKharkivScheduleForQueue(data, queue as string);
      } else if (city === 'Одеса') {
        const data = await fetchOdesaScheduleData();
        schedule = parseOdesaScheduleForQueue(data, queue as string);
      } else {
        schedule = await getVinnytsiaSchedule(queue as string);
      }

      try {
        const { fetchAlertForCity } = await import('./emergency-alerts');
        const alert = await fetchAlertForCity(city);
        if (alert) schedule.alert = alert;
      } catch {}

      res.json(schedule);
    } catch (error: any) {
      console.error('[API] Schedule fetch error:', error.message);
      res.status(500).json({ error: 'Failed to fetch schedule', details: error.message });
    }
  });

  app.get('/api/street-queue', (req, res) => {
    const { street } = req.query;
    if (!street || typeof street !== 'string') {
      return res.json({ matches: [] });
    }

    const matches = findQueuesForStreet(street);
    const allQueues = new Set<string>();
    matches.forEach(m => m.queues.forEach(q => allQueues.add(q)));

    res.json({
      matches,
      queues: Array.from(allQueues).sort(),
      exact: matches.length === 1 && matches[0].queues.length === 1,
      singleQueue: allQueues.size === 1 ? Array.from(allQueues)[0] : null,
    });
  });

  app.get('/api/address-queue', async (req, res) => {
    const { city, street, house } = req.query;
    if (!street || typeof street !== 'string') {
      return res.json({ queueId: null, source: 'none', alternatives: [] });
    }

    const cityName = (city as string) || 'Вінниця';
    const houseName = (house as string) || '';

    if (cityName === 'Київ') {
      const cached = getCachedQueue(cityName, street, houseName);
      if (cached && cached.queueId) {
        console.log(`[API] Address-queue (Kyiv): cache hit "${street} ${houseName}" → ${cached.queueId}`);
        return res.json({ queueId: cached.queueId, source: 'cached', alternatives: [], isEnterprise: cached.isEnterprise || false });
      }

      try {
        const result = await resolveKyivAddressQueue(street, houseName);
        if (result.queueId) {
          cacheQueueResult(cityName, street, houseName, result.queueId);
          console.log(`[API] Address-queue (Kyiv): resolved "${street} ${houseName}" → ${result.queueId}`);
          return res.json({ queueId: result.queueId, source: 'yasno', alternatives: [] });
        }
        console.log(`[API] Address-queue (Kyiv): no match for "${street} ${houseName}"`);
        return res.json({ queueId: null, source: 'none', alternatives: [] });
      } catch (error: any) {
        console.error(`[API] Address-queue (Kyiv) error:`, error.message);
        return res.json({ queueId: null, source: 'none', alternatives: [] });
      }
    }

    if (cityName === 'Харків') {
      const enterprises = loadKharkivEnterprises();
      const entMatch = enterprises.find(e =>
        e.name.toLowerCase() === street.toLowerCase() ||
        stripStreetType(e.name).toLowerCase().trim() === stripStreetType(street).toLowerCase().trim()
      );

      if (entMatch) {
        if (entMatch.queue) {
          cacheQueueResult(cityName, street, houseName, entMatch.queue, true);
          console.log(`[API] Address-queue (Kharkiv): enterprise direct queue "${entMatch.name}" → ${entMatch.queue}`);
          return res.json({ queueId: entMatch.queue, source: 'enterprise', alternatives: [], isEnterprise: true });
        }
        if (entMatch.address) {
          const entStreet = stripStreetType(entMatch.address.split(',')[0]).trim();
          const entHouse = entMatch.address.includes(',') ? entMatch.address.split(',').slice(1).join(',').trim() : '';
          if (entStreet) {
            const entHouseResult = entHouse ? findQueueByHouse(entStreet, entHouse, 'Харків') : { queue: null, allQueues: [] };
            if (entHouseResult.queue) {
              cacheQueueResult(cityName, street, houseName, entHouseResult.queue, true);
              console.log(`[API] Address-queue (Kharkiv): enterprise address match "${entMatch.name}" → ${entHouseResult.queue}`);
              return res.json({ queueId: entHouseResult.queue, source: 'enterprise', alternatives: [], isEnterprise: true });
            }
            const entStreetMatches = findKharkivQueuesForStreet(entStreet);
            const entQueues = new Set<string>();
            entStreetMatches.forEach(m => m.queues.forEach(q => entQueues.add(q)));
            if (entQueues.size === 1) {
              const queueId = Array.from(entQueues)[0];
              cacheQueueResult(cityName, street, houseName, queueId, true);
              return res.json({ queueId, source: 'enterprise', alternatives: [], isEnterprise: true });
            }
            if (entQueues.size > 1) {
              return res.json({ queueId: null, source: 'enterprise', alternatives: Array.from(entQueues).sort(), isEnterprise: true });
            }
          }
        }
        return res.json({ queueId: null, source: 'enterprise', alternatives: [], isEnterprise: true, noOutagesExpected: true });
      }

      const cached = getCachedQueue(cityName, street, houseName);
      if (cached && cached.queueId) {
        console.log(`[API] Address-queue (Kharkiv): cache hit "${street} ${houseName}" → ${cached.queueId}`);
        return res.json({ queueId: cached.queueId, source: 'cached', alternatives: [], isEnterprise: cached.isEnterprise || false });
      }

      const cleanStreetKh = stripStreetType(street).trim();

      if (houseName) {
        const houseResult = findQueueByHouse(cleanStreetKh, houseName, 'Харків');
        if (houseResult.queue) {
          cacheQueueResult(cityName, street, houseName, houseResult.queue);
          console.log(`[API] Address-queue (Kharkiv): house match "${cleanStreetKh} ${houseName}" → ${houseResult.queue}`);
          return res.json({ queueId: houseResult.queue, source: 'local', alternatives: [] });
        }
        if (houseResult.allQueues.length > 1) {
          return res.json({ queueId: null, source: 'local', alternatives: houseResult.allQueues });
        }
      }

      const kharkivMatches = findKharkivQueuesForStreet(cleanStreetKh);
      const khStreetQueues = new Set<string>();
      kharkivMatches.forEach(m => m.queues.forEach(q => khStreetQueues.add(q)));

      if (houseName && khStreetQueues.size > 0) {
        for (const m of kharkivMatches) {
          const hm = findQueueByHouse(m.street, houseName, 'Харків');
          if (hm.queue) {
            cacheQueueResult(cityName, street, houseName, hm.queue);
            console.log(`[API] Address-queue (Kharkiv): house via "${m.street} ${houseName}" → ${hm.queue}`);
            return res.json({ queueId: hm.queue, source: 'local', alternatives: [] });
          }
        }
      }

      if (khStreetQueues.size === 1) {
        const queueId = Array.from(khStreetQueues)[0];
        cacheQueueResult(cityName, street, houseName, queueId);
        console.log(`[API] Address-queue (Kharkiv): single street match "${cleanStreetKh}" → ${queueId}`);
        return res.json({ queueId, source: 'local', alternatives: [] });
      }

      if (khStreetQueues.size > 1) {
        return res.json({ queueId: null, source: 'local', alternatives: Array.from(khStreetQueues).sort() });
      }

      console.log(`[API] Address-queue (Kharkiv): no match for "${street} ${houseName}" — no outages expected`);
      return res.json({ queueId: null, source: 'none', alternatives: [], noOutagesExpected: true });
    }

    if (cityName === 'Одеса') {
      const dtekCity = 'м. Одеса';
      const dtekStreetName = findDtekStreetName(street.trim(), dtekCity) || street.trim();
      try {
        const result = await resolveOdesaAddressQueue(dtekCity, dtekStreetName, houseName);
        if (result.queueId) {
          console.log(`[API] Address-queue (Odesa/DTEK): "${dtekStreetName} ${houseName}" → ${result.queueId}`);
          cacheQueueResult(cityName, street, houseName, result.queueId);
          return res.json({ queueId: result.queueId, source: 'dtek-oem', alternatives: [] });
        }
        if (Object.keys(result.houses).length > 0) {
          const allQueues = [...new Set(Object.values(result.houses))].sort();
          if (allQueues.length === 1) {
            console.log(`[API] Address-queue (Odesa/DTEK): street-level match "${dtekStreetName}" → ${allQueues[0]}`);
            cacheQueueResult(cityName, street, houseName, allQueues[0]);
            return res.json({ queueId: allQueues[0], source: 'dtek-oem', alternatives: [] });
          }
          if (allQueues.length > 1) {
            console.log(`[API] Address-queue (Odesa/DTEK): multi-queue "${dtekStreetName}" → [${allQueues.join(', ')}]`);
            return res.json({ queueId: null, source: 'dtek-oem', alternatives: allQueues, houseHints: result.houses });
          }
        }
      } catch (e: any) {
        console.warn(`[API] Address-queue (Odesa/DTEK): error — ${e.message}`);
      }
      console.log(`[API] Address-queue (Odesa): no match — manual queue selection`);
      return res.json({ queueId: null, source: 'none', alternatives: [], needsManualQueue: true });
    }

    const cleanStreet = stripStreetType(street).trim();

    const cached = getCachedQueue(cityName, street, houseName);
    if (cached && cached.queueId) {
      console.log(`[API] Address-queue: cache hit "${street} ${houseName}" → ${cached.queueId}`);
      return res.json({ queueId: cached.queueId, source: 'cached', alternatives: [], isEnterprise: cached.isEnterprise || false });
    }

    const originalStreetType = extractStreetType(street);

    const tryLocalResolve = (searchStreet: string, label: string, origStreetForType?: string): { queueId: string | null; alternatives: string[] } => {
      const streetForTypeCheck = origStreetForType || searchStreet;
      if (houseName) {
        const houseResult = findQueueByHouse(streetForTypeCheck, houseName);
        if (houseResult.queue) {
          console.log(`[API] Address-queue: ${label} house match "${searchStreet} ${houseName}" → ${houseResult.queue}`);
          return { queueId: houseResult.queue, alternatives: [] };
        }
        if (houseResult.allQueues.length > 1) {
          console.log(`[API] Address-queue: ${label} multi-queue house "${searchStreet} ${houseName}" → [${houseResult.allQueues.join(', ')}]`);
          return { queueId: null, alternatives: houseResult.allQueues };
        }
      }

      const localMatches = findQueuesForStreet(streetForTypeCheck);
      const streetQueues = new Set<string>();
      localMatches.forEach(m => m.queues.forEach(q => streetQueues.add(q)));

      if (houseName && streetQueues.size > 0) {
        for (const m of localMatches) {
          const hm = findQueueByHouse(m.street, houseName);
          if (hm.queue) {
            console.log(`[API] Address-queue: ${label} house via "${m.street} ${houseName}" → ${hm.queue}`);
            return { queueId: hm.queue, alternatives: [] };
          }
        }
      }

      if (streetQueues.size === 1) {
        const queueId = Array.from(streetQueues)[0];
        console.log(`[API] Address-queue: ${label} single street match "${searchStreet}" → ${queueId}`);
        return { queueId, alternatives: [] };
      }

      if (streetQueues.size > 1) {
        return { queueId: null, alternatives: Array.from(streetQueues).sort() };
      }

      return { queueId: null, alternatives: [] };
    };

    const localResult = tryLocalResolve(cleanStreet, 'local', street);
    if (localResult.queueId) {
      cacheQueueResult(cityName, street, houseName, localResult.queueId);
      return res.json({ queueId: localResult.queueId, source: 'local', alternatives: [] });
    }
    if (localResult.alternatives.length > 0) {
      return res.json({ queueId: null, source: 'local', alternatives: localResult.alternatives });
    }

    const oldName = await lookupOldStreetName(cleanStreet) || await lookupOldStreetName(street);
    if (oldName) {
      const oldNameResult = tryLocalResolve(oldName, 'old-name');
      if (oldNameResult.queueId) {
        cacheQueueResult(cityName, street, houseName, oldNameResult.queueId);
        return res.json({ queueId: oldNameResult.queueId, source: 'old-name', alternatives: [] });
      }
      if (oldNameResult.alternatives.length > 0) {
        return res.json({ queueId: null, source: 'old-name', alternatives: oldNameResult.alternatives });
      }
    }

    console.log(`[API] Address-queue: no match for "${street} ${houseName}" — needs manual queue`);
    return res.json({ queueId: null, source: 'none', alternatives: [], needsManualQueue: true });
  });

  const inboxPolicy = !isIsolatedMode() && process.env.NODE_ENV === 'production' ? productionRuntimePolicy() : null;
  let telegramInbox: ReturnType<typeof createTelegramInbox> | undefined;
  registerTelegramInboxRoute(app, {
    enabled: inboxPolicy?.telegramUpdatesEnabled === true,
    expectedControlEpoch: inboxPolicy?.canonicalControlEpoch ?? null,
    inbox: () => {
      if (!inboxPolicy?.telegramUpdatesEnabled || !inboxPolicy.canonicalControlEpoch) throw Error('TELEGRAM_INBOX_DISABLED');
      return telegramInbox ??= createTelegramInbox({ enabled: true, pool,
        expectedBotId: PRODUCT_TELEGRAM_IDENTITY.botId, expectedControlEpoch: inboxPolicy.canonicalControlEpoch,
        secret: process.env.TELEGRAM_WEBHOOK_SECRET!, now: () => new Date().toISOString() });
    },
  });

  app.get('/api/notify/telegram/bot-info', async (_req, res) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return res.status(500).json({ error: 'Telegram bot not configured' });
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = await response.json() as any;
      if (data.ok) {
        res.json({ username: data.result.username, name: data.result.first_name });
      } else {
        res.status(500).json({ error: 'Failed to get bot info' });
      }
    } catch {
      res.status(500).json({ error: 'Failed to get bot info' });
    }
  });

  app.get('/api/notify/telegram/detect-chat', async (_req, res) => {
    try {
      const recent = getRecentStarts();
      if (recent.length === 0) {
        return res.json({ chatId: null });
      }
      const latest = recent[0];
      res.json({
        chatId: latest.chatId,
        firstName: latest.firstName || '',
        username: latest.username || '',
      });
    } catch {
      res.status(500).json({ error: 'Failed to detect chat' });
    }
  });

  app.get('/api/notify/telegram/subscriber', async (req, res) => {
    try {
      const chatId = req.query.chatId as string;
      if (!chatId) return res.status(400).json({ error: 'Missing chatId' });
      const subs = getSubscribers();
      const sub = subs.find(s => s.chatId === chatId);
      if (!sub) return res.status(404).json({ error: 'Not found' });
      res.json({
        city: sub.city || 'Вінниця',
        street: sub.street || '',
        houseNumber: sub.houseNumber || '',
        queueId: sub.queueId || '',
        lookupMode: sub.lookupMode || 'queue',
        notifyBeforeOff: sub.notifyBeforeOff,
        notifyBeforeOn: sub.notifyBeforeOn,
        enabled: sub.enabled,
      });
    } catch {
      res.status(500).json({ error: 'Failed to get subscriber' });
    }
  });

  app.post('/api/notify/telegram/sync-address', async (req, res) => {
    try {
      const { chatId, city, street, house, queueId, notifyBeforeOff, notifyBeforeOn, lookupMode, enabled,
        quietHoursEnabled, quietHoursStart, quietHoursEnd, morningBriefingEnabled, morningBriefingHour, minOutageDuration } = req.body;
      if (!chatId) {
        return res.status(400).json({ error: 'Missing chatId' });
      }
      const subs = getSubscribers();
      const existing = subs.find(s => s.chatId === chatId);
      if (!existing) {
        return res.status(404).json({ error: 'Subscriber not found' });
      }
      const updates: any = {};
      if (typeof city === 'string' && (city === 'Вінниця' || city === 'Київ' || city === 'Харків' || city === 'Одеса')) updates.city = city;
      if (lookupMode) updates.lookupMode = lookupMode;
      if (typeof street === 'string') {
        updates.street = street;
        if (!lookupMode && street) updates.lookupMode = 'address';
      }
      if (typeof house === 'string') updates.houseNumber = house;
      if (typeof queueId === 'string') updates.queueId = queueId;
      if (notifyBeforeOff !== undefined && typeof notifyBeforeOff === 'number') {
        updates.notifyBeforeOff = notifyBeforeOff;
      }
      if (notifyBeforeOn !== undefined && typeof notifyBeforeOn === 'number') {
        updates.notifyBeforeOn = notifyBeforeOn;
      }
      if (enabled !== undefined && typeof enabled === 'boolean') {
        updates.enabled = enabled;
      }
      if (typeof quietHoursEnabled === 'boolean') updates.quietHoursEnabled = quietHoursEnabled;
      if (typeof quietHoursStart === 'number') updates.quietHoursStart = quietHoursStart;
      if (typeof quietHoursEnd === 'number') updates.quietHoursEnd = quietHoursEnd;
      if (typeof morningBriefingEnabled === 'boolean') updates.morningBriefingEnabled = morningBriefingEnabled;
      if (typeof morningBriefingHour === 'number') updates.morningBriefingHour = morningBriefingHour;
      if (typeof minOutageDuration === 'number') updates.minOutageDuration = minOutageDuration;
      if (Object.keys(updates).length > 0) {
        updateSubscriber(chatId, updates, true);
      }
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to sync address' });
    }
  });

  app.post('/api/notify/telegram', async (req, res) => {
    const { chatId, message } = req.body;
    if (!chatId || !message) {
      return res.status(400).json({ error: 'Missing chatId or message' });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return res.status(500).json({ error: 'Telegram bot not configured' });
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      const data = await response.json() as any;
      if (!data.ok) {
        console.error('[Telegram] Send failed:', data.description);
        return res.status(400).json({ error: data.description || 'Telegram API error' });
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error('[Telegram] Request failed:', error.message);
      res.status(500).json({ error: 'Failed to send Telegram message' });
    }
  });

  app.post('/api/notify/telegram/test', async (req, res) => {
    const { chatId } = req.body;
    if (!chatId) {
      return res.status(400).json({ error: 'Missing chatId' });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return res.status(500).json({ error: 'Telegram bot not configured' });
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✅ <b>Підключено!</b>\n\n🔔 Telegram-сповіщення налаштовано.\nВи отримуватимете повідомлення перед змінами у графіку.\n\n<i>Світло Україна</i>',
          parse_mode: 'HTML',
        }),
      });

      const data = await response.json() as any;
      if (!data.ok) {
        return res.status(400).json({ error: data.description || 'Invalid chat ID' });
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error('[Telegram] Test failed:', error.message);
      res.status(500).json({ error: 'Failed to send test message' });
    }
  });

  app.get('/api/geocode/streets', async (req, res) => {
    const { q, city: cityParam } = req.query;
    const city = (cityParam as string) || 'Вінниця';
    if (!q || typeof q !== 'string' || q.length < 2) {
      return res.json([]);
    }

    if (city === 'Київ') {
      try {
        const streets = await searchKyivStreets(q);
        return res.json(streets.map(s => s.value).slice(0, 15));
      } catch (error: any) {
        console.error('[API] YASNO streets error:', error.message);
        return res.json([]);
      }
    }

    if (city === 'Харків') {
      if (!kharkivAllStreets && !kharkivAllStreetsFetching) {
        fetchAllKharkivStreets().catch(() => {});
      }

      const localResults = searchKharkivStreets(q);

      if (localResults.length >= 5 || kharkivAllStreets) {
        return res.json(localResults.slice(0, 20));
      }

      if (q.length >= 3) {
        try {
          const response = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Харків, Україна')}&format=json&addressdetails=1&limit=20&dedupe=1&accept-language=uk`,
            { headers: { 'User-Agent': 'SvitloUkraine/1.0 (outage-tracker-app)' }, signal: AbortSignal.timeout(8000) }
          );
          const data = await response.json();
          const nominatimStreets = (data as any[])
            .filter((item: any) => {
              const addr = item.address;
              const itemCity = addr?.city || addr?.town || addr?.village || '';
              return itemCity.toLowerCase().includes('харк');
            })
            .map((item: any) => item.address?.road || item.address?.pedestrian || item.address?.footway || item.address?.path)
            .filter(Boolean);

          const merged = [...localResults];
          const normalizeForDedup = (name: string) => stripStreetType(name).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
          const existingNorms = new Set(merged.map(normalizeForDedup));
          for (const s of nominatimStreets) {
            const norm = normalizeForDedup(s);
            if (!existingNorms.has(norm)) {
              existingNorms.add(norm);
              merged.push(s);
            }
          }
          return res.json(merged.slice(0, 20));
        } catch (error: any) {
          console.error('[API] Nominatim streets (Kharkiv) error:', error.message);
        }
      }

      return res.json(localResults.slice(0, 20));
    }

    if (city === 'Одеса') {
      const dtekResults = searchDtekOemStreets(q, 'м. Одеса');

      if (!odesaAllStreets && !odesaAllStreetsFetching) {
        fetchAllOdesaStreets().catch(() => {});
      }

      const overpassResults = searchOdesaStreets(q);

      const normalizeForDedup = (name: string) => stripStreetType(name).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
      const merged = [...dtekResults];
      const existingNorms = new Set(merged.map(normalizeForDedup));
      for (const s of overpassResults) {
        const norm = normalizeForDedup(s);
        if (!existingNorms.has(norm)) {
          existingNorms.add(norm);
          merged.push(s);
        }
      }

      if (merged.length >= 5 || (dtekResults.length > 0 && odesaAllStreets)) {
        return res.json(merged.slice(0, 20));
      }

      if (q.length >= 2) {
        try {
          const response = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Одеса, Україна')}&format=json&addressdetails=1&limit=20&dedupe=1&accept-language=uk`,
            { headers: { 'User-Agent': 'SvitloUkraine/1.0 (outage-tracker-app)' }, signal: AbortSignal.timeout(8000) }
          );
          const data = await response.json();
          const nominatimStreets = (data as any[])
            .filter((item: any) => {
              const addr = item.address;
              const itemCity = addr?.city || addr?.town || addr?.village || '';
              return itemCity.toLowerCase().includes('одес');
            })
            .map((item: any) => item.address?.road || item.address?.pedestrian || item.address?.footway || item.address?.path)
            .filter(Boolean);

          for (const s of nominatimStreets) {
            const norm = normalizeForDedup(s);
            if (!existingNorms.has(norm)) {
              existingNorms.add(norm);
              merged.push(s);
            }
          }
          return res.json(merged.slice(0, 20));
        } catch (error: any) {
          console.error('[API] Nominatim streets (Odesa) error:', error.message);
        }
      }

      return res.json(merged.slice(0, 20));
    }

    const localResults = searchLocalStreets(q);

    if (localResults.length >= 5 || q.length < 3) {
      return res.json(localResults.slice(0, 15));
    }

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Вінниця, Україна')}&format=json&addressdetails=1&limit=20&dedupe=1&accept-language=uk`,
        { headers: { 'User-Agent': 'SvitloUkraine/1.0 (outage-tracker-app)' }, signal: AbortSignal.timeout(5000) }
      );
      const data = await response.json();
      const nominatimStreets = (data as any[])
        .filter((item: any) => {
          const addr = item.address;
          const city = addr?.city || addr?.town || addr?.village || '';
          return city.toLowerCase().includes('вінниц');
        })
        .map((item: any) => item.address?.road || item.address?.pedestrian || item.address?.footway || item.address?.path)
        .filter(Boolean);

      const normalizeForDedup = (name: string) => stripStreetType(name).toLowerCase().replace(/[.'`'\u2019\u0027]/g, '').replace(/\s+/g, ' ').trim();
      const merged = [...localResults];
      const existingNorms = new Set(merged.map(normalizeForDedup));
      for (const s of nominatimStreets) {
        const norm = normalizeForDedup(s);
        if (!existingNorms.has(norm)) {
          existingNorms.add(norm);
          merged.push(s);
        }
      }
      return res.json(merged.slice(0, 15));
    } catch (error: any) {
      console.error('[API] Nominatim streets error:', error.message);
    }

    res.json(localResults.slice(0, 15));
  });

  app.get('/api/geocode/houses', async (req, res) => {
    const { street, q, city: cityParam } = req.query;
    const city = (cityParam as string) || 'Вінниця';
    if (!street || typeof street !== 'string') {
      return res.json([]);
    }

    if (city === 'Київ') {
      try {
        const streets = await searchKyivStreets(street);
        if (streets.length === 0) return res.json([]);
        const houses = await searchKyivHouses(streets[0].id, (q as string) || '');
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const h of houses) {
          const num = h.value.replace(/\s*ввод\s*\d+$/i, '').trim();
          if (num && !seen.has(num.toLowerCase())) {
            seen.add(num.toLowerCase());
            cleaned.push(num);
          }
        }
        const sorted = cleaned.sort((a: string, b: string) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
        );
        const filter = ((q as string) || '').toLowerCase().trim();
        const filtered = filter ? sorted.filter(h => h.toLowerCase().startsWith(filter)) : sorted;
        return res.json(filtered.slice(0, 30));
      } catch (error: any) {
        console.error('[API] YASNO houses error:', error.message);
        return res.json([]);
      }
    }

    if (city === 'Харків') {
      const localHouses = searchKharkivHouses(street, (q as string) || '');
      const overpassHouses = await fetchOverpassHouses('Харків', street);
      const merged = [...localHouses];
      for (const h of overpassHouses) {
        if (!merged.includes(h)) merged.push(h);
      }
      const sorted = merged.sort((a: string, b: string) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      );
      const filter = ((q as string) || '').toLowerCase().trim();
      const filtered = filter ? sorted.filter(h => h.toLowerCase().startsWith(filter)) : sorted;
      return res.json(filtered.slice(0, 30));
    }

    if (city === 'Одеса') {
      try {
        const dtekResult = await resolveOdesaAddressQueue('м. Одеса', street, '');
        const dtekHouses = Object.keys(dtekResult.houses);
        const overpassHouses = await fetchOverpassHouses('Одеса', street);
        const merged = [...dtekHouses];
        const seen = new Set(dtekHouses.map(h => h.toLowerCase()));
        for (const h of overpassHouses) {
          if (!seen.has(h.toLowerCase())) { merged.push(h); seen.add(h.toLowerCase()); }
        }
        const sorted = merged.sort((a: string, b: string) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
        );
        const filter = ((q as string) || '').toLowerCase().trim();
        const filtered = filter ? sorted.filter(h => h.toLowerCase().startsWith(filter)) : sorted;
        return res.json(filtered.slice(0, 30));
      } catch (error: any) {
        console.error('[API] Houses (Odesa) error:', error.message);
        return res.json([]);
      }
    }

    const localHouses = searchLocalHouses(street, (q as string) || '');

    if (localHouses.length > 0) {
      return res.json(localHouses.slice(0, 30));
    }

    try {
      const overpassHouses = await fetchOverpassHouses('Вінниця', street);
      const sorted = overpassHouses.sort((a: string, b: string) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      );
      const filter = ((q as string) || '').toLowerCase().trim();
      const filtered = filter ? sorted.filter(h => h.toLowerCase().startsWith(filter)) : sorted;
      return res.json(filtered.slice(0, 30));
    } catch (error: any) {
      console.error('[API] Overpass houses error:', error.message);
      return res.json([]);
    }
  });

  async function resolveOrCreateTelegramUser(chatId: string, firstName?: string, lastName?: string, photoUrl?: string): Promise<string> {
    const linked = await getLinkedAccountByProvider('telegram', chatId);
    if (linked) {
      const currentSettings = await getUserSettings(linked.userId);
      if (!currentSettings?.telegramChatId || currentSettings.telegramChatId !== chatId) {
        await upsertUserSettings(linked.userId, { telegramChatId: chatId });
      }
      return linked.userId;
    }

    const telegramId = `tg_${chatId}`;
    await authStorage.upsertUser({
      id: telegramId,
      email: null,
      firstName: firstName || null,
      lastName: lastName || null,
      profileImageUrl: photoUrl || null,
    });

    await addLinkedAccount(telegramId, 'telegram', chatId, firstName ? `Telegram: ${firstName}` : `Telegram: ${chatId}`);

    const subs = getSubscribers();
    const sub = subs.find(s => s.chatId === chatId);
    if (sub) {
      const settingsFromBot: Record<string, any> = { telegramChatId: chatId };
      if (sub.queueId) settingsFromBot.queueId = sub.queueId;
      if (sub.street) {
        settingsFromBot.street = sub.street;
        settingsFromBot.houseNumber = sub.houseNumber || '';
        settingsFromBot.lookupMode = sub.lookupMode || 'address';
      }
      if (sub.lookupMode === 'queue') settingsFromBot.lookupMode = 'queue';
      settingsFromBot.telegramNotifications = sub.enabled;
      settingsFromBot.telegramNotifyBeforeOff = sub.notifyBeforeOff;
      settingsFromBot.telegramNotifyBeforeOn = sub.notifyBeforeOn;
      await upsertUserSettings(telegramId, settingsFromBot);
      console.log(`[TG Auth] Synced bot settings for new user ${telegramId}`);
    }

    return telegramId;
  }

  // The three Telegram proof routes share one durable ledger and Passport session boundary.
  const telegramProofEnabled = !isIsolatedMode() && process.env.NODE_ENV === 'production'
    && productionRuntimePolicy().telegramAuthReplayEnabled;
  let telegramAuthFlow: ReturnType<typeof createTelegramAuthFlow> | undefined;
  registerTelegramProofRoutes(app, {
    enabled: telegramProofEnabled, now: () => Math.floor(Date.now() / 1000), limiter: authLimiter,
    authenticateSession: isAuthenticated,
    flow: () => {
      if (!telegramProofEnabled) throw Error('TELEGRAM_AUTH_DISABLED');
      if (!telegramAuthFlow) {
        const token = process.env.TELEGRAM_BOT_TOKEN!, botId = PRODUCT_TELEGRAM_IDENTITY.botId;
        const now = () => Math.floor(Date.now() / 1000);
        const guard = createAuthReplayGuard(pool, { key: process.env.SESSION_SECRET!, now });
        telegramAuthFlow = createTelegramAuthFlow({ token, botId, now, guard, resolveUser: createTelegramIdentityResolver(pool) });
      }
      return telegramAuthFlow;
    },
    mobileToken: generateMobileToken, readUser: owner => authStorage.getUser(owner),
  });

  app.get('/api/auth/telegram-auto', async (req: any, res) => {
    const { token } = req.query as Record<string, string>;
    if (!token) {
      return res.redirect('/');
    }

    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isTelegramWebView = ua.includes('telegram') || ua.includes('tgweb');

    if (isTelegramWebView) {
      const consumed = consumeAutoLoginToken(token);
      if (!consumed) {
        return res.redirect('/');
      }
      const freshToken = generateAutoLoginToken(consumed.chatId);
      const loginUrl = `https://power-ukraine.net/api/auth/telegram-auto?token=${encodeURIComponent(freshToken)}`;
      const name = consumed.firstName ? `, ${consumed.firstName}` : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Світло Україна</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{text-align:center;max-width:360px;width:100%}.icon{font-size:48px;margin-bottom:16px}.title{font-size:22px;font-weight:700;margin-bottom:8px}.sub{font-size:14px;color:#94a3b8;margin-bottom:32px;line-height:1.5}
.btn{display:block;width:100%;padding:16px;background:#3b82f6;color:#fff;font-size:17px;font-weight:600;border:none;border-radius:12px;text-decoration:none;cursor:pointer;margin-bottom:12px;-webkit-tap-highlight-color:transparent}
.btn:active{background:#2563eb}.hint{font-size:12px;color:#64748b;margin-top:16px;line-height:1.4}</style></head>
<body><div class="card"><div class="icon">⚡</div><div class="title">Вхід виконано${name}!</div>
<div class="sub">Для найкращої роботи відкрийте додаток у браузері</div>
<a class="btn" href="${loginUrl}" target="_blank" rel="noopener">Відкрити в браузері</a>
<div class="hint">Натисніть кнопку вище — додаток відкриється у Safari/Chrome.<br>Потім можете повернутись до Telegram.</div></div></body></html>`);
    }

    const data = consumeAutoLoginToken(token);
    if (!data) {
      console.log('[TG Auto-Login] Invalid or expired token');
      return res.redirect('/');
    }

    const userId = await resolveOrCreateTelegramUser(data.chatId, data.firstName);

    const existingSettings = await getUserSettings(userId);
    const isReturning = !!(existingSettings?.queueId || existingSettings?.street);

    const now = Math.floor(Date.now() / 1000);
    req.login({ claims: { sub: userId, first_name: data.firstName }, expires_at: now + 7 * 24 * 3600 }, (err: any) => {
      if (err) {
        console.error('[TG Auto-Login] Session error:', err);
        return res.redirect('/');
      }
      console.log(`[TG Auto-Login] User ${userId} auto-logged in from Telegram chatId ${data.chatId} (returning: ${isReturning})`);
      if (isReturning) {
        res.redirect('/?fromTelegram=1');
      } else {
        res.redirect('/?fromTelegram=1&firstTime=1');
      }
    });
  });

  app.get('/api/auth/telegram-link-token', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const token = generateLinkToken(userId);
      res.json({ token });
    } catch (error: any) {
      console.error('[API] Generate link token error:', error.message);
      res.status(500).json({ error: 'Failed to generate link token' });
    }
  });

  app.post('/api/auth/telegram-login-request', async (_req: any, res) => {
    try {
      const token = generateWebLoginToken();
      const botUrl = `https://t.me/PowerUkraineBot?start=weblogin_${token}`;
      res.json({ token, botUrl });
    } catch (error: any) {
      console.error('[API] Telegram login request error:', error.message);
      res.status(500).json({ error: 'Failed to create login request' });
    }
  });

  app.get('/api/auth/telegram-login-poll', async (req: any, res) => {
    try {
      const { token } = req.query as Record<string, string>;
      if (!token) return res.json({ ready: false });
      const result = resolveWebLoginToken(token);
      if (result.ready && result.autoLoginToken) {
        res.json({ ready: true, redirectUrl: `/api/auth/telegram-auto?token=${encodeURIComponent(result.autoLoginToken)}` });
      } else {
        res.json({ ready: false });
      }
    } catch (error: any) {
      res.json({ ready: false });
    }
  });

  app.get('/api/auth/linked-accounts', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const accounts = await getLinkedAccountsByUserId(userId);
      res.json(accounts);
    } catch (error: any) {
      console.error('[API] Get linked accounts error:', error.message);
      res.status(500).json({ error: 'Failed to get linked accounts' });
    }
  });

  app.post('/api/auth/link-telegram', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const { chatId } = req.body;
      if (!chatId) {
        return res.status(400).json({ error: 'Missing chatId' });
      }

      const existing = await getLinkedAccountByProvider('telegram', chatId);
      if (existing && existing.userId !== userId) {
        await migrateUserSettings(existing.userId, userId);
      }

      const subs = getSubscribers();
      const sub = subs.find(s => s.chatId === chatId);
      const displayName = sub?.firstName ? `Telegram: ${sub.firstName}` : `Telegram: ${chatId}`;

      await addLinkedAccount(userId, 'telegram', chatId, displayName);

      const currentSettings = await getUserSettings(userId);
      if (!currentSettings?.telegramChatId || currentSettings.telegramChatId !== chatId) {
        await upsertUserSettings(userId, { telegramChatId: chatId });
      }

      if (sub) {
        const settingsToSync: Record<string, any> = {};
        if (sub.queueId && (!currentSettings?.queueId)) settingsToSync.queueId = sub.queueId;
        if (sub.street && (!currentSettings?.street)) {
          settingsToSync.street = sub.street;
          settingsToSync.houseNumber = sub.houseNumber || '';
          settingsToSync.lookupMode = sub.lookupMode || 'address';
        }
        if (Object.keys(settingsToSync).length > 0) {
          await upsertUserSettings(userId, settingsToSync);
        }
      }

      console.log(`[Link] Telegram chatId ${chatId} linked to user ${userId}`);
      res.json({ success: true });
    } catch (error: any) {
      console.error('[API] Link Telegram error:', error.message);
      res.status(500).json({ error: 'Failed to link Telegram' });
    }
  });

  app.post('/api/auth/unlink', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const { provider, providerId } = req.body;
      if (!provider || !providerId) {
        return res.status(400).json({ error: 'Missing provider or providerId' });
      }

      const accounts = await getLinkedAccountsByUserId(userId);
      if (accounts.length <= 1) {
        return res.status(400).json({ error: 'Cannot unlink last authentication method' });
      }

      await removeLinkedAccount(userId, provider, providerId);
      res.json({ success: true });
    } catch (error: any) {
      console.error('[API] Unlink error:', error.message);
      res.status(500).json({ error: 'Failed to unlink account' });
    }
  });

  app.get('/api/user/settings-stream', isAuthenticated, (req: any, res) => {
    const userId = req.user.claims.sub;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    if (!sseClients.has(userId)) {
      sseClients.set(userId, new Set());
    }
    sseClients.get(userId)!.add(res);

    const heartbeat = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const clients = sseClients.get(userId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) sseClients.delete(userId);
      }
    });
  });

  app.get('/api/user/settings', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      let settings = await getUserSettings(userId);

      if (!settings || (!settings.queueId && !settings.street)) {
        const accounts = await getLinkedAccountsByUserId(userId);
        const tgAccount = accounts.find(a => a.provider === 'telegram');
        if (tgAccount) {
          const chatId = tgAccount.providerId;
          const subs = getSubscribers();
          const sub = subs.find(s => String(s.chatId) === String(chatId));
          if (sub && (sub.queueId || sub.street)) {
            const syncData: Record<string, any> = {};
            if (sub.queueId) syncData.queueId = sub.queueId;
            if (sub.street) {
              syncData.street = sub.street;
              syncData.houseNumber = sub.houseNumber || '';
              syncData.lookupMode = sub.lookupMode || 'address';
            }
            syncData.telegramChatId = chatId;
            syncData.telegramNotifications = true;
            if (sub.notifyBeforeOff) syncData.telegramNotifyBeforeOff = sub.notifyBeforeOff;
            if (sub.notifyBeforeOn) syncData.telegramNotifyBeforeOn = sub.notifyBeforeOn;
            await upsertUserSettings(userId, syncData);
            settings = await getUserSettings(userId);
            console.log(`[Settings] Synced Telegram subscriber data for user ${userId} from chatId ${chatId}`);
          }
        }
      }

      if (!settings) {
        return res.json(null);
      }
      res.json(settings);
    } catch (error: any) {
      console.error('[API] Get user settings error:', error.message);
      res.status(500).json({ error: 'Failed to get settings' });
    }
  });

  app.put('/api/user/settings', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Invalid body' });
      }

      const allowed: Record<string, string> = {
        lookupMode: 'string', city: 'string', street: 'string', houseNumber: 'string',
        queueId: 'string', themeMode: 'string', telegramChatId: 'string',
        notificationsEnabled: 'boolean', telegramNotifications: 'boolean', hasSeenOnboarding: 'boolean',
        notifyBeforeOff: 'number', notifyBeforeOn: 'number',
        telegramNotifyBeforeOff: 'number', telegramNotifyBeforeOn: 'number',
        quietHoursEnabled: 'boolean', quietHoursStart: 'number', quietHoursEnd: 'number',
        morningBriefingEnabled: 'boolean', morningBriefingHour: 'number',
        minOutageDuration: 'number',
      };

      const data: Record<string, any> = {};
      for (const [key, type] of Object.entries(allowed)) {
        if (key in body && typeof body[key] === type) {
          data[key] = body[key];
        }
      }
      if (body.queueAlternatives && Array.isArray(body.queueAlternatives)) {
        data.queueAlternatives = body.queueAlternatives.filter((q: any) => typeof q === 'string');
      }
      if (body.addressQueueMemory && typeof body.addressQueueMemory === 'object' && !Array.isArray(body.addressQueueMemory)) {
        data.addressQueueMemory = body.addressQueueMemory;
      }

      const ADDRESS_KEYS = ['city', 'street', 'houseNumber', 'queueId', 'lookupMode'];
      const clientLastUpdatedAt = body.lastServerUpdatedAt;
      const incomingHasAddressChange = ADDRESS_KEYS.some(k => k in data);

      if (incomingHasAddressChange) {
        const existing = await getUserSettings(userId);
        if (existing && existing.updatedAt) {
          const dbTime = new Date(existing.updatedAt).getTime();
          const existingHasAddress = !!(existing.city || existing.street || existing.queueId);
          let isStale = false;

          if (clientLastUpdatedAt) {
            const clientTime = new Date(clientLastUpdatedAt).getTime();
            isStale = dbTime > clientTime;
          } else if (existingHasAddress) {
            isStale = true;
          }

          if (isStale) {
            const dbAddressDiffers = ADDRESS_KEYS.some(k =>
              k in data && String(data[k] || '') !== String((existing as any)[k] || '')
            );
            if (dbAddressDiffers) {
              console.log(`[Settings] Stale write rejected for ${userId}: client knows ${clientLastUpdatedAt || 'none'}, DB has ${existing.updatedAt}. Client sent city=${data.city}, DB has city=${existing.city}`);
              const nonAddressData: Record<string, any> = {};
              for (const [key, val] of Object.entries(data)) {
                if (!ADDRESS_KEYS.includes(key)) nonAddressData[key] = val;
              }
              let settings = existing;
              if (Object.keys(nonAddressData).length > 0) {
                settings = await upsertUserSettings(userId, nonAddressData);
              }
              return res.json({ ...settings, conflict: true });
            }
          }
        }
      }

      const settings = await upsertUserSettings(userId, data);

      syncSettingsToBot(settings, data);
      syncSettingsAcrossLinkedAccounts(userId, data, settings);

      const sourceTabId = body._tabId;
      broadcastToAllLinkedUsers(userId, settings, sourceTabId);

      res.json(settings);
    } catch (error: any) {
      console.error('[API] Update user settings error:', error.message);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });


  app.post('/api/auth/refresh-token', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const firstName = req.user.claims.first_name;
      const token = generateMobileToken(userId, firstName);
      const user = await authStorage.getUser(userId);
      res.json({
        token,
        user: user || { id: userId, firstName },
        expiresIn: '30d',
      });
    } catch (error: any) {
      console.error('[API] Token refresh error:', error.message);
      res.status(500).json({ error: 'Failed to refresh token' });
    }
  });

  app.post('/api/auth/logout', (req: any, res) => {
    try {
      if (req.session) {
        req.session.destroy((err: any) => {
          if (err) console.error('[Auth] Session destroy error:', err.message);
        });
      }
      res.clearCookie('connect.sid');
      res.json({ success: true });
    } catch {
      res.json({ success: true });
    }
  });

  app.post('/api/user/settings-beacon', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(204).end();
      }

      const allowed: Record<string, string> = {
        lookupMode: 'string', city: 'string', street: 'string', houseNumber: 'string',
        queueId: 'string', themeMode: 'string', telegramChatId: 'string',
        notificationsEnabled: 'boolean', telegramNotifications: 'boolean', hasSeenOnboarding: 'boolean',
        notifyBeforeOff: 'number', notifyBeforeOn: 'number',
        telegramNotifyBeforeOff: 'number', telegramNotifyBeforeOn: 'number',
        quietHoursEnabled: 'boolean', quietHoursStart: 'number', quietHoursEnd: 'number',
        morningBriefingEnabled: 'boolean', morningBriefingHour: 'number',
        minOutageDuration: 'number',
      };

      const data: Record<string, any> = {};
      for (const [key, type] of Object.entries(allowed)) {
        if (key in body && typeof body[key] === type) {
          data[key] = body[key];
        }
      }
      if (body.queueAlternatives && Array.isArray(body.queueAlternatives)) {
        data.queueAlternatives = body.queueAlternatives.filter((q: any) => typeof q === 'string');
      }
      if (body.addressQueueMemory && typeof body.addressQueueMemory === 'object' && !Array.isArray(body.addressQueueMemory)) {
        data.addressQueueMemory = body.addressQueueMemory;
      }

      const ADDRESS_KEYS = ['city', 'street', 'houseNumber', 'queueId', 'lookupMode'];
      const clientLastUpdatedAt = body.lastServerUpdatedAt;
      const incomingHasAddressChange = ADDRESS_KEYS.some(k => k in data);

      if (incomingHasAddressChange) {
        const existing = await getUserSettings(userId);
        if (existing && existing.updatedAt) {
          const dbTime = new Date(existing.updatedAt).getTime();
          const existingHasAddress = !!(existing.city || existing.street || existing.queueId);
          let isStale = false;

          if (clientLastUpdatedAt) {
            const clientTime = new Date(clientLastUpdatedAt).getTime();
            isStale = dbTime > clientTime;
          } else if (existingHasAddress) {
            isStale = true;
          }

          if (isStale) {
            const dbAddressDiffers = ADDRESS_KEYS.some(k =>
              k in data && String(data[k] || '') !== String((existing as any)[k] || '')
            );
            if (dbAddressDiffers) {
              console.log(`[Settings] Stale beacon rejected for ${userId}: client knows ${clientLastUpdatedAt || 'none'}, DB has ${existing.updatedAt}`);
              const nonAddressData: Record<string, any> = {};
              for (const [key, val] of Object.entries(data)) {
                if (!ADDRESS_KEYS.includes(key)) nonAddressData[key] = val;
              }
              if (Object.keys(nonAddressData).length > 0) {
                await upsertUserSettings(userId, nonAddressData);
              }
              return res.status(204).end();
            }
          }
        }
      }

      const settings = await upsertUserSettings(userId, data);
      syncSettingsToBot(settings, data);
      syncSettingsAcrossLinkedAccounts(userId, data, settings);
      const sourceTabId = body._tabId;
      broadcastToAllLinkedUsers(userId, settings, sourceTabId);
      res.status(204).end();
    } catch {
      res.status(204).end();
    }
  });

  const { registerReportRoutes } = await import("./routes-reports");
  const { registerLocationRoutes } = await import("./routes-locations");
  const { registerDigestRoutes } = await import("./routes-digest");
  registerReportRoutes(app);
  registerLocationRoutes(app);
  registerDigestRoutes(app);

  app.post('/api/admin/broadcast', async (req: any, res) => {
    try {
      const { message, token } = req.body;
      const fullBotToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!fullBotToken || !token || token !== fullBotToken) {
        return res.status(403).json({ error: 'Invalid token' });
      }
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Missing message' });
      }
      const result = await broadcastAnnouncement(message);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return httpServer;
}
