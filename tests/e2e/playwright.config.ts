import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure" },
  outputDir: "../.tmp/e2e-results",
});
