import { sql } from "drizzle-orm";
import { pgTable, varchar, integer, real, timestamp, index, serial, text, jsonb } from "drizzle-orm/pg-core";
import { users } from "./auth";

export const weeklyDigests = pgTable("weekly_digests", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  weekStart: timestamp("week_start").notNull(),
  city: varchar("city", { length: 100 }).notNull(),
  queueId: varchar("queue_id", { length: 10 }).notNull(),
  hoursWithoutPower: real("hours_without_power").default(0).notNull(),
  deltaHours: real("delta_hours").default(0),
  totalReports: integer("total_reports").default(0).notNull(),
  longestOutageMinutes: integer("longest_outage_minutes").default(0),
  bestDay: varchar("best_day", { length: 20 }),
  queueAccuracyPct: real("queue_accuracy_pct"),
  queueTotalReports: integer("queue_total_reports").default(0),
  locationDigests: jsonb("location_digests").$type<LocationDigestEntry[]>().default([]),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("weekly_digests_user_week_idx").on(table.userId, table.weekStart),
]);

export interface LocationDigestEntry {
  locationId: number;
  name: string;
  city: string;
  queueId: string;
  hoursWithoutPower: number;
  totalReports: number;
}

export type WeeklyDigest = typeof weeklyDigests.$inferSelect;
export type InsertWeeklyDigest = typeof weeklyDigests.$inferInsert;
