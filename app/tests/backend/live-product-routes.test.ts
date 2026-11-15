import test from 'node:test';
import assert from 'node:assert/strict';
import type {Express,RequestHandler} from 'express';
import {registerLiveProductRoutes,type LiveProductPorts} from '../../server/production/product-routes.ts';
import {createProductionProfileStore} from '../../server/production/profile-store.ts';
import {createBotState} from '../../shared/bot/engine.ts';
import {projectLegacyLiveProfile} from '../../server/production/legacy-profile.ts';
import type {LegacyLiveProfileRead,VerifiedLegacyPrincipal} from '../../server/production/profile-reader.ts';

const owner='fixture-live-owner',now='2026-11-08T18:00:00Z',releaseId='a'.repeat(64);
const principal:VerifiedLegacyPrincipal={kind:'verified_server_principal',ownerId:owner,verified:true};
const authenticate:RequestHandler=(req:any,res,next)=>{if(req.credential!=='verified-local-fixture')return void res.status(401).json({error:'auth required'});req.user={claims:{sub:req.verifiedSubject??owner}};next();};
class Harness {
 routes=new Map<string,any[]>();
 app={get:(path:string,...handlers:any[])=>{this.routes.set('GET '+path,handlers);},post:(path:string,...handlers:any[])=>{this.routes.set('POST '+path,handlers);}} as unknown as Express;
 constructor(ports:LiveProductPorts){registerLiveProductRoutes(this.app,ports);}
 async call(method='GET',path='/api/product/profile',patch:any={}){
  const req:any={query:{},body:{},headers:{},credential:'verified-local-fixture',...patch};let status=200,body:any,headers:Record<string,string>={};
  const res:any={setHeader(k:string,v:string){headers[k.toLowerCase()]=v;return res;},status(code:number){status=code;return res;},json(value:any){body=structuredClone(value);return res;}};
  const handlers=this.routes.get(method+' '+path);assert(handlers);let index=0;
  const invoke=async():Promise<void>=>{const handler=handlers[index++];if(!handler)return;let next=false;await handler(req,res,()=>{next=true;});if(next)await invoke();};await invoke();
  return {status,body,headers};
 }
}
class Port {
 data:any;connects=0;calls:string[]=[];commit:'normal'|'unknown_saved'|'unknown_not_saved'='normal';
 constructor(){const state=createBotState({ownerId:owner,sessionId:'fixture-live-session'});state.profile.locations=[{address:{id:'fixture-home',label:'Дім',territoryId:'fixture-territory',locality:'Fixture locality',street:'Fixture street',house:{number:'1',literal:'1'},aliases:[]},binding:{addressId:'fixture-home',operatorId:'fixture-operator',namespace:'fixture:namespace',targetId:'1.1',kind:'user_selected_group',revisionId:'fixture-binding',status:'needs_confirmation',verifiedAt:null,effectiveFrom:null,effectiveUntil:null},notifications:false,paused:false}];state.profile.primaryAddressId='fixture-home';state.currentAddressId='fixture-home';this.data={state,inbox:{}};}
 pool={connect:async()=>{this.connects++;let tx:any;return {query:async(sql:string,values:any[]=[])=>{
  const q=sql.replace(/\s+/g,' ').trim();this.calls.push(q);const result=(rows:any[],rowCount=rows.length)=>({rows:structuredClone(rows),rowCount});
  if(q.startsWith('begin isolation level ')){tx=structuredClone(this.data);return result([]);}
  if(q==='commit'){const mode=this.commit;this.commit='normal';if(mode!=='unknown_not_saved')this.data=tx;if(mode!=='normal')throw Error('PRIVATE_CONNECTION_DETAIL');return result([]);}
  if(q==='rollback')return result([]);
  if(q.startsWith('select control_epoch'))return result([{controlEpoch:'9',writerMode:'canonical'}]);
  if(q.startsWith('select pg_advisory'))return result([]);
  const who=values[0];
  if(q.startsWith('select owner_id as'))return result(who===owner?[{ownerId:owner,sessionId:tx.state.sessionId,revision:tx.state.revision,state:tx.state}]:[]);
  if(q.startsWith('select source_digest'))return result(who===owner?[{source_digest:'f'.repeat(64)}]:[]);
  if(q.startsWith('select session_id as'))return result(who===owner?[{sessionId:tx.state.sessionId}]:[]);
  if(q.startsWith('select input_digest'))return result(tx.inbox[who+'|'+values[1]]?[tx.inbox[who+'|'+values[1]]]:[]);
  if(q.startsWith('update lba_production_profiles set')){if(who!==owner||values[1]!==tx.state.sessionId||values[2]!==tx.state.revision)return result([],0);tx.state=JSON.parse(values[4]);return result([],1);}
  if(q.startsWith('update lba_production_profile_outbox set'))return result([],0);
  if(q.startsWith('insert into lba_production_profile_inbox(')){tx.inbox[who+'|'+values[1]]={inputDigest:values[2],receipt:JSON.parse(values[3])};return result([],1);}
  throw Error('PRIVATE_UNEXPECTED_SQL');
 },release(){}};}};
 store(context:{addresses:any[];plans:any[]}={addresses:[],plans:[]}){return createProductionProfileStore({pool:this.pool,enabled:true,expectedControlEpoch:9,now:()=>now,context:()=>context});}
}
const active=(store:ReturnType<Port['store']>)=>new Harness({mode:'active',releaseId,authenticate,store});
const request=(revision=0,id='fixture-request')=>({id,expectedSessionId:'fixture-live-session',expectedRevision:revision,mutation:{kind:'rename',addressId:'fixture-home',label:'Нова мітка'}});
const readFixture=():LegacyLiveProfileRead=>({version:'lba-live-legacy-reader/1',status:'ready',projection:projectLegacyLiveProfile({ownerId:owner,identity:principal,settings:null,locations:[],subscribers:[]}),sourceDigest:'f'.repeat(64),projectionDigest:'e'.repeat(64),serverNow:now,counts:{settings:0,locations:0,directlyOwnedSubscribers:0,verifiedMappedNullSubscribers:0,selectedSubscribers:0,verifiedMappings:0,missingVerifiedMappings:0,unresolvedSettingsReferences:0},completeness:{ownerRows:'reconciled',selectedColumnsOnly:true,otherLegacyColumns:'not_read_not_modified',globalOrphans:'not_scanned_outside_owner_scope'},blockers:[]});

