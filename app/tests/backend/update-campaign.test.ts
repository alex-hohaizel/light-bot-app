import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { campaignBinding, campaignOperationId, classifyCampaignReply, prepareCampaignSpec, runUpdateCampaignAttempt,
  type CampaignClaim, type CampaignEnvelope, type CampaignTelegramSender, type DeploymentHealthObservation,
  type UpdateCampaignRepository, type UpdateCampaignSpec } from '../../server/release/update-campaign.ts';
import { createPgUpdateCampaignRepository, UPDATE_CAMPAIGN_SCHEMA_SQL, type CampaignPgClient } from '../../server/release/update-campaign-pg.ts';

/** Query-port fixture executes repository transitions, not PostgreSQL. Actual SQL/locking proof belongs to parent QA. */
class MemoryPg {
  campaigns = new Map<string, any>(); jobs = new Map<string, any>(); enabled = new Map<string, boolean>(); attempts = new Map<string,any>();
  reads: string[] = []; eligibilityReads = 0; tail: Promise<void> = Promise.resolve();
  async connect(): Promise<CampaignPgClient> {
    const db = this; let release: (() => void) | null = null, backup: any = null;
    return {
      async query(sql, values = []) {
        const q = sql.replace(/\s+/g, ' ').trim(); db.reads.push(q);
        const rows = (values: any[]) => ({ rows: structuredClone(values), rowCount: values.length });
        if (q === 'begin') return rows([]);
        if (q.startsWith('select pg_advisory_xact_lock')) {
          const previous = db.tail; db.tail = new Promise(resolve => { release = resolve; }); await previous;
          backup = { campaigns: structuredClone(db.campaigns), jobs: structuredClone(db.jobs), attempts:structuredClone(db.attempts) }; return rows([]);
        }
        if (q === 'commit' || q === 'rollback') {
          if (q === 'rollback' && backup) { db.campaigns = backup.campaigns; db.jobs = backup.jobs; db.attempts=backup.attempts; }
          const done = release; release = null; backup = null; done?.(); return rows([]);
        }
        assert(release, 'repository query must stay inside its explicit transaction/lock');
        if(q.startsWith('insert into lba_release_campaign_attempts')){const key=values[0]+':'+values[1];assert(!db.attempts.has(key));db.attempts.set(key,{operation_id:values[0],fence:values[1],release_id:values[2],worker_id:values[3],spec_hash:values[4],events:JSON.parse(values[5])});return rows([]);}
        if(q.startsWith('update lba_release_campaign_attempts')){const item=db.attempts.get(values[0]+':'+values[1]);if(!item)return rows([]);item.events.push(...JSON.parse(values[2]));return rows([item]);}
        if(q.startsWith('select operation_id,fence,worker_id,spec_hash,events from lba_release_campaign_attempts'))return rows([...db.attempts.values()].filter(a=>a.release_id===values[0]));
        if (q.startsWith('select * from lba_release_campaigns')) return rows(db.campaigns.has(values[0]) ? [db.campaigns.get(values[0])] : []);
        if (q.startsWith('insert into lba_release_campaigns')) {
          assert(!db.campaigns.has(values[0])); db.campaigns.set(values[0], { release_id: values[0], bot_id: values[1], spec_hash: values[2], record: JSON.parse(values[3]) }); return rows([]);
        }
        if (q.startsWith('update lba_release_campaigns')) { db.campaigns.get(values[0]).record = JSON.parse(values[1]); return rows([]); }
        if (q.startsWith('insert into lba_release_campaign_jobs')) {
          for (const row of JSON.parse(values[0])) { assert(!db.jobs.has(row.operation_id)); db.jobs.set(row.operation_id, row); } return rows([]);
        }
        if (q.startsWith('update lba_release_campaign_jobs')) { db.jobs.get(values[0]).record = JSON.parse(values[1]); return rows([]); }
        if (q.startsWith('select j.* from lba_release_campaign_jobs')) return rows([...db.jobs.values()].filter(j => db.campaigns.get(j.release_id)?.bot_id === values[0] && (['leased','dispatching','outcome_unknown','retry_wait'].includes(j.record.state) || j.record.lastOutcome === 'rate_limited')).sort((a,b) => a.operation_id.localeCompare(b.operation_id)));
        if (q.startsWith('select * from lba_release_campaign_jobs where release_id')) return rows([...db.jobs.values()].filter(j => j.release_id === values[0]).sort((a,b) => a.operation_id.localeCompare(b.operation_id)));
        if (q.startsWith('select * from lba_release_campaign_jobs where operation_id')) return rows(db.jobs.has(values[0]) ? [db.jobs.get(values[0])] : []);
        throw new Error('Unsupported query-port fixture: ' + q);
      }, release() { assert(!release, 'connection released without ending transaction'); },
    };
  }
  repository() {
    return createPgUpdateCampaignRepository(this, { enabled: async (_client, ref) => { this.eligibilityReads++; return this.enabled.get(ref) === true; } });
  }
}
const start = Date.parse('2026-11-08T15:00:00Z');
const refs = ['recipient-a','recipient-b','recipient-c'];
function spec(releaseId = 'release-v8'): Omit<UpdateCampaignSpec, 'version' | 'audienceDigest'> {
  return { releaseId, deploymentId: 'deployment-1', buildSha256: 'a'.repeat(64), botId: 'bot-1', origin: 'https://app.example.invalid',
    appUrl: 'https://app.example.invalid/', text: 'Ми оновили застосунок і бота.', createdAt: new Date(start).toISOString(), expiresAt: new Date(start + 3600000).toISOString(),
    pilotRecipientRefs: [refs[0]], maxAttempts: 3 };
}
function fixture() {
  const db = new MemoryPg(), repo = db.repository(); for (const ref of refs) db.enabled.set(ref, true);
  let time = start; const now = () => new Date(time).toISOString();
  const observer = { observe: async (binding: any): Promise<DeploymentHealthObservation> => ({ ...binding, healthy: true, observedAt: now() }) };
  let calls = 0;
  const sender: CampaignTelegramSender = { kind: 'telegram-release-campaign', botId: 'bot-1', send: async envelope => { calls++; return { botId: envelope.botId, recipientRef: envelope.recipientRef, body: { ok: true, result: { message_id: calls } } }; } };
  const run = (transport = sender, repository: UpdateCampaignRepository = repo, health = observer, timeoutMs = 100) => runUpdateCampaignAttempt(repository, transport, health, { releaseId: 'release-v8', workerId: 'worker-1', now, timeoutMs, healthTimeoutMs: 100 });
  return { db, repo, observer, sender, run, now, advance: (ms: number) => { time += ms; }, calls: () => calls };
}

