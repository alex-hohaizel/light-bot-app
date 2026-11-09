import {createHash} from 'node:crypto';
import {restoreBotState,readProviderV2Draft,readProviderV2Tuple,providerV2SnapshotForState,providerV2PageItems,providerV2BatchAllowed} from '../../shared/bot/engine.ts';
import {houseMatchesQuery,normalizeAddressText} from '../../shared/address-index.ts';
import type {BotInput} from '../../shared/bot/types.ts';
import {ProductionProfileStoreError,type createProductionProfileStore} from './profile-store.ts';
import type {createProductAddressFlow} from './address-flow.ts';
import type {LegacyProfileReadPool,VerifiedLegacyPrincipal} from './profile-reader.ts';
import {parseProviderAddressLookupV2} from '../domain/provider-address-lookup.ts';

type Store=Pick<ReturnType<typeof createProductionProfileStore>,'commitGuardedBotInput'|'recoverReceipt'>;
/** Provider work precedes the canonical transaction. A second profile fence inside
 * the processor guard prevents a slow lookup from acting on a different wizard.
 * Replay never repeats a provider request. No profile is bootstrapped here. */
export function createBotAddressPreflight(ports:{store:Store;pool:LegacyProfileReadPool;flow:Pick<ReturnType<typeof createProductAddressFlow>,'lookup'|'forProfile'>;now:()=>string;wait?:(ms:number)=>Promise<void>}):Store{
 return Object.freeze({recoverReceipt:ports.store.recoverReceipt,
  async commitGuardedBotInput(principal,value,guard){
   if(await ports.store.recoverReceipt(principal,{channel:'bot',request:value}))return ports.store.commitGuardedBotInput(principal,value,guard);
   const request=value as {input:BotInput};let state;
   const client=await ports.pool.connect();try{
    const rows=(await client.query('select state from lba_production_profiles where owner_id=$1',[principal.ownerId])).rows;
    if(rows.length>1)throw Error('BOT_PREFLIGHT_STATE_INVALID');
    if(rows.length)state=restoreBotState(rows[0].state,principal.ownerId);
   }finally{client.release();}
   const input=request.input,draft=state?.draft,v2=readProviderV2Draft(draft?.providerV2);
   // A malformed v2 draft must never fall through to the numeric v1 provider.
   if(draft&&Object.hasOwn(draft,'providerV2')&&!v2)return ports.store.commitGuardedBotInput(principal,value,guard);
   if(!state||!draft||!v2&&draft.providerDirectoryId!=='yasno:25/902'||state.processedInputIds.includes(input.id))return ports.store.commitGuardedBotInput(principal,value,guard);
   if(input.kind==='text'){try{normalizeAddressText(input.text);}catch{return ports.store.commitGuardedBotInput(principal,value,guard);}}
   if(input.kind==='text'&&(input.text.trim().startsWith('/')||['назад','скасувати'].includes(input.text.trim().toLocaleLowerCase('uk-UA'))))return ports.store.commitGuardedBotInput(principal,value,guard);
   const session=state.sessionId,revision=state.revision;
   let performed=false,selectionChanged=false;
   async function lookup(operation:'localities'|'streets'|'houses'|'resolve',fields:Record<string,unknown>){
    performed=true;
    const id=(v2?'botlookupv2:':'botlookup:')+createHash('sha256').update(JSON.stringify(v2?['lba-address-lookup/2','dtek:oem',input.id,session,revision,operation,fields]:[input.id,session,revision,operation,fields])).digest('hex');
    const query={...(v2?{schemaVersion:'lba-address-lookup/2',directoryId:'dtek:oem'}:{}),id,expectedSessionId:session,expectedRevision:revision,operation,...fields};
    const invoke=async()=>{try{return await ports.flow.lookup(principal,query);}catch(error){if(error instanceof ProductionProfileStoreError&&['PRODUCTION_PROFILE_REVISION_CONFLICT','ADDRESS_FLOW_SELECTION_CHANGED'].includes(error.code)){selectionChanged=true;return {state:'stale'};}throw error;}};
    let result=await invoke();
    // One bounded wait for our shared local origin budget, never provider 403/429.
    const delay=Date.parse(result.retryAt??'')-Date.parse(ports.now());
    if(result.state==='deferred'&&result.code==='ADDRESS_BUDGET_DEFERRED'&&delay>0&&delay<=1500&&ports.wait){await ports.wait(delay+10);result=await invoke();}
    return result;
   }
   if(v2){
    const hints=ports.flow.forProfile(principal.ownerId,state,ports.now()),context={...hints,now:ports.now()};
    const stale=()=>{performed=true;selectionChanged=true;};
    async function v2Lookup(operation:'localities'|'streets'|'houses'|'resolve',fields:Record<string,unknown>){
     try{parseProviderAddressLookupV2({schemaVersion:'lba-address-lookup/2',directoryId:'dtek:oem',id:'preflight',expectedSessionId:session,expectedRevision:revision,operation,...fields});}
     catch{return;}
     await lookup(operation,fields);
    }
    if(input.kind==='text'){
     if(state.stage==='provider_locality')await v2Lookup('localities',{query:input.text});
     else if(['street','street_choice'].includes(state.stage)&&v2.catalogSnapshotId&&v2.cityKey){
      const parent=providerV2SnapshotForState(state,context,'localities');
      if(!parent||parent.id!==v2.catalogSnapshotId||!parent.items.some(r=>r.key===v2.cityKey))stale();
      else await v2Lookup('streets',{catalogSnapshotId:v2.catalogSnapshotId,cityKey:v2.cityKey,query:input.text});
     }else if(state.stage==='house'&&v2.catalogSnapshotId&&v2.cityKey&&v2.streetKey){
      const parent=providerV2SnapshotForState(state,context,'streets');
      if(!parent||!parent.items.some(r=>r.key===v2.streetKey))stale();
      else await v2Lookup('houses',{catalogSnapshotId:v2.catalogSnapshotId,cityKey:v2.cityKey,streetKey:v2.streetKey,query:input.text});
     }
    }else if(input.kind==='callback'){
     const record=state.callbacks[input.callbackId];
     if(record&&!record.consumed&&record.ownerId===principal.ownerId&&record.stateRevision===revision&&Date.parse(record.expiresAt)>Date.parse(ports.now())){
      const action=record.action;
      if(!action||typeof action!=='object'||Array.isArray(action)||typeof action.kind!=='string'){stale();}
      const kind=action&&typeof action==='object'&&!Array.isArray(action)&&typeof action.kind==='string'?action.kind:'';
      const t=action&&typeof action==='object'&&!Array.isArray(action)&&'value'in action?readProviderV2Tuple(kind,action.value):null;
      if(kind==='provider_v2_house'){
       const s=providerV2SnapshotForState(state,context,'houses');
       if(state.stage!=='house'||!t||t.length!==5||!s||t[0]!==s.catalogSnapshotId||t[1]!==s.id||t[2]!==s.cityKey||t[3]!==s.streetKey||!providerV2PageItems(state,s.items).some(r=>r.key===t[4]))stale();
       else await v2Lookup('resolve',{catalogSnapshotId:t[0],houseSnapshotId:t[1],cityKey:t[2],streetKey:t[3],houseKey:t[4]});
      }else if(kind==='provider_v2_batch'){
       if(!t||t.length!==8)stale();else{
        const level=t[0] as 'localities'|'streets'|'houses',s=providerV2SnapshotForState(state,context,level);
        if(!s||s.id!==t[1]||s.catalogSnapshotId!==t[2]||(s.cityKey??null)!==t[3]||(s.streetKey??null)!==t[4]||hints.providerLookupV2?.[level]?.query!==t[5]||s.offset!==t[6]||!providerV2BatchAllowed(state,s,t[7] as number))stale();
        else await v2Lookup(level,{query:t[5],offset:t[7],...(level!=='localities'?{catalogSnapshotId:t[2],cityKey:t[3]}:{}),...(level==='houses'?{streetKey:t[4]}:{})});
       }
      }else if(kind==='provider_v2_retry'){
       if(!t||t.length!==5)stale();else{
        const level=t[0] as 'localities'|'streets'|'houses',query=v2[level==='localities'?'localityQuery':level==='streets'?'streetQuery':'houseQuery'];
        const expectedStage=level==='localities'?'provider_locality':level==='streets'?'street_choice':'house';
        const parent=level==='localities'?null:providerV2SnapshotForState(state,context,level==='streets'?'localities':'streets');
        if(state.stage!==expectedStage||query!==t[4]||hints.providerLookupV2?.[level]?.query!==query||level!=='localities'&&(!parent||t[1]!==v2.catalogSnapshotId||t[2]!==v2.cityKey)||level==='houses'&&t[3]!==v2.streetKey)stale();
        else await v2Lookup(level,{query:t[4],...(level!=='localities'?{catalogSnapshotId:t[1],cityKey:t[2]}:{}),...(level==='houses'?{streetKey:t[3]}:{})});
       }
      }
     }
    }
   }else if(input.kind==='text'&&input.text.length<=100&&normalizeAddressText(input.text).length>=2&&['street','street_choice'].includes(state.stage)){
    await lookup('streets',{query:input.text});
   }else if(input.kind==='text'&&input.text.trim().length>=1&&input.text.length<=100&&['house','connection'].includes(state.stage)&&draft.providerStreetId&&draft.providerStreetSnapshotId){
    const result=await lookup('houses',{query:input.text,streetSnapshotId:draft.providerStreetSnapshotId,streetId:draft.providerStreetId});
    if(result.state==='available'&&result.snapshot){
     const matches=result.snapshot.items.filter((r:{value:string})=>houseMatchesQuery(r.value,input.text));
     if(matches.length===1)await lookup('resolve',{streetSnapshotId:draft.providerStreetSnapshotId,streetId:draft.providerStreetId,houseSnapshotId:result.snapshot.id,houseId:matches[0].id});
    }
   }else if(input.kind==='callback'){
    const record=state.callbacks[input.callbackId];
    if(record&&!record.consumed&&record.ownerId===principal.ownerId&&record.stateRevision===revision&&Date.parse(record.expiresAt)>Date.parse(ports.now())&&record.action&&typeof record.action==='object'&&record.action.kind==='provider_house'){
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
