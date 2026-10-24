import { defineConfig } from "@playwright/test";

/** Runs the delay-tuned stale-search spec. Retries stay off. */
export default defineConfig({
  testDir: "../../artifacts",
  testMatch: "tuned-stale.spec.ts",
  respectGitIgnore: false,
  outputDir: "../../artifacts/playwright-output-tuned-stale",
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  reporter: "line",
  use: { headless: true, trace: "off", video: "off", screenshot: "off" },
});
