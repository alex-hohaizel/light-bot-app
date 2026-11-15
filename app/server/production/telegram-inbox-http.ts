import type {Express,Request} from 'express';
import {TELEGRAM_INBOX_VERSION,type TelegramInbox} from './telegram-inbox.ts';
import {PRODUCT_TELEGRAM_IDENTITY} from './product-identity.ts';
import {validInstant} from '../../shared/schedule-core.ts';

/** HTTP acknowledgement means durable ingress only. Processing/sending is a separate
 * explicit service; this route never invokes the old bot handler as a fallback.
 */
export function registerTelegramInboxRoute(app:Express,ports:{enabled:boolean;expectedControlEpoch:number|null;inbox:()=>TelegramInbox}){
 if(typeof ports.enabled!=='boolean'||typeof ports.inbox!=='function'||ports.enabled&&(!Number.isSafeInteger(ports.expectedControlEpoch)||Number(ports.expectedControlEpoch)<1))throw Error('TELEGRAM_INBOX_HTTP_CONFIGURATION');
 app.post('/api/telegram-webhook',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!ports.enabled)return res.sendStatus(503);
  try{
   const result=await ports.inbox().accept(req.headers['x-telegram-bot-api-secret-token'],(req as Request&{rawBody?:unknown}).rawBody);
   if(result.ack===true&&result.status==='committed'){
    const r=result.receipt,fields=['version','phase','botId','updateId','disposition','ignoredReason','controlEpoch','receivedAt'];
    const ignored=['unsupported_update','unsupported_chat','unsupported_message_content','inline_callback','inaccessible_callback','unsupported_callback'];
    if(r&&typeof r==='object'&&!Array.isArray(r)&&[Object.prototype,null].includes(Object.getPrototypeOf(r))&&
     Object.keys(r).length===fields.length&&fields.every(k=>Object.hasOwn(r,k))&&r.version===TELEGRAM_INBOX_VERSION&&
     r.phase==='ingress_committed'&&r.botId===PRODUCT_TELEGRAM_IDENTITY.botId&&r.controlEpoch===ports.expectedControlEpoch&&
     typeof r.updateId==='string'&&/^[1-9]\d{0,15}$/.test(r.updateId)&&Number.isSafeInteger(Number(r.updateId))&&Number(r.updateId)<=4503599627370495&&
     Number.isSafeInteger(req.body?.update_id)&&String(req.body.update_id)===r.updateId&&validInstant(r.receivedAt)&&
     (r.disposition==='accepted'&&r.ignoredReason===null||r.disposition==='ignored'&&typeof r.ignoredReason==='string'&&ignored.includes(r.ignoredReason)))
      return res.status(200).json({ok:true});
    return res.sendStatus(503);
   }
   if(result.ack===false&&result.code==='TELEGRAM_INBOX_SECRET_INVALID')return res.sendStatus(403);
   if(result.ack===false&&['TELEGRAM_INBOX_PAYLOAD_INVALID','TELEGRAM_INBOX_PAYLOAD_LIMIT','TELEGRAM_INBOX_CALLBACK_INVALID',
    'TELEGRAM_INBOX_CALLBACK_BOT_MISMATCH','TELEGRAM_INBOX_PRIVATE_ACTOR_MISMATCH'].includes(result.code))return res.sendStatus(400);
   return res.sendStatus(503);
  }catch{return res.sendStatus(503);}
 });
}
