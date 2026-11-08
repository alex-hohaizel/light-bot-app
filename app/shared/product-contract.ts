/** LBA parent contract v1. One owner: light-bot-app-recovery. No provider credentials. */
import type { NotificationPolicy } from './notification-policy.ts';
export const PRODUCT_CONTRACT_VERSION = 'lba-product/1' as const;
export type PlanStatus = 'published' | 'no_planned_outages' | 'possible' | 'emergency' |
  'not_published' | 'stale' | 'unavailable' | 'conflict' | 'needs_confirmation';
export type VerificationLevel = 'catalog' | 'schedule' | 'address' | 'integration';
export type AddressId = string;
export interface AddressRecord {
  id: AddressId;
  label: string;
  territoryId: string;
  locality: string;
  street: string;
  house: { number: string; letter?: string; building?: string; literal: string };
  aliases: string[];
}
export interface AddressBinding {
  addressId: AddressId;
  operatorId: string;
  namespace: string;
  targetId: string;
  kind: 'building' | 'connection' | 'operator_group' | 'user_selected_group';
  revisionId: string;
  status: 'verified' | 'needs_confirmation' | 'ambiguous' | 'stale';
  verifiedAt: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}
export interface PlanInterval {
  /** ISO instants with explicit offset: ambiguous local times must remain distinct. */
  startsAt: string;
  endsAt: string;
  startLocal: string;
  endLocal: string;
  kind: 'planned_outage' | 'possible_outage';
}
export interface SourceReference {
  id: string;
  name: string;
  url: string | null;
  revision: string;
  accessCost: 0;
  verifiedLevel: VerificationLevel;
}
export interface ScheduleView {
  contractVersion: typeof PRODUCT_CONTRACT_VERSION;
  revisionId: string;
  addressId: AddressId;
  addressLabel: string;
  localityLabel: string;
  operatorId: string;
  serviceDate: string;
  /** Required before personal delivery; absent from non-certified previews. */
  bindingRevisionId?: string;
  namespace?: string;
  targetId?: string;
  timezone: 'Europe/Kyiv';
  status: PlanStatus;
  dayCoverage: 'complete' | 'partial' | 'none';
  intervals: PlanInterval[];
  source: SourceReference;
  publishedAt: string | null;
  observedAt: string;
  freshness: 'current' | 'stale' | 'unknown';
  synthetic: boolean;
  deliveryEligible: boolean;
  /** A comparison always refers to the same target and local service day. */
  previousRevisionId?: string;
  previousIntervals?: PlanInterval[];
  notice?: string;
}
export type NotificationKind = 'new_plan' | 'changed' | 'moved' | 'cancelled' | 'emergency' | 'reminder';
export interface ScheduleEvent {
  id: string;
  addressId: AddressId;
  operatorId: string;
  serviceDate: string;
  fromRevisionId: string | null;
  toRevisionId: string;
  kind: NotificationKind;
  createdAt: string;
  reminder?: { edge: 'starts' | 'ends'; intervalStartsAt: string; intervalEndsAt: string };
}
export interface ProductPreferences {
  optedIn: boolean;
  paused: boolean;
  reminders: boolean;
  remindBeforeMinutes: number;
  quietHours: { enabled: boolean; start: string; end: string; timezone: 'Europe/Kyiv' };
  notificationPolicy?: NotificationPolicy;
}
export interface CoverageRecord {
  id: string;
  territoryLabel: string;
  operatorLabel: string;
  status: 'candidate' | 'blocked' | 'schedule_verified' | 'address_verified' | 'integration_accepted';
  schedule: 'verified' | 'unverified' | 'stale' | 'unavailable';
  address: 'verified' | 'unverified' | 'blocked';
  primaryCost: 0 | null;
  fallbackCost: 0 | null;
  checkedAt: string | null;
  reason: string;
}
export const PLAN_STATUS_COPY: Record<PlanStatus, { title: string; detail: string }> = {
  published: { title: 'Опублікований план', detail: 'Інтервали за планом оператора. Це не вимір фактичного живлення.' },
  no_planned_outages: { title: 'Планових відключень немає', detail: 'Оператор явно повідомив про відсутність планових відключень у цьому обсязі.' },
  possible: { title: 'Можливі відключення', detail: 'Оператор позначив інтервали, які ще не є визначеним планом.' },
  emergency: { title: 'Аварійний режим', detail: 'Погодинний план може не діяти. Орієнтуйтеся на повідомлення оператора.' },
  not_published: { title: 'Очікуємо план', detail: 'План на цю дату ще не опублікований.' },
  stale: { title: 'Дані застаріли', detail: 'Нижче останній відомий план. Автоматичні сповіщення призупинені.' },
  unavailable: { title: 'Джерело недоступне', detail: 'Зараз не вдалося перевірити план. Це не означає відсутність відключень.' },
  conflict: { title: 'Дані суперечать одне одному', detail: 'Потрібна звірка з оператором. Персональні сповіщення призупинені.' },
  needs_confirmation: { title: 'Потрібно підтвердити адресу', detail: 'Профіль збережено. Персональний план потребує точної прив’язки будинку.' },
};
