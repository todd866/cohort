import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests run against a real Postgres + pgvector instance.
 * Triggered in CI via `npm run test:integration` after the postgres service
 * is up. They exercise the actual SQL paths — the only way to catch bugs
 * like the 2026-04-28 `vector::bytea` silent-write outage that mocked unit
 * tests slept through.
 *
 * INTEGRATION_DATABASE_URL points at the test DB. If unset the suite no-ops
 * (so plain `npm run test:run` doesn't try to spin them up).
 */
export default defineConfig({
  test: {
    globals: true,
    pool: 'threads',
    fileParallelism: false,
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
