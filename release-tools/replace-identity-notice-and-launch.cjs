'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SOURCE='9be789cb0afe4099a8bac4d19a728ea8290e4e146df5c23769f6554f79d6eb27';
const OPERATOR='6bd8916b069c25cd0d340036292ed1003d79c83568f228f728813c42932c8c42';
const NOTICE='lba-v8-notice-deadline-20261111-r4';
const OLD_SPEC='8a2e238cd3325cfe944ac9ee2f79935ab4f8b0818879cdff792a069fc25ab60f';
const AUDIENCE='4998040c6c58df6eab51402e72aa7b6fd34cd18879a81f4a349fdb80223a9a0b';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function check(ok,code){if(!ok)throw Error(code);}
async function main(){
 const app=require('./verify-prebuilt.cjs').verify();
 check(app.sourceSha256===SOURCE,'REPLACE_LAUNCH_SOURCE');
 check(sha(fs.readFileSync(path.join(__dirname,'replace-cancelled-identity-notice.cjs')))===OPERATOR,'REPLACE_LAUNCH_OPERATOR_DRIFT');
 check(sha(fs.readFileSync(path.join(__dirname,'launch.cjs')))==='0d052bc6564d80c0557b783b2f67ee1e197bdf6b4c99a9f40e2a01aeff7a84dd','REPLACE_LAUNCH_DRIFT');
 const operator=require('./replace-cancelled-identity-notice.cjs');
 if(process.argv.length===3&&process.argv[2]==='--verify'){
  operator.verify();
  console.log(JSON.stringify({kind:'lba-identity-replacement-launch-config/1',...app,operatorSha256:OPERATOR,noticeReleaseId:NOTICE,databaseConnected:false,providerCalls:0}));return;
 }
 check(process.argv.length===2,'REPLACE_LAUNCH_ARGUMENTS');
 try{
  const result=await operator.run(),c=result?.certificate;
  check(result?.kind==='lba-identity-cancelled-notice-replacement/1'&&['replaced','already_replaced'].includes(result.state)&&c?.newSourceSha256===SOURCE&&c.newReleaseId===NOTICE&&c.oldSpecHash===OLD_SPEC&&c.audienceDigest===AUDIENCE&&c.originalAudience===8&&c.pendingReplacement===7&&c.excludedForbidden===1&&c.nativeJobsRetired===1&&c.nativeAttemptsPreserved===1&&c.nativeMarks===0&&c.nativeReceipts===0&&hex(c.newSpecHash)&&hex(c.certificateSha256),'REPLACE_LAUNCH_RECEIPT_INVALID');
  console.log('LBA_NOTICE_REPLACEMENT '+JSON.stringify({state:result.state,noticeReleaseId:NOTICE,certificateSha256:c.certificateSha256,providerCalls:0}));
 }catch(error){
  // Keep the application available if proof is absent or commit remains uncertain.
  process.env.LBA_RELEASE_NOTICE_CONFIG='';
  const code=typeof error?.message==='string'&&/^(?:REPLACE|LBA_RUNTIME)_[A-Z_]+$/.test(error.message)?error.message:'REPLACE_UNCONFIRMED';
  console.error('LBA_NOTICE_REPLACEMENT_BLOCKED '+code);
 }
 require('./launch.cjs');
}
void main().catch(()=>{console.error('LBA_REPLACEMENT_LAUNCH_FAILED');process.exitCode=1;});
