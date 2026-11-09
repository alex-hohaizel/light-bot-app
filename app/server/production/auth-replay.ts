import {createHmac,randomUUID} from 'node:crypto';

export const AUTH_REPLAY_SCHEMA_SQL=`create table if not exists lba_auth_proof_uses(
 proof_key text primary key, kind text not null check(kind in ('mini_app','login')), bot_id text not null,
 claim_id text not null, state text not null check(state in ('claimed','bound')),
 session_binding text not null, owner_id text, expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
alter table lba_auth_proof_uses add column if not exists purpose text not null default 'login' check(purpose in ('login','account_link'));
alter table lba_auth_proof_uses add column if not exists challenge_binding text;`;
export interface AuthReplayQuery {query(sql:string,values?:any[]):Promise<{rows:any[];rowCount:number|null}>}
export interface AuthReplayClient extends AuthReplayQuery {release():void}
export interface AuthReplayPool {connect():Promise<AuthReplayClient>}
export interface VerifiedAuthProof {kind:'mini_app'|'login';botId:string;subjectId:string;authDate:number;signature:string}
export type AuthProofReservation={kind:'new';proofKey:string;claimId:string}|{kind:'bound';ownerId:string};
export class AuthReplayError extends Error{}
const fail=(code:string):never=>{throw new AuthReplayError(code);};
/** The caller MUST first verify Telegram's HMAC, timestamp and signed identity.
 * Only the signed hash is used; query order/URL encoding cannot create another proof.
 * Imports never create a pool or apply schema. Session IDs/signatures are not persisted.
 */
