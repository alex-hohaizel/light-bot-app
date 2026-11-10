import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalRuntime} from '../../server/production/canonical-runtime.ts';
import {productionRuntimePolicy} from '../../server/runtime-policy.ts';

function ports(now='2026-11-10T10:00:00Z') {
 let effects=0;
 const denied=()=>{effects++;throw new Error('UNEXPECTED_COMPOSITION_EFFECT');};
 const policy=productionRuntimePolicy({NODE_ENV:'production',DATABASE_URL:'postgresql://fixture_account:fixture_password@db.example.invalid/power_fixture',
  SESSION_SECRET:'session_fixture_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',JWT_SECRET:'jwt_fixture_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  TELEGRAM_BOT_TOKEN:'8577497098:fixture_provider_token_xxxxxxxxxxxxx',TELEGRAM_WEBHOOK_SECRET:'existing_provider_secret',
  LBA_PRODUCT_PROFILE_MODE:'active',LBA_AUTH_REPLAY_GUARD:'enabled',LBA_CANONICAL_CONTROL_EPOCH:'7',
  LBA_SOURCE_INGESTION:'enabled',LBA_TELEGRAM_DELIVERY:'enabled',LBA_NOTIFICATION_SCHEDULER:'enabled'});
 return {input:{pool:{connect:async()=>denied()},policy,token:'8577497098:fixture_provider_token_xxxxxxxxxxxxx',origin:'https://power-ukraine.net',fetch:async()=>denied(),now:()=>Date.parse(now)} as any,effects:()=>effects};
}

test('first-release notification approval is explicit, source-bound and construction remains inert',()=>{
 for(const enabled of [undefined,false,true]) {
  const p=ports(),runtime=createCanonicalRuntime({...p.input,...(enabled===undefined?{}:{initialLaunchNotifications:enabled})});
  const health=runtime.health();
  assert.equal(health.scheduleCertification.initialLaunchNotifications,enabled===true);
  assert.equal(health.scheduleCertification.launchPolicyCurrent,enabled===true);
  assert.equal(health.scheduleCertification.admittedSources,0);
  assert.equal(health.notificationsReady,false,'workers cannot be ready before prepare/start');
  assert.equal(health.started,false);assert.equal(p.effects(),0);
 }
});
test('expired owner policy cannot report current launch admission and invalid composition flags fail closed',()=>{
 const p=ports('2026-12-11T10:00:00Z'),runtime=createCanonicalRuntime({...p.input,initialLaunchNotifications:true});
 assert.equal(runtime.health().scheduleCertification.launchPolicyCurrent,false);assert.equal(runtime.health().notificationsReady,false);
 assert.throws(()=>createCanonicalRuntime({...p.input,initialLaunchNotifications:'true'} as any),/CANONICAL_RUNTIME_CONFIGURATION/);
 assert.equal(p.effects(),0);
});
