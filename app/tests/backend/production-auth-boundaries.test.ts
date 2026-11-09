import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyProductionRouteFence} from '../../server/production/legacy-route-fence.ts';

test('production fence catches old private readers, identity reassignment, senders, dual writers and unadmitted sources',()=>{
 const fence=legacyProductionRouteFence();
 for(const path of ['/api/auth/link-telegram','/API/AUTH/LINK-TELEGRAM/','/api/auth/unlink','/api/notify/telegram/detect-chat','/api/notify/telegram/subscriber',
  '/api/notify/telegram/test','/api/admin/broadcast','/api/user/settings','/api/user/settings-beacon','/api/user/settings-stream',
  '/api/user/locations','/api/user/locations/1/share','/api/user/locations-reorder','/api/share/private-token','/api/compare/share','/api/compare/data/private-token','/api/reports','/api/user/digest/generate',
  '/api/auth/telegram-auto','/api/auth/telegram-login-request','/api/auth/telegram-login-poll','/api/queues','/api/schedule/1.1','/api/address-queue','/api/geocode/houses','/api/version']){
  let forwarded=0,status=0,body:any;const headers:Record<string,string>={};
  const res:any={setHeader:(k:string,v:string)=>{headers[k]=v;},status:(s:number)=>{status=s;return res;},json:(v:any)=>{body=v;}};
  fence({path} as any,res,()=>{forwarded++;});assert.equal(forwarded,0,path);assert.equal(status,503,path);
  assert.equal(headers['Cache-Control'],'no-store');assert.equal(body.code,'LEGACY_OPERATION_REPLACEMENT_REQUIRED');
 }
});
test('canonical/auth/readiness routes remain available to their own exact authentication and effect gates',()=>{
 const fence=legacyProductionRouteFence();
 for(const path of ['/api/product/profile','/api/auth/telegram','/api/auth/telegram-webapp','/api/auth/mobile-token','/api/auth/refresh-token',
  '/api/auth/user','/api/login','/api/callback','/api/telegram-webhook','/api/health/release']){
  let calls=0;fence({path} as any,{} as any,()=>{calls++;});assert.equal(calls,1,path);
 }
});
// This test process has no production credentials. Configure an explicit disposable key before import.
process.env.JWT_SECRET='unit-test-mobile-auth-boundary-key-only-xxxxxxxxxxxxxxxx';
const {isAuthenticatedMobileOrSession,generateMobileToken,verifyMobileToken}=await import('../../server/mobile-auth.ts');
function authorize(req:any){let passed=0,status=0;const res:any={status:(s:number)=>{status=s;return res;},json:()=>{}};
 isAuthenticatedMobileOrSession({headers:{},...req},res,()=>{passed++;});return {passed,status};}
test('truthy user or expired Passport session cannot refresh JWT/read or mutate legacy data',()=>{
 const now=Math.floor(Date.now()/1000),user={claims:{sub:'synthetic-owner'},expires_at:now-1};
 assert.deepEqual(authorize({user,isAuthenticated:()=>true}),{passed:0,status:401});
 assert.deepEqual(authorize({user:{...user,expires_at:now},isAuthenticated:()=>true}),{passed:0,status:401});
 assert.deepEqual(authorize({user:{...user,expires_at:String(now+60)},isAuthenticated:()=>true}),{passed:0,status:401});
 assert.deepEqual(authorize({user:{...user,expires_at:now+60},isAuthenticated:()=>false}),{passed:0,status:401});
 assert.deepEqual(authorize({user:{...user,expires_at:now+60}}),{passed:0,status:401});
 assert.deepEqual(authorize({user:{...user,expires_at:now+60},isAuthenticated:()=>true}),{passed:1,status:0});
});
test('Bearer proof is reverified even with existing session user; invalid or wrong-shaped identity never wins',()=>{
 const user={claims:{sub:'synthetic-owner'},expires_at:Math.floor(Date.now()/1000)+60},base={user,isAuthenticated:()=>true};
 for(const authorization of ['Basic anything','Bearer forged','Bearer '])assert.deepEqual(authorize({...base,headers:{authorization}}),{passed:0,status:401});
 assert.equal(verifyMobileToken(generateMobileToken('')),null);
 const token=generateMobileToken('synthetic-mobile-owner');const req:any={headers:{authorization:'Bearer '+token}};
 assert.deepEqual(authorize(req),{passed:1,status:0});assert.equal(verifyMobileToken(token)?.sub,'synthetic-mobile-owner');
});
