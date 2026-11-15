import { db } from "./db";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { weeklyDigests, type WeeklyDigest, type InsertWeeklyDigest } from "@shared/models/weekly-digest";

export async function createWeeklyDigest(data: InsertWeeklyDigest): Promise<WeeklyDigest> {
  const [result] = await db.insert(weeklyDigests).values(data).returning();
  return result;
}

export async function getLatestDigest(userId: string): Promise<WeeklyDigest | undefined> {
  const [result] = await db
    .select()
    .from(weeklyDigests)
    .where(eq(weeklyDigests.userId, userId))
    .orderBy(desc(weeklyDigests.weekStart))
    .limit(1);
  return result;
}

export async function getDigestForWeek(userId: string, weekStart: Date): Promise<WeeklyDigest | undefined> {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 1);

  const [result] = await db
    .select()
    .from(weeklyDigests)
    .where(
      and(
        eq(weeklyDigests.userId, userId),
        gte(weeklyDigests.weekStart, weekStart),
        lte(weeklyDigests.weekStart, weekEnd)
      )
    );
  return result;
}

export async function getUserDigests(userId: string, limit: number = 10): Promise<WeeklyDigest[]> {
  return db
    .select()
    .from(weeklyDigests)
    .where(eq(weeklyDigests.userId, userId))
    .orderBy(desc(weeklyDigests.weekStart))
    .limit(limit);
}
