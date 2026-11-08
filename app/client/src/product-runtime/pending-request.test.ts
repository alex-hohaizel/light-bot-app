import test from 'node:test';
import assert from 'node:assert/strict';
import { savePendingProfile, loadPendingProfile, PENDING_PROFILE_KEY } from './pending-request.ts';
const request={id:'fixed-id',expectedSessionId:'session-a',expectedRevision:4,mutation:{kind:'rename' as const,addressId:'address-a',label:'Дім'}};
function storage(){const map=new Map<string,string>();return {getItem:(key:string)=>map.get(key)||null,setItem:(key:string,value:string)=>{map.set(key,value)},removeItem:(key:string)=>{map.delete(key)}};}
test('unknown request survives reload with original ID/baseline and cannot cross owner/session',()=>{
  const port=storage();savePendingProfile(port,'owner-a',request,100);assert.deepEqual(loadPendingProfile(port,'owner-a','session-a',200),request);
  assert.equal(loadPendingProfile(port,'owner-b','session-a',200),null);assert.equal(port.getItem(PENDING_PROFILE_KEY),null);
  savePendingProfile(port,'owner-a',request,100);assert.equal(loadPendingProfile(port,'owner-a','session-b',200),null);
});
test('malformed oversized future and expired pending data never retries',()=>{
  for(const raw of ['{','x'.repeat(65537),JSON.stringify({version:1,ownerId:'owner-a',sessionId:'session-a',savedAt:999,request})]){const port=storage();port.setItem(PENDING_PROFILE_KEY,raw);assert.equal(loadPendingProfile(port,'owner-a','session-a',100),null);assert.equal(port.getItem(PENDING_PROFILE_KEY),null);}
  const port=storage();savePendingProfile(port,'owner-a',request,0);assert.equal(loadPendingProfile(port,'owner-a','session-a',86400001),null);
});
