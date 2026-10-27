import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  globalSetup: "./global-setup.ts",
  timeout: 120_000,
  // Files run side by side, the tests of a file one after another (they share a bridge, a host and often a server).
  // Each file has its own temp folders, ports, Postgres container and web-client build, so files never share state.
  // 3 workers measured 2.4x faster than 1 on a 10-core Mac (641 s to ~265 s), with every test passing; more
  // workers mostly add CPU contention. `pnpm e2e --workers=1` runs them one at a time.
  fullyParallel: false,
  workers: 3,
  reporter: [["list"]],
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure" },
  outputDir: "../.tmp/e2e-results",
});
