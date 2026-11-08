import type {Express,RequestHandler,Response} from 'express';
import type {createTelegramAuthFlow,TelegramLoginSession} from './telegram-auth-flow.ts';

type Flow=ReturnType<typeof createTelegramAuthFlow>;
/** Uses the established Passport/express-session mechanism. Never accepts a session ID from JSON. */
export function telegramHttpSession(req:any,res:Pick<Response,'clearCookie'>,now:()=>number):TelegramLoginSession {
 if(typeof req.sessionID!=='string'||!req.sessionID||!req.session||typeof req.login!=='function')throw Error('AUTH_SESSION_UNAVAILABLE');
 return {
  id:req.sessionID,
  currentOwnerId:req.isAuthenticated?.()===true&&Number.isSafeInteger(req.user?.expires_at)&&req.user.expires_at>=now()&&typeof req.user?.claims?.sub==='string'?req.user.claims.sub:null,
  async login(ownerId,firstName){
   await new Promise<void>((resolve,reject)=>req.login({claims:{sub:ownerId,first_name:firstName},expires_at:now()+7*86400},(error:unknown)=>error?reject(Error('AUTH_SESSION_LOGIN_FAILED')):resolve()));
   if(typeof req.sessionID!=='string'||!req.sessionID||!req.session||typeof req.session.save!=='function')throw Error('AUTH_SESSION_UNAVAILABLE');
   await new Promise<void>((resolve,reject)=>req.session.save((error:unknown)=>error?reject(Error('AUTH_SESSION_SAVE_FAILED')):resolve()));
   return req.sessionID;
  },
  async invalidate(){
   const session=req.session;req.user=undefined;
   // Suppress issuing the newly created cookie even if the backing store cannot confirm deletion.
   res.clearCookie('connect.sid',{path:'/',httpOnly:true,secure:true});
   try{
    if(!session||typeof session.destroy!=='function')throw Error('AUTH_SESSION_DESTROY_FAILED');
    await new Promise<void>((resolve,reject)=>session.destroy((error:unknown)=>error?reject(Error('AUTH_SESSION_DESTROY_FAILED')):resolve()));
   }finally{req.session=null;}
  },
 };
}
export function registerTelegramProofRoutes(app:Express,ports:{
 enabled:boolean;flow:()=>Flow;now:()=>number;limiter:RequestHandler;authenticateSession:RequestHandler;
 mobileToken:(ownerId:string,firstName:string)=>string;
 readUser:(ownerId:string)=>Promise<unknown>;
}){
 const unavailable=(res:Response)=>res.status(503).json({error:'Вхід через Telegram тимчасово недоступний. Спробуйте пізніше.'});
 const failed=(res:Response)=>res.status(401).json({error:'Вхід через Telegram не підтверджений або застарів. Відкрийте застосунок у боті ще раз.'});
 app.get('/api/auth/telegram',ports.limiter,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');if(!ports.enabled)return unavailable(res);
  try{await ports.flow().login(req.query,telegramHttpSession(req,res,ports.now));return res.redirect('/');}catch{return failed(res);}
 });
 app.post('/api/auth/telegram-webapp',ports.limiter,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');if(!ports.enabled)return unavailable(res);
  try{await ports.flow().mini(req.body?.initData,telegramHttpSession(req,res,ports.now));return res.json({ok:true});}catch{return failed(res);}
 });
 app.post('/api/auth/mobile-token',ports.limiter,async(req:any,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.body?.telegramData!==undefined){
   if(!ports.enabled)return unavailable(res);
   try{
    const value=await ports.flow().login(req.body.telegramData,telegramHttpSession(req,res,ports.now));
    const user=await ports.readUser(value.ownerId);
    const token=ports.mobileToken(value.ownerId,value.firstName);
    return res.json({token,user:user??{id:value.ownerId,firstName:value.firstName},expiresIn:'30d'});
   }catch{return failed(res);}
  }
  // Existing authenticated sessions still work; an unverified req.user is insufficient.
  return ports.authenticateSession(req,res,(error?:unknown)=>{
   if(error)return next(error);
   void(async()=>{
    const owner=req.user?.claims?.sub,firstName=req.user?.claims?.first_name;
    if(typeof owner!=='string'||!owner.trim())return res.sendStatus(401);
    const user=await ports.readUser(owner),token=ports.mobileToken(owner,typeof firstName==='string'?firstName:'');
    return res.json({token,user:user??{id:owner,firstName},expiresIn:'30d'});
   })().catch(()=>unavailable(res));
  });
 });
}
