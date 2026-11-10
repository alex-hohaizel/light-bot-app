import {useEffect,useRef,useState} from 'react';
import type {CoverageRecord} from '@shared/product-contract';
import type {ManualGroup} from '@shared/bot/types';
import {addressOptionFingerprint} from '@shared/address-selection';
import {manualGroupOption} from '@shared/manual-group';
import type {ProfileController} from '../product-review/ProductReview';
import {Modal} from '../product-review/Modal';
import {addressBindingFingerprint} from '../product-review/examples';
import {clearScopedDraft,loadDraft,readScopedDraftToken,saveDraft} from '../product-review/ux-drafts';
import {parseManualGroupDraft,type ManualGroupDraft} from './manual-group-draft';
import './manual-group.css';

const sameGroup=(group:ManualGroup,binding:{operatorId:string;namespace:string;targetId:string})=>group.operatorId===binding.operatorId&&group.namespace===binding.namespace&&group.targetId===binding.targetId;
export function ManualGroupSelection({runtime,coverage,activeId,open,onOpen,onClose,onSaved}:{runtime:ProfileController;coverage:CoverageRecord[];activeId:string;open:boolean;onOpen():void;onClose():void;onSaved(id:string):void}){
 const snapshot=runtime.snapshot;if(snapshot.simulationOnly!==false)return null;
 const groups=snapshot.manualGroups??[],location=snapshot.profile.locations.find(l=>l.address.id===activeId);
 const current=location&&groups.find(g=>sameGroup(g,location.binding));
 const operator=location&&(coverage.find(c=>c.id===location.binding.operatorId)?.operatorLabel||current?.territoryLabel);
 const groupName=current?`Група ${current.label}`:location?.binding.kind==='user_selected_group'?location.address.label:'';
 return <section className="pr-panel pr-group-summary" aria-label="Група графіка"><div><span className="pr-eyebrow">Група графіка</span><h2>{groupName||'Знаєте свою групу?'}</h2><p>{location?.binding.kind==='user_selected_group'?'Обрана вами група. Прив’язку будинку не перевірено.':current?'Група зі збереженої прив’язки адреси.':'Можна обрати групу ОСР окремо від пошуку будинку.'}{operator&&<span className="pr-group-operator">{operator}</span>}</p></div><button className="pr-secondary" disabled={runtime.blocked||!groups.length} onClick={onOpen}>{location?.binding.kind==='user_selected_group'?'Змінити групу':'Обрати групу'}</button>{!groups.length&&<small className="pr-field-note">Перелік груп зараз недоступний. Збережений профіль залишається у вашому акаунті.</small>}{open&&<GroupEditor key={JSON.stringify([snapshot.profile.id,snapshot.sessionId])} runtime={runtime} groups={groups} coverage={coverage} activeId={activeId} onClose={onClose} onSaved={onSaved}/>}</section>;
}

