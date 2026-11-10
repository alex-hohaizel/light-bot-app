'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),EXPECTED_SOURCE='fc244e317caf8a738927efa6bc99391ac2599c1ff3b0b3cb9150ded20f7ad982',EXPECTED_MANIFEST='26f9e6d4f0c3edb32efa04943fe8f564131b142623c0f9a3c979d399e7bfe70d';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function verify(){
 const bytes=fs.readFileSync(path.join(__dirname,'artifacts.json'));if(sha(bytes)!==EXPECTED_MANIFEST)throw Error('RELEASE_MANIFEST_DRIFT');
 const m=JSON.parse(bytes);if(m.sourceSha256!==EXPECTED_SOURCE||m.sourceInputs!==315||m.buildArtifacts!==17||m.target!=='node20'||m.files.length!==333)throw Error('RELEASE_MANIFEST_INVALID');
 if(Number(process.versions.node.split('.')[0])<20)throw Error('RELEASE_NODE20_REQUIRED');
 for(const e of m.files){if(typeof e.path!=='string'||!e.path.startsWith('app/')||e.path.split('/').some(p=>!p||p==='.'||p==='..')||!(/^[a-f0-9]{64}$/).test(e.sha256))throw Error('RELEASE_PATH_INVALID');
  let file=ROOT;for(const part of e.path.split('/')){file=path.join(file,part);if(fs.lstatSync(file).isSymbolicLink())throw Error('RELEASE_SYMLINK_REJECTED');}
  if(!fs.statSync(file).isFile()||sha(fs.readFileSync(file))!==e.sha256)throw Error('RELEASE_FILE_DRIFT');
 }
 return {sourceSha256:m.sourceSha256,sourceInputs:m.sourceInputs,buildArtifacts:m.buildArtifacts,target:m.target};
}
module.exports={verify};if(require.main===module){try{console.log(JSON.stringify(verify()));}catch(e){console.error(e.message);process.exitCode=1;}}
