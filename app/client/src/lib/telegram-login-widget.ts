export type TelegramBrowserChallenge={challenge:string;expiresAt:number;botUsername:string};
const ROOT='/api/auth/telegram-browser';
export async function requestTelegramBrowserChallenge():Promise<TelegramBrowserChallenge>{
 const response=await fetch(ROOT+'/challenge',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:'{}'});
 const value=await response.json();
 if(!response.ok||!value||Object.keys(value).sort().join(',')!=='botUsername,challenge,expiresAt'||
  typeof value.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.challenge)||!Number.isSafeInteger(value.expiresAt)||
  typeof value.botUsername!=='string'||!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value.botUsername))throw Error('TELEGRAM_BROWSER_UNAVAILABLE');
 return value;
}
export async function completeTelegramBrowserLogin(challenge:string,telegramData:unknown):Promise<void>{
 // A lost response can follow a successful login. Confirm the actual cookie session in both cases.
 try{
  const response=await fetch(ROOT+'/complete',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge,telegramData})});
  const value=await response.json();
  if(!response.ok||!value||Object.keys(value).join(',')!=='ok'||value.ok!==true)throw Error('TELEGRAM_BROWSER_UNCONFIRMED');
 }catch{/* The session read below is authoritative; an unconfirmed response is never called unexecuted. */}
 const session=await fetch('/api/auth/user',{credentials:'same-origin',cache:'no-store'});
 const user=await session.json();
 if(!session.ok||!user||typeof user.id!=='string'||!user.id.trim())throw Error('TELEGRAM_BROWSER_UNCONFIRMED');
}

/** Telegram's documented legacy iframe widget. Its signed payload is trusted only after server verification. */
export function mountTelegramLoginWidget(host:HTMLElement,options:{botUsername:string;onData:(data:unknown)=>Promise<void>;onReady:()=>void;onError:()=>void}){
 if(!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(options.botUsername))throw Error('TELEGRAM_BROWSER_CONFIGURATION');
 const callback='__lbaTelegramLogin_'+crypto.randomUUID().replaceAll('-','');
 const globals=window as unknown as Record<string,unknown>;
 let alive=true,used=false;
 const script=document.createElement('script');
 const timer=setTimeout(()=>{if(alive&&!host.querySelector('iframe'))options.onError();},12000);
 globals[callback]=(data:unknown)=>{
  if(!alive||used)return;used=true;
  void options.onData(data).catch(()=>{if(alive)options.onError();});
 };
 script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';
 script.setAttribute('data-telegram-login',options.botUsername);
 script.setAttribute('data-size','large');script.setAttribute('data-userpic','false');
 script.setAttribute('data-radius','10');script.setAttribute('data-lang','uk');
 script.setAttribute('data-onauth',callback+'(user)');
 // No redirect query login and no bot messaging permission are requested.
 script.onload=()=>{if(alive&&host.querySelector('iframe')){clearTimeout(timer);options.onReady();}};
 script.onerror=()=>{if(alive){clearTimeout(timer);options.onError();}};
 host.replaceChildren(script);
 return ()=>{alive=false;clearTimeout(timer);script.onload=null;script.onerror=null;delete globals[callback];host.replaceChildren();};
}