test('immutable release/audience preparation is idempotent; conflict cannot create another campaign for a recipient', async () => {
  const f = fixture(); const a = await f.repo.prepare(spec(), refs), b = await f.repo.prepare(spec(), [...refs].reverse());
  assert.equal(a.total, 3); assert.equal(b.replayed, true); assert.equal(f.db.jobs.size, 3);
  await assert.rejects(f.repo.prepare({ ...spec(), text: 'Інший текст' }, refs), /CAMPAIGN_RELEASE_CONFLICT/);
  await assert.rejects(f.repo.prepare(spec(), refs.slice(0, 2)), /CAMPAIGN_RELEASE_CONFLICT/);
  for (const input of [{ ...spec(), pilotRecipientRefs: [] }, { ...spec(), pilotRecipientRefs: ['foreign'] }, { ...spec(), appUrl: 'https://other.example.invalid/' }, { ...spec(), appUrl: 'blob:https://app.example.invalid/opaque' }, { ...spec(), origin: 'http://app.example.invalid' }, { ...spec(), maxAttempts: 0 }]) assert.throws(() => prepareCampaignSpec(input, refs));
  assert.throws(() => prepareCampaignSpec(spec(), ['same','same']));
  assert.equal(campaignOperationId('release-v8','recipient-a'), campaignOperationId('release-v8','recipient-a'));
});

