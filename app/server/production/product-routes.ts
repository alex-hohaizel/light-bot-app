import type {Express,RequestHandler} from 'express';
import type {LiveProfileSnapshot} from '../../shared/live-product.ts';
import type {LegacyLiveProfileRead,VerifiedLegacyPrincipal} from './profile-reader.ts';

export interface LiveProductPorts {
  /** Actual existing session/mobile verification is injected by the server, never request JSON. */
  authenticate: RequestHandler;
  read(principal: VerifiedLegacyPrincipal): Promise<LegacyLiveProfileRead>;
  releaseId: string;
  mode: 'disabled'|'read_only';
}
/** Shadow integration is explicitly read-only until the canonical writer/cutover is accepted.
 * It never reuses review routes, synthetic actors, reset operations, catalogs or plans.
 */
export function registerLiveProductRoutes(app:Express,ports:LiveProductPorts) {
  if (!['disabled','read_only'].includes(ports.mode) || !/^[a-f0-9]{64}$/.test(ports.releaseId)) throw new Error('LIVE_PRODUCT_RELEASE_INVALID');
  app.get('/api/product/profile',ports.authenticate,async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(ports.mode==='disabled')return res.status(503).json({error:'Оновлена версія ще готується до запуску.'});
    if(Object.keys(req.query).length)return res.status(400).json({error:'Параметри вибору іншого профілю не підтримуються.'});
    const subject=(req.user as {claims?:{sub?:unknown}}|undefined)?.claims?.sub;
    if(typeof subject!=='string'||!subject.trim()||subject.length>255)return res.status(401).json({error:'Увійдіть у свій акаунт.'});
    try{
      const value=await ports.read({kind:'verified_server_principal',ownerId:subject,verified:true});
      if(value.projection.profile.id!==subject || !/^[a-f0-9]{64}$/.test(value.sourceDigest))throw new Error('LIVE_PROFILE_OWNER_MISMATCH');
      const snapshot:LiveProfileSnapshot={profile:value.projection.profile,revision:0,sessionId:'legacy-read:'+value.sourceDigest,
        catalog:[],plans:[],simulationOnly:false,serverNow:value.serverNow,releaseId:ports.releaseId,
        capabilities:{profileMutations:false,tools:false},
        migration:value.status==='blocked'||value.projection.issues.length
          ?{status:'needs_confirmation',message:'Для частини збережених налаштувань потрібна додаткова звірка. Дані не змінено.'}
          :{status:'checking',message:'Ваші адреси збережено. Перенесення профілів і прив’язка до графіків ще перевіряються.'}};
      // Private provenance, identity links, subscriber IDs and reconciliation details stay on the server.
      res.json(snapshot);
    }catch{return res.status(503).json({error:'Не вдалося перевірити збережений профіль. Дані не змінено.'});}
  });
  app.post('/api/product/profile',ports.authenticate,(_req,res)=>{
    res.setHeader('Cache-Control','no-store');
    return res.status(503).json({code:'LIVE_PROFILE_WRITER_NOT_READY',error:'Зміни поки недоступні: триває перевірка перенесення профілів.'});
  });
}
