'use strict';
const path=require('node:path'),{verify}=require('./verify-prebuilt.cjs');
try{
 const result=verify();if(process.argv.length===3&&process.argv[2]==='--verify'){console.log(JSON.stringify(result));process.exit(0);}
 if(process.argv.length!==2)throw Error('RELEASE_ARGUMENTS_INVALID');
 if(!(/^[1-9][0-9]{0,15}$/).test(process.env.LBA_CANONICAL_CONTROL_EPOCH||''))throw Error('RELEASE_ACTIVATION_EPOCH_REQUIRED');
 const defaults={NODE_ENV:'production',LBA_PRODUCT_PROFILE_MODE:'active',LBA_AUTH_REPLAY_GUARD:'enabled',LBA_SOURCE_INGESTION:'enabled',LBA_ODESA_PLAN_API:'enabled',LBA_OPERATOR_ADDRESS_LOOKUP:'enabled',LBA_TELEGRAM_UPDATES:'enabled',LBA_TELEGRAM_DELIVERY:'enabled',LBA_NOTIFICATION_SCHEDULER:'enabled',LBA_ACCOUNT_LINKS:'enabled',LBA_RECONCILE_SUBSCRIBERS_ON_START:'disabled',LBA_MIGRATE_SUBSCRIBERS_ON_START:'disabled',LBA_INITIALIZE_SUBSCRIBER_HASHES_ON_START:'disabled'};
 for(const [k,v]of Object.entries(defaults))if(process.env[k]===undefined)process.env[k]=v;
 if(process.env.NODE_ENV!=='production'||process.env.LBA_ISOLATED==='1'||process.env.LBA_DATA_MODE==='synthetic'||process.env.LBA_DB_DISPOSABLE==='1')throw Error('RELEASE_ENVIRONMENT_REJECTED');
 const app=path.resolve(__dirname,'../app');process.chdir(app);require(path.join(app,'dist-production/index.cjs'));
}catch(e){console.error(e.message);process.exitCode=1;}
