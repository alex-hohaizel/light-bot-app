import type {ProductSnapshot} from '../../../shared/live-product.ts';
import type {ProfileRequest} from '../../../shared/profile-mutation.ts';
import type {BotLocation} from '../../../shared/bot/types.ts';
import {addressOptionFingerprint} from '../../../shared/address-selection.ts';

/** The runtime supplies this only after validating the server's commit receipt. */
export interface ProfileCommit {before:ProductSnapshot;request:ProfileRequest;snapshot:ProductSnapshot}
export interface AddressSaveFeedback {
  ownerId:string;sessionId:string;revision:number;addressId:string|null;
  title:string;detail:string;action:'addresses'|'notifications'|null;
}
const channels=(location:BotLocation)=>location.notificationPolicy
  ?location.notificationPolicy.channels
  :{telegram:{enabled:location.notifications},push:{enabled:false}};

/** Describe the returned current state; a replay can include later changes. */
export function addressSaveFeedback({before,request,snapshot}:ProfileCommit):AddressSaveFeedback|null {
  const mutation=request.mutation,receipt=snapshot.receipt;
  if(!['add','replace'].includes(mutation.kind)||before.profile.id!==snapshot.profile.id||
    before.sessionId!==request.expectedSessionId||snapshot.sessionId!==request.expectedSessionId||
    !receipt||receipt.committed!==true||receipt.inputId!=='app:'+request.id||
    receipt.sessionRevision<=request.expectedRevision||receipt.sessionRevision>snapshot.revision)return null;
  if(mutation.kind!=='add'&&mutation.kind!=='replace')return null;
  const base={ownerId:snapshot.profile.id,sessionId:snapshot.sessionId,revision:snapshot.revision};
  const option=[...before.catalog,...snapshot.catalog].find(item=>item.id===mutation.optionId&&
    item.binding.revisionId===mutation.bindingRevisionId&&
    (mutation.selectionFingerprint===undefined||addressOptionFingerprint(item)===mutation.selectionFingerprint));
  const location=option&&snapshot.profile.locations.find(item=>item.address.id===option.address.id&&
    item.binding.operatorId===option.binding.operatorId&&item.binding.namespace===option.binding.namespace&&
    item.binding.targetId===option.binding.targetId);
  if(!location)return {...base,addressId:null,title:'Збереження підтверджено.',
    detail:'Перегляньте поточні адреси й налаштування.',action:'addresses'};
  const exactCurrent=before.revision===request.expectedRevision&&receipt.sessionRevision===snapshot.revision;
  const title=exactCurrent?`Адресу «${location.address.label}» збережено.`:'Збереження підтверджено.';
  const local=channels(location),allOff=!local.telegram.enabled&&!local.push.enabled;
  const unverified=location.binding.status!=='verified'||location.binding.kind==='user_selected_group';
  if(unverified)return {...base,addressId:location.address.id,title,
    detail:(location.binding.kind==='user_selected_group'?'Збережено обрану вами чергу. ':'')+
      'Для цієї адреси ще немає підтвердженого графіка.'+
      (allOff?' Сповіщення для неї вимкнені.':''),action:'addresses'};
  const previous=mutation.kind==='replace'?before.profile.locations.find(item=>item.address.id===mutation.addressId):undefined;
  const hadEnabled=previous&&(channels(previous).telegram.enabled||channels(previous).push.enabled);
  if(allOff&&(mutation.kind==='add'||hadEnabled))return {...base,addressId:location.address.id,title,
    detail:'Сповіщення для цієї адреси вимкнені. Їх можна окремо налаштувати.',action:'notifications'};
  return {...base,addressId:location.address.id,title:exactCurrent?'Адресу збережено.':'Збереження підтверджено.',
    detail:exactCurrent?'':'Перегляньте поточні адреси й налаштування.',action:exactCurrent?null:'addresses'};
}
