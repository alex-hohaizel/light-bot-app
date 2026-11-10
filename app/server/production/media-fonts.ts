import {createHash} from 'node:crypto';
import {chmodSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Bootstrap-only configuration. This module imports no image library, App,
 * database or provider. Call after production policy and before importing index.
 * Merely importing it has no effects. Nothing here is an HTTP/request setting. */
const ASSETS=Object.freeze([
 Object.freeze({name:'onest.ttf',bytes:193056,sha256:'966c5c29b4755da84b6854d5c21dd4eaa2420225d0e9874de602de176d4a9f31'}),
 Object.freeze({name:'manrope.ttf',bytes:164700,sha256:'3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6'}),
 Object.freeze({name:'onest-OFL.txt',bytes:4384,sha256:'071195d8806e226faeee60259c28ca67b458227af5195a73f5cfcab06e3003bc'}),
 Object.freeze({name:'manrope-OFL.txt',bytes:4387,sha256:'58172e0c0fac2cda8a37b348164bb55e44b0e69051e557e92b1d3f6910141f7b'}),
]);
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const xml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export class MediaFontError extends Error {
 constructor(readonly code:'MEDIA_FONT_ASSETS_UNAVAILABLE'|'MEDIA_FONT_ASSET_MISMATCH'|'MEDIA_FONT_CONFIGURATION_FAILED'|'MEDIA_FONT_CONFIGURATION_CHANGED'|'MEDIA_FONT_NOT_READY'){
  super(code);this.name='MediaFontError';
 }
}
export interface MediaFontConfiguration {
 readonly kind:'bundled-media-fonts/1';
 readonly configPath:string;
 readonly configurationSha256:string;
 readonly families:readonly ['Onest','Manrope'];
 readonly assets:typeof ASSETS;
}
let configured:MediaFontConfiguration|undefined;
let preparationFailed=false;

function fontDirectory():string {
 // esbuild CJS places the bootstrap and this module in dist-production/index.cjs.
 // Source/tsx instead resolves this actual module below server/production/.
 // Lexical resolve removes the ESM URL's trailing slash BEFORE lstat. Do not
 // realpath this directory here: that would hide the symlink we must reject.
 return typeof __dirname==='string'?path.resolve(__dirname,'public','fonts'):
  path.resolve(fileURLToPath(new URL('../../client/public/fonts/',import.meta.url)));
}
function checkAssets(directory:string,workingCopy=false):void {
 try{
  if(directory.length>4096||!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink())throw new MediaFontError('MEDIA_FONT_ASSET_MISMATCH');
  const entries=readdirSync(directory);
  if(entries.filter(name=>!(workingCopy&&name==='.uuid')).sort().join('\n')!==ASSETS.map(a=>a.name).sort().join('\n'))throw new MediaFontError('MEDIA_FONT_ASSET_MISMATCH');
  // Fontconfig may create its UUID in its writable font directory. This one
  // bounded non-font metadata file is allowed only beside private copies.
  if(workingCopy&&entries.includes('.uuid')){
   const file=path.join(directory,'.uuid'),stat=lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size<36||stat.size>37||
    path.dirname(realpathSync(file))!==realpathSync(directory)||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n?$/i.test(readFileSync(file,'utf8')))throw new MediaFontError('MEDIA_FONT_ASSET_MISMATCH');
  }
 }catch(error){if(error instanceof MediaFontError)throw error;throw new MediaFontError('MEDIA_FONT_ASSETS_UNAVAILABLE');}
 for(const asset of ASSETS){
  let bytes:Buffer;
  try{
   const file=path.join(directory,asset.name),stat=lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.bytes)throw new MediaFontError('MEDIA_FONT_ASSET_MISMATCH');
   if(path.dirname(realpathSync(file))!==realpathSync(directory))throw new MediaFontError('MEDIA_FONT_ASSET_MISMATCH');
   bytes=readFileSync(file);
  }catch(error){if(error instanceof MediaFontError)throw error;throw new MediaFontError('MEDIA_FONT_ASSETS_UNAVAILABLE');}
  if(bytes.byteLength!==asset.bytes||sha(bytes)!==asset.sha256)throw new MediaFontError('MEDIA_FONT_ASSET_MISMATCH');
 }
}

/** Owns a private temporary Fontconfig/cache directory for this process only.
 * No default/host configuration is included and no system font is installed.
 * Exact bundled fonts+OFL files are checked before any environment mutation.
 * Font use itself is proved by native raster tests, not by this DTO. */