test('pilot precedes full; completed/replayed jobs never send twice; receipts count only provider confirmation', async () => {
  const f = fixture(); await f.repo.prepare(spec(), refs);
  assert.equal((await f.run()).result, 'idle'); assert.equal(f.calls(), 0);
  await assert.rejects(f.repo.promote('release-v8', f.now()), /PILOT_NOT_CONFIRMED/);
  await f.repo.startPilot('release-v8', f.now()); assert.equal((await f.run()).result, 'sent');
  assert.equal((await f.run()).result, 'idle'); assert.equal(f.calls(), 1);
  await f.repo.promote('release-v8', f.now()); await f.run(); await f.run();
  const summary = await f.repo.summary('release-v8'); assert.equal(summary.phase, 'completed'); assert.equal(summary.states.sent, 3); assert.equal(summary.pilotStates.sent, 1);
  assert.equal((await f.run()).result, 'idle'); await f.repo.prepare(spec(), refs); assert.equal((await f.run()).result, 'idle'); assert.equal(f.calls(), 3);
});

test('subscription revoked after claim/health read is cancelled by current eligibility before send', async () => {
  const f = fixture(); await f.repo.prepare(spec(), refs); await f.repo.startPilot('release-v8', f.now());
  const observer = { observe: async (binding: any) => { f.db.enabled.set(refs[0], false); return { ...binding, healthy: true as const, observedAt: f.now() }; } };
  const result = await f.run(f.sender, f.repo, observer); assert.equal(result.result, 'cancelled'); assert.equal(f.calls(), 0); assert.equal(f.db.eligibilityReads, 1);
  assert.equal((await f.repo.summary('release-v8')).states.cancelled, 1);
  await assert.rejects(f.repo.promote('release-v8', f.now()), /PILOT_NOT_CONFIRMED/);
  assert.equal(f.db.enabled.get(refs[0]), false, 'campaign never re-enables a subscription');
});

test('only one leased/dispatching operation can run for the bot across workers and campaigns', async () => {
  const f = fixture(); await f.repo.prepare(spec(), refs); await f.repo.startPilot('release-v8', f.now());
  let resolve!: (value: any) => void, entered!: () => void; const started = new Promise<void>(r => { entered = r; }); let sends = 0;
  const sender: CampaignTelegramSender = { kind: 'telegram-release-campaign', botId: 'bot-1', send: envelope => { sends++; entered(); return new Promise(r => { resolve = body => r({ botId: envelope.botId, recipientRef: envelope.recipientRef, body }); }); } };
  const running = f.run(sender); await started;
  assert.equal(await f.repo.claim('release-v8','worker-2',f.now(),45), null);
  const otherSpec = spec('release-other'); await f.repo.prepare(otherSpec, refs); await f.repo.startPilot(otherSpec.releaseId, f.now());
  assert.equal(await f.repo.claim(otherSpec.releaseId,'worker-2',f.now(),45), null);
  resolve({ ok: true, result: { message_id: 88 } }); assert.equal((await running).result, 'sent'); assert.equal(sends, 1);
});

test('wrong/stale/future deployment observation and wrong sender bot cannot dispatch', async () => {
  for (const patch of [{ buildSha256: 'b'.repeat(64) }, { deploymentId: 'old-deploy' }, { releaseId: 'other' }, { origin: 'https://foreign.invalid' }, { botId: 'foreign' }, { observedAt: new Date(start - 300001).toISOString() }, { observedAt: new Date(start + 1).toISOString() }]) {
    const f = fixture(); await f.repo.prepare(spec(), refs); await f.repo.startPilot('release-v8', f.now());
    const observer = { observe: async (binding: any) => ({ ...binding, healthy: true as const, observedAt: f.now(), ...patch }) };
    assert.equal((await f.run(f.sender, f.repo, observer)).result, 'health_blocked'); assert.equal(f.calls(), 0);
    assert.equal((await f.repo.summary('release-v8')).phase, 'paused');
  }
  const f = fixture(); await f.repo.prepare(spec(), refs); await f.repo.startPilot('release-v8', f.now());
  assert.equal((await f.run({ ...f.sender, botId: 'wrong-bot' })).result, 'health_blocked'); assert.equal(f.calls(), 0);
});

