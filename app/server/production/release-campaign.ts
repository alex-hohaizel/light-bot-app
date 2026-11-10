import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {UPDATE_ANNOUNCEMENT_UA,campaignBinding,campaignId,campaignInstant,campaignSpecHash,validDeploymentHealth,
 type CampaignBinding,type CampaignHealthObserver,type CampaignRecord,type DeploymentHealthObservation} from '../release/update-campaign.ts';
import {createPgUpdateCampaignRepository,type CampaignRecipientEligibility} from '../release/update-campaign-pg.ts';
import {runCoordinatedCampaignAttempt} from './campaign-dispatch.ts';
import {telegramOwnerRecipientRef} from './telegram-dispatch-eligibility.ts';
import type {TelegramDispatcher,DispatchRunResult} from './telegram-dispatch.ts';
import type {LegacyProfileReadPool,LegacyProfileReadClient} from './profile-reader.ts';
import type {createLegacyCampaignRecipients} from './legacy-campaign-recipient.ts';

export const RELEASE_NOTICE_ORIGIN='https://power-ukraine.net' as const;
export const RELEASE_NOTICE_BOT_ID='8577497098' as const;
/** Actual project-owned grant: production-release-20261109/authorization.json.
 * This pin binds deployment configuration to that already recorded authority;
 * neither an environment flag nor this hash creates a new human permission. */
export const RELEASE_NOTICE_AUTHORITY_SHA256='613b008586fe302bc4cbdd45d4f34ae2eb45d2c050ddbf4c459747ac22e5a2bc' as const;
export interface ReleaseCampaignConfiguration {
 kind:'lba-release-notice/1';releaseId:string;deploymentRef:string;buildSha256:string;
 authoritySha256:typeof RELEASE_NOTICE_AUTHORITY_SHA256;createdAt:string;expiresAt:string;
 controlEpoch:number;pilotSize:number;maxAttempts:number;
}
type CampaignRepository=ReturnType<typeof createPgUpdateCampaignRepository>;
export type ReleaseCampaignState='disabled'|'waiting_window'|'waiting_health'|'preparing_audience'|'audience_empty'|'prepared'|'pilot'|'full'|'paused'|'completed'|'expired'|'unavailable'|'stopped';
export interface ReleaseCampaignObservation {state:ReleaseCampaignState;result?:string;audience?:{candidates:number;canonical:number;legacy:number;excluded:number};}
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const safeChat=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)<=2**52-1;
const owner=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=255&&!/[\u0000-\u001f\u007f]/.test(v);
const decoded=(v:unknown):unknown=>typeof v==='string'?JSON.parse(v):v;
const fail=():never=>{throw Error('RELEASE_CAMPAIGN_CONFIGURATION_INVALID');};
function scopedSignal(...parents:AbortSignal[]){
 const controller=new AbortController(),abort=()=>controller.abort();
 for(const parent of parents){parent.addEventListener('abort',abort,{once:true});if(parent.aborted)controller.abort();}
 return {signal:controller.signal,dispose:()=>{for(const parent of parents)parent.removeEventListener('abort',abort);}};
}

