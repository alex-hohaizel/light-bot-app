import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {renderScheduleSvg} from '../../client/src/product-review/schedule-renderer.tsx';
import type {ProductionRuntimePolicy} from '../runtime-policy.ts';
import type {LegacyProfileReadPool} from './profile-reader.ts';
import {createProductionProfileStore,type ProductionProfileStoreOptions} from './profile-store.ts';
import {selectVerifiedLegacySubscriberMappings} from './legacy-identity-links.ts';
import {createRuntimeDataContext} from './runtime-context.ts';
import {createProductAddressFlow} from './address-flow.ts';
import {createAddressCatalog} from './address-catalog.ts';
import {createSourceIngestion} from './source-ingestion.ts';
import {SOURCE_PROFILES} from './source-intake.ts';
import {publicSourceTransport} from './public-http.ts';
import {createProductionTools,invalidateProductionToolShares} from './product-tools.ts';
import {createBotToolActions} from './bot-tools.ts';
import {createBotAddressPreflight} from './bot-address-preflight.ts';
import {createTelegramProcessor} from './telegram-processor.ts';
import {createIngressOwnerResolver,verifyRuntimeEmptyAccount} from './runtime-identity.ts';
import {createTelegramDispatcher} from './telegram-dispatch.ts';
import {createSqlTelegramDispatchEligibility} from './telegram-dispatch-eligibility.ts';
import type {CurrentDispatchSourceProof} from './telegram-dispatch-eligibility.ts';
import type {DispatchEligibilityRequest} from './telegram-dispatch.ts';
import {createTelegramTransport,type TelegramFetch} from './telegram-transport.ts';
import {PRODUCT_TELEGRAM_IDENTITY} from './product-identity.ts';
import {CANONICAL_REQUIRED_RELATIONS} from './canonical-schema.ts';
import {createAccountLinks,isDetachedAccountIdentity,type AccountLinksOptions} from './account-links.ts';
import {createVerifiedSessionFinalizer} from './verified-session.ts';
import {createProductionScheduleEvents} from './schedule-events.ts';
import {createCurrentRawScheduleVerifier} from './runtime-source-proof.ts';
import {createProductionMorningBriefing} from './morning-briefing.ts';
import {createProductionEventProducer} from './event-producer.ts';
import {createLegacyCampaignRecipients} from './legacy-campaign-recipient.ts';
import {createProductionReleaseCampaign,type ReleaseCampaignConfiguration} from './release-campaign.ts';

/** Explicit application composition. Construction has no HTTP, DB, timer or DDL.
 * prepare() checks an already installed canonical database; start() alone starts
 * workers. No fallback invokes the legacy bot, migration, seed or webhook setter. */