test('timeout is durable unknown, cannot retry/promote, and only a late same-attempt positive receipt reconciles it', async () => {
  const f = fixture(); await f.repo.prepare(spec(), refs); await f.repo.startPilot('release-v8', f.now());
  let resolve!: (body: any) => void, sends = 0;
  const sender: CampaignTelegramSender = { kind: 'telegram-release-campaign', botId: 'bot-1', send: e => { sends++; return new Promise(r => { resolve = body => r({ botId: e.botId, recipientRef: e.recipientRef, body }); }); } };
  assert.equal((await f.run(sender, f.repo, f.observer, 5)).result, 'unknown');
  assert.equal((await f.repo.summary('release-v8')).states.outcome_unknown, 1);
  await assert.rejects(f.repo.startPilot('release-v8', f.now()), /PILOT_BLOCKED/); await assert.rejects(f.repo.promote('release-v8', f.now()), /PILOT_NOT_CONFIRMED/);
  f.advance(60000); assert.equal((await f.run(sender)).result, 'idle'); assert.equal(sends, 1);
  resolve({ ok: true, result: { message_id: 91 } }); await new Promise(r => setTimeout(r, 5));
  assert.equal((await f.repo.summary('release-v8')).states.sent, 1); assert.equal(sends, 1);
  const audit=await f.repo.attemptHistory('release-v8');assert.deepEqual(audit[0].events.map((x:any)=>x.kind),['dispatching','unknown','sent']);
});

test('health-only pause resumes full with a terminal excluded pilot and spends no attempt on the failed health check', async () => {
  const f = fixture();
  const input = spec();
  await f.repo.prepare(input, refs);
  f.db.campaigns.get(input.releaseId).record.phase = 'full';
  const pilot = f.db.jobs.get(campaignOperationId(input.releaseId, refs[0])).record;
  Object.assign(pilot, { state: 'failed', lastOutcome: 'provider_403' });
  const lease = await f.repo.claim(input.releaseId, 'worker-1', f.now(), 60);
  assert(lease);
  assert.equal(lease.job.cohort, 'full');
  assert.equal(await f.repo.begin(lease, null, f.now()), 'health_blocked');
  assert.equal((await f.repo.summary(input.releaseId)).pauseReason, 'deployment_health_unverified');
  assert.deepEqual(await f.repo.attemptHistory(input.releaseId), []);
  await assert.rejects(f.repo.startPilot(input.releaseId, f.now()), /PILOT_BLOCKED/);
  const health = await f.observer.observe(campaignBinding(input));
  f.advance(300001);
  assert.equal((await f.repo.resumeAfterHealth(input.releaseId, health, f.now())).phase, 'paused');
  const fresh = await f.observer.observe(campaignBinding(input));
  assert.equal((await f.repo.resumeAfterHealth(input.releaseId, fresh, f.now())).phase, 'full');
  assert.equal(await f.repo.begin(lease, fresh, f.now()), 'lost');
  assert.equal((await f.run()).result, 'sent');
  const summary = await f.repo.summary(input.releaseId);
  assert.equal(summary.pilotStates.failed, 1);
  assert.equal(summary.states.sent, 1);
  assert.equal(f.calls(), 1);
});

test('a failed health observation after an operator pause releases the old lease and preserves the operator pause', async () => {
  const f = fixture();
  const input = spec();
  await f.repo.prepare(input, refs);
  await f.repo.startPilot(input.releaseId, f.now());
  const lease = await f.repo.claim(input.releaseId, 'worker-1', f.now(), 60);
  assert(lease);
  await f.repo.pause(input.releaseId);
  assert.equal(await f.repo.begin(lease, null, f.now()), 'lost');
  const health = await f.observer.observe(campaignBinding(input));
  const summary = await f.repo.resumeAfterHealth(input.releaseId, health, f.now());
  assert.equal(summary.phase, 'paused');
  assert.equal(summary.pauseReason, 'operator_paused');
  assert.equal(summary.states.pending, refs.length);
  assert.deepEqual(await f.repo.attemptHistory(input.releaseId), []);
});

