import {test} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {createProductAuthentication} from '../../server/production/product-auth.ts';

const key='test-key-for-local-auth-only-32-characters';
const verify=(raw:string)=>{try{return jwt.verify(raw,key,{issuer:'svitlo-ukraine',audience:'svitlo-mobile'}) as {sub:unknown};}catch{return null;}};
function request(header:unknown,session=false){
 let next=0,status=0,sessionChecks=0;
 const req:any={headers:header===undefined?{}:{authorization:header},body:{ownerId:'victim'},query:{ownerId:'victim'},user:{claims:{sub:'unverified'}}};
 const res:any={sendStatus(code:number){status=code;}};
 createProductAuthentication({verifyMobile:verify,authenticateSession:(_req,res,accept)=>{sessionChecks++;session?accept():res.sendStatus(401);}})(req,res,()=>{next++;});
 return {req,next,status,sessionChecks};
}
test('only verified existing bearer subject survives body/query/user spoofing; bad/expired/wrong-audience JWT cannot reach reader',()=>{
 const token=jwt.sign({sub:'owned-principal'},key,{issuer:'svitlo-ukraine',audience:'svitlo-mobile',expiresIn:60});
 const good=request('Bearer '+token);assert.equal(good.next,1);assert.equal(good.req.user.claims.sub,'owned-principal');assert.equal(good.sessionChecks,0);
 for(const raw of ['Bearer junk','Basic junk',['Bearer '+token],
  'Bearer '+jwt.sign({sub:'owned-principal'},key,{issuer:'svitlo-ukraine',audience:'wrong-app'}),
  'Bearer '+jwt.sign({sub:'owned-principal'},key,{issuer:'svitlo-ukraine',audience:'svitlo-mobile',expiresIn:-1})]){
  const result=request(raw,true);assert.equal(result.next,0);assert.equal(result.status,401);assert.equal(result.sessionChecks,0);
 }
});
test('absent bearer invokes real session verifier; unsafe verified-token subjects fail closed',()=>{
 assert.equal(request(undefined,false).next,0);assert.equal(request(undefined,true).next,1);
 for(const subject of ['',123,'owner\nadmin','x'.repeat(256)]){
  const raw=jwt.sign({sub:subject},key,{issuer:'svitlo-ukraine',audience:'svitlo-mobile'});
  assert.equal(request('Bearer '+raw).status,401);
 }
});
