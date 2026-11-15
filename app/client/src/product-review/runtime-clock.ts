import type {ScheduleView} from '../../../shared/product-contract.ts';
import type {BotLocation} from '../../../shared/bot/types.ts';
import {calendarDate,localParts,validInstant,wallMinuteInstant} from '../../../shared/schedule-core.ts';

export function liveClock(serverNow: string, receivedMonotonic: number, currentMonotonic: number) {
  if (!validInstant(serverNow) || !Number.isFinite(receivedMonotonic) || !Number.isFinite(currentMonotonic) || currentMonotonic < receivedMonotonic)
    throw new Error('LIVE_CLOCK_UNAVAILABLE');
  const instant = new Date(Date.parse(serverNow) + currentMonotonic - receivedMonotonic).toISOString();
  return {asOf:instant,date:localParts(Date.parse(instant)).date};
}

/** Failure projection contains neither fixture intervals nor another address's source. */
export function missingLivePlan(location: BotLocation|undefined, addressId: string, label: string, date: string, asOf: string,
  status: 'unavailable'|'not_published'|'needs_confirmation'): ScheduleView {
  calendarDate(date);
  const observedAt=validInstant(asOf)?asOf:wallMinuteInstant(date,0);
  return {
    contractVersion:'lba-product/1',revisionId:`missing:${addressId}:${date}`,addressId,addressLabel:label,
    localityLabel:location?.address.locality||'',operatorId:location?.binding.operatorId||'unconfirmed',
    ...(location?{bindingRevisionId:location.binding.revisionId,namespace:location.binding.namespace,targetId:location.binding.targetId}:{}),
    serviceDate:date,timezone:'Europe/Kyiv',status,dayCoverage:'none',intervals:[],
    source:{id:'unconfirmed',name:'План цієї адреси ще не підтверджений',url:null,revision:'missing',accessCost:0,verifiedLevel:'catalog'},
    publishedAt:null,observedAt,freshness:'unknown',synthetic:false,deliveryEligible:false,
    notice:status==='needs_confirmation'?'Адресу збережено. Потрібно перевірити її прив’язку до графіка.':'Не вдалося отримати підтверджений план саме цієї адреси й дати.',
  };
}
