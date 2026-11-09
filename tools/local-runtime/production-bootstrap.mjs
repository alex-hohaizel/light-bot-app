import {createRequire} from 'node:module';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,chmod,rename,rm,access,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {productionConnection,classifyDumpFailure} from './production-backup.mjs';
import {CANONICAL_SCHEMA_SHA256,CANONICAL_REQUIRED_RELATIONS} from '../../app/server/production/canonical-schema.ts';
import {createProductionProfileStore} from '../../app/server/production/profile-store.ts';
import {selectVerifiedLegacySubscriberMappings} from '../../app/server/production/legacy-identity-links.ts';
import {selectLegacyLiveProfileInTransaction} from '../../app/server/production/profile-reader.ts';
import {verifyRuntimeEmptyAccount} from '../../app/server/production/runtime-identity.ts';
import {createBotState} from '../../app/shared/bot/engine.ts';
import {restoreBotState} from '../../app/shared/bot/engine.ts';
import {dispatchBotLockKey} from '../../app/server/production/telegram-dispatch.ts';

const ROOT=path.resolve(import.meta.dirname,'../..');
const require=createRequire(path.join(ROOT,'app/package.json')),{Client}=require('pg');
export const BOOTSTRAP_SCHEMA='3dab788973ff187b372683c0def227da51fd091c2cba94e5ecda04154029e2ce';
export const BOOTSTRAP_IDENTITY=Object.freeze({projectId:'g-p-6aee37634784819189b085127be2946b',replId:'6cdd42ed-6051-42d1-bea6-d73e9f98682d',botId:'8577497098',domain:'power-ukraine.net',oldDeploymentId:'e214ddd5-f6c3-4834-a5d8-2fd29d64a979'});
const LEGACY=['compare_shares','linked_accounts','power_reports','sessions','telegram_subscribers','user_locations','user_settings','users','weekly_digests'];
const CORE=new Set(['lba_production_control','lba_production_telegram_bot_state','lba_production_profiles','lba_production_profile_origins','lba_production_bootstrap_ledger']);
const HOLD='bootstrap_operator_pending';
const CA='/opt/homebrew/etc/ca-certificates/cert.pem';
const BASE=path.join(ROOT,'.local/light-bot-app/production-bootstrap');
const CONTRACT=path.join(ROOT,'docs/light-bot-app/release-v8/phase4/production-release-20261109/bootstrap-operator/expected-canonical-schema.json');
const EXPECTED_CONTRACT_SHA='11a3c8de2fda470f4f4873a89e7579490c33d545055aabfbcf72ea1500c04920';
const NATIVE_SCHEMA_FILE=path.join(ROOT,'docs/light-bot-app/release-v8/phase4/production-release-20261109/native-schema-peer/native-preview-fixed.sql');
export const BOOTSTRAP_NATIVE_SQL_SHA256='44fc2c6935c6d73325309431303bbd1b2700d9817c55320b95b7ef588a451112';
const authorities=new WeakSet();
const KNOWN_CODES=new Set(["BOOTSTRAP_ACCOUNT_COMMIT_UNKNOWN","BOOTSTRAP_ACCOUNT_MISMATCH","BOOTSTRAP_ACTIVATION_HEALTH_INVALID","BOOTSTRAP_ACTIVATION_PROOF_INVALID","BOOTSTRAP_ACTIVATION_PROVIDER_INVALID","BOOTSTRAP_ACTIVE_CORE_INVALID","BOOTSTRAP_ALREADY_FINALIZED","BOOTSTRAP_ALREADY_READY_FOR_ACTIVATION","BOOTSTRAP_ARGUMENTS_INVALID","BOOTSTRAP_AUTHORITY_REQUIRED","BOOTSTRAP_AUTH_FAILED","BOOTSTRAP_CANCELLED","BOOTSTRAP_CANONICAL_IN_USE","BOOTSTRAP_CANONICAL_OWNER_CONFLICT","BOOTSTRAP_CANONICAL_PROFILE_MISMATCH","BOOTSTRAP_CANONICAL_PROVENANCE_MISMATCH","BOOTSTRAP_COMPLETION_PROOF_INVALID","BOOTSTRAP_CONNECTION_INVALID","BOOTSTRAP_CONTROL_DRIFT","BOOTSTRAP_DEVELOPMENT_NOT_FENCED","BOOTSTRAP_DIRECT_TARGET_REQUIRED","BOOTSTRAP_EXPLICIT_SCHEMA_INSTALL_REQUIRED","BOOTSTRAP_FENCE_EVIDENCE_DRIFT","BOOTSTRAP_FENCE_INVALID","BOOTSTRAP_FINALIZED","BOOTSTRAP_FINALIZED_RECONCILED","BOOTSTRAP_FINALIZE_COMMIT_UNKNOWN","BOOTSTRAP_FINALIZE_NOT_COMMITTED","BOOTSTRAP_FINALIZE_OUTCOME_UNCONFIRMED","BOOTSTRAP_FINAL_DENOMINATOR_MISMATCH","BOOTSTRAP_FRESH_R1_REQUIRED","BOOTSTRAP_IMMUTABLE_PROVENANCE_CHANGED","BOOTSTRAP_INPUT_INVALID","BOOTSTRAP_INSTALLED_SCHEMA_MISMATCH","BOOTSTRAP_INSTALLED_STATE_DRIFT","BOOTSTRAP_LEGACY_DRIFT","BOOTSTRAP_LOCAL_TERMINAL_REQUIRED","BOOTSTRAP_NATIVE_SQL_DRIFT","BOOTSTRAP_OPERATOR_BUSY","BOOTSTRAP_OWNED_HOLD_REQUIRED","BOOTSTRAP_OWNER_PROJECTION_DRIFT","BOOTSTRAP_OWNER_RECONCILIATION_REQUIRED","BOOTSTRAP_OWNER_REGISTRY_DRIFT","BOOTSTRAP_OWNER_REGISTRY_INVALID","BOOTSTRAP_PARTIAL_CORE_CONFLICT","BOOTSTRAP_PARTIAL_OR_UNKNOWN_SCHEMA","BOOTSTRAP_PARTIAL_STATE_REQUIRES_JOURNAL","BOOTSTRAP_PERMISSION_DENIED","BOOTSTRAP_PG_DUMP_UNAVAILABLE","BOOTSTRAP_PLAN_FENCE_MISMATCH","BOOTSTRAP_PLAN_NOT_READ_ONLY","BOOTSTRAP_PLAN_RECORDED","BOOTSTRAP_PLAN_STALE_OR_INVALID","BOOTSTRAP_PREACTIVATION_DATA_DRIFT","BOOTSTRAP_PRIVATE_DIRECTORY_UNSAFE","BOOTSTRAP_PRIVATE_FILE_UNAVAILABLE","BOOTSTRAP_PRIVATE_KEY_INVALID","BOOTSTRAP_PRIVATE_PATH_REJECTED","BOOTSTRAP_PRIVATE_RECORD_INVALID","BOOTSTRAP_PRODUCTION_NOT_FENCED","BOOTSTRAP_R1_","BOOTSTRAP_R1_ARCHIVE_CHANGED","BOOTSTRAP_R1_ARCHIVE_INVALID","BOOTSTRAP_R1_ARCHIVE_LIST_FAILED","BOOTSTRAP_R1_ARCHIVE_TABLES_MISMATCH","BOOTSTRAP_R1_ARCHIVE_UNAVAILABLE","BOOTSTRAP_R1_ARCHIVE_UNSAFE","BOOTSTRAP_R1_CONNECTION_MISMATCH","BOOTSTRAP_R1_DUMP_AUTH_FAILED","BOOTSTRAP_R1_DUMP_CA_MISSING","BOOTSTRAP_R1_DUMP_CONNECTION_FAILED","BOOTSTRAP_R1_DUMP_EXEC_FAILED","BOOTSTRAP_R1_DUMP_FAILED","BOOTSTRAP_R1_DUMP_PERMISSION_DENIED","BOOTSTRAP_R1_DUMP_SNAPSHOT_REJECTED","BOOTSTRAP_R1_DUMP_TIMEOUT","BOOTSTRAP_R1_DUMP_TLS_FAILED","BOOTSTRAP_R1_DUMP_VERSION_MISMATCH","BOOTSTRAP_R1_NATIVE_TOOL_REQUIRED","BOOTSTRAP_R1_NOT_READ_ONLY","BOOTSTRAP_R1_OUTPUT_EXISTS","BOOTSTRAP_R1_OUTPUT_SCOPE_REJECTED","BOOTSTRAP_R1_SNAPSHOT_INVALID","BOOTSTRAP_R1_TLS_REQUIRED","BOOTSTRAP_R1_UNSUPPORTED_OPTIONS","BOOTSTRAP_READY_COMMIT_UNKNOWN","BOOTSTRAP_READY_FOR_ACTIVATION","BOOTSTRAP_READY_NOT_COMMITTED","BOOTSTRAP_READY_OUTCOME_UNCONFIRMED","BOOTSTRAP_READY_RECONCILED","BOOTSTRAP_RESUME_JOURNAL_DRIFT","BOOTSTRAP_RESUME_SOURCE_MISMATCH","BOOTSTRAP_ROW_LIMIT","BOOTSTRAP_SCHEMA_CONTRACT_DRIFT","BOOTSTRAP_SENDER_BUSY","BOOTSTRAP_SOURCE_BUILD_DRIFT","BOOTSTRAP_SOURCE_SCHEMA_DRIFT","BOOTSTRAP_SSL_CA_UNAVAILABLE","BOOTSTRAP_TABLE_SET_MISMATCH","BOOTSTRAP_TEST_HOOK_REJECTED","BOOTSTRAP_TEST_TARGET_REJECTED","BOOTSTRAP_TIMEOUT","BOOTSTRAP_TLS_FAILED","BOOTSTRAP_UNCONFIRMED","BOOTSTRAP_UNEXPECTED_EFFECT_ROWS","BOOTSTRAP_UNEXPECTED_SCHEMA_HOOK","BOOTSTRAP_UNKNOWN_NATIVE_EFFECT","BOOTSTRAP_VERIFIED_HELD","BOOTSTRAP_WRONG_OPERATION_AUTHORITY"]);
const freshR1Capabilities=new WeakMap();
export const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
export const digest=value=>createHash('sha256').update(value).digest('hex');
const mac=(key,value)=>createHmac('sha256',key).update(typeof value==='string'?value:canonical(value)).digest('hex');
const quoted=value=>'"'+value.replaceAll('"','""')+'"';
const fail=code=>{throw Error(code);};
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const instant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT.*Z$/.test(value)&&Number.isFinite(Date.parse(value));
const nowIso=()=>new Date().toISOString();
function fresh(value,now,window=300000){return instant(value)&&Date.parse(value)<=now+5000&&now-Date.parse(value)<=window;}
function payload(value){const {signature,...rest}=value;return rest;}
export function signPrivate(key,value){return {...value,signature:mac(key,value)};}
export function verifyPrivate(key,value,kind){if(!value||value.kind!==kind||!hex(value.signature)||mac(key,payload(value))!==value.signature)fail('BOOTSTRAP_PRIVATE_RECORD_INVALID');return payload(value);}
export async function writePrivateAtomic(file,value){
 const directory=path.dirname(file),temporary=path.join(directory,'.bootstrap-'+randomBytes(16).toString('hex')+'.tmp');
 try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,file);}finally{await rm(temporary,{force:true}).catch(()=>{});}
}
async function safePrivateFile(file,project=ROOT,maxBytes=4*1024*1024){
 const absolute=path.resolve(file);if(!absolute.startsWith(path.join(project,'.local')+path.sep))fail('BOOTSTRAP_PRIVATE_PATH_REJECTED');
 const relative=path.relative(project,absolute).split(path.sep);let current=project;
 for(let i=0;i<relative.length;i++){current=path.join(current,relative[i]);const stat=await lstat(current).catch(()=>fail('BOOTSTRAP_PRIVATE_FILE_UNAVAILABLE'));
  if(stat.isSymbolicLink()||stat.uid!==process.getuid()||i<relative.length-1&&!stat.isDirectory()||i===relative.length-1&&!stat.isFile()||(stat.mode&0o022)!==0)fail('BOOTSTRAP_PRIVATE_PATH_REJECTED');}
 const stat=await lstat(absolute);if((stat.mode&0o077)!==0||stat.size>maxBytes)fail('BOOTSTRAP_PRIVATE_PATH_REJECTED');return absolute;
}
async function setupPrivate(){
 for(const folder of [path.join(ROOT,'.local'),path.join(ROOT,'.local/light-bot-app'),BASE,path.join(BASE,'operations'),path.join(BASE,'backups')]){
  try{await mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=await lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o022)!==0)fail('BOOTSTRAP_PRIVATE_DIRECTORY_UNSAFE');await chmod(folder,0o700);
 }
 const keyDirectory=path.join(ROOT,'.local/light-bot-app/production-release-preflight');
 try{await mkdir(keyDirectory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 const ds=await lstat(keyDirectory);if(!ds.isDirectory()||ds.isSymbolicLink()||ds.uid!==process.getuid()||(ds.mode&0o077)!==0)fail('BOOTSTRAP_PRIVATE_DIRECTORY_UNSAFE');
 const file=path.join(keyDirectory,'identity-hmac.key');try{await writeFile(file,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
 await safePrivateFile(file);const key=await readFile(file);if(key.length!==32)fail('BOOTSTRAP_PRIVATE_KEY_INVALID');return key;
}
export async function verifyCurrentSource(){
 if(CANONICAL_SCHEMA_SHA256!==BOOTSTRAP_SCHEMA)fail('BOOTSTRAP_SOURCE_SCHEMA_DRIFT');
 const receiptBytes=await readFile(path.join(ROOT,'app/dist-production/build-receipt.json')),receipt=JSON.parse(receiptBytes);
 if(!hex(receipt.sourceSha256)||!receipt.sourceUnchanged||!Array.isArray(receipt.sourceBefore)||receipt.sourceBefore.length<100||receipt.sourceBefore.length>2000||canonical(receipt.sourceBefore)!==canonical(receipt.sourceAfter))fail('BOOTSTRAP_SOURCE_BUILD_DRIFT');
 const app=path.join(ROOT,'app'),walk=async directory=>{const result=[];for(const item of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())result.push(...await walk(file));else if(item.isFile())result.push(file);else fail('BOOTSTRAP_SOURCE_BUILD_DRIFT');}return result;};
 const files=[...await walk(path.join(app,'server')),...await walk(path.join(app,'shared')),...await walk(path.join(app,'client')),...['script/build-production.ts','package-lock.json','package.json','tsconfig.json','.replit'].map(file=>path.join(app,file))].sort();
 const actual=await Promise.all(files.map(async file=>({path:path.relative(app,file),sha256:digest(await readFile(file))})));
 if(JSON.stringify(actual)!==JSON.stringify(receipt.sourceBefore)||digest(JSON.stringify(actual))!==receipt.sourceSha256)fail('BOOTSTRAP_SOURCE_BUILD_DRIFT');
 const raw=await readFile(CONTRACT);if(digest(raw)!==EXPECTED_CONTRACT_SHA)fail('BOOTSTRAP_SCHEMA_CONTRACT_DRIFT');
 const contract=JSON.parse(raw);if(contract.schemaSha256!==BOOTSTRAP_SCHEMA)fail('BOOTSTRAP_SCHEMA_CONTRACT_DRIFT');return {...contract,sourceSha256:receipt.sourceSha256,buildReceiptSha256:digest(receiptBytes)};
}
// Full semantic catalog, including FK actions, deferrability, CHECKs, defaults,
// partial indexes/opclasses/collations. Autogenerated object names are diagnostic.
export async function collectCanonicalCatalog(client){
 const names=[...CANONICAL_REQUIRED_RELATIONS];
 const tables=(await client.query("select c.relname as table_name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relreplident from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) order by c.relname",[names])).rows;
 const columns=(await client.query("select c.relname as table_name,a.attnum as position,a.attname as column_name,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,a.attidentity as identity,a.attgenerated as generated,pg_get_expr(d.adbin,d.adrelid,true) as default_expression,case when a.attcollation=0 then null else cn.nspname||'.'||co.collname end as collation from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum left join pg_collation co on co.oid=a.attcollation left join pg_namespace cn on cn.oid=co.collnamespace where n.nspname='public' and c.relname=any($1::text[]) and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum",[names])).rows;
 const rawConstraints=(await client.query("select c.relname as table_name,k.conname as constraint_name,k.contype as type,pg_get_constraintdef(k.oid,true) as definition,k.condeferrable as deferrable,k.condeferred as initially_deferred,k.convalidated as validated,k.connoinherit as no_inherit from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) order by c.relname,k.contype,k.conname",[names])).rows;
 const constraints=rawConstraints.map(({constraint_name,...row})=>row).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
 const rawIndexes=(await client.query("select c.relname as table_name,ic.relname as index_name,am.amname as method,i.indisunique as unique_index,i.indisprimary as primary_index,i.indisexclusion as exclusion_index,i.indisvalid as valid,i.indisready as ready,i.indislive as live,i.indnullsnotdistinct as nulls_not_distinct,i.indnkeyatts as key_attributes,i.indnatts as total_attributes,array(select pg_get_indexdef(i.indexrelid,s,false) from generate_series(1,i.indnatts) as s) as terms,pg_get_expr(i.indpred,i.indrelid,true) as predicate,pg_get_expr(i.indexprs,i.indrelid,true) as expressions,i.indoption::text as options,array(select ns.nspname||'.'||opc.opcname from unnest(i.indclass::oid[]) with ordinality a(oid,ord) join pg_opclass opc on opc.oid=a.oid join pg_namespace ns on ns.oid=opc.opcnamespace order by a.ord) as opclasses,array(select case when a.oid=0 then null else ns.nspname||'.'||co.collname end from unnest(i.indcollation::oid[]) with ordinality a(oid,ord) left join pg_collation co on co.oid=a.oid left join pg_namespace ns on ns.oid=co.collnamespace order by a.ord) as collations from pg_index i join pg_class c on c.oid=i.indrelid join pg_class ic on ic.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace join pg_am am on am.oid=ic.relam where n.nspname='public' and c.relname=any($1::text[]) order by c.relname,ic.relname",[names])).rows;
 const indexes=rawIndexes.map(({index_name,...row})=>row).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
 const requiredNamed=rawConstraints.filter(row=>['lba_dispatch_recipient_subject','lba_chat_recipient_subject'].includes(row.constraint_name)).map(row=>({table:row.table_name,name:row.constraint_name})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
 return {tables,columns,constraints,indexes,requiredNamed};
}
export async function assertSchema(client,expected){
 const pinned=await readFile(CONTRACT);if(digest(pinned)!==EXPECTED_CONTRACT_SHA||expected?.schemaSha256!==BOOTSTRAP_SCHEMA||!isDeepStrictEqual(expected.normalized,JSON.parse(pinned).normalized))fail('BOOTSTRAP_SCHEMA_CONTRACT_DRIFT');
 const actual=await collectCanonicalCatalog(client);if(!isDeepStrictEqual(actual,expected.normalized))fail('BOOTSTRAP_INSTALLED_SCHEMA_MISMATCH');
 const hooks=(await client.query("select (select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) and not t.tgisinternal) as triggers,(select count(*)::int from pg_rewrite r join pg_class c on c.oid=r.ev_class join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) and r.rulename<>'_RETURN') as rules,(select count(*)::int from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[])) as policies",[[...CANONICAL_REQUIRED_RELATIONS]])).rows[0];
 if(!hooks||hooks.triggers!==0||hooks.rules!==0||hooks.policies!==0)fail('BOOTSTRAP_UNEXPECTED_SCHEMA_HOOK');
 const publicTables=(await client.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name")).rows.map(row=>row.table_name);
 if(canonical(publicTables)!==canonical([...LEGACY,...CANONICAL_REQUIRED_RELATIONS].sort()))fail('BOOTSTRAP_TABLE_SET_MISMATCH');return digest(canonical(actual));
}
export async function inspectInstalledSchema(client,expected){
 const tables=(await client.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name")).rows.map(row=>row.table_name);
 if(canonical(tables)===canonical([...LEGACY].sort())){
  if((await client.query("select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and left(c.relname,4)='lba_' limit 1")).rows.length)fail('BOOTSTRAP_PARTIAL_OR_UNKNOWN_SCHEMA');
  return {state:'legacy_only',tables,schemaContractSha256:null};
 }
 if(canonical(tables)!==canonical([...LEGACY,...CANONICAL_REQUIRED_RELATIONS].sort()))fail('BOOTSTRAP_PARTIAL_OR_UNKNOWN_SCHEMA');
 return {state:'canonical_complete',tables,schemaContractSha256:await assertSchema(client,expected)};
}
export async function loadReviewedNativeSchema(file=NATIVE_SCHEMA_FILE){const bytes=await readFile(file);if(digest(bytes)!==BOOTSTRAP_NATIVE_SQL_SHA256)fail('BOOTSTRAP_NATIVE_SQL_DRIFT');return bytes.toString('utf8');}
export async function tableEvidence(client,names,key){
 let bytes=0;const result=[];
 for(const table of [...names].sort()){
  const selected=await client.query('select to_jsonb(t)::text as raw from public.'+quoted(table)+' t limit 200001');
  if(selected.rows.length>200000||selected.rows.some(row=>typeof row.raw!=='string'))fail('BOOTSTRAP_ROW_LIMIT');
  const rows=selected.rows.map(row=>row.raw).sort();bytes+=rows.reduce((n,s)=>n+Buffer.byteLength(s),0);if(bytes>128*1024*1024)fail('BOOTSTRAP_ROW_LIMIT');
  result.push({table,rows:rows.length,hmac:mac(key,rows.join('\n'))});
 }
 return result;
}
async function registry(client){
 const users=(await client.query('select id from users order by id limit 10001')).rows;
 if(!users.length||users.length>10000||users.some(row=>typeof row.id!=='string'||!row.id.trim()||row.id.length>255))fail('BOOTSTRAP_OWNER_REGISTRY_INVALID');
 return users.map(row=>row.id);
}
function isolatedSettingsReference(value){return value.completeness.ownerRows==='reconciled'&&value.counts.missingVerifiedMappings===0&&value.counts.unresolvedSettingsReferences===1&&value.blockers.length===1&&value.blockers[0].code==='LEGACY_READER_SETTINGS_TELEGRAM_MAPPING_UNVERIFIED'&&value.blockers[0].sourceRefs?.length===1&&value.blockers[0].sourceRefs[0]==='user_settings.telegram_chat_id';}
function acceptedLegacy(value){return value.projection.issues.length===0&&(value.status==='ready'&&value.blockers.length===0||isolatedSettingsReference(value));}
// This principal is server-verified migration ownership from the fenced users PK.
// It is never an assertion that the person performed a login or provider proof.
async function legacyOwner(client,owner,now){
 const principal={kind:'verified_server_principal',ownerId:owner,verified:true};
 const mappings=await selectVerifiedLegacySubscriberMappings(client,principal);
 const value=await selectLegacyLiveProfileInTransaction(client,principal,{verifiedSubscriberMappings:mappings,now:()=>now});
 if(!acceptedLegacy(value))fail('BOOTSTRAP_OWNER_RECONCILIATION_REQUIRED');return {principal,value,mappings};
}
async function server(client){
 const value=(await client.query("select current_setting('server_version_num')::int as version,pg_is_in_recovery() as replica,current_setting('transaction_read_only') as read_only,current_database() as database,inet_server_addr()::text as address,inet_server_port() as port")).rows[0];
 if(!value||value.replica!==false||!Number.isInteger(value.version))fail('BOOTSTRAP_DIRECT_TARGET_REQUIRED');return value;
}
export async function createReadOnlyPlan(client,{key,targetHmac,expected,sourceSha256=expected?.sourceSha256,now=nowIso(),resume=null,authority=null}){
 if(!Buffer.isBuffer(key)||key.length!==32||!hex(targetHmac)||!hex(sourceSha256)||!instant(now))fail('BOOTSTRAP_INPUT_INVALID');let tx=false;
 try{
  await client.query('begin isolation level repeatable read read only');tx=true;await client.query("set local statement_timeout='30s'");await client.query("set local lock_timeout='1s'");await client.query('set local search_path=pg_catalog,public');
  if(authority){await checkAuthority(client,authority,targetHmac,sourceSha256);if(authority.purpose!=='bootstrap')fail('BOOTSTRAP_WRONG_OPERATION_AUTHORITY');}
  const target=await server(client);if(target.read_only!=='on')fail('BOOTSTRAP_PLAN_NOT_READ_ONLY');const installed=await inspectInstalledSchema(client,expected),owners=await registry(client);
  const legacy=await tableEvidence(client,LEGACY,key),canonicalRows=installed.state==='canonical_complete'?await tableEvidence(client,CANONICAL_REQUIRED_RELATIONS,key):[],accounts=[];
  for(const owner of owners){const {value}=await legacyOwner(client,owner,now);accounts.push({ownerHmac:mac(key,owner),sourceDigest:value.sourceDigest,projectionDigest:value.projectionDigest,profileHmac:mac(key,value.projection.profile),addresses:value.projection.profile.locations.length,selectedSubscribers:value.counts.selectedSubscribers,settingsReferenceIsolated:value.blockers.length===1});}
  const nonCore=canonicalRows.filter(row=>!CORE.has(row.table)&&row.rows!==0);if(nonCore.length)fail('BOOTSTRAP_CANONICAL_IN_USE');
  if(canonicalRows.some(row=>row.rows!==0)&&!resume)fail('BOOTSTRAP_PARTIAL_STATE_REQUIRES_JOURNAL');
  if(resume&&(resume.targetHmac!==targetHmac||resume.sourceSha256!==sourceSha256||resume.schemaSha256!==BOOTSTRAP_SCHEMA||resume.legacyHmac!==mac(key,legacy)))fail('BOOTSTRAP_RESUME_SOURCE_MISMATCH');
  if(resume&&installed.state==='canonical_complete'){await holdState(client,resume.operationId,resume.controlEpoch,false);await validateCoreRows(client,owners,key,{accounts,controlEpoch:resume.controlEpoch});}
  await client.query('commit');tx=false;
  return signPrivate(key,{kind:'lba-core-bootstrap-plan/1',actor:'migration_operator',createdAt:now,sourceSha256,schemaSha256:BOOTSTRAP_SCHEMA,targetHmac,schemaState:installed.state,schemaContractSha256:installed.schemaContractSha256,nativeInstallSqlSha256:installed.state==='legacy_only'?BOOTSTRAP_NATIVE_SQL_SHA256:null,legacyHmac:mac(key,legacy),snapshotHmac:mac(key,[...legacy,...canonicalRows].sort((a,b)=>a.table.localeCompare(b.table))),legacy,canonicalRows,accounts,accountCount:owners.length,serverVersion:target.version,operationId:resume?.operationId??randomBytes(32).toString('hex'),resumeJournalSha256:resume?digest(canonical(resume)):null,expectedControlEpoch:resume?.controlEpoch??authority?.controlEpoch??null,readOnly:true,productionWrites:0,servingBindingProved:false,fenceProved:authority?.kind==='production_cutover',fenceSha256:authority?.fenceSha256??null});
 }finally{if(tx)await client.query('rollback').catch(()=>{});}
}
async function readObserved(file,pin,project){if(!hex(pin))fail('BOOTSTRAP_FENCE_INVALID');const p=await safePrivateFile(path.resolve(project,file),project),bytes=await readFile(p);if(digest(bytes)!==pin)fail('BOOTSTRAP_FENCE_EVIDENCE_DRIFT');return JSON.parse(bytes);}
export async function validateProductionFence(file,{targetHmac,sourceSha256,schemaSha256=BOOTSTRAP_SCHEMA,now=Date.now(),project=ROOT}={}){
 const p=await safePrivateFile(file,project),bytes=await readFile(p),fence=JSON.parse(bytes);
 if(fence.kind!=='lba-controlled-cutover-fence/1'||fence.outcome!=='confirmed'||!fresh(fence.observedAt,now)||fence.projectId!==BOOTSTRAP_IDENTITY.projectId||fence.replId!==BOOTSTRAP_IDENTITY.replId||fence.botId!==BOOTSTRAP_IDENTITY.botId||fence.domain!==BOOTSTRAP_IDENTITY.domain||fence.sourceSha256!==sourceSha256||!hex(sourceSha256)||fence.schemaSha256!==schemaSha256||schemaSha256!==BOOTSTRAP_SCHEMA||fence.targetHmac!==targetHmac||!Number.isSafeInteger(fence.controlEpoch)||fence.controlEpoch<1)fail('BOOTSTRAP_FENCE_INVALID');
 const provider=await readObserved(fence.providerReadback?.path,fence.providerReadback?.sha256,project),dev=await readObserved(fence.developmentReadback?.path,fence.developmentReadback?.sha256,project);
 const result=provider.result?.structuredContent;
 if(provider.kind!=='lba-provider-observation/1'||provider.tool!=='mcp__codex_apps__replit_get_publish_status'||provider.arguments?.replId!==BOOTSTRAP_IDENTITY.replId||!fresh(provider.observedAt,now)||!result||result.found!==true||result.status!=='suspended'||result.deploymentId!==BOOTSTRAP_IDENTITY.oldDeploymentId||result.url!=='https://'+BOOTSTRAP_IDENTITY.domain)fail('BOOTSTRAP_PRODUCTION_NOT_FENCED');
 if(dev.kind!=='lba-development-writer-observation/1'||dev.observer!=='Codex-root'||dev.replId!==BOOTSTRAP_IDENTITY.replId||!fresh(dev.observedAt,now)||dev.assessment?.outcome!=='confirmed'||dev.assessment.oldApplicationProcessesStopped!==true||dev.assessment.oldBotWorkersStopped!==true||!['stopped','build_only'].includes(dev.assessment.workflowMode))fail('BOOTSTRAP_DEVELOPMENT_NOT_FENCED');
 const raw=await readObserved(dev.rawReadback?.path,dev.rawReadback?.sha256,project);if(raw.kind!=='lba-replit-writer-readback/1'||raw.tool!=='mcp__codex_apps__replit_ask_question'||raw.arguments?.replId!==BOOTSTRAP_IDENTITY.replId||!fresh(raw.observedAt,now)||raw.result?.structuredContent?.phase!=='paused'||raw.result.structuredContent.replId!==BOOTSTRAP_IDENTITY.replId)fail('BOOTSTRAP_DEVELOPMENT_NOT_FENCED');
 const authority={kind:'production_cutover',purpose:'bootstrap',targetHmac,sourceSha256,schemaSha256,controlEpoch:fence.controlEpoch,fenceSha256:digest(bytes),expiresAt:Math.min(Date.parse(fence.observedAt),Date.parse(provider.observedAt),Date.parse(dev.observedAt),Date.parse(raw.observedAt))+300000};Object.freeze(authority);authorities.add(authority);return authority;
}
async function assertOwnedLocal(client){const r=(await client.query("select current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port")).rows[0];if(!r||!/^lba_test_[a-z_]+$/.test(r.database)||r.address!=='127.0.0.1'||r.port<55430||r.port>55500)fail('BOOTSTRAP_TEST_TARGET_REJECTED');}
/** Only tests with an actual owned loopback DB may inject a synthetic authority.
 * No CLI option selects this; remote/local production DSNs are rejected separately. */
export async function authorityForOwnedDisposable(client,{targetHmac,sourceSha256,controlEpoch=1,purpose='bootstrap'}={}){await assertOwnedLocal(client);if(!hex(targetHmac)||!hex(sourceSha256)||!Number.isSafeInteger(controlEpoch)||controlEpoch<1||!['bootstrap','finalize'].includes(purpose))fail('BOOTSTRAP_INPUT_INVALID');const authority={kind:'owned_disposable_pg',purpose,targetHmac,sourceSha256,schemaSha256:BOOTSTRAP_SCHEMA,controlEpoch,expiresAt:Date.now()+300000,fenceSha256:digest('owned-disposable-pg-only'),activationSha256:digest('owned-disposable-activation-only'),operationId:null};Object.freeze(authority);authorities.add(authority);return authority;}
async function checkAuthority(client,authority,targetHmac,sourceSha256){if(!authorities.has(authority)||!['production_cutover','production_activation','owned_disposable_pg'].includes(authority.kind)||authority.targetHmac!==targetHmac||authority.sourceSha256!==sourceSha256||!hex(sourceSha256)||authority.schemaSha256!==BOOTSTRAP_SCHEMA||Date.now()>authority.expiresAt)fail('BOOTSTRAP_AUTHORITY_REQUIRED');if(authority.kind==='owned_disposable_pg')await assertOwnedLocal(client);else if((await verifyCurrentSource()).sourceSha256!==sourceSha256)fail('BOOTSTRAP_SOURCE_BUILD_DRIFT');}
async function holdState(client,operationId,epoch,lock=true){
 const suffix=lock?' for share':'';
 const control=(await client.query('select control_epoch::text as epoch,writer_mode from lba_production_control where id=true'+suffix)).rows;
 const bot=(await client.query('select bot_id,hold_reason,hold_operation,cooldown_until,next_send_at from lba_production_telegram_bot_state'+suffix)).rows;
 if(control.length!==1||control[0].epoch!==String(epoch)||control[0].writer_mode!=='canonical'||bot.length!==1||bot[0].bot_id!==BOOTSTRAP_IDENTITY.botId||bot[0].hold_reason!==HOLD||bot[0].hold_operation!==operationId||bot[0].cooldown_until!==null||bot[0].next_send_at!==null)fail('BOOTSTRAP_OWNED_HOLD_REQUIRED');
}
async function validateCoreRows(client,owners,key,plan){
 const profiles=(await client.query('select owner_id,session_id,revision::text as revision,control_epoch::text as epoch,state,created_at,updated_at from lba_production_profiles order by owner_id')).rows;
 if(profiles.some(row=>!owners.includes(row.owner_id))||profiles.length>owners.length)fail('BOOTSTRAP_CANONICAL_OWNER_CONFLICT');
 for(const row of profiles){
  const account=plan.accounts.find(a=>a.ownerHmac===mac(key,row.owner_id)),expected=await legacyOwner(client,row.owner_id,nowIso());
  const origins=(await client.query('select source_digest,projection_digest,private_provenance,imported_at,control_epoch::text as epoch from lba_production_profile_origins where owner_id=$1',[row.owner_id])).rows;
  const ledger=(await client.query('select session_id,source_digest,origin_kind,initialized_at,control_epoch::text as epoch from lba_production_bootstrap_ledger where owner_id=$1',[row.owner_id])).rows;
  if(!account||row.revision!=='0'||row.epoch!==String(plan.controlEpoch)||origins.length!==1||ledger.length!==1||origins[0].source_digest!==account.sourceDigest||origins[0].projection_digest!==account.projectionDigest||origins[0].epoch!==String(plan.controlEpoch)||ledger[0].source_digest!==account.sourceDigest||ledger[0].epoch!==String(plan.controlEpoch)||ledger[0].session_id!==row.session_id||!isDeepStrictEqual(row.state,createBotState({ownerId:row.owner_id,sessionId:row.session_id,profile:expected.value.projection.profile})))fail('BOOTSTRAP_CANONICAL_PROFILE_MISMATCH');
  const imported=origins[0].imported_at.toISOString(),empty=expected.value.counts.settings+expected.value.counts.locations+expected.value.counts.selectedSubscribers===0;
  let emptyProof;
  if(empty){const users=(await client.query('select id,created_at as "createdAt",updated_at as "updatedAt" from users where id=$1',[row.owner_id])).rows;if(users.length!==1||users[0].id!==row.owner_id)fail('BOOTSTRAP_CANONICAL_PROVENANCE_MISMATCH');emptyProof={kind:'verified_empty_account',ownerId:row.owner_id,accountState:'existing_empty',accountRevisionId:'users:'+digest(JSON.stringify([users[0].id,users[0].createdAt,users[0].updatedAt])),evidenceRef:'users-primary-key/same-transaction',legacySourceDigest:expected.value.sourceDigest,verifiedAt:imported};}
  const privateProvenance={version:expected.value.version,provenance:expected.value.projection.provenance,counts:expected.value.counts,completeness:expected.value.completeness,blockers:expected.value.blockers,verifiedSubscriberMappings:expected.mappings,...(isolatedSettingsReference(expected.value)?{unresolvedTelegramReference:{resolution:'retain_owned_rows_reference_unverified',subscriberOwnershipGranted:false}}:{}),...(empty?{emptyAccountProof:emptyProof}:{})};
  if(!isDeepStrictEqual(origins[0].private_provenance,privateProvenance)||ledger[0].origin_kind!==(empty?'verified_empty':'legacy')||ledger[0].initialized_at.toISOString()!==imported||row.created_at.toISOString()!==imported||row.updated_at.toISOString()!==imported)fail('BOOTSTRAP_CANONICAL_PROVENANCE_MISMATCH');
 }
 const counts=(await client.query('select (select count(*)::int from lba_production_profile_origins) as origins,(select count(*)::int from lba_production_bootstrap_ledger) as ledger')).rows[0];if(counts.origins!==profiles.length||counts.ledger!==profiles.length)fail('BOOTSTRAP_PARTIAL_CORE_CONFLICT');return profiles.length;
}
export async function applyCoreBootstrap(pool,{key,targetHmac,expected,sourceSha256=expected?.sourceSha256,signedPlan,authority,backup,journal=null,persistJournal,afterAccount,installReviewedSchema=false}={}){
 const plan=verifyPrivate(key,signedPlan,'lba-core-bootstrap-plan/1');
 if(!fresh(plan.createdAt,Date.now())||plan.targetHmac!==targetHmac||plan.sourceSha256!==sourceSha256||!hex(sourceSha256)||plan.schemaSha256!==BOOTSTRAP_SCHEMA||!hex(plan.operationId)||typeof persistJournal!=='function'||!['legacy_only','canonical_complete'].includes(plan.schemaState)||typeof installReviewedSchema!=='boolean')fail('BOOTSTRAP_PLAN_STALE_OR_INVALID');
 let client=await pool.connect(),locked=false,currentJournal;
 try{
  await checkAuthority(client,authority,targetHmac,sourceSha256);
  if(authority.purpose!=='bootstrap')fail('BOOTSTRAP_WRONG_OPERATION_AUTHORITY');
  if(!hex(plan.fenceSha256)||plan.fenceSha256!==authority.fenceSha256||plan.expectedControlEpoch!==authority.controlEpoch)fail('BOOTSTRAP_PLAN_FENCE_MISMATCH');
  if(plan.schemaState==='legacy_only'&&(!installReviewedSchema||plan.nativeInstallSqlSha256!==BOOTSTRAP_NATIVE_SQL_SHA256))fail('BOOTSTRAP_EXPLICIT_SCHEMA_INSTALL_REQUIRED');
  if(afterAccount&&authority.kind!=='owned_disposable_pg')fail('BOOTSTRAP_TEST_HOOK_REJECTED');
  const r1=await validateFreshR1Capability(backup,{key,targetHmac,sourceSha256,snapshotHmac:plan.snapshotHmac,legacyHmac:plan.legacyHmac});
  if(!(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',['lba:explicit-core-bootstrap'])).rows[0]?.locked)fail('BOOTSTRAP_OPERATOR_BUSY');locked=true;
  await client.query('begin isolation level repeatable read');
  try{
   await client.query("set local statement_timeout='30s'");await client.query("set local lock_timeout='1s'");await client.query('set local search_path=pg_catalog,public');const installed=await inspectInstalledSchema(client,expected);
   if(installed.state!==plan.schemaState)fail('BOOTSTRAP_INSTALLED_STATE_DRIFT');
   const legacy=await tableEvidence(client,LEGACY,key);if(mac(key,legacy)!==plan.legacyHmac)fail('BOOTSTRAP_LEGACY_DRIFT');
   const owners=await registry(client);if(owners.length!==plan.accountCount||canonical(owners.map(owner=>mac(key,owner)).sort())!==canonical(plan.accounts.map(a=>a.ownerHmac).sort()))fail('BOOTSTRAP_OWNER_REGISTRY_DRIFT');
   if(installed.state==='legacy_only'){
    const sql=await loadReviewedNativeSchema();await checkAuthority(client,authority,targetHmac,sourceSha256);
    currentJournal={kind:'lba-core-bootstrap-operation/1',actor:'migration_operator',operationId:plan.operationId,targetHmac,sourceSha256,schemaSha256:BOOTSTRAP_SCHEMA,controlEpoch:authority.controlEpoch,legacyHmac:plan.legacyHmac,planSha256:digest(canonical(signedPlan)),fenceSha256:authority.fenceSha256,backupArchiveSha256:r1.archiveSha256,stage:'schema_install_requested',createdAt:journal?.createdAt??nowIso(),updatedAt:nowIso(),completedOwners:0,productionEffect:'explicit_reviewed_schema_and_core_bootstrap',holdReleased:false,schemaInstallation:{sqlSha256:BOOTSTRAP_NATIVE_SQL_SHA256,state:'intent',before:'legacy_only',backupArchiveSha256:r1.archiveSha256}};
    await persistJournal(signPrivate(key,currentJournal));await client.query('set local search_path=public,pg_catalog');await client.query(sql);await client.query('set local search_path=pg_catalog,public');await assertSchema(client,expected);
    if(mac(key,await tableEvidence(client,LEGACY,key))!==plan.legacyHmac)fail('BOOTSTRAP_LEGACY_DRIFT');
   }
   const rows=await tableEvidence(client,CANONICAL_REQUIRED_RELATIONS,key);if(rows.some(row=>!CORE.has(row.table)&&row.rows))fail('BOOTSTRAP_CANONICAL_IN_USE');
   const existing=rows.some(row=>row.rows);
   if(existing){
    if(!journal||journal.operationId!==plan.operationId||journal.targetHmac!==targetHmac||journal.legacyHmac!==plan.legacyHmac||journal.sourceSha256!==sourceSha256||journal.schemaSha256!==BOOTSTRAP_SCHEMA||journal.controlEpoch!==authority.controlEpoch)fail('BOOTSTRAP_PARTIAL_STATE_REQUIRES_JOURNAL');
    if(plan.resumeJournalSha256!==digest(canonical(journal)))fail('BOOTSTRAP_RESUME_JOURNAL_DRIFT');
    await holdState(client,plan.operationId,authority.controlEpoch);await validateCoreRows(client,owners,key,{...plan,controlEpoch:authority.controlEpoch});
   }else{
    await client.query('insert into lba_production_control(id,control_epoch,writer_mode) values(true,$1,\'canonical\')',[authority.controlEpoch]);
    await client.query('insert into lba_production_telegram_bot_state(bot_id,hold_reason,hold_operation,updated_at) values($1,$2,$3,$4)',[BOOTSTRAP_IDENTITY.botId,HOLD,plan.operationId,nowIso()]);
   }
   currentJournal={kind:'lba-core-bootstrap-operation/1',actor:'migration_operator',operationId:plan.operationId,targetHmac,sourceSha256,schemaSha256:BOOTSTRAP_SCHEMA,controlEpoch:authority.controlEpoch,legacyHmac:plan.legacyHmac,planSha256:digest(canonical(signedPlan)),fenceSha256:authority.fenceSha256,backupArchiveSha256:r1.archiveSha256,stage:'hold_commit_requested',createdAt:journal?.createdAt??nowIso(),updatedAt:nowIso(),completedOwners:journal?.completedOwners??0,productionEffect:'explicit_core_bootstrap_only',holdReleased:false,schemaInstallation:installed.state==='legacy_only'?{...currentJournal.schemaInstallation,state:'schema_and_hold_commit_requested'}:journal?.schemaInstallation??null};
   await persistJournal(signPrivate(key,currentJournal));await client.query('commit');currentJournal.stage='hold_committed';if(currentJournal.schemaInstallation)currentJournal.schemaInstallation={...currentJournal.schemaInstallation,state:'installed_verified'};await persistJournal(signPrivate(key,currentJournal));
  }catch(error){await client.query('rollback').catch(()=>{});throw error;}
  // Store snapshots retain their real per-owner transactions. A separate,
  // read-only-in-effect legacy TABLE SHARE barrier prevents source DB writes
  // during the sequence; it is never described as a global profile commit.
  await client.query('begin isolation level repeatable read');
  await client.query("set local statement_timeout='30s'");await client.query("set local lock_timeout='1s'");
  await client.query('lock table '+LEGACY.map(name=>'public.'+quoted(name)).join(',')+' in share mode');
  if(mac(key,await tableEvidence(client,LEGACY,key))!==plan.legacyHmac)fail('BOOTSTRAP_LEGACY_DRIFT');
  const ownerClient=await pool.connect();let owners;try{owners=await registry(ownerClient);}finally{ownerClient.release();}
  const allowed=new Set(owners);
  const store=createProductionProfileStore({enabled:true,pool,expectedControlEpoch:authority.controlEpoch,context:()=>({addresses:[],plans:[],addressCatalogStatus:'unavailable'}),verifiedSubscriberMappings:(principal,c)=>selectVerifiedLegacySubscriberMappings(c,principal),verifyEmptyAccount:verifyRuntimeEmptyAccount,unresolvedSettingsTelegramPolicy:'retain_owned_profile',authorizePrincipal:async({client:c,principal})=>{
   await checkAuthority(c,authority,targetHmac,sourceSha256);await holdState(c,plan.operationId,authority.controlEpoch);
   if(!allowed.has(principal.ownerId))return false;const rows=(await c.query('select id from users where id=$1 for share',[principal.ownerId])).rows;return rows.length===1&&rows[0].id===principal.ownerId;
  }});
  let completed=0;
  for(const owner of owners){
   const c=await pool.connect();let expectedOwner;try{await checkAuthority(c,authority,targetHmac,sourceSha256);await c.query('begin isolation level repeatable read read only');expectedOwner=await legacyOwner(c,owner,nowIso());if(mac(key,await tableEvidence(c,LEGACY,key))!==plan.legacyHmac)fail('BOOTSTRAP_LEGACY_DRIFT');await c.query('commit');}catch(error){await c.query('rollback').catch(()=>{});throw error;}finally{c.release();}
   const account=plan.accounts.find(a=>a.ownerHmac===mac(key,owner));if(!account||account.sourceDigest!==expectedOwner.value.sourceDigest||account.profileHmac!==mac(key,expectedOwner.value.projection.profile))fail('BOOTSTRAP_OWNER_PROJECTION_DRIFT');
   const first=await store.snapshot(expectedOwner.principal),repeat=await store.snapshot(expectedOwner.principal);
   if(!isDeepStrictEqual(first.profile,expectedOwner.value.projection.profile)||!isDeepStrictEqual(first,repeat)&&!(first.sessionId===repeat.sessionId&&first.revision===repeat.revision&&isDeepStrictEqual(first.profile,repeat.profile))||first.revision!==0)fail('BOOTSTRAP_ACCOUNT_MISMATCH');
   completed++;currentJournal.completedOwners=completed;currentJournal.stage='profiles_in_progress';currentJournal.updatedAt=nowIso();await persistJournal(signPrivate(key,currentJournal));if(afterAccount)await afterAccount(completed);
  }
  const final=await pool.connect();try{
   await final.query('begin isolation level repeatable read read only');await checkAuthority(final,authority,targetHmac,sourceSha256);await holdState(final,plan.operationId,authority.controlEpoch,false);
   if(mac(key,await tableEvidence(final,LEGACY,key))!==plan.legacyHmac)fail('BOOTSTRAP_LEGACY_DRIFT');if(await validateCoreRows(final,owners,key,{...plan,controlEpoch:authority.controlEpoch})!==owners.length)fail('BOOTSTRAP_FINAL_DENOMINATOR_MISMATCH');
   const rows=await tableEvidence(final,CANONICAL_REQUIRED_RELATIONS,key);if(rows.some(row=>!CORE.has(row.table)&&row.rows))fail('BOOTSTRAP_UNEXPECTED_EFFECT_ROWS');const accountProofs=await immutableAccountProofs(final,owners,key);await final.query('commit');
   currentJournal.stage='verified_held';currentJournal.completedOwners=owners.length;currentJournal.updatedAt=nowIso();currentJournal.canonicalRows=rows;currentJournal.canonicalHmac=mac(key,rows);currentJournal.accountProofs=accountProofs;await persistJournal(signPrivate(key,currentJournal));
   await client.query('commit');
   return {code:'BOOTSTRAP_VERIFIED_HELD',operationId:plan.operationId,accounts:owners.length,legacyUnchanged:true,repeatIdempotent:true,holdReleased:false,providerRequests:0};
  }catch(error){await final.query('rollback').catch(()=>{});throw error;}finally{final.release();}
 }catch(error){
  if(currentJournal){currentJournal.stage='partial_or_commit_unknown';currentJournal.updatedAt=nowIso();currentJournal.reason=classifyBootstrapFailure(error);await persistJournal(signPrivate(key,currentJournal)).catch(()=>{});}throw error;
 }finally{
  if(client){await client.query('rollback').catch(()=>{});if(locked)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',['lba:explicit-core-bootstrap']).catch(()=>{});client.release();}
 }
}
async function immutableAccountProofs(client,owners,key){
 const output=[];
 for(const owner of owners){
  const origins=(await client.query('select to_jsonb(t)::text as raw from lba_production_profile_origins t where owner_id=$1',[owner])).rows;
  const ledger=(await client.query('select to_jsonb(t)::text as raw from lba_production_bootstrap_ledger t where owner_id=$1',[owner])).rows;
  if(origins.length!==1||ledger.length!==1||typeof origins[0].raw!=='string'||typeof ledger[0].raw!=='string')fail('BOOTSTRAP_FINAL_DENOMINATOR_MISMATCH');
  output.push({ownerHmac:mac(key,owner),originHmac:mac(key,origins[0].raw),ledgerHmac:mac(key,ledger[0].raw)});
 }
 return output.sort((a,b)=>a.ownerHmac.localeCompare(b.ownerHmac));
}
export async function validateProductionActivation(file,{targetHmac,sourceSha256,operationId,controlEpoch,now=Date.now(),project=ROOT}={}){
 const absolute=await safePrivateFile(file,project),bytes=await readFile(absolute),activation=JSON.parse(bytes);
 if(activation.kind!=='lba-canonical-activation-observation/1'||activation.outcome!=='confirmed'||!fresh(activation.observedAt,now)||activation.projectId!==BOOTSTRAP_IDENTITY.projectId||activation.replId!==BOOTSTRAP_IDENTITY.replId||activation.domain!==BOOTSTRAP_IDENTITY.domain||activation.botId!==BOOTSTRAP_IDENTITY.botId||activation.targetHmac!==targetHmac||activation.sourceSha256!==sourceSha256||!hex(sourceSha256)||activation.schemaSha256!==BOOTSTRAP_SCHEMA||activation.operationId!==operationId||!hex(operationId)||activation.controlEpoch!==controlEpoch||!Number.isSafeInteger(controlEpoch)||controlEpoch<1)fail('BOOTSTRAP_ACTIVATION_PROOF_INVALID');
 const provider=await readObserved(activation.providerReadback?.path,activation.providerReadback?.sha256,project),health=await readObserved(activation.healthReadback?.path,activation.healthReadback?.sha256,project),result=provider.result?.structuredContent;
 if(provider.kind!=='lba-provider-observation/1'||provider.tool!=='mcp__codex_apps__replit_get_publish_status'||provider.arguments?.replId!==BOOTSTRAP_IDENTITY.replId||!fresh(provider.observedAt,now)||!result||result.found!==true||result.status!=='success'||typeof result.deploymentId!=='string'||!result.deploymentId||result.url!=='https://'+BOOTSTRAP_IDENTITY.domain)fail('BOOTSTRAP_ACTIVATION_PROVIDER_INVALID');
 const body=health.body;
 if(health.kind!=='lba-https-release-health-observation/1'||health.observer!=='Codex-root'||health.url!=='https://'+BOOTSTRAP_IDENTITY.domain+'/api/health/release'||health.status!==200||health.redirected!==false||!fresh(health.observedAt,now)||!body||body.releaseId!==sourceSha256||body.buildSha256!==sourceSha256||body.configuredBotId!==BOOTSTRAP_IDENTITY.botId||body.origin!=='https://'+BOOTSTRAP_IDENTITY.domain||body.mode!=='production'||body.profileMode!=='active'||body.status!=='process_serving'||!fresh(body.observedAt,now)||body.canonical?.ready!==true||body.canonical?.started!==true||body.canonical?.stopped!==false)fail('BOOTSTRAP_ACTIVATION_HEALTH_INVALID');
 const authority={kind:'production_activation',purpose:'finalize',targetHmac,sourceSha256,schemaSha256:BOOTSTRAP_SCHEMA,controlEpoch,operationId,activationSha256:digest(bytes),providerDeploymentId:result.deploymentId,expiresAt:Math.min(Date.parse(activation.observedAt),Date.parse(provider.observedAt),Date.parse(health.observedAt),Date.parse(body.observedAt))+300000};Object.freeze(authority);authorities.add(authority);return authority;
}
async function validateActivatedCore(client,journal,key){
 if(!Array.isArray(journal.accountProofs)||journal.accountProofs.length!==journal.completedOwners||!journal.accountProofs.length||journal.accountProofs.some(proof=>!hex(proof.ownerHmac)||!hex(proof.originHmac)||!hex(proof.ledgerHmac))||new Set(journal.accountProofs.map(proof=>proof.ownerHmac)).size!==journal.accountProofs.length)fail('BOOTSTRAP_COMPLETION_PROOF_INVALID');
 const owners=await registry(client),byHmac=new Map(owners.map(owner=>[mac(key,owner),owner])),original=journal.accountProofs.map(proof=>byHmac.get(proof.ownerHmac));
 if(original.some(owner=>!owner)||!isDeepStrictEqual(await immutableAccountProofs(client,original,key),journal.accountProofs))fail('BOOTSTRAP_IMMUTABLE_PROVENANCE_CHANGED');
 const profiles=(await client.query('select owner_id,session_id,revision::text as revision,control_epoch::text as epoch,state from lba_production_profiles order by owner_id')).rows;
 for(const row of profiles){
  if(!owners.includes(row.owner_id)||row.epoch!==String(journal.controlEpoch)||typeof row.session_id!=='string'||!row.session_id||!/^\d+$/.test(row.revision)||!Number.isSafeInteger(Number(row.revision)))fail('BOOTSTRAP_ACTIVE_CORE_INVALID');
  let state;try{state=restoreBotState(row.state,row.owner_id);}catch{fail('BOOTSTRAP_ACTIVE_CORE_INVALID');}
  if(state.sessionId!==row.session_id||state.revision!==Number(row.revision)||state.profile.id!==row.owner_id||!Number.isSafeInteger(state.callbackSequence)||state.callbackSequence<0||state.profile.locations.length>10000||state.processedInputIds.length>256||state.processedEventIds.length>512)fail('BOOTSTRAP_ACTIVE_CORE_INVALID');
  const ids=new Set();for(const location of state.profile.locations){if(typeof location.address?.id!=='string'||!location.address.id||location.address.id.length>255||location.binding?.addressId!==location.address.id||ids.has(location.address.id))fail('BOOTSTRAP_ACTIVE_CORE_INVALID');ids.add(location.address.id);}
  if(state.profile.primaryAddressId!==null&&!ids.has(state.profile.primaryAddressId)||Object.values(state.callbacks).some(callback=>!callback||callback.ownerId!==row.owner_id))fail('BOOTSTRAP_ACTIVE_CORE_INVALID');
  const origin=(await client.query('select source_digest,projection_digest,private_provenance,control_epoch::text as epoch from lba_production_profile_origins where owner_id=$1',[row.owner_id])).rows,ledger=(await client.query('select source_digest,session_id,origin_kind,control_epoch::text as epoch from lba_production_bootstrap_ledger where owner_id=$1',[row.owner_id])).rows;
  if(origin.length!==1||ledger.length!==1||!hex(origin[0].source_digest)||!hex(origin[0].projection_digest)||origin[0].epoch!==String(journal.controlEpoch)||ledger[0].epoch!==String(journal.controlEpoch)||ledger[0].session_id!==row.session_id||ledger[0].source_digest!==origin[0].source_digest||!['legacy','verified_empty'].includes(ledger[0].origin_kind)||origin[0].private_provenance?.version!=='lba-live-legacy-reader/1')fail('BOOTSTRAP_ACTIVE_CORE_INVALID');
 }
 const counts=(await client.query('select (select count(*)::int from lba_production_profile_origins) as origins,(select count(*)::int from lba_production_bootstrap_ledger) as ledger')).rows[0];
 if(counts.origins!==profiles.length||counts.ledger!==profiles.length)fail('BOOTSTRAP_ACTIVE_CORE_INVALID');
 return {originalAccounts:original.length,currentProfiles:profiles.length};
}
async function assertNoUnknownNative(client){
 const result=(await client.query(`select
 (select count(*)::int from lba_production_telegram_dispatch_jobs where bot_id=$1 and state in ('dispatching','unknown')) as jobs,
 (select count(*)::int from lba_production_telegram_dispatch_attempts a join lba_production_telegram_dispatch_jobs j using(operation_id) where j.bot_id=$1 and a.state in ('dispatching','unknown')) as attempts,
 (select count(*)::int from lba_production_telegram_callback_acks where bot_id=$1 and state in ('dispatching','unknown')) as callback_jobs,
 (select count(*)::int from lba_production_telegram_callback_ack_attempts where bot_id=$1 and state in ('dispatching','unknown')) as callback_attempts,
 (select count(*)::int from lba_release_campaign_jobs j join lba_release_campaigns c using(release_id) where c.bot_id=$1 and j.record->>'state' in ('dispatching','outcome_unknown')) as campaigns`,[BOOTSTRAP_IDENTITY.botId])).rows[0];
 if(!result||Object.values(result).some(value=>value!==0))fail('BOOTSTRAP_UNKNOWN_NATIVE_EFFECT');
}
export async function finalizeCoreBootstrap(pool,{key,targetHmac,expected,sourceSha256=expected?.sourceSha256,signedJournal,authority,backup,persistJournal}={}){
 const journal=verifyPrivate(key,signedJournal,'lba-core-bootstrap-operation/1');
 if(journal.targetHmac!==targetHmac||journal.sourceSha256!==sourceSha256||journal.schemaSha256!==BOOTSTRAP_SCHEMA||!hex(journal.operationId)||typeof persistJournal!=='function')fail('BOOTSTRAP_COMPLETION_PROOF_INVALID');
 // Historical same-operation receipt is read before current mutable eligibility.
 // It never clears a later hold or claims current health on a repeated invocation.
 if(journal.stage==='finalized'&&journal.finalization?.state==='cleared')return {code:'BOOTSTRAP_ALREADY_FINALIZED',receipt:structuredClone(journal.finalization),historicalReceiptOnly:true,productionWrites:0};
 if(!['verified_held','finalize_outcome_unknown','finalize_commit_requested'].includes(journal.stage))fail('BOOTSTRAP_COMPLETION_PROOF_INVALID');
 const client=await pool.connect();let operatorLocked=false,botLocked=false,tx=false,commitRequested=false,pending;
 try{
  await checkAuthority(client,authority,targetHmac,sourceSha256);if(authority.purpose!=='finalize'||authority.operationId!==null&&authority.operationId!==journal.operationId||authority.controlEpoch!==journal.controlEpoch)fail('BOOTSTRAP_ACTIVATION_PROOF_INVALID');
  if(!(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',['lba:explicit-core-bootstrap'])).rows[0]?.locked)fail('BOOTSTRAP_OPERATOR_BUSY');operatorLocked=true;
  if(!(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',[dispatchBotLockKey()])).rows[0]?.locked)fail('BOOTSTRAP_SENDER_BUSY');botLocked=true;
  await client.query('begin isolation level repeatable read');tx=true;await client.query("set local statement_timeout='30s'");await client.query("set local lock_timeout='1s'");await client.query('set local search_path=pg_catalog,public');await assertSchema(client,expected);
  const control=(await client.query('select control_epoch::text as epoch,writer_mode from lba_production_control where id=true for share')).rows;
  if(control.length!==1||control[0].epoch!==String(journal.controlEpoch)||control[0].writer_mode!=='canonical')fail('BOOTSTRAP_CONTROL_DRIFT');
  const bot=(await client.query('select hold_reason,hold_operation,updated_at from lba_production_telegram_bot_state where bot_id=$1 for update',[BOOTSTRAP_IDENTITY.botId])).rows;if(bot.length!==1)fail('BOOTSTRAP_OWNED_HOLD_REQUIRED');
  if(journal.stage!=='verified_held'){
   const prior=journal.finalization;if(!prior||prior.state!=='intent'||!instant(prior.clearedAt))fail('BOOTSTRAP_FINALIZE_OUTCOME_UNCONFIRMED');
   if(bot[0].hold_reason===null&&bot[0].hold_operation===null&&bot[0].updated_at.toISOString()===prior.clearedAt){
    await client.query('commit');tx=false;const confirmed={...journal,stage:'finalized',updatedAt:nowIso(),holdReleased:true,finalization:{...prior,state:'cleared',reconciledByReadback:true}};await persistJournal(signPrivate(key,confirmed));return {code:'BOOTSTRAP_FINALIZED_RECONCILED',receipt:confirmed.finalization,productionWrites:0};
   }
   if(bot[0].hold_reason===HOLD&&bot[0].hold_operation===journal.operationId){await client.query('commit');tx=false;await persistJournal(signPrivate(key,{...journal,stage:'verified_held',updatedAt:nowIso(),finalization:{...prior,state:'not_committed'}}));return {code:'BOOTSTRAP_FINALIZE_NOT_COMMITTED',productionWrites:0};}
   fail('BOOTSTRAP_FINALIZE_OUTCOME_UNCONFIRMED');
  }
  if(bot[0].hold_reason!==HOLD||bot[0].hold_operation!==journal.operationId)fail('BOOTSTRAP_OWNED_HOLD_REQUIRED');
  const r1=await validateFreshR1Capability(backup,{key,targetHmac,sourceSha256,snapshotHmac:backup?.snapshotHmac,legacyHmac:backup?.legacyHmac});
  const current=await validateActivatedCore(client,journal,key);await assertNoUnknownNative(client);await checkAuthority(client,authority,targetHmac,sourceSha256);
  const clearedAt=nowIso(),receipt={id:randomBytes(32).toString('hex'),state:'intent',operationId:journal.operationId,clearedAt,sourceSha256,controlEpoch:journal.controlEpoch,activationSha256:authority.activationSha256,providerDeploymentId:authority.providerDeploymentId??null,backupArchiveSha256:r1.archiveSha256,originalAccounts:current.originalAccounts,currentProfiles:current.currentProfiles,configuredBotId:BOOTSTRAP_IDENTITY.botId,nativeBotIdentityVerified:false};
  pending={...journal,stage:'finalize_commit_requested',updatedAt:nowIso(),finalization:receipt};await persistJournal(signPrivate(key,pending));
  const changed=await client.query('update lba_production_telegram_bot_state set hold_reason=null,hold_operation=null,updated_at=$4 where bot_id=$1 and hold_reason=$2 and hold_operation=$3',[BOOTSTRAP_IDENTITY.botId,HOLD,journal.operationId,clearedAt]);if(changed.rowCount!==1)fail('BOOTSTRAP_OWNED_HOLD_REQUIRED');
  commitRequested=true;await client.query('commit');tx=false;
  const completed={...pending,stage:'finalized',updatedAt:nowIso(),holdReleased:true,finalization:{...receipt,state:'cleared'}};await persistJournal(signPrivate(key,completed));return {code:'BOOTSTRAP_FINALIZED',receipt:completed.finalization,productionWrites:1};
 }catch(error){
  if(tx)await client.query('rollback').catch(()=>{});
  if(pending){const uncertain=commitRequested;await persistJournal(signPrivate(key,{...pending,stage:uncertain?'finalize_outcome_unknown':'verified_held',updatedAt:nowIso(),reason:uncertain?'BOOTSTRAP_FINALIZE_COMMIT_UNKNOWN':classifyBootstrapFailure(error),finalization:{...pending.finalization,state:uncertain?'intent':'not_committed'}})).catch(()=>{});if(uncertain)fail('BOOTSTRAP_FINALIZE_COMMIT_UNKNOWN');}
  throw error;
 }finally{if(botLocked)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[dispatchBotLockKey()]).catch(()=>{});if(operatorLocked)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',['lba:explicit-core-bootstrap']).catch(()=>{});client.release();}
}
/** Explicit preactivation route. All old application/bot actors remain actually
 * fenced; this is readiness for a later deployment, never a healthy-deploy claim. */
export async function readyCoreForActivation(pool,{key,targetHmac,expected,sourceSha256=expected?.sourceSha256,signedJournal,authority,backup,persistJournal}={}){
 const journal=verifyPrivate(key,signedJournal,'lba-core-bootstrap-operation/1');
 if(journal.targetHmac!==targetHmac||journal.sourceSha256!==sourceSha256||journal.schemaSha256!==BOOTSTRAP_SCHEMA||!hex(journal.operationId)||typeof persistJournal!=='function')fail('BOOTSTRAP_COMPLETION_PROOF_INVALID');
 if(journal.stage==='ready_for_activation'&&journal.readiness?.state==='cleared')return {code:'BOOTSTRAP_ALREADY_READY_FOR_ACTIVATION',receipt:structuredClone(journal.readiness),historicalReceiptOnly:true,productionWrites:0};
 if(!['verified_held','ready_commit_requested','ready_outcome_unknown'].includes(journal.stage))fail('BOOTSTRAP_COMPLETION_PROOF_INVALID');
 const client=await pool.connect();let operatorLocked=false,botLocked=false,tx=false,commitRequested=false,pending;
 try{
  await checkAuthority(client,authority,targetHmac,sourceSha256);if(authority.purpose!=='bootstrap'||authority.controlEpoch!==journal.controlEpoch)fail('BOOTSTRAP_WRONG_OPERATION_AUTHORITY');
  if(!(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',['lba:explicit-core-bootstrap'])).rows[0]?.locked)fail('BOOTSTRAP_OPERATOR_BUSY');operatorLocked=true;
  if(!(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',[dispatchBotLockKey()])).rows[0]?.locked)fail('BOOTSTRAP_SENDER_BUSY');botLocked=true;
  await client.query('begin isolation level repeatable read');tx=true;await client.query("set local statement_timeout='30s'");await client.query("set local lock_timeout='1s'");await client.query('set local search_path=pg_catalog,public');await assertSchema(client,expected);
  const control=(await client.query('select control_epoch::text as epoch,writer_mode from lba_production_control where id=true for share')).rows;
  if(control.length!==1||control[0].epoch!==String(journal.controlEpoch)||control[0].writer_mode!=='canonical')fail('BOOTSTRAP_CONTROL_DRIFT');
  const bot=(await client.query('select hold_reason,hold_operation,updated_at from lba_production_telegram_bot_state where bot_id=$1 for update',[BOOTSTRAP_IDENTITY.botId])).rows;if(bot.length!==1)fail('BOOTSTRAP_OWNED_HOLD_REQUIRED');
  if(journal.stage!=='verified_held'){
   const prior=journal.readiness;if(!prior||prior.state!=='intent'||!instant(prior.clearedAt)||prior.deployedHealthy!==false)fail('BOOTSTRAP_READY_OUTCOME_UNCONFIRMED');
   if(bot[0].hold_reason===null&&bot[0].hold_operation===null&&bot[0].updated_at.toISOString()===prior.clearedAt){await client.query('commit');tx=false;const completed={...journal,stage:'ready_for_activation',updatedAt:nowIso(),holdReleased:true,readiness:{...prior,state:'cleared',reconciledByReadback:true}};await persistJournal(signPrivate(key,completed));return {code:'BOOTSTRAP_READY_RECONCILED',receipt:completed.readiness,productionWrites:0};}
   if(bot[0].hold_reason===HOLD&&bot[0].hold_operation===journal.operationId){await client.query('commit');tx=false;await persistJournal(signPrivate(key,{...journal,stage:'verified_held',updatedAt:nowIso(),readiness:{...prior,state:'not_committed'}}));return {code:'BOOTSTRAP_READY_NOT_COMMITTED',productionWrites:0};}
   fail('BOOTSTRAP_READY_OUTCOME_UNCONFIRMED');
  }
  if(bot[0].hold_reason!==HOLD||bot[0].hold_operation!==journal.operationId)fail('BOOTSTRAP_OWNED_HOLD_REQUIRED');
  const legacy=await tableEvidence(client,LEGACY,key),canonicalRows=await tableEvidence(client,CANONICAL_REQUIRED_RELATIONS,key);
  await assertNoUnknownNative(client);
  if(mac(key,legacy)!==journal.legacyHmac)fail('BOOTSTRAP_LEGACY_DRIFT');
  if(mac(key,canonicalRows)!==journal.canonicalHmac||canonicalRows.some(row=>!CORE.has(row.table)&&row.rows))fail('BOOTSTRAP_PREACTIVATION_DATA_DRIFT');
  const current=await validateActivatedCore(client,journal,key);if(current.currentProfiles!==journal.completedOwners||current.originalAccounts!==journal.completedOwners)fail('BOOTSTRAP_FINAL_DENOMINATOR_MISMATCH');
  const snapshotHmac=mac(key,[...legacy,...canonicalRows].sort((a,b)=>a.table.localeCompare(b.table))),r1=await validateFreshR1Capability(backup,{key,targetHmac,sourceSha256,snapshotHmac,legacyHmac:journal.legacyHmac});
  await checkAuthority(client,authority,targetHmac,sourceSha256);
  const clearedAt=nowIso(),receipt={id:randomBytes(32).toString('hex'),state:'intent',operationId:journal.operationId,clearedAt,sourceSha256,controlEpoch:journal.controlEpoch,bootstrapFenceSha256:journal.fenceSha256,readyFenceSha256:authority.fenceSha256,backupArchiveSha256:r1.archiveSha256,originalAccounts:current.originalAccounts,deployedHealthy:false,providerHealthyVerified:false,nativeBotIdentityVerified:false,nextPhase:'Explicit root native publish and actual HTTPS/provider/native checks; no app actors were started here.'};
  pending={...journal,stage:'ready_commit_requested',updatedAt:nowIso(),readiness:receipt};await persistJournal(signPrivate(key,pending));
  const changed=await client.query('update lba_production_telegram_bot_state set hold_reason=null,hold_operation=null,updated_at=$4 where bot_id=$1 and hold_reason=$2 and hold_operation=$3',[BOOTSTRAP_IDENTITY.botId,HOLD,journal.operationId,clearedAt]);if(changed.rowCount!==1)fail('BOOTSTRAP_OWNED_HOLD_REQUIRED');
  commitRequested=true;await client.query('commit');tx=false;const completed={...pending,stage:'ready_for_activation',updatedAt:nowIso(),holdReleased:true,readiness:{...receipt,state:'cleared'}};await persistJournal(signPrivate(key,completed));return {code:'BOOTSTRAP_READY_FOR_ACTIVATION',receipt:completed.readiness,productionWrites:1};
 }catch(error){
  if(tx)await client.query('rollback').catch(()=>{});
  if(pending){const uncertain=commitRequested;await persistJournal(signPrivate(key,{...pending,stage:uncertain?'ready_outcome_unknown':'verified_held',updatedAt:nowIso(),reason:uncertain?'BOOTSTRAP_READY_COMMIT_UNKNOWN':classifyBootstrapFailure(error),readiness:{...pending.readiness,state:uncertain?'intent':'not_committed'}})).catch(()=>{});if(uncertain)fail('BOOTSTRAP_READY_COMMIT_UNKNOWN');}throw error;
 }finally{if(botLocked)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[dispatchBotLockKey()]).catch(()=>{});if(operatorLocked)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',['lba:explicit-core-bootstrap']).catch(()=>{});client.release();}
}
export function classifyBootstrapFailure(error){
 const value=error?.message;if(KNOWN_CODES.has(value))return value;
 if(value==='PRODUCTION_COMMIT_UNKNOWN')return 'BOOTSTRAP_ACCOUNT_COMMIT_UNKNOWN';
 if(error?.code==='28P01')return 'BOOTSTRAP_AUTH_FAILED';if(error?.code==='42501')return 'BOOTSTRAP_PERMISSION_DENIED';if(['57014','55P03'].includes(error?.code))return 'BOOTSTRAP_TIMEOUT';
 if(/certificate|self.signed|unable to verify|TLS|SSL/i.test(String(value)))return 'BOOTSTRAP_TLS_FAILED';return 'BOOTSTRAP_UNCONFIRMED';
}
async function hiddenConnection(mode){
 if(!process.stdin.isTTY||!process.stdout.isTTY)fail('BOOTSTRAP_LOCAL_TERMINAL_REQUIRED');
 process.stdout.write('LIGHT BOT APP · '+(mode==='plan'?'план перенесення — лише читання':mode==='finalize'?'завершення: зняття лише власного migration hold':mode==='ready'?'підготовка до майбутнього запуску — production ще не оголошено healthy':'явне перенесення профілів за перевіреним планом')+'\n');
 process.stdout.write('Вставте production Connection string з Replit Database → Production → Settings.\nПісля ⌘V вводу не видно — це нормально. Натисніть Return.\n');
 const silent=new Writable({write(_chunk,_encoding,done){done();}}),rl=createInterface({input:process.stdin,output:silent,terminal:true});
 try{return await new Promise((resolve,reject)=>{rl.once('line',resolve);rl.once('SIGINT',()=>reject(Error('BOOTSTRAP_CANCELLED')));rl.once('close',()=>reject(Error('BOOTSTRAP_CANCELLED')));});}finally{rl.close();process.stdout.write('\n');}
}
function cliOptions(args){
 if(!args.length)return {mode:'plan'};
 if(args[0]==='--fence'&&args.length===2)return {mode:'plan',fence:args[1]};
 if(args[0]==='--ready-for-activation'&&args.length===3&&args[1]==='--fence')return {mode:'ready',fence:args[2]};
 if(args[0]==='--finalize'&&args.length===3&&args[1]==='--activation')return {mode:'finalize',activation:args[2]};
 if(args[0]!=='--apply'||![5,6].includes(args.length)||args[1]!=='--plan'||args[3]!=='--fence'||args.length===6&&args[5]!=='--install-reviewed-schema')fail('BOOTSTRAP_ARGUMENTS_INVALID');
 return {mode:'apply',plan:args[2],fence:args[4],installReviewedSchema:args.length===6};
}
async function backupBinary(){for(const binary of ['/opt/homebrew/opt/libpq/bin/pg_dump','/usr/local/opt/libpq/bin/pg_dump','/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump'])try{await access(binary);return binary;}catch{}fail('BOOTSTRAP_PG_DUMP_UNAVAILABLE');}
async function privateDump(binary,environment,snapshot,file){
 await new Promise((resolve,reject)=>{
  const child=spawn(binary,['--format=custom','--schema=public','--no-owner','--no-privileges','--snapshot='+snapshot,'--file='+file],{env:{PATH:'/usr/bin:/bin',...environment},stdio:['ignore','ignore','pipe']});
  let diagnostic='';child.stderr.on('data',part=>{if(diagnostic.length<16384)diagnostic+=part.toString().slice(0,16384-diagnostic.length);});
  const timeout=setTimeout(()=>{child.kill('SIGTERM');reject(Error('BOOTSTRAP_R1_DUMP_TIMEOUT'));},180000);
  child.once('error',()=>{clearTimeout(timeout);reject(Error('BOOTSTRAP_R1_DUMP_EXEC_FAILED'));});child.once('close',code=>{clearTimeout(timeout);code===0?resolve():reject(Error(classifyDumpFailure(diagnostic).replace(/^BACKUP_/,'BOOTSTRAP_R1_')));});
 });
}
function nativeRestoreBinary(binary){
 if(!['/opt/homebrew/opt/libpq/bin/pg_dump','/usr/local/opt/libpq/bin/pg_dump','/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump'].includes(binary))fail('BOOTSTRAP_R1_NATIVE_TOOL_REQUIRED');
 return binary.replace(/pg_dump$/,'pg_restore');
}
async function verifyNativeArchive(file,binary,requiredTables){
 await safePrivateFile(file,ROOT,512*1024*1024);
 const record=await lstat(file,{bigint:true}).catch(()=>fail('BOOTSTRAP_R1_ARCHIVE_UNAVAILABLE'));
 if(!record.isFile()||record.isSymbolicLink()||record.uid!==BigInt(process.getuid())||record.nlink!==1n||(record.mode&0o777n)!==0o600n||record.size<32n||record.size>512n*1024n*1024n)fail('BOOTSTRAP_R1_ARCHIVE_UNSAFE');
 const bytes=await readFile(file);if(bytes.subarray(0,5).toString('ascii')!=='PGDMP')fail('BOOTSTRAP_R1_ARCHIVE_INVALID');
 const text=await new Promise((resolve,reject)=>{
  const child=spawn(nativeRestoreBinary(binary),['--list',file],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['ignore','pipe','ignore']});let output='';
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('BOOTSTRAP_R1_ARCHIVE_LIST_FAILED'));},30000);
  child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>2*1024*1024){child.kill('SIGTERM');reject(Error('BOOTSTRAP_R1_ARCHIVE_LIST_FAILED'));}});
  child.once('error',()=>{clearTimeout(timer);reject(Error('BOOTSTRAP_R1_ARCHIVE_LIST_FAILED'));});child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error('BOOTSTRAP_R1_ARCHIVE_LIST_FAILED'));});
 });
 const entries=[...text.matchAll(/\bTABLE DATA public ([a-z_][a-z0-9_]*)\s/g)].map(match=>match[1]).sort(),required=[...requiredTables].sort();
 if(canonical(entries)!==canonical(required))fail('BOOTSTRAP_R1_ARCHIVE_TABLES_MISMATCH');
 return {archiveSha256:digest(bytes),device:record.dev.toString(),inode:record.ino.toString(),bytes:record.size.toString()};
}
async function backupOutputFolder(folder,authority){
 const absolute=path.resolve(folder),prefix=authority.kind==='owned_disposable_pg'?path.join(ROOT,'.local/light-bot-app'):path.join(BASE,'backups');
 if(!absolute.startsWith(prefix+path.sep))fail('BOOTSTRAP_R1_OUTPUT_SCOPE_REJECTED');
 const relative=path.relative(ROOT,path.dirname(absolute)).split(path.sep);let current=ROOT;
 for(const component of relative){current=path.join(current,component);const record=await lstat(current).catch(()=>fail('BOOTSTRAP_R1_OUTPUT_SCOPE_REJECTED'));if(!record.isDirectory()||record.isSymbolicLink()||record.uid!==process.getuid()||(record.mode&0o022)!==0)fail('BOOTSTRAP_R1_OUTPUT_SCOPE_REJECTED');}
 return absolute;
}
function assertDumpConnection(client,environment,key,targetHmac,authority){
 const allowed=new Set(['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','PGCONNECT_TIMEOUT']);
 if(!environment||Object.keys(environment).some(name=>!allowed.has(name))||typeof environment.PGPASSWORD!=='string'||!environment.PGPASSWORD)fail('BOOTSTRAP_R1_CONNECTION_MISMATCH');
 if(authority.kind!=='owned_disposable_pg'&&(environment.PGSSLMODE!=='verify-full'||environment.PGSSLROOTCERT!==CA))fail('BOOTSTRAP_R1_TLS_REQUIRED');
 const parameters=client.connectionParameters;
 if(!parameters||typeof parameters.host!=='string'||environment.PGHOST!==parameters.host||String(environment.PGPORT)!==String(parameters.port)||environment.PGDATABASE!==parameters.database||environment.PGUSER!==parameters.user||mac(key,[environment.PGHOST,environment.PGPORT,environment.PGDATABASE,environment.PGUSER].join('|'))!==targetHmac)fail('BOOTSTRAP_R1_CONNECTION_MISMATCH');
}
async function validateFreshR1Capability(record,{key,targetHmac,sourceSha256,snapshotHmac,legacyHmac}){
 const capability=record&&typeof record==='object'?freshR1Capabilities.get(record):null;if(!capability)fail('BOOTSTRAP_FRESH_R1_REQUIRED');
 const value=verifyPrivate(key,record,'lba-fresh-bootstrap-r1/1');
 if(value.targetHmac!==targetHmac||value.sourceSha256!==sourceSha256||value.schemaSha256!==BOOTSTRAP_SCHEMA||value.snapshotHmac!==snapshotHmac||value.legacyHmac!==legacyHmac||!fresh(value.createdAt,Date.now())||value.snapshotConsistent!==true||capability.targetHmac!==targetHmac||capability.sourceSha256!==sourceSha256||capability.snapshotHmac!==snapshotHmac)fail('BOOTSTRAP_FRESH_R1_REQUIRED');
 const current=await verifyNativeArchive(capability.file,capability.binary,capability.requiredTables);
 if(canonical(current)!==canonical(capability.native)||current.archiveSha256!==value.archiveSha256)fail('BOOTSTRAP_R1_ARCHIVE_CHANGED');return value;
}
/** Makes a new private all-public R1 from an exported read-only snapshot. No
 * production DML or application imports/startup occur here. */
export async function createFreshR1(client,{key,targetHmac,expected,sourceSha256=expected?.sourceSha256,authority,binary,environment,folder,...unsupported}){
 if(Object.keys(unsupported).length)fail('BOOTSTRAP_R1_UNSUPPORTED_OPTIONS');
 await checkAuthority(client,authority,targetHmac,sourceSha256);nativeRestoreBinary(binary);assertDumpConnection(client,environment,key,targetHmac,authority);
 const output=await backupOutputFolder(folder,authority);let tx=false,complete=false,created=false,createdIdentity;
 try{
  try{await mkdir(output,{mode:0o700});created=true;const stat=await lstat(output,{bigint:true});createdIdentity={device:stat.dev.toString(),inode:stat.ino.toString()};}catch(error){if(error.code==='EEXIST')fail('BOOTSTRAP_R1_OUTPUT_EXISTS');throw error;}
  await client.query('begin isolation level repeatable read read only');tx=true;await client.query("set local statement_timeout='30s'");await client.query('set local search_path=pg_catalog,public');
  const target=await server(client);if(target.read_only!=='on')fail('BOOTSTRAP_R1_NOT_READ_ONLY');const installed=await inspectInstalledSchema(client,expected);
  const all=await tableEvidence(client,installed.tables,key),legacy=all.filter(row=>LEGACY.includes(row.table));
  const snapshot=(await client.query('select pg_export_snapshot() as snapshot')).rows[0]?.snapshot;if(typeof snapshot!=='string'||!/^\w+-[0-9A-Fa-f]+-\d+$/.test(snapshot))fail('BOOTSTRAP_R1_SNAPSHOT_INVALID');
  const file=path.join(output,'production-r1.dump');await privateDump(binary,environment,snapshot,file);await chmod(file,0o600);
  const native=await verifyNativeArchive(file,binary,installed.tables);await client.query('commit');tx=false;
  const snapshotHmac=mac(key,all),result=signPrivate(key,{kind:'lba-fresh-bootstrap-r1/1',createdAt:nowIso(),targetHmac,schemaSha256:BOOTSTRAP_SCHEMA,installedSchemaState:installed.state,installedContractSha256:installed.schemaContractSha256,sourceSha256,legacyHmac:mac(key,legacy),snapshotHmac,snapshotConsistent:true,readOnlySource:true,nativeFormat:'PGDMP',nativeListVerified:true,archive:'production-r1.dump',archiveSha256:native.archiveSha256,tables:all,restoreVerified:false,retention:'Private R1/tail: retain until stable release and approved recovery; no automatic deletion.'});
  await writePrivateAtomic(path.join(output,'manifest.private.json'),result);freshR1Capabilities.set(result,{file,binary,native,targetHmac,sourceSha256,snapshotHmac,requiredTables:installed.tables});complete=true;return Object.freeze(result);
 }finally{if(tx)await client.query('rollback').catch(()=>{});if(!complete&&created){const current=await lstat(output,{bigint:true}).catch(()=>null);if(current?.isDirectory()&&!current.isSymbolicLink()&&current.dev.toString()===createdIdentity.device&&current.ino.toString()===createdIdentity.inode)await rm(output,{recursive:true,force:true}).catch(()=>{});}}
}
async function latestJournal(key){
 try{const file=await safePrivateFile(path.join(BASE,'LATEST_OPERATION.json')),marker=JSON.parse(await readFile(file,'utf8'));if(!hex(marker.operationId)||!hex(marker.journalSha256))fail('BOOTSTRAP_PRIVATE_RECORD_INVALID');
  const journalFile=await safePrivateFile(path.join(BASE,'operations',marker.operationId+'.private.json')),bytes=await readFile(journalFile);if(digest(bytes)!==marker.journalSha256)fail('BOOTSTRAP_PRIVATE_RECORD_INVALID');return verifyPrivate(key,JSON.parse(bytes),'lba-core-bootstrap-operation/1');
 }catch(error){if(error.message==='BOOTSTRAP_PRIVATE_FILE_UNAVAILABLE')return null;throw error;}
}
async function saveJournal(key,record){
 const data=verifyPrivate(key,record,'lba-core-bootstrap-operation/1');if(!hex(data.operationId))fail('BOOTSTRAP_PRIVATE_RECORD_INVALID');
 const file=path.join(BASE,'operations',data.operationId+'.private.json');await writePrivateAtomic(file,record);await writePrivateAtomic(path.join(BASE,'LATEST_OPERATION.json'),{operationId:data.operationId,journalSha256:digest(await readFile(file)),stage:data.stage});
}
export async function runProductionBootstrap(args=process.argv.slice(2)){
 process.umask(0o077);const options=cliOptions(args),expected=await verifyCurrentSource(),key=await setupPrivate();let pool;
 try{
  const journal=await latestJournal(key);
  if(options.mode==='finalize'&&journal?.stage==='finalized'&&journal.finalization?.state==='cleared'&&journal.sourceSha256===expected.sourceSha256){process.stdout.write('Цю операцію вже завершено. Код: BOOTSTRAP_ALREADY_FINALIZED.\nЦе збережена квитанція; поточний стан production тут повторно не перевірявся.\n');return {code:'BOOTSTRAP_ALREADY_FINALIZED',historicalReceiptOnly:true,productionWrites:0};}
  if(options.mode==='ready'&&journal?.stage==='ready_for_activation'&&journal.readiness?.state==='cleared'&&journal.sourceSha256===expected.sourceSha256){process.stdout.write('Цей крок уже виконано. Код: BOOTSTRAP_ALREADY_READY_FOR_ACTIVATION.\nЦе історична квитанція підготовки, не підтвердження поточного deployment чи health.\n');return {code:'BOOTSTRAP_ALREADY_READY_FOR_ACTIVATION',historicalReceiptOnly:true,productionWrites:0};}
  if(options.mode==='finalize'){if(!journal||!['verified_held','finalize_commit_requested','finalize_outcome_unknown'].includes(journal.stage))fail('BOOTSTRAP_COMPLETION_PROOF_INVALID');await safePrivateFile(path.resolve(options.activation));}
  if(options.mode==='apply'){await safePrivateFile(path.resolve(options.plan));await safePrivateFile(path.resolve(options.fence));}
  if(options.mode==='ready'){if(!journal||!['verified_held','ready_commit_requested','ready_outcome_unknown'].includes(journal.stage))fail('BOOTSTRAP_COMPLETION_PROOF_INVALID');await safePrivateFile(path.resolve(options.fence));}
  if(options.mode==='plan'&&options.fence)await safePrivateFile(path.resolve(options.fence));
  const value=await hiddenConnection(options.mode);let parsed;try{parsed=productionConnection(value);}catch{fail('BOOTSTRAP_CONNECTION_INVALID');}
  const ca=await readFile(CA).catch(()=>fail('BOOTSTRAP_SSL_CA_UNAVAILABLE'));
  const config={...parsed.client,ssl:{rejectUnauthorized:true,ca},application_name:'LIGHT-BOT-explicit-migration-operator',max:4};
  const {Pool}=require('pg');pool=new Pool(config);pool.on('error',()=>{});pool.on('connect',client=>client.on('error',()=>{}));
  const targetHmac=mac(key,[parsed.child.PGHOST,parsed.child.PGPORT,parsed.child.PGDATABASE,parsed.child.PGUSER].join('|'));
  if(options.mode==='plan'){
   const authority=options.fence?await validateProductionFence(path.resolve(options.fence),{targetHmac,sourceSha256:expected.sourceSha256}):null;
   const client=await pool.connect();let plan;try{plan=await createReadOnlyPlan(client,{key,targetHmac,expected,resume:journal,authority});}finally{client.release();}
   const file=path.join(BASE,'plan-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex')+'.private.json');await writePrivateAtomic(file,plan);
   await writePrivateAtomic(path.join(BASE,'LATEST_PLAN.json'),{plan:path.basename(file),planSha256:digest(await readFile(file)),code:'BOOTSTRAP_PLAN_RECORDED',productionWrites:0});
   process.stdout.write('План збережено приватно. Код: BOOTSTRAP_PLAN_RECORDED.\nЦе лише читання: перенесення не виконано. '+(plan.fenceProved?'План прив’язаний до перевіреного поточного fence.':'План без fence не допускає --apply.')+'\nПоверніться до Codex; підключення та звіт у чат не надсилайте.\n');return {code:'BOOTSTRAP_PLAN_RECORDED'};
  }
  if(options.mode==='finalize'){
   const authority=await validateProductionActivation(path.resolve(options.activation),{targetHmac,sourceSha256:expected.sourceSha256,operationId:journal.operationId,controlEpoch:journal.controlEpoch});let backup;
   if(journal.stage==='verified_held'){const client=await pool.connect();try{backup=await createFreshR1(client,{key,targetHmac,expected,authority,binary:await backupBinary(),environment:parsed.child,folder:path.join(BASE,'backups','finalize-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex'))});}finally{client.release();}}
   const result=await finalizeCoreBootstrap(pool,{key,targetHmac,expected,signedJournal:signPrivate(key,journal),authority,backup,persistJournal:record=>saveJournal(key,record)});
   process.stdout.write('Крок завершення перевірено. Код: '+result.code+'.\nЧужі hold, cooldown, профілі й післярелізні записи не перезаписувалися. Telegram API цей помічник не викликає.\n');return result;
  }
  if(options.mode==='ready'){
   const authority=await validateProductionFence(path.resolve(options.fence),{targetHmac,sourceSha256:expected.sourceSha256});let backup;
   if(journal.stage==='verified_held'){const client=await pool.connect();try{backup=await createFreshR1(client,{key,targetHmac,expected,authority,binary:await backupBinary(),environment:parsed.child,folder:path.join(BASE,'backups','ready-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex'))});}finally{client.release();}}
   const result=await readyCoreForActivation(pool,{key,targetHmac,expected,signedJournal:signPrivate(key,journal),authority,backup,persistJournal:record=>saveJournal(key,record)});
   process.stdout.write('Крок підготовки перевірено. Код: '+result.code+'.\nЗастосунок не запущено й production health не підтверджено. Поверніться до Codex для фактичного deployment.\n');return result;
  }
  const planFile=await safePrivateFile(path.resolve(options.plan)),signedPlan=JSON.parse(await readFile(planFile,'utf8')),plan=verifyPrivate(key,signedPlan,'lba-core-bootstrap-plan/1');
  const authority=await validateProductionFence(path.resolve(options.fence),{targetHmac,sourceSha256:expected.sourceSha256});if(plan.targetHmac!==targetHmac||!fresh(plan.createdAt,Date.now()))fail('BOOTSTRAP_PLAN_STALE_OR_INVALID');if(plan.fenceSha256!==authority.fenceSha256||plan.expectedControlEpoch!==authority.controlEpoch)fail('BOOTSTRAP_PLAN_FENCE_MISMATCH');
  if(plan.schemaState==='legacy_only'&&!options.installReviewedSchema)fail('BOOTSTRAP_EXPLICIT_SCHEMA_INSTALL_REQUIRED');
  const binary=await backupBinary(),client=await pool.connect();let backup;
  try{backup=await createFreshR1(client,{key,targetHmac,expected,authority,binary,environment:parsed.child,folder:path.join(BASE,'backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex'))});}finally{client.release();}
  const result=await applyCoreBootstrap(pool,{key,targetHmac,expected,signedPlan,authority,backup,journal,persistJournal:record=>saveJournal(key,record),installReviewedSchema:options.installReviewedSchema});
  process.stdout.write('Перенесення профілів перевірено. Код: '+result.code+'.\nВласний hold збережено; бот, логін, розсилки та застосунок цим кроком не запускалися.\nПоверніться до Codex. Connection string, пароль, архів і приватний звіт у чат не надсилайте.\n');return result;
 }catch(error){const code=classifyBootstrapFailure(error);await writePrivateAtomic(path.join(BASE,'LAST_ATTEMPT.json'),{recordedAt:nowIso(),confirmed:false,code}).catch(()=>{});throw Error(code);}
 finally{if(pool)await pool.end().catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runProductionBootstrap().catch(error=>{process.stderr.write('Операцію не підтверджено. Код: '+classifyBootstrapFailure(error)+'. Секрети у чат не надсилайте.\n');process.exitCode=1;});