test('crash before dispatch reclaims a lease with fencing; crash after dispatch becomes unknown and never resends', async () => {
  const f = fixture(); await f.repo.prepare(spec(), refs); await f.repo.startPilot('release-v8', f.now());
  const first = await f.repo.claim('release-v8','worker-old',f.now(),5); assert(first);
  f.advance(6000); const next = await f.repo.claim('release-v8','worker-new',f.now(),5); assert(next); assert(next.fence > first.fence);
  const health = { ...campaignBinding(next.campaign.spec), healthy: true as const, observedAt: f.now() };
  assert.equal(await f.repo.begin(first, health, f.now()), 'lost'); assert.equal(await f.repo.begin(next, health, f.now()), 'dispatch');
  f.advance(6000); assert.equal(await f.repo.claim('release-v8','worker-third',f.now(),5), null);
  assert.equal((await f.repo.summary('release-v8')).states.outcome_unknown, 1);
  // A late definite failure cannot put an ambiguous issued attempt back in a retry queue.
  await f.repo.finish(next, { kind: 'not_sent', retryable: true, reason: 'late_failure' }, f.now());
  assert.equal((await f.repo.summary('release-v8')).states.outcome_unknown, 1);
  await f.repo.finish(next, { kind: 'sent', receipt: 'tg-msg-123' }, f.now());
  await f.repo.finish(next, { kind: 'sent', receipt: 'tg-msg-123' }, f.now());
  assert.equal((await f.repo.summary('release-v8')).states.sent, 1);
});

test('429 honors retry_after and pauses bot-wide claims; 403 is terminal and cannot count as sent', async () => {
  const f = fixture(); await f.repo.prepare(spec(), refs); await f.repo.startPilot('release-v8', f.now()); let calls = 0;
  const sender: CampaignTelegramSender = { kind: 'telegram-release-campaign', botId: 'bot-1', send: async e => ({ botId: e.botId, recipientRef: e.recipientRef, body: ++calls === 1 ? { ok: false, error_code: 429, parameters: { retry_after: 30 } } : { ok: false, error_code: 403 } }) };
  assert.equal((await f.run(sender)).result, 'rate_limited'); assert.equal((await f.run(sender)).result, 'idle');
  await f.repo.prepare(spec('other-release'), refs); await f.repo.startPilot('other-release', f.now());
  assert.equal(await f.repo.claim('other-release','other-worker',f.now(),45), null);
  f.advance(31000); assert.equal((await f.run(sender)).result, 'not_sent');
  const s = await f.repo.summary('release-v8'); assert.equal(s.states.sent, 0); assert.equal(s.states.failed, 1); assert.equal(s.phase, 'paused'); assert.equal(calls, 2);
});

test('provider response requires exact target and ok/message_id; missing/null/network-shaped values remain unknown', () => {
  const s = prepareCampaignSpec(spec(), refs), e: CampaignEnvelope = { ...campaignBinding(s), operationId: campaignOperationId(s.releaseId,refs[0]), recipientRef: refs[0], text: s.text, appUrl: s.appUrl };
  const response = (body: unknown) => ({ botId: e.botId, recipientRef: e.recipientRef, body });
  assert.deepEqual(classifyCampaignReply(e, response({ ok: true, result: { message_id: 1 } })), { kind: 'sent', receipt: 'tg-msg-1' });
  for (const body of [null, {}, { ok: true }, { ok: true, result: { message_id: 0 } }, { ok: true, result: { message_id: '1' } }, { error_code: 500 }]) assert.equal(classifyCampaignReply(e,response(body)).kind,'unknown');
  assert.equal(classifyCampaignReply(e,{ ...response({ ok: true, result: { message_id: 1 } }), recipientRef: 'foreign' }).kind,'unknown');
  assert.equal(classifyCampaignReply(e,response({ ok: false,error_code: 500 })).kind,'not_sent');
});

