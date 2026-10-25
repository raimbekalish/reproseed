import { defineConfig } from "@playwright/test";

/** Runs the delay-tuned duplicate-submit spec. Retries stay off. */
export default defineConfig({
  testDir: "../../artifacts",
  testMatch: "tuned-duplicate.spec.ts",
  respectGitIgnore: false,
  outputDir: "../../artifacts/playwright-output-tuned-duplicate",
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  reporter: "line",
  use: { headless: true, channel: "chromium", trace: "off", video: "off", screenshot: "off" },
});
