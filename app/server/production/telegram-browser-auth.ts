import {createHmac,randomBytes} from 'node:crypto';
import type {Express,RequestHandler,Response} from 'express';
import type {AuthReplayPool} from './auth-replay.ts';
import type {createTelegramAuthFlow,TelegramLoginSession} from './telegram-auth-flow.ts';
import type {VerifiedTelegramUser} from '../telegram-init-data.ts';

export const BROWSER_TELEGRAM_AUTH_SCHEMA_SQL=`create table if not exists lba_telegram_browser_challenge(
 challenge_key text primary key, session_binding text not null, origin text not null,
 expires_at timestamptz not null, consumed_at timestamptz,
 created_at timestamptz not null default now()
);create index if not exists lba_telegram_browser_challenge_expiry on lba_telegram_browser_challenge(expires_at);`;

function browserOrigin(value:string){
 let url:URL;try{url=new URL(value);}catch{throw Error('TELEGRAM_BROWSER_CONFIGURATION');}
 if(url.origin!==value||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('TELEGRAM_BROWSER_CONFIGURATION');
 return value;
}
/** A durable, short-lived, one-attempt CSRF challenge. No pool/schema/network is created on import. */
export function createTelegramBrowserChallenges(pool:AuthReplayPool,options:{key:string;now:()=>number;origin:string}){
 const origin=browserOrigin(options.origin);
 if(!pool||typeof pool.connect!=='function'||typeof options.key!=='string'||options.key.length<32||typeof options.now!=='function')throw Error('TELEGRAM_BROWSER_CONFIGURATION');
 const mac=(purpose:string,value:string)=>createHmac('sha256',options.key).update(JSON.stringify(['telegram-browser/1',purpose,value])).digest('hex');
 const session=(id:string)=>{if(typeof id!=='string'||!id||id.length>512)throw Error('TELEGRAM_BROWSER_SESSION');return mac('session',id);};
 const now=()=>{const value=options.now();if(!Number.isSafeInteger(value)||value<0)throw Error('TELEGRAM_BROWSER_CLOCK');return value;};
 async function query(sql:string,values:any[]){const client=await pool.connect();try{return await client.query(sql,values);}finally{client.release();}}
 return {
  async issue(sessionId:string){
   const binding=session(sessionId),issuedAt=now(),expiresAt=issuedAt+300,challenge=randomBytes(32).toString('base64url');
   await query('insert into lba_telegram_browser_challenge(challenge_key,session_binding,origin,expires_at) values($1,$2,$3,$4)',[mac('challenge',challenge),binding,origin,new Date(expiresAt*1000).toISOString()]);
   // Only expired attempts are deleted. A consumed challenge cannot be reopened by a restart.
   await query('delete from lba_telegram_browser_challenge where expires_at < $1',[new Date((issuedAt-86400)*1000).toISOString()]);
   if(now()>=expiresAt)throw Error('TELEGRAM_BROWSER_EXPIRED');
   return {challenge,expiresAt};
  },
  async consume(challenge:unknown,sessionId:string){
   if(typeof challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(challenge))throw Error('TELEGRAM_BROWSER_CHALLENGE');
   const binding=session(sessionId),at=now();
   const result=await query(`update lba_telegram_browser_challenge set consumed_at=$4
    where challenge_key=$1 and session_binding=$2 and origin=$3 and consumed_at is null and expires_at>$4 returning expires_at`,
    [mac('challenge',challenge),binding,origin,new Date(at*1000).toISOString()]);
   if(result.rowCount!==1||now()*1000>=new Date(result.rows[0].expires_at).getTime())throw Error('TELEGRAM_BROWSER_CHALLENGE');
  },
 };
}
type BrowserChallenges=ReturnType<typeof createTelegramBrowserChallenges>;
type TelegramFlow=ReturnType<typeof createTelegramAuthFlow>;
/** Browser Login Widget callbacks POST to their initiating cookie session. Signed GET login is deliberately absent. */
export function registerTelegramBrowserAuthRoutes(app:Express,ports:{
 enabled:boolean;origin:string;botUsername:string;challenges:BrowserChallenges;limiter:RequestHandler;
 flow:()=>TelegramFlow;session:(req:any,res:Response)=>TelegramLoginSession;
 verifyLogin:(raw:unknown)=>VerifiedTelegramUser;
 saveAnonymousSession:(req:any)=>Promise<void>;
}){
 const origin=browserOrigin(ports.origin);
 if(!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(ports.botUsername))throw Error('TELEGRAM_BROWSER_CONFIGURATION');
 const fail=(res:Response,status:number,code:string)=>res.status(status).json({code,error:status===503?'Вхід через Telegram тимчасово недоступний. Спробуйте інший спосіб входу.':'Не вдалося підтвердити вхід. Почніть нову спробу в цій вкладці.'});
 function allowed(req:any,res:Response){
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  if(!ports.enabled){fail(res,503,'TELEGRAM_BROWSER_UNAVAILABLE');return false;}
  if(req.headers?.origin!==origin||req.headers?.['sec-fetch-site']==='cross-site'){fail(res,403,'TELEGRAM_BROWSER_ORIGIN');return false;}
  if(!req.is?.('application/json')||!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.query||{}).length){fail(res,400,'TELEGRAM_BROWSER_REQUEST');return false;}
  return true;
 }
 app.post('/api/auth/telegram-browser/challenge',ports.limiter,async(req:any,res)=>{
  if(!allowed(req,res))return;
  if(Object.keys(req.body).length)return fail(res,400,'TELEGRAM_BROWSER_REQUEST');
  try{
   await ports.saveAnonymousSession(req);
   const challenge=await ports.challenges.issue(req.sessionID);
   return res.json({...challenge,botUsername:ports.botUsername});
  }catch{return fail(res,503,'TELEGRAM_BROWSER_UNAVAILABLE');}
 });
 app.post('/api/auth/telegram-browser/complete',ports.limiter,async(req:any,res)=>{
  if(!allowed(req,res))return;
  if(Object.keys(req.body).sort().join(',')!=='challenge,telegramData')return fail(res,400,'TELEGRAM_BROWSER_REQUEST');
  try{
   // Verify the provider proof before even reading or consuming the anonymous challenge.
   // The existing flow repeats its own HMAC/freshness check and durable proof replay fence.
   ports.verifyLogin(req.body.telegramData);
   await ports.challenges.consume(req.body.challenge,req.sessionID);
   await ports.flow().login(req.body.telegramData,ports.session(req,res));
   return res.json({ok:true});
  }catch{return fail(res,401,'TELEGRAM_BROWSER_UNCONFIRMED');}
 });
}
