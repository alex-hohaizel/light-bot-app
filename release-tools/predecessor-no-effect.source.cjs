'use strict';
// Producer for the bundled operator helper. Not an App/provider entry point.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {reconcileCampaignProvenUnissued}=require('../app/server/release/update-campaign-pg.ts');
const APP=path.resolve(__dirname,'../app'),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
class OperatorError extends Error{}
const check=(ok,code)=>{if(!ok)throw new OperatorError(code);};
async function runPredecessorReconciliation(expected){
 let pool;
 try{
  check(hex(expected),'PROVEN_UNISSUED_ARGUMENTS');
  check(process.versions.node.split('.')[0]==='20','PROVEN_UNISSUED_NODE20_REQUIRED');
  const verified=createRequire(__filename)('./verify-prebuilt.cjs').verify();
  check(verified.sourceSha256===expected&&expected!=='ab0a12bc69fe45961941367d8263ae40e89e9cb8330c24b419e276abd08f65fc','PROVEN_UNISSUED_BUILD_MISMATCH');
  const bytes=fs.readFileSync(path.join(APP,'dist-production/build-receipt.json'));
  check(JSON.parse(bytes).sourceSha256===expected,'PROVEN_UNISSUED_RECEIPT_DRIFT');
  check(typeof process.env.DATABASE_URL==='string'&&process.env.DATABASE_URL.length>0,'PROVEN_UNISSUED_DATABASE_CONFIG');
  const {Pool}=createRequire(path.join(APP,'package.json'))('pg');
  pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000});pool.on('error',()=>{});
  const result=await reconcileCampaignProvenUnissued(pool,{
   binding:{releaseId:'lba-v8-font-ab0a12bc-20261110',deploymentId:'lba-release:font-ab0a12bc-20261110',buildSha256:'ab0a12bc69fe45961941367d8263ae40e89e9cb8330c24b419e276abd08f65fc',botId:'8577497098',origin:'https://power-ukraine.net'},
   controlEpoch:1,audienceSize:8,predecessorSenderSha256:'8c8a1aa2817726d491184cece61183b600d3c2014f08870d8faac0c635bcf51f',operatorCodeSha256:sha(fs.readFileSync(__filename))
  });
  const receipt={kind:'lba-predecessor-proven-unissued/1',newSourceSha256:expected,buildReceiptSha256:sha(bytes),...result,
   scope:'One proven-unissued campaign metadata resolution; no provider call, old spec/history/full recipients/profile/schema unchanged.'};
  console.log(JSON.stringify(receipt));return receipt;
 }finally{if(pool)await pool.end();}
}
async function main(){
 try{
  if(process.argv.length===3&&process.argv[2]==='--verify'){
   const verified=createRequire(__filename)('./verify-prebuilt.cjs').verify();
   console.log(JSON.stringify({kind:'lba-predecessor-proven-unissued-config/1',...verified,databaseConnected:false,reconciled:false,sent:false}));return;
  }
  check(process.argv.length===4&&process.argv[2]==='--expected-source','PROVEN_UNISSUED_ARGUMENTS');
  await runPredecessorReconciliation(process.argv[3]);
 }catch(error){
  const code=typeof error?.message==='string'&&/^(?:PROVEN_UNISSUED|CAMPAIGN)_[A-Z_]+$/.test(error.message)?error.message:'PROVEN_UNISSUED_UNCONFIRMED';
  console.error(JSON.stringify({kind:'lba-predecessor-proven-unissued/1',success:false,code}));process.exitCode=1;
 }
}
module.exports={runPredecessorReconciliation,main};
if(require.main===module)void main();
