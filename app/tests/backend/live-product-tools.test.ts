import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLiveToolsRequest,parseLiveToolReceipt,parseLivePublicShare,parseLiveToolsSnapshot,liveToolsErrorMessage} from '../../shared/live-tools.ts';
import {createBotState} from '../../shared/bot/engine.ts';
import {createProductionTools,liveShareScopeFingerprint,invalidateProductionToolShares} from '../../server/production/product-tools.ts';
const request={id:'fixture-1',expectedSessionId:'session-a',expectedRevision:0,action:{kind:'report',addressId:'address-a',value:'off'}};
const location:any={address:{id:'a',label:'Дім',territoryId:'t',locality:'Місто',street:'вул. Тестова',house:{number:'12',literal:'12'},aliases:[]},binding:{addressId:'a',operatorId:'o',namespace:'n',targetId:'1.1',kind:'building',revisionId:'r',status:'verified',verifiedAt:null,effectiveFrom:null,effectiveUntil:null},notifications:false,paused:false};
test('closed production parser rejects owner/private fields, link impersonation and foreign action shapes',()=>{
 assert.equal(parseLiveToolsRequest(request).action.kind,'report');
 for(const patch of [{ownerId:'other'},{profile:{}},{action:{...request.action,owner:'other'}},{action:{kind:'link_account',provider:'Telegram'}},{expectedRevision:'0'},{action:{kind:'share',addressIds:['a','a'],ttlDays:1,serviceDate:'2026-11-09'}},{action:{kind:'share',addressIds:['a'],ttlDays:'1',serviceDate:'2026-11-09'}}])assert.throws(()=>parseLiveToolsRequest({...request,...patch}));
});
test('production receipts require exact committed semantics and closed known scalars',()=>{
 const r={runtime:'production',id:'one',inputId:'tools:one',sessionId:'s',profileRevision:1,recordedAt:'2026-11-09T01:00:00Z',committed:true,kind:'report'};
 assert.equal(parseLiveToolReceipt(r).committed,true);for(const patch of [{privateToken:'x'},{committed:'true'},{profileRevision:'1'},{inputId:'other'},{kind:'share'},{shareToken:'f'.repeat(48)}])assert.throws(()=>parseLiveToolReceipt({...r,...patch}));
});
test('physical fingerprints preserve rename/preferences but bind exact source IDs and aliases',()=>{
 const before=liveShareScopeFingerprint(location);assert.equal(liveShareScopeFingerprint({...location,address:{...location.address,label:'Батьки'},paused:true}),before);
 for(const patch of [{streetId:'new-source-street'},{localityId:'different-town'},{placeNames:['evidenced object']},{aliases:['old street']}])assert.notEqual(liveShareScopeFingerprint({...location,address:{...location.address,...patch}}),before);
 assert.notEqual(liveShareScopeFingerprint({...location,binding:{...location.binding,namespace:'other'}}),before);
});
test('profile lifecycle permanently revokes removed grants and session changes using exact owner',async()=>{
 const before=createBotState({ownerId:'owner',sessionId:'s'});before.profile.locations=[location];const after=structuredClone(before);after.profile.locations=[];
 const calls:any[]=[];const client={query:async(sql:string,values:any[])=>{calls.push({sql,values});return {rows:[],rowCount:0};}};
 await invalidateProductionToolShares({client,before,after,serverNow:'2026-11-09T00:00:00Z'});assert.deepEqual(calls[0].values.slice(0,2),['owner',['a']]);
 after.sessionId='new';await invalidateProductionToolShares({client,before,after,serverNow:'2026-11-09T00:00:00Z'});assert(!calls[1].sql.includes('jsonb_array_elements'));
});
test('public snapshot whitelist rejects nested private fields, bad intervals and forged success status',()=>{
 const p={runtime:'production',mode:'saved_plan',serviceDate:'2026-11-09',createdAt:'2026-11-09T00:00:00Z',expiresAt:'2026-11-10T00:00:00Z',places:[{label:'Дім',localityLabel:'Місто',scope:'address',serviceDate:'2026-11-09',timezone:'Europe/Kyiv',status:'not_published',dayCoverage:'none',freshness:'unknown',intervals:[],sourceName:'План ще не опублікований',observedAt:null}]};
 assert.equal(parseLivePublicShare(p).places[0].status,'not_published');for(const patch of [{ownerId:'private'},{places:[{...p.places[0],street:'private'}]},{places:[{...p.places[0],label:{private:'x'}}]},{places:[{...p.places[0],status:'on'}]},{places:[{...p.places[0],intervals:[{startsAt:'bad',endsAt:'bad',startLocal:'00:00',endLocal:'01:00',kind:'planned_outage',secret:'x'}]}]}])assert.throws(()=>parseLivePublicShare({...p,...patch}));
});
test('disabled construction is inert and all reads/commits fail closed before database',async()=>{
 let calls=0;const t=createProductionTools({store:{withLockedProfile:async()=>{calls++;throw Error('not called');}},pool:{connect:async()=>{calls++;throw Error('not called');}},expectedControlEpoch:7});
 await assert.rejects(t.snapshot({kind:'verified_server_principal',ownerId:'owner',verified:true}),/DISABLED/);await assert.rejects(t.publicShare('f'.repeat(48)),/DISABLED/);assert.equal(calls,0);
});
test('error copy never echoes driver secrets or implementation details',()=>{assert.equal(liveToolsErrorMessage('postgres://private'),liveToolsErrorMessage(null));assert(!liveToolsErrorMessage('PRODUCTION_COMMIT_UNKNOWN').includes('postgres'));});
test('provider operator group awaiting building confirmation is explicitly a technical public scope',async()=>{
 const now='2026-11-09T08:00:00.000Z',state=createBotState({ownerId:'owner',sessionId:'s'}),group=structuredClone(location);group.binding.kind='operator_group';group.binding.status='needs_confirmation';state.profile.locations=[group];let published:any;
 const client={query:async(sql:string,values:any[]=[])=>{if(sql.startsWith('insert into lba_production_tools_shares'))published=JSON.parse(values[7]);return {rows:[],rowCount:0};}};
 const tools=createProductionTools({enabled:true,expectedControlEpoch:7,store:{withLockedProfile:async()=>{throw Error('not called');}},pool:{connect:async()=>{throw Error('not called');}}});
 const p:any={contractVersion:'lba-product/1',revisionId:'r',addressId:'a',operatorId:'o',namespace:'n',targetId:'1.1',bindingRevisionId:'r',addressLabel:'Дім',localityLabel:'Місто',serviceDate:'2026-11-09',timezone:'Europe/Kyiv',status:'no_planned_outages',dayCoverage:'complete',intervals:[],source:{id:'s',name:'Оператор',url:null,revision:'r',accessCost:0,verifiedLevel:'schedule'},observedAt:now,publishedAt:null,freshness:'current',synthetic:false,deliveryEligible:false};
 await tools.commitActionInTransaction({client,state,context:{actorId:'owner',now,addresses:[],plans:[p]},serverNow:now},{id:'group-share',expectedSessionId:'s',expectedRevision:0,action:{kind:'share',addressIds:['a'],ttlDays:1,serviceDate:'2026-11-09'}});assert.equal(published.places[0].scope,'technical_group');assert.equal(published.places[0].status,'no_planned_outages');
});
test('JSON arrays never coerce to report/receipt/public-scope/report-value/share-status enums',()=>{
 assert.throws(()=>parseLiveToolsRequest({...request,action:{...request.action,value:['on']}}));
 assert.throws(()=>parseLiveToolReceipt({runtime:'production',id:'one',inputId:'tools:one',sessionId:'s',profileRevision:0,recordedAt:'2026-11-09T08:00:00Z',committed:true,kind:['report']}));
 assert.throws(()=>parseLivePublicShare({runtime:'production',mode:'saved_plan',serviceDate:'2026-11-09',createdAt:'2026-11-09T08:00:00Z',expiresAt:'2026-11-10T08:00:00Z',places:[{label:'Дім',localityLabel:'Місто',scope:['technical_group'],serviceDate:'2026-11-09',timezone:'Europe/Kyiv',status:'not_published',dayCoverage:'none',freshness:'unknown',intervals:[],sourceName:'Оператор',observedAt:null}]}));
 const snapshot:any={runtime:'production',sessionId:'s',profileRevision:0,serverNow:'2026-11-09T08:00:00Z',capabilities:{reports:true,shares:true,accountLinking:false,accountUnlinking:false,verifiedOutageStatistics:false},reports:[{id:'r',addressId:'a',label:'Дім',locality:'Місто',value:'on',recordedAt:'2026-11-09T08:00:00Z',archived:false}],legacyReports:[],legacyReportsStatus:'available',digest:{fromDate:'2026-11-03',throughDate:'2026-11-09',observationCount:1,observationDays:1,onCount:1,offCount:0,verifiedOutageDays:0,legacyDigestCount:0},accounts:[],accountsStatus:'available',shares:[{token:'f'.repeat(48),url:'/shared-plan/'+'f'.repeat(48),serviceDate:'2026-11-09',createdAt:'2026-11-09T08:00:00Z',expiresAt:'2026-11-10T08:00:00Z',status:'active',labels:['Дім']}]};
 assert.equal(parseLiveToolsSnapshot(snapshot).reports[0].value,'on');const badReport=structuredClone(snapshot);badReport.reports[0].value=['on'];assert.throws(()=>parseLiveToolsSnapshot(badReport));const badShare=structuredClone(snapshot);badShare.shares[0].status=['active'];assert.throws(()=>parseLiveToolsSnapshot(badShare));
});
