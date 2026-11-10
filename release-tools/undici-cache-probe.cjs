'use strict';
// Operational filesystem probe only; never execute App or dependency modules.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const app = path.resolve(__dirname, '../app');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const requiredFiles = [
  ['lib/cache/memory-cache-store.js', 6745, '17d3d95c374165993148f783d47631e94c490be715bf8fa337bac33b561b846e'],
  ['lib/cache/sqlite-cache-store.js', 11419, 'e6feda1217288fe3b0184dc297e6cd173d4b982d648afa13db2944a5b56b71cd'],
  ['lib/web/cache/cache.js', 21152, '60015d174411d4094837ce8f1d44a4ad0b4946c26a49d28e5d95f6d840ac4f82'],
  ['lib/web/cache/cachestorage.js', 3666, 'f9cccd19fbc185edac7624e542b0864412d71c2083177f3c6902b34d2b07d461'],
  ['lib/web/cache/util.js', 1020, '638d5c2424a730e6d2400ac518765b3fc9b50e2b3816b65fb7b46f93c66a5930']
];
function check(ok, code) { if (!ok) throw new Error(code); }
function regular(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink(), 'UNDCACHE_FILE_NOT_REGULAR');
  fs.accessSync(file, fs.constants.R_OK);
}
function physicalPath(file) {
  const relative = path.relative(app, file);
  check(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'UNDCACHE_PATH_OUTSIDE_CANDIDATE');
  let current = app;
  check(fs.lstatSync(current).isDirectory() && !fs.lstatSync(current).isSymbolicLink(), 'UNDCACHE_APP_NOT_PHYSICAL');
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    check(!fs.lstatSync(current).isSymbolicLink(), 'UNDCACHE_SYMLINK_REJECTED');
  }
}
try {
  check(process.argv.length === 2, 'UNDCACHE_ARGUMENTS_INVALID');
  check(process.versions.node.split('.')[0] === '20', 'UNDCACHE_NODE20_REQUIRED');
  const lockBytes = fs.readFileSync(path.join(app, 'package-lock.json'));
  check(sha(lockBytes) === '784c82ca5529b0223ae3037eeb2f36a48791235bac92d125ece53973ed8c8906', 'UNDCACHE_LOCK_DRIFT');
  const lock = JSON.parse(lockBytes);
  check(lock.packages['node_modules/cheerio'].version === '1.2.0' &&
    lock.packages['node_modules/undici'].version === '7.28.0', 'UNDCACHE_LOCK_IDENTITY');
  const bundle = path.join(app, 'dist-production/index.cjs');
  check(sha(fs.readFileSync(bundle)) === '13a2efc3418e4bd8055c497a79dbf68117e3e552bcd8f03f88e4da0e702a614e', 'UNDCACHE_BUNDLE_DRIFT');
  const cheerioEntry = createRequire(bundle).resolve('cheerio');
  const cheerioRoot = path.join(app, 'node_modules/cheerio');
  physicalPath(cheerioEntry);
  check(fs.realpathSync(cheerioEntry).startsWith(fs.realpathSync(cheerioRoot) + path.sep), 'UNDCACHE_CHEERIO_FALLBACK');
  const undiciEntry = createRequire(cheerioEntry).resolve('undici');
  const undiciRoot = path.join(app, 'node_modules/undici');
  physicalPath(undiciEntry);
  check(undiciEntry === path.join(undiciRoot, 'index.js'), 'UNDCACHE_UNDICI_FALLBACK');
  const installed = JSON.parse(fs.readFileSync(path.join(undiciRoot, 'package.json')));
  check(installed.name === 'undici' && installed.version === '7.28.0', 'UNDCACHE_INSTALLED_IDENTITY');
  const fromUndici = createRequire(undiciEntry);
  for (const relative of ['lib/cache/memory-cache-store', 'lib/cache/sqlite-cache-store', 'lib/web/cache/cachestorage']) {
    check(fromUndici.resolve('./' + relative) ===
      path.join(undiciRoot, relative + '.js'), 'UNDCACHE_RELATIVE_RESOLUTION');
  }
  const files = requiredFiles.map(([relative, expectedBytes, expectedSha256]) => {
    const file = path.join(undiciRoot, relative);
    physicalPath(file);
    regular(file);
    const bytes = fs.readFileSync(file);
    const actualSha256 = sha(bytes);
    check(bytes.length === expectedBytes && actualSha256 === expectedSha256, 'UNDCACHE_REQUIRED_FILE_DRIFT');
    return { file: 'undici/' + relative, bytes: bytes.length, sha256: actualSha256 };
  });
  console.log(JSON.stringify({ kind: 'lba-undici-cache-filesystem-probe/2', success: true,
    parentPackage: 'cheerio', package: 'undici', version: '7.28.0', files,
    applicationImported: false, dependencyModulesImported: false }));
} catch (error) {
  const code = typeof error.message === 'string' && /^UNDCACHE_[A-Z_]+$/.test(error.message)
    ? error.message : 'UNDCACHE_FILESYSTEM_OR_RESOLUTION_FAILED';
  console.error(JSON.stringify({ kind: 'lba-undici-cache-filesystem-probe/2', success: false, code }));
  process.exitCode = 1;
}
