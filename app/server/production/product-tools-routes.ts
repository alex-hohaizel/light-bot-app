import type {Express,Request,RequestHandler,Response} from 'express';
import type {} from 'passport';
import {liveToolText,liveToolsErrorMessage,parseLiveToolsRequest,parseLiveToolsSnapshot,parseLiveToolsRecovery,parseLivePublicShare} from '../../shared/live-tools.ts';
import type {createProductionTools} from './product-tools.ts';
import type {VerifiedLegacyPrincipal} from './profile-reader.ts';
type Tools=Pick<ReturnType<typeof createProductionTools>,'snapshot'|'commit'|'recover'|'publicShare'>;
export interface ProductionToolsRoutePorts {authenticate:RequestHandler;enabled?:boolean;tools:Tools}
function identity(req:Request,res:Response):VerifiedLegacyPrincipal|null{
 if(Object.keys(req.query).length){res.status(400).json({code:'LIVE_TOOLS_QUERY_REJECTED',error:'Параметри вибору іншого профілю не підтримуються.'});return null;}
 const sub=(req.user as {claims?:{sub?:unknown}}|undefined)?.claims?.sub;
 if(!liveToolText(sub,255)){res.status(401).json({code:'LIVE_TOOLS_AUTH_REQUIRED',error:liveToolsErrorMessage('LIVE_TOOLS_AUTH_REQUIRED')});return null;}
 return {kind:'verified_server_principal',ownerId:sub,verified:true};
}
function error(res:Response,e:unknown){
 const raw=(e as {code?:unknown})?.code,known=typeof raw==='string'&&/^(?:LIVE_TOOLS_|PRODUCTION_)[A-Z_]+$/.test(raw)?raw:'LIVE_TOOLS_UNCONFIRMED';
 const allowed=['LIVE_TOOLS_INVALID_INPUT','LIVE_TOOLS_ADDRESS_NOT_OWNED','LIVE_TOOLS_REVISION_CONFLICT','LIVE_TOOLS_SESSION_CONFLICT','LIVE_TOOLS_INPUT_ID_CONFLICT','LIVE_TOOLS_SHARE_NOT_FOUND','LIVE_TOOLS_SHARE_GONE','LIVE_TOOLS_DATE_OUT_OF_RANGE','LIVE_TOOLS_AUTH_REQUIRED','PRODUCTION_COMMIT_UNKNOWN'];
 const code=allowed.includes(known)?known:'LIVE_TOOLS_UNCONFIRMED';
 const status=code==='LIVE_TOOLS_AUTH_REQUIRED'?401:code==='LIVE_TOOLS_INVALID_INPUT'||code==='LIVE_TOOLS_DATE_OUT_OF_RANGE'?400:code==='LIVE_TOOLS_SHARE_NOT_FOUND'?404:code==='LIVE_TOOLS_SHARE_GONE'?410:code.includes('CONFLICT')||code==='LIVE_TOOLS_ADDRESS_NOT_OWNED'?409:503;
 res.status(status).json({code,error:liveToolsErrorMessage(code),...(code==='PRODUCTION_COMMIT_UNKNOWN'?{retry:'same_request',recovery:'/api/product/tools/recover'}:{})});
}
/** Consumer is explicitly disabled by default; auth principal is never selected by JSON/query. */
export function registerProductionToolsRoutes(app:Express,ports:ProductionToolsRoutePorts):void{
 const headers:RequestHandler=(_req,res,next)=>{res.setHeader('Cache-Control','no-store, private');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');next();};
 const available:RequestHandler=(_req,res,next)=>{if(ports.enabled!==true){res.status(503).json({code:'LIVE_TOOLS_UNAVAILABLE',error:'Керування інструментами ще недоступне.'});return;}next();};
 app.get('/api/product/tools',headers,available,ports.authenticate,async(req,res)=>{const p=identity(req,res);if(!p)return;try{res.json(parseLiveToolsSnapshot(await ports.tools.snapshot(p)));}catch(e){error(res,e);}});
 app.post('/api/product/tools',headers,available,ports.authenticate,async(req,res)=>{const p=identity(req,res);if(!p)return;let request;try{request=parseLiveToolsRequest(req.body);}catch{return res.status(400).json({code:'LIVE_TOOLS_INVALID_INPUT',error:liveToolsErrorMessage('LIVE_TOOLS_INVALID_INPUT')});}try{res.json(parseLiveToolsSnapshot(await ports.tools.commit(p,request)));}catch(e){error(res,e);}});
 app.post('/api/product/tools/recover',headers,available,ports.authenticate,async(req,res)=>{const p=identity(req,res);if(!p)return;let request;try{request=parseLiveToolsRequest(req.body);}catch{return res.status(400).json({code:'LIVE_TOOLS_INVALID_INPUT',error:liveToolsErrorMessage('LIVE_TOOLS_INVALID_INPUT')});}try{res.json(parseLiveToolsRecovery(await ports.tools.recover(p,request)));}catch(e){error(res,e);}});
 app.get('/api/product/shared/:token',headers,available,async(req,res)=>{if(Object.keys(req.query).length){res.status(400).json({code:'LIVE_TOOLS_QUERY_REJECTED',error:'Посилання не потребує додаткових параметрів.'});return;}try{res.json(parseLivePublicShare(await ports.tools.publicShare(req.params.token)));}catch(e){error(res,e);}});
}
