import type { AddressBinding, AddressRecord, ProductPreferences, ScheduleView } from '../product-contract.ts';
import type { LocationNotificationPolicy } from '../notification-policy.ts';

export interface BotLocation {
  address: AddressRecord;
  binding: AddressBinding;
  notifications: boolean;
  paused: boolean;
  notificationPolicy?: LocationNotificationPolicy;
}
export interface BotProfile {
  id: string;
  locations: BotLocation[];
  primaryAddressId: string | null;
  /** Server-managed provenance; never accepted as user authentication. */
  legacyNotificationPolicySourceHash?: string;
  preferences: ProductPreferences & {
    morningBriefing: { enabled: boolean; time: string };
    minimumOutageMinutes: number;
  };
}
export interface AddressOption {
  id: string;
  address: AddressRecord;
  binding: AddressBinding;
  territoryLabel: string;
  connectionLabel?: string;
}
export interface ManualGroup {
  id: string;
  label: string;
  locality: string;
  territoryLabel: string;
  operatorId: string;
  namespace: string;
  targetId: string;
  revisionId: string;
}
/** Optional trusted provider lookup context. These are source directory facts,
 * never an owner claim, a complete address index or a delivery certificate. */
export interface BotProviderDirectory {
  id:string;namespace:string;operatorId:string;localityId:string;locality:string;
  territoryId:string;territoryLabel:string;
}
export type BotProviderLookupState='available'|'loading'|'unavailable'|'deferred'|'stale';
export interface BotProviderStreets {
  directoryId:string;state:BotProviderLookupState;query:string;snapshotId?:string;expiresAt?:string;
  items:Array<{id:number;value:string}>;code?:string;retryAt?:string;
}
export interface BotProviderHouses {
  directoryId:string;state:BotProviderLookupState;query:string;streetId:number;streetValue:string;
  streetSnapshotId:string;houseSnapshotId?:string;expiresAt?:string;
  items:Array<{id:number;value:string;optionId?:string}>;code?:string;retryAt?:string;
}
export type BotStage = 'home' | 'addresses' | 'settings' | 'locality' | 'street' | 'street_choice' |
  'house' | 'connection' | 'address_confirm' | 'subscription' | 'location' | 'rename' |
  'delete_confirm' | 'reminder_time' | 'quiet_hours' | 'briefing_time' | 'minimum_duration' |
  'reminder_off_time' | 'reminder_on_time' | 'push_off_time' | 'push_on_time' |
  'manual_group' | 'reset_confirm' | 'report' | 'menu' | 'tools' | 'account' | 'help' |
  'telegram' | 'push' | 'timing' | 'location_manage' | 'location_order' |
  'location_notifications' | 'location_telegram' | 'location_push' | 'location_tools';
export interface AddressDraft {
  operation: 'add' | 'edit';
  originalAddressId?: string;
  locality?: string;
  territoryId?: string;
  localityId?: string;
  localityQuery?: string;
  street?: string;
  streetIdentity?: string;
  streetQuery?: string;
  house?: string;
  optionId?: string;
  bindingRevision?: string;
  selectionFingerprint?: string;
  providerDirectoryId?:string;
  providerStreetId?:number;
  providerStreetSnapshotId?:string;
  providerHouseSnapshotId?:string;
  label?: string;
  resumeStage: BotStage;
}
export type CallbackAction =
  | { kind: 'command'; value: string }
  | { kind: 'page'; scope: 'addresses' | 'locality' | 'street' | 'manual_group' | 'connection' | 'provider_street' | 'provider_house'; value: number }
  | { kind: 'locality'; value: string }
  | { kind: 'street'; value: string }
  | { kind: 'provider_street'; value: string }
  | { kind: 'provider_house'; value: string }
  | { kind: 'connection'; value: string }
  | { kind: 'house_suggestion'; value: string }
  | { kind: 'place'; value: string }
  | { kind: 'location'; value: string }
  | { kind: 'confirm_address' }
  | { kind: 'subscription'; value: 'on' | 'off' }
  | { kind: 'location_action'; value: 'rename' | 'edit' | 'primary' | 'up' | 'down' | 'pause' | 'notifications' | 'delete' | 'share' | 'report' }
  | { kind: 'confirm_delete' }
  | { kind: 'manual_group'; value: string }
  | { kind: 'confirm_reset' }
  | { kind: 'power_report'; value: 'on' | 'off' };
export interface CallbackRecord {
  ownerId: string;
  stateRevision: number;
  expiresAt: string;
  action: CallbackAction;
  consumed: boolean;
}
export interface BotState {
  schemaVersion: 'lba-bot/1';
  sessionId: string;
  ownerId: string;
  revision: number;
  callbackSequence: number;
  profile: BotProfile;
  stage: BotStage;
  currentAddressId: string | null;
  /** Persisted policy wizard target: null is global; missing keeps older states compatible. */
  policyAddressId?: string | null;
  /** Optional additive navigation state; old lba-bot/1 snapshots remain readable. */
  returnStage?: BotStage;
  addressPage?: number;
  catalogPage?: number;
  draft: AddressDraft | null;
  callbacks: Record<string, CallbackRecord>;
  processedInputIds: string[];
  processedEventIds: string[];
}
export type BotInput =
  | { id: string; kind: 'command'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'callback'; callbackId: string };
export interface BotContext {
  actorId: string;
  /** A trusted adapter supplies the clock, authenticated actor and scoped catalog. */
  now: string;
  addresses: AddressOption[];
  plans: ScheduleView[];
  manualGroups?: ManualGroup[];
  operatorLabels?: Readonly<Record<string,string>>;
  addressCatalogStatus?: 'ready' | 'loading' | 'unavailable';
  providerDirectory?:BotProviderDirectory[];
  providerStreets?:BotProviderStreets;
  providerHouses?:BotProviderHouses;
  maxAddresses?: number;
  callbackTtlSeconds?: number;
  migration?: { status: 'needs_confirmation' | 'in_progress' | 'complete' | 'failed'; detail?: string };
}
export interface BotButton { label: string; callbackId: string }
export interface BotMessage {
  id: string;
  kind: 'reply' | 'schedule' | 'notification' | 'error';
  text: string;
  buttons: BotButton[];
  /** The caller must commit state/profile/outbox atomically before publishing these messages. */
  commitBarrier: 'none' | 'profile';
  scheduleRevisionId?: string;
}
export interface BotAction {
  type: 'persist_profile' | 'cancel_pending_delivery' | 'prepare_share' | 'record_power_report' |
    'resolve_legacy_link' | 'open_app' | 'enqueue_simulated_delivery' | 'defer_delivery';
  idempotencyKey: string;
  addressId?: string;
  value?: string;
  eventId?: string;
  reason?: string;
  simulationOnly: true;
}
export interface BotTurn {
  state: BotState;
  messages: BotMessage[];
  actions: BotAction[];
  requiresCommit: boolean;
  duplicate?: boolean;
  rejected?: 'foreign_actor' | 'invalid_clock' | 'invalid_state' | 'stale_callback' | 'expired_callback' | 'unknown_callback';
}
