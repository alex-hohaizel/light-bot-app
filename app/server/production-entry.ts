import {productionRuntimePolicy} from './runtime-policy';
import {prepareBundledMediaFonts,MediaFontError} from './production/media-fonts';
import {safeStartupDiagnostic} from './production/startup-diagnostic';

// This boundary runs before importing any DB, auth, legacy bot, routes or server.
// Invalid configuration cannot create a pool, generate fallback JWT credentials,
// run a migration or touch the configured Telegram identity.
productionRuntimePolicy();
try{prepareBundledMediaFonts();}catch(error){
  // The renderer independently requires ready bundled fonts. Temporary storage
  // failure keeps the existing full-text path available, never host-font PNGs.
  if(!(error instanceof MediaFontError)||error.code!=='MEDIA_FONT_CONFIGURATION_FAILED')throw error;
  console.warn('LBA_MEDIA_FONTS_UNAVAILABLE_TEXT_ONLY');
}
void import('./index').catch((error:unknown) => {
  try{console.error('LBA_PRODUCTION_START_FAILED',JSON.stringify({runtime:{node:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules},failure:safeStartupDiagnostic(error)}));}catch{}
  process.exitCode = 1;
});
