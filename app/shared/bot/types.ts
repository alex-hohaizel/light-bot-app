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
import type {AddressOperatorHouseNotice} from '../operator-house-notice.ts';
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
/** Versioned opaque provider keys. Numeric YASNO v1 contracts stay unchanged. */
export interface BotProviderDirectoryV2 {
  id:'dtek:oem';namespace:'dtek:oem';operatorId:'dtek-oem';territoryId:'source:dtek:oem';
  label:string;localitySelection:'required';
}
export interface BotProviderSnapshotV2 {
  kind:'lba-provider-address-snapshot/2';id:string;revisionId:string;namespace:'dtek:oem';
  level:'localities'|'streets'|'houses';catalogSnapshotId:string;cityKey?:string;streetKey?:string;
  observedAt:string;expiresAt:string;items:Array<{key:string;value:string;optionIds?:string[]}>;
  offset:number;hasMore:boolean;catalogCompleteness:'unknown';
}
export interface BotProviderLookupStageV2 {
  state:'available'|'loading'|'disabled'|'unavailable'|'deferred'|'stale';query:string;
  code?:string;retryAt?:string;snapshot?:BotProviderSnapshotV2;
}
export interface BotProviderLookupV2 {
  directoryId:'dtek:oem';localities?:BotProviderLookupStageV2;streets?:BotProviderLookupStageV2;houses?:BotProviderLookupStageV2;
  selectedHouse?:{state:'available'|'stale';catalogSnapshotId:string;houseSnapshotId:string;cityKey:string;streetKey:string;houseKey:string;
    options:AddressOption[];observedAt:string;expiresAt:string;operatorHouseNotice?:AddressOperatorHouseNotice};
}
export type BotStage = 'home' | 'addresses' | 'settings' | 'locality' | 'provider_locality' | 'street' | 'street_choice' |
  'house' | 'connection' | 'address_confirm' | 'subscription' | 'location' | 'rename' |
  'delete_confirm' | 'reminder_time' | 'quiet_hours' | 'briefing_time' | 'minimum_duration' |
  'reminder_off_time' | 'reminder_on_time' | 'push_off_time' | 'push_on_time' |
  'manual_group' | 'reset_confirm' | 'report' | 'menu' | 'tools' | 'account' | 'help' |
  'telegram' | 'push' | 'timing' | 'location_manage' | 'location_order' |
  'location_notifications' | 'location_telegram' | 'location_push' | 'location_tools';
export interface BotProviderDraftV2 {
  directoryId:'dtek:oem';localityQuery?:string;catalogSnapshotId?:string;cityKey?:string;
  streetQuery?:string;streetKey?:string;houseQuery?:string;houseSnapshotId?:string;houseKey?:string;
}
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
  /** Private opaque source selection; never serialized into Telegram wire data. */
  providerV2?:BotProviderDraftV2;
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
  | { kind:'provider_v2_directory'|'provider_v2_city'|'provider_v2_street'|'provider_v2_house'|'provider_v2_group'|'provider_v2_unknown_group'|'provider_v2_page'|'provider_v2_batch'|'provider_v2_retry';value:string }
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
  /** Ephemeral saved/owned lookup reports; public snapshots include saved addresses only. */
  operatorHouseNotices?:AddressOperatorHouseNotice[];
  manualGroups?: ManualGroup[];
  operatorLabels?: Readonly<Record<string,string>>;
  addressCatalogStatus?: 'ready' | 'loading' | 'unavailable';
  providerDirectory?:BotProviderDirectory[];
  providerStreets?:BotProviderStreets;
  providerHouses?:BotProviderHouses;
  providerDirectoriesV2?:BotProviderDirectoryV2[];
  providerLookupV2?:BotProviderLookupV2;
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
