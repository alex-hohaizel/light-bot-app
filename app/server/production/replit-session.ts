interface ReplitTokens {access_token:unknown;refresh_token?:unknown;expires_in?:unknown;claims:()=>Record<string,unknown>|undefined}
export interface ReplitSessionIdentity {providerIdentity:{issuer:'replit';subject:string};claims:Record<string,unknown>&{sub:string};access_token:string;refresh_token?:string;expires_at:number}
const text=(v:unknown,max=16384):v is string=>typeof v==='string'&&Boolean(v)&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
/** Preserves canonical owner through token refresh. Missing ID token is not an
 * invitation to replace the canonical ID with a provider subject or erase claims.
 * The caller revalidates current explicit provider→owner mapping before applying.
 */
export function prepareReplitSession(previous:Partial<ReplitSessionIdentity>|null,tokens:ReplitTokens,ownerId:string,now:number):ReplitSessionIdentity{
 if(!text(ownerId,255)||!Number.isSafeInteger(now)||typeof tokens?.claims!=='function'||!text(tokens.access_token))throw Error('REPLIT_SESSION_INVALID');
 const signed=tokens.claims();
 if(signed!==undefined&&(!signed||typeof signed!=='object'||Array.isArray(signed)||!text(signed.sub,255)))throw Error('REPLIT_SESSION_INVALID');
 const oldSubject=previous?.providerIdentity?.issuer==='replit'?previous.providerIdentity.subject:undefined;
 const subject=signed?.sub??oldSubject;
 if(!text(subject,255)||oldSubject!==undefined&&oldSubject!==subject||previous?.claims?.sub!==undefined&&previous.claims.sub!==ownerId)throw Error('REPLIT_SESSION_IDENTITY_CHANGED');
 const source=signed??previous?.claims;if(!source||typeof source!=='object'||Array.isArray(source))throw Error('REPLIT_SESSION_INVALID');
 let expiry:number;
 if(signed){if(!Number.isSafeInteger(signed.exp)||Number(signed.exp)<=now)throw Error('REPLIT_SESSION_EXPIRED');expiry=Number(signed.exp);}
 else{if(!Number.isSafeInteger(tokens.expires_in)||Number(tokens.expires_in)<=0||Number(tokens.expires_in)>7*86400)throw Error('REPLIT_SESSION_EXPIRY_UNCONFIRMED');expiry=now+Number(tokens.expires_in);}
 const refresh=tokens.refresh_token===undefined?previous?.refresh_token:tokens.refresh_token;
 if(refresh!==undefined&&!text(refresh))throw Error('REPLIT_SESSION_INVALID');
 return {providerIdentity:{issuer:'replit',subject},claims:{...source,sub:ownerId},access_token:tokens.access_token,...(refresh!==undefined?{refresh_token:refresh}:{}),expires_at:expiry};
}
