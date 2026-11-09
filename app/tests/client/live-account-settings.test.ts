import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedAccountList,checkedAccountOperation,checkedAccountChallenge,checkedAccountStatus,checkedAccountMutation,checkedAccountRecovery,accountErrorMessage,loadPendingAccountOperation,readPendingAccountRecoveryHints,PENDING_ACCOUNT_OPERATION_KEY} from '../../client/src/product-review/LiveAccountSettings';
import {saveDraft,type DraftStorage} from '../../client/src/product-review/ux-drafts';
const base={id:'operation-original',expectedSessionId:'session-a',expectedRevision:12};
const challenge={kind:'challenge',challengeId:'11111111-1111-4111-8111-111111111111',startParam:'acctlink_'+'a'.repeat(64),expiresAt:'2026-11-09T12:05:00Z',miniAppUrl:null,state:'pending'};
const link={kind:'link',request:{...base,challengeId:challenge.challengeId,confirmed:true}};
const unlink={kind:'unlink',request:{...base,linkId:'link-2',linkRevision:'b'.repeat(64),confirmed:true}};
const linked={kind:'linked',operationId:base.id,provider:'telegram',linkId:'link-2',authEpoch:0,reauthenticate:false};
test('only exact owned-account DTO is accepted, unavailable is never an empty list',()=>{
 assert.deepEqual(checkedAccountList({links:[{id:'own-link',provider:'replit',linkRevision:'a'.repeat(64)}],authEpoch:1}).links[0].id,'own-link');
 for(const v of [null,{}, {links:[],authEpoch:1,error:'unavailable'}, {links:[],authEpoch:-1}, {links:[{id:'a',provider:'telegram',linkRevision:'a'.repeat(64),providerId:'private'}],authEpoch:0},{links:[{id:'a',provider:'telegram',linkRevision:'bad'}],authEpoch:0},{links:Array(2).fill({id:'same',provider:'telegram',linkRevision:'a'.repeat(64)}),authEpoch:0}])assert.throws(()=>checkedAccountList(v));
});
test('closed operation refuses false or missing consent and identity claims',()=>{
 assert.deepEqual(checkedAccountOperation(link),link);assert.deepEqual(checkedAccountOperation(unlink),unlink);
 for(const v of [{...link,request:{...link.request,confirmed:false}},{...unlink,request:{...unlink.request,confirmed:false}},{...link,request:{...link.request,ownerId:'foreign'}},{kind:'challenge',request:{...base,confirmed:true}},{...unlink,request:{...unlink.request,linkRevision:'wrong'}}])assert.throws(()=>checkedAccountOperation(v));
});
test('challenge with unavailable Mini App stays null; only exact server startapp URL is usable',()=>{
 assert.equal(checkedAccountChallenge(challenge).miniAppUrl,null);
 const url='https://t.me/PowerUkraineBot/verified_app?startapp='+challenge.startParam;
 assert.equal(checkedAccountChallenge({...challenge,miniAppUrl:url}).miniAppUrl,url);
 for(const u of ['https://power-ukraine.net','https://t.me/PowerUkraineBot?start='+challenge.startParam,url+'&owner=a',url+'#unsafe',url.replace('t.me','evil.example'),url.replace(challenge.startParam,'acctlink_'+'b'.repeat(64))])assert.throws(()=>checkedAccountChallenge({...challenge,miniAppUrl:u}));
 assert.throws(()=>checkedAccountChallenge({...challenge,expiresAt:'2026-02-30T12:00:00Z'}));
});
test('challenge status never accepts a different challenge, unmasked identity or ready claim in pending',()=>{
 const status={kind:'challenge_status',challengeId:challenge.challengeId,state:'ready_for_confirmation',expiresAt:challenge.expiresAt,accountLabel:'Telegram ••••1234'};
 assert.equal(checkedAccountStatus(status,challenge.challengeId).accountLabel,'Telegram ••••1234');
 for(const v of [{...status,challengeId:'22222222-2222-4222-8222-222222222222'},{...status,accountLabel:'@private-user'},{...status,state:'pending'},{...status,providerId:'1234'}])assert.throws(()=>checkedAccountStatus(v,challenge.challengeId));
});
test('mutation is correlated to exact operation and unlink exact target with required reauthentication',()=>{
 const operation=checkedAccountOperation(link);assert.equal(checkedAccountMutation(linked,operation).reauthenticate,false);
 for(const patch of [{operationId:'foreign'},{provider:'replit'},{reauthenticate:true},{kind:'unlinked'},{authEpoch:-1},{providerId:'private'}])assert.throws(()=>checkedAccountMutation({...linked,...patch},operation));
 const detached={...linked,kind:'unlinked',reauthenticate:true};assert.equal(checkedAccountMutation(detached,checkedAccountOperation(unlink)).linkId,'link-2');
 assert.throws(()=>checkedAccountMutation({...detached,linkId:'other'},checkedAccountOperation(unlink)));
});
test('unknown recovery has only not_recorded or exact recorded original result',()=>{
 const operation=checkedAccountOperation(link);
 assert.deepEqual(checkedAccountRecovery({kind:'recovery',state:'not_recorded'},operation),{kind:'recovery',state:'not_recorded'});
 assert.equal(checkedAccountRecovery({kind:'recovery',state:'recorded',result:linked},operation).state,'recorded');
 for(const v of [{kind:'recovery',state:'not_recorded',result:null},{kind:'recovery',state:'recorded',result:{...linked,operationId:'other'}},{kind:'recovery',state:'unknown'},{kind:'recovery',state:'recorded',result:challenge}])assert.throws(()=>checkedAccountRecovery(v,operation));
});
test('private pending request preserves original ID revision and session, rejects owner/session swaps',()=>{
 const values=new Map<string,string>();const storage:DraftStorage={getItem:key=>values.get(key)??null,setItem:(key,v)=>{values.set(key,v);},removeItem:key=>{values.delete(key);}};
 const originalWindow=globalThis.window;Object.defineProperty(globalThis,'window',{configurable:true,value:{sessionStorage:storage}});
 try{const scope={ownerId:'owner-a',sessionId:base.expectedSessionId};assert.equal(saveDraft('production-account-operation',scope,link,storage),true);
  const restored=loadPendingAccountOperation(scope);assert.deepEqual(restored,link);assert.equal(restored?.request.expectedRevision,12);
  assert.equal(loadPendingAccountOperation({...scope,ownerId:'owner-b'}),null);
  saveDraft('production-account-operation',scope,link,storage);assert.equal(loadPendingAccountOperation({...scope,sessionId:'new-session'}),null);
  saveDraft('production-account-operation',scope,{...link,request:{...link.request,expectedSessionId:'foreign'}},storage);assert.equal(loadPendingAccountOperation(scope),null);
 }finally{Object.defineProperty(globalThis,'window',{configurable:true,value:originalWindow});}
});
test('copy distinguishes last-login proof, foreign reconciliation, expired and unknown; no raw error leakage',()=>{
 assert.notEqual(accountErrorMessage('ACCOUNT_LAST_LOGIN_REQUIRED'),accountErrorMessage('ACCOUNT_RECONCILIATION_REQUIRED'));
 assert.notEqual(accountErrorMessage('ACCOUNT_CHALLENGE_EXPIRED'),accountErrorMessage(null));
 assert.equal(accountErrorMessage('postgres://private'),accountErrorMessage(null));
 assert.notEqual(accountErrorMessage('ACCOUNT_ORIGINAL_SESSION_REQUIRED',409),accountErrorMessage(null));
 assert.equal(accountErrorMessage('ACCOUNT_ORIGINAL_SESSION_REQUIRED',503),accountErrorMessage(null));
});
test('unauthenticated recovery hints are bounded closed private-storage hints with unchanged operation only',()=>{
 const envelope={version:1,ownerId:'private-owner',sessionId:base.expectedSessionId,generation:'same-generation',payload:unlink};
 const raw=JSON.stringify(envelope),hints=readPendingAccountRecoveryHints({getItem:key=>key===PENDING_ACCOUNT_OPERATION_KEY?raw:null});
 assert.equal(hints.length,1);assert.deepEqual(hints[0].operation,unlink);assert.equal(hints[0].storageToken,raw);assert.equal(hints[0].scope.ownerId,'private-owner');
 for(const v of [{...envelope,ownerId:''},{...envelope,sessionId:'foreign'},{...envelope,authority:'forged'},{...envelope,payload:[unlink,link]},{...envelope,payload:{...unlink,request:{...unlink.request,confirmed:false}}},{...envelope,version:2}])assert.deepEqual(readPendingAccountRecoveryHints({getItem:()=>JSON.stringify(v)}),[]);
 for(const v of ['{bad',raw+' '.repeat(65536),'null'])assert.deepEqual(readPendingAccountRecoveryHints({getItem:()=>v}),[]);
 assert.deepEqual(readPendingAccountRecoveryHints({getItem(){throw Error('storage denied');}}),[]);
});
