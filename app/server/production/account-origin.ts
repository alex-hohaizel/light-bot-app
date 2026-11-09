import type {RequestHandler} from 'express';
/** Cookie-authenticated account mutations require the real first-party Origin.
 * Signed Telegram proof receive is separately HMAC checked by its own route. */
export function createAccountOriginGuard(origin:string):RequestHandler{
 const expected=new URL(origin);if(expected.protocol!=='https:'||expected.origin!==origin||expected.username||expected.password)throw Error('ACCOUNT_ORIGIN_CONFIGURATION');
 return(req,res,next)=>{
  const supplied=req.headers.origin,site=req.headers['sec-fetch-site'];
  if(site==='cross-site'||supplied!==undefined&&supplied!==origin||req.method!=='GET'&&supplied!==origin)return void res.status(403).json({code:'ACCOUNT_ORIGIN_REJECTED',error:'Відкрийте цю дію в застосунку.'});
  next();
 };
}
