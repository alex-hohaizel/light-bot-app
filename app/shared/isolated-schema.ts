// Only the local synthetic schema command consumes this helper table.
export * from './schema';
import { boolean, check, pgTable, text, integer, bigserial, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const localIsolationMarker = pgTable('lba_isolation_marker', {
  singleton: boolean('singleton').primaryKey(),
  kind: text('kind').notNull(),
  sourceRevision: text('source_revision').notNull(),
  marker: text('marker').notNull(),
}, table => [check('lba_isolation_marker_singleton_check', sql`${table.singleton}`)]);

export const localBotSessions = pgTable('lba_bot_sessions', {
  ownerId: text('owner_id').primaryKey(),
  sessionId: text('session_id').notNull(),
  revision: integer('revision').notNull(),
  state: jsonb('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
export const localBotInbox = pgTable('lba_bot_inbox', {
  ownerId: text('owner_id').notNull(),
  inputId: text('input_id').notNull(),
  inputDigest: text('input_digest').notNull(),
  receipt: jsonb('receipt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.ownerId, table.inputId] })]);
export const localBotOutbox = pgTable('lba_bot_outbox', {
  id: text('id').primaryKey(),
  deliveryOrder: bigserial('delivery_order', { mode: 'number' }).notNull(),
  ownerId: text('owner_id').notNull(),
  inputId: text('input_id').notNull(),
  addressId: text('address_id'),
  revision: integer('revision').notNull(),
  ordinal: integer('ordinal').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
export const localDeliveryJobs = pgTable('lba_delivery_jobs', {
  operationId: text('operation_id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  outboxId: text('outbox_id').notNull(),
  record: jsonb('record').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
