import { ScheduleData, OutageSlot, DaySchedule } from './store';
import { format } from 'date-fns';

export async function fetchSchedule(queueId: string, city: string = 'Вінниця'): Promise<ScheduleData> {
  const response = await fetch(`/api/schedule/${encodeURIComponent(queueId)}?city=${encodeURIComponent(city)}`);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.details || `HTTP ${response.status}`);
  }

  const data = await response.json();

  return {
    lastUpdated: data.lastUpdated,
    city,
    address: '',
    queue: data.queue,
    queueName: data.queueName,
    days: data.days,
    updateTime: data.updateTime || '',
    gpvStatus: data.gpvStatus || undefined,
    alert: data.alert || undefined,
  };
}

export async function fetchQueues(city: string = 'Вінниця'): Promise<{ id: string; name: string }[]> {
  const response = await fetch(`/api/queues?city=${encodeURIComponent(city)}`);
  if (!response.ok) {
    throw new Error('Failed to fetch queues');
  }
  const data = await response.json();
  return data.queues;
}

export function getCurrentStatus(schedule: ScheduleData | null) {
  if (!schedule || !schedule.days.length) return { isOnline: true, nextChange: null, currentSlot: null, dayIndex: 0, totalDuration: 0, progress: 0 };

  const now = new Date();
  const currentDayStr = format(now, 'yyyy-MM-dd');
  const dayIndex = schedule.days.findIndex(d => d.date === currentDayStr);
  if (dayIndex === -1) return { isOnline: true, nextChange: null, currentSlot: null, dayIndex: 0, totalDuration: 0, progress: 0 };

  const day = schedule.days[dayIndex];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const slotIndex = day.slots.findIndex(slot => {
    const [startH, startM] = slot.start.split(':').map(Number);
    const [endH, endM] = slot.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  });

  if (slotIndex === -1) return { isOnline: true, nextChange: null, currentSlot: null, dayIndex, totalDuration: 0, progress: 0 };

  const currentSlot = day.slots[slotIndex];
  let nextChangeDate: Date | null = null;
  let totalMinutesInSlotChain = 0;
  let elapsedMinutesInSlotChain = 0;

  let startDIdx = dayIndex;
  let startSIdx = slotIndex;
  while (startDIdx >= 0) {
    const d = schedule.days[startDIdx];
    let foundStart = false;
    for (let i = (startDIdx === dayIndex ? slotIndex : d.slots.length - 1); i >= 0; i--) {
      if (d.slots[i].status !== currentSlot.status) {
        startSIdx = i + 1;
        foundStart = true;
        break;
      }
      if (i === 0 && startDIdx > 0) {
      } else if (i === 0) {
        startSIdx = 0;
        foundStart = true;
      }
    }
    if (foundStart) break;
    startDIdx--;
  }

  const calculateChain = (dIdx: number, sIdx: number, status: string): number => {
    if (dIdx >= schedule.days.length) return 0;
    const d = schedule.days[dIdx];
    let duration = 0;

    for (let i = sIdx; i < d.slots.length; i++) {
      const s = d.slots[i];
      if (s.status !== status) {
        const [h, m] = s.start.split(':').map(Number);
        nextChangeDate = new Date(now);
        nextChangeDate.setDate(now.getDate() + (dIdx - dayIndex));
        nextChangeDate.setHours(h, m, 0, 0);
        return duration;
      }
      const [sh, sm] = s.start.split(':').map(Number);
      const [eh, em] = s.end.split(':').map(Number);
      duration += (eh * 60 + em) - (sh * 60 + sm);
    }
    return duration + calculateChain(dIdx + 1, 0, status);
  };

  totalMinutesInSlotChain = calculateChain(startDIdx, startSIdx, currentSlot.status);

  const startDay = schedule.days[startDIdx];
  const [startH, startM] = startDay.slots[startSIdx].start.split(':').map(Number);
  const chainStartAbsoluteMinutes = (startDIdx * 24 * 60) + (startH * 60 + startM);
  const nowAbsoluteMinutes = (dayIndex * 24 * 60) + currentMinutes;
  elapsedMinutesInSlotChain = nowAbsoluteMinutes - chainStartAbsoluteMinutes;

  const progress = Math.min(Math.max(elapsedMinutesInSlotChain / totalMinutesInSlotChain, 0), 1);
  const totalDurationMs = (totalMinutesInSlotChain - elapsedMinutesInSlotChain) * 60 * 1000;

  return {
    isOnline: currentSlot.status === 'online',
    nextChange: nextChangeDate,
    currentSlot,
    dayIndex,
    totalDuration: totalDurationMs,
    progress
  };
}

export function formatTimeRemaining(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const h = hours;
  const m = minutes % 60;

  if (h > 0) {
    return `${h} год. ${m} хв.`;
  }
  return `${m} хв.`;
}
