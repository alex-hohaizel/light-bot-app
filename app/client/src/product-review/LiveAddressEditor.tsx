import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,MapPin,Search,X} from 'lucide-react';
import type {AddressOption} from '@shared/bot/types';
import {addressOptionFingerprint} from '@shared/address-selection';
import {houseMatchesQuery,houseLookalikeSuggestion,normalizeAddressText} from '@shared/address-index';
import {validInstant} from '@shared/schedule-core';
import type {AddressSearchResult,AddressCandidateResult} from '../../../server/production/address-catalog';
import {AddressEditor,type AddressEditorProps} from './AddressEditor';
import {loadDraft,saveDraft,clearScopedDraft,readScopedDraftToken,type DraftScope} from './ux-drafts';
import {pageItems,optionConsentToken} from './address-editor-model';

export interface LiveAddressLookupRequest {
 id:string;expectedSessionId:string;expectedRevision:number;operation:'streets'|'houses'|'resolve';
 query?:string;streetSnapshotId?:string;streetId?:number;houseSnapshotId?:string;houseId?:number;directoryId?:'yasno:25/902';
}
export type LiveAddressLookupResult=AddressSearchResult|AddressCandidateResult;
export type LiveAddressLookup=(request:LiveAddressLookupRequest)=>Promise<LiveAddressLookupResult>;
export interface LiveAddressEditorProps extends Omit<AddressEditorProps,'mode'|'draftScope'|'reviewSelection'|'onRefreshCatalog'> {
 scope:DraftScope&{revision:number};lookup:LiveAddressLookup;
}
interface Item {id:number;value:string}
export interface LiveAddressSearchSnapshot {id:string;operation:'streets'|'houses';namespace:'yasno:25/902';observedAt:string;expiresAt:string;items:Item[];streetId?:number}
interface LookupDraft {revision:number;streetQuery:string;houseQuery:string;streets:LiveAddressSearchSnapshot|null;houses:LiveAddressSearchSnapshot|null;street:Item|null;pending:LiveAddressLookupRequest|null}
type Status='idle'|'loading'|'available'|'empty'|'deferred'|'unavailable'|'stale'|'disabled';
const DIRECTORY='yasno:25/902' as const;
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const txt=(v:unknown,max=4096)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const invalid=():never=>{throw Error('LIVE_ADDRESS_RESULT_INVALID');};
const current=(v:{expiresAt:string}|null,now:number)=>Boolean(v&&Date.parse(v.expiresAt)>now);
export function checkedLiveAddressSnapshot(value:unknown,operation:'streets'|'houses',streetId?:number):LiveAddressSearchSnapshot{
 if(!plain(value)||!uuid(value.id)||value.operation!==operation||value.namespace!==DIRECTORY||!validInstant(value.observedAt)||!validInstant(value.expiresAt)||Date.parse(value.expiresAt)<=Date.parse(value.observedAt)||!Array.isArray(value.items)||value.items.length>2048||operation==='houses'&&value.streetId!==streetId)return invalid();
 const ids=new Set<number>();const items=value.items.map((v:unknown)=>{if(!plain(v)||!positive(v.id)||!txt(v.value)||!v.value.trim()||ids.has(v.id))return invalid();ids.add(v.id);return {id:v.id,value:v.value};});
 return {id:value.id,operation,namespace:DIRECTORY,observedAt:value.observedAt,expiresAt:value.expiresAt,items,...(operation==='houses'?{streetId}:{})};
}
function checkedPending(value:unknown):LiveAddressLookupRequest{
 if(!plain(value)||Object.keys(value).some(k=>!['id','expectedSessionId','expectedRevision','operation','query','streetSnapshotId','streetId','houseSnapshotId','houseId','directoryId'].includes(k))||typeof value.id!=='string'||!/^[A-Za-z0-9_.:-]{1,96}$/.test(value.id)||!txt(value.expectedSessionId,128)||!value.expectedSessionId||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||!['streets','houses','resolve'].includes(value.operation)||value.directoryId!==DIRECTORY)return invalid();
 if(value.operation!=='resolve'&&(!txt(value.query,100)||!value.query.trim()))return invalid();if(value.operation!=='streets'&&(!uuid(value.streetSnapshotId)||!positive(value.streetId)))return invalid();if(value.operation==='resolve'&&(!uuid(value.houseSnapshotId)||!positive(value.houseId)))return invalid();
 return structuredClone(value) as LiveAddressLookupRequest;
}
function parseDraft(v:unknown):LookupDraft{
 if(!plain(v)||Object.keys(v).some(k=>!['revision','streetQuery','houseQuery','streets','houses','street','pending'].includes(k))||!Number.isSafeInteger(v.revision)||v.revision<0||!txt(v.streetQuery,100)||!txt(v.houseQuery,100))return invalid();
 const streets=v.streets===null?null:checkedLiveAddressSnapshot(v.streets,'streets');
 const street=v.street===null?null:plain(v.street)&&positive(v.street.id)&&txt(v.street.value)&&streets?.items.some(i=>i.id===v.street.id&&i.value===v.street.value)?{id:v.street.id,value:v.street.value}:invalid();
 const houses=v.houses===null?null:street?checkedLiveAddressSnapshot(v.houses,'houses',street.id):invalid();
 return {revision:v.revision,streetQuery:v.streetQuery,houseQuery:v.houseQuery,streets,houses,street,pending:v.pending===null?null:checkedPending(v.pending)};
}
export function liveAddressLookupMessage(code:unknown,status:Status):string{
 if(code==='PRODUCTION_PROFILE_REVISION_CONFLICT')return 'Профіль змінився в іншому вікні або боті. Оновіть його й почніть пошук ще раз.';
 if(code==='ADDRESS_FLOW_SELECTION_CHANGED'||code==='ADDRESS_STALE_SNAPSHOT'||status==='stale')return 'Час дії результатів минув або вибір змінився. Знайдіть вулицю й будинок ще раз.';
 if(code==='ADDRESS_FLOW_INVALID_INPUT'||code==='ADDRESS_INVALID_REQUEST')return 'Перевірте запит: назву вулиці введіть щонайменше двома літерами, номер будинку — точно як у документах.';
 if(code==='LIVE_ADDRESS_STORAGE_UNAVAILABLE')return 'Браузер не зберіг чернетку. Пошук ще не надіслано. Дозвольте зберігання даних для цього сайту або спробуйте інший браузер.';
 if(status==='deferred')return 'Оператор просить зачекати перед наступним пошуком. Введені дані збережено, повторювати запит зараз не потрібно.';
 if(status==='empty')return 'За цим запитом результатів немає. Перевірте написання або спробуйте іншу частину назви. Це не означає, що адреси не існує.';
 if(status==='disabled')return 'Адресний пошук зараз недоступний. Чинні адреси й налаштування збережено.';
 return 'Не вдалося підтвердити результат пошуку. Дані не замінювалися. Спробуйте ще раз тим самим запитом.';
}
function intent(request:LiveAddressLookupRequest):string{const {id:_id,...rest}=request;return JSON.stringify(rest);}
function scopeEqual(a:LiveAddressEditorProps['scope'],b:LiveAddressEditorProps['scope']){return a.ownerId===b.ownerId&&a.sessionId===b.sessionId&&a.revision===b.revision;}
export function LiveAddressEditor(props:LiveAddressEditorProps){return <OwnedLiveAddressEditor key={JSON.stringify([props.scope.ownerId,props.scope.sessionId,props.initial?.id??null])} {...props}/>;}
function OwnedLiveAddressEditor({scope:liveScope,lookup,initial,catalog,operatorLabels,manualGroupHref,saving=false,retrying=false,onRetry,onSave,onClose}:LiveAddressEditorProps){
 const scope=useRef<DraftScope>({ownerId:liveScope.ownerId,sessionId:liveScope.sessionId}).current,initialRevision=useRef(liveScope.revision).current,latest=useRef(liveScope);latest.current=liveScope;
 const kind='provider-address:'+ (initial?.id??'new'),mounted=useRef(true),generation=useRef(0),working=useRef(false),saveInFlight=useRef(false),dialog=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null);
 const [restored]=useState(()=>loadDraft(kind,scope,parseDraft));const recovered=restored?.revision===liveScope.revision?restored:null;
 const [streetQuery,setStreetQuery]=useState(recovered?.streetQuery??initial?.street??''),[houseQuery,setHouseQuery]=useState(recovered?.houseQuery??'');
 const [streets,setStreets]=useState<LiveAddressSearchSnapshot|null>(recovered&&current(recovered.streets,Date.now())?recovered.streets:null),[street,setStreet]=useState<Item|null>(recovered&&current(recovered.streets,Date.now())?recovered.street:null),[houses,setHouses]=useState<LiveAddressSearchSnapshot|null>(recovered&&current(recovered.streets,Date.now())&&current(recovered.houses,Date.now())?recovered.houses:null);
 const [stage,setStage]=useState<'streets'|'houses'|'review'|'cache'>(recovered?.street&&current(recovered.streets,Date.now())?'houses':'streets'),[status,setStatus]=useState<Status>('idle'),[message,setMessage]=useState(''),[retryAt,setRetryAt]=useState<string|null>(null),[page,setPage]=useState(0),[stored,setStored]=useState(true),[tick,setTick]=useState(Date.now());
 const [resolved,setResolved]=useState<{option:AddressOption;expiresAt:string;capturedScope:typeof liveScope}|null>(null);
 const canonicalMatches=resolved?catalog?.filter(o=>o.id===resolved.option.id)??[]:[],canonicalReady=Boolean(resolved&&canonicalMatches.length===1&&optionConsentToken(canonicalMatches[0])===optionConsentToken(resolved.option));
 const pending=useRef<LiveAddressLookupRequest|null>(recovered?.pending??null),completed=useRef(false),requests=useRef(new Map<string,LiveAddressLookupRequest>());
 if(pending.current&&!requests.current.size)requests.current.set(intent(pending.current),pending.current);
 const closeRef=useRef(onClose);closeRef.current=onClose;const closeAction=useRef<()=>void>(()=>{});closeAction.current=()=>{if(saving||saveInFlight.current)return;persist();closeRef.current();};
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;++generation.current;};},[]);
 useEffect(()=>{const timer=setInterval(()=>setTick(Date.now()),500);return()=>clearInterval(timer);},[]);
 const draft=():LookupDraft=>({revision:liveScope.revision,streetQuery,houseQuery,streets,houses,street,pending:pending.current});
 function persist(payload=draft()){const ok=saveDraft(kind,scope,payload);if(mounted.current)setStored(ok);return ok;}
 useEffect(()=>{persist();},[streetQuery,houseQuery,streets,houses,street,liveScope.revision]);
 useEffect(()=>{if(liveScope.revision===initialRevision)return;++generation.current;working.current=false;setResolved(null);setStreets(null);setStreet(null);setHouses(null);setStage('streets');setStatus('stale');setMessage(liveAddressLookupMessage('PRODUCTION_PROFILE_REVISION_CONFLICT','stale'));},[liveScope.revision]);
 useEffect(()=>{if(stage==='review'&&resolved&&!current(resolved,tick)&&!saveInFlight.current){setResolved(null);setStage('houses');setStatus('stale');setMessage(liveAddressLookupMessage(null,'stale'));}},[tick,resolved,stage]);
 useEffect(()=>{heading.current?.focus();},[stage]);
 useEffect(()=>{if(stage==='review'&&canonicalReady||stage==='cache')return;const prior=document.activeElement as HTMLElement|null;const trap=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();closeAction.current();}if(e.key==='Tab'&&dialog.current){const controls=[...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')].filter(el=>el.offsetParent!==null),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',trap);return()=>{document.removeEventListener('keydown',trap);prior?.focus();};},[stage,canonicalReady]);
 function close(){if(saving||saveInFlight.current)return;persist();onClose();}
 function invalidate(){++generation.current;setResolved(null);setStatus('idle');setMessage('');setRetryAt(null);setPage(0);}
 async function search(operation:'streets'|'houses'|'resolve',house?:Item){
  if(working.current||saving||!mounted.current)return;
  const now=Date.now();if(operation!=='streets'&&(!street||!current(streets,now))||operation==='resolve'&&(!house||!current(houses,now))){setStatus('stale');setMessage(liveAddressLookupMessage(null,'stale'));return;}
  if(operation!=='resolve'){try{if(normalizeAddressText(operation==='streets'?streetQuery:houseQuery).length<(operation==='streets'?2:1))throw Error('query');}catch{setStatus('unavailable');setMessage(liveAddressLookupMessage('ADDRESS_FLOW_INVALID_INPUT','unavailable'));return;}}
  const captured={...liveScope},base:LiveAddressLookupRequest={id:'',expectedSessionId:captured.sessionId,expectedRevision:captured.revision,operation,directoryId:DIRECTORY,...(operation==='resolve'?{}:{query:(operation==='streets'?streetQuery:houseQuery).trim()}),...(operation!=='streets'?{streetSnapshotId:streets!.id,streetId:street!.id}:{}),...(operation==='resolve'?{houseSnapshotId:houses!.id,houseId:house!.id}:{})};
  const key=intent(base);let request=requests.current.get(key);
  if(completed.current&&status==='stale'){requests.current.delete(key);request=undefined;}
  request??={...base,id:crypto.randomUUID()};pending.current=request;requests.current.set(key,request);if(requests.current.size>20)requests.current.delete(requests.current.keys().next().value!);
  if(!persist({...draft(),pending:request})){setStatus('unavailable');setMessage(liveAddressLookupMessage('LIVE_ADDRESS_STORAGE_UNAVAILABLE','unavailable'));return;}
  const sequence=++generation.current;working.current=true;completed.current=false;setStatus('loading');setMessage('');setRetryAt(null);
  try{
   const result=await lookup(structuredClone(request));if(!mounted.current||sequence!==generation.current||!scopeEqual(captured,latest.current))return;
   if(!plain(result)||typeof result.state!=='string')return invalid();
   if(result.state!=='available'){
    const state:Status=result.state==='deferred'?'deferred':result.state==='stale'?'stale':result.state==='disabled'||result.state==='unsupported'?'disabled':'unavailable';completed.current=state==='stale';setStatus(state);setMessage(liveAddressLookupMessage(result.code,state));setRetryAt(validInstant(result.retryAt)?result.retryAt:null);return;
   }
   if(operation==='streets'||operation==='houses'){
    const snapshot=checkedLiveAddressSnapshot('snapshot'in result?result.snapshot:null,operation,street?.id);if(!current(snapshot,Date.now())||Date.parse(snapshot.observedAt)>Date.now())return invalid();
    if(operation==='houses'&&!current(streets,Date.now())){setStatus('stale');setMessage(liveAddressLookupMessage(null,'stale'));return;}
    if(operation==='streets'){setStreets(snapshot);setStreet(null);setHouses(null);setStage('streets');}else{setHouses(snapshot);setStage('houses');}
    completed.current=true;setPage(0);setStatus(snapshot.items.length?'available':'empty');setMessage(snapshot.items.length?'':liveAddressLookupMessage(null,'empty'));
   }else{
    if(!current(streets,Date.now())||!current(houses,Date.now())||!('option'in result)||!validInstant(result.expiresAt)||Date.parse(result.expiresAt)<=Date.now())return invalid();
    const option=result.option,fp=addressOptionFingerprint(option);
    if(!fp||option.binding.namespace!==DIRECTORY||option.binding.operatorId!=='dtek-kem'||option.binding.addressId!==option.address.id||option.address.locality!=='Київ'||option.address.localityId!=='source:yasno:25/902:locality:kyiv'||option.address.streetId!==`source:yasno:25/902:street:${street!.id}`||option.address.street!==street!.value||!houseMatchesQuery(option.address.house.literal,house!.value))return invalid();
    const expiresAt=new Date(Math.min(Date.parse(result.expiresAt),Date.parse(streets!.expiresAt),Date.parse(houses!.expiresAt))).toISOString();setResolved({option:structuredClone(option),expiresAt,capturedScope:captured});completed.current=true;setStage('review');setStatus('available');
   }
  }catch(e){if(mounted.current&&sequence===generation.current&&scopeEqual(captured,latest.current)){const code=e&&typeof e==='object'&&typeof (e as {code?:unknown}).code==='string'?(e as {code:string}).code:undefined;const stale=(e as {status?:unknown}).status===409&&(code==='ADDRESS_FLOW_SELECTION_CHANGED'||code==='ADDRESS_STALE_SNAPSHOT');completed.current=stale;setStatus(stale?'stale':'unavailable');setMessage(liveAddressLookupMessage(typeof (e as {status?:unknown}).status==='number'&&Number((e as {status?:number}).status)>=500?undefined:code,stale?'stale':'unavailable'));}}
  finally{if(sequence===generation.current){working.current=false;if(mounted.current)setStatus(s=>s==='loading'?'unavailable':s);}}
 }
 const freshStreet=current(streets,tick),freshHouse=current(houses,tick),busy=status==='loading',retryHeld=retryAt!==null&&Date.parse(retryAt)>tick;
 const list=pageItems(stage==='houses'?houses?.items??[]:streets?.items??[],page);
 if(stage==='cache')return <AddressEditor initial={initial} catalog={catalog} mode="live" draftScope={scope} operatorLabels={operatorLabels} manualGroupHref={manualGroupHref} saving={saving} retrying={retrying} onRetry={onRetry} onClose={close} onSave={onSave}/>;
 if(stage==='review'&&resolved){
  const reviewCatalog=canonicalMatches,fp=addressOptionFingerprint(resolved.option);
  if(!canonicalReady)return <div className="pr-modal-scrim" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><div ref={dialog} className="pr-modal pr-address-editor" role="dialog" aria-modal="true" aria-labelledby="live-address-canonical-heading"><div className="pr-modal-top"><span className="pr-eyebrow">МОЯ АДРЕСА</span><button className="pr-icon-button" aria-label="Закрити" onClick={close}><X size={19}/></button></div><h2 id="live-address-canonical-heading" ref={heading} tabIndex={-1}>Перевірте результат пошуку</h2><p role="alert" className="pr-status-notice pr-warning">Не вдалося звірити цей будинок із поточними даними профілю. Збереження недоступне. Оновіть профіль або знайдіть будинок ще раз.</p><button className="pr-secondary" disabled={saving} onClick={()=>{invalidate();setStage('houses');}}>Повернутися до пошуку</button></div></div>;
  return <AddressEditor initial={initial} catalog={reviewCatalog} mode="live" draftScope={scope} reviewSelection={{optionId:resolved.option.id,bindingRevisionId:resolved.option.binding.revisionId,selectionFingerprint:fp}} operatorLabels={operatorLabels} manualGroupHref={manualGroupHref} saving={saving} retrying={retrying} onRetry={onRetry} onClose={close} onSave={async value=>{
   if(saveInFlight.current||!current(resolved,Date.now())||!scopeEqual(resolved.capturedScope,latest.current)||value.optionId!==resolved.option.id||value.selectionFingerprint!==fp)throw Object.assign(Error('selection changed'),{code:'PROFILE_SELECTION_CHANGED'});
   saveInFlight.current=true;const token=readScopedDraftToken(kind,scope);try{await onSave(value);if(mounted.current)clearScopedDraft(kind,scope,undefined,token);}finally{saveInFlight.current=false;}
  }}/>;
 }
 return <div className="pr-modal-scrim" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><div ref={dialog} className="pr-modal pr-address-editor" role="dialog" aria-modal="true" aria-labelledby="live-address-heading" data-testid="live-address-lookup"><div className="pr-modal-top"><span className="pr-eyebrow">МОЯ АДРЕСА</span><button className="pr-icon-button" aria-label="Закрити" disabled={saving} onClick={close}><X size={19}/></button></div><h2 id="live-address-heading">{initial?'Замінити будинок':'Додати адресу'}</h2><p className="pr-quiet-box"><strong>Київ · ДТЕК Київські електромережі</strong><br/>Пошук у публічному каталозі YASNO. Для інших операторів адресний пошук ще перевіряється. Чинні адреси залишаються у профілі.</p><h3 ref={heading} tabIndex={-1}>{stage==='houses'?'Знайдіть точний будинок':'Знайдіть свою вулицю'}</h3>
 {stored?<p className="pr-field-note">Назад і закриття зберігають пошук у цьому вікні. Чинна адреса не зміниться до вашого підтвердження.</p>:<p role="alert" className="pr-status-notice pr-warning">Браузер не підтвердив збереження чернетки. Залишайте вікно відкритим; перед новим пошуком потрібно дозволити зберігання даних.</p>}
 {stage==='houses'&&<p><strong>{street?.value}</strong></p>}
 <form className="pr-form-stack" onSubmit={e=>{e.preventDefault();void search(stage==='houses'?'houses':'streets');}}><label>{stage==='houses'?'Номер будинку':'Назва вулиці'}<div className="pr-input-icon"><Search size={17}/><input autoComplete="off" maxLength={100} disabled={busy||saving} value={stage==='houses'?houseQuery:streetQuery} onChange={e=>{invalidate();if(stage==='houses'){setHouseQuery(e.target.value);setHouses(null);}else{setStreetQuery(e.target.value);setStreets(null);setStreet(null);setHouses(null);}}}/></div></label><p className="pr-field-note">{stage==='houses'?'Номер, літера, дріб і корпус мають значення. Оберіть точне написання; найближчий номер не підставляємо.':'Вкажіть щонайменше дві літери. Запит до оператора надсилається тільки після натискання «Знайти».'}</p><button className="pr-primary" disabled={busy||saving||retryHeld||stage==='houses'&&!freshStreet} type="submit">{busy?'Шукаємо…':'Знайти'}</button></form>
 {message&&<div className="pr-status-notice pr-warning" role={status==='empty'?'status':'alert'}>{message}{retryAt&&<span> Спробуйте після {new Date(retryAt).toLocaleTimeString('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit'})}.</span>}</div>}
 {(stage==='houses'&&!freshStreet||stage==='houses'&&houses&&!freshHouse)&&<div role="alert" className="pr-status-notice pr-warning">Час дії результатів минув. Поверніться до пошуку вулиці й отримайте свіжі відомості.</div>}
 {list.items.length>0&&<><p role="status" className="pr-field-note">Знайдено {list.total}. Оберіть потрібний запис.</p><div className={stage==='houses'?'pr-house-grid':'pr-address-results'} aria-label={stage==='houses'?'Будинки оператора':'Вулиці оператора'}>{list.items.map(item=><button key={item.id} type="button" className={stage==='houses'?'':'pr-search-result'} disabled={busy||saving||!freshStreet||stage==='houses'&&!freshHouse} onClick={()=>{if(stage==='houses'){void search('resolve',item);}else{invalidate();setStreet(item);setHouses(null);setHouseQuery('');setStage('houses');}}}>{stage==='streets'&&<MapPin size={18}/>}<span><strong>{item.value}</strong>{stage==='houses'&&houseLookalikeSuggestion(item.value,houseQuery)&&<small>Схоже написання — перевірте літеру</small>}</span>{stage==='streets'&&<ArrowRight size={16}/>}</button>)}</div>{list.pages>1&&<nav className="pr-address-pager" aria-label="Сторінки результатів"><button className="pr-secondary" aria-label="Попередня сторінка" disabled={list.page===0} onClick={()=>setPage(p=>p-1)}><ArrowLeft size={16}/></button><span>{list.page+1} з {list.pages}</span><button className="pr-secondary" aria-label="Наступна сторінка" disabled={list.page+1>=list.pages} onClick={()=>setPage(p=>p+1)}><ArrowRight size={16}/></button></nav>}</>}
 {catalog?.length?<button type="button" className="pr-text-button" disabled={busy||saving} onClick={()=>{persist();setStage('cache');}}>Вибрати із завантажених адрес</button>:null}
 {manualGroupHref&&<details><summary>Потрібен інший населений пункт або оператор?</summary><p className="pr-field-note">У боті можна обрати опубліковану групу вручну. Це буде ваш вибір групи, а не підтвердження будинку.</p><a className="pr-text-button" href={manualGroupHref}>Відкрити бота</a></details>}
 <div className="pr-modal-actions"><button className="pr-secondary" disabled={saving} onClick={()=>{if(stage==='houses'){invalidate();setStage('streets');setHouses(null);}else close();}}><ArrowLeft size={16}/>{stage==='houses'?'Назад':'Скасувати'}</button><button className="pr-text-button" disabled={saving||busy} onClick={()=>{clearScopedDraft(kind,scope);onClose();}}>Відкинути пошук</button></div></div></div>;
}
