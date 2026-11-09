import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,Check,Clock3,MapPin,Search,X} from 'lucide-react';
import type {AddressOption} from '@shared/bot/types';
import {addressOptionFingerprint,isManualDtekGroupChoice} from '@shared/address-selection';
import {houseLookalikeSuggestion,normalizeAddressText} from '@shared/address-index';
import {localParts,validInstant} from '@shared/schedule-core';
import type {ProviderAddressLookupV2} from '../../../server/domain/provider-address-lookup';
import type {OdesaCatalogCandidate,OdesaCatalogSearch,OperatorAddressSnapshot} from '../../../server/production/odesa-address-catalog';
import type {OdesaOperatorHouseNotice} from '../../../server/domain/odesa-address-adapter';
import type {LiveAddressEditorProps} from './LiveAddressEditor';
import {addressBindingFingerprint,type DemoAddress} from './examples';
import {addressSaveError} from './address-editor-model';
import {displayInstantDate,durationLabel} from './schedule-model';
import {clearScopedDraft,loadDraft,readScopedDraftToken,saveDraft} from './ux-drafts';
import './address-editor.css';

export type OperatorAddressLookup=(request:ProviderAddressLookupV2,signal?:AbortSignal)=>Promise<OdesaCatalogSearch|OdesaCatalogCandidate>;
export interface OperatorLiveAddressEditorProps extends Omit<LiveAddressEditorProps,'lookup'> {lookup:OperatorAddressLookup}
type Level='localities'|'streets'|'houses';
type Stage=Level|'groups'|'review';
type Item={key:string;value:string};
type Queries=Record<Level,string>;
interface Draft {revision:number;initialId:string|null;baseline:string;baselineLabel:string;queries:Queries;label:string;pending:ProviderAddressLookupV2|null;pendingAt:number|null;retryAt:string|null}
interface Selection {result:Extract<OdesaCatalogCandidate,{state:'available'}>;house:Item;option:AddressOption|null;explicitGroup:boolean}
const DIRECTORY='dtek:oem' as const,PER_PAGE=6,TTL=600000;
const plain=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
const text=(v:unknown,max=4096):v is string=>typeof v==='string'&&v.length<=max&&!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v);
const literal=(v:unknown,max=300):v is string=>text(v,max)&&Boolean(v.trim());
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const invalid=():never=>{throw Error('OPERATOR_ADDRESS_RESULT_INVALID');};
const fresh=(v:{expiresAt:string}|null,now:number)=>Boolean(v&&Date.parse(v.expiresAt)>now);
const intent=(request:ProviderAddressLookupV2)=>{const {id:_id,...fields}=request;return JSON.stringify(fields);};
const time=(instant:string)=>localParts(Date.parse(instant)).time;
const timeInContext=(instant:string,now:number)=>localParts(Date.parse(instant)).date===localParts(now).date?time(instant):`${displayInstantDate(instant)}, ${time(instant)}`;
const waitLabel=(instant:string,now:number)=>durationLabel(Math.max(0,Math.ceil((Date.parse(instant)-now)/60000)));
function validQuery(value:string,level:Level){try{return text(value,100)&&normalizeAddressText(value).length>=(level==='houses'?1:2);}catch{return false;}}
function interval(observed:unknown,expires:unknown,now:number){
 return validInstant(observed)&&validInstant(expires)&&Date.parse(observed)<=now&&Date.parse(expires)>now&&Date.parse(expires)>Date.parse(observed)&&Date.parse(expires)-Date.parse(observed)<=TTL;
}
function checkedPending(value:unknown):ProviderAddressLookupV2|null {
 if(value===null)return null;
 if(!plain(value)||value.schemaVersion!=='lba-address-lookup/2'||value.directoryId!==DIRECTORY||!text(value.id,96)||!/^[A-Za-z0-9_.:-]+$/.test(value.id)||!literal(value.expectedSessionId,128)||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)return invalid();
 const operation=value.operation,allowed=['schemaVersion','directoryId','id','expectedSessionId','expectedRevision','operation'];
 if(!['localities','streets','houses','resolve'].includes(operation))return invalid();
 if(operation!=='resolve'){
  allowed.push('query','offset');if(!text(value.query,100)||!validQuery(value.query,operation)||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>20000)return invalid();
 }
 if(operation!=='localities'){
  allowed.push('catalogSnapshotId','cityKey');if(!uuid(value.catalogSnapshotId)||!literal(value.cityKey))return invalid();
 }
 if(operation==='houses'||operation==='resolve'){allowed.push('streetKey');if(!literal(value.streetKey))return invalid();}
 if(operation==='resolve'){allowed.push('houseSnapshotId','houseKey');if(!uuid(value.houseSnapshotId)||!literal(value.houseKey,100))return invalid();}
 if(Object.keys(value).some(k=>!allowed.includes(k)))return invalid();
 return structuredClone(value) as ProviderAddressLookupV2;
}
function parseDraft(value:unknown):Draft {
 if(!plain(value)||Object.keys(value).some(k=>!['revision','initialId','baseline','baselineLabel','queries','label','pending','pendingAt','retryAt'].includes(k))||!Number.isSafeInteger(value.revision)||value.revision<0||!(value.initialId===null||literal(value.initialId,4096))||!text(value.baseline,32768)||!text(value.baselineLabel,32)||!text(value.label,32)||!plain(value.queries)||Object.keys(value.queries).length!==3||!['localities','streets','houses'].every(k=>text(value.queries[k],100))||!(value.retryAt===null||validInstant(value.retryAt)))return invalid();
 const pending=checkedPending(value.pending);if(pending?(!Number.isSafeInteger(value.pendingAt)||value.pendingAt<0||value.pendingAt>Date.now()):value.pendingAt!==null)return invalid();
 return {revision:value.revision,initialId:value.initialId,baseline:value.baseline,baselineLabel:value.baselineLabel,queries:{localities:value.queries.localities,streets:value.queries.streets,houses:value.queries.houses},label:value.label,pending,pendingAt:value.pendingAt,retryAt:value.retryAt};
}
function checkedSnapshot(value:unknown,request:Exclude<ProviderAddressLookupV2,{operation:'resolve'}>,now:number):OperatorAddressSnapshot {
 if(!plain(value)||value.kind!=='lba-provider-address-snapshot/2'||value.namespace!==DIRECTORY||value.level!==request.operation||!uuid(value.id)||!uuid(value.catalogSnapshotId)||!text(value.revisionId,64)||!/^[a-f0-9]{64}$/.test(value.revisionId)||!interval(value.observedAt,value.expiresAt,now)||value.offset!==request.offset||typeof value.hasMore!=='boolean'||value.catalogCompleteness!=='unknown'||!Array.isArray(value.items)||value.items.length>30)return invalid();
 if(request.operation==='localities'?(value.catalogSnapshotId!==value.id||value.cityKey!==undefined||value.streetKey!==undefined):value.catalogSnapshotId!==request.catalogSnapshotId||value.cityKey!==request.cityKey||request.operation==='streets'&&value.streetKey!==undefined||request.operation==='houses'&&value.streetKey!==request.streetKey)return invalid();
 const keys=new Set<string>();for(const item of value.items){if(!plain(item)||!literal(item.key,request.operation==='houses'?100:300)||item.value!==item.key||keys.has(item.key))return invalid();keys.add(item.key);}
 if(value.hasMore&&value.items.length===0)return invalid();
 return structuredClone(value) as OperatorAddressSnapshot;
}
function checkedNotice(value:unknown):OdesaOperatorHouseNotice {
 if(!plain(value)||value.scope!=='provider_house_record'||!['operator_reported_window','not_reported','unverified_report'].includes(value.state)||!['stabilization','emergency','not_reported','unverified'].includes(value.reportKind)||![null,'unknown_report_type','conflicting_report_fields','missing_report_time','invalid_report_time'].includes(value.reportIssue)||!['none','operator_reports_schedule_not_applicable','house_report_unverified'].includes(value.groupPlanAdvisory)||!validInstant(value.sourceUpdatedAt)||!validInstant(value.observedAt)||typeof value.providerDisplayEnabled!=='boolean'||value.physicalPower!=='unknown')return invalid();
 if(value.state==='operator_reported_window'){
  const w=value.window;if(!plain(w)||!validInstant(w.startsAt)||!validInstant(w.estimatedEndsAt)||Date.parse(w.estimatedEndsAt)<=Date.parse(w.startsAt)||!text(w.startLocal,40)||!text(w.estimatedEndLocal,40)||!['before_reported_window','during_reported_window','past_estimate'].includes(w.phaseAtObservation)||w.endIsEstimate!==true||!['stabilization','emergency'].includes(value.reportKind))return invalid();
 }else if(value.window!==undefined)return invalid();
 return structuredClone(value) as OdesaOperatorHouseNotice;
}
function checkedCandidate(value:unknown,house:Item,city:Item,street:Item,snapshot:OperatorAddressSnapshot,now:number):Selection {
 if(!plain(value)||value.state!=='available'||value.cache!=='hit'||value.snapshotId!==snapshot.id||value.addressBindingVerified!==false||value.deliveryEligible!==false||!interval(value.observedAt,value.expiresAt,now)||!Array.isArray(value.options)||value.options.length<1||value.options.length>12||!text(value.mappingFingerprint,64)||!/^[a-f0-9]{64}$/.test(value.mappingFingerprint))return invalid();
 const ids=new Set<string>(),groups=new Set<string>();
 for(const option of value.options){
  if(!plain(option)||!literal(option.id,4096)||!plain(option.address)||!plain(option.binding)||!literal(option.territoryLabel)||!Array.isArray(option.address.aliases)||!option.address.aliases.every((a:unknown)=>text(a))||!plain(option.address.house))return invalid();
  const a=option.address,b=option.binding;
  if(!literal(a.id,4096)||a.territoryId!=='source:dtek:oem'||a.locality!==city.key||a.street!==street.key||a.house.literal!==house.key||!literal(a.house.number,100)||b.addressId!==a.id||b.namespace!==DIRECTORY||b.operatorId!=='dtek-oem'||b.kind!=='operator_group'||!/^GPV[1-6]\.[12]$/.test(b.targetId)||!literal(b.revisionId,4096)||b.verifiedAt!==null||b.effectiveFrom!==null||b.effectiveUntil!==null||b.status!==(value.options.length>1?'ambiguous':'needs_confirmation')||ids.has(option.id)||groups.has(b.targetId))return invalid();
  if(!addressOptionFingerprint(option as unknown as AddressOption))return invalid();ids.add(option.id);groups.add(b.targetId);
 }
 const result=structuredClone(value) as Extract<OdesaCatalogCandidate,{state:'available'}>;result.operatorNotice=checkedNotice(value.operatorNotice);
 return {result,house:{...house},option:result.options.length===1?result.options[0]:null,explicitGroup:false};
}
function lookupMessage(code:unknown,state:string){
 if(code==='PRODUCTION_PROFILE_REVISION_CONFLICT')return 'Профіль змінився в іншому вікні або боті. Оновіть його й почніть пошук ще раз.';
 if(state==='stale'||code==='ADDRESS_FLOW_SELECTION_CHANGED')return 'Час дії результатів минув або відомості змінилися. Почніть пошук з населеного пункту ще раз.';
 if(state==='deferred')return 'Пошук тимчасово призупинено, щоб не надсилати забагато запитів. Ваші дані збережено.';
 if(state==='disabled')return 'Адресний пошук зараз недоступний. Чинні адреси й налаштування збережено.';
 return 'Не вдалося перевірити результат. Спробуйте ще раз тим самим запитом. Чинна адреса не змінилася.';
}
function HouseNotice({notice,now}:{notice:OdesaOperatorHouseNotice;now:number}){
 const w=notice.window;
 let heading='Поточний стан живлення не підтверджено',body='У доступних даних немає окремого повідомлення для цього будинку. Наявність світла не підтверджена.';
 if(notice.state==='unverified_report')body='Повідомлення для будинку потребує уточнення. Час відновлення невідомий.';
 if(notice.state==='operator_reported_window'&&w){
  heading=notice.reportKind==='emergency'?'Повідомлення про екстрене відключення':'Повідомлення оператора для будинку';
  body=Date.parse(w.estimatedEndsAt)>now?`${Date.parse(w.startsAt)>now?'Початок за повідомленням':'Початок відключення за повідомленням'} — ${timeInContext(w.startsAt,now)}. Орієнтовне відновлення — до ${timeInContext(w.estimatedEndsAt,now)} (ще ${waitLabel(w.estimatedEndsAt,now)}). Час може змінитися.`:`Попередній орієнтир ${timeInContext(w.estimatedEndsAt,now)} минув. Актуального часу відновлення поки немає.`;
 }
 return <section className="pr-quiet-box" aria-label="Повідомлення оператора"><strong style={{display:'flex',alignItems:'center',gap:8}}><Clock3 size={17} aria-hidden="true"/>{heading}</strong><p>{body}</p>{notice.groupPlanAdvisory==='operator_reports_schedule_not_applicable'&&<p>Для цього будинку оператор повідомляє про відключення поза погодинним графіком. План групи показується окремо.</p>}<p className="pr-field-note">Оновлено оператором о {time(notice.sourceUpdatedAt)}. Це повідомлення, а не вимір фактичного живлення.</p></section>;
}

