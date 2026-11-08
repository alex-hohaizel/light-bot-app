import { createHash, randomUUID } from 'node:crypto';
import type { BotContext, BotMessage, BotState } from '../../shared/bot/types.ts';
import type { ScheduleEvent, ScheduleView } from '../../shared/product-contract.ts';
import { handleScheduleEvent, restoreBotState } from '../../shared/bot/engine.ts';
import { canDeliver, scheduleSemantics, validInstant, validateScheduleView } from '../../shared/schedule-core.ts';
import { reminderDurationEligible, reminderLeadMinutes, resolveNotificationPolicy } from '../../shared/notification-policy.ts';
import { assertIsolatedRuntimeReady } from '../isolated-guard.ts';

const SOURCE_REVISION = '45d77e22e68816e5695aa4b7d2a62bfc57e8176d';
type QueryResult = { rows: any[]; rowCount: number | null };
export interface EventClient {
  query(sql: string, values?: any[]): Promise<QueryResult>;
  release(): void;
}
export interface EventPool { connect(): Promise<EventClient> }
export interface StoredEventMessage extends BotMessage {
  schedule: ScheduleView;
  event: ScheduleEvent;
  semantics: string;
}
export interface EventReceipt {
  id: string;
  inputId: string;
  eventId: string;
  committed: true;
  simulationOnly: true;
  delivery: 'local_sink_only';
  sessionRevision: number;
  outcome: 'notification_committed' | 'ignored';
  reason: 'eligible_transition' | 'semantic_unchanged' | 'revision_mismatch' | 'eligibility_or_policy' | 'reminder_already_committed';
  scheduleRevisionId: string;
  cancelledPending: number;
  supersededPending: number;
}
type Cursor = { kind: 'lba-event-cursor/1'; semantics: string; revisionId: string; eventId: string };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Stable object-key order; limits apply before any database operation. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 24) throw new Error('INVALID_SCHEDULE_EVENT');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as any)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical((value as any)[key], depth + 1)}`).join(',')}}`;
  throw new Error('INVALID_SCHEDULE_EVENT');
}
function checked(owner: string, event: ScheduleEvent, view: ScheduleView, context: BotContext) {
  if (!/^lba-synthetic-[A-Za-z0-9_.:-]{1,100}$/.test(owner)) throw new Error('SYNTHETIC_OWNER_REQUIRED');
  if (!context || context.actorId !== owner) throw new Error('EVENT_ACTOR_MISMATCH');
  if (!validInstant(context.now)) throw new Error('INVALID_EVENT_CLOCK');
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      Object.keys(event).some(key => !['id', 'addressId', 'operatorId', 'serviceDate', 'fromRevisionId', 'toRevisionId', 'kind', 'createdAt', 'reminder'].includes(key)) ||
      typeof event.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(event.id) ||
      !['new_plan', 'changed', 'moved', 'cancelled', 'emergency', 'reminder'].includes(event.kind) ||
      !validInstant(event.createdAt) || Date.parse(event.createdAt) > Date.parse(context.now) ||
      !(event.fromRevisionId === null || typeof event.fromRevisionId === 'string' && event.fromRevisionId.length > 0 && event.fromRevisionId.length <= 256)) throw new Error('INVALID_SCHEDULE_EVENT');
  validateScheduleView(view);
  if (event.addressId !== view.addressId || event.operatorId !== view.operatorId || event.serviceDate !== view.serviceDate || event.toRevisionId !== view.revisionId) throw new Error('EVENT_VIEW_SCOPE_MISMATCH');
  const statusMatches = event.kind === 'cancelled' ? view.status === 'no_planned_outages' : event.kind === 'emergency' ? view.status === 'emergency' :
    ['reminder', 'moved'].includes(event.kind) ? ['published', 'possible'].includes(view.status) : ['published', 'possible', 'no_planned_outages'].includes(view.status);
  if (!statusMatches) throw new Error('EVENT_STATUS_MISMATCH');
  if (event.kind === 'reminder') {
    const reminder = event.reminder;
    if (!reminder || Object.keys(reminder).some(key => !['edge', 'intervalStartsAt', 'intervalEndsAt'].includes(key)) ||
        !['starts', 'ends'].includes(reminder.edge) || !validInstant(reminder.intervalStartsAt) || !validInstant(reminder.intervalEndsAt)) throw new Error('INVALID_SCHEDULE_EVENT');
  } else if (event.reminder !== undefined) throw new Error('INVALID_SCHEDULE_EVENT');
  const value = canonical({ event, view });
  if (Buffer.byteLength(value) > 150_000) throw new Error('EVENT_INPUT_TOO_LARGE');
  return { digest: sha(value), semantics: scheduleSemantics(view), inputId: `event:input:${event.id}` };
}
async function lock(client: EventClient, owner: string) {
  const marker = await client.query('select kind,source_revision,marker from public.lba_isolation_marker where singleton=true');
  if (marker.rows.length !== 1 || marker.rows[0].kind !== 'synthetic' || marker.rows[0].source_revision !== SOURCE_REVISION || marker.rows[0].marker !== 'lba-local-only-v1') throw new Error('SYNTHETIC_MARKER_REQUIRED');
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
}
function stateFrom(value: unknown, owner: string): BotState {
  const state = restoreBotState(value, owner);
  if (state.ownerId !== owner || state.profile.id !== owner) throw new Error('EVENT_PROFILE_MISMATCH');
  return state;
}
function qualified(state: BotState, view: ScheduleView, now: string, ignorePermissions = false) {
  const location = state.profile.locations.find(item => item.address.id === view.addressId);
  if (!location) return false;
  const preferences = ignorePermissions ? { ...state.profile.preferences, optedIn: true, paused: false,
    notificationPolicy: undefined, quietHours: { ...state.profile.preferences.quietHours, enabled: false } } : state.profile.preferences;
  const candidateLocation = ignorePermissions ? { ...location, notifications: true, paused: false, notificationPolicy: undefined } : location;
  try { return resolveNotificationPolicy(preferences, candidateLocation, 'telegram').enabled && canDeliver(view, location.binding, preferences, now); } catch { return false; }
}
function pendingAllowed(state: BotState, payload: StoredEventMessage, now: string) {
  if (!payload?.schedule || !qualified(state, payload.schedule, now)) return false;
  const event = payload.event;
  if (!event || !['new_plan', 'changed', 'moved', 'cancelled', 'emergency', 'reminder'].includes(event.kind) ||
      !validInstant(event.createdAt) || Date.parse(event.createdAt) > Date.parse(now) ||
      event.addressId !== payload.schedule.addressId || event.operatorId !== payload.schedule.operatorId ||
      event.toRevisionId !== payload.schedule.revisionId || event.serviceDate !== payload.schedule.serviceDate) return false;
  if (event.kind !== 'reminder') return true;
  const preferences = state.profile.preferences, reminder = event.reminder;
  const location = state.profile.locations.find(item => item.address.id === payload.schedule.addressId);
  if (!location || !reminder || !['starts', 'ends'].includes(reminder.edge)) return false;
  const lead = reminderLeadMinutes(preferences, location, 'telegram', reminder.edge);
  if (lead < 1) return false;
  return payload.schedule.intervals.some(interval => {
    if (!validInstant(reminder.intervalStartsAt) || !validInstant(reminder.intervalEndsAt) ||
        Date.parse(interval.startsAt) !== Date.parse(reminder.intervalStartsAt) || Date.parse(interval.endsAt) !== Date.parse(reminder.intervalEndsAt)) return false;
    const due = Date.parse(reminder.edge === 'starts' ? interval.startsAt : interval.endsAt) - lead * 60000;
    return Date.parse(now) >= due && Date.parse(now) < due + 60000 &&
      reminderDurationEligible(preferences, reminder.edge, (Date.parse(interval.endsAt) - Date.parse(interval.startsAt)) / 60000);
  });
}
/** Reuse the same admission rule at a later transport boundary. No dispatch occurs here. */
export const canDispatchStoredEvent = pendingAllowed;
export function currentPlanCursorId(state: BotState, view: ScheduleView) {
  return `event:cursor:${sha(canonical({ sessionId: state.sessionId, addressId: view.addressId, operatorId: view.operatorId,
    namespace: view.namespace || null, targetId: view.targetId || null, bindingRevisionId: view.bindingRevisionId || null, serviceDate: view.serviceDate }))}`;
}
async function cancelBlocked(client: EventClient, owner: string, state: BotState, now: string) {
  const pending = await client.query("select id,payload from lba_bot_outbox where owner_id=$1 and status='pending' and payload->>'kind'='notification'", [owner]);
  let count = 0;
  for (const row of pending.rows) {
    if (!pendingAllowed(state, row.payload, now)) {
      const result = await client.query("update lba_bot_outbox set status='cancelled' where id=$1 and owner_id=$2 and status='pending'", [row.id, owner]);
      count += result.rowCount || 0;
    }
  }
  return count;
}
function targetScope(view: ScheduleView) {
  return canonical({ addressId: view.addressId, operatorId: view.operatorId, namespace: view.namespace || null,
    targetId: view.targetId || null, bindingRevisionId: view.bindingRevisionId || null, serviceDate: view.serviceDate });
}
async function cancelSuperseded(client: EventClient, owner: string, view: ScheduleView, semantics: string, allInScope = false) {
  const pending = await client.query("select id,payload from lba_bot_outbox where owner_id=$1 and status='pending' and input_id like 'event:%' and payload->>'kind'='notification'", [owner]);
  let count = 0;
  for (const row of pending.rows) {
    const prior = row.payload?.schedule as ScheduleView | undefined;
    if (!prior || targetScope(prior) !== targetScope(view)) continue;
    let priorSemantics: string;
    try { priorSemantics = scheduleSemantics(prior); } catch { continue; }
    if (allInScope || priorSemantics !== semantics) {
      const result = await client.query("update lba_bot_outbox set status='cancelled' where id=$1 and owner_id=$2 and status='pending'", [row.id, owner]);
      count += result.rowCount || 0;
    }
  }
  return count;
}