export function requireBundledMediaFontsReady():MediaFontConfiguration {
 checkAssets(fontDirectory());
 if(!configured)throw new MediaFontError('MEDIA_FONT_NOT_READY');
 try{
  const directory=path.dirname(configured.configPath),config=lstatSync(configured.configPath),cache=lstatSync(path.join(directory,'cache')),root=lstatSync(directory),fonts=path.join(directory,'fonts'),fontRoot=lstatSync(fonts);
  if(process.env.FONTCONFIG_FILE!==configured.configPath||process.env.FONTCONFIG_PATH!==directory||process.env.PANGOCAIRO_BACKEND!=='fontconfig'||
   !config.isFile()||config.isSymbolicLink()||config.size>65536||(config.mode&0o777)!==0o600||
   !root.isDirectory()||root.isSymbolicLink()||(root.mode&0o777)!==0o700||
   !fontRoot.isDirectory()||fontRoot.isSymbolicLink()||(fontRoot.mode&0o777)!==0o700||path.dirname(realpathSync(fonts))!==realpathSync(directory)||
   !cache.isDirectory()||cache.isSymbolicLink()||(cache.mode&0o777)!==0o700||
   sha(readFileSync(configured.configPath))!==configured.configurationSha256)throw new MediaFontError('MEDIA_FONT_CONFIGURATION_CHANGED');
  checkAssets(fonts,true);
 }catch(error){if(error instanceof MediaFontError)throw error;throw new MediaFontError('MEDIA_FONT_CONFIGURATION_CHANGED');}
 return configured;
}

/** A storage/configuration failure is recoverable for application text output,
 * never for raster output. This process does not automatically retry it after
 * index/sharp may have initialized; a fresh process is the recovery boundary. */
export function prepareBundledMediaFonts():MediaFontConfiguration {
 const directory=fontDirectory();checkAssets(directory);
 if(configured)return requireBundledMediaFontsReady();
 if(preparationFailed)throw new MediaFontError('MEDIA_FONT_CONFIGURATION_FAILED');
 let privateDirectory:string|undefined;
 const previous={file:process.env.FONTCONFIG_FILE,path:process.env.FONTCONFIG_PATH,backend:process.env.PANGOCAIRO_BACKEND};
 let changedEnvironment=false;
 try{
  privateDirectory=mkdtempSync(path.join(tmpdir(),'lba-media-fonts-v1-'));chmodSync(privateDirectory,0o700);
  const cacheDirectory=path.join(privateDirectory,'cache');mkdirSync(cacheDirectory,{mode:0o700});
  const workingFonts=path.join(privateDirectory,'fonts');mkdirSync(workingFonts,{mode:0o700});
  for(const asset of ASSETS){
   const bytes=readFileSync(path.join(directory,asset.name));
   if(bytes.byteLength!==asset.bytes||sha(bytes)!==asset.sha256)throw new MediaFontError('MEDIA_FONT_ASSET_MISMATCH');
   writeFileSync(path.join(workingFonts,asset.name),bytes,{mode:0o600,flag:'wx'});
  }
  checkAssets(directory);checkAssets(workingFonts);
  const configPath=path.join(privateDirectory,'fonts.conf');
  const content=`<?xml version="1.0"?>\n<fontconfig><dir>${xml(realpathSync(workingFonts))}</dir><cachedir>${xml(cacheDirectory)}</cachedir><config><rescan><int>0</int></rescan></config><alias binding="strong"><family>sans-serif</family><prefer><family>Onest</family></prefer></alias></fontconfig>\n`;
  writeFileSync(configPath,content,{encoding:'utf8',mode:0o600,flag:'wx'});
  changedEnvironment=true;
  process.env.FONTCONFIG_FILE=configPath;process.env.FONTCONFIG_PATH=privateDirectory;process.env.PANGOCAIRO_BACKEND='fontconfig';
  const ownedDirectory=privateDirectory;
  process.once('exit',()=>{try{rmSync(ownedDirectory,{recursive:true,force:true});}catch{/* A stopped process cannot render or retry. */}});
  configured=Object.freeze({kind:'bundled-media-fonts/1',configPath,configurationSha256:sha(content),families:Object.freeze(['Onest','Manrope'] as const),assets:ASSETS});
  return configured;
 }catch(error){
  preparationFailed=true;
  if(changedEnvironment){
   for(const [key,value] of [['FONTCONFIG_FILE',previous.file],['FONTCONFIG_PATH',previous.path],['PANGOCAIRO_BACKEND',previous.backend]] as const){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
   }
  }
  if(privateDirectory)try{rmSync(privateDirectory,{recursive:true,force:true});}catch{/* Keep the original precise failure. */}
  // If immutable assets disappeared or changed during preparation, they remain
  // fatal. Only process-local temporary/config storage may degrade to text.
  checkAssets(directory);
  throw new MediaFontError('MEDIA_FONT_CONFIGURATION_FAILED');
 }
}
