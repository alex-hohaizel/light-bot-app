/** Bounded failure metadata. Never returns messages, raw stacks or environment. */
const codes=new Set(['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ERR_REQUIRE_ESM','ERR_REQUIRE_ASYNC_MODULE','ERR_DLOPEN_FAILED','ERR_UNKNOWN_FILE_EXTENSION','ERR_INVALID_ARG_TYPE','ERR_INVALID_URL','ENOENT','EACCES','EPERM','ENOTDIR','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EADDRINUSE']);
const names=new Set(['Error','TypeError','ReferenceError','SyntaxError','RangeError','URIError','AggregateError','RuntimePolicyError']);
const packages=['canvas','sharp','nanoid','openid-client','express','pg','@resvg/resvg-js'];
const libraries=['libcairo.so.2','libuuid.so.1','libpango-1.0.so.0','libpangocairo-1.0.so.0','libstdc++.so.6','libvips.so.42','libvips-cpp.so.42'];
function field(error:unknown,key:string):string{
  try{if(error!==null&&(typeof error==='object'||typeof error==='function')){const v=Reflect.get(error,key);if(typeof v==='string')return v;}}catch{}
  return '';
}
export function safeStartupDiagnostic(error:unknown){
  const code=field(error,'code'),name=field(error,'name'),message=field(error,'message'),stack=field(error,'stack');
  const frames:Array<{file:string;line:number;column:number}>=[];
  for(const m of stack.matchAll(/\b(index\.cjs|production-entry\.(?:ts|js)):(\d{1,6}):(\d{1,6})\b/g)){
    const line=Number(m[2]),column=Number(m[3]);
    if(line>0&&line<=200000&&column>0&&column<=200000)frames.push({file:m[1],line,column});
    if(frames.length===6)break;
  }
  const packageHint=packages.find(p=>message.includes(`/node_modules/${p}/`)||message.includes(`Cannot find module '${p}'`)||message.includes(`Cannot find package '${p}'`))??null;
  return Object.freeze({phase:'module-import',name:names.has(name)?name:'UnknownError',code:codes.has(code)?code:'UNKNOWN',packageHint,libraryHint:libraries.find(v=>message.includes(v))??null,abiMismatch:message.includes('NODE_MODULE_VERSION'),frames});
}