/** Dependency injection is for isolated tests; the default boundary always checks the real guard. */
export function createLocalScheduleEventStore(pool: EventPool, assertReady = assertIsolatedRuntimeReady) {
  async function snapshot(owner: string, now: string) {
    assertReady();
    if (!/^lba-synthetic-[A-Za-z0-9_.:-]{1,100}$/.test(owner)) throw new Error('SYNTHETIC_OWNER_REQUIRED');
    if (!validInstant(now)) throw new Error('INVALID_EVENT_CLOCK');
    const client = await pool.connect();
    try {
      await client.query('begin'); await lock(client, owner);
      const selected = await client.query('select state from lba_bot_sessions where owner_id=$1 for update', [owner]);
      if (!selected.rowCount) throw new Error('EVENT_PROFILE_NOT_FOUND');
      const state = stateFrom(selected.rows[0].state, owner);
      await cancelBlocked(client, owner, state, now);
      // The local sink has no network method. Manual replies are left to their own adapter.
      await client.query("update lba_bot_outbox set status='simulated_delivered' where owner_id=$1 and status='pending' and input_id like 'event:%' and payload->>'kind'='notification'", [owner]);
      const messages = await client.query("select payload from lba_bot_outbox where owner_id=$1 and status='simulated_delivered' order by delivery_order", [owner]);
      await client.query('commit');
      return { state, messages: messages.rows.map(row => row.payload), simulationOnly: true as const };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  async function commit(owner: string, event: ScheduleEvent, view: ScheduleView, context: BotContext) {
    assertReady();
    const input = checked(owner, event, view, context), client = await pool.connect();
    let receipt: EventReceipt, replayed = false;
    try {
      await client.query('begin'); await lock(client, owner);
      const previous = await client.query('select input_digest,receipt from lba_bot_inbox where owner_id=$1 and input_id=$2', [owner, input.inputId]);
      if (previous.rowCount) {
        if (previous.rows[0].input_digest !== input.digest) throw new Error('EVENT_ID_CONFLICT');
        receipt = previous.rows[0].receipt; replayed = true;
      } else {
        const selected = await client.query('select state from lba_bot_sessions where owner_id=$1 for update', [owner]);
        if (!selected.rowCount) throw new Error('EVENT_PROFILE_NOT_FOUND');
        const state = stateFrom(selected.rows[0].state, owner);
        let cancelledPending = await cancelBlocked(client, owner, state, context.now);
        const scope = sha(canonical({ sessionId: state.sessionId, addressId: view.addressId, operatorId: view.operatorId,
          namespace: view.namespace || null, targetId: view.targetId || null, bindingRevisionId: view.bindingRevisionId || null, serviceDate: view.serviceDate }));
        const cursorId = event.kind === 'reminder' ? `event:reminder:${sha(canonical({ scope, edge: event.reminder!.edge,
          startsAt: Date.parse(event.reminder!.intervalStartsAt), endsAt: Date.parse(event.reminder!.intervalEndsAt) }))}` : `event:cursor:${scope}`;
        const cursorRows = await client.query('select receipt from lba_bot_inbox where owner_id=$1 and input_id=$2', [owner, cursorId]);
        const cursor = cursorRows.rows[0]?.receipt as Cursor | undefined;
        let reason: EventReceipt['reason'] = 'eligibility_or_policy';
        let turn = { state, messages: [] as BotMessage[], actions: [] as ReturnType<typeof handleScheduleEvent>['actions'] };
        const baselineEligible = qualified(state, view, context.now, true);
        const lineageMismatch = event.kind !== 'reminder' && cursor && event.fromRevisionId !== cursor.revisionId;
        const supersededPending = baselineEligible && !lineageMismatch && event.kind !== 'reminder'
          ? await cancelSuperseded(client, owner, view, input.semantics) : 0;
        cancelledPending += supersededPending;
        if (event.kind === 'reminder' && cursor) reason = 'reminder_already_committed';
        else if (lineageMismatch) reason = 'revision_mismatch';
        else if (event.kind !== 'reminder' && cursor?.semantics === input.semantics) reason = 'semantic_unchanged';
        else {
          turn = handleScheduleEvent(state, event, view, context);
          if (turn.messages.length) reason = 'eligible_transition';
        }
        for (const action of turn.actions) if (action.type === 'cancel_pending_delivery') {
          cancelledPending += await cancelSuperseded(client, owner, view, input.semantics, true);
        }
        if (turn.messages.length) {
          await client.query('update lba_bot_sessions set revision=$2,state=$3::jsonb,updated_at=now() where owner_id=$1', [owner, turn.state.revision, JSON.stringify(turn.state)]);
          const label = turn.state.profile.locations.find(item => item.address.id === view.addressId)!.address.label;
          const displayView = { ...structuredClone(view), addressLabel: label };
          for (let index = 0; index < turn.messages.length; index++) {
            const id = `${state.sessionId}:${input.inputId}:${index}`;
            const payload: StoredEventMessage = { ...turn.messages[index], id, schedule: displayView, event: structuredClone(event), semantics: input.semantics };
            await client.query(`insert into lba_bot_outbox(id,owner_id,input_id,address_id,revision,ordinal,payload)
              values($1,$2,$3,$4,$5,$6,$7::jsonb)`, [id, owner, input.inputId, view.addressId, turn.state.revision, index, JSON.stringify(payload)]);
          }
        }
        // Uncertified views cannot establish a trusted semantic baseline. Opt-out
        // observations can, so a later resume does not send a historical backlog.
        if (baselineEligible && !lineageMismatch && (event.kind !== 'reminder' || turn.messages.length)) {
          const nextCursor: Cursor = { kind: 'lba-event-cursor/1', semantics: input.semantics, revisionId: view.revisionId, eventId: event.id };
          await client.query(`insert into lba_bot_inbox(owner_id,input_id,input_digest,receipt) values($1,$2,$3,$4::jsonb)
            on conflict(owner_id,input_id) do update set input_digest=excluded.input_digest,receipt=excluded.receipt`, [owner, cursorId, sha(input.semantics), JSON.stringify(nextCursor)]);
        }
        receipt = { id: randomUUID(), inputId: input.inputId, eventId: event.id, committed: true, simulationOnly: true,
          delivery: 'local_sink_only', sessionRevision: turn.state.revision, outcome: turn.messages.length ? 'notification_committed' : 'ignored',
          reason, scheduleRevisionId: view.revisionId, cancelledPending, supersededPending };
        await client.query('insert into lba_bot_inbox(owner_id,input_id,input_digest,receipt) values($1,$2,$3,$4::jsonb)', [owner, input.inputId, input.digest, JSON.stringify(receipt)]);
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
    return { ...await snapshot(owner, context.now), receipt: receipt!, replayed };
  }
  return { commit, snapshot };
}

/** Server-only intake. No route accepts a user-supplied trusted event or context. */
export async function commitScheduleEvent(owner: string, event: ScheduleEvent, view: ScheduleView, trustedContext: BotContext) {
  assertIsolatedRuntimeReady();
  const { pool } = await import('../db');
  return createLocalScheduleEventStore(pool).commit(owner, event, view, trustedContext);
}
