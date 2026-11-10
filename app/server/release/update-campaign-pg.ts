import type { DeliveryOutcome, DeliveryState } from '../../shared/delivery-contract.ts';
import { UPDATE_CAMPAIGN_VERSION, UPDATE_ANNOUNCEMENT_UA, campaignHash, campaignBinding, campaignFail, campaignId, campaignInstant, campaignOperationId, campaignSpecHash,
  checkedCampaignOutcome, prepareCampaignSpec, validDeploymentHealth,
  type CampaignBinding, type CampaignClaim, type CampaignJob, type CampaignRecord, type CampaignSummary, type DeploymentHealthObservation,
  type CoordinatedCampaignRepository, type UpdateCampaignSpec } from './update-campaign.ts';

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
export interface CampaignProvenUnissuedRequest {
  binding: CampaignBinding;
  controlEpoch: number;
  audienceSize: number;
  predecessorSenderSha256: string;
  operatorCodeSha256: string;
  acquireMs?: number;
}
export interface CampaignProvenUnissuedCertificate {
  kind: 'lba-campaign-proven-unissued/1';
  releaseId: string; specHash: string; buildSha256: string; botId: string;
  controlEpoch: number; audienceDigest: string; operationIdsDigest: string;
  operations: number; dispatchJobs: 0; dispatchAttempts: 0; providerReceipts: 0;
  predecessorSenderSha256: string; operatorCodeSha256: string; observedAt: string;
  certificateSha256: string;
}
export interface CampaignProvenUnissuedEvent {
  kind: 'not_sent'; retryable: false; reason: 'operator_proven_unissued';
  observedAt: string; operatorCertificate: CampaignProvenUnissuedCertificate;
}
const certHash=(c:Omit<CampaignProvenUnissuedCertificate,'certificateSha256'>)=>campaignHash([
  c.kind,c.releaseId,c.specHash,c.buildSha256,c.botId,c.controlEpoch,c.audienceDigest,c.operationIdsDigest,
  c.operations,c.dispatchJobs,c.dispatchAttempts,c.providerReceipts,c.predecessorSenderSha256,c.operatorCodeSha256,c.observedAt]);

/** Operator-only reconciliation. Native effects are impossible without a prior
 * committed dispatch job/attempt in the pinned sender. This procedure never
 * sends, retries, rewrites historical events or changes the immutable spec.
 * It assumes those append-only journals have not been externally deleted. */
