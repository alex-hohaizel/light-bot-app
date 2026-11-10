'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {verify}=require('./verify-prebuilt.cjs');
const EXPECTED_SOURCE='768f1d605d91d6b917691d1bb9aa9d83d24ac17c3dc15d50127c0939f1476126';
const EXPECTED_OPERATOR='c170a127cc057466dedff8ca7542c946356a4da86a1a61576585273718b9a558';
const EXPECTED_POLICY='e3119ba1b5c4648e42621148ccfc4f3af84799dad549c3f9e3a17ad9b7179575';
const EXPECTED_ENVIRONMENT='302a2c28f5b8899c639d4648117a2274da3515504a963c71e3309474789b310d';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function check(ok,code){if(!ok)throw Error(code);}
async function main(){
 const verified=verify();check(verified.sourceSha256===EXPECTED_SOURCE,'ACTIVATION_SOURCE_MISMATCH');
 check(sha(fs.readFileSync(path.join(__dirname,'predecessor-no-effect.cjs')))===EXPECTED_OPERATOR,'ACTIVATION_OPERATOR_DRIFT');
 check(sha(fs.readFileSync(path.join(__dirname,'runtime-policy.cjs')))===EXPECTED_POLICY,'ACTIVATION_POLICY_DRIFT');
 check(sha(fs.readFileSync(path.join(__dirname,'production-environment.cjs')))===EXPECTED_ENVIRONMENT,'ACTIVATION_ENVIRONMENT_DRIFT');
 if(process.argv.length===3&&process.argv[2]==='--verify'){console.log(JSON.stringify({kind:'lba-reconciled-activation-config/1',...verified,databaseConnected:false,reconciled:false,sent:false}));return;}
 check(process.argv.length===2,'ACTIVATION_ARGUMENTS_INVALID');
 check(process.env.NODE_ENV==='production'&&process.env.LBA_CANONICAL_CONTROL_EPOCH==='1','ACTIVATION_ENVIRONMENT_INVALID');
 let n;try{n=JSON.parse(process.env.LBA_RELEASE_NOTICE_CONFIG||'');}catch{throw Error('ACTIVATION_NOTICE_INVALID');}
 const keys=['kind','releaseId','deploymentRef','buildSha256','authoritySha256','createdAt','expiresAt','controlEpoch','pilotSize','maxAttempts'].sort().join('|');
 check(n!==null&&typeof n==='object'&&!Array.isArray(n)&&Object.getPrototypeOf(n)===Object.prototype&&Object.keys(n).sort().join('|')===keys,'ACTIVATION_NOTICE_INVALID');
 check(n.kind==='lba-release-notice/1'&&n.releaseId==='lba-v8-dispatch-768f1d60-20261110-r2'&&n.deploymentRef==='lba-release:dispatch-768f1d60-20261110-r2'&&n.buildSha256===EXPECTED_SOURCE&&n.authoritySha256==='613b008586fe302bc4cbdd45d4f34ae2eb45d2c050ddbf4c459747ac22e5a2bc'&&n.controlEpoch===1&&n.pilotSize===1&&n.maxAttempts===3&&n.createdAt==='2026-11-10T12:54:30.870Z'&&n.expiresAt==='2026-11-11T12:54:30.870Z','ACTIVATION_NOTICE_MISMATCH');
 require('./production-environment.cjs').applyProductionEnvironmentDefaults();
 const policy=require('./runtime-policy.cjs').productionRuntimePolicy();
 check(policy.productProfileMode==='active'&&policy.telegramDeliveryEnabled&&policy.telegramUpdatesEnabled,'ACTIVATION_DELIVERY_POLICY_INVALID');
 await require('./predecessor-no-effect.cjs').runPredecessorReconciliation(EXPECTED_SOURCE);
 console.log('LBA_PREDECESSOR_RECONCILIATION_VERIFIED');
 require('./launch.cjs');
}
void main().catch(error=>{const message=typeof error?.message==='string'&&/^(?:ACTIVATION|PROVEN_UNISSUED|CAMPAIGN|RELEASE|LBA_RUNTIME)_[A-Z_]+$/.test(error.message)?error.message:'ACTIVATION_UNCONFIRMED';console.error(message);process.exitCode=1;});
