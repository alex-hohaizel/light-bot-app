import {randomUUID} from 'node:crypto';
import {readOwnerAuthEpoch} from './account-links.ts';
import type {AccountLinkService} from './account-links.ts';
import type {createProductionProfileStore} from './profile-store.ts';
/** Only a completed provider verification/login callback may invoke this hook.
 * It is never an HTTP body, refresh-token assertion or ordinary profile read. */
export interface VerifiedProviderSession {req:any;provider:'telegram'|'replit';providerId:string;verifiedAt:number}
export type VerifiedSessionHook=(input:VerifiedProviderSession)=>Promise<void>;
export function createVerifiedSessionFinalizer(ports:{store:Pick<ReturnType<typeof createProductionProfileStore>,'withLockedProfile'>;accounts:Pick<AccountLinkService,'recordVerifiedLogin'>;now:()=>number}):VerifiedSessionHook{
 return async({req,provider,providerId,verifiedAt})=>{
  const owner=req.user?.claims?.sub;
  if(typeof owner!=='string'||!owner||typeof req.sessionID!=='string'||!req.sessionID||!req.session?.save||!Number.isSafeInteger(verifiedAt))throw Error('AUTH_VERIFIED_SESSION_UNCONFIRMED');
  const authEpoch=await ports.store.withLockedProfile({kind:'verified_server_principal',verified:true,ownerId:owner},undefined,async({client})=>{
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:'+provider+':'+providerId]);
   const links=(await client.query('select l.user_id from linked_accounts l join users u on u.id=l.user_id where l.provider=$1 and l.provider_id=$2 for share of l,u',[provider,providerId])).rows;
   if(links.length!==1||links[0].user_id!==owner)throw Error('AUTH_VERIFIED_IDENTITY_CHANGED');
   return readOwnerAuthEpoch(client,owner);
  },{isolation:'read committed'});
  req.user.authEpoch=authEpoch;req.user.providerIdentity={issuer:provider,subject:providerId};
  if(!req.session.passport)throw Error('AUTH_VERIFIED_SESSION_UNCONFIRMED');req.session.passport.user=req.user;
  await new Promise<void>((resolve,reject)=>req.session.save((error:unknown)=>error?reject(Error('AUTH_SESSION_SAVE_FAILED')):resolve()));
  const now=ports.now();
  // A still-valid old Mini App proof permits login, but cannot pretend that the
  // alternative login was freshly verified for a sensitive unlink action.
  if(verifiedAt>now||now-verifiedAt>30)return;
  await ports.accounts.recordVerifiedLogin({kind:'verified_server_principal',verified:true,ownerId:owner,webSessionId:req.sessionID,authEpoch},
   {receiptId:randomUUID(),provider,providerId,verifiedAt:new Date(verifiedAt*1000).toISOString(),validUntil:new Date(Math.min(verifiedAt+900,req.user.expires_at)*1000).toISOString()});
 };
}
