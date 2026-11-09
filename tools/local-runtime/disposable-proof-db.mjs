import EmbeddedPostgres from 'embedded-postgres';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
const require=createRequire(new URL('../../app/package.json',import.meta.url)),{Pool}=require('pg');
const project=path.resolve(import.meta.dirname,'../..');
/** Never reads DATABASE_URL/PG credentials; creates and stops only its own loopback cluster. */
export async function withProofDatabase(tag,port,run){
 if(!/^[a-z_]{1,24}$/.test(tag)||!Number.isInteger(port)||port<55430||port>55500||process.getuid?.()===0)throw Error('INVALID_PROOF_DATABASE');
 await mkdir(path.join(project,'.local/light-bot-app'),{recursive:true,mode:0o700});
 const directory=await mkdtemp(path.join(project,'.local/light-bot-app',tag+'-db-'));
 const user='lba_proof',password=randomBytes(32).toString('hex'),database='lba_test_'+tag;
 const postgres=new EmbeddedPostgres({databaseDir:directory,port,user,password,authMethod:'scram-sha-256',persistent:false,
  createPostgresUser:false,autoRehydrateSymlinks:true,postgresFlags:['-c','listen_addresses=127.0.0.1','-c','unix_socket_directories='],onLog:()=>{},onError:()=>{}});
 let started=false,pool;
 const connection={host:'127.0.0.1',port,user,password,ssl:false,options:'',max:8};
 try{
  await postgres.initialise();await postgres.start();started=true;
  pool=new Pool({...connection,database:'postgres'});await pool.query('create database '+database);await pool.end();
  pool=new Pool({...connection,database});
  const target=(await pool.query("select current_database() as database,inet_server_port() as port,current_setting('listen_addresses') as listen")).rows[0];
  if(target.database!==database||target.port!==port||target.listen!=='127.0.0.1')throw Error('PROOF_DATABASE_TARGET_MISMATCH');
  return await run(pool,target);
 }finally{if(pool)await pool.end();if(started)await postgres.stop();}
}
