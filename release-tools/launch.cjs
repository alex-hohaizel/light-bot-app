'use strict';
const path=require('node:path'),{verify}=require('./verify-prebuilt.cjs');
try{
 const result=verify();if(process.argv.length===3&&process.argv[2]==='--verify'){console.log(JSON.stringify(result));process.exit(0);}
 if(process.argv.length!==2)throw Error('RELEASE_ARGUMENTS_INVALID');
 if(!(/^[1-9][0-9]{0,15}$/).test(process.env.LBA_CANONICAL_CONTROL_EPOCH||''))throw Error('RELEASE_ACTIVATION_EPOCH_REQUIRED');
 require('./production-environment.cjs').applyProductionEnvironmentDefaults();
 if(process.env.NODE_ENV!=='production'||process.env.LBA_ISOLATED==='1'||process.env.LBA_DATA_MODE==='synthetic'||process.env.LBA_DB_DISPOSABLE==='1')throw Error('RELEASE_ENVIRONMENT_REJECTED');
 const app=path.resolve(__dirname,'../app');process.chdir(app);require(path.join(app,'dist-production/index.cjs'));
}catch(e){console.error(e.message);process.exitCode=1;}
