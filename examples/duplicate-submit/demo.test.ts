import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { type Browser, type Page } from "playwright";

import { launchChromium } from "../../src/runner/session.ts";

import { fetchRecords, resetAndConfirmEmpty } from "./harness.ts";
import { installResponseDelay, type ResponseDelay } from "./response-delay.ts";
import { startDemoServer, type DemoServer } from "./server.ts";

const REPETITIONS = 10;
const RESPONSE_DELAY_MS = 2_000;
const SUBMIT_GAP_MS = 800;
const RAPID_GAP_MS = 100;

describe("duplicate-submit demo", { concurrency: false }, () => {
  it("scenario A: an 800ms gap during a 2000ms response delay creates two records", { timeout: 180_000 }, async () => {
    await withDemo(async ({ browser, demo, appId, resetAuthorization }) => {
      for (let iteration = 1; iteration <= REPETITIONS; iteration += 1) {
        const email = `delay-${iteration}@example.com`;
        const page = await openAttempt(browser, demo, appId, resetAuthorization, email);
        const delay = await installResponseDelay(page, RESPONSE_DELAY_MS);
        try {
          const started = Date.now();
          await page.locator("#submit").click();
          await page.waitForTimeout(SUBMIT_GAP_MS);
          assert.equal(await page.locator("#submit").isEnabled(), true, `iteration ${iteration} disabled submit`);
          assert.equal(await textOf(page, "#status"), "", `iteration ${iteration} revealed the response early`);
          await page.locator("#submit").click();
          await waitUntil(() => delay.postCount() === 2, 5_000, `iteration ${iteration} to send two posts`);
          const records = await fetchRecords(demo.origin);
          assert.equal(records.length, 2, `iteration ${iteration} record count`);
          assert.deepEqual(
            records.map((record) => record.email),
            [email, email],
            `iteration ${iteration} emails`,
          );
          assert.ok(
            records.every((record) => record.createdAt >= started && record.createdAt < started + 1_800),
            `iteration ${iteration} processed a POST only after the response delay: ${records.map((record) => record.createdAt - started).join(",")}`,
          );
        } finally {
          await closeAttempt(page, delay);
        }
      }
    });
  });

  it("scenario B: the same 800ms gap without response latency creates one record", { timeout: 180_000 }, async () => {
    await withDemo(async ({ browser, demo, appId, resetAuthorization }) => {
      for (let iteration = 1; iteration <= REPETITIONS; iteration += 1) {
        const email = `fast-${iteration}@example.com`;
        const page = await openAttempt(browser, demo, appId, resetAuthorization, email, "visible note");
        const posts = trackPosts(page);
        try {
          await page.locator("#preview").click();
          assert.equal(await textOf(page, "#preview-output"), "visible note", `iteration ${iteration} preview`);
          assert.equal((await fetchRecords(demo.origin)).length, 0, `iteration ${iteration} preview wrote a record`);
          await page.locator("#submit").click();
          await page.waitForTimeout(SUBMIT_GAP_MS);
          assert.equal(await textOf(page, "#status"), "Saved", `iteration ${iteration} did not finish the fast request`);
          assert.equal(await page.locator("#submit").isEnabled(), true, `iteration ${iteration} disabled submit`);
          await page.locator("#submit").click();
          await page.waitForTimeout(250);
          assert.equal(posts.count(), 1, `iteration ${iteration} post count`);
          const records = await fetchRecords(demo.origin);
          assert.equal(records.length, 1, `iteration ${iteration} record count`);
          assert.equal(records[0]?.email, email);
          assert.equal(records[0]?.note, "visible note");
        } finally {
          await closeAttempt(page);
        }
      }
    });
  });

  it("scenario C: two submits 100ms apart create one record even while the response is delayed", { timeout: 180_000 }, async () => {
    await withDemo(async ({ browser, demo, appId, resetAuthorization }) => {
      for (let iteration = 1; iteration <= REPETITIONS; iteration += 1) {
        const email = `rapid-${iteration}@example.com`;
        const page = await openAttempt(browser, demo, appId, resetAuthorization, email);
        const delay = await installResponseDelay(page, RESPONSE_DELAY_MS);
        try {
          await page.evaluate((gapMs: number) => {
            const root = globalThis as unknown as {
              document: { querySelector: (selector: string) => { click: () => void } | null };
            };
            const button = root.document.querySelector("#submit");
            if (button === null) {
              throw new Error("missing submit button");
            }
            button.click();
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                button.click();
                resolve();
              }, gapMs);
            });
          }, RAPID_GAP_MS);
          await waitUntil(() => delay.postCount() >= 1, 5_000, `iteration ${iteration} to send the first post`);
          await page.waitForTimeout(200);
          assert.equal(delay.postCount(), 1, `iteration ${iteration} post count`);
          assert.equal(await textOf(page, "#status"), "", `iteration ${iteration} locked because the response arrived`);
          assert.equal(await page.locator("#submit").isEnabled(), true, `iteration ${iteration} disabled submit`);
          const records = await fetchRecords(demo.origin);
          assert.equal(records.length, 1, `iteration ${iteration} record count`);
          assert.equal(records[0]?.email, email);
          assert.equal(records[0]?.note, "");
        } finally {
          await closeAttempt(page, delay);
        }
      }
    });
  });
});

async function withDemo(
  fn: (input: { browser: Browser; demo: DemoServer; appId: string; resetAuthorization: string }) => Promise<void>,
): Promise<void> {
  const resetAuthorization = randomBytes(16).toString("hex");
  const appId = "duplicate-submit";
  const demo = await startDemoServer({ port: 0, appId, resetAuthorization });
  let browser: Browser | undefined;
  try {
    browser = await launchChromium();
    await fn({ browser, demo, appId, resetAuthorization });
  } finally {
    await browser?.close();
    await demo.close();
  }
}

async function openAttempt(
  browser: Browser,
  demo: DemoServer,
  appId: string,
  resetAuthorization: string,
  email: string,
  note = "",
): Promise<Page> {
  await resetAndConfirmEmpty({ origin: demo.origin, expectedAppId: appId, resetAuthorization });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(demo.origin);
    await page.locator("#email").fill(email);
    if (note !== "") {
      await page.locator("#note").fill(note);
    }
    assert.equal(await page.locator("#note").getAttribute("required"), null);
    assert.equal(await page.locator("#preview").count(), 1);
    return page;
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function closeAttempt(page: Page, delay?: ResponseDelay): Promise<void> {
  try {
    if (delay !== undefined) {
      await delay.dispose();
    }
  } finally {
    await page.context().close();
  }
}

function trackPosts(page: Page): { count: () => number } {
  let count = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/records")) {
      count += 1;
    }
  });
  return { count: () => count };
}

async function textOf(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).textContent()) ?? "";
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
