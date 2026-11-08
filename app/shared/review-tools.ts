import type { PlanInterval, PlanStatus, ScheduleView } from './product-contract.ts';
import type { BotLocation, BotProfile } from './bot/types.ts';

/** Local isolated adapters. These flags never grant OAuth, live delivery or public internet access. */
export type ReviewProvider = 'Telegram' | 'Replit';
export type ReviewToolsAction =
  | { kind: 'report'; addressId: string; value: 'on' | 'off' }
  | { kind: 'share'; addressIds: string[]; ttlDays: 1 | 3 | 7 | 14 | 30; serviceDate: string }
  | { kind: 'revoke_share'; token: string }
  | { kind: 'link_account' | 'unlink_account'; provider: ReviewProvider };
export interface ReviewToolsRequest {
  id: string;
  expectedSessionId: string;
  expectedRevision: number;
  action: ReviewToolsAction;
}
export interface ReviewPowerReport {
  addressId: string; label: string; locality: string; namespace: string; targetId: string;
  value: 'on' | 'off'; recordedAt: string;
}
export interface ReviewShareSummary {
  token: string; url: string; serviceDate: string; createdAt: string; expiresAt: string;
  status: 'active' | 'revoked' | 'expired'; labels: string[];
}
export interface ReviewToolsSnapshot {
  simulationOnly: true; sessionId: string; profileRevision: number;
  reports: ReviewPowerReport[];
  digest: { status: 'insufficient'; reason: string; verifiedDays: 0 };
  accounts: Record<ReviewProvider, boolean>;
  shares: ReviewShareSummary[];
  receipt?: { id: string; inputId: string; committed: true; simulationOnly: true; shareToken?: string };
  replayed?: boolean;
}
export interface ReviewPublicPlace {
  label: string; localityLabel: string; serviceDate: string; timezone: 'Europe/Kyiv';
  status: PlanStatus; dayCoverage: ScheduleView['dayCoverage']; freshness: ScheduleView['freshness'];
  intervals: PlanInterval[]; sourceName: string; observedAt: string | null; synthetic: true;
}
export interface ReviewPublicShare {
  simulationOnly: true; token: string; serviceDate: string; createdAt: string; expiresAt: string;
  places: ReviewPublicPlace[];
}

function invalid(): never { throw new Error('INVALID_REVIEW_TOOLS_INPUT'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) return invalid();
  return value.trim();
}
export function validReviewServiceDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validReviewShareToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
}
/** Exact boundary rejects caller-supplied owner, profile, scopes and URLs. */
export function parseReviewToolsRequest(value: unknown): ReviewToolsRequest {
  const request = object(value); keys(request, ['id', 'expectedSessionId', 'expectedRevision', 'action']);
  const id = text(request.id, 96);
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) invalid();
  const expectedSessionId = text(request.expectedSessionId);
  if (typeof request.expectedRevision !== 'number' || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) invalid();
  const expectedRevision = request.expectedRevision as number;
  const raw = object(request.action);
  let action: ReviewToolsAction;
  switch (raw.kind) {
    case 'report': {
      keys(raw, ['kind', 'addressId', 'value']);
      if (raw.value !== 'on' && raw.value !== 'off') invalid();
      action = { kind: 'report', addressId: text(raw.addressId), value: raw.value as 'on' | 'off' }; break;
    }
    case 'share': {
      keys(raw, ['kind', 'addressIds', 'ttlDays', 'serviceDate']);
      if (!Array.isArray(raw.addressIds) || !raw.addressIds.length || raw.addressIds.length > 20) invalid();
      const addressIds = (raw.addressIds as unknown[]).map(value => text(value));
      if (new Set(addressIds).size !== addressIds.length || ![1, 3, 7, 14, 30].includes(raw.ttlDays as number) || !validReviewServiceDate(raw.serviceDate)) invalid();
      action = { kind: 'share', addressIds, ttlDays: raw.ttlDays as 1 | 3 | 7 | 14 | 30, serviceDate: raw.serviceDate as string }; break;
    }
    case 'revoke_share':
      keys(raw, ['kind', 'token']); if (!validReviewShareToken(raw.token)) invalid();
      action = { kind: 'revoke_share', token: raw.token as string }; break;
    case 'link_account': case 'unlink_account':
      keys(raw, ['kind', 'provider']); if (raw.provider !== 'Telegram' && raw.provider !== 'Replit') invalid();
      action = { kind: raw.kind, provider: raw.provider as ReviewProvider }; break;
    default: return invalid();
  }
  return { id, expectedSessionId, expectedRevision, action };
}

/** Whitelist is intentionally smaller than ScheduleView; private identity is never spread. */
export function publicReviewPlace(label: string, localityLabel: string, serviceDate: string, plan?: ScheduleView): ReviewPublicPlace {
  if (!validReviewServiceDate(serviceDate)) return invalid();
  const usable = plan?.serviceDate === serviceDate && plan.synthetic === true;
  return {
    label, localityLabel, serviceDate, timezone: 'Europe/Kyiv',
    status: usable ? plan.status : 'not_published', dayCoverage: usable ? plan.dayCoverage : 'none',
    freshness: usable ? plan.freshness : 'unknown',
    intervals: usable ? plan.intervals.map(i => ({ startsAt: i.startsAt, endsAt: i.endsAt, startLocal: i.startLocal, endLocal: i.endLocal, kind: i.kind })) : [],
    sourceName: usable ? plan.source.name : 'План на цю дату ще не опублікований', observedAt: usable ? plan.observedAt : null, synthetic: true,
  };
}

/** Pinned publications bind to physical/address identity, never mutable presentation or preferences. */
export function reviewShareScopeFingerprint(location: BotLocation): string {
  const a = location.address, b = location.binding;
  return JSON.stringify([a.id, a.territoryId, a.locality, a.street, a.house.number, a.house.letter ?? null,
    a.house.building ?? null, a.house.literal, [...a.aliases].sort(), b.addressId, b.operatorId,
    b.namespace, b.targetId, b.kind, b.revisionId, b.status, b.verifiedAt, b.effectiveFrom, b.effectiveUntil]);
}
/** These IDs must invalidate every older publication permanently in the profile writer's transaction. */
export function invalidatedReviewShareAddressIds(before: BotProfile, after: BotProfile): string[] {
  const current = new Map<string, string | null>();
  for (const location of after.locations) {
    const id = location.address.id;
    current.set(id, current.has(id) ? null : reviewShareScopeFingerprint(location));
  }
  return [...new Set(before.locations.filter(location => current.get(location.address.id) !== reviewShareScopeFingerprint(location))
    .map(location => location.address.id))];
}
