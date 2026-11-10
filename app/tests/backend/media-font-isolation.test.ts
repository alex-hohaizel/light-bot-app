import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const source=fileURLToPath(new URL('../../server/production/media-fonts.ts',import.meta.url));
const sourceFonts=fileURLToPath(new URL('../../client/public/fonts/',import.meta.url));
const uuid='d84e33d1-6856-43c3-8f9c-6a89a7ad7b31';
async function fixture(run:(f:any)=>Promise<void>|void){
 const root=mkdtempSync(path.join(tmpdir(),'lba-font-isolation-test-')),app=path.join(root,'app'),fonts=path.join(app,'client/public/fonts'),module=path.join(app,'server/production/media-fonts.ts');
 mkdirSync(fonts,{recursive:true});mkdirSync(path.dirname(module),{recursive:true});writeFileSync(path.join(app,'package.json'),' {"type":"module"}\n');copyFileSync(source,module);
 for(const name of readdirSync(sourceFonts))copyFileSync(path.join(sourceFonts,name),path.join(fonts,name));
 const before=new Set(process.listeners('exit')),keys=['FONTCONFIG_FILE','FONTCONFIG_PATH','PANGOCAIRO_BACKEND'] as const,previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const cleanup=()=>{for(const listener of process.listeners('exit'))if(!before.has(listener)){listener(0);process.removeListener('exit',listener);}};
 try{const api=await import(pathToFileURL(module).href);await run({api,fonts,cleanup,prepare:()=>{const config=api.prepareBundledMediaFonts();return {config,privateRoot:path.dirname(config.configPath),working:path.join(path.dirname(config.configPath),'fonts')};}});}
 finally{
  cleanup();
  for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  rmSync(root,{recursive:true,force:true});
 }
}
const mismatch=(error:any)=>error?.code==='MEDIA_FONT_ASSET_MISMATCH'||error?.code==='MEDIA_FONT_CONFIGURATION_CHANGED';
test('Fontconfig uses private verified copies and valid UUID metadata leaves original assets exact',async()=>fixture(({api,fonts,prepare,cleanup}:any)=>{
 const {config,working,privateRoot}=prepare(),xml=readFileSync(config.configPath,'utf8');
 assert.ok(xml.includes(`<dir>${realpathSync(working)}</dir>`));assert.ok(!xml.includes(`<dir>${realpathSync(fonts)}</dir>`));
 for(const name of readdirSync(fonts))assert.deepEqual(readFileSync(path.join(working,name)),readFileSync(path.join(fonts,name)));
 writeFileSync(path.join(working,'.uuid'),uuid+'\n');assert.equal(api.requireBundledMediaFontsReady(),config);assert.equal(api.prepareBundledMediaFonts(),config);
 assert.deepEqual(readdirSync(fonts).sort(),['manrope-OFL.txt','manrope.ttf','onest-OFL.txt','onest.ttf']);
 cleanup();assert.equal(existsSync(privateRoot),false);
}));
test('tampered working font bytes are rejected despite intact originals',async()=>fixture(({api,prepare}:any)=>{
 const {working}=prepare(),file=path.join(working,'onest.ttf'),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);assert.throws(()=>api.requireBundledMediaFontsReady(),mismatch);
}));
test('symlink working font cannot replace a pinned copy',async()=>fixture(({api,fonts,prepare}:any)=>{
 const {working}=prepare(),file=path.join(working,'onest.ttf');rmSync(file);symlinkSync(path.join(fonts,'onest.ttf'),file);assert.throws(()=>api.requireBundledMediaFontsReady(),mismatch);
}));
test('unapproved working font and arbitrary metadata remain rejected',async()=>fixture(({api,prepare}:any)=>{
 const {working}=prepare();for(const name of ['extra.ttf','extra.txt']){writeFileSync(path.join(working,name),'unapproved');assert.throws(()=>api.requireBundledMediaFontsReady(),mismatch);rmSync(path.join(working,name));}
}));
test('malformed or symlink UUID metadata is rejected',async()=>fixture(({api,fonts,prepare}:any)=>{
 const {working}=prepare(),file=path.join(working,'.uuid');writeFileSync(file,'not-a-valid-uuid');assert.throws(()=>api.requireBundledMediaFontsReady(),mismatch);rmSync(file);symlinkSync(path.join(fonts,'onest-OFL.txt'),file);assert.throws(()=>api.requireBundledMediaFontsReady(),mismatch);
}));
test('original asset directory still rejects even valid UUID metadata',async()=>fixture(({api,fonts}:any)=>{
 writeFileSync(path.join(fonts,'.uuid'),uuid);assert.throws(()=>api.prepareBundledMediaFonts(),mismatch);
}));
test('original asset byte guard remains fatal before preparation',async()=>fixture(({api,fonts}:any)=>{
 const file=path.join(fonts,'manrope.ttf'),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);assert.throws(()=>api.prepareBundledMediaFonts(),mismatch);
}));
