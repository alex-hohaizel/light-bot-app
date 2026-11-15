import { useStore } from './store';
import { getCurrentStatus } from './schedule-service';
import { isNativePlatform } from './capacitor';
import { requestNativePushPermission, scheduleLocalNotification } from './native-notifications';

let lastBrowserNotifKey = '';
let notificationCheckInterval: ReturnType<typeof setInterval> | null = null;

export async function requestNotificationPermission(): Promise<boolean> {
  if (isNativePlatform()) {
    return requestNativePushPermission();
  }
  if (!('Notification' in window)) {
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  const result = await Notification.requestPermission();
  return result === 'granted';
}

export function getNotificationPermission(): string {
  if (isNativePlatform()) return 'granted';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

let nativeNotifCounter = 1;

function sendBrowserNotification(title: string, body: string, tag: string) {
  if (isNativePlatform()) {
    scheduleLocalNotification({
      id: nativeNotifCounter++,
      title,
      body,
      extra: { tag },
    });
    return;
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  try {
    const notification = new Notification(title, {
      body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-192x192.png',
      tag,
      silent: false,
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    setTimeout(() => notification.close(), 30000);
  } catch (e) {
    console.error('[Notifications] Browser notification failed:', e);
  }
}

function formatMinutes(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h} год. ${m} хв.` : `${h} год.`;
  }
  return `${minutes} хв.`;
}

function checkAndNotify() {
  const state = useStore.getState();
  const { schedule, notificationsEnabled, notifyBeforeOff, notifyBeforeOn, queueId } = state;

  if (!schedule || !queueId) return;
  if (!notificationsEnabled) return;

  const status = getCurrentStatus(schedule);
  if (!status.nextChange || status.totalDuration <= 0) return;

  const minutesLeft = Math.floor(status.totalDuration / 60000);
  const isOnline = status.isOnline;
  const changeTime = (status.nextChange as Date).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  const timeStr = formatMinutes(minutesLeft);
  const changeId = (status.nextChange as Date).toISOString();

  const browserThreshold = isOnline ? notifyBeforeOff : notifyBeforeOn;
  if (minutesLeft <= browserThreshold && minutesLeft > 0) {
    const browserKey = `browser-${isOnline ? 'off' : 'on'}-${changeId}-${browserThreshold}`;
    if (browserKey !== lastBrowserNotifKey) {
      lastBrowserNotifKey = browserKey;
      if (isOnline) {
        sendBrowserNotification('⚡ Світло вимкнуть незабаром', `Через ${timeStr} (о ${changeTime}) заплановане вимкнення. Черга ${queueId}.`, 'power-off-warning');
      } else {
        sendBrowserNotification('💡 Світло ввімкнуть незабаром', `Через ${timeStr} (о ${changeTime}) заплановане ввімкнення. Черга ${queueId}.`, 'power-on-warning');
      }
    }
  }
}

export function startNotificationMonitor() {
  if (notificationCheckInterval) return;

  lastBrowserNotifKey = '';
  checkAndNotify();

  notificationCheckInterval = setInterval(checkAndNotify, 30000);
}

export function stopNotificationMonitor() {
  if (notificationCheckInterval) {
    clearInterval(notificationCheckInterval);
    notificationCheckInterval = null;
  }
}

export function resetNotificationState() {
  lastBrowserNotifKey = '';
}
