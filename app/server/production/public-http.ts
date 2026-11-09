import type {SourceHttpTransport} from './source-intake.ts';
/** One explicit anonymous transport; service-specific scope, budget and captures
 * remain enforced by their shared coordinator. Never forwards caller cookies. */
export function publicSourceTransport(fetchPort:typeof fetch):SourceHttpTransport{
 return async request=>{
  const u=new URL(request.url);
  if(!['https://app.yasno.ua','https://raw.githubusercontent.com','https://www.dtek-oem.com.ua','https://oblenergo.kharkiv.ua'].includes(u.origin)||u.username||u.password||u.hash||request.method!=='GET'||request.credentials!=='omit'||request.redirect!=='error')throw Error('PUBLIC_SOURCE_TRANSPORT_SCOPE');
  const response=await fetchPort(request.url,{method:'GET',redirect:'error',credentials:'omit',headers:{accept:'application/json, application/xml;q=0.9, text/plain;q=0.8, text/html;q=0.7','accept-encoding':'identity'},signal:request.signal});
  const body=(async function*(){
   if(!response.body)return;const reader=response.body.getReader();
   try{for(;;){const result=await reader.read();if(result.done)return;yield result.value;}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  })();
  return {status:response.status,url:response.url,headers:Object.fromEntries(response.headers.entries()),body};
 };
}
