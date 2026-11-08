import { sql } from "drizzle-orm";
import { pgTable, varchar, integer, boolean, timestamp, index, uniqueIndex, serial } from "drizzle-orm/pg-core";
import { users } from "./auth";

export const userLocations = pgTable("user_locations", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  city: varchar("city", { length: 100 }).default("Вінниця").notNull(),
  lookupMode: varchar("lookup_mode", { length: 10 }).default("queue").notNull(),
  street: varchar("street", { length: 255 }).default(""),
  houseNumber: varchar("house_number", { length: 50 }).default(""),
  queueId: varchar("queue_id", { length: 10 }).default(""),
  isPrimary: boolean("is_primary").default(false).notNull(),
  orderIndex: integer("order_index").default(0).notNull(),
  notifyEnabled: boolean("notify_enabled").default(true).notNull(),
  notifyBeforeOff: integer("notify_before_off").default(30).notNull(),
  notifyBeforeOn: integer("notify_before_on").default(15).notNull(),
  telegramNotify: boolean("telegram_notify").default(true).notNull(),
  lastNotifKey: varchar("last_notif_key", { length: 255 }).default(""),
  lastScheduleHash: varchar("last_schedule_hash", { length: 255 }).default(""),
  shareId: varchar("share_id", { length: 32 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("user_locations_user_idx").on(table.userId),
  uniqueIndex("user_locations_share_idx").on(table.shareId),
]);

export type UserLocation = typeof userLocations.$inferSelect;
export type InsertUserLocation = typeof userLocations.$inferInsert;
