import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {build} from 'esbuild';
import {createSourceIntake} from '../../server/production/source-intake.ts';
import {technicalDisplaySourceRegistry} from '../../server/production/source-operating-policy.ts';
import {renderScheduleSvg,scheduleText} from '../../client/src/product-review/schedule-renderer.tsx';
import {formatScheduleText} from '../../shared/bot/copy.ts';
import {DistrictDashboard} from '../../client/src/product-review/DistrictDashboard.tsx';
import {SharedDayComparison} from '../../client/src/product-review/SharedDayComparison.tsx';
// The existing TSX sources use host JSX transformation; this standalone SSR
// harness supplies React explicitly without changing those accepted sources.
(globalThis as any).React=React;
const root=new URL('../../../',import.meta.url),out=new URL('docs/light-bot-app/production-release-20261109/schedule-notices/',root);
mkdirSync(out,{recursive:true});
const raw=readFileSync(new URL('current-source/current.rss.xml',out),'utf8'),observedAt='2026-11-09T05:00:37.710Z';
const intake=()=>createSourceIntake({registry:technicalDisplaySourceRegistry(true),now:()=>Date.parse(observedAt),transport:async req=>({url:req.url,status:200,headers:{'content-type':'application/rss+xml'},body:(async function*(){yield Buffer.from(raw);})()})});
const views=[];
for(const targetId of ['1.1','1.2']){const result=await intake().load({sourceId:'kharkiv-official-rss',operatorId:'kharkiv-oe',namespace:'kharkiv:rss',targetId,serviceDate:'2026-11-09'});if(result.state!=='available')throw Error('REPRESENTATIVE_SCOPE_FAILED');views.push(result.view);}
const view=views[0];writeFileSync(new URL('representative-view.json',out),JSON.stringify(view,null,2)+'\n');writeFileSync(new URL('representative-text.txt',out),scheduleText(view));writeFileSync(new URL('representative-bot-text.txt',out),formatScheduleText(view));
for(const variant of ['now','next'] as const)writeFileSync(new URL(`representative-${variant}-text.txt`,out),scheduleText(view,variant,observedAt));
const addresses=views.map(v=>({id:v.addressId,label:v.addressLabel,city:'Харківська область',street:'Обрана група',house:v.targetId!,confirmedInDemo:false,paused:false}));
const noop=()=>{};
let css=['product-review.css','district.css'].map(name=>readFileSync(new URL('app/client/src/product-review/'+name,root),'utf8')).join('\n');
for(const name of ['onest','manrope'])css=css.replace(`url('/fonts/${name}.ttf')`,`url('data:font/ttf;base64,${readFileSync(new URL('app/client/public/fonts/'+name+'.ttf',root)).toString('base64')}')`);
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const measurements=[];
const detailMeasurements=[];
const detailCode=`import React from 'react';import {createRoot} from 'react-dom/client';import {DayPlanDetails} from './client/src/product-review/DistrictDashboard.tsx';import {ScheduleCard} from './client/src/product-review/schedule-renderer.tsx';const f=window.NOTICE_FIXTURE;createRoot(document.getElementById('detail-root')).render(React.createElement('div',{className:'pr-app '+(f.theme==='dark'?'pr-dark':''),'data-design':'district','data-motion':'off'},React.createElement('main',{className:'pr-main'},React.createElement(DayPlanDetails,{view:f.view,asOf:f.asOf,initiallyOpen:true}),React.createElement(ScheduleCard,{view:f.view,variant:'now',theme:f.theme,asOf:f.asOf}))));`;
const detailBuild=await build({stdin:{contents:detailCode,resolveDir:fileURLToPath(new URL('app/',root)),sourcefile:'notice-details-harness.jsx',loader:'jsx'},tsconfig:fileURLToPath(new URL('app/tsconfig.json',root)),bundle:true,format:'iife',platform:'browser',jsx:'automatic',target:'es2022',write:false});
try{
 for(const theme of ['light','dark'] as const){
  const svg=renderScheduleSvg(view,'day',theme);writeFileSync(new URL(`representative-${theme}.svg`,out),svg);await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL(`representative-${theme}.png`,out)));await sharp(Buffer.from(svg)).resize({width:320}).png().toFile(fileURLToPath(new URL(`representative-${theme}-320.png`,out)));
  for(const variant of ['now','next'] as const){const card=renderScheduleSvg(view,variant,theme,observedAt);writeFileSync(new URL(`representative-${variant}-${theme}.svg`,out),card);await sharp(Buffer.from(card)).resize({width:320}).png().toFile(fileURLToPath(new URL(`representative-${variant}-${theme}-320.png`,out)));}
  const svgPage=await browser.newPage();await svgPage.setContent(svg);
  const svgBounds=await svgPage.evaluate(()=>{const svg=document.querySelector('svg')!;const height=svg.viewBox.baseVal.height;return [...svg.querySelectorAll('text')].map(node=>{const b=node.getBBox();return {text:node.textContent,x:b.x,y:b.y,width:b.width,height:b.height};}).filter(b=>b.x<0||b.y<0||b.x+b.width>720||b.y+b.height>height);});
  if(svgBounds.length)throw Error('SVG_TEXT_OVERFLOW '+JSON.stringify(svgBounds));await svgPage.close();
  const scene=renderToStaticMarkup(React.createElement('div',{className:'pr-app '+(theme==='dark'?'pr-dark':''),'data-design':'district','data-motion':'off'},React.createElement('main',{className:'pr-main'},React.createElement(DistrictDashboard,{addresses,activeId:view.addressId,views,asOf:observedAt,day:'today',onSelect:noop,onCompare:noop,onManage:noop,onNotifications:noop,onShare:noop,onDay:noop,onAdd:noop}),React.createElement(SharedDayComparison,{addresses,activeId:view.addressId,views,asOf:observedAt,selectedIds:addresses.map(a=>a.id),onSelectedIds:noop,onFocus:noop,onNotifications:noop,onShare:noop}))));
  const html=`<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}body{background:${theme==='dark'?'#1e262f':'#f2f5f2'}}${css}</style>${scene}</html>`;writeFileSync(new URL(`representative-app-${theme}.html`,out),html);
  for(const width of [320,390,1280]){
   const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1});await page.route('**/*',route=>route.abort());await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
   const result=await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,comparisonNoticeCount:document.querySelectorAll('.pr-comparison .pr-source-notice').length,noticeCount:[...document.querySelectorAll('[role=note]')].filter(n=>n.textContent?.includes('Поточний аварійний стан')).length,overflow:[...document.querySelectorAll('.pr-source-notice')].some(n=>n.scrollWidth>n.clientWidth)}));
   if(result.scrollWidth>width||result.overflow||result.comparisonNoticeCount!==1||result.noticeCount!==2)throw Error('RENDER_OVERFLOW_OR_NOTICE_LOSS '+JSON.stringify(result));
   await page.screenshot({path:fileURLToPath(new URL(`representative-app-${theme}-${width}.png`,out)),fullPage:true});measurements.push({theme,width,...result});await page.close();
  }
  const detailsPage=await browser.newPage({viewport:{width:320,height:900},deviceScaleFactor:1});await detailsPage.route('**/*',route=>route.abort());
  const fixture=JSON.stringify({view,theme,asOf:observedAt}).replace(/</g,'\\u003c');
  await detailsPage.setContent(`<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}${css}</style><div id="detail-root"></div><script>window.NOTICE_FIXTURE=${fixture}</script><script>${detailBuild.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')}</script></html>`);
  await detailsPage.locator('.pr-district-interval').first().click();await detailsPage.locator('.pr-schedule-card figcaption summary').click();
  const selected=await detailsPage.locator('.pr-district-interval-detail').innerText(),fallback=await detailsPage.locator('.pr-schedule-card figcaption pre').innerText();
  if(!selected.includes('01:00–04:30 (UTC+02:00)')||!fallback.includes('UTC+02:00')||!fallback.includes('Час перегляду:')||fallback.includes('Час у прикладі:'))throw Error('HYDRATED_TIME_LABEL_MISMATCH');
  const widths=await detailsPage.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth}));if(widths.scrollWidth>320)throw Error('HYDRATED_DETAILS_OVERFLOW');
  await detailsPage.evaluate(()=>document.fonts.ready);await detailsPage.screenshot({path:fileURLToPath(new URL(`representative-details-${theme}-320.png`,out)),fullPage:true});detailMeasurements.push({theme,width:320,selected,fallbackContainsActualKyivOffset:true,viewingTimeLabel:true,interactions:['select exact first interval','expand card full fallback text'],...widths});await detailsPage.close();
 }
}finally{await browser.close();}
writeFileSync(new URL('render-observations.json',out),JSON.stringify({actor:'/root/app_experience',method:'Current stored public raw→scoped source intake→normalized view→actual text/SVG/sharpPNG + ChromeSSR and hydrated interval/card details; no HTTP; no whole-app/native-device claim',observedSourceAt:observedAt,rawSha256:createHash('sha256').update(raw).digest('hex'),measurements,detailMeasurements},null,2)+'\n');console.log(JSON.stringify({rendered:measurements.length,hydratedDetails:detailMeasurements.length,notices:'one per relevant scope in comparison',network:'none'}));
