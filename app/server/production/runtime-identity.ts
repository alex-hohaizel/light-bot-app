import {randomUUID,createHash} from 'node:crypto';
import type {LegacyProfileReadQuery} from './profile-reader.ts';
import type {ProductionProfileStoreOptions} from './profile-store.ts';
import {resolveCurrentTelegramOwner,type TelegramOwnerResolver} from './telegram-processor.ts';
import {PRODUCT_TELEGRAM_IDENTITY} from './product-identity.ts';

/** Fresh authenticated private ingress may create a NEW account. Existing links
 * and convention-named legacy accounts are never reassigned or silently merged. */
export function createIngressOwnerResolver(expectedControlEpoch:number,options:{isDetached?:(client:LegacyProfileReadQuery,subject:string)=>Promise<boolean>}={}):TelegramOwnerResolver {
 if(!Number.isSafeInteger(expectedControlEpoch)||expectedControlEpoch<1)throw Error('RUNTIME_IDENTITY_EPOCH_INVALID');
 return async(client,actor)=>{
  if(!/^[1-9]\d{0,15}$/.test(actor))return {status:'ambiguous'};
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['lba:identity:telegram:'+actor]);
  const existing=await resolveCurrentTelegramOwner(client,actor);if(existing.status!=='missing')return existing;
  if(await options.isDetached?.(client,actor))return {status:'ambiguous'};
  const orphan=await client.query("select 1 from users where id=$1 limit 1",['tg_'+actor]);
  if(orphan.rows.length)return {status:'ambiguous'};
  const proof=await client.query(`select update_id::text as "updateId" from lba_production_telegram_inbox
   where bot_id=$1 and control_epoch=$2 and disposition='accepted' and received_at>=clock_timestamp()-interval '15 minutes'
   and private_input->>'version'='lba-telegram-private-input/1'
   and private_input->>'actorTelegramId'=$3 and private_input->>'chatId'=$3
   order by update_id desc limit 1 for share`,[PRODUCT_TELEGRAM_IDENTITY.botId,expectedControlEpoch,actor]);
  if(proof.rows.length!==1)return {status:'missing'};
  const owner=randomUUID();await client.query('insert into users(id) values($1)',[owner]);
  await client.query("insert into linked_accounts(id,user_id,provider,provider_id,display_name) values($1,$2,'telegram',$3,'Telegram')",[randomUUID(),owner,actor]);
  return resolveCurrentTelegramOwner(client,actor);
 };
}

/** Exact same-transaction registry proof for a legitimately empty profile. */
export const verifyRuntimeEmptyAccount:NonNullable<ProductionProfileStoreOptions['verifyEmptyAccount']>=async input=>{
 const result=await input.client.query('select id,created_at as "createdAt",updated_at as "updatedAt" from users where id=$1 for share',[input.principal.ownerId]);
 if(result.rows.length!==1||result.rows[0].id!==input.principal.ownerId)return null;
 const row=result.rows[0],canonical=JSON.stringify([row.id,row.createdAt,row.updatedAt]);
 return {kind:'verified_empty_account',ownerId:input.principal.ownerId,accountState:'existing_empty',
  accountRevisionId:'users:'+createHash('sha256').update(canonical).digest('hex'),evidenceRef:'users-primary-key/same-transaction',
  legacySourceDigest:input.legacySourceDigest,verifiedAt:input.serverNow};
};
