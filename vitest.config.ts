import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/fixtures/**", "tests/e2e/**"],
    testTimeout: 20_000,
  },
});
