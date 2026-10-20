import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/fixtures/**"],
    testTimeout: 20_000,
  },
});
