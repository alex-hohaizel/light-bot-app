import { pgTable, varchar, serial, timestamp, text } from "drizzle-orm/pg-core";

export const compareShares = pgTable("compare_shares", {
  id: serial("id").primaryKey(),
  shareId: varchar("share_id", { length: 12 }).notNull().unique(),
  data: text("data").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type CompareShare = typeof compareShares.$inferSelect;
