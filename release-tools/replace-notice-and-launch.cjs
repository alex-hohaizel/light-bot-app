'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SOURCE='fd4ebd4cb2e0a95defba674d7323b112bb7ae04fb5734bc0b2ac1741abb8daf9';
const OPERATOR='28d96d1118f3930483f1dc67fa6c61523d4ff5dcc1992d73919aed77735ed8ae';
const NOTICE='lba-v8-idle-fc244e31-20261111-r3';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function check(ok,code){if(!ok)throw Error(code);}
async function main(){
 const app=require('./verify-prebuilt.cjs').verify();
 check(app.sourceSha256===SOURCE,'REPLACE_LAUNCH_SOURCE');
 check(sha(fs.readFileSync(path.join(__dirname,'replace-unissued-notice.cjs')))===OPERATOR,'REPLACE_LAUNCH_OPERATOR_DRIFT');
 check(sha(fs.readFileSync(path.join(__dirname,'launch.cjs')))==='0d052bc6564d80c0557b783b2f67ee1e197bdf6b4c99a9f40e2a01aeff7a84dd','REPLACE_LAUNCH_DRIFT');
 const operator=require('./replace-unissued-notice.cjs');
 if(process.argv.length===3&&process.argv[2]==='--verify'){
  operator.verify();console.log(JSON.stringify({kind:'lba-replacement-notice-launch-config/1',...app,operatorSha256:OPERATOR,noticeReleaseId:NOTICE,databaseConnected:false,providerCalls:0}));return;
 }
 check(process.argv.length===2,'REPLACE_LAUNCH_ARGUMENTS');
 try{
  const result=await operator.run();
  const certificate=result?.certificate;
  check(result?.kind==='lba-unissued-notice-replacement/1'&&['replaced','already_replaced'].includes(result.state)&&certificate?.newSourceSha256===SOURCE&&certificate.newReleaseId===NOTICE&&certificate.originalAudience===8&&certificate.pendingReplacement===7&&certificate.excludedForbidden===1&&certificate.nativeJobs===0&&certificate.nativeAttempts===0&&/^[a-f0-9]{64}$/.test(certificate.certificateSha256||''),'REPLACE_LAUNCH_RECEIPT_INVALID');
  console.log('LBA_NOTICE_REPLACEMENT '+JSON.stringify({state:result.state,noticeReleaseId:NOTICE,certificateSha256:certificate.certificateSha256,providerCalls:0}));
 }catch(error){
  // A missing or unconfirmed proof must not activate a replacement campaign.
  process.env.LBA_RELEASE_NOTICE_CONFIG='';
  const code=typeof error?.message==='string'&&/^(?:REPLACE|LBA_RUNTIME)_[A-Z_]+$/.test(error.message)?error.message:'REPLACE_UNCONFIRMED';
  console.error('LBA_NOTICE_REPLACEMENT_BLOCKED '+code);
 }
 require('./launch.cjs');
}
void main().catch(()=>{console.error('LBA_REPLACEMENT_LAUNCH_FAILED');process.exitCode=1;});
