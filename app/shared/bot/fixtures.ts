import type { AddressBinding, AddressRecord, ScheduleView } from '../product-contract.ts';
import { REVIEW_PLAN } from '../review-fixtures.ts';
import type { AddressOption, BotContext, BotProfile } from './types.ts';

function option(id: string, house: string, number: string, extra: Partial<AddressRecord['house']> = {}): AddressOption {
  const address: AddressRecord = { id, label: 'Дім', territoryId: 'fixture-vinnytsia', locality: 'Вінниця',
    street: 'Тестова', house: { literal: house, number, ...extra }, aliases: ['Колишня', 'вулиця Колишня'] };
  const binding: AddressBinding = { addressId: id, operatorId: 'fixture-operator', namespace: 'fixture-vinnytsia',
    targetId: `${id}:connection`, kind: 'connection', revisionId: 'fixture-binding-1', status: 'verified',
    verifiedAt: '2026-11-07T06:00:00+02:00', effectiveFrom: '2026-11-07T00:00:00+02:00', effectiveUntil: null };
  return { id: `${id}:option`, address, binding, territoryLabel: 'Вінницька область · тестовий каталог' };
}
export const DEMO_ADDRESSES: AddressOption[] = [
  option('fixture-address-home', '12А', '12', { letter: 'А' }),
  option('fixture-address-12', '12', '12'),
  option('fixture-address-12-slash-1', '12/1', '12/1'),
  option('fixture-address-12-dash-1', '12-1', '12-1'),
  option('fixture-address-12-building-1', '12 корпус 1', '12', { building: '1' }),
  { ...option('fixture-address-office', '14', '14'), connectionLabel: 'Основний ввід', id: 'fixture-office:main' },
  { ...option('fixture-address-office', '14', '14'), connectionLabel: 'Другий ввід', id: 'fixture-office:second',
    binding: { ...option('fixture-address-office', '14', '14').binding, targetId: 'fixture-office:second' } },
];
export function createDemoProfile(ownerId = 'lba-review-user'): BotProfile {
  return { id: ownerId, locations: [{ address: structuredClone(DEMO_ADDRESSES[0].address), binding: structuredClone(DEMO_ADDRESSES[0].binding), notifications: false, paused: false }],
    primaryAddressId: 'fixture-address-home', preferences: { optedIn: false, paused: false,
      reminders: false, remindBeforeMinutes: 30, quietHours: { enabled: false, start: '22:00', end: '08:00', timezone: 'Europe/Kyiv' },
      morningBriefing: { enabled: false, time: '07:30' }, minimumOutageMinutes: 0 } };
}
export function createDemoContext(actorId = 'lba-review-user', now = '2026-11-07T10:00:00+02:00'): BotContext {
  return { actorId, now, addresses: structuredClone(DEMO_ADDRESSES), plans: [structuredClone(REVIEW_PLAN)] as ScheduleView[],
    manualGroups: [{ id: 'fixture-manual-1', label: '1.1', locality: 'Вінниця', territoryLabel: 'Тестовий приклад',
      operatorId: 'fixture-operator', namespace: 'fixture-vinnytsia', targetId: 'manual-1.1', revisionId: 'fixture-manual-1' }] };
}
