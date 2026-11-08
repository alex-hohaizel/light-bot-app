import {useEffect,useRef,type ReactNode} from 'react';
export function Modal({title,children,onClose,busy=false}:{title:string;children:ReactNode;onClose():void;busy?:boolean}){
 const ref=useRef<HTMLDialogElement>(null),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.showModal();return()=>{ref.current?.close();previous?.focus();};},[]);
 return <dialog className="pr-native-dialog" ref={ref} aria-label={title} onCancel={e=>{e.preventDefault();if(!busy)close.current();}} onClick={e=>{if(e.target===e.currentTarget&&!busy)close.current();}}><div><div className="pr-modal-heading"><h2>{title}</h2><button className="pr-icon-button" disabled={busy} onClick={onClose} aria-label="Закрити">×</button></div>{children}</div></dialog>;
}
