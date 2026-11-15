import { db } from "./db";
import { eq, and } from "drizzle-orm";
import { userSettings, type UserSettings, type InsertUserSettings } from "@shared/models/user-settings";
import { telegramSubscribers, type TelegramSubscriber, type InsertTelegramSubscriber } from "@shared/models/telegram-subscribers";
import { linkedAccounts, type LinkedAccount, type InsertLinkedAccount } from "@shared/models/linked-accounts";

export async function getUserSettings(userId: string): Promise<UserSettings | undefined> {
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return settings || undefined;
}

export async function upsertUserSettings(userId: string, data: Partial<InsertUserSettings>): Promise<UserSettings> {
  const [result] = await db
    .insert(userSettings)
    .values({ userId, ...data })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...data, updatedAt: new Date() },
    })
    .returning();
  return result;
}

export async function getSubscriber(chatId: string): Promise<TelegramSubscriber | undefined> {
  const [sub] = await db.select().from(telegramSubscribers).where(eq(telegramSubscribers.chatId, chatId));
  return sub || undefined;
}

export async function upsertSubscriber(chatId: string, data: Partial<InsertTelegramSubscriber>): Promise<TelegramSubscriber> {
  const [result] = await db
    .insert(telegramSubscribers)
    .values({ chatId, ...data })
    .onConflictDoUpdate({
      target: telegramSubscribers.chatId,
      set: { ...data, updatedAt: new Date() },
    })
    .returning();
  return result;
}

export async function getAllSubscribers(): Promise<TelegramSubscriber[]> {
  return db.select().from(telegramSubscribers);
}

export async function deleteSubscriber(chatId: string): Promise<void> {
  await db.delete(telegramSubscribers).where(eq(telegramSubscribers.chatId, chatId));
}

export async function getSubscriberByUserId(userId: string): Promise<TelegramSubscriber | undefined> {
  const [sub] = await db.select().from(telegramSubscribers).where(eq(telegramSubscribers.userId, userId));
  return sub || undefined;
}

export async function getUserSettingsByTelegramChatId(chatId: string): Promise<UserSettings | undefined> {
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.telegramChatId, chatId));
  return settings || undefined;
}

export async function getLinkedAccountsByUserId(userId: string): Promise<LinkedAccount[]> {
  return db.select().from(linkedAccounts).where(eq(linkedAccounts.userId, userId));
}

export async function getLinkedAccountByProvider(provider: string, providerId: string): Promise<LinkedAccount | undefined> {
  const [account] = await db
    .select()
    .from(linkedAccounts)
    .where(and(eq(linkedAccounts.provider, provider), eq(linkedAccounts.providerId, providerId)));
  return account || undefined;
}

export async function addLinkedAccount(userId: string, provider: string, providerId: string, displayName?: string): Promise<LinkedAccount> {
  const [result] = await db
    .insert(linkedAccounts)
    .values({ userId, provider, providerId, displayName })
    .onConflictDoUpdate({
      target: [linkedAccounts.provider, linkedAccounts.providerId],
      set: { userId, displayName },
    })
    .returning();
  return result;
}

export async function removeLinkedAccount(userId: string, provider: string, providerId: string): Promise<void> {
  await db
    .delete(linkedAccounts)
    .where(and(
      eq(linkedAccounts.userId, userId),
      eq(linkedAccounts.provider, provider),
      eq(linkedAccounts.providerId, providerId)
    ));
}

export async function migrateUserSettings(fromUserId: string, toUserId: string): Promise<void> {
  const fromSettings = await getUserSettings(fromUserId);
  if (!fromSettings) return;

  const toSettings = await getUserSettings(toUserId);
  if (toSettings) return;

  const { userId: _, ...settingsData } = fromSettings;
  await upsertUserSettings(toUserId, settingsData);
}
