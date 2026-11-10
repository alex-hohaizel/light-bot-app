import {parseOperatorHouseNotices,currentOperatorHouseNotice} from '../../shared/operator-house-notice.ts';
import type {Express,RequestHandler,Request,Response} from 'express';
import type {} from 'passport';
import type {LiveProfileSnapshot,LiveProfileReceipt,LiveProfileReceiptRecovery} from '../../shared/live-product.ts';
import type {AddressBinding,AddressRecord,ScheduleView} from '../../shared/product-contract.ts';
import type {BotProfile,AddressOption} from '../../shared/bot/types.ts';
import {validInstant,validateScheduleView} from '../../shared/schedule-core.ts';
import {parseProfileRequest} from '../domain/profile-service.ts';
import {profileErrorMessage} from '../../shared/profile-errors.ts';
import {parseLocationNotificationPolicy,parseNotificationPolicy} from '../../shared/notification-policy.ts';
import {parseManualGroups} from '../../shared/manual-group.ts';
import type {LegacyLiveProfileRead,VerifiedLegacyPrincipal} from './profile-reader.ts';
import type {createProductionProfileStore,ProductionProfileSnapshot,ProductionProfileReceipt} from './profile-store.ts';

type CanonicalStore=Pick<ReturnType<typeof createProductionProfileStore>,'snapshot'|'commitProfileMutation'|'recoverReceipt'>;
type CommonPorts={authenticate:RequestHandler;releaseId:string;toolsEnabled?:boolean;operatorLookupEnabled?:boolean};
export type LiveProductPorts=CommonPorts&(
  |{mode:'disabled'|'read_only';read(principal:VerifiedLegacyPrincipal):Promise<LegacyLiveProfileRead>}
  |{mode:'active';store:CanonicalStore}
);
const noStore:RequestHandler=(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();};
const fail=():never=>{throw new Error('LIVE_PRODUCT_INVALID_RESULT');};
const text=(v:unknown,max=128):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
function stringValue(v:unknown,max=4096,empty=true):asserts v is string{if(typeof v!=='string'||v.length>max||!empty&&!v.trim()||/[\u0000-\u001f\u007f]/.test(v))fail();}
function flag(v:unknown):asserts v is boolean{if(typeof v!=='boolean')fail();}
function integer(v:unknown,max:number):asserts v is number{if(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>max)fail();}
function wallTime(v:unknown){if(typeof v!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v))fail();}
function principal(req:Request,res:Response):VerifiedLegacyPrincipal|null{
  if(Object.keys(req.query).length){res.status(400).json({code:'LIVE_PROFILE_QUERY_REJECTED',error:'Параметри вибору іншого профілю не підтримуються.'});return null;}
  const sub=(req.user as {claims?:{sub?:unknown}}|undefined)?.claims?.sub;
  if(!text(sub,255)){res.status(401).json({code:'LIVE_PROFILE_AUTH_REQUIRED',error:'Увійдіть у свій акаунт.'});return null;}
  return {kind:'verified_server_principal',ownerId:sub,verified:true};
}
// Explicit public DTOs: private provenance, identity links and unknown stored fields
// cannot become response fields through an object spread.
function address(a:AddressRecord):AddressRecord{
  if(!object(a)||!object(a.house)||!Array.isArray(a.aliases)||a.aliases.length>1000)return fail();
  for(const v of [a.id,a.territoryId])stringValue(v,512,false);for(const v of [a.label,a.locality,a.street,a.house.number,a.house.literal])stringValue(v);
  for(const v of [a.house.letter,a.house.building])if(v!==undefined)stringValue(v,255);for(const v of a.aliases)stringValue(v,4096);
  for(const v of [a.localityId,a.streetId])if(v!==undefined)stringValue(v,512,false);
  for(const values of [a.localityAliases,a.placeNames])if(values!==undefined){if(!Array.isArray(values)||values.length>1000)return fail();for(const v of values)stringValue(v,4096,false);}
  if(a.objectKind!==undefined&&!['residential','commercial','public','other'].includes(a.objectKind))return fail();
  return {id:a.id,label:a.label,territoryId:a.territoryId,locality:a.locality,street:a.street,
    house:{number:a.house.number,literal:a.house.literal,...(a.house.letter!==undefined?{letter:a.house.letter}:{}),...(a.house.building!==undefined?{building:a.house.building}:{})},aliases:[...a.aliases],
    ...(a.localityId!==undefined?{localityId:a.localityId}:{}),...(a.streetId!==undefined?{streetId:a.streetId}:{}),
    ...(a.localityAliases!==undefined?{localityAliases:[...a.localityAliases]}:{}),...(a.placeNames!==undefined?{placeNames:[...a.placeNames]}:{}),...(a.objectKind!==undefined?{objectKind:a.objectKind}:{})};
}
function binding(b:AddressBinding):AddressBinding{
  if(!object(b))return fail();for(const v of [b.addressId,b.operatorId,b.namespace,b.targetId,b.revisionId])stringValue(v,512,false);
  if(!['building','connection','operator_group','user_selected_group'].includes(b.kind)||!['verified','needs_confirmation','ambiguous','stale'].includes(b.status))return fail();
  for(const v of [b.verifiedAt,b.effectiveFrom,b.effectiveUntil])if(v!==null&&!validInstant(v))return fail();
  return {addressId:b.addressId,operatorId:b.operatorId,namespace:b.namespace,targetId:b.targetId,kind:b.kind,revisionId:b.revisionId,status:b.status,verifiedAt:b.verifiedAt,effectiveFrom:b.effectiveFrom,effectiveUntil:b.effectiveUntil};
}
function profile(p:BotProfile):BotProfile{
  if(!object(p)||!Array.isArray(p.locations)||p.locations.length>10000||!object(p.preferences)||!object(p.preferences.quietHours)||!object(p.preferences.morningBriefing))return fail();stringValue(p.id,255,false);
  const ids=new Set<string>();for(const l of p.locations){if(!object(l))return fail();address(l.address);binding(l.binding);flag(l.notifications);flag(l.paused);if(l.notificationPolicy!==undefined)parseLocationNotificationPolicy(l.notificationPolicy);if(l.binding.addressId!==l.address.id||ids.has(l.address.id))return fail();ids.add(l.address.id);}
  if(p.primaryAddressId!==null&&(!text(p.primaryAddressId,512)||!ids.has(p.primaryAddressId)))return fail();
  if(p.legacyNotificationPolicySourceHash!==undefined&&(typeof p.legacyNotificationPolicySourceHash!=='string'||!/^[a-f0-9]{64}$/.test(p.legacyNotificationPolicySourceHash)))return fail();
  for(const v of [p.preferences.optedIn,p.preferences.paused,p.preferences.reminders,p.preferences.quietHours.enabled,p.preferences.morningBriefing.enabled])flag(v);
  integer(p.preferences.remindBeforeMinutes,1440);integer(p.preferences.minimumOutageMinutes,86400);wallTime(p.preferences.quietHours.start);wallTime(p.preferences.quietHours.end);wallTime(p.preferences.morningBriefing.time);
  if(p.preferences.notificationPolicy!==undefined)parseNotificationPolicy(p.preferences.notificationPolicy);
  if(p.preferences.quietHours.timezone!=='Europe/Kyiv'||p.preferences.quietHours.enabled&&p.preferences.quietHours.start===p.preferences.quietHours.end)return fail();
  return {id:p.id,locations:p.locations.map(l=>({address:address(l.address),binding:binding(l.binding),notifications:l.notifications,paused:l.paused,
  ...(l.notificationPolicy!==undefined?{notificationPolicy:parseLocationNotificationPolicy(l.notificationPolicy)}:{})})),primaryAddressId:p.primaryAddressId,
  ...(p.legacyNotificationPolicySourceHash!==undefined?{legacyNotificationPolicySourceHash:p.legacyNotificationPolicySourceHash}:{}),
  preferences:{optedIn:p.preferences.optedIn,paused:p.preferences.paused,reminders:p.preferences.reminders,remindBeforeMinutes:p.preferences.remindBeforeMinutes,
    quietHours:{enabled:p.preferences.quietHours.enabled,start:p.preferences.quietHours.start,end:p.preferences.quietHours.end,timezone:p.preferences.quietHours.timezone},
    morningBriefing:{enabled:p.preferences.morningBriefing.enabled,time:p.preferences.morningBriefing.time},minimumOutageMinutes:p.preferences.minimumOutageMinutes,
    ...(p.preferences.notificationPolicy!==undefined?{notificationPolicy:parseNotificationPolicy(p.preferences.notificationPolicy)}:{})}};
}
function option(a:AddressOption):AddressOption{if(!object(a))return fail();stringValue(a.id,128,false);stringValue(a.territoryLabel);if(a.connectionLabel!==undefined)stringValue(a.connectionLabel);const shown=address(a.address),bound=binding(a.binding);if(shown.id!==bound.addressId)return fail();return {id:a.id,address:shown,binding:bound,territoryLabel:a.territoryLabel,...(a.connectionLabel!==undefined?{connectionLabel:a.connectionLabel}:{})};}
function plan(v:ScheduleView):ScheduleView{
  if(!object(v)||!object(v.source)||!Array.isArray(v.intervals)||v.intervals.length>10000||v.previousIntervals!==undefined&&(!Array.isArray(v.previousIntervals)||v.previousIntervals.length>10000))return fail();
  for(const value of [v.revisionId,v.addressId,v.operatorId,v.serviceDate,v.source.id,v.source.revision])stringValue(value,512,false);for(const value of [v.addressLabel,v.localityLabel,v.source.name])stringValue(value);
  for(const value of [v.namespace,v.targetId,v.bindingRevisionId,v.previousRevisionId])if(value!==undefined)stringValue(value,512,false);
  if(v.source.url!==null){stringValue(v.source.url,4096,false);let url:URL;try{url=new URL(v.source.url);}catch{return fail();}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return fail();}
  if(v.notice!==undefined&&(typeof v.notice!=='string'||v.notice.length>65536))return fail();
  for(const i of [...v.intervals,...(v.previousIntervals??[])]){if(!object(i))return fail();for(const value of [i.startsAt,i.endsAt,i.startLocal,i.endLocal,i.kind])stringValue(value,128,false);}
  validateScheduleView(v);if(v.synthetic!==false)return fail();
  const interval=(i:ScheduleView['intervals'][number])=>({startsAt:i.startsAt,endsAt:i.endsAt,startLocal:i.startLocal,endLocal:i.endLocal,kind:i.kind});
  return {contractVersion:v.contractVersion,revisionId:v.revisionId,addressId:v.addressId,addressLabel:v.addressLabel,localityLabel:v.localityLabel,operatorId:v.operatorId,
    serviceDate:v.serviceDate,...(v.bindingRevisionId!==undefined?{bindingRevisionId:v.bindingRevisionId}:{}),...(v.namespace!==undefined?{namespace:v.namespace}:{}),...(v.targetId!==undefined?{targetId:v.targetId}:{}),
    timezone:v.timezone,status:v.status,dayCoverage:v.dayCoverage,intervals:v.intervals.map(interval),source:{id:v.source.id,name:v.source.name,url:v.source.url,revision:v.source.revision,accessCost:v.source.accessCost,verifiedLevel:v.source.verifiedLevel},
    publishedAt:v.publishedAt,observedAt:v.observedAt,freshness:v.freshness,synthetic:false,deliveryEligible:v.deliveryEligible,
    ...(v.previousRevisionId!==undefined?{previousRevisionId:v.previousRevisionId}:{}),...(v.previousIntervals!==undefined?{previousIntervals:v.previousIntervals.map(interval)}:{}),...(v.notice!==undefined?{notice:v.notice}:{})};
}
function activeSnapshot(value:ProductionProfileSnapshot,owner:string,releaseId:string,toolsEnabled=false,operatorLookupEnabled=false):LiveProfileSnapshot{
  if(value?.runtime!=='production'||value.profile?.id!==owner||!text(value.sessionId)||!Number.isSafeInteger(value.revision)||value.revision<0||!validInstant(value.serverNow)||!Array.isArray(value.catalog)||!Array.isArray(value.plans))return fail();
  const p=profile(value.profile),needsConfirmation=p.locations.some(l=>l.binding.status!=='verified'||l.binding.kind==='user_selected_group');
  const operatorHouseNotices=value.operatorHouseNotices===undefined?undefined:parseOperatorHouseNotices(value.operatorHouseNotices,p.locations).filter(n=>currentOperatorHouseNotice(n,value.serverNow));
  return {...(operatorHouseNotices!==undefined?{operatorHouseNotices}:{}),...(value.manualGroups!==undefined?{manualGroups:parseManualGroups(value.manualGroups)}:{}),profile:p,sessionId:value.sessionId,revision:value.revision,catalog:value.catalog.map(option),plans:value.plans.map(plan),simulationOnly:false,serverNow:value.serverNow,releaseId,
    capabilities:{profileMutations:true,tools:toolsEnabled,...(operatorLookupEnabled?{addressLookupV2:['dtek:oem'] as Array<'dtek:oem'>}:{})},migration:needsConfirmation
      ?{status:'needs_confirmation',message:'Профіль збережено. Для частини адрес потрібно підтвердити прив’язку до графіків.'}
      :{status:'ready',message:p.locations.length?'Налаштування профілю доступні для змін.':'Профіль створено. Додайте адресу, щоб переглядати свій план.'}};
}
function receipt(value:ProductionProfileReceipt,inputId:string):LiveProfileReceipt{
  if(value?.runtime!=='production'||value.channel!=='app'||value.inputId!==inputId||value.committed!==true||!text(value.id)||!text(value.sessionId)||!Number.isSafeInteger(value.sessionRevision)||value.sessionRevision<0||!validInstant(value.recordedAt)||!['pending','none'].includes(value.delivery))return fail();
  return {id:value.id,inputId:value.inputId,committed:true,sessionRevision:value.sessionRevision,simulationOnly:false,sessionId:value.sessionId,recordedAt:value.recordedAt,delivery:value.delivery};
}
function errorResponse(res:Response,error:unknown){
  const code=error instanceof Error?error.message:'';
  if(code==='PRODUCTION_COMMIT_UNKNOWN')return res.status(503).json({code,error:'Результат збереження ще перевіряється. Повторіть перевірку з тим самим номером запиту.',nextAction:'recover_same_request',retryWithSameRequestId:true});
  if(['PRODUCTION_INPUT_ID_CONFLICT','PROFILE_REVISION_CONFLICT','PRODUCTION_PROFILE_REVISION_CONFLICT','PROFILE_BINDING_REVISION_CONFLICT','PROFILE_SELECTION_CHANGED','PROFILE_SELECTION_REQUIRED','PROFILE_ADDRESS_NOT_FOUND','PROFILE_OPTION_NOT_FOUND','PROFILE_ADDRESS_ALREADY_SAVED','PROFILE_ADDRESS_LIMIT','PROFILE_BINDING_NOT_VERIFIED'].includes(code))
    return res.status(409).json({code,error:profileErrorMessage(code)});
  if(code==='PRODUCTION_INVALID_INPUT'||code==='INVALID_PROFILE_INPUT')return res.status(400).json({code:'LIVE_PROFILE_INVALID_INPUT',error:'Перевірте дані зміни профілю.'});
  if(code==='PRODUCTION_TRANSACTION_RETRY_REQUIRED')return res.status(503).json({code,error:'Не вдалося завершити зміну. Повторіть той самий запит.',nextAction:'retry_same_request',retryWithSameRequestId:true});
  return res.status(503).json({code:'LIVE_PROFILE_UNAVAILABLE',error:'Не вдалося перевірити збережений профіль. Повторіть спробу з тим самим номером запиту.',retryWithSameRequestId:true});
}
/** Active directly consumes the canonical store. Deployed runtime policy and actual
 * cutover controls remain separate root gates; disabled/read-only do not gain writes.
 */
