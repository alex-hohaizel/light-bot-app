'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function exact(name,expected){const bytes=fs.readFileSync(path.join(__dirname,name));if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('LBA_OBSERVATION_WRAPPER_DRIFT');}
async function main(){
 exact('runtime-lock-observation.cjs','73d0456912397d95da7f568601a09f22f00d82c09b8bcdad2e82e66e79ceabcf');
 exact('activate.cjs','d2029d1e30010eb78ef14c47d5cdb75f45cdf1addfc4a3a52add36a8c6637c95');
 if(process.argv.length===3&&process.argv[2]==='--verify'){require('./runtime-lock-observation.cjs').verify();require('./activate.cjs');return;}
 if(process.argv.length!==2)throw Error('LBA_OBSERVATION_WRAPPER_ARGUMENTS');
 try{console.log('LBA_RUNTIME_LOCK_OBSERVATION '+JSON.stringify(await require('./runtime-lock-observation.cjs').observe()));}
 catch{console.log('LBA_RUNTIME_LOCK_OBSERVATION_UNCONFIRMED');}
 require('./activate.cjs');
}
void main().catch(()=>{console.error('LBA_OBSERVATION_WRAPPER_FAILED');process.exitCode=1;});
