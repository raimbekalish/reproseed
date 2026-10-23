import { defineConfig } from "@playwright/test";

/**
 * Runs the generated stale-search spec. Retries stay off so a flake cannot pass.
 */
export default defineConfig({
  testDir: "../../artifacts",
  testMatch: "stale-search.spec.ts",
  respectGitIgnore: false,
  outputDir: "../../artifacts/playwright-output-stale",
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "line",
  use: {
    headless: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
