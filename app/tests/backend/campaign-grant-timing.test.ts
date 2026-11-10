import test from 'node:test';
import assert from 'node:assert/strict';
import {createLegacyCampaignRecipients,LEGACY_CAMPAIGN_BOT_ID as BOT} from '../../server/production/legacy-campaign-recipient.ts';
import {createSqlTelegramDispatchEligibility,telegramOwnerRecipientRef} from '../../server/production/telegram-dispatch-eligibility.ts';
import {prepareCampaignSpec,campaignSpecHash,campaignOperationId} from '../../server/release/update-campaign.ts';
const base=Date.parse('2026-11-10T12:00:00Z'),key='synthetic-binding-key-with-at-least-32-bytes';
async function fixture(delay=150){
 let clock=base,registry:any,leaseUntil=base+60000,enabled=true,reach:any[]=[],campaignRow:any,queries=0;
 const signal=new AbortController(),owner='synthetic-owner';
 const client={async query(sql:string,values:any[]=[]){queries++;clock+=delay;let rows:any[]=[];
  if(sql.includes('lba_release_campaigns c join'))rows=campaignRow?[campaignRow]:[];
  else if(sql.includes('pg_advisory_xact_lock')&&sql.includes('txid_current'))rows=[{transaction_id:'1'}];
  else if(sql==='select txid_current()::text as transaction_id')rows=[{transaction_id:'1'}];
  else if(sql.includes('lba_production_control'))rows=[{control_epoch:'7',writer_mode:'canonical'}];
  else if(sql.includes('to_jsonb(s)::text'))rows=[{subscriber_chat_id:'700901',subscriber_owner_id:null,subscriber_enabled:enabled,subscriber_raw:'{"chat_id":"700901","enabled":true,"user_id":null}'}];
  else if(sql.includes('select user_id as "ownerId"'))rows=[{ownerId:owner}];
  else if(sql.includes('linked_accounts')||sql.includes('user_settings'))rows=[];
  else if(sql.startsWith('insert into lba_legacy_campaign_recipient')){registry={recipient_ref:values[0],bot_id:values[1],chat_id:values[2],control_epoch:String(values[3]),subscriber_digest:values[4],binding_revision:values[5],created_at:new Date(values[6]),revoked_at:null};rows=[registry];}
  else if(sql.startsWith('select chat_id from lba_legacy_campaign_recipient'))rows=registry?[{chat_id:registry.chat_id}]:[];
  else if(sql.startsWith('select * from lba_legacy_campaign_recipient'))rows=registry?[registry]:[];
  else if(sql.includes('lba_production_telegram_chat_state'))rows=reach;
  else throw Error('UNEXPECTED_FIXTURE_SQL');return {rows,rowCount:rows.length};},release(){}};
 const legacy=createLegacyCampaignRecipients({enabled:true,expectedBotId:BOT,expectedControlEpoch:7,bindingKey:key,now:()=>clock});
 const initial=await legacy.prepare(client,{chatId:'700901',now:new Date(clock).toISOString(),signal:signal.signal});assert.ok(initial);
 clock=base+10000;leaseUntil=clock+60000;
 function envelope(recipientRef=initial!.recipientRef){const releaseId='timing-fixture',spec=prepareCampaignSpec({releaseId,deploymentId:'fixture-deployment',buildSha256:'a'.repeat(64),botId:BOT,origin:'https://example.invalid',text:'Fixture update.',appUrl:'https://example.invalid/',createdAt:new Date(base).toISOString(),expiresAt:new Date(base+120000).toISOString(),pilotRecipientRefs:[recipientRef],maxAttempts:3},[recipientRef]);const operationId=campaignOperationId(releaseId,recipientRef),specHash=campaignSpecHash(spec);campaignRow={specHash,campaign:{spec,specHash,phase:'pilot'},job:{operationId,recipientRef,releaseId,botId:BOT,cohort:'pilot',state:'dispatching',leaseUntil:new Date(leaseUntil).toISOString()}};return {...spec,operationId,recipientRef};}
 return {client,legacy,envelope,signal,clock:()=>clock,setLease:(v:number)=>{leaseUntil=v;},setEnabled:(v:boolean)=>{enabled=v;},setReach:(v:any[])=>{reach=v;},queries:()=>queries,owner};
}
test('legacy grant starts after all locked SQL reads, not before their latency',async()=>{
 const f=await fixture(),e=f.envelope(),start=f.clock(),q=f.queries(),port=createSqlTelegramDispatchEligibility({expectedBotId:BOT,expectedControlEpoch:7,legacyRecipients:f.legacy,now:f.clock});
 const grant=await port.resolveLegacyCampaignRecipient!({client:f.client,envelope:e,now:new Date(start).toISOString(),signal:f.signal.signal});assert.ok(grant);assert.ok(f.clock()-start>=1000);assert.equal(f.queries()-q,10);assert.ok(Date.parse(grant.expiresAt)>f.clock());assert.ok(Date.parse(grant.expiresAt)<=f.clock()+1000);
});
test('elapsed absolute campaign lease cannot be renewed by fresh subject issuance',async()=>{
 const f=await fixture();f.setLease(f.clock()+800);const e=f.envelope(),port=createSqlTelegramDispatchEligibility({expectedBotId:BOT,expectedControlEpoch:7,legacyRecipients:f.legacy,now:f.clock});assert.equal(await port.resolveLegacyCampaignRecipient!({client:f.client,envelope:e,now:new Date(f.clock()).toISOString(),signal:f.signal.signal}),null);
});
test('account grant starts after owner lookup and retains the configured five-second cap',async()=>{
 const f=await fixture(800),e=f.envelope(telegramOwnerRecipientRef(f.owner)),port=createSqlTelegramDispatchEligibility({expectedBotId:BOT,expectedControlEpoch:7,grantTtlMs:5000,now:f.clock}),start=f.clock();
 const grant=await port.resolveCampaignOwner({client:f.client,envelope:e,now:new Date(start).toISOString(),signal:f.signal.signal});assert.ok(grant);assert.ok(f.clock()-start>=1000);assert.equal(Date.parse(grant.expiresAt)-f.clock(),5000);assert.throws(()=>createSqlTelegramDispatchEligibility({expectedBotId:BOT,expectedControlEpoch:7,grantTtlMs:5001,now:f.clock}));
});
test('backward clock and revoked subscription fail closed',async()=>{
 const f=await fixture(),e=f.envelope(),port=createSqlTelegramDispatchEligibility({expectedBotId:BOT,expectedControlEpoch:7,legacyRecipients:f.legacy,now:()=>base-1});assert.equal(await port.resolveLegacyCampaignRecipient!({client:f.client,envelope:e,now:new Date(f.clock()).toISOString(),signal:f.signal.signal}),null);
 const g=await fixture();g.setEnabled(false);const q=createSqlTelegramDispatchEligibility({expectedBotId:BOT,expectedControlEpoch:7,legacyRecipients:g.legacy,now:g.clock});assert.equal(await q.resolveLegacyCampaignRecipient!({client:g.client,envelope:g.envelope(),now:new Date(g.clock()).toISOString(),signal:g.signal.signal}),null);
});
test('physical chat ownership is checked before issuance and cannot adopt an account endpoint',async()=>{
 const f=await fixture();f.setReach([{ownerId:'foreign',recipientKind:'account',reachability:'reachable'}]);const port=createSqlTelegramDispatchEligibility({expectedBotId:BOT,expectedControlEpoch:7,legacyRecipients:f.legacy,now:f.clock});assert.equal(await port.resolveLegacyCampaignRecipient!({client:f.client,envelope:f.envelope(),now:new Date(f.clock()).toISOString(),signal:f.signal.signal}),null);
});
