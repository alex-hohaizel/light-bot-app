import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { assertIsolatedConfig, isIsolatedMode } from "./isolated-guard";

const { Pool } = pg;

if (isIsolatedMode()) assertIsolatedConfig();

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (error: Error & { code?: string }) => {
  // The pool discards a failed idle client. Handle its error event so it
  // cannot terminate the process or expose connection details in logs.
  const code = error.code && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "UNKNOWN";
  console.error("LBA_DATABASE_IDLE_CLIENT_ERROR", code);
});
export const db = drizzle(pool, { schema });
