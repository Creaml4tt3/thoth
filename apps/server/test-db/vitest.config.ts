import { defineConfig } from "vitest/config";

/**
 * Tests that need a real PostgreSQL. Run with `pnpm test:server`. They are kept out of `apps/server/test/`
 * so the root `pnpm test` (and `pnpm check`) never needs Podman.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["**/*.test.ts"],
    globalSetup: ["./global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One container, one database per test file: files may run in parallel.
    fileParallelism: true,
  },
});