export function createCanonicalRuntime(ports:{pool:LegacyProfileReadPool;policy:ProductionRuntimePolicy;token:string;origin:string;
 now?:()=>number;fetch:typeof fetch;verifySource?:(request:DispatchEligibilityRequest)=>Promise<CurrentDispatchSourceProof|null>;
 authorizePrincipal?:ProductionProfileStoreOptions['authorizePrincipal'];accountConfiguration?:Pick<AccountLinksOptions,'bindingKey'|'miniApp'|'browserWidget'>;
 releaseCampaign?:ReleaseCampaignConfiguration}){
 const {policy,pool}=ports,epoch=policy.canonicalControlEpoch;
 if(policy.productProfileMode!=='active'||!epoch)throw Error('CANONICAL_RUNTIME_CONFIGURATION');
 if(ports.accountConfiguration&&!ports.authorizePrincipal)throw Error('CANONICAL_AUTH_EPOCH_GUARD_REQUIRED');
 if(policy.accountLinksEnabled&&(!(ports.accountConfiguration?.miniApp?.configurationVerified||ports.accountConfiguration?.browserWidget?.configurationVerified)||!ports.authorizePrincipal))throw Error('CANONICAL_ACCOUNT_LINK_CONFIGURATION_REQUIRED');
 const ms=ports.now??Date.now,now=()=>new Date(ms()).toISOString(),transport=publicSourceTransport(ports.fetch);
 const sources=createSourceIngestion({enabled:policy.sourceIngestionEnabled,expectedControlEpoch:epoch,pool,transport,now:ms});
 const catalog=createAddressCatalog({enabled:policy.sourceIngestionEnabled,expectedControlEpoch:epoch,pool,transport,now:ms});
 let flow:ReturnType<typeof createProductAddressFlow>,tools:ReturnType<typeof createProductionTools>;
 const labels=Object.fromEntries(SOURCE_PROFILES.map(p=>[p.operatorId,p.name]));
 const data=createRuntimeDataContext({sources,catalog,now:ms,operatorLabels:labels,ownedOptionIds:(owner,session)=>flow.ownedOptionIds(owner,session)});
 const store=createProductionProfileStore({enabled:true,pool,expectedControlEpoch:epoch,now,
  verifiedSubscriberMappings:(principal,client)=>selectVerifiedLegacySubscriberMappings(client,principal),verifyEmptyAccount:verifyRuntimeEmptyAccount,
  unresolvedSettingsTelegramPolicy:'retain_owned_profile',
  authorizePrincipal:ports.authorizePrincipal,
  context:input=>({...data.forProfile(input),...flow.forProfile(input.principal.ownerId,input.state,input.serverNow)}),
  onProfileChange:invalidateProductionToolShares,
  handleBotActions:input=>createBotToolActions({tools,origin:ports.origin})(input),
 });
 flow=createProductAddressFlow({enabled:policy.sourceIngestionEnabled,pool,catalog,store,now,refreshPublicContext:()=>data.refresh(true)});
 tools=createProductionTools({enabled:true,pool,store,expectedControlEpoch:epoch,now});
 const accounts=ports.accountConfiguration?createAccountLinks({enabled:true,pool,store,expectedControlEpoch:epoch,botId:PRODUCT_TELEGRAM_IDENTITY.botId,botToken:ports.token,now:ms,...ports.accountConfiguration}):undefined;
 const finishVerifiedLogin=accounts?createVerifiedSessionFinalizer({store,accounts,now:()=>Math.floor(ms()/1000)}):undefined;
 const events=createProductionScheduleEvents({enabled:true,expectedControlEpoch:epoch,store,
  verifyCurrentSource:createCurrentRawScheduleVerifier({expectedControlEpoch:epoch})});
 const morningBriefing=createProductionMorningBriefing({enabled:policy.notificationSchedulerEnabled,expectedControlEpoch:epoch,store,events});
 const eventProducer=createProductionEventProducer({enabled:policy.notificationSchedulerEnabled,expectedControlEpoch:epoch,pool,events,morningBriefing,now});
 const legacyRecipients=ports.accountConfiguration?createLegacyCampaignRecipients({enabled:policy.telegramDeliveryEnabled,expectedBotId:PRODUCT_TELEGRAM_IDENTITY.botId,expectedControlEpoch:epoch,bindingKey:ports.accountConfiguration.bindingKey}):undefined;
 const preflight=createBotAddressPreflight({store,pool,flow,now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
 const processor=createTelegramProcessor({enabled:policy.telegramUpdatesEnabled,expectedBotId:PRODUCT_TELEGRAM_IDENTITY.botId,
  expectedControlEpoch:epoch,pool,store:preflight,now,leaseMs:30000,resolveOwner:createIngressOwnerResolver(epoch,ports.accountConfiguration?{isDetached:(client,subject)=>isDetachedAccountIdentity(client,'telegram',subject)}:{})});
 const eligibility=createSqlTelegramDispatchEligibility({expectedBotId:PRODUCT_TELEGRAM_IDENTITY.botId,expectedControlEpoch:epoch,legacyRecipients,
  verifySource:request=>request.job.payload.briefing?morningBriefing.verifyDispatch(request):request.job.payload.message.kind==='notification'?events.verifyDispatch(request):ports.verifySource?.(request)??Promise.resolve(null)});
 const telegramFetch:TelegramFetch=async(url,request)=>{
  const response=await ports.fetch(url,request as RequestInit);
  const body=(async function*(){if(!response.body)return;const reader=response.body.getReader();
   try{for(;;){const chunk=await reader.read();if(chunk.done)return;yield chunk.value;}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}})();
  return {url:response.url,status:response.status,headers:response.headers,body};
 };
 const dispatcher=createTelegramDispatcher({enabled:policy.telegramDeliveryEnabled,expectedBotId:PRODUCT_TELEGRAM_IDENTITY.botId,
  expectedControlEpoch:epoch,workerId:'canonical:'+randomUUID(),pool,now,...eligibility,
  identityReadGrant:async request=>request.botId===PRODUCT_TELEGRAM_IDENTITY.botId&&request.controlEpoch===epoch&&!request.signal.aborted?
   {actorId:request.actorId,capabilityId:request.capabilityId,botId:request.botId,controlEpoch:epoch,expiresAt:new Date(ms()+1000).toISOString()}:null,
  callbacks:{enabled:policy.telegramUpdatesEnabled},
  createCallbackTransport:({authorize})=>createTelegramTransport({expectedBotId:PRODUCT_TELEGRAM_IDENTITY.botId,token:ports.token,fetch:telegramFetch,authorize,now:ms}),
  ...(legacyRecipients?{createLegacyTransport:({authorize}:{authorize:Parameters<typeof createTelegramTransport>[0]['authorize']})=>createTelegramTransport({expectedBotId:PRODUCT_TELEGRAM_IDENTITY.botId,token:ports.token,fetch:telegramFetch,authorize,now:ms})}:{}),
  createTransport:({authorize,job,renderKey})=>createTelegramTransport({expectedBotId:PRODUCT_TELEGRAM_IDENTITY.botId,token:ports.token,fetch:telegramFetch,authorize,now:ms,
   renderPhoto:async(request,signal)=>{if(signal.aborted||request.renderKey!==renderKey||request.operationId!==job.operationId||request.recipientRef!==job.recipientRef||!job.payload.schedule)throw Error('CANONICAL_RENDER_SCOPE');
    const svg=renderScheduleSvg(job.payload.schedule,'day','light',now(),'telegram');
    const png=await sharp(Buffer.from(svg)).png().toBuffer();if(signal.aborted)throw Error('CANONICAL_RENDER_ABORTED');return png;},
  }),
 });
 const releaseCampaign=ports.releaseCampaign?createProductionReleaseCampaign({enabled:policy.telegramDeliveryEnabled,configuration:ports.releaseCampaign,
  expectedControlEpoch:epoch,pool,dispatcher,eligibility:eligibility.campaignEligibility,
  legacyRecipients:legacyRecipients??{prepare:async()=>null},fetch:ports.fetch,now:ms}):undefined;
 if(ports.releaseCampaign&&(!policy.telegramDeliveryEnabled||!legacyRecipients))throw Error('CANONICAL_RELEASE_CAMPAIGN_CONFIGURATION_REQUIRED');
 let ready=false,started=false,stopped=false;const timers=new Set<ReturnType<typeof setTimeout>>(),running=new Set<Promise<unknown>>(),abort=new AbortController();
 const status={context:'waiting',source:'waiting',processor:'waiting',delivery:'waiting',callbacks:'waiting',notifications:'waiting',releaseCampaign:releaseCampaign?'waiting':'disabled'};
 async function prepare(){
  if(started||stopped)throw Error('CANONICAL_RUNTIME_STATE');
  ready=false;status.context='waiting';
  const client=await pool.connect();try{
   await client.query('begin read only');
   const rows=(await client.query('select control_epoch,writer_mode from lba_production_control where id=true')).rows;
   if(rows.length!==1||rows[0].writer_mode!=='canonical'||Number(rows[0].control_epoch)!==epoch)throw Error('CANONICAL_CONTROL_NOT_INSTALLED');
   const tables=CANONICAL_REQUIRED_RELATIONS;
   for(const table of tables){const result=(await client.query('select to_regclass($1) as relation',['public.'+table])).rows;if(!result[0]?.relation)throw Error('CANONICAL_SCHEMA_NOT_INSTALLED');}
   if(policy.telegramDeliveryEnabled){const bot=(await client.query('select bot_id,hold_reason from lba_production_telegram_bot_state where bot_id=$1',[PRODUCT_TELEGRAM_IDENTITY.botId])).rows;
    if(bot.length!==1||bot[0].hold_reason!==null)throw Error('CANONICAL_BOT_STATE_NOT_READY');}
   await client.query('commit');
  }catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
  await flow.refreshOwned();await data.refresh();ready=true;status.context='ready';
 }
 function loop(name:keyof typeof status,delay:number,operation:()=>Promise<unknown>){
  const tick=()=>{if(stopped)return;const task=operation().then(result=>{status[name]=result&&typeof result==='object'?'observed':'ready';},()=>{status[name]='unavailable';})
   .finally(()=>{running.delete(task);if(!stopped){const timer=setTimeout(()=>{timers.delete(timer);tick();},delay);timers.add(timer);}});running.add(task);};tick();
 }
 function start(){if(!ready||started||stopped)throw Error('CANONICAL_RUNTIME_NOT_PREPARED');started=true;
  loop('context',5000,async()=>{await flow.refreshOwned();await data.refresh();});
  if(policy.sourceIngestionEnabled)loop('source',1000,async()=>{const result=await sources.refreshOnce();await data.refresh(true);return result;});
  if(policy.telegramUpdatesEnabled)loop('processor',250,()=>processor.processNext());
  if(policy.notificationSchedulerEnabled)loop('notifications',1000,()=>eventProducer.runOnce({signal:abort.signal}));
  if(policy.telegramDeliveryEnabled)loop('delivery',100,()=>dispatcher.dispatchNextPending(abort.signal));
  if(policy.telegramUpdatesEnabled&&policy.telegramDeliveryEnabled)loop('callbacks',50,()=>dispatcher.dispatchNextCallbackAck(abort.signal));
  if(releaseCampaign)loop('releaseCampaign',1000,()=>releaseCampaign.runOnce({signal:abort.signal}));
 }
 async function stop(){stopped=true;ready=false;abort.abort();releaseCampaign?.stop();for(const timer of timers)clearTimeout(timer);timers.clear();await Promise.allSettled([...running]);await eventProducer.stop();}
 return Object.freeze({store,flow,tools,accounts,finishVerifiedLogin,events,morningBriefing,eventProducer,legacyRecipients,sources,catalog,processor,dispatcher,eligibility,releaseCampaign,prepare,start,stop,
  health:()=>({ready,started,stopped,workers:{...status},deliveryReady:Boolean(ready&&started&&policy.telegramDeliveryEnabled),notificationsReady:Boolean(ready&&started&&policy.notificationSchedulerEnabled&&policy.telegramDeliveryEnabled),scheduleCertificationRequired:true,accountLinksReady:Boolean(policy.accountLinksEnabled&&accounts&&(ports.accountConfiguration?.miniApp||ports.accountConfiguration?.browserWidget)),authEpochReady:Boolean(ports.authorizePrincipal&&accounts),releaseCampaign:releaseCampaign?.health()??{configured:false,state:'disabled'}})});
}
