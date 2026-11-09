import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checkedInboxCallback,checkedCallbackTransportResult,callbackAckOperationId,TELEGRAM_CALLBACK_ACK_SCHEMA_SQL,CALLBACK_ACK_BOT_ID} from '../../server/production/telegram-callback-ack.ts';
import {createTelegramDispatcher} from '../../server/production/telegram-dispatch.ts';
const bot=CALLBACK_ACK_BOT_ID,at='2026-11-08T18:00:00Z',query='native-opaque-callback-query';
const input=()=>({botId:bot,updateId:'7',controlEpoch:9,ingressSha256:'a'.repeat(64),disposition:'accepted',eventKind:'callback',ignoredReason:null,receivedAt:at,privateInput:{version:'lba-telegram-private-input/1',botId:bot,updateId:'7',actorTelegramId:'700001',chatId:'700001',messageId:4,input:{id:`tg:${bot}:7`,kind:'callback',callbackId:'b1_session'},callbackQueryId:query}});
test('only closed native private callback source bound to exact bot, update and epoch admits ACK',()=>{
 const value=checkedInboxCallback(input(),9);assert.equal(value.callbackQueryId,query);assert.equal(value.chatId,'700001');
 for(const change of [(v:any)=>{v.controlEpoch=8;},(v:any)=>{v.eventKind='message';},(v:any)=>{v.privateInput.chatId='other';},(v:any)=>{v.privateInput.botId='other';},(v:any)=>{v.privateInput.input.id='forged';},(v:any)=>{v.privateInput.callbackQueryId='private\n';},(v:any)=>{v.privateInput.extraPrivate={token:'private'};},(v:any)=>{v.privateInput.input.callbackId='я'.repeat(33);}]){const v=input();change(v);assert.throws(()=>checkedInboxCallback(v,9),/callback_source_invalid/);}
 assert.equal(callbackAckOperationId('7'),callbackAckOperationId('7'));assert.notEqual(callbackAckOperationId('7'),callbackAckOperationId('8'));
});
test('callback receipt must be exact positive true native ACK, never a message receipt or guessed local retry',()=>{
 const operationId=callbackAckOperationId('7'),recipientRef='callback:'+operationId,expected={operationId,recipientRef,callbackQueryId:query},value:any={outcome:{kind:'sent',receipt:'tg-callback-'+createHash('sha256').update(query).digest('hex').slice(0,24)},receipt:{botId:bot,operationId,recipientRef,completedAt:at,attempts:[{method:'answerCallbackQuery',requestSha256:'b'.repeat(64),providerAccepted:true}]}};
 assert.equal(checkedCallbackTransportResult(value,expected).outcome.kind,'sent');
 for(const change of [(v:any)=>{v.receipt.attempts[0].method='sendMessage';},(v:any)=>{v.receipt.attempts[0].messageId=7;},(v:any)=>{v.receipt.operationId='wrong';},(v:any)=>{v.receipt.attempts[0].providerErrorCode=429;},(v:any)=>{v.outcome.receipt='tg-msg-7';}]){const bad=structuredClone(value);change(bad);assert.equal(checkedCallbackTransportResult(bad,expected).outcome.kind,'unknown');}
 const rate={...value,outcome:{kind:'rate_limited',retryAfterSeconds:2},receipt:{...value.receipt,attempts:[{method:'answerCallbackQuery',requestSha256:'b'.repeat(64),providerAccepted:false,providerErrorCode:429}]}};assert.equal(checkedCallbackTransportResult(rate,expected).outcome.kind,'rate_limited');for(const retryAfterSeconds of [0,'2',86401])assert.equal(checkedCallbackTransportResult({...rate,outcome:{kind:'rate_limited',retryAfterSeconds}},expected).outcome.kind,'unknown');
});
test('callback coordinator is default disabled with no SQL/provider; migration is inert additive DDL only',async()=>{
 let calls=0;const d=createTelegramDispatcher({expectedBotId:bot,expectedControlEpoch:9,workerId:'qa',pool:{connect:async()=>{calls++;throw Error('NO');}},now:()=>at,resolveEligibility:async()=>({eligible:false,reason:'unlinked'}),createTransport:()=>{calls++;throw Error('NO');}});assert.deepEqual(await d.dispatchNextCallbackAck(new AbortController().signal),{kind:'disabled'});assert.equal(calls,0);assert(!/\b(?:drop|truncate|delete|insert)\b/i.test(TELEGRAM_CALLBACK_ACK_SCHEMA_SQL));
});
test('callback negative provider claim without a definite4xx remains unknown; pre-effect rejection has no native attempt',()=>{
 const operationId=callbackAckOperationId('7'),recipientRef='callback:'+operationId,expected={operationId,recipientRef,callbackQueryId:query};
 for(const code of [undefined,429,500,'400']){const value:any={outcome:{kind:'not_sent',retryable:false,reason:'claimed_no_send'},receipt:{botId:bot,operationId,recipientRef,completedAt:at,attempts:[{method:'answerCallbackQuery',requestSha256:'b'.repeat(64),providerAccepted:false,...(code===undefined?{}:{providerErrorCode:code})}]}};assert.equal(checkedCallbackTransportResult(value,expected).outcome.kind,'unknown');}
 const before={outcome:{kind:'not_sent',retryable:false,reason:'telegram_capability_invalid'},receipt:{botId:bot,operationId,recipientRef,completedAt:at,attempts:[]}};assert.equal(checkedCallbackTransportResult(before,expected).outcome.kind,'not_sent');
});