export function registerLiveProductRoutes(app:Express,ports:LiveProductPorts){
  if(!['disabled','read_only','active'].includes(ports.mode)||!/^[a-f0-9]{64}$/.test(ports.releaseId)||typeof ports.authenticate!=='function')throw new Error('LIVE_PRODUCT_RELEASE_INVALID');
  if(ports.operatorLookupEnabled!==undefined&&typeof ports.operatorLookupEnabled!=='boolean')throw new Error('LIVE_PRODUCT_PORTS_INVALID');
  if(ports.mode==='active'&&(!ports.store||!['snapshot','commitProfileMutation','recoverReceipt'].every(k=>typeof ports.store[k as keyof CanonicalStore]==='function'))||ports.mode!=='active'&&typeof ports.read!=='function')throw new Error('LIVE_PRODUCT_PORTS_INVALID');
  const mode=ports.mode,releaseId=ports.releaseId,store=ports.mode==='active'?ports.store:null,read=ports.mode==='active'?null:ports.read;
  app.get('/api/product/profile',noStore,ports.authenticate,async(req,res)=>{
    if(mode==='disabled')return res.status(503).json({error:'Оновлена версія ще готується до запуску.'});
    const p=principal(req,res);if(!p)return;
    try{
      if(mode==='active')return res.json(activeSnapshot(await store!.snapshot(p),p.ownerId,releaseId,ports.toolsEnabled===true,ports.operatorLookupEnabled===true));
      const value=await read!(p);
      if(value.projection.profile.id!==p.ownerId||typeof value.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceDigest)||!validInstant(value.serverNow))return fail();
      const snapshot:LiveProfileSnapshot={profile:profile(value.projection.profile),revision:0,sessionId:'legacy-read:'+value.sourceDigest,catalog:[],plans:[],simulationOnly:false,serverNow:value.serverNow,releaseId,
        capabilities:{profileMutations:false,tools:false},migration:value.status==='blocked'||value.projection.issues.length
          ?{status:'needs_confirmation',message:'Для частини збережених налаштувань потрібна додаткова звірка. Дані не змінено.'}
          :{status:'checking',message:'Ваші адреси збережено. Перенесення профілів і прив’язка до графіків ще перевіряються.'}};
      return res.json(snapshot);
    }catch(error){return errorResponse(res,error);}
  });
  app.post('/api/product/profile',noStore,ports.authenticate,async(req,res)=>{
    if(mode!=='active')return res.status(503).json({code:'LIVE_PROFILE_WRITER_NOT_READY',error:'Зміни поки недоступні: триває перевірка перенесення профілів.'});
    const p=principal(req,res);if(!p)return;
    let request;try{request=parseProfileRequest(req.body);}catch{return res.status(400).json({code:'LIVE_PROFILE_INVALID_INPUT',error:'Перевірте дані зміни профілю.'});}
    if((request.mutation.kind==='add'||request.mutation.kind==='replace')&&!request.mutation.selectionFingerprint)return res.status(409).json({code:'PROFILE_SELECTION_REQUIRED',error:profileErrorMessage('PROFILE_SELECTION_REQUIRED')});
    try{
      const value=await store!.commitProfileMutation(p,request),snapshot=activeSnapshot(value.snapshot,p.ownerId,releaseId,ports.toolsEnabled===true,ports.operatorLookupEnabled===true),accepted=receipt(value.receipt,'app:'+request.id);
      if(accepted.sessionId!==snapshot.sessionId||accepted.sessionRevision>snapshot.revision||typeof value.replayed!=='boolean')return fail();
      return res.json({...snapshot,receipt:accepted,replayed:value.replayed});
    }catch(error){return errorResponse(res,error);}
  });
  app.post('/api/product/profile/receipt',noStore,ports.authenticate,async(req,res)=>{
    if(mode!=='active')return res.status(503).json({code:'LIVE_PROFILE_WRITER_NOT_READY',error:'Перевірка збереження поки недоступна.'});
    const p=principal(req,res);if(!p)return;
    let request;try{request=parseProfileRequest(req.body);}catch{return res.status(400).json({code:'LIVE_PROFILE_INVALID_INPUT',error:'Для перевірки потрібен той самий запит на зміну.'});}
    try{
      const found=await store!.recoverReceipt(p,{channel:'app',request});
      const result:LiveProfileReceiptRecovery=found===null?{outcome:'not_recorded',receipt:null,nextAction:'retry_same_request'}:{outcome:'committed',receipt:receipt(found,'app:'+request.id),nextAction:'use_receipt'};
      return res.json(result);
    }catch(error){return errorResponse(res,error);}
  });
}
