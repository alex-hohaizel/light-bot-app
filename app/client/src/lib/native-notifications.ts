import { isNativePlatform } from './capacitor';

let pushNotificationsModule: typeof import('@capacitor/push-notifications') | null = null;
let localNotificationsModule: typeof import('@capacitor/local-notifications') | null = null;

async function loadPushNotifications() {
  if (!pushNotificationsModule) {
    pushNotificationsModule = await import('@capacitor/push-notifications');
  }
  return pushNotificationsModule.PushNotifications;
}

async function loadLocalNotifications() {
  if (!localNotificationsModule) {
    localNotificationsModule = await import('@capacitor/local-notifications');
  }
  return localNotificationsModule.LocalNotifications;
}

export async function requestNativePushPermission(): Promise<boolean> {
  if (!isNativePlatform()) return false;

  try {
    const PushNotifications = await loadPushNotifications();
    let permStatus = await PushNotifications.checkPermissions();

    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }

    if (permStatus.receive === 'granted') {
      await PushNotifications.register();
      return true;
    }
    return false;
  } catch (e) {
    console.error('[NativeNotif] Push permission error:', e);
    return false;
  }
}

export async function setupNativePushListeners(
  onTokenReceived: (token: string) => void,
  onNotificationReceived?: (notification: any) => void,
  onNotificationAction?: (action: any) => void,
) {
  if (!isNativePlatform()) return;

  try {
    const PushNotifications = await loadPushNotifications();

    await PushNotifications.addListener('registration', (token) => {
      console.log('[NativeNotif] Push token:', token.value);
      onTokenReceived(token.value);
    });

    await PushNotifications.addListener('registrationError', (err) => {
      console.error('[NativeNotif] Registration error:', err.error);
    });

    if (onNotificationReceived) {
      await PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('[NativeNotif] Notification received:', notification);
        onNotificationReceived(notification);
      });
    }

    if (onNotificationAction) {
      await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        console.log('[NativeNotif] Action performed:', action);
        onNotificationAction(action);
      });
    }
  } catch (e) {
    console.error('[NativeNotif] Setup listeners error:', e);
  }
}

export async function scheduleLocalNotification(options: {
  id: number;
  title: string;
  body: string;
  scheduleAt?: Date;
  extra?: Record<string, any>;
}): Promise<void> {
  if (!isNativePlatform()) return;

  try {
    const LocalNotifications = await loadLocalNotifications();

    let permStatus = await LocalNotifications.checkPermissions();
    if (permStatus.display === 'prompt') {
      permStatus = await LocalNotifications.requestPermissions();
    }
    if (permStatus.display !== 'granted') return;

    const notification: any = {
      id: options.id,
      title: options.title,
      body: options.body,
      extra: options.extra || {},
    };

    if (options.scheduleAt) {
      notification.schedule = { at: options.scheduleAt };
    }

    await LocalNotifications.schedule({ notifications: [notification] });
  } catch (e) {
    console.error('[NativeNotif] Schedule local notification error:', e);
  }
}

export async function cancelLocalNotification(id: number): Promise<void> {
  if (!isNativePlatform()) return;

  try {
    const LocalNotifications = await loadLocalNotifications();
    await LocalNotifications.cancel({ notifications: [{ id }] });
  } catch (e) {
    console.error('[NativeNotif] Cancel notification error:', e);
  }
}

export async function cancelAllLocalNotifications(): Promise<void> {
  if (!isNativePlatform()) return;

  try {
    const LocalNotifications = await loadLocalNotifications();
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
  } catch (e) {
    console.error('[NativeNotif] Cancel all error:', e);
  }
}

export async function scheduleOutageNotifications(
  slots: Array<{ start: string; end: string; status: string }>,
  notifyBeforeOff: number,
  notifyBeforeOn: number,
  queueId: string,
  addressLabel: string,
): Promise<void> {
  if (!isNativePlatform()) return;

  try {
    await cancelAllLocalNotifications();

    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
    let notifId = 1000;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const prevSlot = i > 0 ? slots[i - 1] : null;

      const [startH] = slot.start.split(':').map(Number);
      const [endH] = slot.end.split(':').map(Number);

      if (slot.status === 'offline' || slot.status === 'possible') {
        const offTime = new Date(today);
        offTime.setHours(startH, 0, 0, 0);
        const notifyOffAt = new Date(offTime.getTime() - notifyBeforeOff * 60 * 1000);

        if (notifyOffAt > now) {
          await scheduleLocalNotification({
            id: notifId++,
            title: `⚡ Вимкнення через ${notifyBeforeOff} хв`,
            body: `${addressLabel} • Черга ${queueId}\nВимкнення о ${slot.start}`,
            scheduleAt: notifyOffAt,
            extra: { type: 'outage_warning', queueId },
          });
        }
      }

      if ((slot.status === 'online') && prevSlot && (prevSlot.status === 'offline' || prevSlot.status === 'possible')) {
        const onTime = new Date(today);
        onTime.setHours(startH, 0, 0, 0);
        const notifyOnAt = new Date(onTime.getTime() - notifyBeforeOn * 60 * 1000);

        if (notifyOnAt > now) {
          await scheduleLocalNotification({
            id: notifId++,
            title: `💡 Увімкнення через ${notifyBeforeOn} хв`,
            body: `${addressLabel} • Черга ${queueId}\nУвімкнення о ${slot.start}`,
            scheduleAt: notifyOnAt,
            extra: { type: 'power_on_warning', queueId },
          });
        }
      }
    }
  } catch (e) {
    console.error('[NativeNotif] Schedule outage notifications error:', e);
  }
}
