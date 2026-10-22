import { defineConfig } from "@playwright/test";

/**
 * Runs the generated spec in artifacts/. That directory is gitignored, and an explicit
 * testDir keeps Playwright from skipping it. Retries stay off so a flake cannot pass.
 */
export default defineConfig({
  testDir: "../../artifacts",
  testMatch: "minimized.spec.ts",
  respectGitIgnore: false,
  outputDir: "../../artifacts/playwright-output",
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
