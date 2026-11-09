import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import LiveProduct from '../../client/src/product-runtime/LiveProduct';
import {LiveAccountSettings,type AccountScope} from '../../client/src/product-review/LiveAccountSettings';
import '../../client/src/product-review/product-review.css';
import '../../client/src/product-review/district.css';
declare global{interface Window{peerAccountScope?:(scope:AccountScope)=>void}}
function PeerWrapper(){
 const [scope,setScope]=useState<AccountScope>({ownerId:'peer-owner-original',sessionId:'peer-profile-original',revision:19});window.peerAccountScope=setScope;
 if(location.pathname==='/entry')return <LiveProduct/>;
 return <main className={'pr-app'+(location.search.includes('night')?' pr-dark':'')} data-design="district" style={{padding:18,minHeight:'100dvh'}}><LiveAccountSettings scope={scope}/></main>;
}
createRoot(document.getElementById('root')!).render(<PeerWrapper/>);
