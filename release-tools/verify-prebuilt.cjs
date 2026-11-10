'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),EXPECTED_SOURCE='52998b21428048da5dc78c998f0db2a8c254023b85d5af4095b05e53375da1ee',EXPECTED_MANIFEST='b6d8fa4a6100b39b662ec44c222fbbf241cbaf5e407161e742f4f5be96ab6ab7';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function verify(){
 const bytes=fs.readFileSync(path.join(__dirname,'artifacts.json'));if(sha(bytes)!==EXPECTED_MANIFEST)throw Error('RELEASE_MANIFEST_DRIFT');
 const m=JSON.parse(bytes);if(m.sourceSha256!==EXPECTED_SOURCE||m.sourceInputs!==314||m.buildArtifacts!==17||m.target!=='node20'||m.files.length!==332)throw Error('RELEASE_MANIFEST_INVALID');
 if(Number(process.versions.node.split('.')[0])<20)throw Error('RELEASE_NODE20_REQUIRED');
 for(const e of m.files){if(typeof e.path!=='string'||!e.path.startsWith('app/')||e.path.split('/').some(p=>!p||p==='.'||p==='..')||!(/^[a-f0-9]{64}$/).test(e.sha256))throw Error('RELEASE_PATH_INVALID');
  let file=ROOT;for(const part of e.path.split('/')){file=path.join(file,part);if(fs.lstatSync(file).isSymbolicLink())throw Error('RELEASE_SYMLINK_REJECTED');}
  if(!fs.statSync(file).isFile()||sha(fs.readFileSync(file))!==e.sha256)throw Error('RELEASE_FILE_DRIFT');
 }
 return {sourceSha256:m.sourceSha256,sourceInputs:m.sourceInputs,buildArtifacts:m.buildArtifacts,target:m.target};
}
module.exports={verify};if(require.main===module){try{console.log(JSON.stringify(verify()));}catch(e){console.error(e.message);process.exitCode=1;}}
