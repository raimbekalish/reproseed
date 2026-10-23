import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { chromium, type Page } from "playwright";

import { installMatchedResponseDelay } from "../../src/runner/faults.ts";
import { startSearchServer, type SearchPage, type SearchServer } from "./server.ts";

const APP_ID = "stale-search";
const DELAY_MS = 800;

describe("stale-search demo", { concurrency: false }, () => {
  it("serves the buggy page by default and the generation guard only when asked", async () => {
    const token = randomBytes(16).toString("hex");
    const buggy = await startSearchServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const fixed = await startSearchServer({
      port: 0,
      appId: APP_ID,
      resetAuthorization: token,
      page: "fixed-generation",
    });
    try {
      const buggyHtml = await (await fetch(buggy.origin)).text();
      const fixedHtml = await (await fetch(fixed.origin)).text();
      assert.equal(buggyHtml.includes("innerHTML"), false);
      assert.equal(fixedHtml.includes("innerHTML"), false);
      assert.equal(buggyHtml.includes("let generation"), false);
      assert.match(fixedHtml, /let generation = 0/);
      assert.match(fixedHtml, /requestGeneration !== generation/);
      assert.match(buggyHtml, /results\.textContent = text/);
      assert.match(buggyHtml, /\(outdated\)/);
      assert.match(fixedHtml, /results\.textContent = text/);
    } finally {
      await buggy.close();
      await fixed.close();
    }
  });

  it("lets a delayed alpha response overwrite beta", { timeout: 120_000 }, async () => {
    await withBrowser("buggy", async ({ page, demo, token }) => {
      for (let iteration = 1; iteration <= 5; iteration += 1) {
        await resetAndOpen(page, demo, token);
        const seen = await searchWithOptionalDelay(page, demo.origin, true);
        assert.equal(seen.sawBeta, true, `iteration ${iteration} never showed beta`);
        assert.equal(seen.finalText, "Results for alpha (outdated)", `iteration ${iteration} final text`);
        assert.equal(seen.delayed, 1, `iteration ${iteration} delayed responses`);
        assert.ok(seen.acceptedAt - seen.started < 400, `iteration ${iteration} server was delayed`);
        assert.ok(seen.alphaAt - seen.acceptedAt >= DELAY_MS - 150, `iteration ${iteration} response was not held`);
        assert.deepEqual(demo.searches(), ["alpha", "beta"]);
      }
    });
  });

  it("keeps beta when the alpha response is not delayed", { timeout: 120_000 }, async () => {
    await withBrowser("buggy", async ({ page, demo, token }) => {
      for (let iteration = 1; iteration <= 5; iteration += 1) {
        await resetAndOpen(page, demo, token);
        await page.locator("#query").fill("alpha");
        await page.locator("#search").click();
        await page.waitForFunction("document.querySelector('#results')?.textContent === 'Results for alpha'");
        await page.locator("#query").fill("beta");
        await page.locator("#search").click();
        await page.waitForFunction("document.querySelector('#results')?.textContent === 'Results for beta'");
        await page.waitForTimeout(500);
        assert.equal(await page.locator("#results").textContent(), "Results for beta", `iteration ${iteration}`);
        assert.deepEqual(demo.searches(), ["alpha", "beta"]);
      }
    });
  });

  it("ignores the stale alpha response on the fixed page", { timeout: 120_000 }, async () => {
    await withBrowser("fixed-generation", async ({ page, demo, token }) => {
      for (let iteration = 1; iteration <= 5; iteration += 1) {
        await resetAndOpen(page, demo, token);
        const seen = await searchWithOptionalDelay(page, demo.origin, true);
        assert.equal(seen.delayed, 1, `iteration ${iteration} did not deliver alpha`);
        assert.equal(seen.finalText, "Results for beta", `iteration ${iteration}`);
        assert.equal(seen.sawAlpha, false, `iteration ${iteration} showed stale alpha`);
        assert.deepEqual(demo.searches(), ["alpha", "beta"]);
      }
    });
  });
});

async function withBrowser(
  pageKind: SearchPage,
  run: (input: { page: Page; demo: SearchServer; token: string }) => Promise<void>,
): Promise<void> {
  const token = randomBytes(16).toString("hex");
  const demo = await startSearchServer({ port: 0, appId: APP_ID, resetAuthorization: token, page: pageKind });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await run({ page, demo, token });
  } finally {
    await browser?.close();
    await demo.close();
  }
}

async function resetAndOpen(page: Page, demo: SearchServer, token: string): Promise<void> {
  const response = await fetch(new URL("/__reproseed/reset", demo.origin), {
    method: "POST",
    headers: {
      "x-reproseed-app-id": APP_ID,
      "x-reproseed-reset-authorization": token,
    },
  });
  assert.equal(response.status, 204);
  await page.goto(demo.origin, { waitUntil: "domcontentloaded" });
}

async function searchWithOptionalDelay(
  page: Page,
  origin: string,
  delayAlpha: boolean,
): Promise<{ delayed: number; started: number; acceptedAt: number; sawBeta: boolean; sawAlpha: boolean; finalText: string; alphaAt: number }> {
  let delayed = 0;
  let acceptedAt = 0;
  const delay = delayAlpha
    ? await installMatchedResponseDelay(page.context(), {
        origin,
        urlIncludes: "/api/search?q=alpha",
        method: "GET",
        ms: DELAY_MS,
        onDelayed: () => {
          delayed += 1;
          acceptedAt = Date.now();
        },
      })
    : undefined;
  const started = Date.now();
  try {
    await page.locator("#note").fill("unrelated");
    await page.locator("#preview").click();
    assert.equal(await page.locator("#preview-output").textContent(), "unrelated");
    await page.locator("#query").fill("alpha");
    await page.locator("#search").click();
    await page.locator("#query").fill("beta");
    await page.locator("#search").click();
    const watched = await watchResults(page, DELAY_MS + 2_000);
    return { delayed, started, acceptedAt, ...watched };
  } finally {
    if (delay !== undefined) {
      await delay.dispose();
    }
  }
}

async function watchResults(
  page: Page,
  timeoutMs: number,
): Promise<{ sawBeta: boolean; sawAlpha: boolean; finalText: string; alphaAt: number }> {
  const deadline = Date.now() + timeoutMs;
  let sawBeta = false;
  let sawAlpha = false;
  let alphaAt = 0;
  while (Date.now() < deadline) {
    const text = await page.locator("#results").textContent();
    if (text === "Results for beta") {
      sawBeta = true;
    }
    if (text === "Results for alpha (outdated)") {
      sawAlpha = true;
      if (alphaAt === 0) {
        alphaAt = Date.now();
      }
    }
    if (sawBeta && text === "Results for alpha (outdated)") {
      return { sawBeta, sawAlpha, finalText: text, alphaAt };
    }
    if (sawBeta && Date.now() > deadline - 400 && text === "Results for beta") {
      break;
    }
    await page.waitForTimeout(15);
  }
  await page.waitForTimeout(DELAY_MS + 200);
  const finalText = (await page.locator("#results").textContent()) ?? "";
  if (finalText === "Results for alpha (outdated)" && alphaAt === 0) {
    alphaAt = Date.now();
    sawAlpha = true;
  }
  return { sawBeta, sawAlpha, finalText, alphaAt };
}
