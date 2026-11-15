import type { PlanStatus, AddressRecord, AddressBinding, ScheduleView } from '../../shared/product-contract.ts';
import type { BotContext, AddressOption, BotProfile } from '../../shared/bot/types.ts';
import { reviewPlan } from '../../shared/review-fixtures.ts';

const homes = ['12', '12А', '12/1', '12-1', '12 корпус 1'];
export const REVIEW_ADDRESSES: AddressOption[] = homes.map((house, index) => {
  const address: AddressRecord = { id: `fixture-address-${index}`, label: 'Дім', territoryId: 'fixture-territory',
    locality: 'Тестове місто', street: 'вулиця Нова', aliases: ['вулиця Стара'], house: { number: house, literal: house } };
  const binding: AddressBinding = { addressId: address.id, operatorId: 'fixture-operator', namespace: 'fixture:operator',
    targetId: `house-${index}`, kind: 'building', revisionId: 'fixture-binding-1', status: 'verified',
    verifiedAt: '2026-11-07T06:00:00+02:00', effectiveFrom: null, effectiveUntil: null };
  return { id: `option-${index}`, address, binding, territoryLabel: 'Тестова область' };
});
export function reviewBotContext(ownerId: string, status: PlanStatus = 'published'): BotContext {
  return { actorId: ownerId, now: new Date().toISOString(), addresses: REVIEW_ADDRESSES,
    plans: REVIEW_ADDRESSES.map((option, index): ScheduleView => {
      const plan = reviewPlan(status);
      // Different synthetic buildings deliberately have different plans. Never relabel one plan as another address.
      const mid = index === 1 ? ['15:00', '17:30'] : index === 0 ? ['14:00', '16:00'] : ['16:00', '18:00'];
      return { ...plan, revisionId: `${option.address.id}:${plan.revisionId}`, addressId: option.address.id,
        addressLabel: option.address.label, bindingRevisionId: option.binding.revisionId,
        namespace: option.binding.namespace, targetId: option.binding.targetId,
        intervals: plan.intervals.map((interval, i) => i === 1 ? { ...interval,
          startsAt: `${plan.serviceDate}T${mid[0]}:00+02:00`, endsAt: `${plan.serviceDate}T${mid[1]}:00+02:00`,
          startLocal: mid[0], endLocal: mid[1] } : interval) };
    }),
    manualGroups: [{ id: 'fixture-manual-1', label: '1.1 · тестова група', locality: 'Тестове місто', territoryLabel: 'Тестова область',
      operatorId: 'fixture-operator', namespace: 'fixture:operator', targetId: '1.1', revisionId: 'fixture-group-1' }] };
}
export function reviewProfilePlans(profile: BotProfile): ScheduleView[] {
  return reviewBotContext(profile.id).plans.flatMap(plan => {
    const location = profile.locations.find(item => item.address.id === plan.addressId &&
      item.binding.namespace === plan.namespace && item.binding.targetId === plan.targetId &&
      item.binding.revisionId === plan.bindingRevisionId);
    return location ? [{ ...plan, addressLabel: location.address.label }] : [];
  });
}
export function returningReviewProfile(ownerId: string): BotProfile {
  return { id: ownerId, locations: [{ address: REVIEW_ADDRESSES[1].address, binding: REVIEW_ADDRESSES[1].binding,
    notifications: false, paused: false }], primaryAddressId: REVIEW_ADDRESSES[1].address.id,
    preferences: { optedIn: false, paused: false, reminders: false, remindBeforeMinutes: 30,
      quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'Europe/Kyiv' },
      morningBriefing: { enabled: false, time: '08:00' }, minimumOutageMinutes: 0 } };
}
