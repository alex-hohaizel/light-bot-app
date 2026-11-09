import type {Express,Request,RequestHandler,Response} from 'express';
import {validInstant} from '../../shared/schedule-core.ts';

/** This structural principal must be created by the injected verified session port,
 * never from a body, query, provider subject or header selected by this module. */
export interface AccountLinkHttpPrincipal {kind:'verified_server_principal';verified:true;ownerId:string;webSessionId:string;authEpoch:number}
export interface AccountLinkHttpService {
 listAccounts(principal:AccountLinkHttpPrincipal):Promise<unknown>;
 createChallenge(principal:AccountLinkHttpPrincipal,body:unknown):Promise<unknown>;
 receiveMiniProof(initData:string):Promise<unknown>;
 receiveWidgetProof?(principal:AccountLinkHttpPrincipal,body:unknown):Promise<unknown>;
 inspectChallenge(principal:AccountLinkHttpPrincipal,challengeId:string):Promise<unknown>;
 confirmLink(principal:AccountLinkHttpPrincipal,body:unknown):Promise<unknown>;
 unlink(principal:AccountLinkHttpPrincipal,body:unknown):Promise<unknown>;
 recoverOperation?(principal:AccountLinkHttpPrincipal,body:unknown):Promise<unknown>;
}
export interface AccountLinkHttpPorts {
 enabled?:boolean;telegramLinkingEnabled?:boolean;widgetLinkingEnabled?:boolean;miniAppProofEnabled?:boolean;service:AccountLinkHttpService;authenticate:RequestHandler;
 principal(req:Request):Promise<AccountLinkHttpPrincipal|null>;
 sameOrigin:RequestHandler;limiter:RequestHandler;
 recoveryAuthenticate?:RequestHandler;recoveryPrincipal?:(req:Request)=>Promise<AccountLinkHttpPrincipal|null>;
}
interface Challenge {kind:'challenge';challengeId:string;startParam:string;expiresAt:string;miniAppUrl:string|null;state:'pending';widgetBotUsername?:string}
interface Mutation {kind:'linked'|'unlinked';operationId:string;provider:'telegram'|'replit';linkId:string;authEpoch:number;reauthenticate:boolean}
interface ChallengeStatus {kind:'challenge_status';challengeId:string;state:'pending'|'ready_for_confirmation'|'linked'|'expired';expiresAt:string;accountLabel?:string}
interface Accounts {links:Array<{id:string;provider:'telegram'|'replit';linkRevision:string}>;authEpoch:number}
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=255):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const invalid=():never=>{throw Error('ACCOUNT_HTTP_INVALID_RESULT');};
function closed(value:unknown,fields:readonly string[]):Record<string,unknown>{if(!plain(value)||Object.keys(value).some(k=>!fields.includes(k)))return invalid();return value;}
function checkedPrincipal(value:unknown):AccountLinkHttpPrincipal|null{
 if(!plain(value)||Object.keys(value).sort().join(',')!=='authEpoch,kind,ownerId,verified,webSessionId'||value.kind!=='verified_server_principal'||value.verified!==true||!text(value.ownerId)||!text(value.webSessionId,512)||!Number.isSafeInteger(value.authEpoch)||Number(value.authEpoch)<0)return null;
 return {kind:'verified_server_principal',verified:true,ownerId:value.ownerId,webSessionId:value.webSessionId,authEpoch:Number(value.authEpoch)};
}
function challenge(value:unknown):Challenge{
 const v=closed(value,['kind','challengeId','startParam','expiresAt','miniAppUrl','state','widgetBotUsername']);
 if(v.kind!=='challenge'||!uuid(v.challengeId)||typeof v.startParam!=='string'||!/^acctlink_[a-f0-9]{64}$/.test(v.startParam)||!validInstant(v.expiresAt)||v.state!=='pending')return invalid();
 if(Object.hasOwn(v,'widgetBotUsername')&&(typeof v.widgetBotUsername!=='string'||!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v.widgetBotUsername)))return invalid();
 if(v.miniAppUrl!==null){
  if(!text(v.miniAppUrl,2048)||!v.miniAppUrl.startsWith('https://t.me/')||v.miniAppUrl.includes('#'))return invalid();let u:URL;try{u=new URL(v.miniAppUrl);}catch{return invalid();}
  const parts=u.pathname.split('/').filter(Boolean);
  if(u.protocol!=='https:'||u.hostname!=='t.me'||u.port||u.username||u.password||u.hash||parts.length!==2||!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(parts[0])||!/^[A-Za-z0-9_]{1,64}$/.test(parts[1])||u.pathname!=='/'+parts.join('/')||[...u.searchParams.keys()].length!==1||u.searchParams.get('startapp')!==v.startParam)return invalid();
 }
 return {kind:'challenge',challengeId:v.challengeId,startParam:v.startParam,expiresAt:v.expiresAt,miniAppUrl:v.miniAppUrl as string|null,state:'pending',...(typeof v.widgetBotUsername==='string'?{widgetBotUsername:v.widgetBotUsername}:{})};
}
function mutation(value:unknown,kind?:'linked'|'unlinked',expectedOperationId?:unknown):Mutation{
 const v=closed(value,['kind','operationId','provider','linkId','authEpoch','reauthenticate']);
 if((v.kind!=='linked'&&v.kind!=='unlinked')||kind!==undefined&&v.kind!==kind||!text(v.operationId,160)||expectedOperationId!==undefined&&v.operationId!==expectedOperationId||v.provider!=='telegram'&&v.provider!=='replit'||!text(v.linkId,255)||!Number.isSafeInteger(v.authEpoch)||Number(v.authEpoch)<0||v.reauthenticate!==(v.kind==='unlinked'))return invalid();
 return {kind:v.kind,operationId:v.operationId,provider:v.provider,linkId:v.linkId,authEpoch:Number(v.authEpoch),reauthenticate:v.reauthenticate};
}
function status(value:unknown,expectedId:string):ChallengeStatus{
 const v=closed(value,['kind','challengeId','state','expiresAt','accountLabel']);
 if(v.kind!=='challenge_status'||v.challengeId!==expectedId||!uuid(v.challengeId)||!validInstant(v.expiresAt)||!['pending','ready_for_confirmation','linked','expired'].some(s=>s===v.state)||v.accountLabel!==undefined&&(typeof v.accountLabel!=='string'||!/^Telegram ••••\d{1,4}$/.test(v.accountLabel)||!['ready_for_confirmation','linked'].some(s=>s===v.state)))return invalid();
 return {kind:'challenge_status',challengeId:v.challengeId,state:v.state as ChallengeStatus['state'],expiresAt:v.expiresAt,...(v.accountLabel!==undefined?{accountLabel:v.accountLabel as string}:{})};
}
function recovery(value:unknown,request:Record<string,unknown>):unknown{
 const v=closed(value,['kind','state','result']);if(v.kind!=='recovery')return invalid();
 if(v.state==='not_recorded'&&Object.keys(v).sort().join(',')==='kind,state')return {kind:'recovery',state:'not_recorded'};
 if(v.state==='recorded'&&plain(v.result)){if(request.kind==='challenge'){if(v.result.kind!=='challenge')return invalid();return {kind:'recovery',state:'recorded',result:challenge(v.result)};}const result=mutation(v.result,request.kind==='link'?'linked':'unlinked',plain(request.request)?request.request.id:undefined);if(request.kind==='link'&&result.provider!=='telegram')return invalid();return {kind:'recovery',state:'recorded',result};}
 return invalid();
}
function accounts(value:unknown,principal:AccountLinkHttpPrincipal):Accounts{
 const v=closed(value,['links','authEpoch']);
 if(!Array.isArray(v.links)||v.links.length>100||!Number.isSafeInteger(v.authEpoch)||v.authEpoch!==principal.authEpoch)return invalid();
 const links=v.links.map(link=>{const l=closed(link,['id','provider','linkRevision']);
  if(!text(l.id)||!['telegram','replit'].includes(l.provider as string)||typeof l.linkRevision!=='string'||!/^[a-f0-9]{64}$/.test(l.linkRevision))return invalid();
  return {id:l.id,provider:l.provider as 'telegram'|'replit',linkRevision:l.linkRevision};
 });
 if(new Set(links.map(l=>l.id)).size!==links.length)return invalid();
 return {links,authEpoch:Number(v.authEpoch)};
}
function sendError(res:Response,error:unknown):void{
 const raw=error&&typeof error==='object'?(error as {code?:unknown}).code:undefined;
 const code=typeof raw==='string'?raw:'';
 if(code==='ACCOUNT_COMMIT_UNKNOWN'){res.status(503).json({code:'ACCOUNT_COMMIT_UNKNOWN',retry:'same_request_id'});return;}
 if(code==='ACCOUNT_AUTH_REQUIRED'||code==='ACCOUNT_SESSION_REVOKED'){res.status(401).json({code,error:'Увійдіть у свій акаунт ще раз.'});return;}
 if(code==='ACCOUNT_INVALID_REQUEST'||code==='ACCOUNT_PROOF_INVALID'){res.status(400).json({code,error:'Не вдалося підтвердити дані. Перевірте дію й спробуйте ще раз.'});return;}
 if(/^ACCOUNT_[A-Z_]+_(?:CONFLICT|EXPIRED)$/.test(code)||['ACCOUNT_RECONCILIATION_REQUIRED','ACCOUNT_LAST_LOGIN_REQUIRED','ACCOUNT_PROFILE_CHANGED','ACCOUNT_ORIGINAL_SESSION_REQUIRED'].includes(code)){res.status(409).json({code,error:code==='ACCOUNT_LAST_LOGIN_REQUIRED'?'Спочатку додайте й перевірте інший спосіб входу.':code==='ACCOUNT_ORIGINAL_SESSION_REQUIRED'?'Це підтвердження створено в іншому вході. Почніть підтвердження заново.':'Дані або дозвіл змінилися. Перевірте стан акаунта перед повторною дією.'});return;}
 res.status(503).json({code:code==='ACCOUNT_DISABLED'?'ACCOUNT_DISABLED':'ACCOUNT_UNCONFIRMED',error:'Не вдалося підтвердити результат. Перевірте попередню дію перед повторенням.'});
}
/** Registration only. Import/construction performs no auth, DB, provider or action. */
export function registerAccountLinkRoutes(app:Express,ports:AccountLinkHttpPorts):void{
 const headers:RequestHandler=(_req,res,next)=>{res.setHeader('Cache-Control','no-store, private');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');next();};
 const enabled:RequestHandler=(_req,res,next)=>{if(ports.enabled!==true){res.status(503).json({code:'ACCOUNT_DISABLED'});return;}next();};
 const telegramLinking:RequestHandler=(_req,res,next)=>{if(ports.telegramLinkingEnabled===false){res.status(503).json({code:'ACCOUNT_DISABLED'});return;}next();};
 const miniProof:RequestHandler=(_req,res,next)=>{if(ports.miniAppProofEnabled===false){res.status(503).json({code:'ACCOUNT_DISABLED'});return;}next();};
 const widgetProof:RequestHandler=(req,res,next)=>{if(ports.widgetLinkingEnabled===false||!ports.service.receiveWidgetProof){res.status(503).json({code:'ACCOUNT_DISABLED'});return;}
  if(req.headers.authorization!==undefined||!req.is('application/json')){res.status(400).json({code:'ACCOUNT_INVALID_REQUEST'});return;}next();};
 const query:RequestHandler=(req,res,next)=>{if(Object.keys(req.query).length){res.status(400).json({code:'ACCOUNT_INVALID_REQUEST'});return;}next();};
 async function owner(req:Request,res:Response,recover=false):Promise<AccountLinkHttpPrincipal|null>{
  const value=await (recover?ports.recoveryPrincipal!:ports.principal)(req),principal=checkedPrincipal(value);if(!principal)res.status(401).json({code:'ACCOUNT_AUTH_REQUIRED'});return principal;
 }
 app.get('/api/product/accounts',headers,enabled,query,ports.sameOrigin,ports.limiter,ports.authenticate,async(req,res)=>{try{const p=await owner(req,res);if(p)res.json(accounts(await ports.service.listAccounts(p),p));}catch(e){sendError(res,e);}});
 app.post('/api/product/accounts/telegram/challenge',headers,enabled,telegramLinking,query,ports.sameOrigin,ports.limiter,ports.authenticate,async(req,res)=>{try{const p=await owner(req,res);if(p)res.json(challenge(await ports.service.createChallenge(p,req.body)));}catch(e){sendError(res,e);}});
 app.post('/api/product/accounts/telegram/proof',headers,enabled,telegramLinking,miniProof,query,ports.limiter,async(req,res)=>{try{
  if(!plain(req.body)||Object.keys(req.body).join(',')!=='initData'||typeof req.body.initData!=='string'||!req.body.initData||req.body.initData.length>16384){res.status(400).json({code:'ACCOUNT_INVALID_REQUEST'});return;}
  const v=closed(await ports.service.receiveMiniProof(req.body.initData),['kind','state']);if(v.kind!=='proof'||v.state!=='ready_for_confirmation')return invalid();res.json({kind:'proof',state:'ready_for_confirmation'});
 }catch(e){sendError(res,e);}});
 app.post('/api/product/accounts/telegram/widget-proof',headers,enabled,telegramLinking,query,ports.sameOrigin,widgetProof,ports.limiter,ports.authenticate,async(req,res)=>{try{
  if(!plain(req.body)||Object.keys(req.body).sort().join(',')!=='challengeId,telegramData'||!uuid(req.body.challengeId)||Buffer.byteLength(JSON.stringify(req.body))>20000){res.status(400).json({code:'ACCOUNT_INVALID_REQUEST'});return;}
  const p=await owner(req,res);if(!p)return;
  const v=closed(await ports.service.receiveWidgetProof!(p,req.body),['kind','state']);if(v.kind!=='proof'||v.state!=='ready_for_confirmation')return invalid();
  res.json({kind:'proof',state:'ready_for_confirmation'});
 }catch(e){sendError(res,e);}});
 app.get('/api/product/accounts/telegram/challenge/:challengeId',headers,enabled,telegramLinking,query,ports.sameOrigin,ports.limiter,ports.authenticate,async(req,res)=>{try{const p=await owner(req,res);if(!p)return;if(!uuid(req.params.challengeId)){res.status(400).json({code:'ACCOUNT_INVALID_REQUEST'});return;}res.json(status(await ports.service.inspectChallenge(p,req.params.challengeId),req.params.challengeId));}catch(e){sendError(res,e);}});
 app.post('/api/product/accounts/telegram/confirm',headers,enabled,telegramLinking,query,ports.sameOrigin,ports.limiter,ports.authenticate,async(req,res)=>{try{const p=await owner(req,res);if(p){const result=mutation(await ports.service.confirmLink(p,req.body),'linked',plain(req.body)?req.body.id:undefined);if(result.provider!=='telegram')return invalid();res.json(result);}}catch(e){sendError(res,e);}});
 app.post('/api/product/accounts/unlink',headers,enabled,query,ports.sameOrigin,ports.limiter,ports.authenticate,async(req,res)=>{try{const p=await owner(req,res);if(p)res.json(mutation(await ports.service.unlink(p,req.body),'unlinked',plain(req.body)?req.body.id:undefined));}catch(e){sendError(res,e);}});
 const recoveryReady:RequestHandler=(_req,res,next)=>{if(!ports.recoveryAuthenticate||!ports.recoveryPrincipal||!ports.service.recoverOperation){res.status(503).json({code:'ACCOUNT_DISABLED'});return;}next();};
 app.post('/api/product/accounts/recover',headers,enabled,query,recoveryReady,ports.sameOrigin,ports.limiter,(req,res,next)=>ports.recoveryAuthenticate!(req,res,next),async(req,res)=>{try{const p=await owner(req,res,true);if(!p)return;if(!plain(req.body)||Object.keys(req.body).sort().join(',')!=='kind,request'||!['challenge','link','unlink'].some(s=>s===req.body.kind)){res.status(400).json({code:'ACCOUNT_INVALID_REQUEST'});return;}res.json(recovery(await ports.service.recoverOperation!(p,req.body),req.body));}catch(e){sendError(res,e);}});
}
