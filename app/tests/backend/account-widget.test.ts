import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createAccountLinks} from '../../server/production/account-links.ts';
import {createAuthReplayGuard} from '../../server/production/auth-replay.ts';
const key='qa-widget-shared-key-'.repeat(4),token='8577497098:synthetic_widget_proof_token_only',now=Date.parse('2026-11-09T02:00:00Z');
const p={kind:'verified_server_principal' as const,verified:true as const,ownerId:'qa-owner',webSessionId:'qa-original-cookie',authEpoch:0};
test('optional Widget configuration is closed, inert and disabled by default; malformed body/HMAC cannot touch SQL or profile state',async()=>{
 let calls=0;const options={enabled:true,expectedControlEpoch:7,pool:{connect:async()=>{calls++;throw Error('MUST_NOT_CONNECT');}},store:{withLockedProfile:async()=>{calls++;throw Error('MUST_NOT_LOAD_PROFILE');}} as any,botId:'8577497098',botToken:token,bindingKey:key,now:()=>now};
 for(const browserWidget of [{botUsername:'https://foreign.invalid',configurationVerified:true},{botUsername:'PowerUkraineBot',configurationVerified:false},{botUsername:'PowerUkraineBot',configurationVerified:true,extra:true}])assert.throws(()=>createAccountLinks({...options,browserWidget} as any),/ACCOUNT_CONFIGURATION/);
 await assert.rejects(createAccountLinks(options).receiveWidgetProof(p,{challengeId:'00000000-0000-0000-0000-000000000000',telegramData:{}}),/ACCOUNT_DISABLED/);
 const service=createAccountLinks({...options,browserWidget:{botUsername:'PowerUkraineBot',configurationVerified:true}});
 for(const body of [{},{challengeId:'bad',telegramData:{}},{challengeId:'00000000-0000-0000-0000-000000000000',telegramData:{},ownerId:'foreign'},{challengeId:'00000000-0000-0000-0000-000000000000',telegramData:{hash:'0'.repeat(64)}}])await assert.rejects(service.receiveWidgetProof(p,body),/ACCOUNT_INVALID_REQUEST|ACCOUNT_PROOF_INVALID/);
 assert.equal(calls,0);
});
test('existing-client account-link claim retains exact historic key and performs no own transaction/pool/session action',async()=>{
 let connects=0;const queries:string[]=[],guard=createAuthReplayGuard({connect:async()=>{connects++;throw Error('MUST_NOT_CONNECT');}},{key,now:()=>now/1000});
 const proof={kind:'login' as const,botId:'8577497098',subjectId:'42',authDate:now/1000,signature:'a'.repeat(64)};
 const client={query:async(sql:string)=>{queries.push(sql);return {rows:[],rowCount:1};}};
 const result=await guard.claimAccountLink(client,proof,{ownerId:p.ownerId,sessionId:p.webSessionId,challengeId:'00000000-0000-0000-0000-000000000000'});
 assert.equal(result.proofKey,createHmac('sha256',key).update(JSON.stringify(['telegram-auth/1','login',proof.botId,proof.subjectId,proof.authDate,proof.signature])).digest('hex'));
 assert.equal(result.alreadyClaimed,false);assert.equal(connects,0);assert.equal(queries.length,1);assert.match(queries[0],/^insert into lba_auth_proof_uses/);assert(!queries.some(q=>/^(begin|commit|rollback)/.test(q)));
});
test('freshness and purpose input are checked before existing-client queries; verified user identity is not accepted from nested fields',async()=>{
 let queries=0;const guard=createAuthReplayGuard({connect:async()=>{throw Error('NO');}},{key,now:()=>now/1000}),client={query:async()=>{queries++;throw Error('NO');}},binding={ownerId:p.ownerId,sessionId:p.webSessionId,challengeId:'00000000-0000-0000-0000-000000000000'};
 const proof={kind:'login' as const,botId:'8577497098',subjectId:'42',authDate:now/1000,signature:'a'.repeat(64)};
 for(const value of [{...proof,kind:'mini_app'},{...proof,authDate:now/1000-86401},{...proof,subjectId:{id:42}},{...proof,purpose:'login'}])await assert.rejects(guard.claimAccountLink(client,value as any,binding));assert.equal(queries,0);
 // This fixture is a valid HMAC but is 301s old: the account adapter rejects it before any store read.
 const data={id:'42',first_name:'QA',auth_date:now/1000-301};const check=Object.entries(data).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');const signed={...data,hash:createHmac('sha256',createHash('sha256').update(token).digest()).update(check).digest('hex')};
 const service=createAccountLinks({enabled:true,expectedControlEpoch:7,pool:{connect:async()=>{throw Error('NO');}},store:{withLockedProfile:async()=>{throw Error('NO_STORE');}} as any,botId:'8577497098',botToken:token,bindingKey:key,now:()=>now,browserWidget:{botUsername:'PowerUkraineBot',configurationVerified:true}});
 await assert.rejects(service.receiveWidgetProof(p,{challengeId:binding.challengeId,telegramData:signed}),/ACCOUNT_PROOF_INVALID/);
});
