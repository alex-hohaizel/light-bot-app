import {randomUUID} from 'node:crypto';
import type {AuthReplayPool,AuthReplayClient} from './auth-replay.ts';

export interface VerifiedReplitClaims {sub:unknown;first_name?:unknown;last_name?:unknown;email?:unknown;profile_image_url?:unknown}
const text=(v:unknown,max=255):v is string=>typeof v==='string'&&Boolean(v)&&v===v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const optional=(v:unknown,max=255)=>text(v,max)?v:null;
/** Caller is the established verified OIDC strategy, never a request-body claims object.
 * Current explicit provider links are authoritative; username/email and legacy ID
 * conventions cannot merge accounts. Login/refresh never copy settings/locations.
 */
export function createReplitIdentityResolver(pool:AuthReplayPool,options:{isDetached?:(client:AuthReplayClient,subject:string)=>Promise<boolean>}={}){
 async function resolve(claims:VerifiedReplitClaims,allowCreate:boolean):Promise<string>{
  if(!claims||!text(claims.sub))throw Error('REPLIT_IDENTITY_INVALID');
  const subject=claims.sub,metadata=[optional(claims.email,320),optional(claims.first_name),optional(claims.last_name),optional(claims.profile_image_url,2048)];
  let client:Awaited<ReturnType<AuthReplayPool['connect']>>;
  try{client=await pool.connect();}catch{throw Error('REPLIT_IDENTITY_UNCONFIRMED');}
  try{
   await client.query('begin');
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:replit:'+subject]);
   const links=await client.query("select a.user_id as owner from linked_accounts a join users u on u.id=a.user_id where a.provider='replit' and a.provider_id=$1 for update of a,u",[subject]);
   if(links.rows.length===1&&text(links.rows[0].owner)){await client.query('commit');return links.rows[0].owner;}
   if(links.rows.length||!allowCreate)throw Error('REPLIT_IDENTITY_CONFIRMATION_REQUIRED');
   if(await options.isDetached?.(client,subject))throw Error('REPLIT_IDENTITY_CONFIRMATION_REQUIRED');
   const held=await client.query("select 1 from linked_accounts where provider='replit' and provider_id=$1 union all select 1 from users where id=$1",[subject]);
   if(held.rows.length)throw Error('REPLIT_IDENTITY_CONFIRMATION_REQUIRED');
   const owner=randomUUID();
   await client.query('insert into users(id,email,first_name,last_name,profile_image_url) values($1,$2,$3,$4,$5)',
    [owner,...metadata]);
   await client.query("insert into linked_accounts(id,user_id,provider,provider_id,display_name) values($1,$2,'replit',$3,'Replit')",[randomUUID(),owner,subject]);
   await client.query('commit');return owner;
  }catch{try{await client.query('rollback');}catch{}throw Error('REPLIT_IDENTITY_UNCONFIRMED');}
  finally{try{client.release();}catch{throw Error('REPLIT_IDENTITY_UNCONFIRMED');}}
 }
 return {login:(claims:VerifiedReplitClaims)=>resolve(claims,true),existing:(subject:string)=>resolve({sub:subject},false)};
}
