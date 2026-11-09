import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareReplitSession} from '../../server/production/replit-session.ts';
import {createReplitIdentityResolver} from '../../server/production/replit-identity.ts';
const now=1794168000,owner='canonical-owner',subject='external-replit-subject';
const signed=()=>({sub:subject,exp:now+600,iss:'https://replit.com/oidc',first_name:'Олена'});
const tokens=(claims:Record<string,unknown>|undefined=signed())=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,claims:()=>claims});
test('initial verified OIDC session keeps provider subject separate from canonical owner without changing source claims',()=>{
 const claims=signed(),before=structuredClone(claims),session=prepareReplitSession(null,tokens(claims),owner,now);
 assert.equal(session.claims.sub,owner);assert.equal(session.providerIdentity.subject,subject);assert.equal(session.expires_at,now+600);assert.deepEqual(claims,before);
});
test('refresh with signed claims retains canonical owner and retains existing refresh credential when no replacement arrives',()=>{
 const previous=prepareReplitSession(null,tokens(),owner,now),before=structuredClone(previous);
 const refreshed=prepareReplitSession(previous,{...tokens({...signed(),exp:now+1200}),refresh_token:undefined},owner,now+60);
 assert.equal(refreshed.claims.sub,owner);assert.equal(refreshed.providerIdentity.subject,subject);assert.equal(refreshed.expires_at,now+1200);
 assert.equal(refreshed.refresh_token,'synthetic-refresh');assert.deepEqual(previous,before);
});
test('refresh without ID token uses preserved provider identity and verified access lifetime, never old owner as provider subject',()=>{
 const previous=prepareReplitSession(null,tokens(),owner,now),refresh={access_token:'next-access',expires_in:3600,claims:()=>undefined};
 const next=prepareReplitSession(previous,refresh,owner,now+600);assert.equal(next.claims.sub,owner);assert.equal(next.providerIdentity.subject,subject);
 assert.equal(next.expires_at,now+4200);assert.equal(next.claims.exp,previous.claims.exp);assert.equal(next.refresh_token,previous.refresh_token);
 assert.throws(()=>prepareReplitSession({claims:previous.claims},refresh,owner,now+600),/IDENTITY_CHANGED/);
});
test('changed provider/owner, expired signed claims and unknown token lifetime fail before granting a replacement session',()=>{
 const previous=prepareReplitSession(null,tokens(),owner,now);
 assert.throws(()=>prepareReplitSession(previous,tokens({...signed(),sub:'another-subject'}),owner,now),/IDENTITY_CHANGED/);
 assert.throws(()=>prepareReplitSession(previous,tokens(),'another-owner',now),/IDENTITY_CHANGED/);
 for(const exp of [now,now-1,'9999999999',false,undefined])assert.throws(()=>prepareReplitSession(previous,tokens({...signed(),exp}),owner,now),/EXPIRED/);
 for(const expires_in of [undefined,0,-1,7*86400+1,'3600'])assert.throws(()=>prepareReplitSession(previous,{access_token:'next',expires_in,claims:()=>undefined},owner,now+600),/EXPIRY_UNCONFIRMED/);
});
test('invalid access/refresh credential shape or missing signed initial subject never enters session object',()=>{
 for(const access_token of ['',{},'a\nb','x'.repeat(16385)])assert.throws(()=>prepareReplitSession(null,{...tokens(),access_token},owner,now),/INVALID/);
 assert.throws(()=>prepareReplitSession(null,{...tokens(),refresh_token:{}},owner,now),/INVALID/);
 assert.throws(()=>prepareReplitSession(null,{...tokens(),claims:()=>undefined},owner,now),/IDENTITY_CHANGED/);
});
test('unverified malformed Replit subject fails before connecting; no constructor DB action or environment access',async()=>{
 let calls=0;const resolver=createReplitIdentityResolver({connect:async()=>{calls++;throw Error('private connection');}});
 assert.equal(calls,0);for(const sub of [undefined,{},'', 'bad\nsubject',' spaced '])await assert.rejects(resolver.login({sub}),/INVALID/);
 assert.equal(calls,0);await assert.rejects(resolver.existing(subject),e=>e instanceof Error&&e.message==='REPLIT_IDENTITY_UNCONFIRMED');
});
