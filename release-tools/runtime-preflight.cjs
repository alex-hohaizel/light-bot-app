'use strict';
// Filesystem/module-resolution checks only. Never load application/dependency code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire, isBuiltin } = require('node:module');
const app = path.resolve(__dirname, '../app');
const entry = path.join(app, 'dist-production/index.cjs');
const metaPath = path.join(app, 'dist-production/server-metafile.json');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function check(ok, code) { if (!ok) throw new Error(code); }
try {
  check(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--inventory'), 'PREFLIGHT_ARGUMENTS_INVALID');
  check(process.versions.node.split('.')[0] === '20', 'PREFLIGHT_NODE20_REQUIRED');
  check(sha(fs.readFileSync(entry)) === 'eebdbeab47aa8f3a90c86674d5afd75f3257a9e9168e5817a6ab9fdf59665d15', 'PREFLIGHT_ENTRY_DRIFT');
  const bytes = fs.readFileSync(metaPath);
  check(sha(bytes) === '2a0a6a23e67286c329f08d730fccb710eef6eadc60a506cb2ff378c9c94486ef', 'PREFLIGHT_METAFILE_DRIFT');
  const meta = JSON.parse(bytes);
  const outputs = Object.values(meta.outputs);
  check(outputs.length === 1, 'PREFLIGHT_OUTPUT_SHAPE');
  const external = [...new Set(outputs.flatMap(o => o.imports.filter(i => i.external).map(i => i.path)))].sort();
  check(external.length > 0, 'PREFLIGHT_EXTERNALS_EMPTY');
  const dependencies = external.filter(s => !isBuiltin(s));
  check(dependencies.every(s => /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-zA-Z0-9._/-]+)?$/.test(s) && !s.startsWith('.') && !s.includes('..')), 'PREFLIGHT_EXTERNAL_SPECIFIER');
  if (process.argv[2] === '--inventory') {
    console.log(JSON.stringify({kind:'lba-runtime-resolution-inventory/1', dependencies, resolutionExecuted:false}));
  } else {
    const modules = path.join(app, 'node_modules');
    check(fs.lstatSync(modules).isDirectory() && !fs.lstatSync(modules).isSymbolicLink(), 'PREFLIGHT_NODE_MODULES_NOT_PHYSICAL');
    const base = fs.realpathSync(modules) + path.sep;
    const fromBundle = createRequire(entry);
    const results = dependencies.map(specifier => {
      let resolved;
      try { resolved = fromBundle.resolve(specifier); }
      catch { throw new Error('PREFLIGHT_DEPENDENCY_UNRESOLVED:' + specifier); }
      const real = fs.realpathSync(resolved);
      check(real.startsWith(base), 'PREFLIGHT_ANCESTOR_FALLBACK:' + specifier);
      check(fs.statSync(real).isFile(), 'PREFLIGHT_RESOLVED_NOT_FILE:' + specifier);
      fs.accessSync(real, fs.constants.R_OK);
      return {specifier, resolvedWithinCandidate:true};
    });
    console.log(JSON.stringify({kind:'lba-runtime-resolution-preflight/1',success:true,node:process.version,dependencies:results,builtins:external.filter(isBuiltin),applicationImported:false,dependencyModulesImported:false}));
  }
} catch (error) {
  // Only our bounded codes, never raw resolver messages/require stacks.
  console.error(JSON.stringify({kind:'lba-runtime-resolution-preflight/1',success:false,code:String(error.message).startsWith('PREFLIGHT_') ? error.message : 'PREFLIGHT_FILESYSTEM_OR_METADATA_FAILURE'}));
  process.exitCode = 1;
}
