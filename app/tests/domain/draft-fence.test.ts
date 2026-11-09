import test from 'node:test';
import assert from 'node:assert/strict';
import {saveDraft,loadDraft,readScopedDraftToken,clearScopedDraft,parseAddressDraft} from '../../client/src/product-review/ux-drafts.ts';
const store=()=>{const values=new Map<string,string>();return {values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};};
test('an old asynchronous completion cannot clear another account, session or newer generation of the same draft',()=>{
 const storage=store(),scope={ownerId:'owner-a',sessionId:'s-a'},payload={privateLabel:'Дім'};
 assert.equal(saveDraft('address',scope,payload,storage),true);const token=readScopedDraftToken('address',scope,storage);assert.ok(token);
 for(const nextScope of [{ownerId:'owner-b',sessionId:'s-b'},{ownerId:'owner-a',sessionId:'s-new'},scope]){
  assert.equal(saveDraft('address',nextScope,payload,storage),true);clearScopedDraft('address',scope,storage,token);
  assert.notEqual(readScopedDraftToken('address',nextScope,storage),null);
 }
 const current=readScopedDraftToken('address',scope,storage);clearScopedDraft('address',scope,storage,current);assert.equal(storage.values.size,0);
});
test('version1 drafts before generation metadata still load, while unknown envelope fields remain refused',()=>{
 const storage=store(),scope={ownerId:'a',sessionId:'s'},key='lba:ux-a:draft:address';
 storage.setItem(key,JSON.stringify({version:1,...scope,payload:{value:'old'}}));assert.deepEqual(loadDraft('address',scope,x=>x,storage),{value:'old'});
 storage.setItem(key,JSON.stringify({version:1,...scope,unknown:'not permitted',payload:{value:'old'}}));assert.equal(loadDraft('address',scope,x=>x,storage),null);
});
test('source-sized address drafts retain stable street identity without truncating it or persisting confirmation fingerprint',()=>{
 const draft={addressId:'x'.repeat(255),baselineFingerprint:'f'.repeat(32000),baselineLabel:'Дім',step:1,cityKey:'c'.repeat(1000),query:'q'.repeat(500),street:'s'.repeat(500),streetKey:'k'.repeat(2000),house:'12А',label:'Дім',confirmed:false,optionId:'o'.repeat(255),bindingRevisionId:'r'.repeat(255)};
 assert.deepEqual(parseAddressDraft(draft),draft);assert.throws(()=>parseAddressDraft({...draft,selectionFingerprint:'must not restore consent'}));
});
