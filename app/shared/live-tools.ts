import type {PlanInterval,PlanStatus,ScheduleView} from './product-contract.ts';
import {validReviewServiceDate,validReviewShareToken} from './review-tools.ts';
import {validInstant,validateScheduleView} from './schedule-core.ts';
export type LiveToolsAction=
 |{kind:'report';addressId:string;value:'on'|'off'}
 |{kind:'share';addressIds:string[];ttlDays:1|3|7|14|30;serviceDate:string}
 |{kind:'revoke_share';token:string};
export interface LiveToolsRequest {id:string;expectedSessionId:string;expectedRevision:number;action:LiveToolsAction}
export interface LiveToolReceipt {runtime:'production';id:string;inputId:string;sessionId:string;profileRevision:number;recordedAt:string;committed:true;kind:LiveToolsAction['kind'];shareToken?:string}
export interface LivePowerReport {id:string;addressId:string;label:string;locality:string;value:'on'|'off';recordedAt:string;archived:boolean}
export interface LiveLegacyReport {id:string;locality:string;group:string;value:'on'|'off';reportedAtLiteral:string;timeZone:'unverified';origin:'legacy'}
export interface LiveShareSummary {token:string;url:string;serviceDate:string;createdAt:string;expiresAt:string;status:'active'|'revoked'|'expired';labels:string[]}
export interface LivePublicPlace {
 label:string;localityLabel:string;scope:'address'|'technical_group';serviceDate:string;timezone:'Europe/Kyiv';
 status:PlanStatus;dayCoverage:ScheduleView['dayCoverage'];freshness:ScheduleView['freshness'];intervals:PlanInterval[];
 sourceName:string;observedAt:string|null;
}
export interface LivePublicShare {runtime:'production';mode:'saved_plan';serviceDate:string;createdAt:string;expiresAt:string;places:LivePublicPlace[]}
export interface LiveToolsSnapshot {
 runtime:'production';sessionId:string;profileRevision:number;serverNow:string;
 capabilities:{reports:true;shares:true;accountLinking:false;accountUnlinking:false;verifiedOutageStatistics:false};
 reports:LivePowerReport[];legacyReports:LiveLegacyReport[];legacyReportsStatus:'available'|'unavailable';
 digest:{fromDate:string;throughDate:string;observationCount:number;observationDays:number;onCount:number;offCount:number;verifiedOutageDays:0;legacyDigestCount:number|null};
 accounts:Array<{provider:string;label:string;linkedAtLiteral:string|null}>;accountsStatus:'available'|'unavailable';
 shares:LiveShareSummary[];receipt?:LiveToolReceipt;replayed?:boolean;
}
export interface LiveToolsRecovery {runtime:'production';status:'recorded'|'not_recorded';receipt:LiveToolReceipt|null;retry:'none'|'same_request'}
export function liveToolObject(v:unknown):v is Record<string,unknown>{return Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));}
export function liveToolText(v:unknown,max=255,empty=false):v is string{return typeof v==='string'&&v.length<=max&&(empty||Boolean(v.trim()))&&!/[\u0000-\u001f\u007f]/.test(v);}
const member=(v:unknown,allowed:readonly string[]):v is string=>typeof v==='string'&&allowed.includes(v);
const invalid=():never=>{throw Error('LIVE_TOOLS_INVALID_INPUT');};
function closed(v:unknown,fields:string[]):Record<string,unknown>{if(!liveToolObject(v)||Object.keys(v).some(k=>!fields.includes(k)))return invalid();return v;}
export function parseLiveToolsRequest(value:unknown):LiveToolsRequest{
 const r=closed(value,['id','expectedSessionId','expectedRevision','action']);
 if(!liveToolText(r.id,96)||!/^[A-Za-z0-9_.:-]+$/.test(r.id)||!liveToolText(r.expectedSessionId,128)||!Number.isSafeInteger(r.expectedRevision)||Number(r.expectedRevision)<0)return invalid();
 const a=closed(r.action,['kind','addressId','value','addressIds','ttlDays','serviceDate','token']);let action:LiveToolsAction;
 if(a.kind==='report'){closed(a,['kind','addressId','value']);if(!liveToolText(a.addressId)||!member(a.value,['on','off']))return invalid();action={kind:'report',addressId:a.addressId,value:a.value as 'on'|'off'};}
 else if(a.kind==='share'){closed(a,['kind','addressIds','ttlDays','serviceDate']);if(!Array.isArray(a.addressIds)||!a.addressIds.length||a.addressIds.length>20||a.addressIds.some(v=>!liveToolText(v))||new Set(a.addressIds).size!==a.addressIds.length||![1,3,7,14,30].includes(Number(a.ttlDays))||typeof a.ttlDays!=='number'||!validReviewServiceDate(a.serviceDate))return invalid();action={kind:'share',addressIds:[...a.addressIds] as string[],ttlDays:a.ttlDays as 1|3|7|14|30,serviceDate:a.serviceDate};}
 else if(a.kind==='revoke_share'){closed(a,['kind','token']);if(!validReviewShareToken(a.token))return invalid();action={kind:'revoke_share',token:a.token};}
 else return invalid();
 return {id:r.id,expectedSessionId:r.expectedSessionId,expectedRevision:Number(r.expectedRevision),action};
}
export function parseLiveToolReceipt(value:unknown):LiveToolReceipt{
 const r=closed(value,['runtime','id','inputId','sessionId','profileRevision','recordedAt','committed','kind','shareToken']);
 if(r.runtime!=='production'||!liveToolText(r.id,96)||r.inputId!=='tools:'+r.id||!liveToolText(r.sessionId,128)||!Number.isSafeInteger(r.profileRevision)||Number(r.profileRevision)<0||!validInstant(r.recordedAt)||r.committed!==true||!member(r.kind,['report','share','revoke_share'])||r.shareToken!==undefined&&!validReviewShareToken(r.shareToken)||r.kind==='share'&&r.shareToken===undefined||r.kind!=='share'&&r.shareToken!==undefined)return invalid();
 return {runtime:'production',id:r.id,inputId:r.inputId as string,sessionId:r.sessionId,profileRevision:Number(r.profileRevision),recordedAt:r.recordedAt,committed:true,kind:r.kind as LiveToolsAction['kind'],...(r.shareToken!==undefined?{shareToken:r.shareToken as string}:{})};
}
/** Saved public DTO is closed recursively. It contains no identity, building, owner or provenance fields. */
export function parseLivePublicShare(value:unknown):LivePublicShare{
 const v=closed(value,['runtime','mode','serviceDate','createdAt','expiresAt','places']);
 if(v.runtime!=='production'||v.mode!=='saved_plan'||!validReviewServiceDate(v.serviceDate)||!validInstant(v.createdAt)||!validInstant(v.expiresAt)||Date.parse(v.expiresAt)<=Date.parse(v.createdAt)||!Array.isArray(v.places)||!v.places.length||v.places.length>20)return invalid();
 const places=v.places.map(raw=>{
  const p=closed(raw,['label','localityLabel','scope','serviceDate','timezone','status','dayCoverage','freshness','intervals','sourceName','observedAt']);
  if(!liveToolText(p.label,4096)||!liveToolText(p.localityLabel,4096,true)||!member(p.scope,['address','technical_group'])||p.serviceDate!==v.serviceDate||p.timezone!=='Europe/Kyiv'||!liveToolText(p.sourceName,4096)||p.observedAt!==null&&!validInstant(p.observedAt)||!Array.isArray(p.intervals)||p.intervals.length>2000)return invalid();
  for(const i of p.intervals){closed(i,['startsAt','endsAt','startLocal','endLocal','kind']);}
  // Reuse the actual schedule semantic validator, with private identities replaced by fixed non-authorizing markers.
  validateScheduleView({contractVersion:'lba-product/1',revisionId:'public-saved',addressId:'public-saved',addressLabel:p.label,localityLabel:p.localityLabel,operatorId:'public-saved',serviceDate:p.serviceDate,timezone:p.timezone,status:p.status,dayCoverage:p.dayCoverage,intervals:p.intervals,source:{id:'public-saved',name:p.sourceName,url:null,revision:'public-saved',accessCost:0,verifiedLevel:'schedule'},publishedAt:null,observedAt:p.observedAt??v.createdAt,freshness:p.freshness,synthetic:false,deliveryEligible:false} as ScheduleView);
  return {label:p.label,localityLabel:p.localityLabel,scope:p.scope,serviceDate:p.serviceDate,timezone:'Europe/Kyiv',status:p.status,dayCoverage:p.dayCoverage,freshness:p.freshness,intervals:p.intervals.map(i=>({startsAt:i.startsAt,endsAt:i.endsAt,startLocal:i.startLocal,endLocal:i.endLocal,kind:i.kind})),sourceName:p.sourceName,observedAt:p.observedAt} as LivePublicPlace;
 });
 return {runtime:'production',mode:'saved_plan',serviceDate:v.serviceDate,createdAt:v.createdAt,expiresAt:v.expiresAt,places};
}
export function liveToolsErrorMessage(code:unknown):string{
 if(code==='LIVE_TOOLS_INVALID_INPUT')return 'Перевірте дані дії й спробуйте ще раз.';
 if(code==='LIVE_TOOLS_ADDRESS_NOT_OWNED')return 'Цієї адреси вже немає у вашому профілі. Оновіть список адрес.';
 if(code==='LIVE_TOOLS_REVISION_CONFLICT'||code==='LIVE_TOOLS_SESSION_CONFLICT')return 'Профіль змінився. Оновіть його й перевірте дію ще раз.';
 if(code==='LIVE_TOOLS_INPUT_ID_CONFLICT')return 'Попередній запит має інший вміст. Оновіть стан, не створюючи повторної дії.';
 if(code==='LIVE_TOOLS_SHARE_NOT_FOUND')return 'Посилання не знайдено у вашому профілі.';
 if(code==='LIVE_TOOLS_DATE_OUT_OF_RANGE')return 'Поділитися можна планом на сьогодні або завтра.';
 if(code==='PRODUCTION_COMMIT_UNKNOWN'||code==='LIVE_TOOLS_COMMIT_UNKNOWN')return 'Результат ще не підтверджено. Перевірте той самий запит.';
 if(code==='LIVE_TOOLS_AUTH_REQUIRED')return 'Увійдіть у свій акаунт.';
 if(code==='LIVE_TOOLS_STORAGE_UNAVAILABLE')return 'Браузер не дозволив зберегти відновлення. Дію ще не надіслано.';
 return 'Не вдалося підтвердити результат. Оновіть стан або перевірте попередній запит.';
}
/** Validate the owner DTO as data, including known scalar slots; a field allowlist alone is insufficient. */
export function parseLiveToolsSnapshot(value:unknown):LiveToolsSnapshot{
 const v=closed(value,['runtime','sessionId','profileRevision','serverNow','capabilities','reports','legacyReports','legacyReportsStatus','digest','accounts','accountsStatus','shares','receipt','replayed']);
 if(v.runtime!=='production'||!liveToolText(v.sessionId,128)||!Number.isSafeInteger(v.profileRevision)||Number(v.profileRevision)<0||!validInstant(v.serverNow))return invalid();
 const c=closed(v.capabilities,['reports','shares','accountLinking','accountUnlinking','verifiedOutageStatistics']);if(c.reports!==true||c.shares!==true||c.accountLinking!==false||c.accountUnlinking!==false||c.verifiedOutageStatistics!==false)return invalid();
 if(!Array.isArray(v.reports)||v.reports.length>200||!Array.isArray(v.legacyReports)||v.legacyReports.length>200||!Array.isArray(v.accounts)||v.accounts.length>100||!Array.isArray(v.shares)||v.shares.length>100||!member(v.legacyReportsStatus,['available','unavailable'])||!member(v.accountsStatus,['available','unavailable']))return invalid();
 const reports=v.reports.map(raw=>{const r=closed(raw,['id','addressId','label','locality','value','recordedAt','archived']);if(!liveToolText(r.id,128)||!liveToolText(r.addressId)||!liveToolText(r.label,4096)||!liveToolText(r.locality,4096,true)||!member(r.value,['on','off'])||!validInstant(r.recordedAt)||typeof r.archived!=='boolean')return invalid();return {id:r.id,addressId:r.addressId,label:r.label,locality:r.locality,value:r.value,recordedAt:r.recordedAt,archived:r.archived} as LivePowerReport;});
 const legacyReports=v.legacyReports.map(raw=>{const r=closed(raw,['id','locality','group','value','reportedAtLiteral','timeZone','origin']);if(!liveToolText(r.id,128)||!liveToolText(r.locality,4096,true)||!liveToolText(r.group,128,true)||!member(r.value,['on','off'])||!liveToolText(r.reportedAtLiteral,128)||r.timeZone!=='unverified'||r.origin!=='legacy')return invalid();return {id:r.id,locality:r.locality,group:r.group,value:r.value,reportedAtLiteral:r.reportedAtLiteral,timeZone:'unverified',origin:'legacy'} as LiveLegacyReport;});
 const accounts=v.accounts.map(raw=>{const a=closed(raw,['provider','label','linkedAtLiteral']);if(!liveToolText(a.provider,20)||!liveToolText(a.label,4096)||a.linkedAtLiteral!==null&&!liveToolText(a.linkedAtLiteral,128))return invalid();return {provider:a.provider,label:a.label,linkedAtLiteral:a.linkedAtLiteral as string|null};});
 const shares=v.shares.map(raw=>{const s=closed(raw,['token','url','serviceDate','createdAt','expiresAt','status','labels']);if(!validReviewShareToken(s.token)||s.url!=='/shared-plan/'+s.token||!validReviewServiceDate(s.serviceDate)||!validInstant(s.createdAt)||!validInstant(s.expiresAt)||Date.parse(s.expiresAt)<=Date.parse(s.createdAt)||!member(s.status,['active','revoked','expired'])||!Array.isArray(s.labels)||!s.labels.length||s.labels.length>20||s.labels.some(l=>!liveToolText(l,4096)))return invalid();return {token:s.token,url:s.url,serviceDate:s.serviceDate,createdAt:s.createdAt,expiresAt:s.expiresAt,status:s.status,labels:[...s.labels]} as LiveShareSummary;});
 const d=closed(v.digest,['fromDate','throughDate','observationCount','observationDays','onCount','offCount','verifiedOutageDays','legacyDigestCount']);
 for(const key of ['observationCount','observationDays','onCount','offCount'])if(!Number.isSafeInteger(d[key])||Number(d[key])<0)return invalid();
 if(!validReviewServiceDate(d.fromDate)||!validReviewServiceDate(d.throughDate)||Date.parse(d.throughDate)-Date.parse(d.fromDate)!==6*86400000||Number(d.observationDays)>7||Number(d.observationDays)>Number(d.observationCount)||Number(d.onCount)+Number(d.offCount)!==d.observationCount||d.verifiedOutageDays!==0||d.legacyDigestCount!==null&&(!Number.isSafeInteger(d.legacyDigestCount)||Number(d.legacyDigestCount)<0))return invalid();
 if(v.replayed!==undefined&&typeof v.replayed!=='boolean')return invalid();const receipt=v.receipt===undefined?undefined:parseLiveToolReceipt(v.receipt);if(receipt&&(receipt.sessionId!==v.sessionId||receipt.profileRevision>Number(v.profileRevision)))return invalid();
 return {runtime:'production',sessionId:v.sessionId,profileRevision:Number(v.profileRevision),serverNow:v.serverNow,capabilities:{reports:true,shares:true,accountLinking:false,accountUnlinking:false,verifiedOutageStatistics:false},reports,legacyReports,legacyReportsStatus:v.legacyReportsStatus as 'available'|'unavailable',digest:{fromDate:d.fromDate,throughDate:d.throughDate,observationCount:Number(d.observationCount),observationDays:Number(d.observationDays),onCount:Number(d.onCount),offCount:Number(d.offCount),verifiedOutageDays:0,legacyDigestCount:d.legacyDigestCount===null?null:Number(d.legacyDigestCount)},accounts,accountsStatus:v.accountsStatus as 'available'|'unavailable',shares,...(receipt?{receipt}:{}),...(v.replayed!==undefined?{replayed:v.replayed}:{})};
}
export function parseLiveToolsRecovery(value:unknown):LiveToolsRecovery{
 const v=closed(value,['runtime','status','receipt','retry']);if(v.runtime!=='production')return invalid();
 if(v.status==='not_recorded'&&v.receipt===null&&v.retry==='same_request')return {runtime:'production',status:'not_recorded',receipt:null,retry:'same_request'};
 if(v.status==='recorded'&&v.retry==='none')return {runtime:'production',status:'recorded',receipt:parseLiveToolReceipt(v.receipt),retry:'none'};
 return invalid();
}
