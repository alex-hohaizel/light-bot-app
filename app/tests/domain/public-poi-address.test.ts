import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildYasnoAddressCandidate,readYasnoHouseCandidates,YASNO_KYIV_ADDRESS_SCOPE,type YasnoAddressCapture} from '../../server/domain/yasno-address-adapter.ts';
const directory=new URL('../../../docs/light-bot-app/release-v8/address-data-integration/public-poi/',import.meta.url);
const ledger=JSON.parse(readFileSync(new URL('observations.json',directory),'utf8'));
const policy={asOf:new Date(Math.max(...ledger.requests.map((r:any)=>Date.parse(r.observed_at_utc)))+1000).toISOString(),maximumCaptureAgeMs:900000};
function capture(name:string):YasnoAddressCapture{
 const r=ledger.requests.find((r:any)=>r.name===name),raw=readFileSync(new URL(r.body_file,directory),'utf8');
 assert.equal(createHash('sha256').update(raw).digest('hex'),r.response_sha256);
 return {sourceId:'yasno-public-address-v2',method:'GET',url:r.url,httpStatus:200,contentType:r.headers['Content-Type'],observedAt:r.observed_at_utc,rawBody:raw,rawSha256:r.response_sha256};
}
test('actual road candidate distinguishes Кільцева from Велика Кільцева and binds only house1/44360 to25.1',()=>{
 const input={scope:YASNO_KYIV_ADDRESS_SCOPE,selection:{streetId:985,streetValue:'дорога Кільцева',houseId:44360,houseLiteral:'1'},captures:{streets:capture('respublika-streets'),houses:capture('respublika-exact-houses'),group:capture('respublika-confirmed-chain-group')},policy};
 const c=buildYasnoAddressCandidate(input);assert.equal(c.binding.targetId,'25.1');assert.equal(c.address.streetId,'source:yasno:25/902:street:985');assert.equal(c.address.house.literal,'1');
 assert.equal(c.binding.status,'needs_confirmation');assert.equal(c.proof.independentlyConfirmed,false);assert.equal(c.proof.deliveryEligible,false);assert.deepEqual(c.address.placeNames,undefined);
 for(const selection of [{...input.selection,streetId:125,streetValue:'вул. Велика Кільцева'},{...input.selection,houseId:44361,houseLiteral:'1А'}])assert.throws(()=>buildYasnoAddressCandidate({...input,selection}));
});
test('exact public business queries empty cannot promote adjacent addresses from a default listing',()=>{
 for(const [name,street] of [['ocean-exact-house',43],['lavina-exact-house',67]] as const){
  const result=readYasnoHouseCandidates(capture(name),street,policy);assert.equal(result.items.length,0);
 }
 // Default provider listing is not a complete search response and is refused by
 // the exact-query capture contract, even though the HTTP response was valid.
 assert.throws(()=>readYasnoHouseCandidates(capture('lavina-houses'),67,policy),/REQUEST_FIELDS_MISMATCH/);
});
