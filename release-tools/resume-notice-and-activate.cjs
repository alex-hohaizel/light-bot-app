'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SOURCE='768f1d605d91d6b917691d1bb9aa9d83d24ac17c3dc15d50127c0939f1476126';
const EXPECTED_OPERATOR='d80886dd69f981c1dd676f06819e79b1de47eb5c162b01100269654ac20f68e2';
function exact(name,expected){if(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')!==expected)throw Error('LBA_NOTICE_RESUME_WRAPPER_DRIFT');}
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
 require('./activate.cjs');
 void resume(operator);
}
void main().catch(()=>{console.error('LBA_NOTICE_RESUME_WRAPPER_FAILED');process.exitCode=1;});
