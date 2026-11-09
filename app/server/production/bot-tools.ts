import {createHash} from 'node:crypto';
import type {ProductionProfileStoreOptions} from './profile-store.ts';
import type {createProductionTools} from './product-tools.ts';
import {localParts} from '../../shared/schedule-core.ts';

/** Trusted action recipes run inside the canonical Bot command transaction.
 * No provider/network calls and no optimistic successful-effect messages. */
export function createBotToolActions(options:{tools:Pick<ReturnType<typeof createProductionTools>,'commitActionInTransaction'>;origin:string}):NonNullable<ProductionProfileStoreOptions['handleBotActions']>{
 const url=new URL(options.origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/')throw Error('BOT_TOOLS_ORIGIN_INVALID');
 return async input=>{
  const handledKeys:string[]=[],messages=structuredClone(input.messages) as typeof input.messages[number][];
  for(const action of input.actions){
   const id='bottool:'+createHash('sha256').update(action.idempotencyKey).digest('hex');
   if(action.type==='record_power_report'||action.type==='prepare_share'){
    if(!action.addressId)throw Error('PRODUCTION_EFFECT_HANDLER_INVALID');
    const command=action.type==='record_power_report'?{kind:'report',addressId:action.addressId,value:action.value}:
      {kind:'share',addressIds:[action.addressId],ttlDays:1,serviceDate:localParts(Date.parse(input.serverNow)).date};
    const result=await options.tools.commitActionInTransaction({client:input.client,state:input.state,context:input.context,serverNow:input.serverNow},
      {id,expectedSessionId:input.state.sessionId,expectedRevision:input.state.revision,action:command});
    const line=action.type==='record_power_report'?'Вашу позначку збережено. Вона не змінює план оператора.':
      result.receipt.shareToken?'План доступний за посиланням протягом доби:\n'+url.origin+'/shared-plan/'+result.receipt.shareToken:null;
    if(!line)throw Error('PRODUCTION_EFFECT_HANDLER_INVALID');
    if(messages.length)messages[0]={...messages[0],text:line};
    else messages.push({id,kind:'reply',text:line,buttons:[],commitBarrier:'none'});
   }else if(action.type==='open_app'||action.type==='resolve_legacy_link'){
    const section=action.type==='open_app'&&['history','compare'].includes(action.value??'')?'?view='+encodeURIComponent(action.value!):'';
    const line=action.type==='resolve_legacy_link'?'Відкрийте застосунок і увійдіть у свій профіль. Старе посилання не переносить акаунти автоматично:\n':'Відкрити застосунок:\n';
    if(messages.length)messages[0]={...messages[0],text:line+url.origin+'/'+section};
    else messages.push({id,kind:'reply',text:line+url.origin+'/'+section,buttons:[],commitBarrier:'none'});
   }else throw Error('PRODUCTION_EFFECT_HANDLER_REQUIRED');
   handledKeys.push(action.idempotencyKey);
  }
  return {handledKeys,messages};
 };
}
