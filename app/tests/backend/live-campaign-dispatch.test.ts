import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignBinding,campaignOperationId,campaignSpecHash,prepareCampaignSpec,type CoordinatedCampaignRepository,type CampaignClaim} from '../../server/release/update-campaign.ts';
import {runCoordinatedCampaignAttempt} from '../../server/production/campaign-dispatch.ts';
import type {DispatchRunResult} from '../../server/production/telegram-dispatch.ts';
const bot='8577497098',now='2026-11-08T18:00:00Z';
function fixture(){const spec=prepareCampaignSpec({releaseId:'qa-release',deploymentId:'qa-deployment',buildSha256:'a'.repeat(64),botId:bot,origin:'https://example.invalid',text:'Оновлення застосунку.',appUrl:'https://example.invalid',createdAt:now,expiresAt:'2026-11-09T18:00:00Z',pilotRecipientRefs:['owner:qa'],maxAttempts:3},['owner:qa']);const claim:CampaignClaim={campaign:{spec,specHash:campaignSpecHash(spec),phase:'pilot',pauseReason:null},workerId:'qa-worker',fence:1,job:{operationId:campaignOperationId(spec.releaseId,'owner:qa'),releaseId:spec.releaseId,botId:bot,recipientRef:'owner:qa',cohort:'pilot',state:'leased',fence:1,attempts:0,nextAttemptAt:now,leaseOwner:'qa-worker',leaseUntil:'2026-11-08T18:01:00Z',providerReceipt:null,lastOutcome:null}};
 const finishes:any[]=[],deferrals:any[]=[],repo:CoordinatedCampaignRepository={claim:async()=>structuredClone(claim),begin:async()=> 'dispatch',finish:async(_c,o)=>{finishes.push(o);},defer:async(c,d)=>{deferrals.push({operationId:c.job.operationId,...d});return 'deferred';}},observer={observe:async()=>({...campaignBinding(spec),healthy:true as const,observedAt:now})},options={releaseId:spec.releaseId,workerId:'qa-worker',now:()=>now,timeoutMs:100,healthTimeoutMs:100};return{claim,finishes,deferrals,repo,observer,options};}
test('proved local coordinator busy/deferred keeps operation and invokes typed defer without a fake provider outcome',async()=>{for(const kind of ['busy','deferred'] as const){const f=fixture();const r=await runCoordinatedCampaignAttempt(f.repo,{dispatchCampaign:async()=>({kind})},f.observer,f.options);assert.equal(r.result,'deferred');assert.equal(f.finishes.length,0);assert.equal(f.deferrals.length,1);assert.equal(f.deferrals[0].operationId,f.claim.job.operationId);assert(!JSON.stringify(f.deferrals).includes('429'));}});
test('held/ambiguous or malformed claimed successes remain unknown and never auto defer',async()=>{for(const value of [{kind:'held'},{kind:'unknown'},{kind:'completed',outcome:{kind:'sent',receipt:'tg-msg-1'}},{kind:'deferred',outcome:{kind:'sent',receipt:'tg-msg-1'}}] as DispatchRunResult[]){const f=fixture(),r=await runCoordinatedCampaignAttempt(f.repo,{dispatchCampaign:async()=>value},f.observer,f.options);assert.equal(r.result,'unknown');assert.equal(f.deferrals.length,0);assert.equal(f.finishes[0].kind,'unknown');}});
test('coordinator terminal cancellation is a definite no-send; exact verified message receipt is confirmed',async()=>{const f=fixture(),r=await runCoordinatedCampaignAttempt(f.repo,{dispatchCampaign:async()=>({kind:'cancelled'})},f.observer,f.options);assert.equal(r.result,'not_sent');assert.equal(f.finishes[0].retryable,false);
 const g=fixture(),op=g.claim.job.operationId,result=await runCoordinatedCampaignAttempt(g.repo,{dispatchCampaign:async()=>({kind:'completed',outcome:{kind:'sent',receipt:'tg-msg-7'},receipt:{botId:bot,operationId:op,recipientRef:'owner:qa',completedAt:now,attempts:[{method:'sendMessage',requestSha256:'b'.repeat(64),providerAccepted:true,messageId:7}]}})},g.observer,g.options);assert.equal(result.result,'sent');});
