import type {ScheduleView} from './product-contract.ts';
import type {BotContext,BotMessage,BotState} from './bot/types.ts';
import {formatScheduleText} from './bot/copy.ts';
import {globalNotificationPolicy,resolveNotificationPolicy} from './notification-policy.ts';
import {calendarDate,canDeliver,dayBounds,localParts,validInstant,validateScheduleView} from './schedule-core.ts';

export interface MorningBriefingPacket {
 kind:'morning_briefing';id:string;serviceDate:string;createdAt:string;primaryAddressId:string|null;
 entries:Array<{addressId:string;label:string;kind:'schedule';view:ScheduleView}|
  {addressId:string;label:string;kind:'unavailable';reason:'not_certified'|'source_unverified'}>;
}
const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const clean=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\u0000-\u001f\u007f]/.test(v);
const closed=(v:unknown,keys:string[]):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&
 [Object.prototype,null].includes(Object.getPrototypeOf(v))&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k)));
const minute=(v:string)=>{const [h,m]=v.split(':').map(Number);return h*60+m;};
const dueCache=new Map<string,number|null>();
const clockFormatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
/** First real occurrence on a folded IANA day; a nonexistent spring time is
 * skipped. The bounded cache contains calendar/clock values, never user data. */
function dueInstant(day:string,time:string):number|null{
 const key=day+' '+time;if(dueCache.has(key))return dueCache.get(key)!;
 const bounds=dayBounds(day);let result:number|null=null;
 if(bounds.minutes===1440)result=bounds.start+minute(time)*60000;
 else for(let at=bounds.start;at<bounds.end;at+=60000)if(clockFormatter.format(new Date(at))===time){result=at;break;}
 dueCache.set(key,result);if(dueCache.size>128)dueCache.delete(dueCache.keys().next().value!);return result;
}
/** Legacy intent retained: one briefing per local date within ten minutes of
 * the configured time. This window never crosses Kyiv midnight. */
export function morningBriefingWindow(state:BotState,serviceDate:string,now:string):{dueAt:string;until:string}|null{
 try{
  calendarDate(serviceDate);if(!validInstant(now)||localParts(Date.parse(now)).date!==serviceDate)return null;
  const p=state.profile.preferences,b=p.morningBriefing;
  if(!globalNotificationPolicy(p,'telegram').enabled||b?.enabled!==true||!timePattern.test(b.time)||typeof p.quietHours?.enabled!=='boolean')return null;
  const due=dueInstant(serviceDate,b.time);if(due===null)return null;
  const at=Date.parse(now),until=Math.min(due+600000,dayBounds(serviceDate).end);
  if(at<due||at>=until)return null;
  if(p.quietHours.enabled){
   const q=p.quietHours;if(q.timezone!=='Europe/Kyiv'||!timePattern.test(q.start)||!timePattern.test(q.end)||q.start===q.end)return null;
   const a=minute(q.start),z=minute(q.end),actual=minute(localParts(at).time);
   if(a<z?actual>=a&&actual<z:actual>=a||actual<z)return null;
  }
  return {dueAt:new Date(due).toISOString(),until:new Date(until).toISOString()};
 }catch{return null;}
}
function chunks(text:string,limit:number):string[]{
 const result:string[]=[];let rest=text;
 while(rest.length>limit){
  let cut=rest.lastIndexOf('\n',limit);if(cut<limit/2)cut=limit;
  // Never split the two UTF-16 units of a code point. Keep every character.
  if(/[\uD800-\uDBFF]/.test(rest[cut-1])&&/[\uDC00-\uDFFF]/.test(rest[cut]))cut--;
  result.push(rest.slice(0,cut));rest=rest.slice(cut);
 }
 if(rest)result.push(rest);return result;
}
/** Pure aggregate formatter. No navigation/profile mutations, synthetic plan,
 * hidden address, invented online status or sender/certificate authority. */
export function handleMorningBriefing(state:BotState,packet:MorningBriefingPacket,context:BotContext):{messages:BotMessage[];primarySchedule?:ScheduleView}{
 const empty={messages:[] as BotMessage[]};
 if(context.actorId!==state.ownerId||!validInstant(context.now))return empty;
 const window=morningBriefingWindow(state,packet?.serviceDate,context.now);if(!window)return empty;
 if(!closed(packet,['kind','id','serviceDate','createdAt','primaryAddressId','entries'])||packet.kind!=='morning_briefing'||!clean(packet.id)||
  !validInstant(packet.createdAt)||packet.createdAt!==window.dueAt||packet.primaryAddressId!==state.profile.primaryAddressId||!Array.isArray(packet.entries))throw Error('INVALID_MORNING_BRIEFING');
 const locations=state.profile.locations.filter(l=>resolveNotificationPolicy(state.profile.preferences,l,'telegram').enabled);
 if(!locations.length)return empty;
 if(packet.entries.length!==locations.length||new Set(locations.map(l=>l.address.id)).size!==locations.length)throw Error('INVALID_MORNING_BRIEFING');
 const sections:string[]=[];
 for(let i=0;i<locations.length;i++){
  const entry=packet.entries[i],location=locations[i];
  if(!entry||!clean(entry.addressId)||!clean(entry.label)||entry.addressId!==location.address.id||entry.label!==location.address.label)throw Error('INVALID_MORNING_BRIEFING');
  if(entry.kind==='schedule'){
   if(!closed(entry,['addressId','label','kind','view']))throw Error('INVALID_MORNING_BRIEFING');
   validateScheduleView(entry.view);
   if(entry.view.addressId!==entry.addressId||entry.view.addressLabel!==entry.label||entry.view.serviceDate!==packet.serviceDate||
    !canDeliver(entry.view,location.binding,state.profile.preferences,context.now,'telegram'))throw Error('INVALID_MORNING_BRIEFING');
   sections.push(formatScheduleText(entry.view));
  }else{
   if(!closed(entry,['addressId','label','kind','reason'])||entry.kind!=='unavailable'||!['not_certified','source_unverified'].includes(entry.reason))throw Error('INVALID_MORNING_BRIEFING');
   sections.push(entry.label+'\n'+(entry.reason==='not_certified'?'Для цієї адреси ще немає перевіреного графіка на сьогодні.':'Графік для цієї адреси зараз не вдалося перевірити.')+
    '\nЧас відключення та відновлення поки невідомий.');
  }
 }
 const date=new Intl.DateTimeFormat('uk-UA',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Kyiv'}).format(new Date(packet.serviceDate+'T12:00:00Z'));
 const heading='Ранковий огляд · '+date,body=sections.join('\n\n'),text=heading+'\n\n'+body;
 const make=(value:string,i:number):BotMessage=>({id:packet.id+':'+i,kind:'notification',text:value,buttons:[],commitBarrier:'none'});
 if(text.length<=4096){
  const primary=packet.entries.find(e=>e.addressId===packet.primaryAddressId)??packet.entries[0];
  return {messages:[{...make(text,0),...(primary?.kind==='schedule'?{scheduleRevisionId:primary.view.revisionId}:{})}],...(primary?.kind==='schedule'?{primarySchedule:structuredClone(primary.view)}:{})};
 }
 const parts=chunks(body,3300);if(parts.length>100)throw Error('MORNING_BRIEFING_TOO_LARGE');
 return {messages:parts.map((part,i)=>make(heading+' · частина '+(i+1)+' з '+parts.length+'\n\n'+part,i))};
}
