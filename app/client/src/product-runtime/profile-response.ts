import {parseOperatorHouseNotices} from '../../../shared/operator-house-notice.ts';
import {profileErrorMessage} from '../../../shared/profile-errors.ts';
import type {ProfileRequest} from '../../../shared/profile-mutation.ts';
import type {ProductSnapshot} from '../../../shared/live-product.ts';
import {validInstant,validateScheduleView} from '../../../shared/schedule-core.ts';
import {parseLocationNotificationPolicy,parseNotificationPolicy} from '../../../shared/notification-policy.ts';
import {parseManualGroups} from '../../../shared/manual-group.ts';

const object=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const text=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=255;
const lookupCapability=(v:unknown)=>v===undefined||Array.isArray(v)&&v.length<=1&&v.every(x=>x==='dtek:oem');
/** Validate the fields consumed by the UI before replacing a good snapshot.
 * Authentication and source accuracy remain server/provider responsibilities. */
export function assertProfileSnapshotResponse(value:unknown,mode:'review'|'live'):asserts value is ProductSnapshot {
 const bad=()=>{throw Object.assign(new Error(profileErrorMessage('LIVE_PROFILE_UNAVAILABLE')),{code:'LIVE_PROFILE_UNAVAILABLE',definiteRejection:false});};
 const str=(v:unknown,max=4096,empty=true)=>typeof v==='string'&&v.length<=max&&(empty||Boolean(v.trim()))&&!/[\u0000-\u001f\u007f]/.test(v);
 const integer=(v:unknown,max:number)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
 const wall=(v:unknown)=>typeof v==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
 const strings=(v:unknown)=>Array.isArray(v)&&v.length<=1000&&v.every(x=>str(x));
 const address=(a:any)=>{
  if(!object(a)||!object(a.house)||![a.id,a.territoryId].every(x=>str(x,512,false))||
    ![a.label,a.locality,a.street,a.house.number,a.house.literal].every(x=>str(x))||!strings(a.aliases))return false;
  if([a.house.letter,a.house.building].some(x=>x!==undefined&&!str(x,255)))return false;
  if([a.localityId,a.streetId].some(x=>x!==undefined&&!str(x,512,false)))return false;
  if([a.localityAliases,a.placeNames].some(x=>x!==undefined&&!strings(x)))return false;
  return a.objectKind===undefined||['residential','commercial','public','other'].includes(a.objectKind);
 };
 const binding=(b:any,id:string)=>object(b)&&b.addressId===id&&[b.addressId,b.operatorId,b.namespace,b.targetId,b.revisionId].every(x=>str(x,512,false))&&
  ['building','connection','operator_group','user_selected_group'].includes(b.kind)&&['verified','needs_confirmation','ambiguous','stale'].includes(b.status)&&
  [b.verifiedAt,b.effectiveFrom,b.effectiveUntil].every(x=>x===null||validInstant(x));
 try{
  if(!object(value)||value.simulationOnly!==(mode==='review')||!text(value.sessionId)||!integer(value.revision,Number.MAX_SAFE_INTEGER)||!object(value.profile)||
    !text(value.profile.id)||!Array.isArray(value.profile.locations)||value.profile.locations.length>10000||!Array.isArray(value.catalog)||value.catalog.length>10000)return bad();
  const p=value.profile,ids=new Set<string>(),optionIds=new Set<string>();
  for(const l of p.locations){if(!object(l)||!address(l.address)||!binding(l.binding,l.address.id)||typeof l.notifications!=='boolean'||typeof l.paused!=='boolean'||ids.has(l.address.id))return bad();ids.add(l.address.id);if(l.notificationPolicy!==undefined)parseLocationNotificationPolicy(l.notificationPolicy);}
  if(value.operatorHouseNotices!==undefined)parseOperatorHouseNotices(value.operatorHouseNotices,p.locations);
  if(value.manualGroups!==undefined)parseManualGroups(value.manualGroups);
  if(p.primaryAddressId!==null&&!ids.has(p.primaryAddressId))return bad();
  const prefs=p.preferences;if(!object(prefs)||!object(prefs.quietHours)||!object(prefs.morningBriefing)||
    [prefs.optedIn,prefs.paused,prefs.reminders,prefs.quietHours.enabled,prefs.morningBriefing.enabled].some(v=>typeof v!=='boolean')||
    !integer(prefs.remindBeforeMinutes,1440)||!integer(prefs.minimumOutageMinutes,86400)||!wall(prefs.quietHours.start)||!wall(prefs.quietHours.end)||!wall(prefs.morningBriefing.time)||
    prefs.quietHours.timezone!=='Europe/Kyiv'||prefs.quietHours.enabled&&prefs.quietHours.start===prefs.quietHours.end)return bad();
  if(prefs.notificationPolicy!==undefined)parseNotificationPolicy(prefs.notificationPolicy);
  for(const o of value.catalog){if(!object(o)||!str(o.id,512,false)||optionIds.has(o.id)||!address(o.address)||!binding(o.binding,o.address.id)||!str(o.territoryLabel)||o.connectionLabel!==undefined&&!str(o.connectionLabel))return bad();optionIds.add(o.id);}
  if(value.plans!==undefined){if(!Array.isArray(value.plans)||value.plans.length>20000)return bad();for(const v of value.plans){if(!object(v)||!object(v.source)||![v.addressLabel,v.localityLabel,v.source.name].every(x=>str(x))||v.source.url!==null&&!str(v.source.url)||v.notice!==undefined&&!str(v.notice,65536))return bad();validateScheduleView(v as any);if(mode==='live'&&v.synthetic!==false)return bad();}}
  if(mode==='live'&&(!Array.isArray(value.plans)||!validInstant(value.serverNow)||!str(value.releaseId,512,false)||!object(value.capabilities)||typeof value.capabilities.profileMutations!=='boolean'||typeof value.capabilities.tools!=='boolean'||!lookupCapability(value.capabilities.addressLookupV2)||
    !object(value.migration)||!['checking','needs_confirmation','ready'].includes(value.migration.status)||!str(value.migration.message)))return bad();
 }catch{return bad();}
}
/** A success status alone does not settle a previously persisted mutation. */
export function assertProfileCommitResponse(value:unknown,request:ProfileRequest,mode:'review'|'live',ownerId:string):asserts value is ProductSnapshot {
 const bad=()=>{throw Object.assign(new Error(profileErrorMessage('PRODUCTION_COMMIT_UNKNOWN')),{code:'PRODUCTION_COMMIT_UNKNOWN',definiteRejection:false});};
 if(!object(value)||!object(value.profile)||value.profile.id!==ownerId||value.sessionId!==request.expectedSessionId||
   !Number.isSafeInteger(value.revision)||value.revision<request.expectedRevision||!Array.isArray(value.catalog)||
   value.simulationOnly!==(mode==='review')||!object(value.receipt))return bad();
 const r=value.receipt;
 if(!text(r.id)||r.committed!==true||r.inputId!=='app:'+request.id||r.simulationOnly!==(mode==='review')||
   !Number.isSafeInteger(r.sessionRevision)||r.sessionRevision<=request.expectedRevision||r.sessionRevision>value.revision||typeof value.replayed!=='boolean')return bad();
 if(mode==='live'&&(!object(value.capabilities)||typeof value.capabilities.profileMutations!=='boolean'||typeof value.capabilities.tools!=='boolean'||!lookupCapability(value.capabilities.addressLookupV2)||
   r.sessionId!==request.expectedSessionId||!text(r.recordedAt)||!Number.isFinite(Date.parse(r.recordedAt))||!['pending','none'].includes(r.delivery)))return bad();
}

