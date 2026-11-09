import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeSourceProof} from '../../server/production/runtime-source-proof.ts';
import {createBotState} from '../../shared/bot/engine.ts';
const now='2026-11-08T20:00:00Z';
function request(){const state=createBotState({ownerId:'qa-proof',sessionId:'qa-proof-session'});return {
 client:{query:async()=>{throw Error('PRIVATE_DATABASE_ERROR_SHOULD_NOT_LEAK');},release(){}},profile:state,now,phase:'native' as const,signal:new AbortController().signal,
 job:{sourceKind:'profile',ownerId:state.ownerId,sessionId:state.sessionId,controlEpoch:7,payload:{message:{kind:'notification'}}},
};}
test('factory requires a safe exact epoch and bounded short-lived grant without creating IO',()=>{
 for(const value of [0,-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>createRuntimeSourceProof({expectedControlEpoch:value}));
 for(const ttl of [0,-1,1.5,5001])assert.throws(()=>createRuntimeSourceProof({expectedControlEpoch:7,grantTtlMs:ttl}));
 assert.equal(typeof createRuntimeSourceProof({expectedControlEpoch:7}),'function');
});
test('notification/campaign/no-schedule inputs cannot acquire an event proof or query SQL',async()=>{
 const verify=createRuntimeSourceProof({expectedControlEpoch:7});let sql=0;const r=request();r.client.query=async()=>{sql++;throw Error('NO');};
 assert.equal(await verify(r as any),null);r.job.payload.message.kind='schedule';assert.equal(await verify(r as any),null);
 (r.job as any).sourceKind='campaign';assert.equal(await verify(r as any),null);assert.equal(sql,0);
});
test('foreign owner/session/epoch, abort, invalid clock and thrown input stay closed without propagating raw errors',async()=>{
 const verify=createRuntimeSourceProof({expectedControlEpoch:7}),r=request();
 for(const patch of [{now:'not-an-instant'},{profile:{...r.profile,ownerId:'foreign'}},{job:{...r.job,sessionId:'foreign'}},{job:{...r.job,controlEpoch:8}},{signal:AbortSignal.abort()}])assert.equal(await verify({...r,...patch} as any),null);
 assert.equal(await verify(null as any),null);assert.equal(await verify({} as any),null);
});
