import test from 'node:test';
import assert from 'node:assert/strict';
import {completeTelegramBrowserLogin,requestTelegramBrowserChallenge} from '../../client/src/lib/telegram-login-widget.ts';

test('a lost complete response checks the real cookie session exactly once and never resends Telegram proof',async()=>{
 const original=globalThis.fetch,calls:{url:string;options?:RequestInit}[]=[];
 globalThis.fetch=async(input,options)=>{calls.push({url:String(input),options});if(calls.length===1)throw Error('SYNTHETIC_NETWORK_LOST');return new Response(JSON.stringify({id:'qa-owner'}),{status:200});};
 try{
  const proof={id:42,hash:'synthetic-provider-signature'};await completeTelegramBrowserLogin('A'.repeat(43),proof);
  assert.deepEqual(calls.map(call=>call.url),['/api/auth/telegram-browser/complete','/api/auth/user']);
  assert.equal(calls[0].options?.method,'POST');assert.deepEqual(JSON.parse(String(calls[0].options?.body)),{challenge:'A'.repeat(43),telegramData:proof});
  assert.equal(calls[1].options?.body,undefined);assert(calls.every(call=>call.options?.credentials==='same-origin'&&call.options?.cache==='no-store'));
 }finally{globalThis.fetch=original;}
});
test('HTTP success or malformed completion does not authenticate without a confirmed actual user session',async()=>{
 const original=globalThis.fetch;
 try{
  for(const result of [{status:200,body:{ok:true}},{status:401,body:{error:'declined'}},{status:200,body:{ok:'true'}}]){
   let n=0;globalThis.fetch=async()=>++n===1?new Response(JSON.stringify(result.body),{status:result.status}):new Response(JSON.stringify({error:'unauthorized'}),{status:401});
   await assert.rejects(()=>completeTelegramBrowserLogin('B'.repeat(43),{}),/TELEGRAM_BROWSER_UNCONFIRMED/);assert.equal(n,2);
  }
 }finally{globalThis.fetch=original;}
});
test('challenge response requires bounded opaque state, expiry and a valid exact bot username',async()=>{
 const original=globalThis.fetch,valid={challenge:'C'.repeat(43),expiresAt:1900000000,botUsername:'PowerUkraineBot'};
 try{
  for(const response of [{...valid,botUsername:'https://attacker.invalid'}, {...valid,challenge:'short'}, {...valid,expiresAt:'1900000000'}, {...valid,ownerId:'qa-victim'}]){
   globalThis.fetch=async()=>new Response(JSON.stringify(response),{status:200});await assert.rejects(requestTelegramBrowserChallenge,/TELEGRAM_BROWSER_UNAVAILABLE/);
  }
  globalThis.fetch=async()=>new Response(JSON.stringify(valid),{status:200});assert.deepEqual(await requestTelegramBrowserChallenge(),valid);
 }finally{globalThis.fetch=original;}
});
