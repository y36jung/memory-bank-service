import { defineConfig } from 'vitest/config';

// Separate config for the integration suite (real Postgres/Redis/Qdrant —
// no mocks, per PLAN.md §M1 Deliverables). Kept apart from vitest.config.ts
// (unit suite) so `npm test` (unit, fast, hermetic) is unaffected; run this
// suite explicitly with:
//   npx vitest run --config vitest.integration.config.ts
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    globalSetup: ['tests/integration/globalSetup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Ownership-scoping tests share the mb_test_slice1 database and rely on
    // per-test-file seed isolation (unique users/rows per file), but the DB
    // connection pool and schema are shared — run test files serially to
    // avoid cross-file interference on shared tables.
    fileParallelism: false,
  },
});
