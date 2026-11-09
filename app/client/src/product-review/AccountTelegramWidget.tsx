import {useEffect,useRef,useState} from 'react';
import {mountTelegramLoginWidget} from '../lib/telegram-login-widget';
import './account-telegram-widget.css';

/** An explicit link-proof action. It never calls a login endpoint or saves provider data. */
export function AccountTelegramWidget({botUsername,submitted,disabled,onProof}:{botUsername:string;submitted:boolean;disabled:boolean;onProof:(data:unknown)=>Promise<void>}){
 const host=useRef<HTMLDivElement>(null),latest=useRef(onProof);latest.current=onProof;
 const [attempt,setAttempt]=useState(0),[state,setState]=useState<'idle'|'loading'|'ready'|'sent'|'error'>('idle');
 useEffect(()=>{
  if(!attempt||submitted||disabled||!host.current)return;
  let alive=true;setState('loading');
  const cleanup=mountTelegramLoginWidget(host.current,{botUsername,onReady:()=>{if(alive)setState('ready');},onError:()=>{if(alive)setState('error');},onData:async data=>{if(!alive)return;setState('sent');await latest.current(data);}});
  return()=>{alive=false;cleanup();};
 },[attempt,botUsername,submitted,disabled]);
 return <div className="pr-account-widget" data-testid="account-telegram-widget">
  {submitted||state==='sent'?<p className="pr-field-note" role="status">Спробу підтвердження вже розпочато. Перевірте її результат у цій вкладці. Нові дані Telegram автоматично не надсилаються.</p>:<>
   {(!attempt||state==='error')&&<button className="pr-primary" disabled={disabled} onClick={()=>setAttempt(value=>value+1)}>{state==='error'?'Завантажити кнопку ще раз':'Підтвердити Telegram у цьому браузері'}</button>}
   <div ref={host} aria-label="Офіційна кнопка підтвердження Telegram"/>
   {state==='loading'&&<p role="status">Завантажуємо кнопку Telegram…</p>}
   {state==='ready'&&<p className="pr-field-note">Підтвердьте свій акаунт у вікні Telegram. Остаточна прив’язка потребує окремого підтвердження нижче.</p>}
   {state==='error'&&<p role="alert" className="pr-account-message pr-account-warning">Не вдалося завантажити або підтвердити Telegram. Перевірте стан цієї спроби нижче.</p>}
  </>}
 </div>;
}
