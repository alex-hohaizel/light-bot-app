import {createHash} from 'node:crypto';
import {restoreBotState} from '../../shared/bot/engine.ts';
import {houseMatchesQuery,normalizeAddressText} from '../../shared/address-index.ts';
import type {BotInput} from '../../shared/bot/types.ts';
import {ProductionProfileStoreError,type createProductionProfileStore} from './profile-store.ts';
import type {createProductAddressFlow} from './address-flow.ts';
import type {LegacyProfileReadPool,VerifiedLegacyPrincipal} from './profile-reader.ts';

type Store=Pick<ReturnType<typeof createProductionProfileStore>,'commitGuardedBotInput'|'recoverReceipt'>;
/** Provider work precedes the canonical transaction. A second profile fence inside
 * the processor guard prevents a slow lookup from acting on a different wizard.
 * Replay never repeats a provider request. No profile is bootstrapped here. */
export function createBotAddressPreflight(ports:{store:Store;pool:LegacyProfileReadPool;flow:ReturnType<typeof createProductAddressFlow>;now:()=>string;wait?:(ms:number)=>Promise<void>}):Store{
 return Object.freeze({recoverReceipt:ports.store.recoverReceipt,
  async commitGuardedBotInput(principal,value,guard){
   if(await ports.store.recoverReceipt(principal,{channel:'bot',request:value}))return ports.store.commitGuardedBotInput(principal,value,guard);
   const request=value as {input:BotInput};let state;
   const client=await ports.pool.connect();try{
    const rows=(await client.query('select state from lba_production_profiles where owner_id=$1',[principal.ownerId])).rows;
    if(rows.length>1)throw Error('BOT_PREFLIGHT_STATE_INVALID');
    if(rows.length)state=restoreBotState(rows[0].state,principal.ownerId);
   }finally{client.release();}
   const input=request.input,draft=state?.draft;
   if(!state||!draft||draft.providerDirectoryId!=='yasno:25/902'||state.processedInputIds.includes(input.id))return ports.store.commitGuardedBotInput(principal,value,guard);
   if(input.kind==='text'){try{normalizeAddressText(input.text);}catch{return ports.store.commitGuardedBotInput(principal,value,guard);}}
   const session=state.sessionId,revision=state.revision;
   let performed=false,selectionChanged=false;
   async function lookup(operation:'streets'|'houses'|'resolve',fields:Record<string,unknown>){
    performed=true;
    const id='botlookup:'+createHash('sha256').update(JSON.stringify([input.id,session,revision,operation,fields])).digest('hex');
    const query={id,expectedSessionId:session,expectedRevision:revision,operation,...fields};
    const invoke=async()=>{try{return await ports.flow.lookup(principal,query);}catch(error){if(error instanceof ProductionProfileStoreError&&['PRODUCTION_PROFILE_REVISION_CONFLICT','ADDRESS_FLOW_SELECTION_CHANGED'].includes(error.code)){selectionChanged=true;return {state:'stale'};}throw error;}};
    let result=await invoke();
    // One bounded wait for our shared local origin budget, never provider 403/429.
    const delay=Date.parse(result.retryAt??'')-Date.parse(ports.now());
    if(result.state==='deferred'&&result.code==='ADDRESS_BUDGET_DEFERRED'&&delay>0&&delay<=1500&&ports.wait){await ports.wait(delay+10);result=await invoke();}
    return result;
   }
   if(input.kind==='text'&&input.text.length<=100&&normalizeAddressText(input.text).length>=2&&['street','street_choice'].includes(state.stage)){
    await lookup('streets',{query:input.text});
   }else if(input.kind==='text'&&input.text.trim().length>=1&&input.text.length<=100&&['house','connection'].includes(state.stage)&&draft.providerStreetId&&draft.providerStreetSnapshotId){
    const result=await lookup('houses',{query:input.text,streetSnapshotId:draft.providerStreetSnapshotId,streetId:draft.providerStreetId});
    if(result.state==='available'&&result.snapshot){
     const matches=result.snapshot.items.filter((r:{value:string})=>houseMatchesQuery(r.value,input.text));
     if(matches.length===1)await lookup('resolve',{streetSnapshotId:draft.providerStreetSnapshotId,streetId:draft.providerStreetId,houseSnapshotId:result.snapshot.id,houseId:matches[0].id});
    }
   }else if(input.kind==='callback'){
    const record=state.callbacks[input.callbackId];
    if(record&&!record.consumed&&record.ownerId===principal.ownerId&&record.stateRevision===revision&&Date.parse(record.expiresAt)>Date.parse(ports.now())&&record.action.kind==='provider_house'){
     let tuple;try{tuple=JSON.parse(record.action.value);}catch{tuple=null;}
     const hints=ports.flow.forProfile(principal.ownerId,state,ports.now()).providerHouses;
     if(Array.isArray(tuple)&&tuple.length===4&&hints?.state==='available'&&tuple[0]===draft.providerStreetSnapshotId&&tuple[0]===hints.streetSnapshotId&&tuple[1]===hints.houseSnapshotId&&tuple[2]===draft.providerStreetId&&hints.items.some(r=>r.id===tuple[3])){
      await lookup('resolve',{streetSnapshotId:tuple[0],houseSnapshotId:tuple[1],streetId:tuple[2],houseId:tuple[3]});
     }
    }
   }
   if(!performed)return ports.store.commitGuardedBotInput(principal,value,guard);
   return ports.store.commitGuardedBotInput(principal,value,guard,{sessionId:session,revision,...(selectionChanged?{selectionChanged:true as const}:{})});
  },
 });
}
