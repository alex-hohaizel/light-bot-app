import type { DeliveryOutcome, DeliveryState } from '../../shared/delivery-contract.ts';
import { UPDATE_CAMPAIGN_VERSION, campaignBinding, campaignFail, campaignId, campaignInstant, campaignOperationId, campaignSpecHash,
  checkedCampaignOutcome, prepareCampaignSpec, validDeploymentHealth,
  type CampaignClaim, type CampaignJob, type CampaignRecord, type CampaignSummary, type DeploymentHealthObservation,
  type UpdateCampaignRepository, type UpdateCampaignSpec } from './update-campaign.ts';

/** Explicit additive migration, exported for the sole production schema writer. Never executed on import. */
export const UPDATE_CAMPAIGN_SCHEMA_SQL = `
create table if not exists lba_release_campaigns (
 release_id text primary key, bot_id text not null, spec_hash text not null, record jsonb not null
);
create table if not exists lba_release_campaign_jobs (
 operation_id text primary key, release_id text not null references lba_release_campaigns(release_id),
 recipient_ref text not null, cohort text not null check(cohort in ('pilot','full')), record jsonb not null,
 unique(release_id,recipient_ref)
);
create table if not exists lba_release_campaign_attempts (
 operation_id text not null references lba_release_campaign_jobs(operation_id), fence integer not null,
 release_id text not null references lba_release_campaigns(release_id), worker_id text not null, spec_hash text not null,
 events jsonb not null, primary key(operation_id,fence)
);
create index if not exists lba_release_campaign_bot on lba_release_campaigns(bot_id);
create index if not exists lba_release_campaign_job_release on lba_release_campaign_jobs(release_id,cohort);
create index if not exists lba_release_campaign_job_state on lba_release_campaign_jobs((record->>'state'));
`;
export interface CampaignPgClient {
  query(sql: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}
export interface CampaignPgPool { connect(): Promise<CampaignPgClient> }
export interface CampaignRecipientEligibility {
  /** Lock/read the actual subscription in this transaction. False for missing/opt-out/blocked/paused or wrong bot. */
  enabled(client: CampaignPgClient, recipientRef: string, botId: string, now: string): Promise<boolean>;
}
const STATES: DeliveryState[] = ['pending','leased','dispatching','retry_wait','outcome_unknown','sent','cancelled','failed'];
const TERMINAL: DeliveryState[] = ['sent','cancelled','failed'];
function decode<T>(value: any): T { return structuredClone(typeof value === 'string' ? JSON.parse(value) : value) as T; }
function record(row: any): CampaignRecord {
  const c = decode<CampaignRecord>(row?.record);
  if (!c?.spec || c.spec.version !== UPDATE_CAMPAIGN_VERSION || c.spec.releaseId !== row.release_id || c.spec.botId !== row.bot_id ||
      c.specHash !== row.spec_hash || campaignSpecHash(c.spec) !== c.specHash || !['prepared','pilot','full','paused','completed'].includes(c.phase) ||
      !campaignInstant(c.spec.createdAt) || !campaignInstant(c.spec.expiresAt)) return campaignFail('CAMPAIGN_RECORD_INVALID');
  return c;
}
function job(row: any): CampaignJob {
  const j = decode<CampaignJob>(row?.record);
  if (!j || j.operationId !== row.operation_id || j.releaseId !== row.release_id || j.recipientRef !== row.recipient_ref || j.cohort !== row.cohort ||
      j.operationId !== campaignOperationId(j.releaseId, j.recipientRef) || !campaignId(j.botId) || !STATES.includes(j.state) ||
      !Number.isSafeInteger(j.fence) || j.fence < 0 || !Number.isSafeInteger(j.attempts) || j.attempts < 0 || !campaignInstant(j.nextAttemptAt) ||
      (j.leaseUntil !== null && !campaignInstant(j.leaseUntil)) || (j.leaseOwner !== null && !campaignId(j.leaseOwner))) return campaignFail('CAMPAIGN_JOB_INVALID');
  return j;
}
const nowCheck = (now: string) => { if (!campaignInstant(now)) return campaignFail('INVALID_CAMPAIGN_CLOCK'); return Date.parse(now); };
function sameClaim(c: CampaignRecord, j: CampaignJob, claim: CampaignClaim) {
  return c.specHash === claim.campaign.specHash && c.specHash === campaignSpecHash(claim.campaign.spec) &&
    j.operationId === claim.job.operationId && j.recipientRef === claim.job.recipientRef && j.releaseId === claim.job.releaseId && j.botId === claim.job.botId &&
    j.fence === claim.fence && j.fence === claim.job.fence && j.leaseOwner === claim.workerId;
}
const zero = () => Object.fromEntries(STATES.map(state => [state, 0])) as Record<DeliveryState, number>;
const clearLease = (j: CampaignJob) => { j.leaseOwner = null; j.leaseUntil = null; };

/** Only injected ports are held. No global pool, timer, provider or implicit migration is created. */
export function createPgUpdateCampaignRepository(pool: CampaignPgPool, eligibility: CampaignRecipientEligibility) {
  if (!pool || typeof pool.connect !== 'function' || typeof eligibility?.enabled !== 'function') return campaignFail('INVALID_CAMPAIGN_REPOSITORY');
  async function tx<T>(fn: (client: CampaignPgClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // One control-plane lock also serializes active campaign claims across all application replicas.
      await client.query("select pg_advisory_xact_lock(hashtextextended('lba-update-campaign-global-v1',0))");
      const value = await fn(client); await client.query('commit'); return value;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  async function load(client: CampaignPgClient, releaseId: string): Promise<CampaignRecord> {
    if (!campaignId(releaseId)) return campaignFail('INVALID_CAMPAIGN_ID');
    const rows = await client.query('select * from lba_release_campaigns where release_id=$1 for update', [releaseId]);
    if (!rows.rows.length) return campaignFail('CAMPAIGN_NOT_FOUND'); return record(rows.rows[0]);
  }
  async function jobs(client: CampaignPgClient, releaseId: string): Promise<CampaignJob[]> {
    return (await client.query('select * from lba_release_campaign_jobs where release_id=$1 order by operation_id for update', [releaseId])).rows.map(job);
  }
  async function saveCampaign(client: CampaignPgClient, c: CampaignRecord) {
    await client.query('update lba_release_campaigns set record=$2::jsonb where release_id=$1', [c.spec.releaseId, JSON.stringify(c)]);
  }
  async function saveJob(client: CampaignPgClient, j: CampaignJob) {
    await client.query('update lba_release_campaign_jobs set record=$2::jsonb where operation_id=$1', [j.operationId, JSON.stringify(j)]);
  }
  async function summaryIn(client: CampaignPgClient, c: CampaignRecord): Promise<CampaignSummary> {
    const rows = await jobs(client, c.spec.releaseId), states = zero(), pilotStates = zero();
    for (const j of rows) { states[j.state]++; if (j.cohort === 'pilot') pilotStates[j.state]++; }
    return { releaseId: c.spec.releaseId, specHash: c.specHash, phase: c.phase, pauseReason: c.pauseReason,
      total: rows.length, pilotTotal: rows.filter(j => j.cohort === 'pilot').length, states, pilotStates };
  }
  async function botJobs(client: CampaignPgClient, botId: string): Promise<CampaignJob[]> {
    return (await client.query(`select j.* from lba_release_campaign_jobs j join lba_release_campaigns c on c.release_id=j.release_id
      where c.bot_id=$1 and (j.record->>'state' in ('leased','dispatching','outcome_unknown','retry_wait') or j.record->>'lastOutcome'='rate_limited') order by j.operation_id for update of j`, [botId])).rows.map(job);
  }
  async function event(client: CampaignPgClient, j: CampaignJob, outcome: DeliveryOutcome, now: string) {
    const result = await client.query('update lba_release_campaign_attempts set events=events||$3::jsonb where operation_id=$1 and fence=$2', [j.operationId,j.fence,JSON.stringify([{...outcome,observedAt:now}])]);
    if (!result.rowCount) return campaignFail('CAMPAIGN_ATTEMPT_MISSING');
  }
  async function recoverBot(client: CampaignPgClient, botId: string, now: string) {
    const time = nowCheck(now), rows = await botJobs(client, botId);
    for (const j of rows) {
      if (!['leased','dispatching'].includes(j.state) || j.leaseUntil === null || Date.parse(j.leaseUntil) > time) continue;
      if (j.state === 'dispatching') {
        await event(client,j,{kind:'unknown',reason:'dispatch_lease_expired'},now);
        j.state = 'outcome_unknown'; j.lastOutcome = 'dispatch_lease_expired';
        const c = await load(client, j.releaseId); c.phase = 'paused'; c.pauseReason = 'dispatch_outcome_unknown'; await saveCampaign(client, c);
        // Keep this attempt's fence/worker so a known late positive receipt can resolve it without re-send.
      } else { j.state = 'pending'; j.lastOutcome = 'lease_expired_before_dispatch'; clearLease(j); }
      await saveJob(client, j);
    }
  }
  async function noUnknown(client: CampaignPgClient, botId: string) {
    return !(await botJobs(client, botId)).some(j => j.state === 'outcome_unknown');
  }
  async function prepare(input: Omit<UpdateCampaignSpec, 'version' | 'audienceDigest'>, recipientRefs: string[]) {
    const spec = prepareCampaignSpec(input, recipientRefs), specHash = campaignSpecHash(spec);
    return tx(async client => {
      const existing = await client.query('select * from lba_release_campaigns where release_id=$1 for update', [spec.releaseId]);
      if (existing.rows.length) {
        const prior = record(existing.rows[0]); if (prior.specHash !== specHash) return campaignFail('CAMPAIGN_RELEASE_CONFLICT');
        return { ...await summaryIn(client, prior), replayed: true };
      }
      const c: CampaignRecord = { spec, specHash, phase: 'prepared', pauseReason: null };
      await client.query('insert into lba_release_campaigns(release_id,bot_id,spec_hash,record) values($1,$2,$3,$4::jsonb)', [spec.releaseId, spec.botId, specHash, JSON.stringify(c)]);
      for (let offset = 0; offset < recipientRefs.length; offset += 500) {
        const rows = recipientRefs.slice(offset, offset + 500).map(recipientRef => {
          const j: CampaignJob = { operationId: campaignOperationId(spec.releaseId, recipientRef), releaseId: spec.releaseId, botId: spec.botId, recipientRef,
            cohort: spec.pilotRecipientRefs.includes(recipientRef) ? 'pilot' : 'full', state: 'pending', fence: 0, attempts: 0,
            nextAttemptAt: spec.createdAt, leaseOwner: null, leaseUntil: null, providerReceipt: null, lastOutcome: null };
          return { operation_id: j.operationId, release_id: j.releaseId, recipient_ref: recipientRef, cohort: j.cohort, record: j };
        });
        await client.query(`insert into lba_release_campaign_jobs(operation_id,release_id,recipient_ref,cohort,record)
          select x.operation_id,x.release_id,x.recipient_ref,x.cohort,x.record from jsonb_to_recordset($1::jsonb)
          as x(operation_id text,release_id text,recipient_ref text,cohort text,record jsonb)`, [JSON.stringify(rows)]);
      }
      return { ...await summaryIn(client, c), replayed: false };
    });
  }
  async function startPilot(releaseId: string, now: string) {
    nowCheck(now); return tx(async client => {
      let c = await load(client, releaseId); await recoverBot(client, c.spec.botId, now); c = await load(client, releaseId);
      if (!['prepared','paused','pilot'].includes(c.phase) || Date.parse(now) < Date.parse(c.spec.createdAt) || Date.parse(now) >= Date.parse(c.spec.expiresAt) || !await noUnknown(client, c.spec.botId)) return null;
      c.phase = 'pilot'; c.pauseReason = null; await saveCampaign(client, c); return summaryIn(client, c);
    }).then(value => value ?? campaignFail('CAMPAIGN_PILOT_BLOCKED'));
  }
  async function promote(releaseId: string, now: string) {
    nowCheck(now); return tx(async client => {
      let c = await load(client, releaseId); await recoverBot(client, c.spec.botId, now); c = await load(client, releaseId);
      const pilot = (await jobs(client, releaseId)).filter(j => j.cohort === 'pilot');
      if (!pilot.length || pilot.length !== c.spec.pilotRecipientRefs.length || pilot.some(j => j.state !== 'sent') || Date.parse(now) >= Date.parse(c.spec.expiresAt) || !await noUnknown(client, c.spec.botId)) return null;
      if (c.phase !== 'completed') { c.phase = 'full'; c.pauseReason = null; await saveCampaign(client, c); }
      return summaryIn(client, c);
    }).then(value => value ?? campaignFail('CAMPAIGN_PILOT_NOT_CONFIRMED'));
  }
  async function pause(releaseId: string) {
    return tx(async client => { const c = await load(client, releaseId); if (c.phase !== 'completed') { c.phase = 'paused'; c.pauseReason = 'operator_paused'; await saveCampaign(client, c); } return summaryIn(client, c); });
  }
  const repo: UpdateCampaignRepository = {
    async claim(releaseId, workerId, now, leaseSeconds) {
      const time = nowCheck(now);
      if (!campaignId(workerId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) return campaignFail('INVALID_CAMPAIGN_WORKER');
      return tx(async client => {
        let c = await load(client, releaseId); await recoverBot(client, c.spec.botId, now); c = await load(client, releaseId);
        if (!['pilot','full'].includes(c.phase) || time < Date.parse(c.spec.createdAt)) return null;
        const active = await botJobs(client, c.spec.botId);
        if (active.some(j => j.state === 'outcome_unknown' || ['leased','dispatching'].includes(j.state) && j.leaseUntil !== null && Date.parse(j.leaseUntil) > time || j.lastOutcome === 'rate_limited' && Date.parse(j.nextAttemptAt) > time)) return null;
        const all = await jobs(client, releaseId);
        for (const j of all) {
          if (!['pending','retry_wait'].includes(j.state)) continue;
          if (time >= Date.parse(c.spec.expiresAt) || j.attempts >= c.spec.maxAttempts) {
            j.state = time >= Date.parse(c.spec.expiresAt) ? 'cancelled' : 'failed'; j.lastOutcome = 'campaign_expired_or_attempt_limit'; clearLease(j); await saveJob(client, j); continue;
          }
          if (c.phase === 'pilot' && j.cohort !== 'pilot' || Date.parse(j.nextAttemptAt) > time) continue;
          j.state = 'leased'; j.fence++; j.leaseOwner = workerId; j.leaseUntil = new Date(time + leaseSeconds * 1000).toISOString();
          await saveJob(client, j); return { campaign: c, job: j, workerId, fence: j.fence };
        }
        if ((c.phase === 'full' || time >= Date.parse(c.spec.expiresAt)) && all.every(j => TERMINAL.includes(j.state))) { c.phase = 'completed'; c.pauseReason = null; await saveCampaign(client, c); }
        return null;
      });
    },
    async begin(claim, health, now) {
      const time = nowCheck(now); return tx(async client => {
        const c = await load(client, claim.job.releaseId), rows = await client.query('select * from lba_release_campaign_jobs where operation_id=$1 for update', [claim.job.operationId]);
        if (!rows.rows.length) return 'lost'; const j = job(rows.rows[0]);
        if (!sameClaim(c, j, claim) || j.state !== 'leased' || !j.leaseUntil || time >= Date.parse(j.leaseUntil)) return 'lost';
        if (time >= Date.parse(c.spec.expiresAt)) { j.state = 'cancelled'; j.lastOutcome = 'campaign_expired_before_send'; clearLease(j); await saveJob(client, j); return 'cancelled'; }
        if (!['pilot','full'].includes(c.phase) || c.phase === 'pilot' && j.cohort !== 'pilot' || !validDeploymentHealth(campaignBinding(c.spec), health, now)) {
          j.state = 'pending'; j.lastOutcome = 'deployment_health_unverified'; clearLease(j); c.phase = 'paused'; c.pauseReason = j.lastOutcome; await saveJob(client, j); await saveCampaign(client, c); return 'health_blocked';
        }
        // The injected reader must lock the actual current subscription row in this same transaction.
        const enabled = await eligibility.enabled(client, j.recipientRef, c.spec.botId, now);
        if (enabled !== true) { j.state = 'cancelled'; j.lastOutcome = 'subscription_not_enabled'; clearLease(j); await saveJob(client, j); return 'cancelled'; }
        j.state = 'dispatching'; j.attempts++; j.lastOutcome = 'dispatch_started';
        await client.query('insert into lba_release_campaign_attempts(operation_id,fence,release_id,worker_id,spec_hash,events) values($1,$2,$3,$4,$5,$6::jsonb)', [j.operationId,j.fence,j.releaseId,claim.workerId,c.specHash,JSON.stringify([{kind:'dispatching',observedAt:now}])]);
        await saveJob(client, j); return 'dispatch';
      });
    },
    async finish(claim, value: DeliveryOutcome, now) {
      const time = nowCheck(now), outcome = checkedCampaignOutcome(value);
      return tx(async client => {
        const c = await load(client, claim.job.releaseId), rows = await client.query('select * from lba_release_campaign_jobs where operation_id=$1 for update', [claim.job.operationId]);
        if (!rows.rows.length) return campaignFail('CAMPAIGN_FENCE_LOST'); const j = job(rows.rows[0]);
        if (j.state === 'sent' && j.fence === claim.fence && c.specHash === claim.campaign.specHash && outcome.kind === 'sent' && outcome.receipt === j.providerReceipt) return;
        if (!sameClaim(c, j, claim) || !['dispatching','outcome_unknown'].includes(j.state)) return campaignFail('CAMPAIGN_FENCE_LOST');
        // Unknown is never converted to an automatic retry, even by a late negative result.
        if (j.state === 'outcome_unknown' && outcome.kind !== 'sent' && outcome.kind !== 'unknown') return;
        if (j.state === 'outcome_unknown' && outcome.kind === 'unknown' && j.lastOutcome === outcome.reason) return;
        await event(client,j,outcome,now);
        if (outcome.kind === 'unknown') { j.state = 'outcome_unknown'; j.lastOutcome = outcome.reason; c.phase = 'paused'; c.pauseReason = 'dispatch_outcome_unknown'; }
        else if (outcome.kind === 'sent') { j.state = 'sent'; j.providerReceipt = outcome.receipt; j.lastOutcome = 'telegram_confirmed'; clearLease(j); }
        else {
          const retry = outcome.kind === 'rate_limited' || outcome.retryable;
          const delay = outcome.kind === 'rate_limited' ? outcome.retryAfterSeconds : Math.min(60, 2 ** j.attempts);
          j.nextAttemptAt = new Date(time + delay * 1000).toISOString();
          j.state = !retry || j.attempts >= c.spec.maxAttempts || Date.parse(j.nextAttemptAt) >= Date.parse(c.spec.expiresAt) ? 'failed' : 'retry_wait';
          j.lastOutcome = outcome.kind; clearLease(j);
          if (j.cohort === 'pilot' && j.state === 'failed') { c.phase = 'paused'; c.pauseReason = 'pilot_failed'; }
        }
        await saveJob(client, j);
        if (c.phase === 'full' && (await jobs(client, j.releaseId)).every(item => TERMINAL.includes(item.state))) { c.phase = 'completed'; c.pauseReason = null; }
        await saveCampaign(client, c);
      });
    },
  };
  return { ...repo, prepare, startPilot, promote, pause,
    summary: (releaseId: string) => tx(async client => summaryIn(client, await load(client, releaseId))),
    attemptHistory: (releaseId: string) => tx(async client => { await load(client,releaseId); return (await client.query('select operation_id,fence,worker_id,spec_hash,events from lba_release_campaign_attempts where release_id=$1 order by operation_id,fence',[releaseId])).rows; }) };
}
