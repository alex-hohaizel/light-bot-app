import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {copyFileSync, lstatSync, mkdirSync, readFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {createRequire, isBuiltin} from 'node:module';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const releaseFiles = [
  'artifacts.json',
  'launch.cjs',
  'production-environment.cjs',
  'runtime-preflight.cjs',
  'undici-cache-probe.cjs',
  'verify-prebuilt.cjs',
];
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

function prepare(candidate, scratch) {
  candidate = path.resolve(candidate);
  scratch = path.resolve(scratch);
  const release = path.join(candidate, 'release-tools');
  assert(lstatSync(release).isDirectory() && !lstatSync(release).isSymbolicLink());
  for (const name of releaseFiles) {
    const stat = lstatSync(path.join(release, name));
    assert(stat.isFile() && !stat.isSymbolicLink());
  }
  const {verify} = createRequire(import.meta.url)(path.join(release, 'verify-prebuilt.cjs'));
  verify();
  const files = json(path.join(release, 'artifacts.json')).files.map(file => file.path);
  for (const relative of [...files, ...releaseFiles.map(name => 'release-tools/' + name)]) {
    const destination = path.join(scratch, relative);
    mkdirSync(path.dirname(destination), {recursive: true});
    copyFileSync(path.join(candidate, relative), destination);
  }
  // The copy is the installation target. Reject any discrepancy before npm.
  const staged = createRequire(import.meta.url)(path.join(scratch, 'release-tools/verify-prebuilt.cjs'));
  console.log(JSON.stringify({kind: 'lba-linux-prebuilt-staged/1', ...staged.verify()}));
}

function assertLinux() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v20.20.0');
  assert.equal(process.versions.modules, '115');
}

async function nativeProbe(scratch) {
  const bundle = path.join(scratch, 'app/dist-production/index.cjs');
  const fromBundle = createRequire(bundle);
  const meta = json(path.join(scratch, 'app/dist-production/server-metafile.json'));
  const dependencies = new Map();
  for (const item of Object.values(meta.outputs).flatMap(output => output.imports)) {
    if (!item.external || isBuiltin(item.path)) continue;
    dependencies.set(item.kind + ':' + item.path, item);
  }
  for (const {kind, path: specifier} of dependencies.values()) {
    try {
      if (kind === 'require-call') fromBundle(specifier);
      else if (kind === 'dynamic-import') await import(specifier);
      else assert.fail('Unsupported external import kind');
    } catch (error) {
      console.error(JSON.stringify({kind: 'lba-native-module-failed/1', specifier, mode: kind, code: error.code ?? error.name}));
      throw error;
    }
  }

  const cheerio = fromBundle('cheerio');
  const fromCheerio = createRequire(fromBundle.resolve('cheerio'));
  assert.equal(typeof fromCheerio('undici').fetch, 'function');
  assert.equal(cheerio.load('<p>Світло</p>')('p').text(), 'Світло');
  const sharp = fromBundle('sharp');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect x="2" y="2" width="24" height="12" fill="#197a62"/></svg>';
  const image = await sharp(Buffer.from(svg)).png().toBuffer();
  assert(image.subarray(0, 8).equals(pngSignature));
  const raster = await sharp(image).metadata();
  assert.equal(raster.width, 32);
  assert.equal(raster.height, 16);
  const {createCanvas} = await import('canvas');
  const canvas = createCanvas(4, 4);
  const context = canvas.getContext('2d');
  context.fillRect(0, 0, 4, 4);
  assert(canvas.toBuffer('image/png').subarray(0, 8).equals(pngSignature));
  console.log(JSON.stringify({
    kind: 'lba-linux-native-preflight/1', node: process.version, platform: process.platform, arch: process.arch,
    abi: process.versions.modules, glibc: process.report.getReport().header.glibcVersionRuntime,
    importedExternalCount: dependencies.size, cheerioUndici: 'loaded', sharpLibvips: sharp.versions.vips,
    sharpPng: true, canvasPng: true,
  }));
}

async function startProbe(scratch) {
  const launch = path.join(scratch, 'release-tools/launch.cjs');
  const release = json(path.join(scratch, 'release-tools/artifacts.json')).sourceSha256;
  const key = readFileSync(path.join(scratch, 'oidc.key'));
  const certPath = path.join(scratch, 'oidc.pem');
  const cert = readFileSync(certPath);
  let oidcRequests = 0;
  let issuer;
  const server = createServer({key, cert}, (request, response) => {
    if (request.method !== 'GET' || request.url !== '/.well-known/openid-configuration') {
      response.writeHead(404).end();
      return;
    }
    oidcRequests++;
    response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({
      issuer,
      authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/jwks',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  issuer = 'https://127.0.0.1:' + server.address().port;
  const port = '55494';
  const secret = () => randomBytes(32).toString('hex');
  const disabled = [
    'LBA_AUTH_REPLAY_GUARD', 'LBA_SOURCE_INGESTION', 'LBA_ODESA_PLAN_API', 'LBA_OPERATOR_ADDRESS_LOOKUP',
    'LBA_TELEGRAM_UPDATES', 'LBA_TELEGRAM_DELIVERY', 'LBA_NOTIFICATION_SCHEDULER', 'LBA_ACCOUNT_LINKS',
    'LBA_RECONCILE_SUBSCRIBERS_ON_START', 'LBA_MIGRATE_SUBSCRIBERS_ON_START', 'LBA_INITIALIZE_SUBSCRIBER_HASHES_ON_START',
  ];
  const child = spawn(process.execPath, [launch], {
    cwd: scratch,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'production', LBA_CANONICAL_CONTROL_EPOCH: '1', LBA_PRODUCT_PROFILE_MODE: 'disabled',
      ...Object.fromEntries(disabled.map(name => [name, 'disabled'])),
      PORT: port, ISSUER_URL: issuer, NODE_EXTRA_CA_CERTS: certPath, REPL_ID: 'lba-ci-preflight',
      DATABASE_URL: 'postgresql://lba_ci@127.0.0.1:55493/lba_preflight',
      SESSION_SECRET: secret(), JWT_SECRET: secret(),
    },
  });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({code, signal}));
    child.once('error', error => resolve({code: error.code}));
  });
  try {
    const base = 'http://127.0.0.1:' + port;
    const get = route => fetch(base + route, {signal: AbortSignal.timeout(1500), redirect: 'error'});
    const until = Date.now() + 16_000;
    let health;
    while (!health && Date.now() < until && child.exitCode === null && child.signalCode === null) {
      const response = await get('/api/health/release').catch(() => null);
      if (response?.ok) health = await response.json();
      else await delay(150);
    }
    assert(health, 'Exact candidate did not serve release health');
    assert.equal(health.releaseId, release);
    assert.equal(health.mode, 'production');
    assert.equal(health.profileMode, 'disabled');
    assert.equal(health.status, 'process_serving');
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /<script[^>]*src=/);
    assert.equal(oidcRequests, 1);
    console.log(JSON.stringify({
      kind: 'lba-linux-production-entry-smoke/1', release, healthStatus: health.status,
      profileMode: health.profileMode, root: page.status, oidcDiscovery: 'loopback-fixture', dbTarget: 'disposable-loopback',
    }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!await Promise.race([exited, delay(3500).then(() => false)])) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'prepare' && args.length === 2) {
  prepare(...args);
} else if (args.length === 1 && ['native', 'startup'].includes(mode)) {
  assertLinux();
  if (mode === 'native') await nativeProbe(args[0]);
  else await startProbe(args[0]);
} else {
  assert.fail('Invalid Linux preflight arguments');
}
