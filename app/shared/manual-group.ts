import type {AddressOption,ManualGroup} from './bot/types.ts';

/** The same technical identity used by the bot's existing manual-group flow. */
export function manualGroupAddressId(group:Pick<ManualGroup,'operatorId'|'namespace'|'targetId'>):string {
  return `manual:${encodeURIComponent(JSON.stringify([group.operatorId,group.namespace,group.targetId]))}`;
}

/** Server-owned choices use the existing exact option/fingerprint mutation contract.
 * Selecting a group never certifies an address or invents an electrical mapping. */
export function manualGroupOption(group:ManualGroup):AddressOption {
  const id=manualGroupAddressId(group);
  return {id:group.id,address:{id,label:`Черга ${group.label}`,territoryId:group.namespace,
    locality:group.locality,street:'',house:{number:'',literal:''},aliases:[]},
    binding:{addressId:id,operatorId:group.operatorId,namespace:group.namespace,targetId:group.targetId,
      kind:'user_selected_group',revisionId:group.revisionId,status:'needs_confirmation',verifiedAt:null,effectiveFrom:null,effectiveUntil:null},
    territoryLabel:group.territoryLabel,connectionLabel:`Група ${group.label}`};
}

/** Explicit public DTO projection: provider-private fields cannot leak by spread. */
export function parseManualGroups(value:unknown):ManualGroup[] {
  if(!Array.isArray(value)||value.length>10000)throw Error('MANUAL_GROUPS_INVALID');
  const ids=new Set<string>(),scopes=new Set<string>();
  return value.map(raw=>{
    const fields=['id','label','locality','territoryLabel','operatorId','namespace','targetId','revisionId'] as const;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||fields.some(key=>typeof raw[key]!=='string'||!raw[key].trim()||raw[key].length>128||/[\u0000-\u001f\u007f]/.test(raw[key])))throw Error('MANUAL_GROUPS_INVALID');
    const scope=JSON.stringify([raw.operatorId,raw.namespace,raw.targetId]);
    if(ids.has(raw.id)||scopes.has(scope))throw Error('MANUAL_GROUPS_INVALID');
    ids.add(raw.id);scopes.add(scope);
    return {id:raw.id,label:raw.label,locality:raw.locality,territoryLabel:raw.territoryLabel,operatorId:raw.operatorId,namespace:raw.namespace,targetId:raw.targetId,revisionId:raw.revisionId};
  });
}
