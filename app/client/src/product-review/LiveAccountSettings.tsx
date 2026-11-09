import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {validInstant} from '../../../shared/schedule-core';
import {Modal} from './Modal';
import {AccountTelegramWidget} from './AccountTelegramWidget';
import {clearScopedDraft,draftStorage,loadDraft,readScopedDraftToken,saveDraft,type DraftScope,type DraftStorage} from './ux-drafts';
import './live-account-settings.css';

export interface AccountScope extends DraftScope {revision:number}
export interface LiveAccountSettingsProps {scope:AccountScope;busy?:boolean;onRefreshProfile?:()=>void|Promise<void>}
export interface AccountLink {id:string;provider:'telegram'|'replit';linkRevision:string}
export interface AccountList {links:AccountLink[];authEpoch:number}
type BaseRequest={id:string;expectedSessionId:string;expectedRevision:number};
export type AccountOperation={kind:'challenge';request:BaseRequest}|{kind:'link';request:BaseRequest&{challengeId:string;confirmed:true}}|{kind:'unlink';request:BaseRequest&{linkId:string;linkRevision:string;confirmed:true}};
export interface AccountChallenge {kind:'challenge';challengeId:string;startParam:string;expiresAt:string;miniAppUrl:string|null;state:'pending';widgetBotUsername?:string}
export interface AccountChallengeStatus {kind:'challenge_status';challengeId:string;state:'pending'|'ready_for_confirmation'|'linked'|'expired';expiresAt:string;accountLabel?:string}
export interface AccountMutation {kind:'linked'|'unlinked';operationId:string;provider:'telegram'|'replit';linkId:string;authEpoch:number;reauthenticate:boolean}
interface ChallengeDraft {request:BaseRequest;challenge:AccountChallenge;widgetProofAttempted?:true}
const PENDING='production-account-operation',CHALLENGE='production-account-challenge';
export const PENDING_ACCOUNT_OPERATION_KEY='lba:ux-a:draft:'+PENDING;
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=255):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const provider=(v:unknown):v is AccountLink['provider']=>v==='telegram'||v==='replit';
const instant=validInstant;
function invalid():never{throw Error(accountErrorMessage(null));}
function closed(v:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{if(!plain(v)||Object.keys(v).some(k=>!keys.includes(k)&&!optional.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))return invalid();return v;}
export function checkedAccountList(value:unknown):AccountList{
 const v=closed(value,['links','authEpoch']);if(!integer(v.authEpoch)||!Array.isArray(v.links)||v.links.length>100)return invalid();
 const ids=new Set<string>();const links=v.links.map((entry:unknown)=>{const l=closed(entry,['id','provider','linkRevision']);if(!text(l.id)||!provider(l.provider)||!hex(l.linkRevision)||ids.has(l.id))return invalid();ids.add(l.id);return {id:l.id,provider:l.provider,linkRevision:l.linkRevision};});
 return {links,authEpoch:v.authEpoch};
}
export function checkedAccountOperation(value:unknown):AccountOperation{
 const v=closed(value,['kind','request']);if(!['challenge','link','unlink'].includes(String(v.kind)))return invalid();
 const r=closed(v.request,['id','expectedSessionId','expectedRevision',...(v.kind==='link'?['challengeId','confirmed']:v.kind==='unlink'?['linkId','linkRevision','confirmed']:[])]);
 if(!text(r.id,160)||!text(r.expectedSessionId)||!integer(r.expectedRevision)||v.kind!=='challenge'&&r.confirmed!==true||v.kind==='link'&&!uuid(r.challengeId)||v.kind==='unlink'&&(!text(r.linkId)||!hex(r.linkRevision)))return invalid();
 return structuredClone(v) as unknown as AccountOperation;
}
export function checkedAccountChallenge(value:unknown):AccountChallenge{
 const v=closed(value,['kind','challengeId','startParam','expiresAt','miniAppUrl','state'],['widgetBotUsername']);
 if(v.kind!=='challenge'||!uuid(v.challengeId)||typeof v.startParam!=='string'||!/^acctlink_[a-f0-9]{64}$/.test(v.startParam)||!instant(v.expiresAt)||v.state!=='pending')return invalid();
 if(Object.hasOwn(v,'widgetBotUsername')&&(typeof v.widgetBotUsername!=='string'||!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v.widgetBotUsername)))return invalid();
 if(v.miniAppUrl!==null){
  if(!text(v.miniAppUrl,2048))return invalid();let url:URL;try{url=new URL(v.miniAppUrl);}catch{return invalid();}
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.protocol!=='https:'||url.hostname!=='t.me'||url.port||url.username||url.password||url.hash||parts.length!==2||!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(parts[0])||!/^[A-Za-z0-9_]{1,64}$/.test(parts[1])||url.pathname!=='/'+parts.join('/')||[...url.searchParams.keys()].length!==1||url.searchParams.get('startapp')!==v.startParam)return invalid();
 }
 return {kind:'challenge',challengeId:v.challengeId,startParam:v.startParam,expiresAt:v.expiresAt,miniAppUrl:v.miniAppUrl as string|null,state:'pending',...(typeof v.widgetBotUsername==='string'?{widgetBotUsername:v.widgetBotUsername}:{})};
}
export function checkedAccountStatus(value:unknown,id:string):AccountChallengeStatus{
 const v=closed(value,['kind','challengeId','state','expiresAt'],['accountLabel']);
 if(v.kind!=='challenge_status'||v.challengeId!==id||!uuid(v.challengeId)||!instant(v.expiresAt)||!['pending','ready_for_confirmation','linked','expired'].includes(String(v.state))||v.accountLabel!==undefined&&(typeof v.accountLabel!=='string'||!/^Telegram ••••\d{1,4}$/.test(v.accountLabel)||!['ready_for_confirmation','linked'].includes(String(v.state))))return invalid();
 return {kind:'challenge_status',challengeId:id,state:v.state as AccountChallengeStatus['state'],expiresAt:v.expiresAt,...(typeof v.accountLabel==='string'?{accountLabel:v.accountLabel}:{})};
}
export function checkedAccountMutation(value:unknown,operation:AccountOperation):AccountMutation{
 const v=closed(value,['kind','operationId','provider','linkId','authEpoch','reauthenticate']);
 if(operation.kind==='challenge'||v.kind!==(operation.kind==='link'?'linked':'unlinked')||v.operationId!==operation.request.id||!provider(v.provider)||operation.kind==='link'&&v.provider!=='telegram'||!text(v.linkId)||operation.kind==='unlink'&&v.linkId!==operation.request.linkId||!integer(v.authEpoch)||v.reauthenticate!==(operation.kind==='unlink'))return invalid();
 return {kind:v.kind as AccountMutation['kind'],operationId:v.operationId as string,provider:v.provider,linkId:v.linkId,authEpoch:v.authEpoch,reauthenticate:v.reauthenticate as boolean};
}
export function checkedAccountRecovery(value:unknown,operation:AccountOperation):{kind:'recovery';state:'not_recorded'}|{kind:'recovery';state:'recorded';result:AccountChallenge|AccountMutation}{
 const v=closed(value,['kind','state'],['result']);if(v.kind!=='recovery')return invalid();
 if(v.state==='not_recorded'&&!Object.hasOwn(v,'result'))return {kind:'recovery',state:'not_recorded'};
 if(v.state==='recorded')return {kind:'recovery',state:'recorded',result:operation.kind==='challenge'?checkedAccountChallenge(v.result):checkedAccountMutation(v.result,operation)};
 return invalid();
}
function checkedChallengeDraft(value:unknown):ChallengeDraft{const v=closed(value,['request','challenge'],['widgetProofAttempted']);if(Object.hasOwn(v,'widgetProofAttempted')&&v.widgetProofAttempted!==true)return invalid();const operation=checkedAccountOperation({kind:'challenge',request:v.request});return {request:operation.request,challenge:checkedAccountChallenge(v.challenge),...(v.widgetProofAttempted===true?{widgetProofAttempted:true as const}:{})};}
export function loadPendingAccountOperation(scope:DraftScope):AccountOperation|null{return loadDraft(PENDING,scope,value=>{const operation=checkedAccountOperation(value);if(operation.request.expectedSessionId!==scope.sessionId)return invalid();return operation;});}
/** Local hints select only a recovery screen. They never select the server owner. */
export interface AccountRecoveryHint {scope:DraftScope;operation:AccountOperation;storageToken:string}
export function readPendingAccountRecoveryHints(storage:Pick<DraftStorage,'getItem'>):AccountRecoveryHint[]{
 try{
  const raw=storage.getItem(PENDING_ACCOUNT_OPERATION_KEY);if(!raw||raw.length>65536)return [];
  const v=closed(JSON.parse(raw),['version','ownerId','sessionId','payload'],['generation']);
  if(v.version!==1||!text(v.ownerId)||!text(v.sessionId)||v.generation!==undefined&&!text(v.generation,128))return [];
  const operation=checkedAccountOperation(v.payload);if(operation.request.expectedSessionId!==v.sessionId)return [];
  return [{scope:{ownerId:v.ownerId,sessionId:v.sessionId},operation,storageToken:raw}];
 }catch{return [];}
}
interface ChallengeResetTicket {scope:DraftScope;operation:Extract<AccountOperation,{kind:'challenge'}>;pendingToken:string;challengeToken:string|null}
function challengeResetTicket(scope:DraftScope,operation:AccountOperation,pendingToken:string,storage=draftStorage()):ChallengeResetTicket|null{
 try{
  if(operation.kind!=='challenge'||operation.request.expectedSessionId!==scope.sessionId||readScopedDraftToken(PENDING,scope,storage)!==pendingToken)return null;
  if(JSON.stringify(checkedAccountOperation(JSON.parse(pendingToken).payload))!==JSON.stringify(operation))return null;
  const challengeToken=readScopedDraftToken(CHALLENGE,scope,storage);
  if(challengeToken!==null&&JSON.stringify(checkedChallengeDraft(JSON.parse(challengeToken).payload).request)!==JSON.stringify(operation.request))return null;
  return {scope:{...scope},operation:structuredClone(operation),pendingToken,challengeToken};
 }catch{return null;}
}
function resetTicketStillCurrent(ticket:ChallengeResetTicket):boolean{
 const current=challengeResetTicket(ticket.scope,ticket.operation,ticket.pendingToken);
 return current!==null&&current.challengeToken===ticket.challengeToken;
}
/** Only removes the exact local challenge attempt; it never calls a mutation. */
function abandonOldChallenge(ticket:ChallengeResetTicket):boolean{
 try{
  const storage=draftStorage();if(!storage||!resetTicketStillCurrent(ticket))return false;
  if(ticket.challengeToken!==null)clearScopedDraft(CHALLENGE,ticket.scope,storage,ticket.challengeToken);
  clearScopedDraft(PENDING,ticket.scope,storage,ticket.pendingToken);
  return storage.getItem(PENDING_ACCOUNT_OPERATION_KEY)===null&&(ticket.challengeToken===null||readScopedDraftToken(CHALLENGE,ticket.scope,storage)===null);
 }catch{return false;}
}
const CHALLENGE_RESET_CHANGED='Збережена спроба змінилася. Оновіть сторінку й перевірте її ще раз.';
const ACCOUNT_NOT_RECORDED_COPY='У цьому вході не знайдено підтвердження попередньої дії. Увійдіть у той самий акаунт.';
export function accountErrorMessage(code:unknown,status?:number):string{
 if(code==='ACCOUNT_ORIGINAL_SESSION_REQUIRED'&&status===409)return 'Це підтвердження можна відновити лише в початковому вході. Щоб продовжити, почніть підтвердження заново.';
 if(code==='ACCOUNT_LAST_LOGIN_REQUIRED')return 'Спочатку увійдіть іншим уже прив’язаним способом і підтвердьте, що він працює. Потім поверніться сюди для від’єднання.';
 if(code==='ACCOUNT_RECONCILIATION_REQUIRED')return 'Цей спосіб входу вже пов’язаний з акаунтом або має попередню прив’язку. Автоматично об’єднати акаунти не можна. Залиште чинні входи й зверніться до підтримки для перевірки.';
 if(code==='ACCOUNT_PROFILE_CHANGED')return 'Профіль змінився в іншому вікні або боті. Оновіть його й перевірте дію ще раз.';
 if(code==='ACCOUNT_AUTH_REQUIRED'||code==='ACCOUNT_SESSION_REVOKED')return 'Цей вхід уже не чинний. Якщо результат попередньої дії невідомий, спочатку перевірте його тут. Для нових дій потрібно увійти знову.';
 if(code==='ACCOUNT_CHALLENGE_EXPIRED')return 'П’ять хвилин для підтвердження минули. Почніть прив’язку ще раз у цьому браузері.';
 if(code==='ACCOUNT_DISABLED')return 'Керування способами входу зараз недоступне. Спробуйте оновити стан пізніше.';
 if(code==='ACCOUNT_PROOF_INVALID')return 'Не вдалося підтвердити дані Telegram. Поверніться до початкового браузера й почніть прив’язку ще раз.';
 if(code==='ACCOUNT_INVALID_REQUEST')return 'Не вдалося підтвердити цю дію. Оновіть стан акаунта й перевірте вибір.';
 if(code==='ACCOUNT_STORAGE_UNAVAILABLE')return 'Браузер не зберіг запит для відновлення. Дію ще не надіслано. Дозвольте зберігання даних для цього сайту й спробуйте знову.';
 if(typeof code==='string'&&/^ACCOUNT_.*_CONFLICT$/.test(code))return 'Дані або підтвердження змінилися. Оновіть стан акаунта й перевірте дію ще раз.';
 return 'Не вдалося підтвердити результат. Перевірте попередню дію перед повторенням.';
}
async function accountCall(path:string,body?:unknown):Promise<unknown>{
 let response:Response;try{response=await fetch(path,{credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});}catch{throw Error(accountErrorMessage(null));}
 let value:unknown;try{value=await response.json();}catch{throw Error(accountErrorMessage(null));}
 if(!response.ok){const code=plain(value)&&typeof value.code==='string'?value.code:undefined;throw Object.assign(Error(accountErrorMessage(code,response.status)),{code,status:response.status});}return value;
}
const label=(link:AccountLink)=>link.provider==='telegram'?'Telegram':'Replit';
function scopeValid(scope:AccountScope){return text(scope.ownerId)&&text(scope.sessionId)&&integer(scope.revision);}
export function AccountRecoveryOnly({hint,onSignIn,theme='light'}:{hint:AccountRecoveryHint;onSignIn:()=>void;theme?:'light'|'dark'}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[outcome,setOutcome]=useState<'recorded'|'not_recorded'|null>(null),[unlinked,setUnlinked]=useState(false);
 const [resetTicket,setResetTicket]=useState<ChallengeResetTicket|null>(null);
 const working=useRef(false),mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function recover(){
  if(working.current||outcome)return;working.current=true;setBusy(true);setError('');setResetTicket(null);
  let resetCandidate:ChallengeResetTicket|null=null;
  try{
   const token=readScopedDraftToken(PENDING,hint.scope);if(token!==hint.storageToken)throw Error('Збережений запит змінився. Оновіть сторінку, щоб перевірити попередню дію.');
   resetCandidate=challengeResetTicket(hint.scope,hint.operation,token);
   const result=checkedAccountRecovery(await accountCall('/api/product/accounts/recover',hint.operation),hint.operation);
   if(!mounted.current)return;
   if(result.state==='recorded'){clearScopedDraft(PENDING,hint.scope,undefined,hint.storageToken);setUnlinked(result.result.kind==='unlinked');setOutcome('recorded');}
   else setOutcome('not_recorded');
  }catch(e){if(mounted.current){const failure=e as {status?:number;code?:unknown};if(failure.status===409&&failure.code==='ACCOUNT_ORIGINAL_SESSION_REQUIRED'&&resetCandidate&&resetTicketStillCurrent(resetCandidate))setResetTicket(resetCandidate);setError(e instanceof Error?e.message:accountErrorMessage(null));}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 }
 function startAgain(){if(busy||!resetTicket)return;if(!abandonOldChallenge(resetTicket)){setResetTicket(null);setError(CHALLENGE_RESET_CHANGED);return;}setResetTicket(null);onSignIn();}
 return <main className={'pr-app pr-account-proof'+(theme==='dark'?' pr-dark':'')} data-design="district"><article className="pr-panel"><p className="pr-eyebrow">Світло Україна · Відновлення</p><h1>Перевірте попередню дію</h1>{outcome==='recorded'?<><p role="status">{unlinked?'Спосіб входу від’єднано. Сесії акаунта завершено.':'Результат попереднього запиту підтверджено.'}</p><p>{unlinked?'Увійдіть знову способом, що залишився прив’язаним.':'Для подальших дій увійдіть до свого профілю знову.'}</p></>:outcome==='not_recorded'?<p role="status">{ACCOUNT_NOT_RECORDED_COPY}</p>:<><p>Зараз вхід не підтверджено, а результат попередньої дії ще невідомий. У цій вкладці можна перевірити лише цей збережений запит.</p><p>Нові прив’язки, від’єднання та зміни профілю тут недоступні.</p>{error&&<p className="pr-account-message pr-account-warning" role="alert">{error}</p>}<button className="pr-primary" disabled={busy} onClick={()=>void recover()}>{busy?'Перевіряємо…':'Перевірити результат'}</button>{resetTicket&&<button className="pr-secondary" disabled={busy} onClick={startAgain}>Почати підтвердження заново</button>}</>}<button className="pr-secondary" disabled={busy} onClick={onSignIn}>Перейти до входу</button></article></main>;
}
export function LiveAccountSettings(props:LiveAccountSettingsProps){return <OwnedAccountSettings key={JSON.stringify([props.scope.ownerId,props.scope.sessionId])} {...props}/>;}
function OwnedAccountSettings({scope:liveScope,busy:outsideBusy=false,onRefreshProfile}:LiveAccountSettingsProps){
 const scope=useRef({ownerId:liveScope.ownerId,sessionId:liveScope.sessionId}).current,latest=useRef(liveScope);latest.current=liveScope;
 const mounted=useRef(true),working=useRef(false),sequence=useRef(0);
 const [data,setData]=useState<AccountList|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reauthenticate,setReauthenticate]=useState(false),[sessionExpired,setSessionExpired]=useState(false);
 const [pending,setPending]=useState<AccountOperation|null>(()=>loadPendingAccountOperation(scope));
 const [active,setActive]=useState<ChallengeDraft|null>(()=>loadDraft(CHALLENGE,scope,value=>{const draft=checkedChallengeDraft(value);if(draft.request.expectedSessionId!==scope.sessionId)return invalid();return draft;}));
 const [status,setStatus]=useState<AccountChallengeStatus|null>(null),[retryAllowed,setRetryAllowed]=useState(false),[now,setNow]=useState(Date.now());
 const [resetTicket,setResetTicket]=useState<ChallengeResetTicket|null>(null);
 const [unlink,setUnlink]=useState<{link:AccountLink;revision:number}|null>(null),[unlinkConsent,setUnlinkConsent]=useState(false),[linkConsent,setLinkConsent]=useState(false);
 const pendingRef=useRef(pending);pendingRef.current=pending;
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;++sequence.current;};},[]);
 async function refresh(){if(!scopeValid(latest.current))return;const seq=++sequence.current;try{const next=checkedAccountList(await accountCall('/api/product/accounts'));if(mounted.current&&seq===sequence.current){setData(next);setError('');}}catch(e){if(mounted.current&&seq===sequence.current){if((e as {status?:number}).status===401)setSessionExpired(true);setError(e instanceof Error?e.message:accountErrorMessage(null));}}}
 useEffect(()=>{void refresh();},[liveScope.revision]);
 useEffect(()=>{if(!active)return;const tick=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(tick);},[active?.challenge.challengeId]);
 const pendingToken=()=>readScopedDraftToken(PENDING,scope);
 function clearPending(operation:AccountOperation,token:string|null){clearScopedDraft(PENDING,scope,undefined,token);if(mounted.current&&pendingRef.current?.request.id===operation.request.id){pendingRef.current=null;setPending(null);setRetryAllowed(false);}}
 function storedMatches(operation:AccountOperation){try{const token=pendingToken();return token!==null&&JSON.stringify(checkedAccountOperation(JSON.parse(token).payload))===JSON.stringify(operation);}catch{return false;}}
 async function accept(operation:AccountOperation,result:AccountChallenge|AccountMutation,token:string|null){
  if(!mounted.current)return;
  if(result.kind==='challenge'){
   const draft={request:operation.request,challenge:result};
   if(!saveDraft(CHALLENGE,scope,draft))throw Error('Результат отримано, але браузер не зберіг підтвердження. Перевірте цю саму дію ще раз.');
   clearPending(operation,token);if(mounted.current){setActive(draft);setStatus(null);setLinkConsent(false);setNotice(result.widgetBotUsername?'Спробу підготовлено. Підтвердьте свій Telegram у цьому браузері.':result.miniAppUrl?'Посилання підготовлено. Відкрийте Telegram і підтвердьте володіння акаунтом.':'Прив’язка Telegram зараз недоступна: підтверджене посилання Mini App ще не налаштовано.');}return;
  }
  clearPending(operation,token);clearScopedDraft(CHALLENGE,scope);
  if(!mounted.current)return;setActive(null);setStatus(null);setUnlink(null);setLinkConsent(false);setUnlinkConsent(false);
  if(result.reauthenticate){++sequence.current;setData(null);setReauthenticate(true);setNotice('Спосіб входу від’єднано. Сесії акаунта завершено. Увійдіть знову способом, що залишився.');}
  else{setNotice('Telegram прив’язано до вашого акаунта.');await refresh();void onRefreshProfile?.();}
 }
 async function commit(operation:AccountOperation,retry=false){
  if(working.current||!mounted.current||outsideBusy||sessionExpired||!scopeValid(latest.current))return;
  working.current=true;setBusy(true);setError('');setNotice('');
  try{
   if(!retry&&!saveDraft(PENDING,scope,operation))throw Object.assign(Error(accountErrorMessage('ACCOUNT_STORAGE_UNAVAILABLE')),{local:true});
   const token=pendingToken();if(token===null||!storedMatches(operation))throw Object.assign(Error(accountErrorMessage('ACCOUNT_STORAGE_UNAVAILABLE')),{local:true});
   pendingRef.current=operation;setPending(operation);setRetryAllowed(false);
   const path=operation.kind==='challenge'?'/telegram/challenge':operation.kind==='link'?'/telegram/confirm':'/unlink';
   try{const value=await accountCall('/api/product/accounts'+path,operation.request);const result=operation.kind==='challenge'?checkedAccountChallenge(value):checkedAccountMutation(value,operation);await accept(operation,result,token);}
   catch(e){
    const v=e as {status?:number;code?:unknown};
    if(v.status===401&&mounted.current)setSessionExpired(true);
    if((v.status===400&&['ACCOUNT_INVALID_REQUEST','ACCOUNT_PROOF_INVALID'].includes(String(v.code)))||(v.status===409&&typeof v.code==='string'&&(/^ACCOUNT_.*_(?:CONFLICT|EXPIRED)$/.test(v.code)||['ACCOUNT_RECONCILIATION_REQUIRED','ACCOUNT_LAST_LOGIN_REQUIRED','ACCOUNT_PROFILE_CHANGED'].includes(v.code)))){clearPending(operation,token);if(mounted.current){setUnlink(null);setUnlinkConsent(false);setLinkConsent(false);if(operation.kind==='link')setStatus(null);void onRefreshProfile?.();}}
    throw e;
   }
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:accountErrorMessage(null));}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 }
 async function recover(){
  const operation=pendingRef.current;if(!operation||working.current||outsideBusy)return;working.current=true;setBusy(true);setError('');setResetTicket(null);setRetryAllowed(false);
  let resetCandidate:ChallengeResetTicket|null=null;
  try{const token=pendingToken();if(token===null||!storedMatches(operation))throw Error('Збережений запит змінився. Оновіть сторінку, щоб перевірити його.');
   resetCandidate=challengeResetTicket(scope,operation,token);
   const result=checkedAccountRecovery(await accountCall('/api/product/accounts/recover',operation),operation);
   if(result.state==='recorded')await accept(operation,result.result,token);
   else if(mounted.current){setRetryAllowed(!sessionExpired);setNotice(ACCOUNT_NOT_RECORDED_COPY);}
  }catch(e){if(mounted.current){const failure=e as {status?:number;code?:unknown};if(failure.status===409&&failure.code==='ACCOUNT_ORIGINAL_SESSION_REQUIRED'&&resetCandidate&&resetTicketStillCurrent(resetCandidate))setResetTicket(resetCandidate);setError(e instanceof Error?e.message:accountErrorMessage(null));}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 }
 async function inspect(){if(!active||working.current||pending||outsideBusy)return;working.current=true;setBusy(true);setError('');setLinkConsent(false);
  try{const result=checkedAccountStatus(await accountCall('/api/product/accounts/telegram/challenge/'+encodeURIComponent(active.challenge.challengeId)),active.challenge.challengeId);if(mounted.current){setStatus(result);if(result.state==='linked'){setNotice('Прив’язку вже завершено.');await refresh();}}}
  catch(e){if(mounted.current)setError(e instanceof Error?e.message:accountErrorMessage(null));}finally{working.current=false;if(mounted.current)setBusy(false);}
 }
 async function submitWidgetProof(telegramData:unknown){
  if(!active?.challenge.widgetBotUsername||working.current||pending||outsideBusy||sessionExpired||reauthenticate||active.widgetProofAttempted||Date.parse(active.challenge.expiresAt)<=Date.now()||active.request.expectedRevision!==latest.current.revision)return;
  working.current=true;setBusy(true);setError('');setNotice('');setLinkConsent(false);
  try{
   // Save only a scoped attempt marker before sending. Never persist the provider payload.
   const marked={...active,widgetProofAttempted:true as const};
   if(!saveDraft(CHALLENGE,scope,marked))throw Error(accountErrorMessage('ACCOUNT_STORAGE_UNAVAILABLE'));
   setActive(marked);
   let failure:unknown;
   try{
    const result=closed(await accountCall('/api/product/accounts/telegram/widget-proof',{challengeId:active.challenge.challengeId,telegramData}),['kind','state']);
    if(result.kind!=='proof'||result.state!=='ready_for_confirmation')invalid();
   }catch(e){failure=e;if((e as {status?:number}).status===401&&mounted.current)setSessionExpired(true);}
   // A failed/lost acknowledgement may follow a committed proof. Read its original challenge, never replay it automatically.
   const next=checkedAccountStatus(await accountCall('/api/product/accounts/telegram/challenge/'+encodeURIComponent(active.challenge.challengeId)),active.challenge.challengeId);
   if(mounted.current){setStatus(next);if(next.state==='ready_for_confirmation')setNotice('Telegram підтверджено. Перевірте акаунт і окремо завершіть прив’язку.');else if(next.state==='linked'){setNotice('Прив’язку вже завершено.');await refresh();}else setError(failure instanceof Error?failure.message:'Підтвердження ще не надійшло. Перевірте стан перед новою спробою.');}
  }catch(e){if(mounted.current){if((e as {status?:number}).status===401)setSessionExpired(true);setError(e instanceof Error?e.message:accountErrorMessage(null));}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 }
 function request():BaseRequest{return {id:crypto.randomUUID(),expectedSessionId:scope.sessionId,expectedRevision:latest.current.revision};}
 const disabled=busy||outsideBusy||Boolean(pending)||reauthenticate||sessionExpired||!scopeValid(liveScope),expired=Boolean(active&&(Date.parse(active.challenge.expiresAt)<=now||status?.state==='expired'));
 const staleChallenge=Boolean(active&&active.request.expectedRevision!==liveScope.revision),staleUnlink=Boolean(unlink&&(unlink.revision!==liveScope.revision||!data?.links.some(l=>l.id===unlink.link.id&&l.linkRevision===unlink.link.linkRevision)));
 const ready=Boolean(active&&!expired&&!staleChallenge&&status?.state==='ready_for_confirmation');
 function discardChallenge(){if(disabled)return;clearScopedDraft(CHALLENGE,scope);setActive(null);setStatus(null);setLinkConsent(false);setError('');setNotice('');}
 function startChallengeAgain(){
  if(busy||outsideBusy||!resetTicket||scope.ownerId!==latest.current.ownerId||scope.sessionId!==latest.current.sessionId)return;
  if(!abandonOldChallenge(resetTicket)){setResetTicket(null);setError(CHALLENGE_RESET_CHANGED);return;}
  pendingRef.current=null;setPending(null);setActive(null);setStatus(null);setResetTicket(null);setRetryAllowed(false);setLinkConsent(false);setError('');setNotice('Попередню спробу закрито в цій вкладці. Почніть підтвердження ще раз.');
 }
 return <section className="pr-tools pr-account-settings" data-testid="live-accounts"><div className="pr-section-intro"><div><h2>Акаунти й вхід</h2><p>Керуйте способами входу до свого профілю.</p></div><button className="pr-secondary" disabled={busy||outsideBusy||reauthenticate} onClick={()=>void refresh()}>Оновити стан</button></div>
 {error&&<p className="pr-account-message pr-account-warning" role="alert">{error}</p>}{notice&&<p className="pr-account-message" role="status">{notice}</p>}
 {sessionExpired&&!reauthenticate&&<p className="pr-account-message">Для нових дій потрібно увійти знову. Якщо попередній результат невідомий, спочатку перевірте його в цій вкладці.</p>}
 {pending&&<article className="pr-panel pr-tool-panel pr-account-pending" aria-label="Непідтверджена дія"><h3>Перевірте попередню дію</h3><p>Її результат ще невідомий. Нові дії тимчасово недоступні. Залишайтеся в цьому браузері, щоб перевірити результат.</p><button className="pr-primary" disabled={busy||outsideBusy} onClick={()=>retryAllowed?void commit(pending,true):void recover()}>{busy?'Перевіряємо…':retryAllowed?'Повторити той самий запит':'Перевірити результат'}</button>{resetTicket&&<button className="pr-secondary" disabled={busy||outsideBusy} onClick={startChallengeAgain}>Почати підтвердження заново</button>}</article>}
 {reauthenticate?<article className="pr-panel pr-tool-panel"><h3>Потрібно увійти знову</h3><p>Скористайтеся способом входу, який залишився прив’язаним.</p><a className="pr-primary" href="/">Перейти до входу</a></article>:<>
 <article className="pr-panel pr-tool-panel"><h3>Пов’язані способи входу</h3>{!data?<p role={error?undefined:'status'}>{error?'Список зараз недоступний. Це не означає, що прив’язаних входів немає.':'Отримуємо способи входу…'}</p>:data.links.length?<ul className="pr-account-list">{data.links.map((l,i)=><li key={l.id}><div><strong>{label(l)}{data.links.filter(a=>a.provider===l.provider).length>1?' · '+(i+1):''}</strong><span>Пов’язано з вашим профілем</span></div><button className="pr-secondary" disabled={disabled||data.links.length<2} onClick={()=>{setUnlink({link:l,revision:liveScope.revision});setUnlinkConsent(false);}}>Від’єднати<span className="pr-account-sr"> {label(l)}</span></button></li>)}</ul>:<p>Пов’язаних способів входу не знайдено. Оновіть стан або увійдіть знову, перш ніж змінювати акаунт.</p>}
 {data&&data.links.length===1&&<p className="pr-field-note">Це єдиний пов’язаний спосіб входу. Перш ніж від’єднати його, потрібно додати й перевірити інший.</p>}</article>
 {!data?.links.some(l=>l.provider==='telegram')&&<article className="pr-panel pr-tool-panel"><h3>Додати Telegram</h3><p>Ваші адреси й налаштування залишаться в цьому профілі. Прив’язка потребує підтвердження Telegram і окремого завершення в цьому браузері. Спроба діє п’ять хвилин.</p>
 {!active?<button className="pr-primary" disabled={disabled||!data||data.links.length===0} onClick={()=>void commit({kind:'challenge',request:request()})}>Почати прив’язку Telegram</button>:<>
 {!ready&&<ol className="pr-account-steps"><li>{active.challenge.widgetBotUsername?'Підтвердьте свій акаунт кнопкою Telegram нижче.':'Відкрийте посилання й підтвердьте свій Telegram.'}</li><li>{active.challenge.widgetBotUsername?'Залишайтеся в цій вкладці браузера.':'Поверніться саме до цієї вкладки браузера.'}</li><li>Перевірте підтвердження й завершіть прив’язку.</li></ol>}
 {expired?<p className="pr-account-message pr-account-warning" role="status">Час підтвердження минув. Почніть прив’язку ще раз.</p>:staleChallenge?<p className="pr-account-message pr-account-warning" role="status">Профіль змінився. Почніть прив’язку ще раз із поточними даними.</p>:active.challenge.widgetBotUsername?<><p className="pr-field-note">Підтвердіть до {new Date(active.challenge.expiresAt).toLocaleTimeString('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit'})} за київським часом.</p>{!ready&&<AccountTelegramWidget key={active.challenge.challengeId} botUsername={active.challenge.widgetBotUsername} submitted={Boolean(active.widgetProofAttempted)} disabled={disabled} onProof={submitWidgetProof}/>}<button className="pr-secondary" disabled={disabled} onClick={()=>void inspect()}>Перевірити підтвердження</button></>:active.challenge.miniAppUrl?<><p className="pr-field-note">Підтвердіть до {new Date(active.challenge.expiresAt).toLocaleTimeString('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit'})} за київським часом.</p><div className="pr-settings-actions"><a className="pr-primary" href={active.challenge.miniAppUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Відкрити Telegram</a><button className="pr-secondary" disabled={disabled} onClick={()=>void inspect()}>Перевірити підтвердження</button></div></>:<p className="pr-account-message pr-account-warning">Прив’язка Telegram зараз недоступна: підтверджене посилання Mini App ще не налаштовано. Спробуйте пізніше.</p>}
 {status?.state==='pending'&&!expired&&<p role="status">{active.challenge.widgetBotUsername?'Підтвердження Telegram поки не зафіксовано. Перевірте стан у цій вкладці перед новою спробою.':'Підтвердження від Telegram ще не надійшло. Після підтвердження поверніться сюди й перевірте знову.'}</p>}
 {ready&&<div className="pr-account-final"><h4>Telegram підтверджено</h4><p>{status?.accountLabel||'Ваш Telegram'} готовий до прив’язки. Перевірте, що це ваш акаунт.</p><label className="pr-account-consent"><input type="checkbox" checked={linkConsent} disabled={disabled} onChange={e=>setLinkConsent(e.target.checked)}/><span>Підтверджую прив’язку цього Telegram до мого профілю.</span></label><button className="pr-primary" disabled={disabled||!linkConsent} onClick={()=>{if(ready&&linkConsent&&active)void commit({kind:'link',request:{...request(),challengeId:active.challenge.challengeId,confirmed:true}});}}>Завершити прив’язку</button></div>}
 <button className="pr-text-button" disabled={disabled} onClick={discardChallenge}>{expired||staleChallenge?'Почати знову':'Закрити цю спробу'}</button></>}
 </article>}</>}
 {unlink&&<Modal title={'Від’єднати '+label(unlink.link)+'?'} busy={busy} onClose={()=>{if(!busy){setUnlink(null);setUnlinkConsent(false);}}}><p>Вхід через {label(unlink.link)} більше не відкриватиме цей профіль. Усі сесії акаунта завершаться. Після цього потрібно знову увійти іншим прив’язаним способом.</p><p>Спочатку переконайтеся, що інший спосіб входу працює. Якщо його ще не підтверджено, від’єднання буде недоступне.</p>{staleUnlink&&<p role="alert">Дані змінилися. Закрийте підтвердження й перевірте список ще раз.</p>}<label className="pr-account-consent"><input type="checkbox" checked={unlinkConsent} disabled={disabled||staleUnlink} onChange={e=>setUnlinkConsent(e.target.checked)}/><span>Підтверджую від’єднання {label(unlink.link)} й повторний вхід.</span></label><div className="pr-modal-actions"><button className="pr-secondary" disabled={busy} onClick={()=>setUnlink(null)}>Скасувати</button><button className="pr-primary" disabled={disabled||staleUnlink||!unlinkConsent} onClick={()=>{if(unlinkConsent&&!staleUnlink)void commit({kind:'unlink',request:{...request(),linkId:unlink.link.id,linkRevision:unlink.link.linkRevision,confirmed:true}});}}>Від’єднати</button></div></Modal>}
 </section>;
}
