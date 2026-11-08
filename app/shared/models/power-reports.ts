import { sql } from "drizzle-orm";
import { pgTable, varchar, timestamp, boolean, index, serial } from "drizzle-orm/pg-core";

export const powerReports = pgTable("power_reports", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 255 }),
  chatId: varchar("chat_id", { length: 50 }),
  city: varchar("city", { length: 100 }).notNull(),
  queueId: varchar("queue_id", { length: 10 }).notNull(),
  hasPower: boolean("has_power").notNull(),
  source: varchar("source", { length: 10 }).default("web").notNull(),
  reportedAt: timestamp("reported_at").defaultNow().notNull(),
}, (table) => [
  index("power_reports_queue_idx").on(table.city, table.queueId, table.reportedAt),
  index("power_reports_user_idx").on(table.userId),
]);

export type PowerReport = typeof powerReports.$inferSelect;
export type InsertPowerReport = typeof powerReports.$inferInsert;