test('lost finish acknowledgement after actual dispatch is not retried; explicit schema/import has no DB side effects', async () => {
  const f = fixture(); await f.repo.prepare(spec(), refs); await f.repo.startPilot('release-v8', f.now());
  const wrapper: UpdateCampaignRepository = { ...f.repo, finish: async () => { throw new Error('ACK_LOST'); } };
  await assert.rejects(f.run(f.sender, wrapper),/ACK_LOST/); f.advance(46000);
  assert.equal((await f.run()).result,'idle'); assert.equal(f.calls(),1); assert.equal((await f.repo.summary('release-v8')).states.outcome_unknown,1);
  assert(UPDATE_CAMPAIGN_SCHEMA_SQL.includes('unique(release_id,recipient_ref)'));
  assert(f.db.reads.every(q => !q.startsWith('create ')), 'repository never auto-applies DDL');
  const child = spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',"await import('./server/release/update-campaign.ts');await import('./server/release/update-campaign-pg.ts');console.log('IMPORT_WITHOUT_DB_PASS')"],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{PATH:process.env.PATH,TZ:'UTC'},encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr); assert(child.stdout.includes('IMPORT_WITHOUT_DB_PASS'));
});


test('retry_after still fences other campaigns when the rate-limited attempt exhausts its limit', async () => {
 const f=fixture();await f.repo.prepare({...spec(),maxAttempts:1},refs);await f.repo.startPilot('release-v8',f.now());
 const sender:CampaignTelegramSender={kind:'telegram-release-campaign',botId:'bot-1',send:async e=>({botId:e.botId,recipientRef:e.recipientRef,body:{ok:false,error_code:429,parameters:{retry_after:60}}})};
 await f.run(sender);assert.equal((await f.repo.summary('release-v8')).states.failed,1);
 await f.repo.prepare(spec('release-two'),refs);await f.repo.startPilot('release-two',f.now());assert.equal(await f.repo.claim('release-two','worker-two',f.now(),45),null);
 f.advance(61000);assert(await f.repo.claim('release-two','worker-two',f.now(),45));
});
test('control-plane rejection commits crash recovery, and campaign expiry resolves unattempted full recipients without sends', async () => {
 const f=fixture();await f.repo.prepare(spec(),refs);await f.repo.startPilot('release-v8',f.now());const claim=await f.repo.claim('release-v8','worker-1',f.now(),5);assert(claim);
 await f.repo.begin(claim,{...campaignBinding(claim.campaign.spec),healthy:true,observedAt:f.now()},f.now());f.advance(6000);
 await assert.rejects(f.repo.startPilot('release-v8',f.now()),/PILOT_BLOCKED/);assert.equal((await f.repo.summary('release-v8')).states.outcome_unknown,1);
 const g=fixture();await g.repo.prepare(spec(),refs);await g.repo.startPilot('release-v8',g.now());g.advance(3600001);assert.equal((await g.run()).result,'idle');
 const end=await g.repo.summary('release-v8');assert.equal(end.states.cancelled,3);assert.equal(end.states.pending,0);assert.equal(end.states.sent,0);assert.equal(end.phase,'completed');assert.equal(g.calls(),0);
});


test('429 without a verified bounded retry_after fails stopped and cannot dispatch another recipient or campaign', async () => {
 for(const parameters of [undefined,{retry_after:0},{retry_after:86401},{retry_after:'30'}]){
  const f=fixture();await f.repo.prepare(spec(),refs);await f.repo.startPilot('release-v8',f.now());let calls=0;
  const sender:CampaignTelegramSender={kind:'telegram-release-campaign',botId:'bot-1',send:async e=>{calls++;return {botId:e.botId,recipientRef:e.recipientRef,body:{ok:false,error_code:429,...(parameters===undefined?{}:{parameters})}};}};
  assert.equal((await f.run(sender)).result,'unknown');const summary=await f.repo.summary('release-v8');assert.equal(summary.phase,'paused');assert.equal(summary.states.outcome_unknown,1);
  await f.repo.prepare(spec('other-release'),refs);await assert.rejects(f.repo.startPilot('other-release',f.now()),/PILOT_BLOCKED/);
  f.advance(86400000);assert.equal((await f.run(sender)).result,'idle');assert.equal(calls,1);
  const audit=await f.repo.attemptHistory('release-v8');assert.equal(audit[0].events[1].reason,'rate_limit_unverified');
 }
});
