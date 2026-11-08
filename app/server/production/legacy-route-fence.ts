import type {RequestHandler} from 'express';

/** The canonical replacement must register before this fence. Never let old clients
 * reach legacy identity reassignment, dual writers or uncontrolled Telegram sends.
 * This is a deployment-preparation boundary, not a claim of feature parity.
 */
export function legacyProductionRouteFence():RequestHandler {
 const exact=new Set([
  '/api/auth/link-telegram','/api/auth/unlink','/api/auth/telegram-auto','/api/auth/telegram-link-token',
  '/api/auth/telegram-login-request','/api/auth/telegram-login-poll',
  '/api/admin/broadcast','/api/user/settings','/api/user/settings-beacon','/api/user/settings-stream',
  '/api/queues','/api/schedule','/api/street-queue','/api/address-queue',
 ]);
 return(req,res,next)=>{
  const path=req.path.toLowerCase().replace(/\/+$/,'');
  if(exact.has(path)||/^\/api\/notify\/telegram(?:\/|$)/.test(path)||/^\/api\/user\/locations(?:[-/]|$)/.test(path)||
    /^\/api\/reports(?:\/|$)/.test(path)||/^\/api\/user\/digests?(?:\/|$)/.test(path)||/^\/api\/share(?:\/|$)/.test(path)||
    /^\/api\/schedule(?:\/|$)/.test(path)||/^\/api\/geocode(?:\/|$)/.test(path)||/^\/api\/compare\/(?:share|data)(?:\/|$)/.test(path)){
   res.setHeader('Cache-Control','no-store');
   return res.status(503).json({code:'LEGACY_OPERATION_REPLACEMENT_REQUIRED',error:'Ця дія ще проходить перевірку в оновленій версії. Ваші збережені дані не змінено.'});
  }
  return next();
 };
}
