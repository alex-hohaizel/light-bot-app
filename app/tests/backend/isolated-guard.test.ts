import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { assertIsolatedConfig, assertSocketTarget, assertLocalRequestHeaders,
  installIsolatedEgressGuard } from "../../server/isolated-guard.ts";
import { registerIsolatedFixtureRoutes } from "../../server/isolated-routes.ts";

const valid = {
  LBA_ISOLATED: "1", LBA_DATA_MODE: "synthetic", LBA_DB_DISPOSABLE: "1",
  DATABASE_URL: "postgresql://lba_local@127.0.0.1:55432/lba_synthetic?sslmode=disable",
  PORT: "5417", NODE_ENV: "test",
};

test("configuration requires explicit synthetic/disposable flags before application import", () => {
  assert.equal(assertIsolatedConfig(valid).databasePort, 55432);
  for (const key of ["LBA_ISOLATED", "LBA_DATA_MODE", "LBA_DB_DISPOSABLE", "DATABASE_URL"]) {
    assert.throws(() => assertIsolatedConfig({ ...valid, [key]: undefined }), /LBA_/);
  }
});

test("remote, production-named, alternative local DB and TLS URL configuration are rejected", () => {
  for (const url of [
    "postgresql://lba_local@db.example.invalid:55432/lba_synthetic",
    "postgresql://lba_local@localhost:55432/lba_synthetic",
    "postgresql://lba_local@127.0.0.1:55432/production",
    "postgresql://postgres@127.0.0.1:55432/lba_synthetic",
    "postgresql://lba_local:non-local-value@127.0.0.1:55432/lba_synthetic",
    "postgresql://lba_local@127.0.0.1:55432/lba_synthetic?sslmode=require",
    "postgresql://lba_local@127.0.0.1:55432/lba_synthetic?host=db.example.invalid",
  ]) assert.throws(() => assertIsolatedConfig({ ...valid, DATABASE_URL: url }), /LBA_DATABASE_REJECTED/);
});

test("live secrets, alternate pg settings, loader injection and broad bind are rejected", () => {
  for (const key of ["TELEGRAM_BOT_TOKEN", "REPL_ID", "OPENAI_API_KEY", "PGHOST", "PGPASSWORD",
    "NODE_OPTIONS", "NODE_PATH", "SESSION_SECRET", "JWT_SECRET", "HTTPS_PROXY"]) {
    assert.throws(() => assertIsolatedConfig({ ...valid, [key]: "synthetic-negative-fixture" }), /LBA_LIVE_CREDENTIAL_REJECTED/);
  }
  assert.throws(() => assertIsolatedConfig({ ...valid, HOST: "0.0.0.0" }), /LBA_BIND_REJECTED/);
  assert.throws(() => assertIsolatedConfig({ ...valid, NODE_ENV: "production" }), /LBA_BIND_REJECTED/);
});

test("socket policy allows the one DB endpoint and rejects fd/path/remote endpoint escapes", () => {
  assert.doesNotThrow(() => assertSocketTarget([55432, "127.0.0.1"], 55432));
  assert.doesNotThrow(() => assertSocketTarget([{ host: "127.0.0.1", port: 55432 }], 55432));
  assert.doesNotThrow(() => assertSocketTarget([[{ host: "127.0.0.1", port: 55432 }]], 55432));
  for (const args of [[443, "example.invalid"], [80, "127.0.0.1"], [55432, "localhost"],
    [{ path: "/private/tmp/socket" }], [{ host: "127.0.0.1", port: 55432, fd: 7 }],
    [{ host: "127.0.0.1", port: 55432, handle: {} }]]) {
    assert.throws(() => assertSocketTarget(args, 55432), /LBA_EGRESS_BLOCKED/);
  }
});

test("local synthetic auth rejects cross-site origin, production Host and DNS rebinding", () => {
  assert.doesNotThrow(() => assertLocalRequestHeaders({ host: "127.0.0.1:5417" }, 5417));
  assert.doesNotThrow(() => assertLocalRequestHeaders({ host: "localhost:5417", origin: "http://localhost:5417" }, 5417));
  for (const headers of [{ host: "power-ukraine.net" },
    { host: "evil.example.invalid:5417" }, { host: "127.0.0.1:5417", origin: "https://power-ukraine.net" },
    { host: "127.0.0.1:5417", origin: "https://example.replit.app" },
    { host: "127.0.0.1:5417", "sec-fetch-site": "cross-site" }]) {
    assert.throws(() => assertLocalRequestHeaders(headers, 5417), /LBA_LOCAL_ORIGIN_REQUIRED/);
  }
});

test("installed process guard rejects actual high-level API calls before network/process dispatch", async () => {
  const restore = installIsolatedEgressGuard(assertIsolatedConfig(valid));
  try {
    await assert.rejects(fetch("https://example.invalid/"), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => http.get("http://example.invalid/"), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => https.request("https://example.invalid/"), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => net.connect(443, "203.0.113.1"), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => tls.connect({ host: "example.invalid", port: 443 }), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => dns.lookup("example.invalid", () => {}), /LBA_EGRESS_BLOCKED/);
    await assert.rejects(dns.promises.resolve4("example.invalid"), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => new dns.Resolver().resolve4("example.invalid", () => {}), /LBA_EGRESS_BLOCKED/);
    await assert.rejects(new dns.promises.Resolver().resolve4("example.invalid"), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => dgram.createSocket("udp4"), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => childProcess.spawn("curl", ["https://example.invalid/"]), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => new workerThreads.Worker("inert", { eval: true }), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => net.createServer().listen({ host: "0.0.0.0", port: 5417 }), /LBA_EGRESS_BLOCKED/);
    assert.throws(() => net.createServer().listen({ host: "127.0.0.1", port: 5417, fd: 7 } as any), /LBA_EGRESS_BLOCKED/);
  } finally {
    restore();
  }
});

test("disabled provider middleware matches Express route casing and keeps linked-account reads", () => {
  const previous = process.env;
  process.env = { ...valid };
  const restore = installIsolatedEgressGuard(assertIsolatedConfig(valid));
  try {
    let middleware: any;
    registerIsolatedFixtureRoutes({ use: (_path: string, callback: any) => { middleware = callback; }, get: () => {}, post: () => {} } as any);
    for (const path of ["/USER/digest/generate", "/AUTH/link-telegram", "/Notify/Telegram/test", "/telegram-webhook"]) {
      let status: number | undefined;
      let continued = false;
      const response = { status: (value: number) => { status = value; return response; }, json: () => {} };
      middleware({ path }, response, () => { continued = true; });
      assert.equal(status, 403, path);
      assert.equal(continued, false, path);
    }
    let continued = false;
    middleware({ path: "/auth/linked-accounts" }, { status: () => { throw new Error("must remain readable"); } }, () => { continued = true; });
    assert.equal(continued, true);
  } finally {
    restore();
    process.env = previous;
  }
});
