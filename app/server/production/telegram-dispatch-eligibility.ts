import {createHash} from 'node:crypto';
import {restoreBotState} from '../../shared/bot/engine.ts';
import {globalNotificationPolicy} from '../../shared/notification-policy.ts';
import {validInstant} from '../../shared/schedule-core.ts';
import {campaignOperationId,campaignSpecHash} from '../release/update-campaign.ts';
import type {CampaignRecipientEligibility} from '../release/update-campaign-pg.ts';
import type {DispatchClient,DispatchEligibility,DispatchEligibilityRequest,DispatchOptions} from './telegram-dispatch.ts';
import type {createLegacyCampaignRecipients} from './legacy-campaign-recipient.ts';

const BOT='8577497098' as const;
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text=(v:unknown,max=255):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const numeric=(v:unknown):v is string=>text(v,16)&&/^[1-9]\d{0,15}$/.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)<=2**52-1;
const decoded=(v:any)=>typeof v==='string'?JSON.parse(v):v;
/** Historical canonical bootstrap proof, not a client-supplied empty-profile claim. */
export function verifiedEmptyReplyOrigin(row:any,ownerId:string,now:string):boolean{
 const proof=decoded(row?.provenance)?.emptyAccountProof,keys=['kind','ownerId','accountState','accountRevisionId','evidenceRef','legacySourceDigest','verifiedAt'];
 return row?.originKind==='verified_empty'&&typeof row.sourceDigest==='string'&&/^[a-f0-9]{64}$/.test(row.sourceDigest)&&row.bootstrapDigest===row.sourceDigest&&
  Boolean(proof&&typeof proof==='object'&&!Array.isArray(proof)&&Object.keys(proof).length===keys.length&&Object.keys(proof).every(k=>keys.includes(k))&&proof.kind==='verified_empty_account'&&proof.ownerId===ownerId&&['new','existing_empty'].includes(proof.accountState)&&text(proof.accountRevisionId,160)&&text(proof.evidenceRef)&&proof.legacySourceDigest===row.sourceDigest&&validInstant(proof.verifiedAt)&&validInstant(now)&&Date.parse(proof.verifiedAt)<=Date.parse(now));
}
export function telegramOwnerRecipientRef(ownerId:string):string{if(!text(ownerId))throw Error('INVALID_TELEGRAM_OWNER');return 'owner:'+sha(ownerId).slice(0,40);}
export interface CurrentDispatchSourceProof {
 sourceRevision:string;expiresAt:string;eventProof?:Extract<DispatchEligibility,{eligible:true}>['eventProof'];
}
/** No pool/env/network/schema writer. Every read uses the coordinator's existing TX. */
export function createSqlTelegramDispatchEligibility(options:{expectedBotId:typeof BOT;expectedControlEpoch:number;grantTtlMs?:number;now?:()=>number;
 verifySource?:(request:DispatchEligibilityRequest)=>Promise<CurrentDispatchSourceProof|null>;
 legacyRecipients?:Pick<ReturnType<typeof createLegacyCampaignRecipients>,'resolve'>;
}){
 const epoch=options.expectedControlEpoch,ttl=options.grantTtlMs??1000,clock=options.now??Date.now;
 if(options.expectedBotId!==BOT||!Number.isSafeInteger(epoch)||epoch<1||!Number.isInteger(ttl)||ttl<1||ttl>5000||options.verifySource!==undefined&&typeof options.verifySource!=='function'||options.now!==undefined&&typeof options.now!=='function')throw Error('INVALID_TELEGRAM_SQL_ELIGIBILITY');
 function current(after:string):string|null{try{const ms=clock();return validInstant(after)&&Number.isSafeInteger(ms)&&ms>=Date.parse(after)?new Date(ms).toISOString():null;}catch{return null;}}
 async function mapping(client:Pick<DispatchClient,'query'>,owner:string,expectedSession?:string,emptyReplyAt?:string){
  const rows=(await client.query(`select p.owner_id as "ownerId",p.session_id as "sessionId",p.revision,p.state,p.control_epoch as "profileEpoch",o.control_epoch as "originEpoch",o.private_provenance as provenance,o.source_digest as "sourceDigest",b.control_epoch as "bootstrapEpoch",b.session_id as "bootstrapSession",b.origin_kind as "originKind",b.source_digest as "bootstrapDigest" from lba_production_profiles p join lba_production_profile_origins o on o.owner_id=p.owner_id join lba_production_bootstrap_ledger b on b.owner_id=p.owner_id where p.owner_id=$1 for share of p,o,b`,[owner])).rows;
  if(rows.length!==1)return null;const row=rows[0];if(row.ownerId!==owner||[row.profileEpoch,row.originEpoch,row.bootstrapEpoch].some(v=>Number(v)!==epoch)||row.sessionId!==row.bootstrapSession||expectedSession!==undefined&&row.sessionId!==expectedSession)return null;
  let state;try{state=restoreBotState(decoded(row.state),owner);}catch{return null;}
  if(state.sessionId!==row.sessionId||state.revision!==Number(row.revision)||!Number.isSafeInteger(state.revision))return null;
  const links=(await client.query(`select id,user_id as "ownerId",provider_id as "chatId" from linked_accounts where provider='telegram' and user_id=$1 order by id limit 3 for share`,[owner])).rows;
  if(links.length!==1||!text(links[0].id)||links[0].ownerId!==owner||!numeric(links[0].chatId))return null;const link=links[0];
  const global=(await client.query(`select id,user_id as "ownerId" from linked_accounts where provider='telegram' and provider_id=$1 order by id limit 3 for share`,[link.chatId])).rows;
  if(global.length!==1||global[0].id!==link.id||global[0].ownerId!==owner)return null;
  const users=(await client.query('select id from users where id=$1 for share',[owner])).rows;if(users.length!==1||users[0].id!==owner)return null;
  const subscribers=(await client.query('select chat_id as "chatId",user_id as "ownerId" from telegram_subscribers where chat_id=$1 for share',[link.chatId])).rows;
  const emptyReply=subscribers.length===0&&emptyReplyAt!==undefined&&verifiedEmptyReplyOrigin(row,owner,emptyReplyAt);
  if(!emptyReply&&(subscribers.length!==1||subscribers[0].chatId!==link.chatId||subscribers[0].ownerId!==null&&subscribers[0].ownerId!==owner))return null;
  const provenance=decoded(row.provenance),subscriberOwner=emptyReply?'canonical_verified_empty':subscribers[0].ownerId;
  if(!emptyReply&&subscriberOwner===null&&(!Array.isArray(provenance?.verifiedSubscriberMappings)||!provenance.verifiedSubscriberMappings.some((m:any)=>m?.kind==='verified_telegram_owner_mapping'&&m.ownerId===owner&&m.chatId===link.chatId&&text(m.revisionId))))return null;
  const chatKey=sha([BOT,link.chatId,'private']),reach=(await client.query('select owner_id as "ownerId",recipient_kind as "recipientKind",reachability from lba_production_telegram_chat_state where bot_id=$1 and chat_key=$2 for share',[BOT,chatKey])).rows;
  if(reach.length>1||reach.length===1&&(!(reach[0].ownerId===owner&&(reach[0].recipientKind??'account')==='account'||reach[0].ownerId===null&&reach[0].recipientKind==='legacy_subscription')||!['unknown','reachable'].includes(reach[0].reachability)))return null;
  return {state,chatId:link.chatId,mappingRevision:'mapping:'+sha({owner,session:row.sessionId,linkId:link.id,subscriberOwner}),recipientRef:telegramOwnerRecipientRef(owner)};
 }
 async function ownerForRef(client:Pick<DispatchClient,'query'>,recipientRef:string):Promise<string|null>{
  if(!/^owner:[a-f0-9]{40}$/.test(recipientRef))return null;
  // This is only an owner hint; locked unique ownership is revalidated after the
  // coordinator acquires its owner lock. It never decodes a prefix into identity.
  const rows=(await client.query(`select user_id as "ownerId" from linked_accounts where provider='telegram' and 'owner:'||left(encode(sha256(convert_to(to_json(user_id)::text,'UTF8')),'hex'),40)=$1 order by user_id limit 3`,[recipientRef])).rows;
  const owners=[...new Set(rows.map(r=>r.ownerId))];return owners.length===1&&text(owners[0])&&telegramOwnerRecipientRef(owners[0])===recipientRef?owners[0]:null;
 }
 const resolveEligibility:DispatchOptions['resolveEligibility']=async request=>{
  const {job,profile,now,client}=request;if(request.signal.aborted||!validInstant(now)||job.controlEpoch!==epoch||job.ownerId!==profile.ownerId||job.sessionId!==profile.sessionId||job.recipientRef!==telegramOwnerRecipientRef(job.ownerId))return {eligible:false,reason:'unlinked'};
  // A newly verified canonical owner may explicitly subscribe without an old
  // subscriber row. Campaign eligibility remains limited to its legacy scope.
  const value=await mapping(client,job.ownerId,job.sessionId,job.sourceKind==='profile'?now:undefined);if(!value||value.state.revision!==profile.revision)return {eligible:false,reason:'unlinked'};
  if(job.payload.message.kind==='notification'){try{if(!globalNotificationPolicy(value.state.profile.preferences,'telegram').enabled)return {eligible:false,reason:'paused'};}catch{return {eligible:false,reason:'not_eligible'};}}
  if(job.sourceKind==='campaign'){try{if(!globalNotificationPolicy(value.state.profile.preferences,'telegram').enabled)return {eligible:false,reason:'paused'};}catch{return {eligible:false,reason:'not_eligible'};}}
  let bound=Number.POSITIVE_INFINITY,proof:CurrentDispatchSourceProof|null=null;
  if(job.sourceKind==='campaign'){
   if(!job.payload.campaign)return {eligible:false,reason:'not_eligible'};const current=await resolveCampaignOwner({client,envelope:job.payload.campaign,now,signal:request.signal});
   if(!current||current.ownerId!==job.ownerId)return {eligible:false,reason:'not_eligible'};bound=Math.min(bound,Date.parse(current.expiresAt));
  }
  if(job.payload.schedule||job.payload.briefing){proof=await options.verifySource?.(request)??null;if(!proof||!text(proof.sourceRevision)||job.payload.schedule&&proof.sourceRevision!==job.payload.schedule.source.revision||!validInstant(proof.expiresAt)||Date.parse(proof.expiresAt)<=Date.parse(now))return {eligible:false,reason:'source_unverified'};bound=Math.min(bound,Date.parse(proof.expiresAt));}
  const issuedAt=current(now);if(!issuedAt||request.signal.aborted)return {eligible:false,reason:'not_eligible'};
  if(bound<=Date.parse(issuedAt))return {eligible:false,reason:proof?'source_unverified':'not_eligible'};
  const expiresAt=new Date(Math.min(Date.parse(issuedAt)+ttl,bound)).toISOString();
  return {eligible:true,ownerId:job.ownerId,recipientRef:job.recipientRef,chatId:value.chatId,chatType:'private',mappingRevision:value.mappingRevision,expiresAt,...(proof?{sourceRevision:proof.sourceRevision,...(proof.eventProof?{eventProof:proof.eventProof}:{})}:{})};
 };
 async function campaignLease({client,envelope,now,signal}:Parameters<NonNullable<DispatchOptions['resolveCampaignOwner']>>[0]):Promise<{validUntil:string;checkedAt:string}|null>{
  if(signal.aborted||envelope.botId!==BOT||!validInstant(now))return null;
  // Acquire campaign rows BEFORE the coordinator's canonical owner lock. Its
  // begin()/pause()/finish() writers use the same campaign -> owner order.
  const rows=(await client.query('select c.spec_hash as "specHash",c.record as campaign,j.record as job from lba_release_campaigns c join lba_release_campaign_jobs j on j.release_id=c.release_id where c.release_id=$1 and j.operation_id=$2 for share of c,j',[envelope.releaseId,envelope.operationId])).rows;
  const checkedAt=current(now);if(rows.length!==1||!checkedAt||signal.aborted)return null;const c=decoded(rows[0].campaign),j=decoded(rows[0].job),spec=c?.spec;
  if(!c||!j||!spec||c.specHash!==rows[0].specHash||campaignSpecHash(spec)!==c.specHash||!['pilot','full'].includes(c.phase)||c.phase==='pilot'&&j.cohort!=='pilot'||j.state!=='dispatching'||j.botId!==BOT||j.releaseId!==envelope.releaseId||j.recipientRef!==envelope.recipientRef||j.operationId!==envelope.operationId||envelope.operationId!==campaignOperationId(envelope.releaseId,envelope.recipientRef)||!validInstant(j.leaseUntil)||Date.parse(j.leaseUntil)<=Date.parse(checkedAt)||!validInstant(spec.expiresAt)||Date.parse(spec.expiresAt)<=Date.parse(checkedAt)||['releaseId','deploymentId','buildSha256','botId','origin','text','appUrl'].some(k=>spec[k]!==envelope[k as keyof typeof envelope]))return null;
  // This is the locked lease horizon, not an already-running short grant.
  return {validUntil:new Date(Math.min(Date.parse(j.leaseUntil),Date.parse(spec.expiresAt))).toISOString(),checkedAt};
 }
 const resolveCampaignOwner:NonNullable<DispatchOptions['resolveCampaignOwner']>=async request=>{
  const lease=await campaignLease(request);if(!lease)return null;
  const ownerId=await ownerForRef(request.client,request.envelope.recipientRef),issuedAt=current(lease.checkedAt);
  if(!ownerId||!issuedAt||request.signal.aborted||Date.parse(lease.validUntil)<=Date.parse(issuedAt))return null;
  return {ownerId,expiresAt:new Date(Math.min(Date.parse(issuedAt)+ttl,Date.parse(lease.validUntil))).toISOString()};
 };
 const resolveLegacyCampaignRecipient:NonNullable<DispatchOptions['resolveLegacyCampaignRecipient']>=async request=>{
  const lease=await campaignLease(request);if(!lease||!options.legacyRecipients)return null;
  // resolve issues its short subject only after all locked eligibility and chat
  // reads. No further SQL may consume that subject's freshness budget here.
  const subject=await options.legacyRecipients.resolve(request.client,{recipientRef:request.envelope.recipientRef,now:lease.checkedAt,signal:request.signal});
  if(!subject||subject.botId!==BOT||subject.recipientRef!==request.envelope.recipientRef||!validInstant(subject.expiresAt))return null;
  const issuedAt=current(lease.checkedAt);if(!issuedAt||request.signal.aborted||Date.parse(subject.expiresAt)<=Date.parse(issuedAt)||Date.parse(lease.validUntil)<=Date.parse(issuedAt))return null;
  return {...subject,expiresAt:new Date(Math.min(Date.parse(issuedAt)+ttl,Date.parse(subject.expiresAt),Date.parse(lease.validUntil))).toISOString()};
 };
 const campaignEligibility:CampaignRecipientEligibility={async enabled(client,recipientRef,botId,now){
  if(botId!==BOT||!validInstant(now))return false;
  if(recipientRef.startsWith('legacy:')){
   const subject=await options.legacyRecipients?.resolve(client,{recipientRef,now,signal:new AbortController().signal});return Boolean(subject&&subject.kind==='legacy_subscription'&&subject.botId===BOT&&subject.recipientRef===recipientRef&&validInstant(subject.expiresAt)&&Date.parse(subject.expiresAt)>Date.parse(now));
  }
  const owner=await ownerForRef(client,recipientRef);if(!owner)return false;
  // Canonical writer order: release-campaign transaction -> owner -> current rows.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba-production-owner:'+owner]);
  const current=await mapping(client,owner);if(!current)return false;try{return globalNotificationPolicy(current.state.profile.preferences,'telegram').enabled;}catch{return false;}
 }};
 return Object.freeze({resolveEligibility,resolveCampaignOwner,campaignEligibility,...(options.legacyRecipients?{resolveLegacyCampaignRecipient}:{})});
}
