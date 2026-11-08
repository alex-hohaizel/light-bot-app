import {useEffect,useState} from 'react';
export type ViewPreferences={theme:'light'|'dark';motion:boolean;accent:'green'|'blue'|'purple'|'rose'|'amber'|'cyan'|'orange'};
const defaults:ViewPreferences={theme:'light',motion:true,accent:'green'};
export function parseViewPreferences(value:unknown):ViewPreferences{
 if(!value||typeof value!=='object')return defaults;const v=value as Record<string,unknown>;
 return {theme:v.theme==='dark'?'dark':'light',motion:v.motion!==false,accent:['green','blue','purple','rose','amber','cyan','orange'].includes(String(v.accent))?v.accent as ViewPreferences['accent']:'green'};
}
function read(scope:string):ViewPreferences{try{const raw=localStorage.getItem('lba:view:v7:'+scope);if(raw)return parseViewPreferences(JSON.parse(raw));const wa=window.Telegram?.WebApp;return wa?.initData&&wa.colorScheme==='dark'?{...defaults,theme:'dark'}:defaults;}catch{return defaults;}}
export function useViewPreferences(scope:string){
 const [prefs,setPrefs]=useState(()=>read(scope)),[saved,setSaved]=useState(true);
 useEffect(()=>{setPrefs(read(scope));setSaved(true);const update=(e:StorageEvent)=>{if(e.key==='lba:view:v7:'+scope)setPrefs(read(scope));};window.addEventListener('storage',update);return()=>window.removeEventListener('storage',update);},[scope]);
 const update=(patch:Partial<ViewPreferences>)=>{const next=parseViewPreferences({...prefs,...patch});setPrefs(next);try{const key='lba:view:v7:'+scope,raw=JSON.stringify(next);localStorage.setItem(key,raw);setSaved(localStorage.getItem(key)===raw);}catch{setSaved(false);}};
 return {prefs,update,saved};
}
