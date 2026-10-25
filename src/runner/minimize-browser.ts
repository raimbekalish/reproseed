import type { Browser } from "playwright";

import type { TimingSearchConfig } from "../core/duration.ts";
import { minimize } from "../core/minimize.ts";
import type { MinimizeReport, Scenario } from "../core/types.ts";
import { optimizeVerifiedDuration, type DurationTunedResult } from "./minimize-duration.ts";
import { writeSanitizedReport } from "./report.ts";
import { startReplayRuntime } from "./replay.ts";
import type { FetchLike } from "./reset.ts";

/**
 * Runs the minimizer against isolated Chromium replays.
 * Each probe call is one replay: authorized reset, a fresh context, the
 * selected steps, settled responses, then the scenario oracle.
 * The minimizer does not read the page or the record list itself.
 */
type BrowserMinimizeInput = {
  scenario: Scenario;
  reportPath?: string;
  fetchImpl?: FetchLike;
  launchBrowser?: () => Promise<Browser>;
  now?: () => number;
  tuneDelays?: TimingSearchConfig;
};

export function minimizeWithBrowser(input: BrowserMinimizeInput & { tuneDelays?: undefined }): Promise<MinimizeReport>;
export function minimizeWithBrowser(input: BrowserMinimizeInput & { tuneDelays: TimingSearchConfig }): Promise<DurationTunedResult>;
export async function minimizeWithBrowser(input: BrowserMinimizeInput): Promise<MinimizeReport | DurationTunedResult> {
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
    if (input.tuneDelays === undefined) {
      if (input.reportPath !== undefined) {
        await writeSanitizedReport(input.reportPath, input.scenario, report);
      }
      return report;
    }
    const tuned = await optimizeVerifiedDuration({
      scenario: input.scenario,
      stage1: report,
      config: input.tuneDelays,
      probeFor: (variant) => runtime.probeFor(variant),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (input.reportPath !== undefined) {
      await writeSanitizedReport(input.reportPath, tuned.scenario, tuned.report, tuned.optimization);
    }
    return tuned;
  } finally {
    await runtime.close();
  }
}
