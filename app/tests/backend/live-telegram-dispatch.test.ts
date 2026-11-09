import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramDispatcher,profileDispatchOperationId,dispatchPayloadDigest,checkedDispatchPayload,checkedDispatchTransportResult,campaignSenderFromDispatcher,DISPATCH_BOT_ID,TELEGRAM_DISPATCH_SCHEMA_SQL,type DispatchPayload,type TelegramDispatcher} from '../../server/production/telegram-dispatch.ts';
const operationId='a'.repeat(64),recipientRef='owner:fixture',at='2026-11-08T18:00:00Z';
const payload:DispatchPayload={message:{id:'fixture-message',kind:'reply',text:'План оновлено.',buttons:[{label:'Мій план',callbackId:'b1_fixture'}],commitBarrier:'none'}};
const success=()=>({outcome:{kind:'sent',receipt:'tg-msg-7'},receipt:{botId:DISPATCH_BOT_ID,operationId,recipientRef,completedAt:at,attempts:[{method:'sendMessage',requestSha256:'b'.repeat(64),providerAccepted:true,messageId:7}]}});
test('stable profile operation and semantic digest survive key reorder without conflating another outbox',()=>{
 assert.equal(profileDispatchOperationId('one'),profileDispatchOperationId('one'));assert.notEqual(profileDispatchOperationId('one'),profileDispatchOperationId('two'));
 assert.equal(dispatchPayloadDigest(payload),dispatchPayloadDigest({message:{buttons:payload.message.buttons,text:payload.message.text,kind:'reply',id:'fixture-message',commitBarrier:'none'}}));
});
test('payload is closed, preserves full text, and rejects native overlimits without truncation',()=>{
 assert.deepEqual(checkedDispatchPayload(payload),payload);
 for(const value of [{...payload,privateToken:'private'},{message:{...payload.message,text:'x'.repeat(4097)}},{message:{...payload.message,buttons:[{label:'Стан',callbackId:'я'.repeat(33)}]}},{message:{...payload.message,buttons:Array.from({length:17},()=>payload.message.buttons[0])}}])assert.throws(()=>checkedDispatchPayload(value));
 assert.equal(payload.message.text,'План оновлено.');
});
test('provider-confirmed success requires exact target/context, completed timestamp, message ID and internally consistent receipt',()=>{
 assert.equal(checkedDispatchTransportResult(success(),{operationId,recipientRef}).outcome.kind,'sent');
 const variants:any[]=[];
 for(const patch of [{botId:'other'},{operationId:'other'},{recipientRef:'other'},{completedAt:null}])variants.push({...success(),receipt:{...success().receipt,...patch}});
 for(const patch of [{method:'getMe'},{providerAccepted:false},{messageId:0},{providerErrorCode:429},{requestSha256:'invalid'}])variants.push({...success(),receipt:{...success().receipt,attempts:[{...success().receipt.attempts[0],...patch}]}});
 for(const value of variants)assert.equal(checkedDispatchTransportResult(value,{operationId,recipientRef}).outcome.kind,'unknown');
});
test('rate limit must be a real nonaccepted429 with bounded retry_after, never a guessed local delay',()=>{
 const value:any={outcome:{kind:'rate_limited',retryAfterSeconds:2},receipt:{botId:DISPATCH_BOT_ID,operationId,recipientRef,completedAt:at,attempts:[{method:'sendMessage',requestSha256:'b'.repeat(64),providerAccepted:false,providerErrorCode:429}]}};
 assert.equal(checkedDispatchTransportResult(value,{operationId,recipientRef}).outcome.kind,'rate_limited');
 for(const retry of [0,'2',86401])assert.equal(checkedDispatchTransportResult({...value,outcome:{kind:'rate_limited',retryAfterSeconds:retry}},{operationId,recipientRef}).outcome.kind,'unknown');
 assert.equal(checkedDispatchTransportResult({...value,receipt:{...value.receipt,attempts:[]}},{operationId,recipientRef}).outcome.kind,'unknown');
});
test('only a rejected photo400 may precede an accepted text; multiple positive receipts fail stopped',()=>{
 const r=success();r.receipt.attempts.unshift({method:'sendPhoto',requestSha256:'c'.repeat(64),providerAccepted:false,messageId:undefined} as any);(r.receipt.attempts[0] as any).providerErrorCode=400;
 assert.equal(checkedDispatchTransportResult(r,{operationId,recipientRef}).outcome.kind,'sent');
 (r.receipt.attempts[0] as any).providerErrorCode=500;assert.equal(checkedDispatchTransportResult(r,{operationId,recipientRef}).outcome.kind,'unknown');
});
test('raw errors/private fields are never copied into sanitized outcome or receipt',()=>{
 const value:any=success();value.receipt.rawToken='DO_NOT_EXPORT';value.receipt.attempts[0].chatId='DO_NOT_EXPORT';
 const safe=checkedDispatchTransportResult(value,{operationId,recipientRef});assert(!JSON.stringify(safe).includes('DO_NOT_EXPORT'));
 value.outcome={kind:'unknown',reason:'https://api.telegram.org/botsecret'};assert.equal(checkedDispatchTransportResult(value,{operationId,recipientRef}).outcome.kind,'unknown');assert(!JSON.stringify(checkedDispatchTransportResult(value,{operationId,recipientRef})).includes('botsecret'));
});
test('default disabled and invalid bot/options cannot access database, factory, read grant or provider',async()=>{
 let calls=0;const options:any={expectedBotId:DISPATCH_BOT_ID,expectedControlEpoch:7,workerId:'fixture',pool:{connect:async()=>{calls++;throw Error('NO');}},now:()=>at,resolveEligibility:async()=>{calls++;return {eligible:false};},createTransport:()=>{calls++;throw Error('NO');}};
 const dispatcher=createTelegramDispatcher(options);assert.deepEqual(await dispatcher.dispatchNextPending(new AbortController().signal),{kind:'disabled'});assert.equal(calls,0);
 for(const patch of [{expectedBotId:'wrong'},{expectedControlEpoch:0},{limits:{scan:0}}])assert.throws(()=>createTelegramDispatcher({...options,...patch}));
 // An explicit nullable subject migration may DROP NOT NULL while retaining
 // branch-specific CHECKs. Row/object destruction remains forbidden.
 assert(!/\b(?:drop\s+(?:table|schema|database|column|index|sequence|constraint)|truncate|insert\s+into|delete\s+from)\b/i.test(TELEGRAM_DISPATCH_SCHEMA_SQL));
});
test('campaign extension uses the shared coordinator and cannot turn local busy/deferred into fake Telegram429',async()=>{
 let invoked=0;const base:any={releaseId:'release',deploymentId:'deployment',buildSha256:'a'.repeat(64),botId:DISPATCH_BOT_ID,origin:'https://example.invalid',operationId,recipientRef,text:'Оновлення.',appUrl:'https://example.invalid'};
 const dispatcher={dispatchCampaign:async()=>{invoked++;return {kind:'busy'};}} as unknown as TelegramDispatcher;
 const reply=await campaignSenderFromDispatcher(dispatcher).send(base,new AbortController().signal);assert.equal(invoked,1);assert.equal(reply.body,null);
});
test('a negative outcome after native intent needs a definite4xx rejection; missing/5xx/429 cannot settle as known no-send',()=>{
 for(const code of [undefined,429,500,'400']){
  const value:any={outcome:{kind:'not_sent',retryable:false,reason:'claimed_no_send'},receipt:{botId:DISPATCH_BOT_ID,operationId,recipientRef,completedAt:at,attempts:[{method:'sendMessage',requestSha256:'b'.repeat(64),providerAccepted:false,...(code===undefined?{}:{providerErrorCode:code})}]}};
  assert.equal(checkedDispatchTransportResult(value,{operationId,recipientRef}).outcome.kind,'unknown');
 }
});
