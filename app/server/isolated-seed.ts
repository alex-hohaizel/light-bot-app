import { assertIsolatedRuntimeReady, SYNTHETIC_USER_ID } from "./isolated-guard";
import { db, pool } from "./db";
import { users } from "@shared/models/auth";
import { userSettings } from "@shared/models/user-settings";
import { userLocations } from "@shared/models/user-locations";
import { eq } from "drizzle-orm";

export async function seedIsolatedData(): Promise<void> {
  assertIsolatedRuntimeReady();
  const identity = await pool.query("select current_database() as database, current_user as role");
  if (identity.rows[0]?.database !== "lba_synthetic" || identity.rows[0]?.role !== "lba_local") {
    throw new Error("LBA_SYNTHETIC_DATABASE_IDENTITY_MISMATCH");
  }
  const marker = await pool.query("select kind, source_revision, marker from public.lba_isolation_marker where singleton = true");
  if (marker.rowCount !== 1 || marker.rows[0]?.kind !== "synthetic" ||
      marker.rows[0]?.source_revision !== "45d77e22e68816e5695aa4b7d2a62bfc57e8176d" ||
      marker.rows[0]?.marker !== "lba-local-only-v1") {
    throw new Error("LBA_DISPOSABLE_DATABASE_MARKER_REQUIRED");
  }
  const provenance = await pool.query(`select
    (select count(*)::int from users where id not like 'lba-synthetic-%') as foreign_users,
    (select count(*)::int from user_settings where user_id not like 'lba-synthetic-%') as foreign_settings,
    (select count(*)::int from user_locations where user_id not like 'lba-synthetic-%') as foreign_locations,
    (select count(*)::int from weekly_digests where user_id not like 'lba-synthetic-%') as foreign_digests,
    (select count(*)::int from power_reports where user_id is null or user_id not like 'lba-synthetic-%' or coalesce(chat_id, '') <> '') as foreign_reports,
    (select count(*)::int from linked_accounts) as linked_accounts,
    (select count(*)::int from sessions) as sessions,
    (select count(*)::int from telegram_subscribers) as subscribers`);
  if (Object.values(provenance.rows[0] || {}).some(value => value !== 0)) {
    throw new Error("LBA_NON_SYNTHETIC_ROWS_REJECTED: use a fresh disposable test database");
  }
  await db.insert(users).values({ id: SYNTHETIC_USER_ID, email: "synthetic@example.invalid",
    firstName: "Тестовий", lastName: "Профіль" }).onConflictDoNothing();
  await db.insert(userSettings).values({ userId: SYNTHETIC_USER_ID, city: "Вінниця", queueId: "1.1",
    street: "Тестова", houseNumber: "12А", lookupMode: "address", hasSeenOnboarding: true,
    notificationsEnabled: false, telegramNotifications: false, themeMode: "elegant" }).onConflictDoNothing();
  const locations = await db.select({ id: userLocations.id }).from(userLocations).where(eq(userLocations.userId, SYNTHETIC_USER_ID));
  if (!locations.length) {
    await db.insert(userLocations).values({ userId: SYNTHETIC_USER_ID, name: "Тестова адреса · синтетичні дані",
      city: "Вінниця", lookupMode: "address", street: "Тестова", houseNumber: "12А", queueId: "1.1",
      isPrimary: true, orderIndex: 0, notifyEnabled: false, telegramNotify: false });
  }
}
