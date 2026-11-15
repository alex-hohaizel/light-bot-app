import type { ScheduleView, PlanStatus } from '@shared/product-contract';
import type { BotLocation } from '@shared/bot/types';
import { REVIEW_PLAN, reviewPlan } from '../../../shared/review-fixtures.ts';
import type { CardVariant } from './schedule-model';

export function cardExample(variant: CardVariant): ScheduleView {
  const base: ScheduleView = { ...REVIEW_PLAN, intervals: REVIEW_PLAN.intervals.map(i => ({ ...i })) };
  if (variant === 'emergency') return reviewPlan('emergency');
  if (variant === 'unknown') return reviewPlan('unavailable');
  if (variant === 'cancelled') return { ...reviewPlan('no_planned_outages'), previousRevisionId: base.revisionId, previousIntervals: base.intervals };
  if (variant === 'changed') return { ...base, previousRevisionId: 'fixture-plan-a', previousIntervals: base.intervals.map((i, index) => index === 0 ? { ...i, endsAt: '2026-11-07T10:30:00+02:00', endLocal: '10:30' } : { ...i }) };
  if (variant === 'moved') return { ...base, previousRevisionId: 'fixture-plan-moved-a', previousIntervals: base.intervals.map((i, index) => index === 1 ? { ...i, startsAt: '2026-11-07T14:00:00+02:00', endsAt: '2026-11-07T16:30:00+02:00', startLocal: '14:00', endLocal: '16:30' } : { ...i }) };
  return base;
}
export const STATUS_OPTIONS: { id: PlanStatus; label: string }[] = [
  { id: 'published', label: 'Опублікований' }, { id: 'no_planned_outages', label: 'Без планових' },
  { id: 'possible', label: 'Можливі' }, { id: 'emergency', label: 'Аварійний' },
  { id: 'not_published', label: 'Очікуємо' }, { id: 'stale', label: 'Застарілий' },
  { id: 'unavailable', label: 'Недоступний' }, { id: 'conflict', label: 'Конфлікт' },
  { id: 'needs_confirmation', label: 'Підтвердити адресу' },
];
export interface DemoAddress {
  id: string; label: string; city: string; street: string; house: string;
  confirmedInDemo: boolean; paused: boolean;
  notifications?: boolean; primary?: boolean; optionId?: string; bindingRevisionId?: string; recordFingerprint?: string;
}
export function addressBindingFingerprint({ address: a, binding: b }: Pick<BotLocation, 'address' | 'binding'>): string {
  return JSON.stringify([a.id, a.territoryId, a.locality, a.street, a.house.number, a.house.letter || null, a.house.building || null,
    a.house.literal, [...a.aliases].sort(), b.addressId, b.operatorId, b.namespace, b.targetId, b.kind, b.revisionId,
    b.status, b.verifiedAt, b.effectiveFrom, b.effectiveUntil]);
}
export const INITIAL_ADDRESSES: DemoAddress[] = [
  { id: 'fixture-address-home', label: 'Дім', city: 'Вінниця', street: 'Тестова', house: '12А', confirmedInDemo: true, paused: false },
  { id: 'fixture-address-work', label: 'Робота', city: 'Київ', street: 'Тестова', house: '12/1', confirmedInDemo: false, paused: false },
];
export const HOUSE_CHOICES = ['12', '12А', '12/1', '12-1', '12 корпус 1'];
export function streetMatches(query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase('uk-UA');
  return normalized.length >= 2 && ['тестова', 'планова'].some(name => name.includes(normalized));
}
export function houseIdentity(house: string): string | null {
  const normalized = house.replace(/\s+/g, '').toLocaleUpperCase('uk-UA');
  return HOUSE_CHOICES.find(candidate => candidate.replace(/\s+/g, '').toLocaleUpperCase('uk-UA') === normalized) || null;
}
