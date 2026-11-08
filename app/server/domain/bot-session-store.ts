import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db';
import { createBotState, handleBotInput } from '../../shared/bot/engine.ts';
import type { BotInput, BotState, BotTurn } from '../../shared/bot/types.ts';
import type { PlanStatus } from '../../shared/product-contract.ts';
import { REVIEW_ADDRESSES, reviewBotContext, reviewProfilePlans, returningReviewProfile } from './review-context.ts';
import type { ProfileRequest, ProfileSnapshot } from '../../shared/profile-mutation.ts';
import { applyProfileMutation } from './profile-service.ts';

async function lock(client: PoolClient, owner: string) {
  if (!owner.startsWith('lba-synthetic-')) throw new Error('SYNTHETIC_OWNER_REQUIRED');
  const marker = await client.query("select marker from public.lba_isolation_marker where singleton=true and kind='synthetic'");
  if (marker.rows[0]?.marker !== 'lba-local-only-v1') throw new Error('SYNTHETIC_MARKER_REQUIRED');
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
}
async function initialize(client: PoolClient, owner: string) {
  const state = createBotState({ ownerId: owner, sessionId: randomUUID() });
  await client.query(`insert into lba_bot_sessions(owner_id,session_id,revision,state)
    values($1,$2,$3,$4::jsonb) on conflict(owner_id) do nothing`, [owner, state.sessionId, state.revision, JSON.stringify(state)]);
}
/** Delivery is an explicitly local durable sink. No Telegram method exists here. */
export async function botSnapshot(owner: string) {
  const client = await pool.connect();
  try {
    await client.query('begin'); await lock(client, owner);
    // Event notifications have their own policy-rechecked publication boundary.
    await client.query("update lba_bot_outbox set status='simulated_delivered' where owner_id=$1 and status='pending' and input_id not like 'event:%'", [owner]);
    const state = await client.query('select state from lba_bot_sessions where owner_id=$1', [owner]);
    const history = await client.query("select payload from lba_bot_outbox where owner_id=$1 and status='simulated_delivered' order by delivery_order", [owner]);
    await client.query('commit');
    return { state: (state.rows[0]?.state || null) as BotState | null, messages: history.rows.map(row => row.payload), simulationOnly: true };
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
export async function resetBotSession(owner: string, returning = false) {
  const client = await pool.connect();
  try {
    await client.query('begin'); await lock(client, owner);
    await client.query('delete from lba_bot_outbox where owner_id=$1', [owner]);
    await client.query('delete from lba_bot_inbox where owner_id=$1', [owner]);
    await client.query('delete from lba_bot_sessions where owner_id=$1', [owner]);
    const state = createBotState({ ownerId: owner, sessionId: randomUUID(),
      ...(returning ? { profile: returningReviewProfile(owner) } : {}) });
    await client.query('insert into lba_bot_sessions(owner_id,session_id,revision,state) values($1,$2,$3,$4::jsonb)',
      [owner, state.sessionId, state.revision, JSON.stringify(state)]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
  return botSnapshot(owner);
}
export async function commitBotInput(owner: string, input: BotInput, status: PlanStatus = 'published') {
  if (input.id.startsWith('app:') || input.id.startsWith('event:')) throw new Error('INVALID_INPUT');
  const client = await pool.connect();
  const digest = createHash('sha256').update(JSON.stringify({ input, status })).digest('hex');
  let committed = false, replayed = false, receipt: Record<string, unknown>;
  try {
    await client.query('begin'); await lock(client, owner); await initialize(client, owner);
    const previous = await client.query('select input_digest,receipt from lba_bot_inbox where owner_id=$1 and input_id=$2', [owner, input.id]);
    if (previous.rowCount) {
      if (previous.rows[0].input_digest !== digest) throw new Error('INPUT_ID_CONFLICT');
      receipt = previous.rows[0].receipt; replayed = true;
    } else {
      const selected = await client.query('select state from lba_bot_sessions where owner_id=$1 for update', [owner]);
      const state = selected.rows[0].state as BotState;
      const context = reviewBotContext(owner, status);
      const turn: BotTurn = handleBotInput(state, input, context);
      await (await import('./review-tools.ts')).invalidateReviewShares(client, owner, state.profile, turn.state.profile);
      await client.query('update lba_bot_sessions set revision=$2,state=$3::jsonb,updated_at=now() where owner_id=$1',
        [owner, turn.state.revision, JSON.stringify(turn.state)]);
      for (const action of turn.actions) {
        if (action.type === 'cancel_pending_delivery') {
          await client.query("update lba_bot_outbox set status='cancelled' where owner_id=$1 and status='pending' and payload->>'kind'='notification' and ($2::text is null or address_id=$2)", [owner, action.addressId || null]);
        }
      }
      for (let i = 0; i < turn.messages.length; i++) {
        const message = turn.messages[i];
        const id = `${state.sessionId}:${input.id}:${i}`;
        const rawSchedule = context.plans.find(plan => plan.revisionId === message.scheduleRevisionId);
        const location = turn.state.profile.locations.find(item => item.address.id === rawSchedule?.addressId);
        const schedule = rawSchedule ? { ...rawSchedule, addressLabel: location?.address.label || rawSchedule.addressLabel } : undefined;
        await client.query(`insert into lba_bot_outbox(id,owner_id,input_id,address_id,revision,ordinal,payload)
          values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [id, owner, input.id, turn.state.currentAddressId,
            turn.state.revision, i, JSON.stringify({ ...message, id, ...(schedule ? { schedule } : {}) })]);
      }
      receipt = { id: randomUUID(), inputId: input.id, committed: true, simulationOnly: true,
        sessionRevision: turn.state.revision, recordedAt: new Date().toISOString(), actions: turn.actions,
        rejected: turn.rejected || null, delivery: 'local_sink_only' };
      await client.query('insert into lba_bot_inbox(owner_id,input_id,input_digest,receipt) values($1,$2,$3,$4::jsonb)',
        [owner, input.id, digest, JSON.stringify(receipt)]);
    }
    await client.query('commit'); committed = true;
  } catch (error) { if (!committed) await client.query('rollback'); throw error; }
  finally { client.release(); }
  // Publish to the local UI only after the transaction durably committed.
  return { ...await botSnapshot(owner), receipt: receipt!, replayed };
}

export async function profileSnapshot(owner: string): Promise<ProfileSnapshot> {
  const client = await pool.connect();
  try {
    await client.query('begin'); await lock(client, owner); await initialize(client, owner);
    const result = await client.query('select state from lba_bot_sessions where owner_id=$1', [owner]);
    const state = result.rows[0].state as BotState;
    await client.query('commit');
    return { profile: state.profile, revision: state.revision, sessionId: state.sessionId, catalog: REVIEW_ADDRESSES,
      plans: reviewProfilePlans(state.profile), simulationOnly: true };
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

/** App and bot serialize on exactly the same owner lock, row and input ledger. */
export async function commitProfileMutation(owner: string, request: ProfileRequest) {
  const client = await pool.connect(), inputId = `app:${request.id}`;
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  let committed = false, replayed = false;
  let receipt: NonNullable<ProfileSnapshot['receipt']>;
  try {
    await client.query('begin'); await lock(client, owner); await initialize(client, owner);
    const previous = await client.query('select input_digest,receipt from lba_bot_inbox where owner_id=$1 and input_id=$2', [owner, inputId]);
    if (previous.rowCount) {
      if (previous.rows[0].input_digest !== digest) throw new Error('INPUT_ID_CONFLICT');
      receipt = previous.rows[0].receipt; replayed = true;
    } else {
      const selected = await client.query('select state from lba_bot_sessions where owner_id=$1 for update', [owner]);
      const previousState=selected.rows[0].state as BotState;
      const result = applyProfileMutation(previousState, request, REVIEW_ADDRESSES);
      await (await import('./review-tools.ts')).invalidateReviewShares(client, owner, previousState.profile, result.state.profile);
      await client.query('update lba_bot_sessions set revision=$2,state=$3::jsonb,updated_at=now() where owner_id=$1',
        [owner, result.state.revision, JSON.stringify(result.state)]);
      for (const addressId of result.cancelledAddresses) {
        await client.query("update lba_bot_outbox set status='cancelled' where owner_id=$1 and status='pending' and payload->>'kind'='notification' and ($2::text is null or address_id=$2)", [owner, addressId]);
      }
      receipt = { id: randomUUID(), inputId, committed: true, sessionRevision: result.state.revision, simulationOnly: true };
      await client.query('insert into lba_bot_inbox(owner_id,input_id,input_digest,receipt) values($1,$2,$3,$4::jsonb)',
        [owner, inputId, digest, JSON.stringify(receipt)]);
    }
    await client.query('commit'); committed = true;
  } catch (error) { if (!committed) await client.query('rollback'); throw error; }
  finally { client.release(); }
  return { ...await profileSnapshot(owner), receipt: receipt!, replayed };
}
