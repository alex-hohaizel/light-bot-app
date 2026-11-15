import { defineConfig } from 'drizzle-kit';

const expected = 'postgresql://lba_local:lba_local@127.0.0.1:55432/lba_synthetic?sslmode=disable';
if (process.env.DATABASE_URL !== expected || process.env.LBA_ISOLATED !== '1' ||
    process.env.LBA_DATA_MODE !== 'synthetic' || process.env.LBA_DB_DISPOSABLE !== '1') {
  throw new Error('Only the fixed local synthetic database is allowed.');
}
export default defineConfig({
  schema: './shared/isolated-schema.ts', dialect: 'postgresql',
  dbCredentials: { url: expected },
});
