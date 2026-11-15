// Only built-ins may be imported here: the legacy graph is loaded AFTER this guard.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dns from "node:dns";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";

export interface IsolatedConfig {
  databaseUrl: string;
  databasePort: number;
  appPort: number;
  host: "127.0.0.1";
}

const INSTALLED = Symbol.for("lba.isolated.guard.installed");
export const SYNTHETIC_USER_ID = "lba-synthetic-user";
export const LOCAL_SESSION_SECRET = "lba-local-synthetic-only-session-secret";
export const LOCAL_JWT_SECRET = "lba-local-synthetic-only-jwt-secret";

export function isIsolatedMode(): boolean {
  return process.env.LBA_ISOLATED === "1";
}

export function assertIsolatedConfig(env: NodeJS.ProcessEnv = process.env): IsolatedConfig {
  if (env.LBA_ISOLATED !== "1" || env.LBA_DATA_MODE !== "synthetic" || env.LBA_DB_DISPOSABLE !== "1") {
    throw new Error("LBA_ISOLATION_REQUIRED: explicit isolated, synthetic, disposable configuration is required");
  }
  const forbidden = ["TELEGRAM_BOT_TOKEN", "BOT_TOKEN", "REPL_ID", "REPLIT_DB_URL", "REPLIT_DOMAINS",
    "ISSUER_URL", "DATABASE_PUBLIC_URL", "PRODUCTION_DATABASE_URL", "PGHOST", "PGPORT", "PGDATABASE",
    "PGUSER", "PGPASSWORD", "PGSERVICE", "PGSERVICEFILE", "PGSSLMODE", "PGSSLROOTCERT",
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
  const allowedSyntheticSecrets = new Set(["SESSION_SECRET", "JWT_SECRET"]);
  if (forbidden.some(name => Boolean(env[name])) || Object.entries(env).some(([name, value]) =>
    value && /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTHORIZATION/i.test(name) && !allowedSyntheticSecrets.has(name))) {
    throw new Error("LBA_LIVE_CREDENTIAL_REJECTED: remove inherited provider or alternate database configuration");
  }
  if ((env.SESSION_SECRET && env.SESSION_SECRET !== LOCAL_SESSION_SECRET) ||
      (env.JWT_SECRET && env.JWT_SECRET !== LOCAL_JWT_SECRET)) {
    throw new Error("LBA_LIVE_CREDENTIAL_REJECTED: only the documented synthetic auth values are allowed");
  }
  let url: URL;
  try { url = new URL(env.DATABASE_URL || ""); } catch {
    throw new Error("LBA_DATABASE_REJECTED: explicit loopback synthetic database URL is required");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" ||
      url.username !== "lba_local" || url.pathname !== "/lba_synthetic" ||
      !url.port || !/^\d+$/.test(url.port) || Number(url.port) < 1024 || Number(url.port) > 65535 ||
      (url.password !== "" && url.password !== "lba_local") || url.hash ||
      Array.from(url.searchParams.entries()).some(([key, value]) => key !== "sslmode" || value !== "disable")) {
    throw new Error("LBA_DATABASE_REJECTED: expected dedicated lba_local/lba_synthetic on explicit IPv4 loopback port with TLS disabled");
  }
  const appPort = Number(env.PORT || "5417");
  if (!Number.isInteger(appPort) || appPort < 1024 || appPort > 65535 || appPort === Number(url.port) ||
      (env.HOST && env.HOST !== "127.0.0.1") || env.NODE_ENV === "production") {
    throw new Error("LBA_BIND_REJECTED: isolated runtime uses test mode and a separate loopback application port");
  }
  return { databaseUrl: url.href, databasePort: Number(url.port), appPort, host: "127.0.0.1" };
}

function socketTarget(args: any[]): { host: unknown; port: unknown; path: unknown; adoptedHandle?: boolean } {
  let first = args[0];
  // Node's own createConnection/listen forwards its normalized argument array.
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    return { host: first.host, port: first.port, path: first.path,
      adoptedHandle: first.fd !== undefined || first.handle !== undefined };
  }
  return { host: args[1], port: first, path: typeof first === "string" && !/^\d+$/.test(first) ? first : undefined };
}