/** Optional, closed, non-secret deployment configuration. No environment or IO. */
export function readReleaseCampaignConfiguration(raw:unknown,actualBuildSha256:string):ReleaseCampaignConfiguration|undefined{
 if(raw===undefined||raw==='')return undefined;
 if(typeof raw==='string'){if(raw.length>4096)return fail();try{raw=JSON.parse(raw);}catch{return fail();}}
 if(!plain(raw)||!exact(raw,['kind','releaseId','deploymentRef','buildSha256','authoritySha256','createdAt','expiresAt','controlEpoch','pilotSize','maxAttempts'])||
  raw.kind!=='lba-release-notice/1'||!campaignId(raw.releaseId)||typeof raw.deploymentRef!=='string'||!/^lba-release:[A-Za-z0-9_.:-]{1,140}$/.test(raw.deploymentRef)||
  !hex(actualBuildSha256)||raw.buildSha256!==actualBuildSha256||raw.authoritySha256!==RELEASE_NOTICE_AUTHORITY_SHA256||
  !campaignInstant(raw.createdAt)||!campaignInstant(raw.expiresAt)||Date.parse(raw.expiresAt)<=Date.parse(raw.createdAt)||Date.parse(raw.expiresAt)-Date.parse(raw.createdAt)>7*86400000||
  !Number.isSafeInteger(raw.controlEpoch)||Number(raw.controlEpoch)<1||!Number.isInteger(raw.pilotSize)||Number(raw.pilotSize)<1||Number(raw.pilotSize)>5||
  !Number.isInteger(raw.maxAttempts)||Number(raw.maxAttempts)<1||Number(raw.maxAttempts)>5)return fail();
 return Object.freeze(structuredClone(raw)) as unknown as ReleaseCampaignConfiguration;
}
export function releaseCampaignBinding(c:ReleaseCampaignConfiguration):CampaignBinding{
 // The existing engine calls this field deploymentId. Here it is explicitly an
 // operator-owned logical rollout reference, never a claimed provider UUID.
 return {releaseId:c.releaseId,deploymentId:c.deploymentRef,buildSha256:c.buildSha256,botId:RELEASE_NOTICE_BOT_ID,origin:RELEASE_NOTICE_ORIGIN};
}
/** Public build/rollout fields are actual compiled source plus explicit config.
 * Native Telegram identity remains verified by the shared dispatch boundary. */
export function releaseCampaignPublicFields(c:ReleaseCampaignConfiguration|undefined,actualBuildSha256:string,observedAt:string){
 return {buildSha256:actualBuildSha256,noticeReleaseId:c?.releaseId??null,deploymentRef:c?.deploymentRef??null,
  configuredBotId:RELEASE_NOTICE_BOT_ID,origin:RELEASE_NOTICE_ORIGIN,observedAt};
}

/** Real bounded HTTPS read of the public app. The fetched fields, rather than
 * the requested binding, form the returned observation. No DB lock spans it. */
export function createReleaseCampaignHealthObserver(options:{fetch:typeof fetch;now:()=>number;timeoutMs?:number}):CampaignHealthObserver{
 const timeout=options.timeoutMs??4000;
 if(typeof options.fetch!=='function'||typeof options.now!=='function'||!Number.isInteger(timeout)||timeout<1||timeout>10000)throw Error('RELEASE_CAMPAIGN_HEALTH_OPTIONS');
 return Object.freeze({async observe(binding:Readonly<CampaignBinding>,signal:AbortSignal):Promise<DeploymentHealthObservation|null>{
  if(signal.aborted||binding.origin!==RELEASE_NOTICE_ORIGIN||binding.botId!==RELEASE_NOTICE_BOT_ID)return null;
  const url=RELEASE_NOTICE_ORIGIN+'/api/health/release',abort=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let resolveAbort:(value:null)=>void=()=>{};const cancelled=new Promise<null>(resolve=>{resolveAbort=resolve;});
  const stop=()=>{abort.abort();resolveAbort(null);void reader?.cancel().catch(()=>{});};
  signal.addEventListener('abort',stop,{once:true});timer=setTimeout(stop,timeout);
  const request=(async():Promise<DeploymentHealthObservation|null>=>{
   try{
    const response=await options.fetch(url,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',headers:{accept:'application/json'},signal:abort.signal});
    if(signal.aborted||abort.signal.aborted||response.status!==200||response.redirected||response.url!==url||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'||!response.body)return null;
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>16384))return null;
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>16384)return null;chunks.push(part.value);}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),now=new Date(options.now()).toISOString();
    if(!plain(body)||body.releaseId!==binding.buildSha256||body.buildSha256!==binding.buildSha256||body.noticeReleaseId!==binding.releaseId||body.deploymentRef!==binding.deploymentId||
     body.configuredBotId!==binding.botId||body.origin!==binding.origin||body.mode!=='production'||body.profileMode!=='active'||body.status!=='process_serving'||
     !campaignInstant(body.observedAt)||Date.parse(body.observedAt)>Date.parse(now)||Date.parse(now)-Date.parse(body.observedAt)>10000||
     !plain(body.canonical)||body.canonical.ready!==true||body.canonical.started!==true||body.canonical.stopped!==false||body.canonical.deliveryReady!==true)return null;
    const observed:DeploymentHealthObservation={releaseId:body.noticeReleaseId as string,deploymentId:body.deploymentRef as string,
     buildSha256:body.buildSha256 as string,botId:body.configuredBotId as string,origin:body.origin as string,healthy:true,observedAt:body.observedAt};
    return validDeploymentHealth(binding,observed,now)?observed:null;
   }catch{return null;}
  })();
  try{return await Promise.race([request,cancelled]);}finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',stop);abort.abort();void reader?.cancel().catch(()=>{});}
 }});
}

