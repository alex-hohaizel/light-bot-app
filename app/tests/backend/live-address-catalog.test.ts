import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAddressCatalog,ADDRESS_CATALOG_SCHEMA_SQL,ADDRESS_CATALOG_POLICY} from '../../server/production/address-catalog.ts';
import {collectAddressCapture} from '../../server/production/address-catalog-http.ts';
import {technicalDisplaySourceRegistry,YASNO_SHARED_ORIGIN_BUDGET_MS} from '../../server/production/source-operating-policy.ts';
import type {SourceHttpTransport} from '../../server/production/source-intake.ts';
const url='https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/streets?regionId=25&dsoId=902&query=%D0%9A%D1%96%D0%BB%D1%8C%D1%86%D0%B5%D0%B2%D0%B0';
const now=()=>Date.parse('2026-11-08T21:00:00Z');
const body=(raw:string|Uint8Array)=>({async *[Symbol.asyncIterator](){yield typeof raw==='string'?Buffer.from(raw):raw;}});
const base=()=>({pool:{async connect(){throw Error('UNEXPECTED_DB');}},transport:async()=>{throw Error('UNEXPECTED_HTTP');},now,expectedControlEpoch:7});
test('default disabled catalog, every entrypoint, is inert and explicit DDL contains only public address cache',async()=>{
 const s=createAddressCatalog(base());
 for(const r of [await s.searchStreets({namespace:'yasno:25/902',query:'Кільцева'}),await s.searchHouses({}),await s.resolveCandidate({}),await s.readSnapshot('invalid'),await s.readCandidates()])assert.equal(r.state,'disabled');
 assert(!/user_settings|user_locations|telegram_subscribers|linked_accounts|\busers\b|owner_id/i.test(ADDRESS_CATALOG_SCHEMA_SQL));
 assert.equal(ADDRESS_CATALOG_POLICY.deliveryEligible,false);assert.equal(ADDRESS_CATALOG_POLICY.addressBindingVerified,false);
});
test('constructor requires bounded injected IO and exact safe control epoch; never builds fetch/pool',()=>{
 for(const patch of [{expectedControlEpoch:0},{expectedControlEpoch:1.5},{expectedControlEpoch:Number.MAX_SAFE_INTEGER+1},{enabled:'true'},{timeoutMs:0},{timeoutMs:30001},{transport:null},{now:null}])assert.throws(()=>createAddressCatalog({...base(),...patch} as any));
});
test('wrong scope, arbitrary URL/private labels, invalid IDs, getters and surplus fields reject before any database or HTTP',async()=>{
 const s=createAddressCatalog({...base(),enabled:true});
 assert.equal((await s.searchStreets({namespace:'yasno:3/301',query:'Кільцева'})).state,'unsupported');
 for(const value of [{namespace:'yasno:25/902',query:'К'}, {namespace:'yasno:25/902',query:'abc\n'},
  {namespace:'yasno:25/902',query:'Кільцева',url:'https://evil.invalid'}, {namespace:'yasno:25/902',query:'Кільцева',ownerId:'private'},
  Object.defineProperty({namespace:'yasno:25/902'},'query',{enumerable:true,get(){throw Error('GETTER_EXECUTED');}})])assert.equal((await s.searchStreets(value) as any).code,'ADDRESS_INVALID_REQUEST');
 assert.equal((await s.searchHouses({streetSnapshotId:'bad',streetId:1,query:'1'}) as any).code,'ADDRESS_INVALID_REQUEST');
 assert.equal((await s.resolveCandidate({streetSnapshotId:'bad',houseSnapshotId:'bad',streetId:1,houseId:1,label:'Private account'}) as any).code,'ADDRESS_INVALID_REQUEST');
});
test('missing/wrong control cannot read cache or make provider request; transaction always rolls back and releases',async()=>{
 for(const rows of [[],[{control_epoch:7,writer_mode:'legacy'}],[{control_epoch:8,writer_mode:'canonical'}]]){
  const queries:string[]=[];let released=false;
  const c={async query(sql:string){queries.push(sql);return {rows:sql.includes('pg_try_advisory_lock')?[{locked:true}]:sql.includes('lba_production_control')?rows:[],rowCount:0};},release(){released=true;}};
  const s=createAddressCatalog({...base(),enabled:true,pool:{async connect(){return c;}}});
  const r=await s.searchStreets({namespace:'yasno:25/902',query:'Кільцева'});assert.notEqual(r.state,'available');
  assert(queries.includes('rollback'));assert(released);assert(!queries.some(q=>q.includes('lba_public_address_query')));
 }
});
test('expired/rollback clock cannot query even a local cache',async()=>{
 let time=Date.parse(ADDRESS_CATALOG_POLICY.validUntil);const s=createAddressCatalog({...base(),enabled:true,now:()=>time});
 assert.equal((await s.readCandidates()).code,'ADDRESS_ADMISSION_EXPIRED');time-=1;
 assert.equal((await s.readCandidates()).code,'ADDRESS_CLOCK_INVALID');
});
test('actual captured public street bytes are hashed without changing source observation or inventing metadata',async()=>{
 const dir=new URL('../../../docs/light-bot-app/release-v8/address-data-integration/public-poi/',import.meta.url);
 const ledger=JSON.parse(await readFile(new URL('observations.json',dir),'utf8'));
 const record=ledger.requests.find((r:any)=>r.name==='respublika-streets'),raw=await readFile(new URL(record.body_file,dir),'utf8');
 assert.equal(createHash('sha256').update(raw).digest('hex'),record.response_sha256);
 let calls=0;const transport:SourceHttpTransport=async r=>{calls++;assert.equal(r.url,url);assert.equal(r.credentials,'omit');assert.equal(r.redirect,'error');assert.deepEqual(r.headers,{'accept-encoding':'identity'});assert.equal(r.maxBytes,250000);return {url:r.url,status:200,headers:{'content-type':record.headers['Content-Type'],'content-length':String(Buffer.byteLength(raw))},body:body(raw)};};
 const result=await collectAddressCapture({url,transport,now:()=>Date.parse(record.observed_at_utc),timeoutMs:100});
 assert.equal(result.ok,true);if(result.ok){assert.equal(result.capture.rawSha256,record.response_sha256);assert.equal(result.capture.rawBody,raw);assert.equal(Date.parse(result.capture.observedAt),Date.parse(record.observed_at_utc));assert.equal(result.capture.sourceId,'yasno-public-address-v2');}
 assert.equal(calls,1);
});
test('untrusted origin/operation is refused without invoking injected transport',async()=>{
 let calls=0;const transport:SourceHttpTransport=async()=>{calls++;throw Error('NO');};
 for(const bad of ['https://evil.invalid',url.replace('app.yasno.ua','app.yasno.ua.evil.invalid'),url.replace('/streets?','/account?'),url+'#fragment',url.replace('https://','https://user@')]){
  const result=await collectAddressCapture({url:bad,transport,now,timeoutMs:100});assert.equal(result.ok,false);if(!result.ok)assert.equal(result.code,'ADDRESS_ORIGIN_REJECTED');
 }
 assert.equal(calls,0);
});
test('redirect/final URL mismatch, 403 and 404 remain different explicit transport outcomes',async()=>{
 for(const [status,final,code,hold] of [[200,url+'x','ADDRESS_ORIGIN_REJECTED',true],[403,url,'ADDRESS_HTTP_REJECTED',true],[404,url,'ADDRESS_HTTP_REJECTED',false],[304,url,'ADDRESS_HTTP_REJECTED',false]] as const){
  const r=await collectAddressCapture({url,now,timeoutMs:100,transport:async()=>({url:final,status,headers:{},body:body('[]')})});
  assert(!r.ok);assert.equal(r.code,code);assert.equal(r.hold,hold);
 }
});
test('429 positive bounded retry-after differs from unknown/malformed limits and never reads response body',async()=>{
 for(const retry of [undefined,'0','-1','86401','1.5','tomorrow']){
  const r=await collectAddressCapture({url,now,timeoutMs:100,transport:async()=>({url,status:429,headers:{'retry-after':retry},body:{async *[Symbol.asyncIterator](){throw Error('BODY_MUST_NOT_READ');}}})});
  assert(!r.ok);assert.equal(r.code,'ADDRESS_RATE_LIMIT_UNVERIFIED');assert.equal(r.hold,true);
 }
 const r=await collectAddressCapture({url,now,timeoutMs:100,transport:async()=>({url,status:429,headers:{'retry-after':'120'},body:body('[]')})});
 assert(!r.ok);assert.equal(r.retryAfterMs,120000);assert.equal(r.hold,false);
});
test('HTML/challenge, compressed payload, forged length, oversized body and UTF8 corruption are refused',async()=>{
 for(const [headers,raw,code] of [
  [{'content-type':'text/html'},'<html>challenge</html>','ADDRESS_CONTENT_TYPE_REJECTED'],
  [{'content-type':'application/json','content-encoding':'gzip'},'[]','ADDRESS_ENCODING_REJECTED'],
  [{'content-type':'application/json','content-length':'3'},'[]','ADDRESS_BODY_LIMIT'],
  [{'content-type':'application/json','content-length':'250001'},'[]','ADDRESS_BODY_LIMIT'],
  [{'content-type':'application/json'},new Uint8Array(250001),'ADDRESS_BODY_LIMIT'],
  [{'content-type':'application/json'},Uint8Array.from([0xff,0xff]),'ADDRESS_UTF8_REJECTED'],
 ] as const){const r=await collectAddressCapture({url,now,timeoutMs:100,transport:async()=>({url,status:200,headers,body:body(raw)})});assert(!r.ok);assert.equal(r.code,code);}
});
test('chunk cap and ambiguous header spelling cannot create an accepted raw capture',async()=>{
 const chunks={async *[Symbol.asyncIterator](){for(let i=0;i<4097;i++)yield Uint8Array.from([32]);}};
 const r=await collectAddressCapture({url,now,timeoutMs:100,transport:async()=>({url,status:200,headers:{'content-type':'application/json'},body:chunks})});assert(!r.ok);assert.equal(r.code,'ADDRESS_BODY_LIMIT');
 const ambiguous=await collectAddressCapture({url,now,timeoutMs:100,transport:async()=>({url,status:200,headers:{'content-type':'application/json','Content-Type':'text/html'},body:body('[]')})});assert(!ambiguous.ok);
});
test('transport timeout returns a durable-hold instruction even when the transport ignores abort and resolves late',async()=>{
 let resolve!:(v:any)=>void;const pending=new Promise<any>(r=>resolve=r);
 const result=await collectAddressCapture({url,now,timeoutMs:5,transport:async()=>pending});
 assert(!result.ok);assert.equal(result.code,'ADDRESS_TIMEOUT');assert.equal(result.hold,true);assert.equal(result.workerHold,true);
 resolve({url,status:200,headers:{'content-type':'application/json'},body:body('[]')});await new Promise(r=>setImmediate(r));
 assert.equal(result.ok,false);
});
test('one-second YASNO origin budget preserves five-minute plan cadence;9Nov mirror semantic display scope creates no address certification',()=>{
 const registry=technicalDisplaySourceRegistry(true),kem=registry.find(r=>r.sourceId==='yasno-kem')!;
 assert(kem.state==='technical_display');assert.equal(kem.rate.minIntervalMs,YASNO_SHARED_ORIGIN_BUDGET_MS);assert.equal(kem.cacheTtlMs,300000);assert.equal(kem.providerQuota,'not_published_in_reviewed_sources');
 const kh=registry.find(r=>r.sourceId==='kharkiv-official-rss')!;assert(kh.state==='technical_display');assert.equal(kh.publicationScope?.serviceDate,'2026-11-09');assert.equal(kh.addressBindingVerified,false);assert.equal(kh.deliveryEligible,false);
 const vn=registry.find(r=>r.sourceId==='voe-mirror-vn-progr')!;assert.equal(vn.state,'blocked');
 const mirror=registry.find(r=>r.sourceId==='mirror-odesa')!;assert(mirror.state==='technical_display');assert.equal(mirror.semanticScope?.serviceDate,'2026-11-09');assert.equal(mirror.addressBindingVerified,false);assert.equal(mirror.deliveryEligible,false);assert.equal(mirror.independentFallbackVerified,false);
 for(const name of ['dtek-oem-official','yasno-dnem','yasno-cek'])assert.equal(registry.find(r=>r.sourceId===name)?.state,'blocked');
});
