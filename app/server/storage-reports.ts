import { db } from "./db";
import { eq, and, gte, lte, desc, sql, count } from "drizzle-orm";
import { powerReports, type PowerReport, type InsertPowerReport } from "@shared/models/power-reports";
import { isIsolatedMode } from "./isolated-guard";

export async function createPowerReport(data: InsertPowerReport): Promise<PowerReport> {
  const [result] = await db.insert(powerReports).values(data).returning();
  return result;
}

export async function getRecentReportsForQueue(
  city: string,
  queueId: string,
  minutes: number = 30
): Promise<PowerReport[]> {
  const since = new Date(Date.now() - minutes * 60 * 1000);
  return db
    .select()
    .from(powerReports)
    .where(
      and(
        eq(powerReports.city, city),
        eq(powerReports.queueId, queueId),
        gte(powerReports.reportedAt, since)
      )
    )
    .orderBy(desc(powerReports.reportedAt));
}

export async function getQueueReportsForDateRange(
  city: string,
  queueId: string,
  from: Date,
  to: Date
): Promise<PowerReport[]> {
  return db
    .select()
    .from(powerReports)
    .where(
      and(
        eq(powerReports.city, city),
        eq(powerReports.queueId, queueId),
        gte(powerReports.reportedAt, from),
        lte(powerReports.reportedAt, to)
      )
    )
    .orderBy(desc(powerReports.reportedAt));
}

export async function getUserReportCount(userId: string, from?: Date, to?: Date): Promise<number> {
  const conditions = [eq(powerReports.userId, userId)];
  if (from) conditions.push(gte(powerReports.reportedAt, from));
  if (to) conditions.push(lte(powerReports.reportedAt, to));

  const [result] = await db
    .select({ count: count() })
    .from(powerReports)
    .where(and(...conditions));
  return result?.count || 0;
}

export async function getUserTotalReportCount(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(powerReports)
    .where(eq(powerReports.userId, userId));
  return result?.count || 0;
}

export async function getLastUserReport(userId: string, city: string, queueId: string): Promise<PowerReport | undefined> {
  const [result] = await db
    .select()
    .from(powerReports)
    .where(
      and(
        eq(powerReports.userId, userId),
        eq(powerReports.city, city),
        eq(powerReports.queueId, queueId)
      )
    )
    .orderBy(desc(powerReports.reportedAt))
    .limit(1);
  return result;
}

export function getUserStatus(totalReports: number): { level: string; emoji: string } {
  if (totalReports >= 200) return { level: 'Громадський Кореспондент', emoji: '🏆' };
  if (totalReports >= 50) return { level: 'Репортер', emoji: '📡' };
  return { level: 'Спостерігач', emoji: '👁️' };
}

export function getPointsForReport(): number {
  return 5;
}

export async function getQueueAccuracyStats(city: string, queueId: string): Promise<{
  totalReportsAllTime: number;
  uniqueVerifiers7d: number;
  reportsToday: number;
  confirmedAccuracy: number | null;
  dailyBreakdown: { date: string; total: number; hasPower: number; noPower: number }[];
}> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const dailyRows = await db
    .select({
      date: sql<string>`to_char(${powerReports.reportedAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`,
      total: count(),
      hasPower: sql<number>`count(*) filter (where ${powerReports.hasPower} = true)`,
      noPower: sql<number>`count(*) filter (where ${powerReports.hasPower} = false)`,
    })
    .from(powerReports)
    .where(
      and(
        eq(powerReports.city, city),
        eq(powerReports.queueId, queueId),
        gte(powerReports.reportedAt, sevenDaysAgo)
      )
    )
    .groupBy(sql`to_char(${powerReports.reportedAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${powerReports.reportedAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`);

  const [allTimeResult] = await db
    .select({ count: count() })
    .from(powerReports)
    .where(and(eq(powerReports.city, city), eq(powerReports.queueId, queueId)));

  const [uniqueResult] = await db
    .select({ count: sql<number>`count(distinct ${powerReports.userId})` })
    .from(powerReports)
    .where(
      and(
        eq(powerReports.city, city),
        eq(powerReports.queueId, queueId),
        gte(powerReports.reportedAt, sevenDaysAgo)
      )
    );

  const windowRows = await db
    .select({
      window: sql<string>`to_char(${powerReports.reportedAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD HH24') || ':00'`,
      uniqueUsers: sql<number>`count(distinct ${powerReports.userId})`,
      hasPower: sql<number>`count(*) filter (where ${powerReports.hasPower} = true)`,
      noPower: sql<number>`count(*) filter (where ${powerReports.hasPower} = false)`,
      total: count(),
    })
    .from(powerReports)
    .where(
      and(
        eq(powerReports.city, city),
        eq(powerReports.queueId, queueId),
        gte(powerReports.reportedAt, fourteenDaysAgo)
      )
    )
    .groupBy(sql`to_char(${powerReports.reportedAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD HH24') || ':00'`);

  let confirmedAccuracy: number | null = null;
  const confirmedWindows = windowRows.filter(w => Number(w.uniqueUsers) >= 2);
  if (confirmedWindows.length >= 3) {
    let consensusCount = 0;
    for (const w of confirmedWindows) {
      const hp = Number(w.hasPower);
      const np = Number(w.noPower);
      const total = hp + np;
      const majorityRatio = Math.max(hp, np) / total;
      if (majorityRatio >= 0.67) {
        consensusCount++;
      }
    }
    confirmedAccuracy = Math.round((consensusCount / confirmedWindows.length) * 100);
  }

  const todayStr = now.toLocaleDateString('sv-SE');
  const todayRow = dailyRows.find(r => r.date === todayStr);

  return {
    totalReportsAllTime: allTimeResult?.count || 0,
    uniqueVerifiers7d: Number(uniqueResult?.count) || 0,
    reportsToday: todayRow?.total || 0,
    confirmedAccuracy,
    dailyBreakdown: dailyRows.map(r => ({
      date: r.date,
      total: r.total,
      hasPower: Number(r.hasPower),
      noPower: Number(r.noPower),
    })),
  };
}

export async function getUserStreak(userId: string): Promise<number> {
  const rows = await db
    .select({
      date: sql<string>`to_char(${powerReports.reportedAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`,
    })
    .from(powerReports)
    .where(eq(powerReports.userId, userId))
    .groupBy(sql`to_char(${powerReports.reportedAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${powerReports.reportedAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') desc`);

  if (rows.length === 0) return 0;

  const now = new Date();
  const kyivNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const todayStr = kyivNow.toISOString().split('T')[0];
  const yesterdayStr = new Date(kyivNow.getTime() - 86400000).toISOString().split('T')[0];

  const dates = rows.map(r => r.date);
  if (dates[0] !== todayStr && dates[0] !== yesterdayStr) return 0;

  let streak = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const curr = new Date(dates[i]);
    const diff = (prev.getTime() - curr.getTime()) / 86400000;
    if (Math.round(diff) === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

const SEED_USERS = Array.from({ length: 40 }, (_, i) => `seed-user-${i + 1}`);

function pickSeedUsers(count: number): string[] {
  const shuffled = [...SEED_USERS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Historical compatibility symbol. Production observations are never manufactured.
 * Explicit synthetic fixtures belong to the isolated schema/seed, not user history. */
export async function ensureSeedDataForQueue(_city: string, _queueId: string): Promise<void> {
  return;
}
