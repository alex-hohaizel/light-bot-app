import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeHourMatrix} from '../../server/domain/hour-matrix-adapter.ts';
import {normalizeYasnoRaw} from '../../server/domain/yasno-adapter.ts';
import {normalizeKharkivRss} from '../../server/domain/kharkiv-adapter.ts';
const directory=new URL('../../../docs/light-bot-app/release-v8/data-current-2026-11-08/',import.meta.url);
const read=(name:string)=>readFileSync(new URL(name,directory),'utf8');
const hash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const observedAt='2026-11-08T17:39:00Z';
const context=(raw:string,id:string)=>({addressId:'unbound-test-group',addressLabel:'Обрана група',localityLabel:'Public captured plan',
 serviceDate:'2026-11-08',observedAt,freshness:'current' as const,synthetic:false,
 source:{id,name:'Public capture',url:null,revision:hash(raw),accessCost:0 as const,verifiedLevel:'schedule' as const}});

test('actual8Nov mirrors retain exact region/source provenance and OEM half-hours; never relabelled official',()=>{
 const raw=read('odesa-mirror.txt'),ctx={...context(raw,'mirror-odesa'),namespace:'dtek:oem-mirror' as const,operatorId:'dtek-oem',targetId:'GPV1.1'};
 const view=normalizeHourMatrix(raw,ctx);assert.equal(view.serviceDate,'2026-11-08');assert.equal(view.source.id,'mirror-odesa');
 assert.equal(view.operatorId,'dtek-oem');assert.equal(view.namespace,'dtek:oem');assert.equal(view.deliveryEligible,false);
 assert.ok(view.intervals.length>0);assert.ok(view.intervals.every(i=>i.startLocal.endsWith(':00')||i.startLocal.endsWith(':30')));
 assert.throws(()=>normalizeHourMatrix(raw,{...ctx,namespace:'voe:vn-progr',operatorId:'vinnytsia-oe'}));
 assert.throws(()=>normalizeHourMatrix(raw,{...ctx,source:{...ctx.source,id:'dtek-oem-official'}}));
 const wrong=JSON.parse(raw);wrong.regionId='kyiv';const body=JSON.stringify(wrong);
 assert.throws(()=>normalizeHourMatrix(body,{...ctx,source:{...ctx.source,revision:hash(body)}}),/REGION_MISMATCH/);
});
test('actual8Nov Kyiv waiting tomorrow stays unpublished and Kharkiv remains its own operator',()=>{
 const raw=read('yasno-kem.json'),ctx={...context(raw,'yasno-kem'),namespace:'yasno:25/902' as const,operatorId:'dtek-kem',targetId:'1.1'};
 const today=normalizeYasnoRaw(raw,'today',ctx);assert.equal(today.status,'published');
 const next=normalizeYasnoRaw(raw,'tomorrow',{...ctx,serviceDate:'2026-11-09'});assert.equal(next.status,'not_published');assert.deepEqual(next.intervals,[]);
 const rss=read('kharkiv-rss.txt');const kharkiv=normalizeKharkivRss(rss,{...context(rss,'kharkiv-official-rss'),namespace:'kharkiv:rss',operatorId:'kharkiv-oe',targetId:'1.1'});
 assert.equal(kharkiv.serviceDate,'2026-11-08');assert.equal(kharkiv.operatorId,'kharkiv-oe');assert.equal(kharkiv.deliveryEligible,false);
});
