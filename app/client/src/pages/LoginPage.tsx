import {useEffect,useRef,useState} from 'react';
import {ArrowRight,Bell,House,LogIn,Moon,Sun,Zap} from 'lucide-react';
import {useViewPreferences} from '../product-review/view-preferences';
import {completeTelegramBrowserLogin,mountTelegramLoginWidget,requestTelegramBrowserChallenge} from '../lib/telegram-login-widget';
import '../product-review/product-review.css';
import '../product-review/district.css';
import './telegram-login.css';

export function LoginPage(){
 const {prefs,update}=useViewPreferences('guest'),dark=prefs.theme==='dark';
 const [attempt,setAttempt]=useState(0),[state,setState]=useState<'idle'|'loading'|'ready'|'checking'|'error'|'expired'>('idle');
 const host=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!attempt)return;
  let alive=true,cleanup:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  setState('loading');
  void requestTelegramBrowserChallenge().then(value=>{
   if(!alive||!host.current)return;
   const remaining=Math.min(300000,value.expiresAt*1000-Date.now());
   if(remaining<=0){setState('expired');return;}
   timer=setTimeout(()=>{cleanup?.();if(alive)setState('expired');},remaining);
   cleanup=mountTelegramLoginWidget(host.current,{
    botUsername:value.botUsername,
    onReady:()=>{if(alive)setState('ready');},
    onError:()=>{if(alive){clearTimeout(timer);cleanup?.();setState('error');}},
    onData:async data=>{
     if(!alive)return;setState('checking');clearTimeout(timer);
     await completeTelegramBrowserLogin(value.challenge,data);
     if(alive)window.location.assign('/');
    },
   });
  }).catch(()=>{if(alive)setState('error');});
  return()=>{alive=false;clearTimeout(timer);cleanup?.();};
 },[attempt]);
 const busy=state==='loading'||state==='checking';
 return <main className={'pr-app pr-login'+(dark?' pr-dark':'')} data-design="district" data-accent={prefs.accent}>
  <header className="pr-login-header"><a href="/" className="pr-brand" aria-label="Світло Україна"><span className="pr-brand-mark"><Zap size={22}/></span><span>світло<span>УКРАЇНА</span></span></a><button className="pr-icon-button" onClick={()=>update({theme:dark?'light':'dark'})} aria-label={dark?'Увімкнути світлу тему':'Увімкнути темну тему'} data-testid="button-theme-toggle-login">{dark?<Sun size={19}/>:<Moon size={19}/>}</button></header>
  <section className="pr-login-main"><div className="pr-login-intro"><p className="pr-eyebrow">ВАШІ АДРЕСИ Й ПЛАНИ</p><h1 data-testid="text-app-title">Світло Україна</h1><p>Графіки для ваших адрес.<br/>Усі налаштування — в одному профілі.</p><ul><li><House size={20}/><span>Ваші збережені адреси</span></li><li><Zap size={20}/><span>Плани відключень і зміни</span></li><li><Bell size={20}/><span>Зручні налаштування сповіщень</span></li></ul></div>
   <article className="pr-panel pr-login-panel" aria-labelledby="login-title"><p className="pr-eyebrow">ОСОБИСТИЙ ПРОСТІР</p><h2 id="login-title">Увійдіть до свого профілю</h2><p>Оберіть спосіб, яким користувалися раніше. Це допоможе відкрити ваші збережені адреси й налаштування.</p>
    <div className="pr-login-telegram">
     {state==='idle'&&<button className="pr-primary" data-testid="button-login-telegram" onClick={()=>setAttempt(value=>value+1)}>Увійти через Telegram<ArrowRight size={17}/></button>}
     <div ref={host} className={state==='checking'?'pr-login-widget is-checking':'pr-login-widget'} data-testid="telegram-login-widget" aria-label="Офіційна кнопка входу Telegram"/>
     {busy&&<p role="status">{state==='checking'?'Підтверджуємо вхід…':'Завантажуємо кнопку Telegram…'}</p>}
     {state==='ready'&&<p className="pr-field-note">Підтвердьте вхід у вікні Telegram. Повертатися до бота й вводити команди не потрібно.</p>}
     {(state==='error'||state==='expired')&&<div role="alert" className="pr-login-message"><p>{state==='expired'?'Час цієї спроби минув. Почніть ще раз.':'Вхід через Telegram ще не підтверджено. Оновіть сторінку, щоб перевірити стан, або почніть нову спробу.'}</p><div><button className="pr-secondary" onClick={()=>window.location.reload()}>Оновити сторінку</button><button className="pr-text-button" onClick={()=>setAttempt(value=>value+1)}>Спробувати ще раз</button></div></div>}
    </div>
    <div className="pr-login-divider"><span>або</span></div><a href="/api/login" className="pr-secondary pr-login-replit" data-testid="button-login"><LogIn size={17}/>Увійти через Replit</a>
    <p className="pr-field-note">Використовуйте попередній спосіб входу. Прив’язати інший акаунт можна після входу в налаштуваннях.</p>
   </article>
  </section><footer className="pr-login-footer">Ваш графік — у вебі та Telegram</footer>
 </main>;
}
