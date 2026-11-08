import type { Express } from "express";
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertIsolatedRuntimeReady, isolationObservations, SYNTHETIC_USER_ID } from "./isolated-guard.ts";
import { SYNTHETIC_CITIES, SYNTHETIC_DATE, SYNTHETIC_HOUSE, SYNTHETIC_STREET, SYNTHETIC_UPDATED_AT, syntheticSchedule } from "./isolated-fixtures.ts";
import { registerProductReviewRoutes } from './domain/review-routes.ts';
import { registerCapturedDataRoutes } from './domain/captured-data-routes.ts';

// Only provider/data-boundary responses are fixtures. The normal user, settings,
// locations and report routes continue through the existing pg/Drizzle storage.
export function registerIsolatedFixtureRoutes(app: Express): void {
  assertIsolatedRuntimeReady();
  const artifact = path.resolve(process.cwd(), 'dist/legacy-local.cjs');
  const servingArtifactSha256 = existsSync(artifact) ? createHash('sha256').update(readFileSync(artifact)).digest('hex') : null;
  app.use("/api", (req, res, next) => {
    // Express routes are case-insensitive by default; policy matching must agree.
    const path = req.path.toLowerCase();
    if (path.startsWith("/telegram-webhook") || path.startsWith("/notify/telegram") ||
        path.startsWith("/admin/") || path.startsWith("/auth/telegram") ||
        path.startsWith("/auth/link-") || path === "/auth/unlink" ||
        path === "/auth/mobile-token" || path === "/auth/refresh-token" ||
        path === "/user/digest/generate") {
      return res.status(403).json({ error: "LBA_LOCAL_PROVIDER_DISABLED", synthetic: true,
        message: "У локальній копії зовнішні входи, Telegram і розсилки вимкнено." });
    }
    next();
  });
  app.get("/api/local/status", (_req, res) => {
    res.json({ isolated: true, dataMode: "synthetic", userId: SYNTHETIC_USER_ID,
      serviceDate: SYNTHETIC_DATE, sourceRevision: "45d77e22e68816e5695aa4b7d2a62bfc57e8176d", servingArtifactSha256,
      networkPolicy: "process API guard: only configured loopback PostgreSQL; not an OS sandbox",
      telegram: "disabled", oidc: "disabled", legacySeed: "disabled", notificationScheduler: "disabled",
      fixtureCoverage: SYNTHETIC_CITIES, liveCoverageVerified: false, observations: isolationObservations });
  });
  app.get("/api/queues", (_req, res) => {
    res.json({ queues: [{ id: "1.1", name: "1.1 · синтетичний приклад" }],
      lastUpdated: SYNTHETIC_UPDATED_AT, updateTime: "Синтетичні дані · не графік ОСР", synthetic: true });
  });
  app.get(["/api/schedule", "/api/schedule/:queueId"], (req, res) => {
    const queue = String(req.params.queueId || req.query.queue || "");
    const city = String(req.query.city || "Вінниця");
    if (queue !== "1.1" || !SYNTHETIC_CITIES.includes(city)) {
      return res.status(404).json({ error: "Synthetic fixture not defined", synthetic: true, status: "unavailable" });
    }
    res.json(syntheticSchedule(city, queue));
  });
  app.get("/api/geocode/streets", (req, res) => {
    const query = String(req.query.q || "").toLocaleLowerCase("uk-UA");
    res.json(query.length >= 2 && (SYNTHETIC_STREET.toLocaleLowerCase("uk-UA").includes(query) ||
      query.includes("тест")) ? [SYNTHETIC_STREET] : []);
  });
  app.get("/api/geocode/houses", (req, res) => {
    const street = String(req.query.street || "");
    const query = String(req.query.q || "");
    res.json(street === SYNTHETIC_STREET ? ["12", SYNTHETIC_HOUSE, "12/1"].filter(house => house.startsWith(query)) : []);
  });
  app.get("/api/address-queue", (req, res) => {
    const matches = req.query.street === SYNTHETIC_STREET && req.query.house === SYNTHETIC_HOUSE;
    res.json({ queueId: matches ? "1.1" : null, source: "synthetic_fixture", alternatives: [],
      synthetic: true, addressVerified: false });
  });
  app.get("/api/street-queue", (req, res) => {
    const matches = req.query.street === SYNTHETIC_STREET;
    res.json({ matches: matches ? [{ street: SYNTHETIC_STREET, queues: ["1.1"] }] : [],
      queues: matches ? ["1.1"] : [], exact: false, singleQueue: null, synthetic: true });
  });
  registerProductReviewRoutes(app);
  registerCapturedDataRoutes(app);
}
