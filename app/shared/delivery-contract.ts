/** Local test transport boundary. No credential, Telegram destination or HTTP sender exists here. */
export const DELIVERY_VERSION = 'lba-local-delivery/1' as const;
export type DeliveryState = 'pending' | 'leased' | 'dispatching' | 'retry_wait' | 'outcome_unknown' | 'sent' | 'cancelled' | 'failed';
export interface DeliveryEnvelope {
  operationId: string; outboxId: string; ownerId: string; addressId: string; sessionId: string;
  scheduleRevisionId: string; bindingRevisionId: string; payloadDigest: string;
  text: string; simulationOnly: true;
}
export interface DeliveryJob {
  version: typeof DELIVERY_VERSION; envelope: DeliveryEnvelope; state: DeliveryState;
  fence: number; attempts: number; maxAttempts: number; createdAt: string; expiresAt: string;
  nextAttemptAt: string; leaseOwner: string | null; leaseUntil: string | null;
  cancelRequested: boolean; providerReceipt: string | null; lastOutcome: string | null;
}
export interface DeliveryClaim { job: DeliveryJob; workerId: string; fence: number }
export type DeliveryOutcome =
  | { kind: 'sent'; receipt: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'not_sent'; retryable: boolean; reason: string }
  | { kind: 'unknown'; reason: string };
/** Each operation is durable and fenced. begin rechecks current profile + source under its transaction. */
export interface DeliveryRepository {
  claim(workerId: string, now: string, leaseSeconds: number): Promise<DeliveryClaim | null>;
  begin(claim: DeliveryClaim, now: string): Promise<'dispatch' | 'cancelled' | 'lost'>;
  finish(claim: DeliveryClaim, outcome: DeliveryOutcome, now: string): Promise<void>;
}
export interface LocalTestTransport {
  readonly kind: 'local-test-only';
  send(envelope: Readonly<DeliveryEnvelope>, signal: AbortSignal): Promise<DeliveryOutcome>;
}
export interface DeliveryAttemptResult {
  operationId: string | null; result: 'idle' | 'lost' | 'cancelled' | DeliveryOutcome['kind']; simulationOnly: true;
}