/** Only a known application rejection at its documented status releases the
 * pending request. A proxy response or rate limit cannot prove no commit. */
export function profileResponseFailure(status:number,value:unknown):Error & {status:number;code:string;definiteRejection:boolean} {
  const code=status===401?'LIVE_PROFILE_AUTH_REQUIRED':value&&typeof value==='object'&&!Array.isArray(value)&&
    typeof (value as Record<string,unknown>).code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test((value as {code:string}).code)
    ?(value as {code:string}).code:'LIVE_PROFILE_UNAVAILABLE';
  const conflicts=['PROFILE_ADDRESS_ALREADY_SAVED','PROFILE_ADDRESS_LIMIT','PROFILE_ADDRESS_NOT_FOUND',
    'PROFILE_OPTION_NOT_FOUND','PROFILE_BINDING_REVISION_CONFLICT','PROFILE_SELECTION_CHANGED','PROFILE_SELECTION_REQUIRED',
    'PROFILE_BINDING_NOT_VERIFIED','PROFILE_REVISION_CONFLICT','PRODUCTION_PROFILE_REVISION_CONFLICT','PRODUCTION_INPUT_ID_CONFLICT'];
  const definiteRejection=status===401||status===400&&['LIVE_PROFILE_INVALID_INPUT','LIVE_PROFILE_QUERY_REJECTED'].includes(code)||
    status===409&&conflicts.includes(code);
  return Object.assign(new Error(profileErrorMessage(code)),{status,code,definiteRejection});
}