test('a late local defer after deadline never clears the durable unknown',async()=>{const f=fixture();let calls=0;const r=await runCoordinatedCampaignAttempt(f.repo,{dispatchCampaign:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return {kind:'busy'};}},f.observer,{...f.options,timeoutMs:1});assert.equal(r.result,'unknown');await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);assert.deepEqual(f.finishes,[{kind:'unknown',reason:'coordinator_timeout'}]);assert.equal(f.deferrals.length,0);});

function productionFixture() {
 const f=fixture(),start=Date.parse(now);
 let time=start,observedLease=0;
 f.repo.claim=async (_id,_worker,at,seconds)=>{
  observedLease=seconds;
  const claim=structuredClone(f.claim);
  claim.job.leaseUntil=new Date(Date.parse(at)+seconds*1000).toISOString();
  return claim;
 };
 const clock=()=>new Date(time).toISOString();
 const options={releaseId:f.options.releaseId,workerId:f.options.workerId,now:clock,timing:'production-release-notice' as const};
 return {...f,clock,options,advance:(ms:number)=>{time+=ms;},lease:()=>observedLease,
  observer:{observe:async()=>({...campaignBinding(f.claim.campaign.spec),healthy:true as const,observedAt:clock()})}};
}

test('production notice stays live through a 51-second preflight and uses its 210-second lease',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=productionFixture();
 let entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const attempt=runCoordinatedCampaignAttempt(f.repo,{async dispatchCampaign(envelope,signal){
  entered();
  await new Promise<void>(resolve=>setTimeout(resolve,51000));
  assert.equal(signal.aborted,false);
  return {kind:'completed',outcome:{kind:'sent',receipt:'tg-msg-79'},
   receipt:{botId:bot,operationId:envelope.operationId,recipientRef:envelope.recipientRef,completedAt:f.clock(),
    attempts:[{method:'sendMessage',requestSha256:'b'.repeat(64),providerAccepted:true,messageId:79}]}};
 }},f.observer,f.options);
 await ready;
 assert.equal(f.lease(),210);
 f.advance(51000);
 t.mock.timers.tick(51000);
 assert.equal((await attempt).result,'sent');
 assert.deepEqual(f.finishes,[{kind:'sent',receipt:'tg-msg-79'}]);
});

test('production notice aborts a pending marked effect at 150 seconds and leaves it unknown',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=productionFixture();
 let entered!:()=>void,aborted=0;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const attempt=runCoordinatedCampaignAttempt(f.repo,{async dispatchCampaign(_envelope,signal){
  entered();
  return new Promise<DispatchRunResult>(resolve=>signal.addEventListener('abort',()=>{aborted++;resolve({kind:'deferred'});},{once:true}));
 }},f.observer,f.options);
 await ready;
 f.advance(149999);
 t.mock.timers.tick(149999);
 assert.equal(aborted,0);
 f.advance(1);
 t.mock.timers.tick(1);
 assert.equal((await attempt).result,'unknown');
 assert.equal(aborted,1);
 assert.deepEqual(f.finishes,[{kind:'unknown',reason:'coordinator_timeout'}]);
 assert.deepEqual(f.deferrals,[]);
});

test('production notice shortens the watchdog against expiry and defers without a coordinator call when its reserve is gone',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=productionFixture();
 const expiry=Date.parse(f.claim.campaign.spec.expiresAt);
 f.advance(expiry-Date.parse(now)-45000);
 let entered!:()=>void,aborted=0;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const attempt=runCoordinatedCampaignAttempt(f.repo,{async dispatchCampaign(_envelope,signal){
  entered();
  return new Promise<DispatchRunResult>(resolve=>signal.addEventListener('abort',()=>{aborted++;resolve({kind:'deferred'});},{once:true}));
 }},f.observer,f.options);
 await ready;
 f.advance(29999);
 t.mock.timers.tick(29999);
 assert.equal(aborted,0);
 f.advance(1);
 t.mock.timers.tick(1);
 assert.equal((await attempt).result,'unknown');
 assert.equal(aborted,1);
 const deferral=await runCoordinatedCampaignAttempt(f.repo,{async dispatchCampaign(){assert.fail('reserve exhausted');}},f.observer,f.options);
 assert.equal(deferral.result,'deferred');
 assert.equal(f.deferrals.length,1);
});
