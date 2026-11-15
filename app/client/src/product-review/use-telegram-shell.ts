import {useEffect,useRef} from 'react';
import {getTelegramWebApp} from '@/lib/telegram-webapp';
/** Presentation-only bridge. Authentication remains a server responsibility. */
export function useTelegramShell(theme:'light'|'dark',hasBack:boolean,onBack:()=>void){
 const back=useRef(onBack);back.current=onBack;
 useEffect(()=>{const wa=getTelegramWebApp();if(!wa)return;const handler=()=>back.current();
  try{wa.ready();wa.expand();wa.BackButton.onClick(handler);}catch{}
  const insets=()=>{const safe=wa as typeof wa&{safeAreaInset?:{top?:number;bottom?:number};contentSafeAreaInset?:{top?:number;bottom?:number}};const bound=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)?Math.max(0,Math.min(240,n)):0;document.documentElement.style.setProperty('--pr-safe-top',Math.max(bound(safe.safeAreaInset?.top),bound(safe.contentSafeAreaInset?.top))+'px');document.documentElement.style.setProperty('--pr-safe-bottom',Math.max(bound(safe.safeAreaInset?.bottom),bound(safe.contentSafeAreaInset?.bottom))+'px');};insets();
  try{wa.onEvent('safeAreaChanged',insets);wa.onEvent('contentSafeAreaChanged',insets);}catch{}
  return()=>{try{wa.BackButton.offClick(handler);wa.BackButton.hide();wa.offEvent('safeAreaChanged',insets);wa.offEvent('contentSafeAreaChanged',insets);}catch{}document.documentElement.style.removeProperty('--pr-safe-top');document.documentElement.style.removeProperty('--pr-safe-bottom');};
 },[]);
 useEffect(()=>{const wa=getTelegramWebApp();if(!wa)return;try{hasBack?wa.BackButton.show():wa.BackButton.hide();}catch{}},[hasBack]);
 useEffect(()=>{const wa=getTelegramWebApp();if(!wa)return;try{const color=theme==='dark'?'#1e262f':'#f2f5f2';wa.setHeaderColor(color);wa.setBackgroundColor(color);}catch{}},[theme]);
}
