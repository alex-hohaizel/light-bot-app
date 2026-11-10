import {useState} from 'react';
import {ArrowRight,MapPin} from 'lucide-react';
import {LiveAddressEditor,type LiveAddressEditorProps} from './LiveAddressEditor';
import {OperatorLiveAddressEditor,type OperatorAddressLookup} from './OperatorLiveAddressEditor';
import {AddressEditor} from './AddressEditor';
import {Modal} from './Modal';
import {MANUAL_GROUP_REGIONS,type ManualGroupRegion} from '../product-runtime/ManualGroupSelection';

export interface ProviderLiveAddressEditorProps extends LiveAddressEditorProps {
 operatorLookup:OperatorAddressLookup;
 operatorEnabled:boolean;
 onChooseGroup?:(region:ManualGroupRegion)=>void;
}

/** A directory choice is navigation only. The selected provider owns its scoped
 * draft and the server still verifies every selected record and confirmation. */
export function ProviderLiveAddressEditor({operatorLookup,operatorEnabled,onChooseGroup,...props}:ProviderLiveAddressEditorProps){
 const [directory,setDirectory]=useState<'kyiv'|'odesa'|'cached'|null>(null);
 const [checking,setChecking]=useState(false),[retryError,setRetryError]=useState('');
 if(directory==='kyiv'||!operatorEnabled&&!onChooseGroup&&directory===null)return <LiveAddressEditor {...props}/>;
 if(directory==='odesa'&&operatorEnabled)return <OperatorLiveAddressEditor {...props} lookup={operatorLookup}/>;
 if(directory==='cached'){
  const {scope,lookup:_,...editorProps}=props;
  return <AddressEditor {...editorProps} mode="live" draftScope={scope}/>;
 }
 if(directory==='odesa')return <Modal title="Пошук тимчасово недоступний" busy={props.saving} onClose={props.onClose}>
  <p>Адресний пошук для Одещини зараз призупинено. Ваш пошук і чинні адреси збережено.</p>
  {props.onRetry&&<button className="pr-secondary" disabled={props.retrying||checking} onClick={async()=>{if(checking)return;setChecking(true);setRetryError('');try{await props.onRetry?.();}catch{setRetryError('Збереження ще не підтверджено. Перевірте цей самий запит ще раз.');}finally{setChecking(false);}}}>Перевірити збереження адреси</button>}
  {retryError&&<p role="alert">{retryError}</p>}
 </Modal>;
 return <Modal title={props.initial?'Замінити адресу':'Додати адресу'} busy={props.saving} onClose={props.onClose}>
  {props.initial&&<p className="pr-field-note">Зараз: {props.initial.city}, {props.initial.street}, {props.initial.house}. Ця адреса залишиться до підтвердження заміни.</p>}
  <p>{onChooseGroup?'Оберіть свій регіон, щоб знайти адресу або обрати групу графіка.':'Оберіть регіон, щоб знайти точну адресу в каталозі оператора.'}</p>
  <div className="pr-address-results" aria-label="Регіон адресного пошуку">
   <button type="button" className="pr-search-result" disabled={props.saving} onClick={()=>setDirectory('kyiv')}><MapPin size={18} aria-hidden="true"/><span><strong>Київ</strong><small>ДТЕК Київські електромережі · каталог YASNO</small></span><ArrowRight size={16} aria-hidden="true"/></button>
   {operatorEnabled&&<button type="button" className="pr-search-result" disabled={props.saving} onClick={()=>setDirectory('odesa')}><MapPin size={18} aria-hidden="true"/><span><strong>Одеса й Одеська область</strong><small>ДТЕК Одеські електромережі</small></span><ArrowRight size={16} aria-hidden="true"/></button>}
   {onChooseGroup&&MANUAL_GROUP_REGIONS.map(region=><button key={region.operatorId} type="button" className="pr-search-result" disabled={props.saving} onClick={()=>onChooseGroup(region)}><MapPin size={18} aria-hidden="true"/><span><strong>{region.locality}</strong><small>Обрати групу вручну</small></span><ArrowRight size={16} aria-hidden="true"/></button>)}
   {Boolean(props.catalog?.length)&&<button type="button" className="pr-search-result" disabled={props.saving} onClick={()=>setDirectory('cached')}><MapPin size={18} aria-hidden="true"/><span><strong>Завантажені адреси</strong><small>Результати попередніх пошуків</small></span><ArrowRight size={16} aria-hidden="true"/></button>}
  </div>
  <p className="pr-field-note">Чинні адреси й налаштування залишаються у профілі. Графік та адресна прив’язка перевіряються окремо.</p>
 </Modal>;
}
