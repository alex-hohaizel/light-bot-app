import { pgTable, varchar, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { users } from "./auth";

export const userSettings = pgTable("user_settings", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  lookupMode: varchar("lookup_mode", { length: 10 }).default("queue").notNull(),
  city: varchar("city", { length: 100 }).default("Вінниця").notNull(),
  street: varchar("street", { length: 255 }).default(""),
  houseNumber: varchar("house_number", { length: 50 }).default(""),
  queueId: varchar("queue_id", { length: 10 }).default(""),
  queueAlternatives: jsonb("queue_alternatives").$type<string[]>().default([]),
  addressQueueMemory: jsonb("address_queue_memory").$type<Record<string, string>>().default({}),
  notificationsEnabled: boolean("notifications_enabled").default(false).notNull(),
  notifyBeforeOff: integer("notify_before_off").default(30).notNull(),
  notifyBeforeOn: integer("notify_before_on").default(15).notNull(),
  telegramNotifications: boolean("telegram_notifications").default(false).notNull(),
  telegramChatId: varchar("telegram_chat_id", { length: 50 }).default(""),
  telegramNotifyBeforeOff: integer("telegram_notify_before_off").default(30).notNull(),
  telegramNotifyBeforeOn: integer("telegram_notify_before_on").default(15).notNull(),
  quietHoursEnabled: boolean("quiet_hours_enabled").default(false).notNull(),
  quietHoursStart: integer("quiet_hours_start").default(23).notNull(),
  quietHoursEnd: integer("quiet_hours_end").default(7).notNull(),
  morningBriefingEnabled: boolean("morning_briefing_enabled").default(false).notNull(),
  morningBriefingHour: integer("morning_briefing_hour").default(7).notNull(),
  minOutageDuration: integer("min_outage_duration").default(0).notNull(),
  themeMode: varchar("theme_mode", { length: 20 }).default("elegant").notNull(),
  hasSeenOnboarding: boolean("has_seen_onboarding").default(false).notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UserSettings = typeof userSettings.$inferSelect;
export type InsertUserSettings = typeof userSettings.$inferInsert;