/** Opaque provider keys stay intact. This UI records consent; the server alone
 * validates owner mutation and any manual-group conversion. No fetch occurs here. */
export function OperatorLiveAddressEditor(props:OperatorLiveAddressEditorProps){
 return <OwnedEditor key={JSON.stringify([DIRECTORY,props.scope.ownerId,props.scope.sessionId,props.scope.revision,props.initial?.id??null])} {...props}/>;
}
function OwnedEditor({scope,lookup,initial,catalog,catalogStatus,operatorLabels,manualGroupHref,saving=false,retrying=false,onRetry,onSave,onClose}:OperatorLiveAddressEditorProps){
 const ids=useId(),kind=JSON.stringify(['provider-address/2',DIRECTORY,scope.ownerId,scope.sessionId,scope.revision,initial?.id??null]);
 const draftScope=useRef({ownerId:scope.ownerId,sessionId:scope.sessionId}).current;
 const baseline=useRef(initial?.recordFingerprint??'').current,baselineLabel=useRef(initial?.label??'').current;
 const [restored]=useState(()=>loadDraft(kind,draftScope,parseDraft));
 const recovered=restored?.revision===scope.revision&&restored.initialId===(initial?.id??null)&&restored.baseline===baseline&&restored.baselineLabel===baselineLabel&&(!restored.pending||restored.pending.expectedSessionId===scope.sessionId&&restored.pending.expectedRevision===scope.revision)?restored:null;
 const [queries,setQueries]=useState<Queries>(recovered?.queries??{localities:initial?.city??'',streets:initial?.street??'',houses:''});
 const [label,setLabel]=useState(recovered?.label??initial?.label??''),[stage,setStage]=useState<Stage>('localities');
 const [localities,setLocalities]=useState<OperatorAddressSnapshot|null>(null),[streets,setStreets]=useState<OperatorAddressSnapshot|null>(null),[houses,setHouses]=useState<OperatorAddressSnapshot|null>(null);
 const [city,setCity]=useState<Item|null>(null),[street,setStreet]=useState<Item|null>(null),[selection,setSelection]=useState<Selection|null>(null);
 const [page,setPage]=useState(0),[status,setStatus]=useState('idle'),[message,setMessage]=useState(''),[retryAt,setRetryAt]=useState<string|null>(recovered?.retryAt??null),[tick,setTick]=useState(Date.now()),[stored,setStored]=useState(true),[consent,setConsent]=useState(''),[groupHelp,setGroupHelp]=useState(false),[saveError,setSaveError]=useState(''),[localSaving,setLocalSaving]=useState(false);
 const mounted=useRef(true),sequence=useRef(0),controller=useRef<AbortController|null>(null),working=useRef(false),saveInFlight=useRef(false),retryInFlight=useRef(false),pending=useRef(recovered?.pending??null),pendingAt=useRef(recovered?.pendingAt??null),requests=useRef(new Map<string,{request:ProviderAddressLookupV2;at:number}>());
 const dialog=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null),priorFocus=useRef(typeof document==='undefined'?null:document.activeElement as HTMLElement|null),closeRef=useRef<()=>void>(()=>{}),latest=useRef({scope,catalog,initial,saving});latest.current={scope,catalog,initial,saving};
 if(pending.current&&pendingAt.current!==null&&!requests.current.size)requests.current.set(intent(pending.current),{request:pending.current,at:pendingAt.current});
 const blockedSave=saving||localSaving,changedRemote=Boolean(initial&&((initial.recordFingerprint??'')!==baseline||initial.label!==baselineLabel));
 const now=Math.max(tick,Date.now());
 const chosen=selection?.option??null,token=chosen?addressOptionFingerprint(chosen):'';
 const canonical=chosen?catalog?.filter(o=>o.id===chosen.id)??[]:[];
 let canonicalReady=false;try{canonicalReady=Boolean(chosen&&canonical.length===1&&addressOptionFingerprint(canonical[0])===token);}catch{/* Invalid readback never grants consent. */}
 const freshParents=fresh(localities,now)&&fresh(streets,now)&&fresh(houses,now),freshSelection=Boolean(selection&&fresh(selection.result,now)&&freshParents);
 const manual=Boolean(chosen&&isManualDtekGroupChoice(chosen.binding)),bindingAllowed=Boolean(chosen&&(chosen.binding.status==='needs_confirmation'||manual&&selection?.explicitGroup));
 const canReview=Boolean(freshSelection&&canonicalReady&&bindingAllowed&&!changedRemote&&catalogStatus!=='loading'&&catalogStatus!=='unavailable');
 const canSave=Boolean(canReview&&text(label,32)&&label.trim()&&consent===token&&!blockedSave);
 const draft=():Draft=>({revision:scope.revision,initialId:initial?.id??null,baseline,baselineLabel,queries,label,pending:pending.current,pendingAt:pendingAt.current,retryAt});
 function persist(payload=draft()){const ok=saveDraft(kind,draftScope,payload);if(mounted.current)setStored(ok);return ok;}
 function fence(){++sequence.current;controller.current?.abort();controller.current=null;working.current=false;}
 function resetNotice(){setStatus('idle');setMessage('');setSaveError('');setConsent('');setGroupHelp(false);setPage(0);}
 function close(){if(saveInFlight.current||latest.current.saving)return;fence();persist();onClose();}
 closeRef.current=close;
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;fence();};},[]);
 useEffect(()=>{const timer=setInterval(()=>setTick(Date.now()),500);return()=>clearInterval(timer);},[]);
 useEffect(()=>{persist();},[queries,label,retryAt]);
 useEffect(()=>{if(consent&&(!canReview||consent!==token))setConsent('');},[canReview,token,consent]);
 useEffect(()=>{heading.current?.focus();},[stage]);
 useEffect(()=>{
  const trap=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();closeRef.current();}
   if(event.key==='Tab'&&dialog.current){const controls=[...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')].filter(el=>el.offsetParent!==null),first=controls[0],last=controls.at(-1);if(!dialog.current.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus();}else if(event.shiftKey&&(document.activeElement===first||document.activeElement===heading.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  };document.addEventListener('keydown',trap);return()=>{document.removeEventListener('keydown',trap);if(priorFocus.current?.isConnected)priorFocus.current.focus();};
 },[]);
 function edit(value:string,level:Level){
  fence();resetNotice();setSelection(null);setQueries(q=>({...q,[level]:value}));
  if(level==='localities'){setLocalities(null);setCity(null);setStreets(null);setStreet(null);setHouses(null);}
  else if(level==='streets'){setStreets(null);setStreet(null);setHouses(null);}else setHouses(null);
 }
 function back(){
  if(blockedSave)return;fence();resetNotice();setSelection(null);
  if(stage==='review'&&selection&&selection.result.options.length>1){setSelection({...selection,option:null,explicitGroup:false});setStage('groups');return;}
  if(stage==='review'||stage==='groups'){setStage(fresh(localities,Date.now())&&fresh(streets,Date.now())?'houses':'localities');return;}
  if(stage==='houses'){setHouses(null);setStreet(null);setStage(fresh(localities,Date.now())?'streets':'localities');return;}
  if(stage==='streets'){setCity(null);setStreets(null);setStreet(null);setHouses(null);setStage('localities');return;}close();
 }
 function restart(){fence();resetNotice();setLocalities(null);setCity(null);setStreets(null);setStreet(null);setHouses(null);setSelection(null);setStage('localities');}
 async function search(operation:Level|'resolve',offset=0,house?:Item,landingLast=false){
  if(working.current||blockedSave||changedRemote||!mounted.current||retryAt&&Date.parse(retryAt)>Date.now())return;
  const now=Date.now();
  if(operation!=='localities'&&(!city||!fresh(localities,now))||(operation==='houses'||operation==='resolve')&&(!street||!fresh(streets,now))||operation==='resolve'&&(!house||!fresh(houses,now)||!houses?.items.some(i=>i.key===house.key&&i.value===house.value))){setStatus('stale');setMessage(lookupMessage(null,'stale'));return;}
  if(operation!=='resolve'&&!validQuery(queries[operation],operation)){setStatus('invalid');setMessage(operation==='houses'?'Введіть номер будинку. Літера, дріб і корпус мають значення.':'Введіть щонайменше дві літери назви без незвичних символів.');return;}
  const common={schemaVersion:'lba-address-lookup/2' as const,id:'',expectedSessionId:scope.sessionId,expectedRevision:scope.revision,directoryId:DIRECTORY};
  const requestBase:ProviderAddressLookupV2=operation==='localities'?{...common,operation,query:normalizeAddressText(queries.localities),offset}:operation==='streets'?{...common,operation,query:normalizeAddressText(queries.streets),offset,catalogSnapshotId:localities!.id,cityKey:city!.key}:operation==='houses'?{...common,operation,query:normalizeAddressText(queries.houses),offset,catalogSnapshotId:localities!.id,cityKey:city!.key,streetKey:street!.key}:{...common,operation,catalogSnapshotId:localities!.id,houseSnapshotId:houses!.id,cityKey:city!.key,streetKey:street!.key,houseKey:house!.key};
  const key=intent(requestBase),prior=requests.current.get(key),active=prior&&now>=prior.at&&now-prior.at<TTL?prior:null;
  const request=active?.request??{...requestBase,id:crypto.randomUUID()},at=active?.at??now;requests.current.set(key,{request,at});if(requests.current.size>20)requests.current.delete(requests.current.keys().next().value!);pending.current=request;pendingAt.current=at;
  if(!persist()){setStatus('unavailable');setMessage('Браузер не зберіг чернетку. Запит ще не надіслано. Дозвольте зберігання даних для цього сайту або спробуйте інший браузер.');return;}
  // A newer lookup supersedes the old authoritative batch, even if it fails.
  // Parent snapshots remain available only while their exact selection is kept.
  setSelection(null);setConsent('');
  if(operation==='localities'){setLocalities(null);setCity(null);setStreets(null);setStreet(null);setHouses(null);}
  else if(operation==='streets'){setStreets(null);setStreet(null);setHouses(null);}else if(operation==='houses')setHouses(null);
  const seq=++sequence.current,abort=new AbortController();controller.current=abort;working.current=true;setStatus('loading');setMessage('');setSaveError('');setRetryAt(null);
  const stillCurrent=()=>mounted.current&&seq===sequence.current&&!abort.signal.aborted&&latest.current.scope.ownerId===scope.ownerId&&latest.current.scope.sessionId===scope.sessionId&&latest.current.scope.revision===scope.revision;
  try{
   const result=await lookup(structuredClone(request),abort.signal);if(!stillCurrent())return;
   if(!plain(result)||!['available','disabled','unavailable','deferred','stale'].includes(result.state))return invalid();
   if(result.state!=='available'){
    if(!text(result.code,128)||result.retryAt!==undefined&&!validInstant(result.retryAt))return invalid();
    if(operation==='resolve')setHouses(null);
    if(result.code!=='ADDRESS_PUBLICATION_UNKNOWN'){requests.current.delete(key);pending.current=null;pendingAt.current=null;persist();}
    setStatus(result.state);setMessage(lookupMessage(result.code,result.state));setRetryAt(result.retryAt??null);return;
   }
   const resultExpiry='snapshot'in result&&plain(result.snapshot)?result.snapshot.expiresAt:'expiresAt'in result?result.expiresAt:null;
   if(validInstant(resultExpiry)&&Date.parse(resultExpiry)<=Date.now()){
    requests.current.delete(key);pending.current=null;pendingAt.current=null;persist();setStatus('stale');setMessage(lookupMessage(null,'stale'));return;
   }
   if(operation==='resolve'){
    if(!fresh(localities,Date.now())||!fresh(streets,Date.now())||!fresh(houses,Date.now()))return invalid();
    const resolved=checkedCandidate(result,house!,city!,street!,houses!,Date.now());setSelection(resolved);setConsent('');setGroupHelp(false);setPage(0);setStage(resolved.result.options.length>1?'groups':'review');
   }else{
    const snapshot=checkedSnapshot('snapshot'in result?result.snapshot:null,request as Exclude<ProviderAddressLookupV2,{operation:'resolve'}>,Date.now());
    if(operation!=='localities'&&!fresh(localities,Date.now())||operation==='houses'&&!fresh(streets,Date.now()))return invalid();
    if(operation==='localities'){setLocalities(snapshot);setCity(null);setStreets(null);setStreet(null);setHouses(null);}else if(operation==='streets'){setStreets(snapshot);setStreet(null);setHouses(null);}else setHouses(snapshot);
    setPage(landingLast?Math.max(0,Math.ceil(snapshot.items.length/PER_PAGE)-1):0);setSelection(null);
    if(!snapshot.items.length)setMessage('У доступних результатах збігів немає. Перевірте написання або спробуйте іншу частину назви. Це не означає, що адреси не існує.');
   }
   requests.current.delete(key);pending.current=null;pendingAt.current=null;persist();setStatus('available');
  }catch(error){if(stillCurrent()){if(operation==='resolve')setHouses(null);const code=error&&typeof error==='object'&&typeof(error as {code?:unknown}).code==='string'?(error as {code:string}).code:undefined;setStatus('unavailable');setMessage(lookupMessage(code,'unavailable'));}}
  finally{if(stillCurrent()){working.current=false;controller.current=null;setStatus(s=>s==='loading'?'unavailable':s);}}
 }
 async function save(){
  if(saveInFlight.current||!canSave||!chosen||!selection||!mounted.current)return;
  // Recheck time and canonical identity at the action boundary, not only the timer render.
  const currentOptions=latest.current.catalog?.filter(o=>o.id===chosen.id)??[];
  if(!fresh(selection.result,Date.now())||![localities,streets,houses].every(s=>fresh(s,Date.now()))||currentOptions.length!==1||addressOptionFingerprint(currentOptions[0])!==consent)return;
  saveInFlight.current=true;setLocalSaving(true);setSaveError('');const draftToken=readScopedDraftToken(kind,draftScope);
  const value:DemoAddress={id:initial?.id||chosen.address.id,label:label.trim(),city:chosen.address.locality,street:chosen.address.street,house:chosen.address.house.literal,confirmedInDemo:false,paused:initial?.paused||false,optionId:chosen.id,bindingRevisionId:chosen.binding.revisionId,recordFingerprint:addressBindingFingerprint(chosen),selectionFingerprint:consent};
  try{await onSave(value);clearScopedDraft(kind,draftScope,undefined,draftToken);}
  catch(error){if(mounted.current)setSaveError(addressSaveError(error));}
  finally{saveInFlight.current=false;if(mounted.current)setLocalSaving(false);}
 }
 async function retrySave(){
  if(!onRetry||retrying||localSaving||retryInFlight.current)return;retryInFlight.current=true;
  const draftToken=readScopedDraftToken(kind,draftScope);
  try{await onRetry();clearScopedDraft(kind,draftScope,undefined,draftToken);}
  catch(error){if(mounted.current)setSaveError(addressSaveError(error));}
  finally{retryInFlight.current=false;}
 }
 const busy=status==='loading',retryHeld=Boolean(retryAt&&Date.parse(retryAt)>now),isSearch=stage==='localities'||stage==='streets'||stage==='houses';
 const snapshot=stage==='localities'?localities:stage==='streets'?streets:stage==='houses'?houses:null;
 const options=stage==='groups'?selection?.result.options??[]:[],items=isSearch?snapshot?.items??[]:[];
 const total=stage==='groups'?options.length:items.length,pages=Math.max(1,Math.ceil(total/PER_PAGE)),visibleItems=items.slice(page*PER_PAGE,(page+1)*PER_PAGE),visibleOptions=options.slice(page*PER_PAGE,(page+1)*PER_PAGE);
 const searchParentFresh=stage==='localities'||fresh(localities,now)&&(stage==='streets'||fresh(streets,now));
 const title=stage==='localities'?'Знайдіть населений пункт':stage==='streets'?'Знайдіть свою вулицю':stage==='houses'?'Оберіть точний будинок':stage==='groups'?'Уточніть свою групу':'Перевірте адресу';
 const step=stage==='localities'||stage==='streets'?0:stage==='houses'||stage==='groups'?1:2;
 return <div className="pr-modal-scrim" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><div ref={dialog} className="pr-modal pr-address-editor" role="dialog" aria-modal="true" aria-labelledby={ids+'title'} aria-busy={busy||blockedSave} data-testid="operator-address-editor" data-stage={stage}>
  <div className="pr-modal-top"><span className="pr-eyebrow">МОЯ АДРЕСА · ОДЕЩИНА</span><button className="pr-icon-button" type="button" aria-label="Закрити" disabled={blockedSave} onClick={close}><X size={19}/></button></div>
  <h2 id={ids+'title'}>{initial?'Замінити будинок':'Додати адресу'}</h2>
  <div className="pr-stepper" aria-label={`Крок ${step+1} з 3`}>{['Знайти','Будинок','Перевірити'].map((name,index)=><span key={name} className={index===step?'is-active':index<step?'is-done':''} aria-current={index===step?'step':undefined}><b>{index<step?<Check size={11} aria-hidden="true"/>:index+1}</b>{name}</span>)}</div>
  <h3 ref={heading} tabIndex={-1}>{title}</h3>
  {stage!=='localities'&&stage!=='review'&&<p className="pr-field-note" style={{overflowWrap:'anywhere'}}>{city?.value}{street&&` · ${street.value}`}{selection&&` · ${selection.house.value}`}</p>}
  {changedRemote&&<p className="pr-status-notice pr-warning" role="alert">Адресу змінили в іншому вікні або боті. Закрийте редактор і перевірте актуальний профіль.</p>}
  {!stored&&<p className="pr-status-notice pr-warning" role="status">Браузер не підтвердив збереження чернетки. Введені дані залишаються в цьому вікні.</p>}
  {recovered&&stage==='localities'&&<p className="pr-field-note">Введені дані відновлено. Результати пошуку й підтвердження потрібно отримати заново.</p>}
  {isSearch&&<form className="pr-form-stack" onSubmit={e=>{e.preventDefault();void search(stage);}}>
   <label>{stage==='localities'?'Населений пункт':stage==='streets'?'Назва вулиці':'Номер будинку'}<div className="pr-input-icon"><Search size={17} aria-hidden="true"/><input autoComplete="off" maxLength={100} disabled={blockedSave||changedRemote} value={queries[stage]} onChange={e=>edit(e.target.value,stage)} aria-describedby={ids+'help'} placeholder={stage==='localities'?'Наприклад, Одеса':stage==='streets'?'Назва або її частина':'Номер, літера або корпус'}/></div></label>
   <p id={ids+'help'} className="pr-field-note">{stage==='houses'?'Номер, літера та дріб мають значення. Схожі латинські й українські літери позначено окремо. Оберіть точне написання.':stage==='streets'?'Достатньо двох літер. Якщо назва змінилася, спробуйте й попередню — ми не вгадуємо перейменування.':'Введіть щонайменше дві літери. Пошук почнеться лише після натискання «Знайти».'}</p>
   <button type="submit" className="pr-primary" disabled={busy||blockedSave||changedRemote||retryHeld||!searchParentFresh}>{busy?'Шукаємо…':'Знайти'}<Search size={15} aria-hidden="true"/></button>
  </form>}
  {message&&<p className="pr-status-notice pr-warning" role={status==='available'?'status':'alert'}>{message}</p>}
  {retryHeld&&<p role="status" className="pr-field-note">Повторний пошук буде доступний через {waitLabel(retryAt!,now)} — після {time(retryAt!)}.</p>}
  {(isSearch&&(!searchParentFresh||snapshot&&!fresh(snapshot,now))||selection&&!freshSelection)&&<div role="alert" className="pr-status-notice pr-warning"><span>Час дії результатів минув. Отримайте свіжі відомості перед збереженням.</span><button type="button" disabled={blockedSave} onClick={restart}>Почати пошук заново</button></div>}
  {isSearch&&visibleItems.length>0&&<><p className="pr-field-note" role="status">Результати {(snapshot?.offset??0)+page*PER_PAGE+1}–{(snapshot?.offset??0)+Math.min((page+1)*PER_PAGE,items.length)}. Оберіть потрібний запис.</p><div className={stage==='houses'?'pr-house-grid':'pr-address-results'} aria-label={stage==='localities'?'Населені пункти':stage==='streets'?'Вулиці':'Будинки'}>{visibleItems.map(item=><button key={item.key} className={stage==='houses'?'':'pr-search-result'} type="button" disabled={busy||blockedSave||changedRemote||stage==='houses'&&retryHeld||!searchParentFresh||!fresh(snapshot,now)} onClick={()=>{
   if(stage==='houses'){void search('resolve',0,item);return;}fence();resetNotice();setSelection(null);
   if(stage==='localities'){setCity(item);setStreets(null);setStreet(null);setHouses(null);setStage('streets');}else{setStreet(item);setHouses(null);setStage('houses');}
  }}>{stage!=='houses'&&<MapPin size={17} aria-hidden="true"/>}<span><strong>{item.value}</strong>{stage==='houses'&&items.some(other=>houseLookalikeSuggestion(other.key,item.key))&&<small>{/[a-z]$/i.test(item.key)?'Латинська':'Українська'} «{item.key.slice(-1)}»</small>}</span>{stage!=='houses'&&<ArrowRight size={16} aria-hidden="true"/>}</button>)}</div></>}
  {stage==='groups'&&selection&&<div className="pr-form-stack"><p className="pr-quiet-box">Для цього будинку оператор указує кілька груп. Оберіть свою, якщо знаєте її, або спершу уточніть в оператора. Перший варіант не підставляється автоматично.</p><div className="pr-address-results" aria-label="Групи будинку">{visibleOptions.map(option=><button key={option.id} className="pr-search-result" type="button" disabled={blockedSave||!freshSelection||!isManualDtekGroupChoice(option.binding)} onClick={()=>{setSelection({...selection,option,explicitGroup:true});setConsent('');setGroupHelp(false);setStage('review');}}><span><strong>Група {option.binding.targetId.replace(/^GPV/,'')}</strong><small>Оберіть, лише якщо знаєте свою групу</small></span><ArrowRight size={16} aria-hidden="true"/></button>)}</div><button className="pr-text-button" type="button" onClick={()=>setGroupHelp(true)}>Не знаю свою групу</button>{groupHelp&&<div className="pr-quiet-box" role="status">Уточніть групу в ДТЕК Одеські електромережі або звірте її з відомостями для вашої адреси. Поки що можна повернутися до пошуку. Жодну групу не обрано.<p><a href="https://www.dtek-oem.com.ua/ua/shutdowns" target="_blank" rel="noreferrer noopener">Перевірити на сайті оператора</a></p></div>}</div>}
  {(isSearch&&snapshot||stage==='groups')&&(pages>1||isSearch&&(Boolean(snapshot?.hasMore)||Boolean(snapshot?.offset)))&&<nav className="pr-address-pager" aria-label="Сторінки результатів"><button className="pr-secondary" type="button" aria-label="Попередня сторінка" disabled={blockedSave||busy||retryHeld||page===0&&!(isSearch&&snapshot&&snapshot.offset>0)} onClick={()=>{if(page>0)setPage(page-1);else if(isSearch&&snapshot)void search(stage,Math.max(0,snapshot.offset-30),undefined,true);}}><ArrowLeft size={16}/></button><span>Сторінка {Math.floor((snapshot?.offset??0)/PER_PAGE)+page+1}{!snapshot?.hasMore&&` з ${Math.floor((snapshot?.offset??0)/PER_PAGE)+pages}`}</span><button className="pr-secondary" type="button" aria-label="Наступна сторінка" disabled={blockedSave||busy||retryHeld||page+1>=pages&&!(isSearch&&snapshot?.hasMore)} onClick={()=>{if(page+1<pages)setPage(page+1);else if(isSearch&&snapshot)void search(stage,snapshot.offset+30);}}><ArrowRight size={16}/></button></nav>}
  {stage==='review'&&selection&&chosen&&<div className="pr-form-stack">
   <div className="pr-address-confirm"><MapPin size={22} aria-hidden="true"/><span><strong>{chosen.address.locality}, {chosen.address.street}, {chosen.address.house.literal}</strong><small>{operatorLabels?.['dtek-oem']||'ДТЕК Одеські електромережі'} · Група {chosen.binding.targetId.replace(/^GPV/,'')}</small></span></div>
   <HouseNotice notice={selection.result.operatorNotice} now={now}/>
   <label>Мітка адреси<input maxLength={32} placeholder="Дім, Робота…" value={label} disabled={blockedSave} onChange={e=>setLabel(e.target.value)}/></label>
   {!canonicalReady&&<p className="pr-status-notice pr-warning" role="alert">Профіль ще не підтвердив поточний результат пошуку. Збереження недоступне. Дочекайтеся оновлення або знайдіть будинок ще раз.</p>}
   <label className="pr-checkbox"><input type="checkbox" checked={consent===token&&canReview} disabled={!canReview||blockedSave} onChange={e=>setConsent(e.target.checked?token:'')}/><span>{manual?`Я обираю групу ${chosen.binding.targetId.replace(/^GPV/,'')} для цієї адреси`:'Підтверджую: це потрібний будинок і зазначена оператором група'}</span></label>
   <p className="pr-quiet-box">{manual?'Групу обрали ви. Точне приєднання будинку ще не підтверджено; автоматичні сповіщення вимкнені.':'Адресу можна зберегти. Точне приєднання будинку ще потребує перевірки; автоматичні сповіщення вимкнені.'}</p>
  </div>}
  {saveError&&<div className="pr-status-notice pr-warning" role="alert"><span>{saveError}</span>{onRetry&&<button type="button" disabled={retrying||localSaving} onClick={()=>void retrySave()}>{retrying?'Перевіряємо…':'Перевірити результат збереження'}</button>}</div>}
  <div className="pr-modal-actions"><button className="pr-secondary" type="button" disabled={blockedSave} onClick={back}><ArrowLeft size={16}/>{stage==='localities'?'Скасувати':'Назад'}</button>{stage==='review'&&<button className="pr-primary" type="button" disabled={!canSave} onClick={()=>void save()}>{localSaving?'Зберігаємо…':saving&&saveError?'Очікуємо підтвердження':'Зберегти адресу'}<Check size={16}/></button>}</div>
  <details><summary>Про пошук і дані</summary><p className="pr-field-note">Адреси та повідомлення — з публічного сайту ДТЕК Одеські електромережі. Пошук не вимірює наявність світла. Відсутній запис не доводить відсутності будинку. План групи та повідомлення для будинку можуть відрізнятися.</p>{manualGroupHref&&<><p className="pr-field-note">У боті можна обрати опубліковану групу вручну. Це буде ваш вибір, а не підтвердження точного приєднання.</p><a className="pr-text-button" href={manualGroupHref}>Відкрити бота<ArrowRight size={14}/></a></>}</details>
  <button type="button" className="pr-text-button pr-discard-draft" disabled={blockedSave} onClick={()=>{if(saveInFlight.current)return;fence();clearScopedDraft(kind,draftScope);onClose();}}>Відкинути чернетку</button>
 </div></div>;
}
