/** Route templates never include public capabilities, login proofs or personal
 * address fragments. Query strings and request/response bodies are not logged. */
export function safeApiLogPath(path:string):string{
 if(!path.startsWith('/api'))return '/non-api';
 if(/^\/api\/product\/shared(?:\/|$)/i.test(path))return '/api/product/shared/:token';
 if(/^\/api\/auth(?:\/|$)/i.test(path))return '/api/auth/:operation';
 if(/^\/api\/(?:share|compare\/share)(?:\/|$)/i.test(path))return '/api/share/:capability';
 // Only a closed set of known static paths survives. Dynamic legacy paths are
 // intentionally summarized even if the old handler still accepts them.
 return /^\/api\/(?:product\/(?:profile(?:\/receipt)?|tools(?:\/recover)?|address\/lookup)|health\/release|telegram-webhook|auth\/user)$/.test(path)?path:'/api/:operation';
}
