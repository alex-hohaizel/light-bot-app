'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),EXPECTED_SOURCE='ab7e3b1babeaea7b72db5dc1518b03ede8a51665792c9b7389fdafac7dee8788',EXPECTED_MANIFEST='e2c96ea8b0eeba4705e4e338e2617f6cee52c83a51c24f6b76d0b88383ffb500';
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
