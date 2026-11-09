import {createRequire} from 'node:module';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,chmod,access,rename,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';

const root=path.resolve(import.meta.dirname,'../..');
const CA_FILE='/opt/homebrew/etc/ca-certificates/cert.pem';
const require=createRequire(path.join(root,'app/package.json')),{Client}=require('pg');
const canon=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canon).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(v).digest('hex');
const identifier=v=>'"'+v.replaceAll('"','""')+'"';
export function productionConnection(value){
 let u;try{u=new URL(value);}catch{throw Error('BACKUP_CONNECTION_INVALID');}
 const host=u.hostname.toLowerCase().replace(/\.$/,'');
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.username||!u.password||!host.includes('.')||isIP(host)||
   !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)||host.includes('..')||/(?:^|\.)(?:local|localhost|localdomain|lan|internal|home|test|invalid)$/.test(host)||u.hash||
   !u.pathname||u.pathname==='/'||[...u.searchParams.keys()].some(k=>!['sslmode','channel_binding','connect_timeout'].includes(k)))throw Error('BACKUP_CONNECTION_INVALID');
 const database=decodeURIComponent(u.pathname.slice(1)),user=decodeURIComponent(u.username),password=decodeURIComponent(u.password);
 if(/[\u0000-\u001f]/.test(database+user+password)||/lba[_-](?:synthetic|test|local)/i.test(database))throw Error('BACKUP_CONNECTION_INVALID');
 u.hostname=host;for(const k of [...u.searchParams.keys()])u.searchParams.delete(k);
 return {client:{connectionString:u.toString(),ssl:{rejectUnauthorized:true},connectionTimeoutMillis:15000,application_name:'LIGHT-BOT-private-readonly-backup'},
  child:{PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:database,PGUSER:user,PGPASSWORD:password,PGSSLMODE:'verify-full',PGSSLROOTCERT:CA_FILE,PGCONNECT_TIMEOUT:'15'},
  targetSha256:sha([u.hostname,u.port||'5432',database,user].join('|'))};
}
export async function collectSnapshotEvidence(client,salt){
 const tables=(await client.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name")).rows.map(r=>r.table_name);
 if(tables.length>200||!['users','user_settings','user_locations','linked_accounts','telegram_subscribers'].every(t=>tables.includes(t)))throw Error('BACKUP_PRODUCT_SCHEMA_MISMATCH');
 const h=v=>createHmac('sha256',salt).update(v).digest('hex'),rowsByTable={},rawByRow=new WeakMap(),tableEvidence=[];let bytes=0;
 for(const name of tables){
  const selected=await client.query('select to_jsonb(t)::text as raw from public.'+identifier(name)+' t limit 200001');
  if(selected.rows.length>200000)throw Error('BACKUP_LIMIT_EXCEEDED');
  const rows=selected.rows.map(r=>{if(typeof r.raw!=='string')throw Error('BACKUP_ROW_INVALID');const value=JSON.parse(r.raw);rawByRow.set(value,r.raw);return value;}),sorted=selected.rows.map(r=>r.raw).sort();bytes+=sorted.reduce((n,s)=>n+Buffer.byteLength(s),0);
  if(bytes>128*1024*1024)throw Error('BACKUP_LIMIT_EXCEEDED');
  tableEvidence.push({table:name,count:rows.length,hmac:h(sorted.join('\n'))});
  if(['users','user_settings','user_locations','linked_accounts','telegram_subscribers'].includes(name))rowsByTable[name]=rows;
 }
 // Prevent accidental backup of an empty development database in this existing product.
 if(rowsByTable.users.length<10||rowsByTable.user_locations.length<15||rowsByTable.telegram_subscribers.length<9)throw Error('BACKUP_TARGET_COUNTS_REQUIRE_REVIEW');
 const links=new Map();
 for(const r of rowsByTable.linked_accounts)if(r.provider==='telegram'&&typeof r.provider_id==='string'){
  const prior=links.get(r.provider_id);links.set(r.provider_id,prior===undefined?r.user_id:null);
 }
 const owners=new Map();
 for(const u of rowsByTable.users){
  const items={};for(const t of Object.keys(rowsByTable))items[t]=rowsByTable[t].filter(r=>t==='users'?r.id===u.id:t==='telegram_subscribers'?r.user_id===u.id||r.user_id===null&&links.get(r.chat_id)===u.id:r.user_id===u.id).map(r=>rawByRow.get(r)).sort();
  owners.set(h(String(u.id)),h(canon(items)));
 }
 const schema=(await client.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows;
 return {version:'lba-private-backup-evidence/1',tables:tableEvidence,accountCount:owners.size,perAccount:[...owners].sort().map(([ownerHmac,stateHmac])=>({ownerHmac,stateHmac})),schemaSha256:sha(canon(schema)),bytesExamined:bytes};
}
async function privateDirectory(){
 const folder=path.join(root,'.local','production-backup');
 for(const f of [path.join(root,'.local'),folder]){try{await mkdir(f,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const s=await lstat(f);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())throw Error('BACKUP_DIRECTORY_UNSAFE');}
 await chmod(folder,0o700);return folder;
}
async function executable(){
 const candidates=['/opt/homebrew/opt/libpq/bin/pg_dump','/usr/local/opt/libpq/bin/pg_dump','/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump'];
 for(const p of candidates)try{await access(p);return p;}catch{}
 throw Error('BACKUP_PG_DUMP_UNAVAILABLE');
}
async function hiddenConnection(){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('BACKUP_LOCAL_TERMINAL_REQUIRED');
 process.stdout.write('Вставте production Connection string із Replit Database → Production. Ввід прихований. Натисніть Return:\n');
 const muted=new Writable({write(_chunk,_encoding,done){done();}});
 const rl=createInterface({input:process.stdin,output:muted,terminal:true});
 try{return await new Promise((resolve,reject)=>{rl.once('line',resolve);rl.once('SIGINT',()=>reject(Error('BACKUP_CANCELLED')));rl.once('close',()=>reject(Error('BACKUP_CANCELLED')));});}finally{rl.close();process.stdout.write('\n');}
}
async function dump(binary,environment,snapshot,filename){
 await new Promise((resolve,reject)=>{
  const child=spawn(binary,['--format=custom','--schema=public','--no-owner','--no-privileges','--snapshot='+snapshot,'--file='+filename],{env:{PATH:'/usr/bin:/bin',...environment},stdio:['ignore','ignore','pipe']});
  // Never forward provider diagnostics: they can contain the entered credential.
  let diagnostic='';child.stderr.on('data',chunk=>{if(diagnostic.length<16384)diagnostic+=chunk.toString('utf8').slice(0,16384-diagnostic.length);});
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('BACKUP_DUMP_TIMEOUT'));},180000);
  child.once('error',()=>{clearTimeout(timer);reject(Error('BACKUP_DUMP_EXEC_FAILED'));});child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(classifyDumpFailure(diagnostic)));});
 });
}
/** Classification only: provider text/credentials are never returned or persisted. */
export function classifyDumpFailure(value){
 if(/root certificate file.*does not exist|could not (?:read|load).*root certificate/i.test(value))return 'BACKUP_DUMP_CA_MISSING';
 if(/certificate verify failed|certificate.*does not match|SSL error/i.test(value))return 'BACKUP_DUMP_TLS_FAILED';
 if(/server version mismatch|aborting because of server version/i.test(value))return 'BACKUP_DUMP_VERSION_MISMATCH';
 if(/password authentication failed|no password supplied/i.test(value))return 'BACKUP_DUMP_AUTH_FAILED';
 if(/invalid snapshot|snapshot.*does not exist|cannot import.*snapshot/i.test(value))return 'BACKUP_DUMP_SNAPSHOT_REJECTED';
 if(/permission denied|must be.*owner|insufficient privilege/i.test(value))return 'BACKUP_DUMP_PERMISSION_DENIED';
 if(/could not translate host|could not connect|connection.*(?:refused|timed out|closed)/i.test(value))return 'BACKUP_DUMP_CONNECTION_FAILED';
 return 'BACKUP_DUMP_FAILED';
}
export async function runBackup(){
 process.umask(0o077);const binary=await executable(),base=await privateDirectory();await access(CA_FILE).catch(()=>{throw Error('BACKUP_SSL_CA_UNAVAILABLE');});
 const stamp=new Date().toISOString().replace(/[:.]/g,'-'),folder=path.join(base,stamp+'-'+randomBytes(4).toString('hex'));
 const connection=productionConnection(await hiddenConnection());await mkdir(folder,{mode:0o700});
 const client=new Client(connection.client);client.on('error',()=>{});let tx=false,complete=false;
 try{
  await client.connect();await client.query('begin isolation level repeatable read read only');tx=true;
  await client.query("set local statement_timeout='30s'");
  const server=(await client.query("select current_setting('server_version_num')::int as version,pg_is_in_recovery() as replica")).rows[0];
  if(server.replica!==false)throw Error('BACKUP_READ_REPLICA_REJECTED');
  const salt=randomBytes(32),evidence=await collectSnapshotEvidence(client,salt),snapshot=(await client.query('select pg_export_snapshot() as snapshot')).rows[0]?.snapshot;
  if(typeof snapshot!=='string'||!/^\w+-[0-9A-Fa-f]+-\d+$/.test(snapshot))throw Error('BACKUP_SNAPSHOT_INVALID');
  const archive=path.join(folder,'production-public.dump');await dump(binary,connection.child,snapshot,archive);await chmod(archive,0o600);
  await client.query('commit');tx=false;
  const manifest={...evidence,createdAt:new Date().toISOString(),targetSha256:connection.targetSha256,serverVersionNumber:server.version,
   snapshotConsistent:true,readOnlySource:true,replica:false,archive:'production-public.dump',archiveSha256:sha(await readFile(archive)),hmacSalt:salt.toString('base64'),
   scope:'Allpublicschemaobjects/data, including profiles/settings/locations/linkedidentities/subscribers/sessions andsourcehistory. No externaltransfer; privateMacfilepermissions0700/0600.',
   retention:'Keepprivateuntilrestore/migration/rollbackrehearsalcompleted andstablerelease; noautomaticdeletion.',restoreVerified:false};
  await writeFile(path.join(folder,'manifest.private.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  const latest=path.join(base,'LATEST.json'),tmp=latest+'.'+randomBytes(4).toString('hex');await writeFile(tmp,JSON.stringify({folder:path.relative(root,folder),createdAt:manifest.createdAt,archiveSha256:manifest.archiveSha256,accounts:evidence.accountCount,restoreVerified:false})+'\n',{mode:0o600});await rename(tmp,latest);complete=true;
  process.stdout.write('Копію збережено приватно на цьому Mac. Пароль та URL не записані.\nПовертайтеся до Codex; архів і значення підключення в чат не надсилайте.\n');
 }catch(e){const code=e instanceof Error&&/^BACKUP_[A-Z_]+$/.test(e.message)?e.message:'BACKUP_UNCONFIRMED';
  await writeFile(path.join(base,'LAST_ATTEMPT.json'),JSON.stringify({recordedAt:new Date().toISOString(),confirmed:false,code})+'\n',{mode:0o600}).catch(()=>{});throw Error(code);
 }finally{if(tx)await client.query('rollback').catch(()=>{});await client.end().catch(()=>{});if(!complete)await rm(folder,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runBackup().catch(e=>{const code=e instanceof Error&&/^BACKUP_[A-Z_]+$/.test(e.message)?e.message:'BACKUP_UNCONFIRMED';process.stderr.write('Резервну копію не підтверджено. Код: '+code+'. Секрет у чат не надсилайте.\n');process.exitCode=1;});