/** Explicit service composition. No timer, pool connection, preparation or send
 * occurs during construction. The caller's canonical lifecycle invokes runOnce. */
export function createProductionReleaseCampaign(options:{enabled:boolean;configuration?:ReleaseCampaignConfiguration;expectedControlEpoch:number;
 pool:LegacyProfileReadPool;dispatcher:Pick<TelegramDispatcher,'dispatchCampaign'>;eligibility:CampaignRecipientEligibility;
 legacyRecipients:Pick<ReturnType<typeof createLegacyCampaignRecipients>,'prepare'>;fetch:typeof fetch;now?:()=>number;healthObserver?:CampaignHealthObserver}){
 const c=options.configuration,enabled=options.enabled===true&&c!==undefined,ms=options.now??Date.now,now=()=>new Date(ms()).toISOString();
 if(typeof options.enabled!=='boolean'||!Number.isSafeInteger(options.expectedControlEpoch)||options.expectedControlEpoch<1)throw Error('RELEASE_CAMPAIGN_OPTIONS');
 if(c&&(readReleaseCampaignConfiguration(c,c.buildSha256)?.controlEpoch!==options.expectedControlEpoch))throw Error('RELEASE_CAMPAIGN_EPOCH_MISMATCH');
 const binding=c?releaseCampaignBinding(c):null;
 const repository:CampaignRepository=createPgUpdateCampaignRepository(options.pool,options.eligibility);
 const observer=options.healthObserver??createReleaseCampaignHealthObserver({fetch:options.fetch,now:ms});
 const workerId='release-notice:'+randomUUID(),shutdown=new AbortController();let busy=false,stopped=false,finished=false;
 let progress:{hints:Array<{chatId:unknown;branch:string;ownerId:unknown}>;index:number;refs:string[];canonicalRefs:string[];legacyRefs:string[];seen:Set<string>;counts:{candidates:number;canonical:number;legacy:number;excluded:number}}|undefined;
 let observation:ReleaseCampaignObservation={state:enabled?'waiting_health':'disabled'};
 const set=(value:ReleaseCampaignObservation)=>{observation=value;return structuredClone(value);};
 async function tx<T>(fn:(client:LegacyProfileReadClient)=>Promise<T>,readOnly=false){
  const client=await options.pool.connect();try{await client.query(readOnly?'begin isolation level repeatable read read only':'begin');await client.query("set local statement_timeout='5s'");await client.query("set local lock_timeout='1s'");const value=await fn(client);await client.query('commit');return value;}
  catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
 }
 function matches(record:CampaignRecord){const s=record.spec;return c&&s&&record.specHash===campaignSpecHash(s)&&
  ['releaseId','deploymentId','buildSha256','botId','origin'].every(k=>s[k as keyof CampaignBinding]===binding![k as keyof CampaignBinding])&&
  s.text===UPDATE_ANNOUNCEMENT_UA&&s.appUrl===RELEASE_NOTICE_ORIGIN+'/'&&s.createdAt===c.createdAt&&s.expiresAt===c.expiresAt&&s.maxAttempts===c.maxAttempts&&
  Array.isArray(s.pilotRecipientRefs)&&s.pilotRecipientRefs.length>0&&s.pilotRecipientRefs.length<=c.pilotSize;}
 async function existing():Promise<boolean>{
  return tx(async client=>{const rows=(await client.query('select record from lba_release_campaigns where release_id=$1',[c!.releaseId])).rows;
   if(!rows.length)return false;if(rows.length!==1)return false;const record=decoded(rows[0].record) as CampaignRecord;if(!record||!matches(record))throw Error('RELEASE_CAMPAIGN_EXISTING_CONFLICT');return true;},true);
 }
 async function audience(signal:AbortSignal){
  // A single snapshot classifies every physical subscription chat exactly once.
  // These are only hints; each selected branch obtains fresh locked authority.
  if(!progress){const hints=await tx(async client=>{
   const rows=(await client.query('select chat_id as "chatId",user_id as "subscriberOwner" from telegram_subscribers order by chat_id limit 100001')).rows;
   if(rows.length>100000)throw Error('RELEASE_CAMPAIGN_AUDIENCE_LIMIT');
   const links=(await client.query("select id,user_id as \"ownerId\",provider_id as \"chatId\" from linked_accounts where provider='telegram' and provider_id in(select chat_id from telegram_subscribers) order by id limit 200001")).rows;
   if(links.length>200000)throw Error('RELEASE_CAMPAIGN_AUDIENCE_LIMIT');
   const profileRows=(await client.query("select owner_id from lba_production_profiles where control_epoch=$1 and owner_id in(select user_id from linked_accounts where provider='telegram' and provider_id in(select chat_id from telegram_subscribers)) limit 100001",[options.expectedControlEpoch])).rows;
   if(profileRows.length>100000)throw Error('RELEASE_CAMPAIGN_AUDIENCE_LIMIT');const profiles=new Set(profileRows.map(r=>r.owner_id));
   const byChat=new Map<unknown,any[]>(),chatCounts=new Map<unknown,number>();
   for(const link of links){const list=byChat.get(link.chatId)??[];list.push(link);byChat.set(link.chatId,list);}
   for(const row of rows)chatCounts.set(row.chatId,(chatCounts.get(row.chatId)??0)+1);
   return rows.map(row=>{const linked=byChat.get(row.chatId)??[];return {chatId:row.chatId,branch:chatCounts.get(row.chatId)!==1?'excluded':linked.length===1&&owner(linked[0].ownerId)&&profiles.has(linked[0].ownerId)?'canonical':linked.length===0&&row.subscriberOwner===null?'legacy':'excluded',ownerId:linked.length===1?linked[0].ownerId:null};});
  },true);
   progress={hints,index:0,refs:[],canonicalRefs:[],legacyRefs:[],seen:new Set(),counts:{candidates:hints.length,canonical:0,legacy:0,excluded:0}};
  }
  const start=performance.now();let processed=0;
  while(progress.index<progress.hints.length&&processed<64&&(processed===0||performance.now()-start<2000)){
   const hint=progress.hints[progress.index];
   if(signal.aborted||stopped)throw Error('RELEASE_CAMPAIGN_ABORTED');
   if(!safeChat(hint.chatId)||hint.branch==='excluded'){progress.counts.excluded++;progress.index++;processed++;continue;}
   const chatId=hint.chatId;
   const ref=await tx(async client=>{
    if(hint.branch==='legacy')return (await options.legacyRecipients.prepare(client,{chatId,now:now(),signal}))?.recipientRef??null;
    if(!owner(hint.ownerId))return null;const recipientRef=telegramOwnerRecipientRef(hint.ownerId);
    if(!await options.eligibility.enabled(client,recipientRef,RELEASE_NOTICE_BOT_ID,now()))return null;
    const control=(await client.query('select control_epoch,writer_mode from lba_production_control where id=true for share')).rows;
    return control.length===1&&Number(control[0].control_epoch)===options.expectedControlEpoch&&control[0].writer_mode==='canonical'?recipientRef:null;
   });
   if(!ref||progress.seen.has(ref))progress.counts.excluded++;
   else {progress.seen.add(ref);progress.refs.push(ref);if(hint.branch==='legacy'){progress.counts.legacy++;progress.legacyRefs.push(ref);}else {progress.counts.canonical++;progress.canonicalRefs.push(ref);}}
   progress.index++;processed++;
  }
  return {complete:progress.index===progress.hints.length,refs:[...progress.refs].sort(),pilotRefs:[...progress.canonicalRefs].sort().concat([...progress.legacyRefs].sort()).slice(0,c!.pilotSize),counts:{...progress.counts}};
 }
 async function runOnce(input:{signal:AbortSignal}):Promise<ReleaseCampaignObservation>{
  if(!enabled)return set({state:'disabled'});if(stopped||input.signal.aborted)return set({state:'stopped'});if(finished)return structuredClone(observation);if(busy)return {...structuredClone(observation),result:'busy'};
  busy=true;const scope=scopedSignal(input.signal,shutdown.signal);try{
   const at=now();if(Date.parse(at)<Date.parse(c!.createdAt))return set({state:'waiting_window'});
   if(Date.parse(at)>=Date.parse(c!.expiresAt)){
    // Let the existing repository expire unattempted work. This never invokes
    // a health/native port and retains any ambiguous issued attempt as a hold.
    if(await existing())await repository.claim(c!.releaseId,workerId,at,60);
    finished=true;return set({state:'expired'});
   }
   const health=await observer.observe(binding!,scope.signal);if(scope.signal.aborted)return set({state:'stopped'});
   if(!validDeploymentHealth(binding!,health,now()))return set({state:'waiting_health'});
   if(!await existing()){
    const selected=await audience(scope.signal);if(!selected.complete)return set({state:'preparing_audience',audience:selected.counts});
    if(!selected.refs.length)return set({state:'audience_empty',audience:selected.counts});
    try{await repository.prepare({...binding!,text:UPDATE_ANNOUNCEMENT_UA,appUrl:RELEASE_NOTICE_ORIGIN+'/',createdAt:c!.createdAt,expiresAt:c!.expiresAt,
     pilotRecipientRefs:selected.pilotRefs,maxAttempts:c!.maxAttempts},selected.refs);}catch(error){if(!await existing())throw error;}
    observation={state:'prepared',audience:selected.counts};
    progress=undefined;
   }
   let summary=await repository.summary(c!.releaseId);
   if(summary.phase==='paused'&&summary.pauseReason==='deployment_health_unverified'){
    summary=await repository.resumeAfterHealth(c!.releaseId,health,now());
   }else if(summary.phase!=='paused'&&summary.phase!=='completed'){
    if(summary.pilotTotal>0&&summary.pilotStates.sent===summary.pilotTotal){if(summary.phase!=='full')summary=await repository.promote(c!.releaseId,now());}
    else if(summary.phase==='prepared')summary=await repository.startPilot(c!.releaseId,now());
   }
   if(summary.phase==='completed'){finished=true;return set({state:'completed'});}
   if(summary.phase==='paused')return set({state:'paused',result:summary.pauseReason??'paused'});
   if(scope.signal.aborted)return set({state:'stopped'});
   const guardedObserver:CampaignHealthObserver={observe:async(b,s)=>{const gate=scopedSignal(scope.signal,s);try{if(gate.signal.aborted)return null;const health=await observer.observe(b,gate.signal);return gate.signal.aborted?null:health;}finally{gate.dispose();}}};
   const guardedDispatcher:Pick<TelegramDispatcher,'dispatchCampaign'>={dispatchCampaign:async(envelope,s):Promise<DispatchRunResult>=>{const gate=scopedSignal(scope.signal,s);try{return gate.signal.aborted?{kind:'cancelled',reason:'release_worker_stopped'}:await options.dispatcher.dispatchCampaign(envelope,gate.signal);}finally{gate.dispose();}}};
   const attempt=await runCoordinatedCampaignAttempt(repository,guardedDispatcher,guardedObserver,{releaseId:c!.releaseId,workerId,now,timing:'production-release-notice'});
   summary=await repository.summary(c!.releaseId);if(summary.phase==='completed')finished=true;
   if(scope.signal.aborted)return set({state:'stopped',result:attempt.result});
   return set({state:summary.phase,result:attempt.result,...(observation.audience?{audience:observation.audience}:{})});
  }catch{return set({state:scope.signal.aborted?'stopped':'unavailable',result:'release_campaign_unconfirmed'});}finally{scope.dispose();busy=false;}
 }
 return Object.freeze({runOnce,stop:()=>{stopped=true;shutdown.abort();},
  health:()=>({configured:enabled,state:stopped&&!finished?'stopped':observation.state,...(c?{deploymentRef:c.deploymentRef}:{} )}),
  // Private operational diagnostics contain aggregate counts only, never refs/IDs.
  observation:()=>structuredClone(observation)});
}
