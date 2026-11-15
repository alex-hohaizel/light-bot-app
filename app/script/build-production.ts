import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file imports build tools only. No server/application, DB, seed or bot module is evaluated.
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(appRoot, 'dist-production');
const hash = async (name: string) => createHash('sha256').update(await readFile(name)).digest('hex');
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}
async function sourceSnapshot() {
  const source = [...await files(path.join(appRoot, 'server')), ...await files(path.join(appRoot, 'shared')),
    ...await files(path.join(appRoot, 'client')), ...['script/build-production.ts', 'package-lock.json', 'package.json', 'tsconfig.json', '.replit'].map(name => path.join(appRoot, name))].sort();
  return Promise.all(source.map(async name => ({ path: path.relative(appRoot, name), sha256: await hash(name) })));
}
const sourceBefore = await sourceSnapshot();
const sourceSha256 = createHash('sha256').update(JSON.stringify(sourceBefore)).digest('hex');
if (process.env.LBA_ISOLATED === '1' || process.env.LBA_DATA_MODE === 'synthetic' || process.env.LBA_DB_DISPOSABLE === '1')
  throw new Error('LBA_PRODUCTION_BUILD_SYNTHETIC_ENV_REJECTED: use a separate clean build process');
process.env.NODE_ENV = 'production';

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await viteBuild({
  configFile: false, mode: 'production', root: path.join(appRoot, 'client'),
  envDir: false, envPrefix: [],
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    '@': path.join(appRoot, 'client/src'), '@shared': path.join(appRoot, 'shared'), '@assets': path.join(appRoot, 'attached_assets'),
  } },
  css: { postcss: { plugins: [] } },
  build: { outDir: path.join(output, 'public'), emptyOutDir: true, manifest: true, sourcemap: false },
});
const server = await esbuild({
  absWorkingDir: appRoot, entryPoints: ['server/production-entry.ts'], platform: 'node', target: 'node20',
  bundle: true, packages: 'external', format: 'cjs', outfile: path.join(output, 'index.cjs'),
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), '__LBA_BUILD_SHA256__': JSON.stringify(sourceSha256) },
  minify: false, sourcemap: false, metafile: true, logLevel: 'info',
  plugins: [{ name: 'exclude-production-dev-server', setup(context) {
    context.onResolve({ filter: /^\.\/vite$/ }, args => args.importer.endsWith('/server/index.ts')
      ? { path: 'disabled-production-vite-server', namespace: 'lba-production-build' } : undefined);
    context.onLoad({ filter: /^disabled-production-vite-server$/, namespace: 'lba-production-build' }, () => ({
      contents: 'export async function setupVite() { throw new Error("LBA_PRODUCTION_DEV_SERVER_DISABLED"); }', loader: 'js',
    }));
  } }],
});
await writeFile(path.join(output, 'server-metafile.json'), JSON.stringify(server.metafile, null, 2) + '\n');

const assets = await Promise.all((await files(output)).map(async name => ({ path: path.relative(output, name), sha256: await hash(name) })));
const toolVersions = Object.fromEntries(await Promise.all(['vite', 'esbuild', '@vitejs/plugin-react', '@tailwindcss/vite'].map(async name =>
  [name, JSON.parse(await readFile(path.join(appRoot, 'node_modules', name, 'package.json'), 'utf8')).version])));
const sourceAfter = await sourceSnapshot();
if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter))
  throw new Error('LBA_PRODUCTION_BUILD_SOURCE_CHANGED: freeze the source and rebuild this candidate');
await writeFile(path.join(output, 'build-receipt.json'), JSON.stringify({
  kind: 'lba-production-build/1', builtAt: new Date().toISOString(), target: 'node20', buildNode: process.version, toolVersions,
  output: 'dist-production', server: 'index.cjs', client: 'public',
  applicationExecuted: false, databaseConnected: false, seedExecuted: false, deployed: false,
  isolatedDefine: false, configFile: false, envFilesLoaded: false,
  sourceSha256, sourceBefore, sourceAfter, sourceUnchanged: true, assets,
}, null, 2) + '\n');
console.log('LBA production candidate built in dist-production; no application runtime was started.');