export function createAuthReplayGuard(pool:AuthReplayPool,options:{key:string;now:()=>number}){
 if(!pool||typeof pool.connect!=='function'||typeof options?.key!=='string'||options.key.length<32||typeof options.now!=='function')fail('AUTH_REPLAY_CONFIGURATION');
 const mac=(value:unknown)=>createHmac('sha256',options.key).update(JSON.stringify(value)).digest('hex');
 function session(value:string){if(typeof value!=='string'||!value||value.length>512)fail('AUTH_REPLAY_SESSION');return mac(['session',value]);}
 function proof(value:VerifiedAuthProof){
  if(!value||Object.keys(value).sort().join(',')!=='authDate,botId,kind,signature,subjectId'||!['mini_app','login'].includes(value.kind)||
   !/^[1-9]\d{0,15}$/.test(value.botId)||!/^[1-9]\d{0,15}$/.test(value.subjectId)||!Number.isSafeInteger(value.authDate)||value.authDate<0||!/^[a-f0-9]{64}$/.test(value.signature))fail('AUTH_REPLAY_PROOF');
  const now=options.now(),maxAge=value.kind==='mini_app'?3600:86400;
  if(!Number.isSafeInteger(now)||now<0||now-value.authDate>maxAge||value.authDate-now>30)fail('AUTH_REPLAY_EXPIRED');
  return {proofKey:mac(['telegram-auth/1',value.kind,value.botId,value.subjectId,value.authDate,value.signature]),expiry:new Date((value.authDate+maxAge+1)*1000).toISOString()};
 }
 async function transaction<T>(fn:(client:AuthReplayClient)=>Promise<T>){
  let client:AuthReplayClient;try{client=await pool.connect();}catch{return fail('AUTH_REPLAY_UNCONFIRMED');}
  try{await client.query('begin');const result=await fn(client);await client.query('commit');return result;}
  catch(error){try{await client.query('rollback');}catch{}if(error instanceof AuthReplayError)throw error;return fail('AUTH_REPLAY_UNCONFIRMED');}
  finally{try{client.release();}catch{fail('AUTH_REPLAY_UNCONFIRMED');}}
 }
 return {
  async reserve(value:VerifiedAuthProof,sessionId:string):Promise<AuthProofReservation>{
   const {proofKey,expiry}=proof(value),binding=session(sessionId),claimId=randomUUID();
   return transaction(async client=>{
    proof(value);
    const inserted=await client.query(`insert into lba_auth_proof_uses(proof_key,kind,bot_id,claim_id,state,session_binding,expires_at,purpose,challenge_binding)
     values($1,$2,$3,$4,'claimed',$5,$6,'login',null) on conflict(proof_key) do nothing`,[proofKey,value.kind,value.botId,claimId,binding,expiry]);
    proof(value);
    if(inserted.rowCount===1)return {kind:'new',proofKey,claimId};
    const row=(await client.query('select state,session_binding,owner_id,purpose,challenge_binding from lba_auth_proof_uses where proof_key=$1 for update',[proofKey])).rows[0];
    proof(value);
    if(row?.purpose!=='login'||row.challenge_binding!==null)return fail('AUTH_REPLAY_PURPOSE_MISMATCH');
    if(row?.state==='bound'&&row.session_binding===binding&&typeof row.owner_id==='string'&&row.owner_id)return {kind:'bound',ownerId:row.owner_id};
    return fail('AUTH_REPLAY_REOPEN_REQUIRED');
   });
  },
  async bind(reservation:Extract<AuthProofReservation,{kind:'new'}>,newSessionId:string,ownerId:string){
   if(!reservation||reservation.kind!=='new'||!/^[a-f0-9]{64}$/.test(reservation.proofKey)||typeof reservation.claimId!=='string'||
    typeof ownerId!=='string'||!ownerId.trim()||ownerId.length>255||/[\u0000-\u001f]/.test(ownerId))fail('AUTH_REPLAY_BINDING');
   const binding=session(newSessionId);
   return transaction(async client=>{
    const row=(await client.query('select state,claim_id,session_binding,owner_id,expires_at,purpose,challenge_binding from lba_auth_proof_uses where proof_key=$1 for update',[reservation.proofKey])).rows[0];
    if(!row||row.claim_id!==reservation.claimId)fail('AUTH_REPLAY_FENCE');
    if(row.purpose!=='login'||row.challenge_binding!==null)fail('AUTH_REPLAY_PURPOSE_MISMATCH');
    const expiry=Date.parse(row.expires_at instanceof Date?row.expires_at.toISOString():String(row.expires_at));
    function checkExpiry(){const now=options.now();if(!Number.isSafeInteger(now)||!Number.isFinite(expiry)||now*1000>=expiry)fail('AUTH_REPLAY_EXPIRED');}
    checkExpiry();
    if(row.state==='bound'){
     if(row.session_binding===binding&&row.owner_id===ownerId)return;
     fail('AUTH_REPLAY_FENCE');
    }
    if(row.state!=='claimed')fail('AUTH_REPLAY_FENCE');
    await client.query("update lba_auth_proof_uses set state='bound',session_binding=$2,owner_id=$3 where proof_key=$1",[reservation.proofKey,binding,ownerId]);
    checkExpiry();
   });
  },
  /** HMAC/freshness and original-browser authority are verified by the caller.
   * Uses its existing canonical transaction: no BEGIN/COMMIT, pool or release.
   * Purpose is metadata, never part of the established shared provider proof key. */
  async claimAccountLink(client:AuthReplayQuery,value:VerifiedAuthProof,input:{sessionId:string;ownerId:string;challengeId:string}):Promise<{proofKey:string;alreadyClaimed:boolean}>{
   if(!client||typeof client.query!=='function'||!input||Object.keys(input).sort().join(',')!=='challengeId,ownerId,sessionId'||
    typeof input.ownerId!=='string'||!input.ownerId.trim()||input.ownerId.length>255||/[\u0000-\u001f]/.test(input.ownerId)||
    typeof input.challengeId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.challengeId)||value?.kind!=='login')fail('AUTH_REPLAY_BINDING');
   const {proofKey,expiry}=proof(value),binding=session(input.sessionId),challengeBinding=mac(['account-link-challenge/1',input.challengeId]),claimId=randomUUID();
   const inserted=await client.query(`insert into lba_auth_proof_uses(proof_key,kind,bot_id,claim_id,state,session_binding,owner_id,expires_at,purpose,challenge_binding)
    values($1,$2,$3,$4,'bound',$5,$6,$7,'account_link',$8) on conflict(proof_key) do nothing`,[proofKey,value.kind,value.botId,claimId,binding,input.ownerId,expiry,challengeBinding]);
   proof(value);
   if(inserted.rowCount===1)return {proofKey,alreadyClaimed:false};
   const rows=(await client.query('select state,purpose,session_binding,owner_id,challenge_binding from lba_auth_proof_uses where proof_key=$1 for update',[proofKey])).rows,row=rows[0];
   proof(value);
   if(rows.length!==1||row.purpose!=='account_link')fail('AUTH_REPLAY_PURPOSE_MISMATCH');
   if(row.state!=='bound'||row.session_binding!==binding||row.owner_id!==input.ownerId||row.challenge_binding!==challengeBinding)fail('AUTH_REPLAY_REOPEN_REQUIRED');
   return {proofKey,alreadyClaimed:true};
  },
 };
}
