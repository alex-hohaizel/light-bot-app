'use strict';
const DEFAULTS=Object.freeze({NODE_ENV:'production',LBA_PRODUCT_PROFILE_MODE:'active',LBA_AUTH_REPLAY_GUARD:'enabled',LBA_SOURCE_INGESTION:'enabled',LBA_ODESA_PLAN_API:'enabled',LBA_OPERATOR_ADDRESS_LOOKUP:'enabled',LBA_TELEGRAM_UPDATES:'enabled',LBA_TELEGRAM_DELIVERY:'enabled',LBA_NOTIFICATION_SCHEDULER:'enabled',LBA_ACCOUNT_LINKS:'enabled',LBA_RECONCILE_SUBSCRIBERS_ON_START:'disabled',LBA_MIGRATE_SUBSCRIBERS_ON_START:'disabled',LBA_INITIALIZE_SUBSCRIBER_HASHES_ON_START:'disabled'});
function applyProductionEnvironmentDefaults(){for(const[k,v]of Object.entries(DEFAULTS))if(process.env[k]===undefined)process.env[k]=v;}
module.exports={applyProductionEnvironmentDefaults};
