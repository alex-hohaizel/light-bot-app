import test from 'node:test';
import assert from 'node:assert/strict';
import {safeStartupDiagnostic} from '../../server/production/startup-diagnostic.ts';
const canary='PRIVATE_CREDENTIAL_4f8826419b5ad0e5';
test('missing package diagnostic preserves code without message or private path',()=>{
 const e=Object.assign(new Error(`Cannot find module 'canvas' ${canary}`),{code:'MODULE_NOT_FOUND'});e.stack=`Error ${canary}\n at /private/${canary}/index.cjs:123:45`;
 const r=safeStartupDiagnostic(e);assert.equal(r.code,'MODULE_NOT_FOUND');assert.equal(r.packageHint,'canvas');assert.deepEqual(r.frames,[{file:'index.cjs',line:123,column:45}]);assert.ok(!JSON.stringify(r).includes(canary));assert.ok(!('message'in r));assert.ok(!('stack'in r));
});
test('native library and ABI hints are fixed literals only',()=>{
 const r=safeStartupDiagnostic(Object.assign(new Error(`${canary} libcairo.so.2 NODE_MODULE_VERSION /node_modules/sharp/build`),{code:'ERR_DLOPEN_FAILED'}));assert.equal(r.code,'ERR_DLOPEN_FAILED');assert.equal(r.libraryHint,'libcairo.so.2');assert.equal(r.packageHint,'sharp');assert.equal(r.abiMismatch,true);assert.ok(!JSON.stringify(r).includes(canary));
});
test('untrusted name and code never become output',()=>{
 const r=safeStartupDiagnostic({name:canary,code:canary,message:`postgresql://u:${canary}@secret.invalid/db`,stack:canary});assert.equal(r.name,'UnknownError');assert.equal(r.code,'UNKNOWN');assert.ok(!JSON.stringify(r).includes(canary));
});
test('throwing property getters cannot mask the original failure',()=>{
 const e=new Proxy({},{get(){throw Error(canary);}});assert.doesNotThrow(()=>safeStartupDiagnostic(e));assert.equal(safeStartupDiagnostic(e).code,'UNKNOWN');
});
test('non-errors and cycles are bounded',()=>{
 for(const e of [null,undefined,canary,42])assert.equal(safeStartupDiagnostic(e).code,'UNKNOWN');const c:any={name:'Error'};c.cause=c;assert.equal(safeStartupDiagnostic(c).name,'Error');
});
test('frame count and numeric ranges are bounded; unrelated files are omitted',()=>{
 const r=safeStartupDiagnostic({stack:'at secret.ts:5:9\nat index.cjs:999999:2\n'+Array.from({length:30},(_,i)=>`at /hidden/index.cjs:${i+1}:2`).join('\n')});assert.equal(r.frames.length,6);assert.equal(r.frames[0].line,1);assert.ok(r.frames.every(f=>f.file==='index.cjs'));
});
