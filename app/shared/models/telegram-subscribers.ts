import { pgTable, varchar, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const telegramSubscribers = pgTable("telegram_subscribers", {
  chatId: varchar("chat_id", { length: 50 }).primaryKey(),
  userId: varchar("user_id", { length: 255 }),
  username: varchar("username", { length: 255 }),
  city: varchar("city", { length: 50 }).default("Вінниця"),
  queueId: varchar("queue_id", { length: 10 }).default(""),
  lookupMode: varchar("lookup_mode", { length: 10 }).default("queue"),
  street: varchar("street", { length: 255 }).default(""),
  houseNumber: varchar("house_number", { length: 50 }).default(""),
  enabled: boolean("enabled").default(false).notNull(),
  notifyBeforeOff: integer("notify_before_off").default(30).notNull(),
  notifyBeforeOn: integer("notify_before_on").default(15).notNull(),
  lastNotifKey: varchar("last_notif_key", { length: 255 }).default(""),
  lastScheduleHash: varchar("last_schedule_hash", { length: 50 }).default(""),
  lastBotMsgId: integer("last_bot_msg_id"),
  welcomeMsgId: integer("welcome_msg_id"),
  quietHoursEnabled: boolean("quiet_hours_enabled").default(false).notNull(),
  quietHoursStart: integer("quiet_hours_start").default(23).notNull(),
  quietHoursEnd: integer("quiet_hours_end").default(7).notNull(),
  morningBriefingEnabled: boolean("morning_briefing_enabled").default(false).notNull(),
  morningBriefingHour: integer("morning_briefing_hour").default(7).notNull(),
  lastBriefingDate: varchar("last_briefing_date", { length: 20 }).default(""),
  minOutageDuration: integer("min_outage_duration").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type TelegramSubscriber = typeof telegramSubscribers.$inferSelect;
export type InsertTelegramSubscriber = typeof telegramSubscribers.$inferInsert;
