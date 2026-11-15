import {useEffect,useState} from 'react';
import {useAuth} from '@/hooks/useAuth';
import {getTelegramWebApp} from '@/lib/telegram-webapp';
import {LoginPage} from '@/pages/LoginPage';
import ProductRuntime from './ProductRuntime';

/** Uses the existing real account/session flows without legacy local-store profile syncing. */
export default function LiveProduct(){
  const {user,isLoading,refetch}=useAuth();
  const [attempted,setAttempted]=useState(false),[authenticating,setAuthenticating]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(user||isLoading||attempted)return;
    const app=getTelegramWebApp();
    if(!app?.initData)return;
    setAttempted(true);setAuthenticating(true);app.ready();app.expand();
    void fetch('/api/auth/telegram-webapp',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:app.initData})})
      .then(async response=>{if(!response.ok)throw Error('Не вдалося підтвердити вхід через Telegram. Відкрийте застосунок у боті ще раз.');await refetch();})
      .catch(e=>setError(e.message)).finally(()=>setAuthenticating(false));
  },[user,isLoading,attempted,refetch]);
  if(isLoading||authenticating)return <main className="pr-app"><div className="pr-empty-state" role="status"><h1>Світло Україна</h1><p>Перевіряємо ваш вхід…</p></div></main>;
  if(!user)return <>{error&&<div className="pr-runtime-error" role="alert">{error}</div>}<LoginPage/></>;
  return <ProductRuntime mode="live"/>;
}
