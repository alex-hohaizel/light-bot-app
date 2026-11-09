import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {createHmac} from 'node:crypto';
import {createTelegramAuthFlow} from '../../server/production/telegram-auth-flow.ts';
import {createAccountOriginGuard} from '../../server/production/account-origin.ts';
process.env.JWT_SECRET='unit-auth-epoch-token-key-only-xxxxxxxxxxxxxxxxxxxxxxxx';
const {generateMobileToken,verifyMobileToken}=await import('../../server/mobile-auth.ts');
test('signed mobile tokens carry the original validated epoch; legacy missing epoch remains distinguishable',()=>{
 assert.equal(verifyMobileToken(generateMobileToken('qa-epoch','Тест',7))?.authEpoch,7);
 for(const authEpoch of [-1,1.5,NaN,Infinity])assert.throws(()=>generateMobileToken('qa-epoch','Тест',authEpoch));
 for(const authEpoch of ['7',null,true,-1,1.5]){
  const token=jwt.sign({sub:'qa-epoch',type:'mobile',authEpoch},process.env.JWT_SECRET!,{expiresIn:'1h',issuer:'svitlo-ukraine',audience:'svitlo-mobile'});assert.equal(verifyMobileToken(token),null);
 }
 const legacy=jwt.sign({sub:'qa-epoch',type:'mobile'},process.env.JWT_SECRET!,{expiresIn:'1h',issuer:'svitlo-ukraine',audience:'svitlo-mobile'});
 assert.equal(verifyMobileToken(legacy)?.authEpoch,undefined);
});
const bot='8577497098',token=bot+':fixture_hmac_token_xxxxxxxxxxxxx',now=1794052800;
function mini(start?:string){const p=new URLSearchParams({auth_date:String(now),user:JSON.stringify({id:12345,first_name:'Тест'})});if(start)p.set('start_param',start);
 const check=[...p.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update(check).digest('hex'));return p.toString();}
test('signed account-link purpose cannot reserve a generic login proof or autocreate an account',async()=>{
 let calls=0;const flow=createTelegramAuthFlow({token,botId:bot,now:()=>now,guard:{reserve:async()=>{calls++;throw Error('NO');},bind:async()=>{calls++;}} as any,resolveUser:async()=>{calls++;return 'qa-owner';}});
 await assert.rejects(async()=>flow.mini(mini('acctlink_'+'a'.repeat(64)),{} as any),/AUTH_PROOF_PURPOSE_MISMATCH/);assert.equal(calls,0);
});
test('fresh verified-session hook follows durable proof binding; failure invalidates the new session',async()=>{
 const log:string[]=[],flow=createTelegramAuthFlow({token,botId:bot,now:()=>now,guard:{reserve:async()=>{log.push('reserve');return {kind:'new',proofKey:'qa',claimId:'claim'};},bind:async()=>{log.push('bind');}} as any,resolveUser:async()=>{log.push('identity');return 'qa-owner';}});
 await assert.rejects(flow.mini(mini(),{id:'old-session',currentOwnerId:null,login:async()=>{log.push('saved-login');return 'new-session';},verified:async input=>{assert.equal(input.user.id,'12345');log.push('verified-hook');throw Error('HOOK_UNCONFIRMED');},invalidate:async()=>{log.push('invalidate');}}),/HOOK_UNCONFIRMED/);
 assert.deepEqual(log,['reserve','identity','saved-login','bind','verified-hook','invalidate']);
});
test('bound login proof never reissues a new session or refreshes alternative-login consent',async()=>{
 let calls=0;const flow=createTelegramAuthFlow({token,botId:bot,now:()=>now,guard:{reserve:async()=>({kind:'bound',ownerId:'qa-owner'}),bind:async()=>{calls++;}} as any,resolveUser:async()=>{calls++;return 'qa-owner';}});
 const result=await flow.mini(mini(),{id:'old-session',currentOwnerId:'qa-owner',login:async()=>{calls++;return 'new';},verified:async()=>{calls++;},invalidate:async()=>{calls++;}});assert.equal(result.alreadyAuthenticated,true);assert.equal(calls,0);
});
test('account cookie mutations require the exact first-party Origin; source proof route is separately guarded',()=>{
 const guard=createAccountOriginGuard('https://power-ukraine.net');
 for(const [method,headers,allowed] of [['POST',{},false],['POST',{origin:'null'},false],['POST',{origin:'https://other.replit.app'},false],['POST',{origin:'https://power-ukraine.net'},true],['GET',{},true],['GET',{'sec-fetch-site':'cross-site'},false]] as const){
  let next=0,status=0;const res:any={status:(s:number)=>{status=s;return res;},json:()=>{}};guard({method,headers} as any,res,()=>{next++;});assert.equal(next,allowed?1:0);assert.equal(status,allowed?0:403);
 }
});
