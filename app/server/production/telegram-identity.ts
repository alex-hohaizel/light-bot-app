import {randomUUID} from 'node:crypto';
import type {AuthReplayPool,AuthReplayClient} from './auth-replay.ts';
import type {VerifiedTelegramUser} from '../telegram-init-data.ts';
/** Called only after verified Telegram proof was durably reserved. Never merges by username/email/chat heuristics. */
export function createTelegramIdentityResolver(pool:AuthReplayPool,options:{isDetached?:(client:AuthReplayClient,subject:string)=>Promise<boolean>}={}){
 return async(user:VerifiedTelegramUser):Promise<string>=>{
  if(!user||!/^[1-9]\d{0,15}$/.test(user.id))throw Error('TELEGRAM_IDENTITY_INVALID');
  const subject=user.id,client=await pool.connect();
  try{
   await client.query('begin');
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:telegram:'+subject]);
   const linked=await client.query("select a.user_id as owner from linked_accounts a join users u on u.id=a.user_id where a.provider='telegram' and a.provider_id=$1 for update of a,u",[subject]);
   if(linked.rows.length===1&&typeof linked.rows[0].owner==='string'){
    await client.query('commit');return linked.rows[0].owner;
   }
   if(linked.rows.length)throw Error('TELEGRAM_IDENTITY_AMBIGUOUS');
   if(await options.isDetached?.(client,subject))throw Error('TELEGRAM_IDENTITY_CONFIRMATION_REQUIRED');
   // A dangling link or old convention-based account is retained for reconciliation, never overwritten or silently duplicated.
   const unresolved=await client.query("select 1 from linked_accounts where provider='telegram' and provider_id=$1 union all select 1 from users where id=$2",[subject,'tg_'+subject]);
   if(unresolved.rows.length)throw Error('TELEGRAM_IDENTITY_CONFIRMATION_REQUIRED');
   const owner=randomUUID();
   await client.query('insert into users(id,first_name,last_name,profile_image_url) values($1,$2,$3,$4)',[owner,user.firstName,user.lastName??null,user.photoUrl??null]);
   await client.query("insert into linked_accounts(id,user_id,provider,provider_id,display_name) values($1,$2,'telegram',$3,$4)",[randomUUID(),owner,subject,'Telegram']);
   await client.query('commit');return owner;
  }catch{try{await client.query('rollback');}catch{}throw Error('TELEGRAM_IDENTITY_UNCONFIRMED');}
  finally{client.release();}
 };
}
