'use strict';
// Observe bounded distinct loader failures. Never emit raw messages, paths or stacks.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const app=path.resolve(__dirname,'../app');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let packageNames;
try{
 const bytes=fs.readFileSync(path.join(app,'package-lock.json'));
 if(sha(bytes)!=='784c82ca5529b0223ae3037eeb2f36a48791235bac92d125ece53973ed8c8906')throw Error('LOCK_DRIFT');
 packageNames=new Set();
 for(const key of Object.keys(JSON.parse(bytes).packages))for(const m of key.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g))if(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(m[1]))packageNames.add(m[1]);
 if(!packageNames.has('express')||!packageNames.has('canvas'))throw Error('LOCK_INVALID');
}catch{console.error('LBA_MODULE_DIAGNOSTIC_CONFIGURATION_FAILED');process.exit(1);}
const original=Module._load,seen=new Set();let last=null;
const fixedNativeNames=new Set(['canvas.node','sharp-linux-x64.node','sharp-linuxmusl-x64.node']);
function knownPackage(value){
 if(typeof value!=='string'||value.startsWith('.')||path.isAbsolute(value))return null;
 const parts=value.split('/'),name=value.startsWith('@')?parts.slice(0,2).join('/'):parts[0];
 return packageNames.has(name)?name:null;
}
function parentPackage(parent){
 try{const file=parent&&parent.filename;if(typeof file!=='string')return null;const prefix=path.join(app,'node_modules')+path.sep;if(!file.startsWith(prefix))return null;const relative=file.slice(prefix.length);let name=null;for(const m of ('node_modules/'+relative).matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g))if(packageNames.has(m[1]))name=m[1];return name;}catch{return null;}
}
Module._load=function(request,parent,isMain){
 try{return Reflect.apply(original,this,arguments);}catch(error){
  let code;try{code=error&&error.code;}catch{}
  if(code==='MODULE_NOT_FOUND'||code==='ERR_MODULE_NOT_FOUND'||code==='ERR_DLOPEN_FAILED'){
   try{const base=typeof request==='string'?path.basename(request):'';const record={code,requestedPackage:knownPackage(request),parentPackage:parentPackage(parent),nativeFile:fixedNativeNames.has(base)?base:null,node:process.version,platform:process.platform,arch:process.arch};const key=JSON.stringify(record);last=record;if(!seen.has(key)&&seen.size<20){seen.add(key);console.error('LBA_MODULE_RESOLUTION_FAILED',key);}}catch{}
  }
  throw error;
 }
};
process.once('beforeExit',()=>{if(process.exitCode&&last)try{console.error('LBA_MODULE_RESOLUTION_LAST_OBSERVED',JSON.stringify(last));}catch{}});
