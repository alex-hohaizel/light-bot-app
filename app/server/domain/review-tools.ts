import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { BotProfile, BotState } from '../../shared/bot/types.ts';
import { createBotState } from '../../shared/bot/engine.ts';
import type { ReviewPublicShare, ReviewToolsRequest, ReviewToolsSnapshot, ReviewShareSummary, ReviewPowerReport } from '../../shared/review-tools.ts';
import { invalidatedReviewShareAddressIds, publicReviewPlace, reviewShareScopeFingerprint, validReviewShareToken } from '../../shared/review-tools.ts';
import { SYNTHETIC_USER_ID, assertIsolatedRuntimeReady } from '../isolated-guard.ts';
import { reviewProfilePlans } from './review-context.ts';

export class ReviewToolsError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) { super(message); this.code = code; this.status = status; }
}
const fail = (code: string, status: number, message: string): never => { throw new ReviewToolsError(code, status, message); };

/** DDL is lazy and reachable only after the actual process guard and database marker checks. */
async function ensureTables(client: PoolClient) {
  await client.query(`create table if not exists lba_review_tools_accounts(
    owner_id text not null, session_id text not null,
    accounts jsonb not null, primary key(owner_id,session_id))`);
  await client.query(`create table if not exists lba_review_tools_reports(
    owner_id text not null, session_id text not null, address_id text not null,
    locality text not null, namespace text not null, target_id text not null,
    value text not null check(value in ('on','off')), recorded_at timestamptz not null,
    primary key(owner_id,session_id,address_id))`);
  await client.query(`create table if not exists lba_review_tools_shares(
    token text primary key, owner_id text not null, session_id text not null,
    service_date text not null, created_at timestamptz not null, expires_at timestamptz not null,
    revoked boolean not null default false, private_scope jsonb not null, snapshot jsonb not null)`);
  await client.query(`create table if not exists lba_review_tools_inbox(
    owner_id text not null, session_id text not null, input_id text not null,
    input_digest text not null, receipt jsonb not null,
    primary key(owner_id,session_id,input_id))`);
}
async function withOwner<T>(owner: string, operation: (client: PoolClient, state: BotState) => Promise<T>): Promise<T> {
  assertIsolatedRuntimeReady();
  if (owner !== SYNTHETIC_USER_ID) fail('SYNTHETIC_OWNER_REQUIRED', 403, 'Доступний лише локальний тестовий профіль.');
  // Dynamic import prevents inspecting this module or registering its routes from opening a pool.
  const { pool } = await import('../db');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const marker = await client.query("select marker from public.lba_isolation_marker where singleton=true and kind='synthetic'");
    if (marker.rows[0]?.marker !== 'lba-local-only-v1') throw new Error('SYNTHETIC_MARKER_REQUIRED');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
    await ensureTables(client);
    const initial = createBotState({ ownerId: owner, sessionId: randomUUID() });
    await client.query(`insert into lba_bot_sessions(owner_id,session_id,revision,state)
      values($1,$2,$3,$4::jsonb) on conflict(owner_id) do nothing`, [owner, initial.sessionId, initial.revision, JSON.stringify(initial)]);
    const selected = await client.query('select state from lba_bot_sessions where owner_id=$1 for update', [owner]);
    const state = selected.rows[0].state as BotState;
    if (state.ownerId !== owner || state.profile.id !== owner) throw new Error('SYNTHETIC_PROFILE_SCOPE_MISMATCH');
    await client.query(`insert into lba_review_tools_accounts(owner_id,session_id,accounts)
      values($1,$2,$3::jsonb) on conflict(owner_id,session_id) do nothing`, [owner, state.sessionId, JSON.stringify({ Telegram: true, Replit: true })]);
    const result = await operation(client, state);
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
function iso(value: unknown): string { return new Date(value as string).toISOString(); }
function shareScopeCurrent(row: Record<string, any>, state: BotState): boolean {
  if (!Array.isArray(row.private_scope) || !row.private_scope.length) return false;
  return row.private_scope.every((scope: Record<string, unknown>) => scope && typeof scope === 'object' && !Array.isArray(scope) && state.profile.locations.some(location =>
    location.address.id === scope.addressId && location.binding.namespace === scope.namespace &&
    location.binding.targetId === scope.targetId && location.binding.revisionId === scope.bindingRevisionId &&
    typeof scope.fingerprint === 'string' && reviewShareScopeFingerprint(location) === scope.fingerprint));
}
function shareSummary(row: Record<string, any>, state: BotState, now: number): ReviewShareSummary {
  return { token: row.token, url: '/local-share/' + row.token, serviceDate: row.service_date,
    createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    status: row.revoked || !shareScopeCurrent(row, state) ? 'revoked' : Date.parse(iso(row.expires_at)) <= now ? 'expired' : 'active',
    labels: (row.snapshot as ReviewPublicShare).places.map(place => place.label) };
}
async function snapshot(client: PoolClient, state: BotState): Promise<ReviewToolsSnapshot> {
  const owner = state.ownerId, session = state.sessionId;
  const accounts = await client.query('select accounts from lba_review_tools_accounts where owner_id=$1 and session_id=$2', [owner, session]);
  const reports = await client.query('select * from lba_review_tools_reports where owner_id=$1 and session_id=$2 order by recorded_at desc,address_id', [owner, session]);
  const shares = await client.query('select * from lba_review_tools_shares where owner_id=$1 and session_id=$2 order by created_at desc,token', [owner, session]);
  const visible: ReviewPowerReport[] = reports.rows.flatMap(row => {
    const location = state.profile.locations.find(item => item.address.id === row.address_id && item.address.locality === row.locality &&
      item.binding.namespace === row.namespace && item.binding.targetId === row.target_id);
    return location ? [{ addressId: row.address_id, label: location.address.label, locality: row.locality, namespace: row.namespace,
      targetId: row.target_id, value: row.value as 'on' | 'off', recordedAt: iso(row.recorded_at) }] : [];
  });
  return { simulationOnly: true, sessionId: session, profileRevision: state.revision, reports: visible,
    digest: { status: 'insufficient', reason: 'Підтвердженої історії за тиждень ще немає. Тестові плани та власні позначки не видаються за фактичну історію відключень.', verifiedDays: 0 },
    accounts: accounts.rows[0].accounts, shares: shares.rows.map(row => shareSummary(row, state, Date.now())) };
}
export async function reviewToolsSnapshot(owner: string): Promise<ReviewToolsSnapshot> {
  return withOwner(owner, (client, state) => snapshot(client, state));
}
export async function commitReviewTools(owner: string, request: ReviewToolsRequest): Promise<ReviewToolsSnapshot> {
  return withOwner(owner, async (client, state) => {
    if (request.expectedSessionId !== state.sessionId) fail('TOOLS_SESSION_CONFLICT', 409, 'Тестовий сеанс змінився. Оновіть профіль і відкрийте дію ще раз.');
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = await client.query('select input_digest,receipt from lba_review_tools_inbox where owner_id=$1 and session_id=$2 and input_id=$3', [owner, state.sessionId, request.id]);
    if (previous.rowCount) {
      if (previous.rows[0].input_digest !== digest) fail('TOOLS_INPUT_ID_CONFLICT', 409, 'Цей ID уже належить іншій дії.');
      return { ...await snapshot(client, state), receipt: previous.rows[0].receipt, replayed: true };
    }
    if (request.expectedRevision !== state.revision) fail('TOOLS_PROFILE_CONFLICT', 409, 'Профіль змінився в іншому вікні або боті. Перевірте актуальну адресу й повторіть дію.');
    const action = request.action;
    const savedLocation = (id: string) => {
      const found = state.profile.locations.find(item => item.address.id === id);
      return found || fail('TOOLS_ADDRESS_NOT_FOUND', 422, 'Цієї адреси вже немає у збережених.');
    };
    const receipt: NonNullable<ReviewToolsSnapshot['receipt']> = { id: randomUUID(), inputId: request.id, committed: true, simulationOnly: true };
    if (action.kind === 'report') {
      const location = savedLocation(action.addressId);
      await client.query(`insert into lba_review_tools_reports(owner_id,session_id,address_id,locality,namespace,target_id,value,recorded_at)
        values($1,$2,$3,$4,$5,$6,$7,now()) on conflict(owner_id,session_id,address_id)
        do update set locality=excluded.locality,namespace=excluded.namespace,target_id=excluded.target_id,value=excluded.value,recorded_at=excluded.recorded_at`,
      [owner, state.sessionId, location.address.id, location.address.locality, location.binding.namespace, location.binding.targetId, action.value]);
    } else if (action.kind === 'share') {
      const locations = action.addressIds.map(savedLocation), plans = reviewProfilePlans(state.profile);
      const privateScope = locations.map(location => ({ addressId: location.address.id, namespace: location.binding.namespace, targetId: location.binding.targetId, bindingRevisionId: location.binding.revisionId, fingerprint: reviewShareScopeFingerprint(location) }));
      const token = randomBytes(24).toString('hex'), createdAt = new Date().toISOString(), expiresAt = new Date(Date.parse(createdAt) + action.ttlDays * 86400000).toISOString();
      const value: ReviewPublicShare = { simulationOnly: true, token, serviceDate: action.serviceDate, createdAt, expiresAt,
        places: locations.map(location => publicReviewPlace(location.address.label, location.address.locality, action.serviceDate,
          plans.find(plan => plan.addressId === location.address.id && plan.serviceDate === action.serviceDate))) };
      await client.query(`insert into lba_review_tools_shares(token,owner_id,session_id,service_date,created_at,expires_at,private_scope,snapshot)
        values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [token, owner, state.sessionId, action.serviceDate, createdAt, expiresAt, JSON.stringify(privateScope), JSON.stringify(value)]);
      receipt.shareToken = token;
    } else if (action.kind === 'revoke_share') {
      const result = await client.query('update lba_review_tools_shares set revoked=true where token=$1 and owner_id=$2 and session_id=$3 returning token', [action.token, owner, state.sessionId]);
      if (!result.rowCount) fail('TOOLS_SHARE_NOT_FOUND', 404, 'Демо-посилання не знайдено у цьому сеансі.');
    } else {
      const accounts = await client.query('select accounts from lba_review_tools_accounts where owner_id=$1 and session_id=$2', [owner, state.sessionId]);
      const value = accounts.rows[0].accounts as Record<'Telegram' | 'Replit', boolean>;
      if (action.kind === 'unlink_account' && value[action.provider] && Object.values(value).filter(Boolean).length <= 1) fail('TOOLS_LAST_ACCOUNT', 422, 'Залиште хоча б один тестовий спосіб входу.');
      value[action.provider] = action.kind === 'link_account';
      await client.query('update lba_review_tools_accounts set accounts=$3::jsonb where owner_id=$1 and session_id=$2', [owner, state.sessionId, JSON.stringify(value)]);
    }
    await client.query('insert into lba_review_tools_inbox(owner_id,session_id,input_id,input_digest,receipt) values($1,$2,$3,$4,$5::jsonb)',
      [owner, state.sessionId, request.id, digest, JSON.stringify(receipt)]);
    return { ...await snapshot(client, state), receipt, replayed: false };
  });
}
export async function readReviewPublicShare(token: string): Promise<ReviewPublicShare> {
  if (!validReviewShareToken(token)) fail('TOOLS_SHARE_NOT_FOUND', 404, 'Демо-посилання не знайдено.');
  return withOwner(SYNTHETIC_USER_ID, async (client, state) => {
    const result = await client.query('select * from lba_review_tools_shares where token=$1', [token]);
    const row = result.rows[0];
    if (!row) fail('TOOLS_SHARE_NOT_FOUND', 404, 'Демо-посилання не знайдено.');
    if (row.owner_id !== state.ownerId || row.session_id !== state.sessionId || row.revoked || !shareScopeCurrent(row, state) || Date.parse(iso(row.expires_at)) <= Date.now())
      fail('TOOLS_SHARE_GONE', 410, 'Термін демо-посилання минув або доступ відкликано. Попросіть нове посилання.');
    return row.snapshot as ReviewPublicShare;
  });
}

/**
 * Caller holds the same synthetic owner's advisory lock and transaction as its profile write.
 * This update is monotonic: restoring a deleted address can never un-revoke an older token.
 * No DDL/pool is used, and the tools feature need not have been opened yet.
 */
export async function invalidateReviewShares(client: PoolClient, owner: string, before: BotProfile, after: BotProfile): Promise<void> {
  assertIsolatedRuntimeReady();
  if (owner !== SYNTHETIC_USER_ID || before.id !== owner || after.id !== owner)
    fail('SYNTHETIC_OWNER_REQUIRED', 403, 'Доступний лише локальний тестовий профіль.');
  const affected = invalidatedReviewShareAddressIds(before, after);
  if (!affected.length) return;
  const table = await client.query("select to_regclass('public.lba_review_tools_shares')::text as relation");
  if (!table.rows[0]?.relation) return;
  await client.query(`update public.lba_review_tools_shares set revoked=true
    where owner_id=$1 and revoked=false and exists(
      select 1 from jsonb_array_elements(private_scope) as participant(value)
      where participant.value->>'addressId'=any($2::text[]))`, [owner, affected]);
}