export async function reconcileCampaignProvenUnissued(pool:CampaignPgPool,request:CampaignProvenUnissuedRequest) {
  const b=request?.binding,hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  if(!pool||typeof pool.connect!=='function'||!b||!campaignId(b.releaseId)||!campaignId(b.deploymentId)||!campaignId(b.botId)||!hex(b.buildSha256)||b.origin!=='https://power-ukraine.net'||
    !Number.isSafeInteger(request.controlEpoch)||request.controlEpoch<1||!Number.isInteger(request.audienceSize)||request.audienceSize<1||request.audienceSize>100000||!hex(request.predecessorSenderSha256)||!hex(request.operatorCodeSha256))return campaignFail('PROVEN_UNISSUED_OPTIONS');
  const acquire=request.acquireMs??4000;if(!Number.isInteger(acquire)||acquire<1||acquire>10000)return campaignFail('PROVEN_UNISSUED_LOCK_BUDGET');
  const client=await pool.connect(),locks:string[]=[];let begun=false,tainted=false;
  const check=(yes:unknown,code:string)=>{if(!yes)campaignFail(code);};
  async function inspect(){
    const backend=(await client.query("select pg_is_in_recovery() as recovery,current_setting('default_transaction_read_only') as default_ro,to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as observed_at")).rows[0];
    check(backend?.recovery===false&&backend.default_ro==='off'&&campaignInstant(backend.observed_at),'PROVEN_UNISSUED_NOT_PRIMARY');
    const control=(await client.query('select control_epoch,writer_mode from lba_production_control where id=true')).rows;
    check(control.length===1&&Number(control[0].control_epoch)===request.controlEpoch&&control[0].writer_mode==='canonical','PROVEN_UNISSUED_CONTROL');
    const rows=(await client.query('select * from lba_release_campaigns where release_id=$1',[b.releaseId])).rows;check(rows.length===1,'PROVEN_UNISSUED_CAMPAIGN_MISSING');
    const c=record(rows[0]),s=c.spec;
    check(['releaseId','deploymentId','buildSha256','botId','origin'].every(k=>s[k as keyof CampaignBinding]===b[k as keyof CampaignBinding])&&s.text===UPDATE_ANNOUNCEMENT_UA&&s.appUrl===b.origin+'/'&&c.phase==='paused'&&c.pauseReason==='dispatch_outcome_unknown','PROVEN_UNISSUED_BINDING');
    const all=(await client.query('select * from lba_release_campaign_jobs where release_id=$1 order by operation_id',[b.releaseId])).rows.map(job);
    check(all.length===request.audienceSize&&new Set(all.map(j=>j.operationId)).size===all.length&&all.every(j=>j.botId===b.botId&&j.providerReceipt===null),'PROVEN_UNISSUED_AUDIENCE');
    check(s.audienceDigest===campaignHash(all.map(j=>j.recipientRef).sort()),'PROVEN_UNISSUED_AUDIENCE_DIGEST');
    const pilot=all.filter(j=>j.cohort==='pilot');check(pilot.length===1&&s.pilotRecipientRefs.length===1&&pilot[0].recipientRef===s.pilotRecipientRefs[0],'PROVEN_UNISSUED_PILOT');
    const opids=all.map(j=>j.operationId),history=(await client.query('select operation_id,fence,spec_hash,events from lba_release_campaign_attempts where release_id=$1 order by operation_id,fence',[b.releaseId])).rows;
    check(history.every(a=>opids.includes(a.operation_id)&&a.spec_hash===c.specHash&&Array.isArray(decode(a.events))),'PROVEN_UNISSUED_HISTORY');
    const proofEvents=history.flatMap(a=>decode<any[]>(a.events).filter(e=>e?.reason==='operator_proven_unissued').map(e=>({attempt:a,event:e})));
    const dispatch=(await client.query('select count(*)::int as count from lba_production_telegram_dispatch_jobs where operation_id::text=any($1::text[])',[opids])).rows;
    const attempts=(await client.query('select count(*)::int as count from lba_production_telegram_dispatch_attempts where operation_id::text=any($1::text[])',[opids])).rows;
    check(dispatch.length===1&&dispatch[0].count===0&&attempts.length===1&&attempts[0].count===0,'PROVEN_UNISSUED_DISPATCH_PRESENT');
    const operationsDigest=campaignHash([...opids].sort());
    if(proofEvents.length){
      check(proofEvents.length===1,'PROVEN_UNISSUED_CERTIFICATE_CONFLICT');
      const {attempt,event}=proofEvents[0],cert=event.operatorCertificate as CampaignProvenUnissuedCertificate;
      check(event.kind==='not_sent'&&event.retryable===false&&campaignInstant(event.observedAt)&&cert?.kind==='lba-campaign-proven-unissued/1'&&
        cert.releaseId===b.releaseId&&cert.specHash===c.specHash&&cert.buildSha256===b.buildSha256&&cert.botId===b.botId&&cert.controlEpoch===request.controlEpoch&&
        cert.audienceDigest===s.audienceDigest&&cert.operationIdsDigest===operationsDigest&&cert.operations===all.length&&cert.dispatchJobs===0&&cert.dispatchAttempts===0&&cert.providerReceipts===0&&
        cert.predecessorSenderSha256===request.predecessorSenderSha256&&hex(cert.operatorCodeSha256)&&campaignInstant(cert.observedAt)&&event.observedAt===cert.observedAt&&
        certHash(cert)===cert.certificateSha256&&pilot[0].operationId===attempt.operation_id&&pilot[0].fence===Number(attempt.fence)&&
        pilot[0].state==='failed'&&pilot[0].lastOutcome==='operator_proven_unissued'&&pilot[0].leaseOwner===null&&pilot[0].leaseUntil===null&&
        all.filter(j=>j.cohort==='full').every(j=>j.state==='pending'&&j.lastOutcome===null&&j.fence===0&&j.attempts===0&&j.leaseOwner===null&&j.leaseUntil===null),'PROVEN_UNISSUED_CERTIFICATE_INVALID');
      return {already:true as const,certificate:cert,campaign:c,jobs:all,history,observedAt:backend.observed_at};
    }
    check(pilot[0].state==='outcome_unknown'&&pilot[0].lastOutcome==='coordinator_unconfirmed'&&pilot[0].fence>=1&&pilot[0].attempts>=1&&pilot[0].leaseOwner!==null&&
      pilot[0].leaseUntil!==null&&Date.parse(pilot[0].leaseUntil)<Date.parse(backend.observed_at)&&
      all.filter(j=>j.cohort==='full').every(j=>j.state==='pending'&&j.lastOutcome===null&&j.fence===0&&j.attempts===0&&j.leaseOwner===null&&j.leaseUntil===null),'PROVEN_UNISSUED_NOT_LOCAL_UNKNOWN');
    check(history.length>=1&&history.length<=c.spec.maxAttempts&&history.every(a=>a.operation_id===pilot[0].operationId&&decode<any[]>(a.events).every(e=>
      e?.kind==='dispatching'&&e.reason==null||e?.kind==='local_deferred'&&['coordinator_busy','coordinator_deferred'].includes(e.reason)||e?.kind==='unknown'&&e.reason==='coordinator_unconfirmed')),'PROVEN_UNISSUED_HISTORY_NOT_LOCAL');
    check(history.some(a=>Number(a.fence)===pilot[0].fence),'PROVEN_UNISSUED_ATTEMPT_MISSING');
    return {already:false as const,campaign:c,jobs:all,history,observedAt:backend.observed_at,operationsDigest};
  }
  try{
    await client.query("set statement_timeout='3000ms'");await client.query("set lock_timeout='1000ms'");
    // Idempotent cold starts read an existing verified certificate without
    // blocking a later campaign's active sender or requiring its hold to clear.
    await client.query('begin isolation level repeatable read read only');begun=true;
    const prior=await inspect();await client.query('rollback');begun=false;
    if(prior.already)return {state:'already_reconciled' as const,certificate:prior.certificate};
    const until=Date.now()+acquire;
    while(locks.length!==2&&Date.now()<until){
      for(const key of ['lba-update-campaign-global-v1',`lba-telegram-dispatch-bot:${b.botId}`]){
        if((await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',[key])).rows[0]?.locked===true)locks.push(key);else break;
      }
      if(locks.length!==2){while(locks.length)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[locks.pop()]);await new Promise(r=>setTimeout(r,75));}
    }
    check(locks.length===2,'PROVEN_UNISSUED_BUSY');
    // This new snapshot is AFTER both locks. An earlier snapshot could miss a
    // just-committed native effect while waiting for the dispatcher to finish.
    await client.query('begin isolation level repeatable read');begun=true;
    const current=await inspect();
    if(current.already){await client.query('rollback');begun=false;return {state:'already_reconciled' as const,certificate:current.certificate};}
    const bot=(await client.query('select hold_reason,hold_operation from lba_production_telegram_bot_state where bot_id=$1',[b.botId])).rows;
    check(bot.length===1&&bot[0].hold_reason===null&&bot[0].hold_operation===null,'PROVEN_UNISSUED_BOT_HOLD');
    const unsigned:Omit<CampaignProvenUnissuedCertificate,'certificateSha256'>={kind:'lba-campaign-proven-unissued/1',releaseId:b.releaseId,specHash:current.campaign.specHash,buildSha256:b.buildSha256,botId:b.botId,
      controlEpoch:request.controlEpoch,audienceDigest:current.campaign.spec.audienceDigest,operationIdsDigest:current.operationsDigest,operations:current.jobs.length,
      dispatchJobs:0,dispatchAttempts:0,providerReceipts:0,predecessorSenderSha256:request.predecessorSenderSha256,operatorCodeSha256:request.operatorCodeSha256,observedAt:current.observedAt};
    const certificate:CampaignProvenUnissuedCertificate={...unsigned,certificateSha256:certHash(unsigned)};
    const event:CampaignProvenUnissuedEvent={kind:'not_sent',retryable:false,reason:'operator_proven_unissued',observedAt:current.observedAt,operatorCertificate:certificate};
    const target=current.jobs.find(j=>j.cohort==='pilot')!;
    // Append; never overwrite the historical unknown/coordinator events.
    const appended=await client.query('update lba_release_campaign_attempts set events=events||$3::jsonb where operation_id=$1 and fence=$2',[target.operationId,target.fence,JSON.stringify([event])]);
    check(appended.rowCount===1,'PROVEN_UNISSUED_FENCE_LOST');
    const resolved:CampaignJob={...target,state:'failed',lastOutcome:'operator_proven_unissued',leaseOwner:null,leaseUntil:null};
    const saved=await client.query('update lba_release_campaign_jobs set record=$2::jsonb where operation_id=$1',[target.operationId,JSON.stringify(resolved)]);
    check(saved.rowCount===1,'PROVEN_UNISSUED_FENCE_LOST');
    await client.query('commit');begun=false;
    return {state:'reconciled' as const,certificate};
  }finally{
    if(begun)try{await client.query('rollback');}catch{tainted=true;}
    while(locks.length)try{if((await client.query('select pg_advisory_unlock(hashtextextended($1,0)) as unlocked',[locks.pop()])).rows[0]?.unlocked!==true)tainted=true;}catch{tainted=true;}
    client.release();
    // Pool is privately owned by the operator helper and is closed after use.
    if(tainted)campaignFail('PROVEN_UNISSUED_CLIENT_QUARANTINED');
  }
}
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
  const repo: CoordinatedCampaignRepository = {
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
    async defer(claim,deferral,now){
      const time=nowCheck(now);
      if(!deferral||!['coordinator_busy','coordinator_deferred'].includes(deferral.reason)||!campaignInstant(deferral.retryAt)||Date.parse(deferral.retryAt)<=time||Date.parse(deferral.retryAt)-time>86400000)return campaignFail('INVALID_CAMPAIGN_LOCAL_DEFERRAL');
      return tx(async client=>{
        const c=await load(client,claim.job.releaseId),rows=await client.query('select * from lba_release_campaign_jobs where operation_id=$1 for update',[claim.job.operationId]);
        if(rows.rows.length!==1)return 'lost';const j=job(rows.rows[0]);
        if(!sameClaim(c,j,claim)||j.state!=='dispatching'||!j.leaseUntil||time>=Date.parse(j.leaseUntil)||j.attempts!==claim.job.attempts+1)return 'lost';
        const updated=await client.query('update lba_release_campaign_attempts set events=events||$3::jsonb where operation_id=$1 and fence=$2',[j.operationId,j.fence,JSON.stringify([{kind:'local_deferred',reason:deferral.reason,retryAt:deferral.retryAt,observedAt:now}])]);if(updated.rowCount!==1)return campaignFail('CAMPAIGN_ATTEMPT_MISSING');
        j.attempts--;j.nextAttemptAt=deferral.retryAt;j.lastOutcome=deferral.reason;j.state=time>=Date.parse(c.spec.expiresAt)||Date.parse(deferral.retryAt)>=Date.parse(c.spec.expiresAt)?'cancelled':'retry_wait';clearLease(j);await saveJob(client,j);
        if(c.phase==='full'&&(await jobs(client,j.releaseId)).every(item=>TERMINAL.includes(item.state))){c.phase='completed';c.pauseReason=null;await saveCampaign(client,c);}
        return j.state==='cancelled'?'cancelled':'deferred';
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
