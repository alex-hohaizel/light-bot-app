import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir } from "node:fs/promises";

// Vite resolves its configuration when build() is called. Force the local
// frontend sanitation branch before that resolution and suppress Replit tools.
process.env.LBA_ISOLATED = "1";
delete process.env.REPL_ID;
delete process.env.REPLIT_DOMAINS;

// Build does not import or run any server entry. Runtime validation happens
// before the separate legacy bundle is imported, preserving the guard boundary.
await viteBuild();
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["server/index.ts"], platform: "node", target: "node24", bundle: true,
  packages: "external", format: "cjs", outfile: "dist/legacy-local.cjs", logLevel: "info",
  plugins: [{ name: "exclude-local-runtime-dev-server", setup(context) {
    context.onResolve({ filter: /^\.\/vite$/ }, args => {
      if (args.importer.endsWith("/server/index.ts")) return { path: "disabled-vite-server", namespace: "lba-isolated" };
      return undefined;
    });
    context.onLoad({ filter: /^disabled-vite-server$/, namespace: "lba-isolated" }, () => ({
      contents: 'export async function setupVite() { throw new Error("LBA_DEV_SERVER_DISABLED: use the isolated static build"); }',
      loader: "js",
    }));
  } }] });
await build({ entryPoints: ["server/isolated-entry.ts"], platform: "node", target: "node24", bundle: true,
  packages: "external", format: "cjs", outfile: "dist/isolated.cjs", logLevel: "info",
  plugins: [{ name: "preserve-isolated-import-boundary", setup(context) {
    context.onResolve({ filter: /^\.\/index$/ }, args => {
      if (args.importer.endsWith("/server/isolated-entry.ts")) return { path: "./legacy-local.cjs", external: true };
      return undefined;
    });
  } }] });
