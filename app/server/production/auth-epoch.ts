import {AsyncLocalStorage} from 'node:async_hooks';
import type {RequestHandler,Request} from 'express';
import type {LegacyProfileReadPool,LegacyProfileReadQuery,VerifiedLegacyPrincipal} from './profile-reader.ts';
import {AccountLinkError,checkOwnerAuthEpoch,readOwnerAuthEpoch,type AccountLinkPrincipal} from './account-links.ts';

type VerifiedMobile={sub:unknown;authEpoch?:unknown};
type Credential={ownerId:string;authEpoch:number;webSessionId:string|null};
const text=(v:unknown,max=512):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const epoch=(v:unknown)=>v===undefined?0:typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
/** Cookie/token signature verification is upstream. Every checked request gets
 * its own immutable server context; a second check runs under the canonical
 * owner lock so a queued write cannot survive an intervening account unlink. */
export function createOwnerAuthEpoch(ports:{pool:LegacyProfileReadPool;verifyMobile:(token:string)=>VerifiedMobile|null;now:()=>number}){
 const requests=new AsyncLocalStorage<Readonly<Credential>>();
 function credential(req:Request,requireFreshExpiry=true):Credential|null{
  const r=req as any,header=req.headers.authorization;
  if(header!==undefined){
   if(typeof header!=='string'||!header.startsWith('Bearer '))return null;
   const v=ports.verifyMobile(header.slice(7)),issued=epoch(v?.authEpoch);
   return v&&text(v.sub,255)&&issued!==null?{ownerId:v.sub,authEpoch:issued,webSessionId:null}:null;
  }
  const user=r.user,issued=epoch(user?.authEpoch);
  if(r.isAuthenticated?.()!==true||!text(user?.claims?.sub,255)||issued===null||requireFreshExpiry&&(!Number.isSafeInteger(user.expires_at)||user.expires_at<=ports.now()))return null;
  return {ownerId:user.claims.sub,authEpoch:issued,webSessionId:text(r.sessionID)?r.sessionID:null};
 }
 async function current(value:Credential){const client=await ports.pool.connect();try{return await checkOwnerAuthEpoch(client,value.ownerId,value.authEpoch);}finally{client.release();}}
 const enforce:RequestHandler=(req,res,next)=>{
  const path=req.path;
  // Fresh cryptographic login replaces an old cookie. Proof receive and exact
  // account-operation recovery have their own separate closed authenticators.
  if(!path.startsWith('/api/')||['/api/auth/telegram','/api/auth/telegram-webapp','/api/auth/telegram-browser/challenge','/api/auth/telegram-browser/complete','/api/product/accounts/telegram/proof','/api/product/accounts/recover','/api/auth/logout'].includes(path)||
    path==='/api/auth/mobile-token'&&req.method==='POST'&&req.body?.telegramData!==undefined||
    req.method==='GET'&&/^\/api\/product\/shared\/[a-f0-9]{48}$/.test(path))return next();
  const value=credential(req,false);
  if(!value){if(req.headers.authorization!==undefined||(req as any).isAuthenticated?.()===true)return void res.sendStatus(401);return next();}
  void current(value).then(allowed=>{if(!allowed){res.status(401).json({code:'AUTH_SESSION_REVOKED',error:'Увійдіть знову після зміни під’єднаних акаунтів.'});return;}requests.run(Object.freeze({...value}),()=>next());})
   .catch(()=>res.status(503).json({code:'AUTH_UNCONFIRMED',error:'Не вдалося перевірити вхід. Повторіть спробу.'}));
 };
 async function accountPrincipal(req:Request,recovery=false):Promise<AccountLinkPrincipal>{
  const value=credential(req);if(!value?.webSessionId||!recovery&&!await current(value))throw new AccountLinkError('ACCOUNT_AUTH_REQUIRED');
  return {kind:'verified_server_principal',verified:true,ownerId:value.ownerId,webSessionId:value.webSessionId,authEpoch:value.authEpoch};
 }
 async function sessionIsCurrent(req:Request){
  const r=req as any,user=r.user,issued=epoch(user?.authEpoch);
  if(r.isAuthenticated?.()!==true||!text(r.sessionID)||!text(user?.claims?.sub,255)||issued===null||!Number.isSafeInteger(user.expires_at)||user.expires_at<=ports.now())return false;
  return current({ownerId:user.claims.sub,authEpoch:issued,webSessionId:r.sessionID});
 }
 const authorizePrincipal=async({client,principal}:{client:LegacyProfileReadQuery;principal:VerifiedLegacyPrincipal})=>{
  const request=requests.getStore();return !request||request.ownerId===principal.ownerId&&await checkOwnerAuthEpoch(client,principal.ownerId,request.authEpoch);
 };
 async function issueEpoch(ownerId:string){const client=await ports.pool.connect();try{return await readOwnerAuthEpoch(client,ownerId);}finally{client.release();}}
 return Object.freeze({enforce,accountPrincipal,sessionIsCurrent,authorizePrincipal,issueEpoch});
}
