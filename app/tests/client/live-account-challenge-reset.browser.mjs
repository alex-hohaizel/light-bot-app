import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const appRoot=path.resolve(import.meta.dirname,'../..'),project=path.dirname(appRoot),out=path.join(project,'docs/light-bot-app/release-v8/phase4/accounts-ui');
await mkdir(out,{recursive:true});const temp=await mkdtemp(path.join(tmpdir(),'lba-account-reset-'));
await build({entryPoints:[path.join(import.meta.dirname,'live-account-ui.fixture.tsx')],bundle:true,platform:'browser',format:'esm',jsx:'automatic',external:['/fonts/*'],outfile:path.join(temp,'bundle.js'),tsconfig:path.join(appRoot,'tsconfig.json'),logLevel:'silent'});
const sourcePins=await Promise.all(['client/src/product-review/LiveAccountSettings.tsx','client/src/product-runtime/LiveProduct.tsx','tests/client/live-account-challenge-reset.browser.mjs','tests/client/live-account-ui.fixture.tsx'].map(async file=>({path:'app/'+file,sha256:createHash('sha256').update(await readFile(path.join(appRoot,file))).digest('hex')})));
const OWNER='fixture-owner-a',SESSION='fixture-session-a',PENDING='lba:ux-a:draft:production-account-operation',CHALLENGE='lba:ux-a:draft:production-account-challenge';
const ORIGINAL='ACCOUNT_ORIGINAL_SESSION_REQUIRED',NOT_RECORDED='У цьому вході не знайдено підтвердження попередньої дії. Увійдіть у той самий акаунт.';
const request={id:'old-challenge-operation',expectedSessionId:SESSION,expectedRevision:7};
const operation={kind:'challenge',request};
const challenge={kind:'challenge',challengeId:'11111111-1111-4111-8111-111111111111',startParam:'acctlink_'+'a'.repeat(64),expiresAt:new Date(Date.now()+300000).toISOString(),miniAppUrl:null,state:'pending'};
const envelope=(payload,generation='original-generation')=>JSON.stringify({version:1,ownerId:OWNER,sessionId:SESSION,generation,payload});
const challengeDraft=envelope({request,challenge});
const calls=[];let responseStatus=409,responseCode=ORIGINAL;
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://127.0.0.1').pathname;
 if(['/fonts/onest.ttf','/fonts/manrope.ttf'].includes(pathname)){res.writeHead(200,{'Content-Type':'font/ttf'});res.end(await readFile(path.join(appRoot,'client/public',pathname)));return;}
 if(pathname==='/bundle.js'||pathname==='/bundle.css'){res.writeHead(200,{'Content-Type':pathname.endsWith('.css')?'text/css':'text/javascript'});res.end(await readFile(path.join(temp,pathname.slice(1))));return;}
 if(!pathname.startsWith('/api/')){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>');return;}
 let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;calls.push({method:req.method,path:pathname,body});
 if(pathname==='/api/auth/user')return json(res,401,{code:'AUTH_REQUIRED'});
 if(pathname==='/api/product/accounts')return json(res,200,{links:[{id:'own-replit',provider:'replit',linkRevision:'b'.repeat(64)}],authEpoch:1});
 if(pathname==='/api/product/accounts/recover')return json(res,responseStatus,responseStatus===200?{kind:'recovery',state:'not_recorded'}:{code:responseCode});
 if(pathname==='/api/product/accounts/telegram/challenge')return json(res,200,challenge);
 return json(res,404,{});
});
await new Promise((resolve,reject)=>server.listen(55485,'127.0.0.1',resolve).once('error',reject));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const checks=[],errors=[];let context,page;
const api=pathname=>calls.filter(c=>c.path===pathname);
async function open(mode='normal',pending=operation,status=409){
 await context?.close();context=await browser.newContext({viewport:{width:390,height:900}});calls.length=0;responseStatus=status;responseCode=ORIGINAL;
 await context.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:55485'?route.continue():route.abort());
 await context.addInitScript(({pendingRaw,challengeRaw,PENDING,CHALLENGE})=>{sessionStorage.setItem(PENDING,pendingRaw);if(challengeRaw)sessionStorage.setItem(CHALLENGE,challengeRaw);},{pendingRaw:envelope(pending),challengeRaw:pending.kind==='challenge'?challengeDraft:null,PENDING,CHALLENGE});
 page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:55485/'+(mode==='recovery'?'?normal=1':''),{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Перевірити результат',exact:true}).waitFor();return page;
}
const stored=()=>page.evaluate(({PENDING,CHALLENGE})=>({pending:sessionStorage.getItem(PENDING),challenge:sessionStorage.getItem(CHALLENGE)}),{PENDING,CHALLENGE});
const resetButton=()=>page.getByRole('button',{name:'Почати підтвердження заново',exact:true});
try{
 await open();await page.getByRole('button',{name:'Перевірити результат',exact:true}).click();await resetButton().waitFor();assert.deepEqual(await stored(),{pending:envelope(operation),challenge:challengeDraft});assert.deepEqual(api('/api/product/accounts/recover')[0].body,operation);assert.equal(api('/api/product/accounts/telegram/challenge').length,0);
 await page.evaluate(()=>window.renderAccountScope({ownerId:'fixture-owner-a',sessionId:'fixture-session-a',revision:8}));await resetButton().click();assert.deepEqual(await stored(),{pending:null,challenge:null});assert.equal(api('/api/product/accounts/telegram/challenge').length,0);await page.getByRole('button',{name:'Почати прив’язку Telegram',exact:true}).click();await page.getByText('Прив’язка Telegram зараз недоступна: підтверджене посилання Mini App ще не налаштовано. Спробуйте пізніше.',{exact:true}).waitFor();const fresh=api('/api/product/accounts/telegram/challenge')[0].body;assert.notEqual(fresh.id,request.id);assert.equal(fresh.expectedRevision,8);assert.equal(fresh.expectedSessionId,SESSION);checks.push('normal exact409 challenge reset is explicit local-only, clears only old fenced slots, then a separate fresh command uses new ID/current CAS');

 await open('recovery');await page.getByRole('button',{name:'Перевірити результат',exact:true}).click();await resetButton().waitFor();assert.deepEqual(await stored(),{pending:envelope(operation),challenge:challengeDraft});await resetButton().click();await page.getByTestId('button-theme-toggle-login').waitFor();assert.deepEqual(await stored(),{pending:null,challenge:null});assert.deepEqual(calls.map(c=>c.path),['/api/auth/user','/api/product/accounts/recover']);checks.push('RecoveryOnly exact409 challenge reset clears exact local attempt and requires sign-in first without any fresh mutation or profile/account read');

 for(const mode of ['normal','recovery']){
  const link={kind:'link',request:{...request,challengeId:challenge.challengeId,confirmed:true}},unlink={kind:'unlink',request:{...request,linkId:'exact-link',linkRevision:'c'.repeat(64),confirmed:true}};
  for(const [pending,status] of [[operation,503],[link,409],[unlink,409]]){
   await open(mode,pending,status);const before=await stored();await page.getByRole('button',{name:'Перевірити результат',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await resetButton().count(),0);assert.deepEqual(await stored(),before);assert.equal(api('/api/product/accounts/recover').length,1);assert.equal(api('/api/product/accounts/telegram/challenge').length,0);if(status===503)assert.equal(await page.getByText('Це підтвердження можна відновити лише в початковому вході. Щоб продовжити, почніть підтвердження заново.',{exact:true}).count(),0);
  }
  await open(mode,operation,200);const before=await stored();await page.getByRole('button',{name:'Перевірити результат',exact:true}).click();await page.getByText(NOT_RECORDED,{exact:true}).waitFor();assert.deepEqual(await stored(),before);if(mode==='recovery')assert.equal(await page.getByRole('button',{name:'Повторити той самий запит',exact:true}).count(),0);else assert.equal(await page.getByRole('button',{name:'Повторити той самий запит',exact:true}).count(),1);
 }
 checks.push('both consumers retain unknown503 even with same code and every link/unlink409; scoped not_recorded copy never claims global nonexecution and RecoveryOnly never retries');

 for(const mode of ['normal','recovery']){
  await open(mode);await page.evaluate(({PENDING})=>sessionStorage.setItem(PENDING,'changed-private-hint-token'),{PENDING});await page.getByRole('button',{name:'Перевірити результат',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(api('/api/product/accounts/recover').length,0);assert.equal((await stored()).pending,'changed-private-hint-token');assert.equal((await stored()).challenge,challengeDraft);
  for(const key of [PENDING,CHALLENGE]){
   await open(mode);await page.getByRole('button',{name:'Перевірити результат',exact:true}).click();await resetButton().waitFor();const replacement=envelope(key===PENDING?operation:{request:{...request,id:'newer-challenge-id'},challenge},'newer-generation');await page.evaluate(({key,replacement})=>sessionStorage.setItem(key,replacement),{key,replacement});const before=await stored();await resetButton().click();await page.getByRole('alert').filter({hasText:'Збережена спроба змінилася.'}).waitFor();assert.deepEqual(await stored(),before);assert.equal(api('/api/product/accounts/recover').length,1);assert.equal(api('/api/product/accounts/telegram/challenge').length,0);
  }
 }
 checks.push('changed private pending token prevents recovery POST; changed pending or scoped challenge token after409 prevents all local clearing in both consumers');
 assert.deepEqual(errors,[]);const receipt={actor:'/root/account_ui',scope:'Bounded post-reauth challenge reset extension; previous author20 and independent11 receipts preserved at their original source pins',result:'PASS',environment:'Actual React code with isolated fake localhost HTTP/desktop Chrome only; no PG/provider/production',checks,pageErrors:errors,sourcePins};await writeFile(path.join(out,'author-reset-browser-results.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({result:'PASS',checks},null,2));
}catch(e){await writeFile(path.join(out,'author-reset-browser-failure.json'),JSON.stringify({error:String(e),checks,sourcePins,pageErrors:errors,calls,body:await page?.locator('body').innerText({timeout:1000}).catch(()=>null)},null,2)+'\n');throw e;}
finally{await context?.close();await browser.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
