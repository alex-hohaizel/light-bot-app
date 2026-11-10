'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SOURCE='768f1d605d91d6b917691d1bb9aa9d83d24ac17c3dc15d50127c0939f1476126';
const EXPECTED_OPERATOR='7c37d28ec9fb1eacaec3219bc6695ca1fbb55c4a06a8121e0d11c55eaa72f60f';
function exact(name,expected){if(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')!==expected)throw Error('LBA_NOTICE_RESUME_WRAPPER_DRIFT');}
function productionGuard(){
 exact('runtime-policy.cjs','e3119ba1b5c4648e42621148ccfc4f3af84799dad549c3f9e3a17ad9b7179575');
 exact('production-environment.cjs','302a2c28f5b8899c639d4648117a2274da3515504a963c71e3309474789b310d');
 if(process.env.NODE_ENV!=='production'||process.env.LBA_CANONICAL_CONTROL_EPOCH!=='1')throw Error('LBA_NOTICE_RESUME_AUTHORITY');
 let n;try{n=JSON.parse(process.env.LBA_RELEASE_NOTICE_CONFIG||'');}catch{throw Error('LBA_NOTICE_RESUME_AUTHORITY');}
 const keys=['kind','releaseId','deploymentRef','buildSha256','authoritySha256','createdAt','expiresAt','controlEpoch','pilotSize','maxAttempts'].sort().join('|');
 if(n===null||typeof n!=='object'||Array.isArray(n)||Object.getPrototypeOf(n)!==Object.prototype||Object.keys(n).sort().join('|')!==keys||n.kind!=='lba-release-notice/1'||n.releaseId!=='lba-v8-dispatch-768f1d60-20261110-r2'||n.deploymentRef!=='lba-release:dispatch-768f1d60-20261110-r2'||n.buildSha256!==SOURCE||n.authoritySha256!=='613b008586fe302bc4cbdd45d4f34ae2eb45d2c050ddbf4c459747ac22e5a2bc'||n.createdAt!=='2026-11-10T12:54:30.870Z'||n.expiresAt!=='2026-11-11T12:54:30.870Z'||n.controlEpoch!==1||n.pilotSize!==1||n.maxAttempts!==3)throw Error('LBA_NOTICE_RESUME_AUTHORITY');
 require('./production-environment.cjs').applyProductionEnvironmentDefaults();
 const policy=require('./runtime-policy.cjs').productionRuntimePolicy();
 if(policy.productProfileMode!=='active'||!policy.telegramDeliveryEnabled||!policy.telegramUpdatesEnabled)throw Error('LBA_NOTICE_RESUME_POLICY');
}
async function resume(operator){
 const deadline=Date.now()+90000;
 for(let attempt=1;attempt<=6;attempt++){
  try{const result=await operator.run({apply:true});console.log('LBA_NOTICE_PILOT_ADVANCE '+JSON.stringify(result));return;}
  catch(error){
   const code=typeof error?.message==='string'&&/^ADVANCE_[A-Z_]+$/.test(error.message)?error.message:'ADVANCE_UNCONFIRMED';
   if(!['ADVANCE_BUSY','ADVANCE_HEALTH'].includes(code)||attempt===6||Date.now()+2000>=deadline){console.error('LBA_NOTICE_PILOT_ADVANCE_FAILED '+code);return;}
   await new Promise(resolve=>setTimeout(resolve,2000));
  }
 }
}
async function main(){
 exact('advance-unreachable-pilot.cjs',EXPECTED_OPERATOR);
 exact('activate.cjs','d2029d1e30010eb78ef14c47d5cdb75f45cdf1addfc4a3a52add36a8c6637c95');
 const verified=require('./verify-prebuilt.cjs').verify();
 if(verified.sourceSha256!==SOURCE)throw Error('LBA_NOTICE_RESUME_SOURCE');
 const operator=require('./advance-unreachable-pilot.cjs');
 if(process.argv.length===3&&process.argv[2]==='--verify'){operator.verify();require('./activate.cjs');return;}
 if(process.argv.length!==2)throw Error('LBA_NOTICE_RESUME_ARGUMENTS');
 productionGuard();
 require('./activate.cjs');
 void resume(operator);
}
void main().catch(()=>{console.error('LBA_NOTICE_RESUME_WRAPPER_FAILED');process.exitCode=1;});
