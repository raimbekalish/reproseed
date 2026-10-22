import type { Browser } from "playwright";

import { minimize } from "../core/minimize.ts";
import type { MinimizeReport, Scenario } from "../core/types.ts";
import { writeSanitizedReport } from "./report.ts";
import { startReplayRuntime } from "./replay.ts";
import type { FetchLike } from "./reset.ts";

/**
 * Runs the minimizer against isolated Chromium replays.
 * Each probe call is one replay: authorized reset, a fresh context, the
 * selected steps, settled responses, then the record-count oracle.
 * The minimizer does not read the record list itself.
 */
export async function minimizeWithBrowser(input: {
  scenario: Scenario;
  reportPath?: string;
  fetchImpl?: FetchLike;
  launchBrowser?: () => Promise<Browser>;
  now?: () => number;
}): Promise<MinimizeReport> {
  const runtime = startReplayRuntime({
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.launchBrowser !== undefined ? { launchBrowser: input.launchBrowser } : {}),
  });
  try {
    const report = await minimize({
      scenario: input.scenario,
      probe: runtime.probeFor(input.scenario),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (input.reportPath !== undefined) {
      await writeSanitizedReport(input.reportPath, input.scenario, report);
    }
    return report;
  } finally {
    await runtime.close();
  }
}
