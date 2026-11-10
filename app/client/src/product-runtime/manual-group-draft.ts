import {draftFlag,draftText,exactKeys} from '../product-review/ux-drafts';

export interface ManualGroupDraft {
  addressId:string|null;baseline:string;operatorId:string;groupId:string;fingerprint:string;query:string;label:string;confirmed:boolean;
}
export function parseManualGroupDraft(input:unknown):ManualGroupDraft {
  const v=exactKeys(input,['addressId','baseline','operatorId','groupId','fingerprint','query','label','confirmed']);
  return {addressId:v.addressId===null?null:draftText(v.addressId,255),baseline:draftText(v.baseline,32768),operatorId:draftText(v.operatorId,128),
    groupId:draftText(v.groupId,128),fingerprint:draftText(v.fingerprint,32768),query:draftText(v.query,128),label:draftText(v.label,60),confirmed:draftFlag(v.confirmed)};
}