test('active routes consume the real canonical store for snapshot, committed mutation, durable replay and exact receipt readback',async()=>{
 const p=new Port(),h=active(p.store()),first=await h.call();assert.equal(first.status,200);assert.equal(first.body.profile.id,owner);assert.equal(first.body.simulationOnly,false);assert.equal(first.body.capabilities.profileMutations,true);assert.equal(first.body.capabilities.tools,false);assert.equal(first.body.migration.status,'needs_confirmation');
 const body=request(),saved=await h.call('POST','/api/product/profile',{body});assert.equal(saved.status,200);assert.equal(saved.body.profile.locations[0].address.label,'Нова мітка');assert.equal(saved.body.revision,1);assert.equal(saved.body.receipt.committed,true);assert.equal(saved.body.receipt.simulationOnly,false);assert.equal(saved.body.receipt.inputId,'app:'+body.id);assert.equal(saved.body.replayed,false);
 const repeated=await h.call('POST','/api/product/profile',{body});assert.equal(repeated.status,200);assert.equal(repeated.body.replayed,true);assert.deepEqual(repeated.body.receipt,saved.body.receipt);assert.equal(p.data.state.revision,1);
 const recovered=await h.call('POST','/api/product/profile/receipt',{body});assert.equal(recovered.body.outcome,'committed');assert.equal(recovered.body.nextAction,'use_receipt');assert.deepEqual(recovered.body.receipt,saved.body.receipt);assert.equal(recovered.headers['cache-control'],'no-store');
});
test('authentication, unsafe verified subjects and query/body owner spoofing never reach canonical state',async()=>{
 const p=new Port(),h=active(p.store());
 for(const path of ['/api/product/profile','/api/product/profile/receipt']){const r=await h.call('POST',path,{credential:'invalid',user:{claims:{sub:owner}},body:request()});assert.equal(r.status,401);assert.equal(r.headers['cache-control'],'no-store');}
 for(const sub of ['',123,'bad\nowner','x'.repeat(256)])assert.equal((await h.call('GET','/api/product/profile',{verifiedSubject:sub})).status,401);
 for(const method of ['GET','POST'])assert.equal((await h.call(method,'/api/product/profile',{query:{ownerId:'foreign'},body:request()})).status,400);
 for(const body of [{...request(),ownerId:'foreign'},{...request(),profile:{id:'foreign'}},{...request(),mutation:{...request().mutation,ownerId:'foreign'}},{...request(),expectedRevision:-1}])assert.equal((await h.call('POST','/api/product/profile',{body})).status,400);
 assert.equal(p.connects,0);assert.equal(p.data.state.revision,0);
});
test('foreign authenticated owner cannot receive or mutate this owner profile even with its session/address IDs',async()=>{
 const p=new Port(),h=active(p.store()),before=structuredClone(p.data);
 const read=await h.call('GET','/api/product/profile',{verifiedSubject:'foreign-owner'});assert.equal(read.status,503);assert(!JSON.stringify(read.body).includes('fixture-home'));
 const write=await h.call('POST','/api/product/profile',{verifiedSubject:'foreign-owner',body:request()});assert.equal(write.status,503);assert.deepEqual(p.data,before);
});
test('unknown saved/not-saved commits return an explicit same-ID recovery action and cannot duplicate the App mutation',async()=>{
 for(const mode of ['unknown_saved','unknown_not_saved'] as const){
  const p=new Port(),h=active(p.store()),body=request();p.commit=mode;
  const unknown=await h.call('POST','/api/product/profile',{body});assert.equal(unknown.status,503);assert.equal(unknown.body.code,'PRODUCTION_COMMIT_UNKNOWN');assert.equal(unknown.body.nextAction,'recover_same_request');assert.equal(unknown.body.retryWithSameRequestId,true);assert(!JSON.stringify(unknown.body).includes('PRIVATE'));
  const recovery=await h.call('POST','/api/product/profile/receipt',{body});assert.equal(recovery.status,200);assert.equal(recovery.body.outcome,mode==='unknown_saved'?'committed':'not_recorded');assert.equal(recovery.body.nextAction,mode==='unknown_saved'?'use_receipt':'retry_same_request');
  const retried=await h.call('POST','/api/product/profile',{body});assert.equal(retried.status,200);assert.equal(retried.body.replayed,mode==='unknown_saved');assert.equal(p.data.state.revision,1);assert.equal(Object.keys(p.data.inbox).length,1);
 }
});
test('changed payload/revision under the same ID conflicts; stale/new wrong-session requests are not applied',async()=>{
 const p=new Port(),h=active(p.store());await h.call('POST','/api/product/profile',{body:request()});
 for(const body of [{...request(),expectedRevision:1},{...request(),mutation:{...request().mutation,label:'Different'}},request(0,'stale-id'),{...request(1,'bad-session'),expectedSessionId:'wrong-session'}])assert.equal((await h.call('POST','/api/product/profile',{body})).status,409);
 const changedRecovery=await h.call('POST','/api/product/profile/receipt',{body:{...request(),expectedRevision:1}});assert.equal(changedRecovery.status,409);assert.equal(p.data.state.revision,1);
});
test('public DTO projections exclude unknown top-level and nested profile/receipt provenance fields',async()=>{
 const p=new Port(),real=p.store();(p.data.state.profile as any).privateToken='MUST_NOT_RETURN';(p.data.state.profile.locations[0].address as any).privateToken='MUST_NOT_RETURN';(p.data.state.profile.locations[0].binding as any).privateToken='MUST_NOT_RETURN';
 const store={...real,snapshot:async(id:VerifiedLegacyPrincipal)=>({...await real.snapshot(id),privateProvenance:{privateToken:'MUST_NOT_RETURN'}}),commitProfileMutation:async(id:VerifiedLegacyPrincipal,value:unknown)=>{const r=await real.commitProfileMutation(id,value);return {...r,privateProvenance:'MUST_NOT_RETURN',receipt:{...r.receipt,privateToken:'MUST_NOT_RETURN'}};}};
 const h=new Harness({mode:'active',releaseId,authenticate,store});const read=await h.call(),saved=await h.call('POST','/api/product/profile',{body:request()});
 assert.equal(read.status,200);assert.equal(saved.status,200);assert(!JSON.stringify(read.body).includes('MUST_NOT_RETURN'));assert(!JSON.stringify(saved.body).includes('MUST_NOT_RETURN'));assert(!('controlEpoch'in saved.body.receipt));assert(!('outboxIds'in saved.body.receipt));
});
test('malformed/foreign/simulated store results and private exception text fail closed with safe errors',async()=>{
 const p=new Port(),real=p.store();
 for(const change of [(v:any)=>({...v,runtime:'isolated'}),(v:any)=>({...v,profile:{...v.profile,id:'foreign-owner'}}),(v:any)=>({...v,serverNow:'invalid'})]){
  const h=new Harness({mode:'active',releaseId,authenticate,store:{...real,snapshot:async id=>change(await real.snapshot(id))}});const r=await h.call();assert.equal(r.status,503);assert(!JSON.stringify(r.body).includes('foreign-owner'));
 }
 const h=new Harness({mode:'active',releaseId,authenticate,store:{...real,snapshot:async()=>{throw Error('PRIVATE_CONNECTION_AND_SECRET');}}});const r=await h.call();assert.equal(r.status,503);assert.equal(r.body.code,'LIVE_PROFILE_UNAVAILABLE');assert(!JSON.stringify(r.body).includes('PRIVATE'));
});
test('only literal null is a confirmed recovery miss; false/undefined/zero/empty malformed results cannot invite a retry as not-recorded',async()=>{
 const p=new Port(),real=p.store();
 for(const bad of [false,undefined,0,'']){const h=new Harness({mode:'active',releaseId,authenticate,store:{...real,recoverReceipt:async()=>bad as any}}),r=await h.call('POST','/api/product/profile/receipt',{body:request()});assert.equal(r.status,503);assert.equal(r.body.code,'LIVE_PROFILE_UNAVAILABLE');assert.notEqual(r.body.outcome,'not_recorded');}
 const h=new Harness({mode:'active',releaseId,authenticate,store:{...real,recoverReceipt:async()=>null}}),miss=await h.call('POST','/api/product/profile/receipt',{body:request()});assert.equal(miss.status,200);assert.equal(miss.body.outcome,'not_recorded');
});
test('actual store malformed known profile scalar/array/enum/policy fields are rejected before public projection',async()=>{
 for(const corrupt of [(p:any)=>{p.locations[0].address.label={privateProvenance:'MUST_NOT_RETURN'};},(p:any)=>{p.locations[0].paused={privateProvenance:'MUST_NOT_RETURN'};},(p:any)=>{p.preferences.optedIn='false';},(p:any)=>{p.locations[0].address.aliases='abc';},(p:any)=>{p.locations[0].binding.status=false;},(p:any)=>{p.locations[0].address.house.number={privateProvenance:'MUST_NOT_RETURN'};},(p:any)=>{p.preferences.quietHours.enabled='false';},(p:any)=>{p.preferences.morningBriefing.time={privateProvenance:'MUST_NOT_RETURN'};},(p:any)=>{p.legacyNotificationPolicySourceHash={privateProvenance:'MUST_NOT_RETURN'};},(p:any)=>{p.locations[0].notificationPolicy=false;},(p:any)=>{p.preferences.notificationPolicy=false;}]){
  const port=new Port();corrupt(port.data.state.profile);const r=await active(port.store()).call();assert.equal(r.status,503);assert.equal(r.body.code,'LIVE_PROFILE_UNAVAILABLE');assert(!JSON.stringify(r.body).includes('MUST_NOT_RETURN'));
 }
});
test('actual manual-display store view with a malformed known source URL cannot leak nested private values',async()=>{
 const p=new Port(),view:any={contractVersion:'lba-product/1',revisionId:'fixture-plan',addressId:'fixture-home',addressLabel:'Дім',localityLabel:'Fixture locality',operatorId:'fixture-operator',bindingRevisionId:'fixture-binding',namespace:'fixture:namespace',targetId:'1.1',serviceDate:'2026-11-08',timezone:'Europe/Kyiv',status:'no_planned_outages',dayCoverage:'complete',intervals:[],source:{id:'fixture-source',name:'Fixture source',url:{privateProvenance:'MUST_NOT_RETURN'},revision:'fixture-source-rev',accessCost:0,verifiedLevel:'schedule'},publishedAt:now,observedAt:now,freshness:'current',synthetic:false,deliveryEligible:false};
 const r=await active(p.store({addresses:[],plans:[view]})).call();assert.equal(r.status,503);assert.equal(r.body.code,'LIVE_PROFILE_UNAVAILABLE');assert(!JSON.stringify(r.body).includes('MUST_NOT_RETURN'));
});
test('disabled/read-only retain safe capabilities, cannot write/recover, and never invoke a canonical store',async()=>{
 let reads=0;for(const mode of ['disabled','read_only'] as const){
  const h=new Harness({mode,releaseId,authenticate,read:async()=>{reads++;return readFixture();}}),before=reads;
  const get=await h.call();assert.equal(get.status,mode==='disabled'?503:200);assert.equal(reads-before,mode==='disabled'?0:1);
  if(mode==='read_only'){assert.equal(get.body.capabilities.profileMutations,false);assert.equal(get.body.capabilities.tools,false);assert.equal(get.body.migration.status,'checking');assert.deepEqual(get.body.plans,[]);}
  for(const path of ['/api/product/profile','/api/product/profile/receipt']){const r=await h.call('POST',path,{body:request()});assert.equal(r.status,503);assert.equal(r.body.code,'LIVE_PROFILE_WRITER_NOT_READY');assert.equal(r.headers['cache-control'],'no-store');}
 }
});
test('ready denotes only editable profile state; empty accounts and verified-address profiles do not claim whole-product acceptance',async()=>{
 const p=new Port();p.data.state.profile.locations=[];p.data.state.profile.primaryAddressId=null;p.data.state.currentAddressId=null;
 const h=active(p.store()),r=await h.call();assert.equal(r.status,200);assert.equal(r.body.migration.status,'ready');assert.equal(r.body.capabilities.tools,false);assert(!('productAccepted'in r.body));assert.deepEqual(r.body.plans,[]);
});
test('active registration requires concrete canonical methods and an exact release hash',()=>{
 const p=new Port();assert.throws(()=>new Harness({mode:'active',releaseId:'bad',authenticate,store:p.store()}),/RELEASE_INVALID/);
 assert.throws(()=>new Harness({mode:'active',releaseId,authenticate,store:{}} as any),/PORTS_INVALID/);
});
