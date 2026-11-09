import type { AddressOption, BotProfile } from './bot/types.ts';
import type { LocationNotificationPolicy } from './notification-policy.ts';
import type { ScheduleView } from './product-contract.ts';

export type ProfilePreferences = BotProfile['preferences'];
export type ProfileMutation =
  | { kind: 'add'; optionId: string; bindingRevisionId: string; selectionFingerprint?: string; label: string; confirmed: true }
  | { kind: 'replace'; addressId: string; optionId: string; bindingRevisionId: string; selectionFingerprint?: string; label: string; confirmed: true }
  | { kind: 'rename'; addressId: string; label: string }
  | { kind: 'delete'; addressId: string; confirmed: true }
  | { kind: 'primary'; addressId: string }
  | { kind: 'move'; addressId: string; direction: 'up' | 'down' }
  | { kind: 'location'; addressId: string; paused?: boolean; notifications?: boolean; notificationPolicy?: LocationNotificationPolicy }
  | { kind: 'preferences'; patch: Partial<ProfilePreferences> };
export interface ProfileRequest { id: string; expectedSessionId: string; expectedRevision: number; mutation: ProfileMutation }
export interface ProfileSnapshot {
  profile: BotProfile;
  revision: number;
  sessionId: string;
  catalog: AddressOption[];
  plans?: ScheduleView[];
  simulationOnly: true;
  receipt?: { id: string; inputId: string; committed: true; sessionRevision: number; simulationOnly: true };
  replayed?: boolean;
}
