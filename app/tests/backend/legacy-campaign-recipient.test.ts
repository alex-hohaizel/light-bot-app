import test from 'node:test';
import assert from 'node:assert/strict';
import {createLegacyCampaignRecipients,LEGACY_CAMPAIGN_BOT_ID,LEGACY_CAMPAIGN_RECIPIENT_SCHEMA_SQL} from '../../server/production/legacy-campaign-recipient.ts';
const options={expectedBotId:LEGACY_CAMPAIGN_BOT_ID,expectedControlEpoch:7,bindingKey:'synthetic-binding-key-with-at-least-32-bytes'};
test('legacy recipient construction/disabled ports are inert and schema contains no recipient/account seed',async()=>{
 let calls=0;const client={query:async()=>{calls++;throw Error('PRIVATE_DIAGNOSTIC');}};
 for(const enabled of [undefined,false]){const port=createLegacyCampaignRecipients({...options,enabled});assert.equal(calls,0);assert.equal(await port.prepare(client,null as any),null);assert.equal(await port.resolve(client,null as any),null);assert.equal(calls,0);}
 assert(!/\b(?:insert|update|delete|drop|alter)\b/i.test(LEGACY_CAMPAIGN_RECIPIENT_SCHEMA_SQL));
});
test('weak keys, unknown bot/epoch and malformed or account-shaped input fail before IO',async()=>{
 for(const extra of [{expectedBotId:'foreign'},{expectedControlEpoch:0},{bindingKey:'short'},{bindingKey:null},{enabled:'yes'}])assert.throws(()=>createLegacyCampaignRecipients({...options,...extra} as any),/LEGACY_CAMPAIGN_RECIPIENT_INVALID_OPTIONS/);
 const port=createLegacyCampaignRecipients({...options,enabled:true});let calls=0;const client={query:async()=>{calls++;throw Error('MUST_NOT_QUERY');}},now='2026-11-09T00:00:00Z',signal=new AbortController().signal;
 for(const input of [null,{}, {chatId:'-1',now,signal},{chatId:'700901',now:'invalid',signal},{chatId:'700901',now,signal,ownerId:'invented'},{chatId:'9007199254740991',now,signal}])assert.equal(await port.prepare(client,input as any),null);
 for(const recipientRef of ['owner:invented','legacy:bad','700901'])assert.equal(await port.resolve(client,{recipientRef,now,signal}),null);assert.equal(calls,0);
});
