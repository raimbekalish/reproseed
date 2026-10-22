import { defineConfig } from "@playwright/test";

/**
 * Bare `npx playwright test` does not collect node:test files or artifacts/minimized.spec.ts.
 * The RED/GREEN run uses test/export/playwright.config.ts via `npm run test:export`.
 */
export default defineConfig({
  testDir: "./test/export",
  testMatch: "uncollected/*.spec.ts",
  retries: 0,
  workers: 1,
  fullyParallel: false,
});
