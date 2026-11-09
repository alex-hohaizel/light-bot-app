import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import LiveProduct from '../../client/src/product-runtime/LiveProduct';
import {LiveAccountSettings,type AccountScope} from '../../client/src/product-review/LiveAccountSettings';
import '../../client/src/product-review/product-review.css';
import '../../client/src/product-review/district.css';
declare global {interface Window {renderAccountScope?:(scope:AccountScope)=>void}}
function Fixture(){
 const [scope,setScope]=useState<AccountScope>({ownerId:'fixture-owner-a',sessionId:'fixture-session-a',revision:7});window.renderAccountScope=setScope;
 if(new URLSearchParams(location.search).has('proof')||new URLSearchParams(location.search).has('normal'))return <LiveProduct/>;
 return <main className={'pr-app'+(new URLSearchParams(location.search).has('night')?' pr-dark':'')} data-design="district" style={{padding:20,minHeight:'100dvh'}}><LiveAccountSettings scope={scope}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