export function assertSocketTarget(args: any[], port: number): void {
  const target = socketTarget(args);
  if (target.path || target.adoptedHandle || target.host !== "127.0.0.1" || Number(target.port) !== port) {
    throw new Error("LBA_EGRESS_BLOCKED: only the configured synthetic PostgreSQL loopback socket is allowed");
  }
}

export function assertIsolatedRuntimeReady(): void {
  assertIsolatedConfig();
  if (!(globalThis as any)[INSTALLED]) {
    throw new Error("LBA_GUARD_NOT_INSTALLED: use server/isolated-entry.ts before importing the application");
  }
}

export function assertLocalRequestHeaders(headers: { host?: string; origin?: string; "sec-fetch-site"?: string }, port: number): void {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(headers.host || "") ||
      (headers.origin && !hosts.map(host => `http://${host}`).includes(headers.origin)) ||
      headers["sec-fetch-site"] === "cross-site") {
    throw new Error("LBA_LOCAL_ORIGIN_REQUIRED");
  }
}

const OBSERVATIONS = Symbol.for("lba.isolated.guard.observations");
export const isolationObservations: { blocked: number; databaseConnects: number } =
  (globalThis as any)[OBSERVATIONS] ||= { blocked: 0, databaseConnects: 0 };

export function installIsolatedEgressGuard(config: IsolatedConfig): () => void {
  if ((globalThis as any)[INSTALLED]) throw new Error("LBA_GUARD_ALREADY_INSTALLED");
  const restores: (() => void)[] = [];
  const patch = (object: any, key: string, replacement: any) => {
    const original = object[key];
    object[key] = replacement;
    restores.push(() => { object[key] = original; });
  };
  const denied = () => {
    isolationObservations.blocked++;
    throw new Error("LBA_EGRESS_BLOCKED: outbound networking, child processes and workers are disabled in this local runtime");
  };
  const originalConnect = net.Socket.prototype.connect;
  patch(net.Socket.prototype, "connect", function (this: net.Socket, ...args: any[]) {
    try { assertSocketTarget(args, config.databasePort); } catch (error) {
      isolationObservations.blocked++;
      throw error;
    }
    isolationObservations.databaseConnects++;
    return (originalConnect as any).apply(this, args);
  });
  const originalListen = net.Server.prototype.listen;
  patch(net.Server.prototype, "listen", function (this: net.Server, ...args: any[]) {
    const target = socketTarget(args);
    if (target.path || target.adoptedHandle || target.host !== config.host || Number(target.port) !== config.appPort) {
      return denied();
    }
    return (originalListen as any).apply(this, args);
  });
  patch(globalThis, "fetch", async () => denied());
  for (const module of [http, https]) {
    patch(module, "request", denied);
    patch(module, "get", denied);
  }
  patch(http2, "connect", denied);
  patch(tls, "connect", denied);
  patch(dgram, "createSocket", denied);
  const originalLookup = dns.lookup;
  patch(dns, "lookup", function (hostname: string, ...args: any[]) {
    // Node Server.listen(host) calls lookup even for a numeric address. Node's
    // literal-IP branch returns that address without a resolver request.
    if (hostname === "127.0.0.1") return (originalLookup as any)(hostname, ...args);
    return denied();
  });
  patch(dns.promises, "lookup", async (hostname: string) => {
    if (hostname === "127.0.0.1") return { address: "127.0.0.1", family: 4 };
    return denied();
  });
  for (const name of ["lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname",
    "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
    if (typeof (dns as any)[name] === "function") patch(dns, name, denied);
    if (typeof (dns.promises as any)[name] === "function") patch(dns.promises, name, async () => denied());
  }
  for (const [Resolver, asynchronous] of [[dns.Resolver, false], [dns.promises.Resolver, true]] as const) {
    for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
      if (/^(resolve|reverse)/.test(name) && typeof (Resolver.prototype as any)[name] === "function") {
        patch(Resolver.prototype, name, asynchronous ? async () => denied() : denied);
      }
    }
  }
  for (const name of ["exec", "execFile", "spawn", "fork", "execSync", "execFileSync", "spawnSync"]) {
    patch(childProcess, name, denied);
  }
  patch(workerThreads, "Worker", function () { return denied(); });
  (globalThis as any)[INSTALLED] = true;
  syncBuiltinESMExports();
  return () => {
    for (const restore of restores.reverse()) restore();
    delete (globalThis as any)[INSTALLED];
    syncBuiltinESMExports();
  };
}
