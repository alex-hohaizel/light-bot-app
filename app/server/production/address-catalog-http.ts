import {createHash} from 'node:crypto';
import type {SourceHttpTransport} from './source-intake.ts';
import type {YasnoAddressCapture} from '../domain/yasno-address-adapter.ts';

export type AddressHttpCode='ADDRESS_TIMEOUT'|'ADDRESS_TRANSPORT_FAILED'|'ADDRESS_ORIGIN_REJECTED'|
 'ADDRESS_HTTP_REJECTED'|'ADDRESS_RATE_LIMITED'|'ADDRESS_RATE_LIMIT_UNVERIFIED'|
 'ADDRESS_BODY_LIMIT'|'ADDRESS_CONTENT_TYPE_REJECTED'|'ADDRESS_ENCODING_REJECTED'|'ADDRESS_UTF8_REJECTED';
export interface AddressHttpFailure {ok:false;code:AddressHttpCode;hold:boolean;workerHold:boolean;retryAfterMs?:number;}
export type AddressHttpResult={ok:true;capture:YasnoAddressCapture}|AddressHttpFailure;
const MAX_BYTES=250000;
const failure=(code:AddressHttpCode,hold=false,workerHold=false):AddressHttpFailure=>({ok:false,code,hold,workerHold});

/** No fetch, environment, credentials or import IO. The caller has already
 * committed the shared origin reservation; a timeout must remain durably held.
 * Even a transport ignoring AbortSignal cannot produce a late cache write.
 */
export async function collectAddressCapture(input:{url:string;transport:SourceHttpTransport;now:()=>number;timeoutMs:number}):Promise<AddressHttpResult>{
 try{const u=new URL(input.url);if(u.origin!=='https://app.yasno.ua'||u.username||u.password||u.hash||
  !/^\/api\/blackout-service\/public\/shutdowns\/addresses\/v2\/(streets|houses|group)$/.test(u.pathname))return failure('ADDRESS_ORIGIN_REJECTED',true);}
 catch{return failure('ADDRESS_ORIGIN_REJECTED',true);}
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
 const operation=Promise.resolve().then(async():Promise<AddressHttpResult>=>{
  try{
   const r=await input.transport({url:input.url,method:'GET',redirect:'error',credentials:'omit',headers:{'accept-encoding':'identity'},signal:controller.signal,maxBytes:MAX_BYTES});
   if(controller.signal.aborted)return failure('ADDRESS_TIMEOUT',true,true);
   if(!r||r.url!==input.url)return failure('ADDRESS_ORIGIN_REJECTED',true);
   const header=(key:string)=>{
    const rows=Object.entries(r.headers).filter(([k])=>k.toLowerCase()===key);
    if(rows.length>1||rows.some(([,v])=>v!==undefined&&typeof v!=='string'))throw Error('AMBIGUOUS_HEADERS');
    return rows[0]?.[1];
   };
   if(r.status===429){
    const retry=header('retry-after');
    return typeof retry==='string'&&/^[1-9]\d{0,4}$/.test(retry)&&Number(retry)<=86400
     ?{ok:false,code:'ADDRESS_RATE_LIMITED',hold:false,workerHold:false,retryAfterMs:Number(retry)*1000}
     :failure('ADDRESS_RATE_LIMIT_UNVERIFIED',true);
   }
   if(r.status!==200)return failure('ADDRESS_HTTP_REJECTED',r.status===403);
   const encoding=header('content-encoding');
   if(encoding!==undefined&&encoding.trim().toLowerCase()!=='identity')return failure('ADDRESS_ENCODING_REJECTED');
   const contentType=header('content-type');
   if(typeof contentType!=='string'||!/^application\/json(?:\s*;|$)/i.test(contentType))return failure('ADDRESS_CONTENT_TYPE_REJECTED');
   const length=header('content-length');
   if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))return failure('ADDRESS_BODY_LIMIT');
   const chunks:Uint8Array[]=[];let size=0;
   for await(const chunk of r.body){
    if(controller.signal.aborted)return failure('ADDRESS_TIMEOUT',true,true);
    if(!(chunk instanceof Uint8Array)||!chunk.byteLength||chunks.length>=4096||chunk.byteLength>MAX_BYTES-size)return failure('ADDRESS_BODY_LIMIT');
    size+=chunk.byteLength;chunks.push(Uint8Array.from(chunk));
   }
   if(!size||length!==undefined&&Number(length)!==size)return failure('ADDRESS_BODY_LIMIT');
   let rawBody:string;const bytes=Buffer.concat(chunks,size);
   try{rawBody=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return failure('ADDRESS_UTF8_REJECTED');}
   if(controller.signal.aborted)return failure('ADDRESS_TIMEOUT',true,true);
   return {ok:true,capture:{sourceId:'yasno-public-address-v2',method:'GET',url:input.url,httpStatus:200,contentType,
    observedAt:new Date(input.now()).toISOString(),rawBody,rawSha256:createHash('sha256').update(bytes).digest('hex')}};
   }catch{return controller.signal.aborted?failure('ADDRESS_TIMEOUT',true,true):failure('ADDRESS_TRANSPORT_FAILED');}
 });
 const deadline=new Promise<AddressHttpFailure>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(failure('ADDRESS_TIMEOUT',true,true));},input.timeoutMs);});
 try{return await Promise.race([operation,deadline]);}finally{clearTimeout(timer!);controller.abort();}
}
