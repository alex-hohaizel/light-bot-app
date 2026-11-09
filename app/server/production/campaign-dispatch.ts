import type {DeliveryOutcome} from '../../shared/delivery-contract.ts';
import {campaignBinding,campaignId,campaignInstant,checkedCampaignClaim,validDeploymentHealth,
 type CampaignAttemptOptions,type CampaignHealthObserver,type CampaignEnvelope,type CoordinatedCampaignRepository} from '../release/update-campaign.ts';
import {checkedDispatchTransportResult,type DispatchRunResult,type TelegramDispatcher} from './telegram-dispatch.ts';
export type CoordinatedCampaignAttemptResult={operationId:string|null;result:'idle'|'cancelled'|'health_blocked'|'lost'|'deferred'|DeliveryOutcome['kind'];retryAt?:string};
/** One bounded operation through the same durable bot-global sender. No polling/startup. */
export async function runCoordinatedCampaignAttempt(repo:CoordinatedCampaignRepository,dispatcher:Pick<TelegramDispatcher,'dispatchCampaign'>,observer:CampaignHealthObserver,options:CampaignAttemptOptions):Promise<CoordinatedCampaignAttemptResult>{
 if(!campaignId(options?.releaseId)||!campaignId(options?.workerId)||typeof options.now!=='function'||!repo||!['claim','begin','finish','defer'].every(k=>typeof repo[k as keyof CoordinatedCampaignRepository]==='function')||typeof dispatcher?.dispatchCampaign!=='function'||typeof observer?.observe!=='function')throw Error('INVALID_COORDINATED_CAMPAIGN_RUN');
 const lease=options.leaseSeconds??60,timeout=options.timeoutMs??25000,healthTimeout=options.healthTimeoutMs??5000;
 if(!Number.isInteger(lease)||lease<5||lease>300||!Number.isInteger(timeout)||timeout<1||timeout>30000||!Number.isInteger(healthTimeout)||healthTimeout<1||healthTimeout>10000)throw Error('INVALID_CAMPAIGN_BOUNDS');
 let last=options.now();if(!campaignInstant(last))throw Error('INVALID_CAMPAIGN_CLOCK');
 const clock=()=>{try{const value=options.now();if(campaignInstant(value)&&Date.parse(value)>=Date.parse(last)){last=value;return {now:value,valid:true};}}catch{}return {now:last,valid:false};};
 const raw=await repo.claim(options.releaseId,options.workerId,last,lease);if(!raw)return {operationId:null,result:'idle'};
 const claim=checkedCampaignClaim(raw,options),operationId=claim.job.operationId,spec=claim.campaign.spec;
 const healthController=new AbortController();let healthTimer:ReturnType<typeof setTimeout>|undefined;
 const health=await Promise.race([Promise.resolve().then(()=>observer.observe(Object.freeze(campaignBinding(spec)),healthController.signal)).catch(()=>null),new Promise<null>(resolve=>{healthTimer=setTimeout(()=>{healthController.abort();resolve(null);},healthTimeout);})]);if(healthTimer)clearTimeout(healthTimer);
 const before=clock(),begun=await repo.begin(claim,before.valid&&validDeploymentHealth(spec,health,before.now)?health:null,before.now);if(begun!=='dispatch')return {operationId,result:begun};
 const at=clock();if(!at.valid||!claim.job.leaseUntil||Date.parse(at.now)>=Date.parse(claim.job.leaseUntil)||Date.parse(at.now)>=Date.parse(spec.expiresAt)){await repo.finish(claim,{kind:'unknown',reason:'dispatch_clock_or_deadline_changed'},at.now);return {operationId,result:'unknown'};}
 const envelope:Readonly<CampaignEnvelope>=Object.freeze({...campaignBinding(spec),operationId,recipientRef:claim.job.recipientRef,text:spec.text,appUrl:spec.appUrl});
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,timedOut=false;
 const completion:Promise<DispatchRunResult>=Promise.resolve().then(()=>dispatcher.dispatchCampaign(envelope,controller.signal)).catch(():DispatchRunResult=>({kind:'unknown',outcome:{kind:'unknown',reason:'coordinator_unconfirmed'}}));
 const result=await Promise.race([completion,new Promise<DispatchRunResult>(resolve=>{timer=setTimeout(()=>{timedOut=true;controller.abort();resolve({kind:'unknown',outcome:{kind:'unknown',reason:'coordinator_timeout'}});},timeout);})]);if(timer)clearTimeout(timer);
 const finish=clock();
 if(finish.valid&&!timedOut&&['busy','deferred'].includes(result.kind)&&!result.outcome&&!result.receipt){
  const supplied=result.retryAt,retryAt=campaignInstant(supplied)&&Date.parse(supplied)>Date.parse(finish.now)?supplied:new Date(Date.parse(finish.now)+1000).toISOString();
  const deferred=await repo.defer(claim,{reason:result.kind==='busy'?'coordinator_busy':'coordinator_deferred',retryAt},finish.now);return {operationId,result:deferred,...(deferred==='deferred'?{retryAt}:{})};
 }
 const outcome:DeliveryOutcome=!finish.valid?{kind:'unknown',reason:'clock_changed_after_send'}:result.kind==='completed'?checkedDispatchTransportResult(result,{operationId,recipientRef:envelope.recipientRef}).outcome:result.kind==='cancelled'?{kind:'not_sent',retryable:false,reason:'coordinator_cancelled'}:{kind:'unknown',reason:result.kind==='held'?'coordinator_held':'coordinator_unconfirmed'};
 await repo.finish(claim,outcome,finish.now);
 if(timedOut)void completion.then(async late=>{if(late.kind==='completed'){const verified=checkedDispatchTransportResult(late,{operationId,recipientRef:envelope.recipientRef}).outcome;if(verified.kind==='sent'){const observed=clock();if(observed.valid)try{await repo.finish(claim,verified,observed.now);}catch{}}}});
 return {operationId,result:outcome.kind};
}
