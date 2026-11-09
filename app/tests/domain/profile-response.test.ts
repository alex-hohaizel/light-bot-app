import test from 'node:test';
import assert from 'node:assert/strict';
import {profileResponseFailure,assertProfileSnapshotResponse,assertProfileCommitResponse} from '../../client/src/product-runtime/profile-response.ts';
import {createDemoProfile} from '../../shared/bot/fixtures.ts';

test('uncertain HTTP failures retain the original pending request, even with misleading application code',()=>{
 for(const status of [403,408,418,422,429,500,502,503,504])for(const value of [null,{error:'PRIVATE_PROVIDER_TOKEN'},{code:'PROFILE_SELECTION_CHANGED',error:'PRIVATE_PROVIDER_TOKEN'}]){
  const error=profileResponseFailure(status,value);assert.equal(error.definiteRejection,false);assert.doesNotMatch(error.message,/PRIVATE_PROVIDER_TOKEN/);
 }
});
test('only documented validation/conflict responses permit a fresh deliberate request',()=>{
 for(const [status,code] of [[400,'LIVE_PROFILE_INVALID_INPUT'],[409,'PROFILE_SELECTION_CHANGED'],[409,'PROFILE_SELECTION_REQUIRED'],[409,'PROFILE_REVISION_CONFLICT']] as const){
  const error=profileResponseFailure(status,{code,error:'PRIVATE_PROVIDER_TOKEN'});assert.equal(error.definiteRejection,true);assert.doesNotMatch(error.message,/PRIVATE_PROVIDER_TOKEN/);
 }
 assert.equal(profileResponseFailure(401,{code:'PRIVATE_TEXT'}).code,'LIVE_PROFILE_AUTH_REQUIRED');
 for(const code of ['FUTURE_CODE','LIVE_PROFILE_UNAVAILABLE','PRODUCTION_COMMIT_UNKNOWN'])assert.equal(profileResponseFailure(409,{code}).definiteRejection,false);
});
test('HTTP200 mutation response settles only the matching committed receipt; replay may return a newer snapshot',()=>{
 const request={id:'one',expectedSessionId:'session-one',expectedRevision:4,mutation:{kind:'rename' as const,addressId:'address-one',label:'Робота'}},owner='owner-one';
 const good={profile:{id:owner},sessionId:request.expectedSessionId,revision:5,catalog:[],simulationOnly:false,capabilities:{profileMutations:true,tools:false},replayed:false,
  receipt:{id:'receipt-one',inputId:'app:one',committed:true,sessionRevision:5,simulationOnly:false,sessionId:request.expectedSessionId,recordedAt:'2026-11-08T20:00:00Z',delivery:'none'}};
 assert.doesNotThrow(()=>assertProfileCommitResponse(good,request,'live',owner));
 assert.doesNotThrow(()=>assertProfileCommitResponse({...good,revision:9,replayed:true},request,'live',owner));
 const corrupt:Array<(v:any)=>void>=[v=>delete v.receipt,v=>{v.receipt.inputId='app:other';},v=>{v.receipt.sessionId='other';},v=>{v.sessionId='other';},v=>{v.profile.id='other';},v=>{v.receipt.committed=false;},v=>{v.receipt.simulationOnly=true;},v=>{v.receipt.sessionRevision=4;},v=>{v.receipt.sessionRevision=6;},v=>{v.revision=3;},v=>{v.receipt.recordedAt='invalid';},v=>{v.replayed='yes';}];
 for(const change of corrupt){const value=structuredClone(good);change(value);assert.throws(()=>assertProfileCommitResponse(value,request,'live',owner),(error:any)=>error.code==='PRODUCTION_COMMIT_UNKNOWN'&&error.definiteRejection===false);}
});
test('malformed HTTP200 snapshots fail safely before replacing an existing rendered profile',()=>{
 const good={profile:createDemoProfile(),sessionId:'session-one',revision:0,catalog:[],plans:[],simulationOnly:false,serverNow:'2026-11-08T20:00:00Z',releaseId:'f'.repeat(64),capabilities:{profileMutations:false,tools:false},migration:{status:'checking',message:'Перевіряємо дані.'}};
 assert.doesNotThrow(()=>assertProfileSnapshotResponse(good,'live'));assert.doesNotThrow(()=>assertProfileSnapshotResponse({...good,simulationOnly:true},'review'));
 const changes:Array<(v:any)=>void>=[v=>delete v.profile,v=>delete v.sessionId,v=>delete v.revision,v=>{v.profile.locations=null;},v=>{v.profile.locations[0].address.house.literal={private:'not text'};},v=>{v.profile.locations[0].address.placeNames='not an array';},v=>{v.profile.locations[0].binding.namespace={private:'bad'};},v=>{v.profile.preferences.quietHours.start='unknown';},v=>{v.profile.preferences.optedIn='false';},v=>{v.capabilities={};},v=>{v.migration.message={private:'not text'};},v=>{v.serverNow='wrong date';},v=>{v.catalog=null;}];
 for(const change of changes){const value=structuredClone(good);change(value);assert.throws(()=>assertProfileSnapshotResponse(value,'live'),(error:any)=>error.code==='LIVE_PROFILE_UNAVAILABLE'&&error.definiteRejection===false);}
});