function GroupEditor({runtime,groups,coverage,activeId,onClose,onSaved}:{runtime:ProfileController;groups:ManualGroup[];coverage:CoverageRecord[];activeId:string;onClose():void;onSaved(id:string):void}){
 const snapshot=runtime.snapshot,scope={ownerId:snapshot.profile.id,sessionId:snapshot.sessionId};
 const location=snapshot.profile.locations.find(l=>l.address.id===activeId),initial=location&&groups.find(g=>sameGroup(g,location.binding));
 const baseline=(id:string|null)=>{const l=snapshot.profile.locations.find(l=>l.address.id===id);return l?JSON.stringify([addressBindingFingerprint(l),l.address.label]):'';};
 const [draft,setDraft]=useState<ManualGroupDraft>(()=>loadDraft('manual-group',scope,parseManualGroupDraft)??{
  addressId:location?.binding.kind==='user_selected_group'?location.address.id:null,baseline:location?.binding.kind==='user_selected_group'?baseline(location.address.id):'',
  operatorId:initial?.operatorId||groups[0]?.operatorId||'',groupId:initial?.id||'',fingerprint:initial?addressOptionFingerprint(manualGroupOption(initial)):'',query:'',label:location?.binding.kind==='user_selected_group'?location.address.label:'',confirmed:false});
 const [error,setError]=useState(''),[stored,setStored]=useState(true),[busy,setBusy]=useState(false),mounted=useRef(true),inflight=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{setStored(saveDraft('manual-group',scope,draft));},[draft,scope.ownerId,scope.sessionId]);
 const selected=groups.find(g=>g.id===draft.groupId&&g.operatorId===draft.operatorId),option=selected&&manualGroupOption(selected),fingerprint=option?addressOptionFingerprint(option):'';
 const selectionChanged=Boolean(draft.groupId&&draft.fingerprint!==fingerprint),conflict=Boolean(draft.addressId&&draft.baseline!==baseline(draft.addressId));
 const operators=[...new Map(groups.map(g=>[g.operatorId,{id:g.operatorId,label:coverage.find(c=>c.id===g.operatorId)?.operatorLabel||g.territoryLabel}])).values()].sort((a,b)=>a.label.localeCompare(b.label,'uk'));
 const operatorRecord=coverage.find(c=>c.id===draft.operatorId);
 const matching=groups.filter(g=>g.operatorId===draft.operatorId&&`${g.locality} ${g.label}`.toLocaleLowerCase('uk-UA').includes(draft.query.trim().toLocaleLowerCase('uk-UA'))).sort((a,b)=>a.locality.localeCompare(b.locality,'uk')||a.label.localeCompare(b.label,'uk',{numeric:true}));
 const localities=[...new Set(matching.map(g=>g.locality))];
 function choose(id:string){const group=groups.find(g=>g.id===id),next=group&&manualGroupOption(group);setDraft(d=>({...d,groupId:id,fingerprint:next?addressOptionFingerprint(next):'',confirmed:false,label:d.label||next?.address.label||''}));setError('');}
 async function finish(retry=false){
  if(inflight.current||runtime.blocked&&!retry||(!option||!draft.confirmed||selectionChanged||conflict||!draft.label.trim())&&!retry)return;
  inflight.current=true;setBusy(true);setError('');const token=readScopedDraftToken('manual-group',scope);
  try{
   const result=retry?(await runtime.retry?.(),null):await runtime.mutate({kind:draft.addressId?'replace':'add',...(draft.addressId?{addressId:draft.addressId}:{}),optionId:option!.id,bindingRevisionId:option!.binding.revisionId,selectionFingerprint:fingerprint,label:draft.label.trim(),confirmed:true} as Parameters<ProfileController['mutate']>[0]);
   if(!mounted.current)return;
   clearScopedDraft('manual-group',scope,undefined,token);onSaved(retry?'':result?.profile.locations.find(l=>l.address.id===option?.address.id)?.address.id||'');onClose();
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Збереження ще не підтверджено.');}
  finally{inflight.current=false;if(mounted.current)setBusy(false);}
 }
 return <Modal title="Оберіть групу графіка" busy={runtime.blocked||busy} onClose={onClose}><form className="pr-form-stack pr-group-form" onSubmit={event=>{event.preventDefault();void finish();}}>
  <p className="pr-field-note">Вибір збережеться у вашому профілі застосунку й бота.</p>
  {draft.addressId&&<small className="pr-field-note">Змінюємо групу «{snapshot.profile.locations.find(l=>l.address.id===draft.addressId)?.address.label||'Група'}». Інші місця збережуться.</small>}
  <label>Оператор системи розподілу<select aria-label="Оператор для групи" value={draft.operatorId} disabled={runtime.blocked||busy} onChange={e=>{setDraft(d=>({...d,operatorId:e.target.value,groupId:'',fingerprint:'',query:'',confirmed:false}));setError('');}}>{operators.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
  <label>Знайти групу<input aria-label="Знайти групу" value={draft.query} maxLength={128} placeholder="Наприклад, 3.1 або місто" disabled={runtime.blocked||busy} onChange={e=>setDraft(d=>({...d,query:e.target.value}))}/></label>
  <label>Ваша група<select aria-label="Ваша група" value={draft.groupId} disabled={runtime.blocked||busy} onChange={e=>choose(e.target.value)}><option value="">Оберіть групу зі списку</option>{selected&&!matching.some(g=>g.id===selected.id)&&<option value={selected.id}>{selected.locality} · група {selected.label} (обрана)</option>}{localities.map(locality=><optgroup key={locality} label={locality}>{matching.filter(g=>g.locality===locality).map(g=><option key={g.id} value={g.id}>Група {g.label}</option>)}</optgroup>)}</select></label>
  {!matching.length&&<p role="status" className="pr-field-note">Груп за цим запитом не знайдено. Спробуйте лише номер або змініть ОСР.</p>}
  <label>Мітка у вашому профілі<input aria-label="Мітка групи" maxLength={60} value={draft.label} disabled={runtime.blocked||busy} onChange={e=>setDraft(d=>({...d,label:e.target.value}))}/></label>
  {operatorRecord&&<details className="pr-quiet-box"><summary>Джерело й обмеження даних</summary><p>{operatorRecord.reason}</p></details>}
  <div className="pr-quiet-box">Показуватимемо план обраної групи з його датою, джерелом та актуальністю. Він не підтверджує прив’язку вашого будинку або наявність світла зараз.</div>
  {selectionChanged&&<div role="alert" className="pr-status-notice pr-warning"><span>Перелік груп змінився. Перевірте поточні дані й підтвердьте вибір знову.</span>{selected&&<button type="button" className="pr-secondary" disabled={runtime.blocked||busy} onClick={()=>choose(selected.id)}>Використати поточні дані групи</button>}</div>}
  {conflict&&<p role="alert" className="pr-status-notice pr-warning">Цю збережену групу вже змінили в іншому вікні або боті. Чернетку збережено. Відкиньте її, щоб почати з поточного профілю.</p>}
  <label className="pr-checkbox"><input type="checkbox" aria-label="Підтверджую ручний вибір групи" checked={draft.confirmed&&!selectionChanged} disabled={runtime.blocked||busy||!option||selectionChanged||conflict} onChange={e=>setDraft(d=>({...d,confirmed:e.target.checked}))}/><span>Підтверджую: це обрана мною група. Відповідність мого будинку не перевірена.</span></label>
  {error&&<p role="alert" className="pr-status-notice pr-warning">{error}</p>}{!stored&&<p role="alert" className="pr-field-note">Браузер не підтвердив збереження чернетки. Після закриття вона може бути втрачена.</p>}
  {runtime.retry&&<button type="button" className="pr-secondary" disabled={runtime.busy||busy} onClick={()=>void finish(true)}>Перевірити той самий запит</button>}
  <div className="pr-modal-actions"><button type="button" className="pr-secondary" disabled={runtime.blocked||busy} onClick={onClose}>Закрити й зберегти чернетку</button><button className="pr-primary" type="submit" disabled={runtime.blocked||busy||!option||!draft.confirmed||selectionChanged||conflict||!draft.label.trim()}>{busy?'Зберігаємо…':'Зберегти групу'}</button></div>
  <button type="button" className="pr-text-button" disabled={runtime.blocked||busy} onClick={()=>{clearScopedDraft('manual-group',scope);onClose();}}>Відкинути чернетку групи</button>
 </form></Modal>;
}
