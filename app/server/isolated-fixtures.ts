import type { ParsedSchedule } from "./scraper";

export const SYNTHETIC_DATE = "2026-11-07";
export const SYNTHETIC_UPDATED_AT = Date.parse("2026-11-07T08:00:00+02:00");
export const SYNTHETIC_STREET = "Тестова";
export const SYNTHETIC_HOUSE = "12А";
export const SYNTHETIC_CITIES = ["Вінниця", "Київ", "Одеса", "Харків"];

export function syntheticSchedule(city = "Вінниця", queueId = "1.1"): ParsedSchedule & { fixture: object } {
  const slots = [
    { start: "00:00", end: "05:00", status: "online" as const },
    { start: "05:00", end: "07:30", status: "offline" as const },
    { start: "07:30", end: "12:00", status: "online" as const },
    { start: "12:00", end: "13:00", status: "possible" as const },
    { start: "13:00", end: "18:00", status: "online" as const },
    { start: "18:00", end: "20:00", status: "offline" as const },
    { start: "20:00", end: "24:00", status: "online" as const },
  ];
  return { queue: queueId, queueName: `Синтетичний приклад · ${city} · ${queueId}`,
    days: [{ date: SYNTHETIC_DATE, slots }, { date: "2026-11-08", slots: slots.map(slot => ({ ...slot })) }],
    lastUpdated: SYNTHETIC_UPDATED_AT, updateTime: "Синтетичні дані · 07.11.2026 08:00 Europe/Kyiv",
    fixture: { kind: "synthetic", source: "local deterministic fixture; not an ОСР feed", serviceDate: SYNTHETIC_DATE,
      addressVerified: false, liveCoverage: false } };
}
