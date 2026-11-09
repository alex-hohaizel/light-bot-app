import {verifyTelegramInitData,verifyTelegramLoginData,type VerifiedTelegramUser} from '../telegram-init-data.ts';
import type {createAuthReplayGuard,VerifiedAuthProof} from './auth-replay.ts';

type ReplayGuard=ReturnType<typeof createAuthReplayGuard>;
export interface TelegramLoginSession {
 id:string;
 currentOwnerId:string|null;
 /** Resolves only after the established session mechanism persisted/regenerated the session. */
 login(ownerId:string,firstName:string):Promise<string>;
 /** Clears/destroys a newly issued session if its proof cannot be durably bound. */
 invalidate():Promise<void>;
  verified?:(input:{user:VerifiedTelegramUser;kind:VerifiedAuthProof['kind']})=>Promise<void>;
}
/** Cryptographic verification always precedes replay reservation, identity lookup and session writes. */
export function createTelegramAuthFlow(ports:{token:string;botId:string;now:()=>number;guard:ReplayGuard;
 resolveUser(user:VerifiedTelegramUser):Promise<string>}){
 if(!/^[1-9]\d{0,15}$/.test(ports.botId)||ports.token.split(':')[0]!==ports.botId||typeof ports.now!=='function')throw Error('TELEGRAM_AUTH_CONFIGURATION');
 async function finish(user:VerifiedTelegramUser,kind:VerifiedAuthProof['kind'],signature:string,session:TelegramLoginSession){
  const fresh=()=>{const now=ports.now();if(!Number.isSafeInteger(now)||now-user.authDate>(kind==='mini_app'?3600:86400)||user.authDate-now>30)throw Error('AUTH_REPLAY_EXPIRED');};
  const reservation=await ports.guard.reserve({kind,botId:ports.botId,subjectId:user.id,authDate:user.authDate,signature},session.id);
  fresh();
  if(reservation.kind==='bound'){
   if(session.currentOwnerId!==reservation.ownerId)throw Error('AUTH_REPLAY_REOPEN_REQUIRED');
   return {ownerId:reservation.ownerId,firstName:user.firstName,alreadyAuthenticated:true};
  }
  const ownerId=await ports.resolveUser(user);
  fresh();
  if(typeof ownerId!=='string'||!ownerId.trim()||ownerId.length>255||/[\u0000-\u001f]/.test(ownerId))throw Error('TELEGRAM_AUTH_OWNER_INVALID');
  let loginStarted=false;
  try{
   fresh();loginStarted=true;const newSessionId=await session.login(ownerId,user.firstName);fresh();
   await ports.guard.bind(reservation,newSessionId,ownerId);
   await session.verified?.({user,kind});
  }catch(error){
   if(loginStarted)try{await session.invalidate();}catch{throw Error('AUTH_SESSION_CLEANUP_UNCONFIRMED');}
   throw error;
  }
  return {ownerId,firstName:user.firstName,alreadyAuthenticated:false};
 }
 return {
  mini(raw:unknown,session:TelegramLoginSession){
   const user=verifyTelegramInitData(raw,ports.token,{nowSeconds:ports.now()});
   if(new URLSearchParams(raw as string).get('start_param')?.startsWith('acctlink_'))throw Error('AUTH_PROOF_PURPOSE_MISMATCH');
   return finish(user,'mini_app',new URLSearchParams(raw as string).get('hash')!,session);
  },
  login(raw:unknown,session:TelegramLoginSession){
   const user=verifyTelegramLoginData(raw,ports.token,ports.now());
   return finish(user,'login',(raw as {hash:string}).hash,session);
  },
 };
}
