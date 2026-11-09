import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeKharkivRss} from '../../server/domain/kharkiv-adapter.ts';
import {createSourceIntake,type TechnicalDisplayAdmission} from '../../server/production/source-intake.ts';
import {technicalDisplaySourceRegistry,KHARKIV_9NOV_PUBLICATION_SCOPE} from '../../server/production/source-operating-policy.ts';
import {scheduleText} from '../../client/src/product-review/schedule-model.ts';
import {formatScheduleText} from '../../shared/bot/copy.ts';
import {parseLivePublicShare} from '../../shared/live-tools.ts';
import {publicReviewPlace} from '../../shared/review-tools.ts';
const raw=readFileSync(new URL('../../../docs/light-bot-app/production-release-20261109/schedule-notices/current-source/current.rss.xml',import.meta.url),'utf8');
const observedAt='2026-11-09T05:00:37.710Z',start=Date.parse(observedAt),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const entry=()=>technicalDisplaySourceRegistry(true).find(e=>e.sourceId==='kharkiv-official-rss') as TechnicalDisplayAdmission;
const request=(targetId='1.1',serviceDate='2026-11-09')=>({sourceId:'kharkiv-official-rss',operatorId:'kharkiv-oe',namespace:'kharkiv:rss',targetId,serviceDate});
const reader=(body=raw,now=start)=>createSourceIntake({registry:[entry()],now:()=>now,transport:async req=>({url:req.url,status:200,headers:{'content-type':'application/rss+xml'},body:(async function*(){yield Buffer.from(body);})()})});
const normalize=(body=raw)=>normalizeKharkivRss(body,{namespace:'kharkiv:rss',operatorId:'kharkiv-oe',targetId:'1.1',addressId:'unbound:kharkiv-oe:kharkiv:rss:1.1',addressLabel:'Група1.1',localityLabel:'Харківська область',serviceDate:'2026-11-09',observedAt,source:{id:'kharkiv-official-rss',name:'Харківобленерго',url:null,revision:hash(body),accessCost:0,verifiedLevel:'schedule'},freshness:'current',synthetic:false});
test('actual current public capture admits only reviewed9Nov12group technical plans, never binding/delivery/certification',async()=>{
 assert.equal(hash(raw),KHARKIV_9NOV_PUBLICATION_SCOPE.rawCaptureSha256);
 for(const target of Object.keys(KHARKIV_9NOV_PUBLICATION_SCOPE.targetPlanSha256s)){
  const result=await reader().load(request(target));assert.equal(result.state,'available');
  if(result.state==='available'){assert.equal(result.view.status,'published');assert.equal(result.view.source.verifiedLevel,'schedule');assert.equal(result.view.publishedAt,'2026-11-08T20:18:03.000Z');assert(result.view.intervals.every(i=>i.kind==='planned_outage'));assert.equal(result.deliveryEligible,false);assert.equal(result.view.deliveryEligible,false);assert.equal(result.addressBindingVerified,false);}
 }
 assert.equal(entry().parallel48hAccepted,false);assert.equal(entry().independentFallbackVerified,false);assert.equal(entry().rate.minIntervalMs,2700000);
 for(const date of ['2026-11-08','2026-11-10'])assert.notEqual((await reader().load(request('1.1',date))).state,'available');
 assert.equal((await reader(raw,Date.parse('2026-11-09T22:00:00Z')).load(request())).state,'blocked');
});
test('unrelated RSS news is not a blanket raw-hash failure; changed plan publication or target semantics needs review',async()=>{
 const unrelated=raw.replace('</channel>','<item><title>Інша новина</title><link>https://oblenergo.kharkiv.ua/uk/node/99999</link><pubDate>Mon, 09 Nov 2026 04:00:00 +0000</pubDate><description>Звичайна новина</description></item></channel>');
 assert.notEqual(hash(unrelated),hash(raw));assert.equal((await reader(unrelated).load(request())).state,'available');
 for(const body of [raw.replace('Sun, 08 Nov 2026 20:18:03 +0000','Sun, 08 Nov 2026 20:19:03 +0000'),raw.replace('01:00-04:30','01:00-04:31')])assert.notEqual((await reader(body).load(request())).state,'available');
});
test('an old emergency alone neither cancels9Nov plan nor proves normal power; a new service-day emergency is not ignored',async()=>{
 const old=raw.replace('</channel>','<item><title>Аварійні відключення</title><pubDate>Sun, 08 Nov 2026 08:05:02 +0000</pubDate><description>Запроваджено аварійні відключення</description></item></channel>');
 assert.equal(normalize(old).status,'published');assert.match(normalize(old).notice??'',/Поточний аварійний стан групи не підтверджено/);
 const current=raw.replace('</channel>','<item><title>Аварійні відключення9листопада</title><pubDate>Mon, 09 Nov 2026 04:00:00 +0000</pubDate><description>Запроваджено аварійні відключення</description></item></channel>');
 assert.throws(()=>normalize(current),/CURRENT_EMERGENCY_REQUIRES_SCOPED_REVIEW/);assert.notEqual((await reader(current).load(request())).state,'available');
 assert.throws(()=>normalize(raw.replace('з урахуванням часу на перемикання (орієнтовно)','без застереження')),/SWITCHING_CAVEAT_REQUIRES_REVIEW/);
});
test('emergency bulletin review follows operative scope and effective date, not a keyword or posting-midnight shortcut',async()=>{
 const add=(title:string,description:string,publication='Mon, 09 Nov 2026 04:00:00 +0000')=>raw.replace('</channel>',`<item><title>${title}</title><pubDate>${publication}</pubDate><description><![CDATA[${description}]]></description></item></channel>`);
 for(const body of [
  add('Поради споживачам','Як підготуватися до аварійних відключень? Пояснюємо правила безпеки.'),
  add('Новини Києва','У Києві застосовуються аварійні відключення. Це повідомлення стосується лише міста Києва.'),
  add('Поради споживачам','Що робити, якщо застосовуються аварійні відключення?'),
  add('Харківська область','Наразі аварійні відключення не застосовуються.'),
  add('Аварійні відключення 9 листопада','У Харківській області 9 листопада аварійні відключення скасовано.'),
  add('Поради споживачам','Що робити, якщо аварійні відключення не було скасовано?'),
  add('Новини Києва','У Києві 9 листопада аварійні відключення не скасовано.'),
 ]) assert.equal((await reader(body).load(request())).state,'available');
 for(const body of [
  add('Аварійні відключення 9 листопада','У Харківській області 9 листопада з 00:00 запроваджуються аварійні відключення.','Sun, 08 Nov 2026 21:00:00 +0000'),
  add('Аварійні відключення','У Харківській області 09.11.2026 з 00:00 запроваджуються аварійні відключення.','Sun, 08 Nov 2026 21:00:00 +0000'),
  add('Аварійні відключення','У Харківській області завтра з 00:00 запроваджуються аварійні відключення.','Sun, 08 Nov 2026 21:00:00 +0000'),
  add('Аварійні відключення','У Харківській області 9 листопада застосовуються аварійні відключення.','Sun, 08 Nov 2026 19:00:00 +0000'),
  add('Аварійні відключення 9 листопада','У Харківській області 9 листопада аварійні відключення не скасовано.'),
  add('Аварійні відключення 9 листопада','У Харківській області 9 листопада аварійні відключення не було скасовано.'),
  add('Аварійні відключення 9 листопада','У Харківській області 9 листопада аварійні відключення залишаються чинними.'),
 ]) assert.notEqual((await reader(body).load(request())).state,'available');
});
test('notice survives full app text, bot text and public saved-plan validation without inventing live freshness',()=>{
 const view=normalize(),text=scheduleText(view),bot=formatScheduleText(view);for(const value of [text,bot]){assert(value.includes(view.notice!));assert.equal(value.split(view.notice!).length-1,1);}
 const share={runtime:'production',mode:'saved_plan',serviceDate:view.serviceDate,createdAt:observedAt,expiresAt:'2026-11-10T05:00:37.710Z',places:[{label:view.addressLabel,localityLabel:view.localityLabel,scope:'technical_group',serviceDate:view.serviceDate,timezone:view.timezone,status:view.status,dayCoverage:view.dayCoverage,freshness:view.freshness,intervals:view.intervals,sourceName:view.source.name,observedAt:view.observedAt,notice:view.notice}]};
 assert.equal(parseLivePublicShare(share).places[0].notice,view.notice);
  assert.equal(publicReviewPlace('Тестова група','Харківська область',view.serviceDate,{...view,synthetic:true}).notice,view.notice);
 assert.throws(()=>parseLivePublicShare({...share,places:[{...share.places[0],notice:42}]}),/INVALID_INPUT/);
 const old=reader();assert.equal(typeof old.projectSnapshot,'function');
});
test('an archived snapshot becomes stale after3h and changed-plan refresh preserves only stale prior evidence',async()=>{
 let clock=start,body=raw;const intake=createSourceIntake({registry:[entry()],now:()=>clock,transport:async req=>({url:req.url,status:200,headers:{'content-type':'application/rss+xml'},body:(async function*(){yield Buffer.from(body);})()})});
 const first=await intake.load(request());assert.equal(first.state,'available');const captured=intake.snapshotRaw('kharkiv-official-rss')!;
 clock+=10800001;const projected=intake.projectSnapshot(request(),captured);assert.equal(projected.state,'available');if(projected.state==='available'){assert.equal(projected.view.status,'stale');assert.equal(projected.view.observedAt,observedAt);assert.equal(projected.deliveryEligible,false);}
 body=raw.replace('01:00-04:30','01:00-04:31');const failed=await intake.load(request());assert.equal(failed.state,'available');if(failed.state==='available'){assert.equal(failed.view.status,'stale');assert.equal(failed.refreshFailure,'SOURCE_SCHEMA_REJECTED');assert.equal(failed.provenance.rawSha256,hash(raw));}
});
