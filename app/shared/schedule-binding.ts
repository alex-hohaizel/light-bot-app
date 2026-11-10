import type {AddressBinding,ScheduleView} from './product-contract.ts';
import {validInstant,validateScheduleView,localParts,nextCalendarDate} from './schedule-core.ts';

/** Displaying an explicitly chosen group never certifies its physical building
 * or grants notification delivery. Both clients use this same narrow rule. */
export function planMatchesDisplay(view:ScheduleView,binding:AddressBinding,now:string):boolean {
 try{
  validateScheduleView(view);if(!validInstant(now))return false;
  if([binding.verifiedAt,binding.effectiveFrom,binding.effectiveUntil].some(v=>v!==null&&!validInstant(v)))return false;
  if(view.addressId!==binding.addressId||view.operatorId!==binding.operatorId||view.namespace!==binding.namespace||view.targetId!==binding.targetId||view.bindingRevisionId!==binding.revisionId)return false;
  if(Date.parse(view.observedAt)>Date.parse(now)||view.publishedAt&&Date.parse(view.publishedAt)>Date.parse(now)||
    binding.effectiveFrom&&Date.parse(binding.effectiveFrom)>Date.parse(now)||binding.effectiveUntil&&Date.parse(binding.effectiveUntil)<=Date.parse(now))return false;
  if(binding.status==='verified'&&binding.verifiedAt!==null&&Date.parse(binding.verifiedAt)<=Date.parse(now)&&['building','connection','operator_group'].includes(binding.kind))return true;
  const today=localParts(Date.parse(now)).date;
  return ['user_selected_group','operator_group'].includes(binding.kind)&&binding.status==='needs_confirmation'&&(view.deliveryEligible===false||view.source.verifiedLevel==='initial_launch')&&
   ['schedule','address','integration','initial_launch'].includes(view.source.verifiedLevel)&&[today,nextCalendarDate(today)].includes(view.serviceDate)&&
   (view.freshness==='current'||view.freshness==='stale'&&view.status==='stale');
 }catch{return false;}
}
