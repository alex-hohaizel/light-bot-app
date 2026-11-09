import test from 'node:test';
import assert from 'node:assert/strict';
import type {Express,RequestHandler} from 'express';
import {registerAccountLinkRoutes,type AccountLinkHttpPorts,type AccountLinkHttpPrincipal} from '../../server/production/account-links-http.ts';
const principal:AccountLinkHttpPrincipal={kind:'verified_server_principal',verified:true,ownerId:'owner-a',webSessionId:'signed-session-a',authEpoch:3};
const challengeId='11111111-1111-4111-8111-111111111111',startParam='acctlink_'+'a'.repeat(64),at='2026-11-09T10:00:00Z';
const challenge={kind:'challenge',challengeId,startParam,expiresAt:at,miniAppUrl:null,state:'pending'};
const linked={kind:'linked',operationId:'operation-a',provider:'telegram',linkId:'old-non-uuid-link-id',authEpoch:3,reauthenticate:false};
const unlinked={...linked,kind:'unlinked',authEpoch:4,reauthenticate:true};
const paths={accounts:'/api/product/accounts',challenge:'/api/product/accounts/telegram/challenge',proof:'/api/product/accounts/telegram/proof',inspect:'/api/product/accounts/telegram/challenge/:challengeId',link:'/api/product/accounts/telegram/confirm',unlink:'/api/product/accounts/unlink',recover:'/api/product/accounts/recover'};
class Harness {
 routes=new Map<string,any[]>();calls:any[]=[];middleware:string[]=[];result:any=challenge;error:any;identity:any=principal;
 app={get:(p:string,...h:any[])=>this.routes.set('GET '+p,h),post:(p:string,...h:any[])=>this.routes.set('POST '+p,h)} as unknown as Express;
 constructor(patch:Partial<AccountLinkHttpPorts>={}){
  const layer=(name:string):RequestHandler=>(_req,res,next)=>{this.middleware.push(name);if((_req as any).deny===name)return void res.status(403).json({code:'DENIED'});next();};
  const service=(name:string)=>async(...args:any[])=>{this.calls.push({name,args:structuredClone(args)});if(this.error)throw this.error;return structuredClone(this.result);};
  registerAccountLinkRoutes(this.app,{enabled:true,service:{listAccounts:service('accounts'),createChallenge:service('challenge'),receiveMiniProof:service('proof'),inspectChallenge:service('inspect'),confirmLink:service('link'),unlink:service('unlink'),recoverOperation:service('recover')},authenticate:layer('auth'),sameOrigin:layer('origin'),limiter:layer('limit'),principal:async()=>{this.middleware.push('principal');return this.identity;},recoveryAuthenticate:layer('recoveryAuth'),recoveryPrincipal:async()=>{this.middleware.push('recoveryPrincipal');return this.identity;},...patch});
 }
 async call(path=paths.challenge,body:any={id:'operation-a'},patch:any={}){
  const req:any={query:{},params:{challengeId},body,...patch};let status=200,value:any;const headers:Record<string,string>={};const res:any={setHeader:(k:string,v:string)=>{headers[k.toLowerCase()]=v;return res;},status:(s:number)=>{status=s;return res;},json:(v:any)=>{value=structuredClone(v);return res;}};
  const handlers=this.routes.get(([paths.inspect,paths.accounts].includes(path)?'GET ':'POST ')+path)!;let index=0;const next=async():Promise<void>=>{const h=handlers[index++];if(!h)return;let advanced=false;await h(req,res,()=>{advanced=true;});if(advanced)await next();};await next();return {status,body:value,headers};
 }
}
test('registration is inert; all endpoints disabled by default deny before any service or authentication',async()=>{const h=new Harness({enabled:undefined});assert.equal(h.calls.length,0);for(const path of Object.values(paths))assert.equal((await h.call(path)).status,503);assert.equal(h.calls.length,0);assert.equal(h.middleware.length,0);});
test('owner routes require injected auth/origin/limiter and server principal; request/query cannot select another owner',async()=>{
 for(const path of [paths.accounts,paths.challenge,paths.inspect,paths.link,paths.unlink]){for(const deny of ['origin','auth','limit']){const h=new Harness();assert.equal((await h.call(path,{}, {deny})).status,403);assert.equal(h.calls.length,0);}const h=new Harness();assert.equal((await h.call(path,{}, {query:{ownerId:'foreign'}})).status,400);assert.equal(h.calls.length,0);h.identity=null;assert.equal((await h.call(path)).status,401);assert.equal(h.calls.length,0);}
 const h=new Harness();assert.equal((await h.call(paths.challenge,{ownerId:'foreign',webSessionId:'foreign'})).status,200);assert.deepEqual(h.calls[0].args[0],principal);assert.equal(h.calls[0].args[1].ownerId,'foreign'); // Domain service owns closed body validation; body never authenticates.
 for(const p of [{...principal,verified:false},{...principal,ownerId:{private:'x'}},{...principal,authEpoch:'3'},{...principal,extra:'x'}]){h.identity=p;assert.equal((await h.call()).status,401);}
});
test('account list exposes only exact public link/revision fields and correlates fresh authenticated epoch',async()=>{
 const h=new Harness(),value={links:[{id:'legacy-link',provider:'replit',linkRevision:'b'.repeat(64)}],authEpoch:principal.authEpoch};h.result=value;assert.deepEqual((await h.call(paths.accounts)).body,value);assert.deepEqual(h.calls[0].args,[principal]);
 for(const result of [{...value,ownerId:'PRIVATE'},{...value,authEpoch:2},{...value,authEpoch:'3'},{...value,links:[{...value.links[0],providerId:'PRIVATE'}]},{...value,links:[{...value.links[0],linkRevision:'invalid'}]},{...value,links:[value.links[0],value.links[0]]}]){h.result=result;const r=await h.call(paths.accounts);assert.equal(r.status,503);assert(!JSON.stringify(r.body).includes('PRIVATE'));}
});
test('proof accepts only bounded initData, uses limiter without login, and never returns subject/proof fields',async()=>{
 const h=new Harness();h.result={kind:'proof',state:'ready_for_confirmation'};assert.equal((await h.call(paths.proof,{initData:'signed-fixture'})).status,200);assert.deepEqual(h.middleware,['limit']);assert.equal(h.calls[0].args[0],'signed-fixture');
 for(const body of [null,{}, {initData:['x']},{initData:'x',ownerId:'foreign'},{initData:'x'.repeat(16385)}]){const r=await h.call(paths.proof,body);assert.equal(r.status,400);}
 h.result={kind:'proof',state:'ready_for_confirmation',subject:'PRIVATE'};const r=await h.call(paths.proof,{initData:'x'});assert.equal(r.status,503);assert(!JSON.stringify(r.body).includes('PRIVATE'));
});
test('closed challenge URL and inspect shape reject redirects, extra params, private slots and mismatched IDs',async()=>{
 const h=new Harness();h.result={...challenge,miniAppUrl:'https://t.me/ValidBot/mini?startapp='+startParam};assert.equal((await h.call()).status,200);
 for(const url of ['https://evil.invalid/ValidBot/mini?startapp='+startParam,'https://t.me/ValidBot/mini?startapp='+startParam+'&extra=x','https://u:p@t.me/ValidBot/mini?startapp='+startParam,'https://t.me/ValidBot/mini?startapp='+startParam+'#','https://t.me/ValidBot/mini?startapp=other']){h.result={...challenge,miniAppUrl:url};assert.equal((await h.call()).status,503);}
 h.result={kind:'challenge_status',challengeId,state:'ready_for_confirmation',expiresAt:at,accountLabel:'Telegram ••••1234'};assert.equal((await h.call(paths.inspect)).status,200);
 for(const bad of [{...h.result,challengeId:'22222222-2222-4222-8222-222222222222'},{...h.result,state:['linked']},{...h.result,accountLabel:{private:'x'}},{...h.result,state:'pending'},{...h.result,subjectId:'PRIVATE'}]){h.result=bad;assert.equal((await h.call(paths.inspect)).status,503);}
});
test('mutation results correlate immutable ID/provider/kind and retain valid legacy text link IDs',async()=>{
 const h=new Harness();h.result=linked;assert.equal((await h.call(paths.link)).status,200);h.result=unlinked;assert.equal((await h.call(paths.unlink)).status,200);
 for(const bad of [{...linked,operationId:'wrong'},{...linked,provider:'replit'},{...linked,reauthenticate:true},{...linked,authEpoch:'3'},{...linked,linkId:{private:'x'}},{...linked,secret:'PRIVATE'}]){h.result=bad;assert.equal((await h.call(paths.link)).status,503);}
});
test('false/undefined/malformed outcomes fail closed and unknown COMMIT exposes only stable same-ID recovery instruction',async()=>{
 const h=new Harness();for(const path of Object.values(paths))for(const result of [undefined,false,0,'',null,{}]){h.result=result;const r=await h.call(path,path===paths.proof?{initData:'x'}:path===paths.recover?{kind:'link',request:{id:'operation-a'}}:{id:'operation-a'});assert.equal(r.status,503,path);}
 h.error=Object.assign(Error('postgres://PRIVATE owner subject proof'),{code:'ACCOUNT_COMMIT_UNKNOWN'});const r=await h.call(paths.unlink);assert.equal(r.status,503);assert.deepEqual(r.body,{code:'ACCOUNT_COMMIT_UNKNOWN',retry:'same_request_id'});
 for(const [code,status]of [['ACCOUNT_AUTH_REQUIRED',401],['ACCOUNT_SESSION_REVOKED',401],['ACCOUNT_INVALID_REQUEST',400],['ACCOUNT_PROOF_INVALID',400],['ACCOUNT_LINK_CONFLICT',409],['ACCOUNT_CHALLENGE_EXPIRED',409],['ACCOUNT_RECONCILIATION_REQUIRED',409],['ACCOUNT_PROFILE_CHANGED',409],['ACCOUNT_LAST_LOGIN_REQUIRED',409],['ACCOUNT_DISABLED',503],['raw sql PRIVATE',503]] as const){h.error=Object.assign(Error('PRIVATE'),{code});const r=await h.call();assert.equal(r.status,status);assert(!JSON.stringify(r.body).includes('PRIVATE'));}
});
test('read-only recovery uses distinct original-session auth and validates exact recorded/miss shapes',async()=>{
 const h=new Harness();h.result={kind:'recovery',state:'recorded',result:unlinked};const body={kind:'unlink',request:{id:'operation-a'}};const r=await h.call(paths.recover,body);assert.equal(r.status,200);assert(h.middleware.includes('recoveryAuth'));assert(h.middleware.includes('recoveryPrincipal'));assert(!h.middleware.includes('auth'));assert(!h.middleware.includes('principal'));
 for(const result of [{kind:'recovery',state:'not_recorded'},{kind:'recovery',state:'recorded',result:unlinked}]){h.result=result;assert.equal((await h.call(paths.recover,body)).status,200);}
 for(const result of [{kind:'recovery',state:'not_recorded',result:null},{kind:'recovery',state:'recorded',result:linked},{kind:'recovery',state:'recorded',result:{...unlinked,operationId:'different'}}]){h.result=result;assert.equal((await h.call(paths.recover,body)).status,503);}
 const disabled=new Harness({recoveryAuthenticate:undefined,recoveryPrincipal:undefined});assert.equal((await disabled.call(paths.recover,body)).status,503);assert.equal(disabled.calls.length,0);
});
