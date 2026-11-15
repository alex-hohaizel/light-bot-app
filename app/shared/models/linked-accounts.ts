import { sql } from "drizzle-orm";
import { pgTable, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";

export const linkedAccounts = pgTable("linked_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 20 }).notNull(),
  providerId: varchar("provider_id", { length: 255 }).notNull(),
  displayName: varchar("display_name", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  uniqueIndex("linked_accounts_provider_id_idx").on(table.provider, table.providerId),
]);

export type LinkedAccount = typeof linkedAccounts.$inferSelect;
export type InsertLinkedAccount = typeof linkedAccounts.$inferInsert;
