import { db } from "./db";
import { eq, and, asc } from "drizzle-orm";
import { userLocations, type UserLocation, type InsertUserLocation } from "@shared/models/user-locations";
import { getUserSettings } from "./storage";
import crypto from "crypto";

export async function getUserLocations(userId: string): Promise<UserLocation[]> {
  return db
    .select()
    .from(userLocations)
    .where(eq(userLocations.userId, userId))
    .orderBy(asc(userLocations.orderIndex));
}

export async function getUserLocation(id: number, userId: string): Promise<UserLocation | undefined> {
  const [result] = await db
    .select()
    .from(userLocations)
    .where(and(eq(userLocations.id, id), eq(userLocations.userId, userId)));
  return result;
}

export async function getUserLocationById(id: number): Promise<UserLocation | undefined> {
  const [result] = await db
    .select()
    .from(userLocations)
    .where(eq(userLocations.id, id));
  return result;
}

export async function createUserLocation(data: InsertUserLocation): Promise<UserLocation> {
  const existing = await getUserLocations(data.userId);
  if (existing.length >= 5) {
    throw new Error('Maximum 5 locations allowed');
  }

  if (data.isPrimary) {
    await db
      .update(userLocations)
      .set({ isPrimary: false })
      .where(eq(userLocations.userId, data.userId));
  }

  const orderIndex = existing.length;
  const [result] = await db
    .insert(userLocations)
    .values({ ...data, orderIndex })
    .returning();
  return result;
}

export async function updateUserLocation(
  id: number,
  userId: string,
  data: Partial<InsertUserLocation>
): Promise<UserLocation> {
  if (data.isPrimary) {
    await db
      .update(userLocations)
      .set({ isPrimary: false })
      .where(eq(userLocations.userId, userId));
  }

  const [result] = await db
    .update(userLocations)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(userLocations.id, id), eq(userLocations.userId, userId)))
    .returning();
  return result;
}

export async function deleteUserLocation(id: number, userId: string): Promise<void> {
  const loc = await getUserLocation(id, userId);
  if (!loc) return;

  await db
    .delete(userLocations)
    .where(and(eq(userLocations.id, id), eq(userLocations.userId, userId)));

  if (loc.isPrimary) {
    const remaining = await getUserLocations(userId);
    if (remaining.length > 0) {
      await db
        .update(userLocations)
        .set({ isPrimary: true })
        .where(eq(userLocations.id, remaining[0].id));
    }
  }
}

export async function reorderUserLocations(
  userId: string,
  orderedIds: number[]
): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await db
      .update(userLocations)
      .set({ orderIndex: i, updatedAt: new Date() })
      .where(and(eq(userLocations.id, orderedIds[i]), eq(userLocations.userId, userId)));
  }
}

export async function getPrimaryLocation(userId: string): Promise<UserLocation | undefined> {
  const [result] = await db
    .select()
    .from(userLocations)
    .where(and(eq(userLocations.userId, userId), eq(userLocations.isPrimary, true)));
  return result;
}

export async function updateLocationNotifTracking(
  locationId: number,
  data: { lastNotifKey?: string; lastScheduleHash?: string }
): Promise<void> {
  await db
    .update(userLocations)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(userLocations.id, locationId));
}

export async function migrateBotSubscriberToLocations(
  userId: string,
  chatId: string,
  subscriber: { city?: string; street?: string; houseNumber?: string; queueId?: string; lookupMode?: string; notifyBeforeOff?: number; notifyBeforeOn?: number; enabled?: boolean }
): Promise<boolean> {
  try {
    const existing = await getUserLocations(userId);
    if (existing.length > 0) return false;

    if (!subscriber.queueId && !subscriber.street) return false;

    await db.insert(userLocations).values({
      userId,
      name: "Дім",
      city: subscriber.city || "Вінниця",
      lookupMode: (subscriber.lookupMode as any) || "queue",
      street: subscriber.street || "",
      houseNumber: subscriber.houseNumber || "",
      queueId: subscriber.queueId || "",
      isPrimary: true,
      orderIndex: 0,
      notifyEnabled: true,
      notifyBeforeOff: subscriber.notifyBeforeOff || 30,
      notifyBeforeOn: subscriber.notifyBeforeOn || 15,
      telegramNotify: subscriber.enabled !== false,
    });

    console.log(`[Locations] Migrated bot subscriber ${chatId} to user_locations for user ${userId}`);
    return true;
  } catch (error: any) {
    console.error('[Locations] Bot migration error:', error.message);
    return false;
  }
}

export async function getLocationByShareId(shareId: string): Promise<UserLocation | undefined> {
  const [result] = await db
    .select()
    .from(userLocations)
    .where(eq(userLocations.shareId, shareId));
  return result;
}

export async function generateShareId(id: number, userId: string): Promise<string> {
  const loc = await getUserLocation(id, userId);
  if (!loc) throw new Error('Location not found');
  if (loc.shareId) return loc.shareId;

  const shareId = crypto.randomBytes(12).toString('base64url');
  await db
    .update(userLocations)
    .set({ shareId, updatedAt: new Date() })
    .where(and(eq(userLocations.id, id), eq(userLocations.userId, userId)));
  return shareId;
}

export async function removeShareId(id: number, userId: string): Promise<void> {
  await db
    .update(userLocations)
    .set({ shareId: null, updatedAt: new Date() })
    .where(and(eq(userLocations.id, id), eq(userLocations.userId, userId)));
}

export async function migrateUserSettingsToLocation(userId: string): Promise<boolean> {
  try {
    const existing = await getUserLocations(userId);
    if (existing.length > 0) return false;

    const settings = await getUserSettings(userId);
    if (!settings) return false;

    if (!settings.queueId && !settings.street) return false;

    await db.insert(userLocations).values({
      userId,
      name: "Дім",
      city: settings.city,
      lookupMode: settings.lookupMode,
      street: settings.street || "",
      houseNumber: settings.houseNumber || "",
      queueId: settings.queueId || "",
      isPrimary: true,
      orderIndex: 0,
      notifyEnabled: settings.notificationsEnabled,
      notifyBeforeOff: settings.notifyBeforeOff,
      notifyBeforeOn: settings.notifyBeforeOn,
      telegramNotify: settings.telegramNotifications,
    });

    return true;
  } catch (error: any) {
    console.error('[Locations] Migration error:', error.message);
    return false;
  }
}
