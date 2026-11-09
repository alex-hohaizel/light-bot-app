import {useEffect,useRef,useState} from 'react';
import {useAuth} from '@/hooks/useAuth';
import {getTelegramWebApp} from '@/lib/telegram-webapp';
import {LoginPage} from '@/pages/LoginPage';
import ProductRuntime from './ProductRuntime';
import {AccountRecoveryOnly,PENDING_ACCOUNT_OPERATION_KEY,readPendingAccountRecoveryHints,accountErrorMessage} from '../product-review/LiveAccountSettings';
import '../product-review/product-review.css';
import '../product-review/district.css';

/** Only selects a consent screen. The server verifies the complete signed data. */
export function isAccountLinkEntry(initData:string):boolean{
  try{return new URLSearchParams(initData).getAll('start_param').some(value=>value.startsWith('acctlink_'));}catch{return false;}
}

export function TelegramAccountProof({initData}:{initData:string}){
  const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
  const working=useRef(false);
  const app=getTelegramWebApp();
  useEffect(()=>{app?.ready();app?.expand();},[]);
  async function confirm(){
    if(!consent||working.current||done)return;working.current=true;setBusy(true);setError('');
    try{
      let response:Response,value:any;
      try{response=await fetch('/api/product/accounts/telegram/proof',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData})});value=await response.json();}catch{throw Error(accountErrorMessage(null));}
      if(!response.ok)throw Error(accountErrorMessage(value?.code));
      if(!value||Object.keys(value).sort().join(',')!=='kind,state'||value.kind!=='proof'||value.state!=='ready_for_confirmation')throw Error(accountErrorMessage(null));
      setDone(true);
    }catch(e){setError(e instanceof Error&&e.message!==''?e.message:accountErrorMessage(null));}finally{working.current=false;setBusy(false);}
  }
  return <main className={'pr-app pr-account-proof'+(app?.colorScheme==='dark'?' pr-dark':'')} data-design="district"><article className="pr-panel"><p className="pr-eyebrow">Світло Україна · Telegram</p><h1>{done?'Поверніться до браузера':'Підтвердити Telegram для прив’язки'}</h1>{done?<><p role="status">Володіння Telegram підтверджено. Прив’язку ще потрібно завершити.</p><p>Поверніться до тієї самої вкладки браузера, де ви почали прив’язку. Натисніть «Перевірити підтвердження», перевірте акаунт і підтвердьте остаточну прив’язку.</p><p className="pr-field-note">Посилання діє п’ять хвилин від початку спроби.</p>{app&&<button className="pr-secondary" onClick={()=>app.close()}>Закрити Mini App</button>}</>:<><p>Продовжуйте, лише якщо ви щойно почали прив’язку Telegram у своєму профілі на сайті «Світло Україна».</p><p>Після цього потрібно повернутися до початкового браузера й окремо підтвердити прив’язку. Адреси та налаштування залишаться у вашому профілі.</p><label className="pr-account-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/><span>Це моя спроба прив’язки. Хочу підтвердити свій Telegram.</span></label>{error&&<div className="pr-account-message pr-account-warning" role="alert"><p>{error}</p><p>Якщо результат невідомий, поверніться до початкової вкладки й перевірте підтвердження там.</p></div>}<button className="pr-primary" disabled={!consent||busy} onClick={()=>void confirm()}>{busy?'Перевіряємо…':'Підтвердити мій Telegram'}</button>{app&&<button className="pr-text-button" disabled={busy} onClick={()=>app.close()}>Скасувати й закрити</button>}<p className="pr-field-note">Якщо ви не починали цю дію, закрийте це вікно.</p></>}</article></main>;
}

/** Uses the existing real account/session flows without legacy local-store profile syncing. */
export default function LiveProduct(){
  const app=getTelegramWebApp();
  if(app&&isAccountLinkEntry(app.initData))return <TelegramAccountProof key={app.initData} initData={app.initData}/>;
  return <SignedInProduct/>;
}
function SignedInProduct(){
  const {user,isLoading,refetch}=useAuth();
  const [recovery]=useState(()=>{try{return {present:sessionStorage.getItem(PENDING_ACCOUNT_OPERATION_KEY)!==null,hints:readPendingAccountRecoveryHints(sessionStorage)};}catch{return {present:false,hints:[]};}});
  const [showLogin,setShowLogin]=useState(false);
  const [attempted,setAttempted]=useState(false),[authenticating,setAuthenticating]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(user||isLoading||attempted||recovery.present||showLogin)return;
    const app=getTelegramWebApp();
    if(!app?.initData)return;
    setAttempted(true);setAuthenticating(true);app.ready();app.expand();
    void fetch('/api/auth/telegram-webapp',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:app.initData})})
      .then(async response=>{if(!response.ok)throw Error('Не вдалося підтвердити вхід через Telegram. Відкрийте застосунок у боті ще раз.');await refetch();})
      .catch(e=>setError(e.message)).finally(()=>setAuthenticating(false));
  },[user,isLoading,attempted,refetch,recovery.present,showLogin]);
  if(isLoading||authenticating)return <main className="pr-app"><div className="pr-empty-state" role="status"><h1>Світло Україна</h1><p>Перевіряємо ваш вхід…</p></div></main>;
  if(!user&&recovery.hints.length===1&&!showLogin)return <AccountRecoveryOnly hint={recovery.hints[0]} theme={getTelegramWebApp()?.colorScheme} onSignIn={()=>setShowLogin(true)}/>;
  if(!user)return <>{error&&<div className="pr-runtime-error" role="alert">{error}</div>}{recovery.present&&recovery.hints.length!==1&&<p className="pr-runtime-error" role="status">Не вдалося однозначно відновити попередній запит у цій вкладці. Увійдіть до свого профілю й перевірте його стан перед новою дією.</p>}<LoginPage/></>;
  return <ProductRuntime key={user.id} mode="live"/>;
}
