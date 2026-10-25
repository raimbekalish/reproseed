import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { cleanStateVerify } from "../core/clean-state.ts";
import type { JsonArrayEmptyVerify, MinimizeReport, Scenario, Step } from "../core/types.ts";
import { embedJson } from "./embed.ts";
import { selectVerifiedExport } from "./eligibility.ts";
import { ExportError } from "./export-error.ts";
import { DOM_TEXT_ASSERTION, DOM_TEXT_HELPERS, RECORD_COUNT_ASSERTION, renderPlaywrightSpec } from "./spec-template.ts";

type ExportStep =
  | { id: string; kind: "goto"; path: string }
  | { id: string; kind: "fill"; selector: string; value: string }
  | { id: string; kind: "click"; selector: string }
  | { id: string; kind: "wait"; ms: number }
  | { id: string; kind: "delay"; urlIncludes: string; method: "GET" | "POST"; ms: number };

type ExportOracle =
  | { id: "record-count"; path: string; email: string; expect: number }
  | { id: "dom-text"; selector: string; expect: string };

type ExportData = {
  oracle: ExportOracle;
  verify: JsonArrayEmptyVerify;
  steps: ExportStep[];
};

/**
 * Builds a standalone Playwright spec from the original scenario and a verified report.
 * The sanitized report only has step ids and kinds. Selectors, values, and delays come from `scenario`.
 * The spec asserts the oracle's intended result. It does not assert the observed failure.
 */
export function exportPlaywrightTest(scenario: Scenario, report: MinimizeReport): string {
  const selected = selectVerifiedExport(scenario, report);
  const dom = scenario.oracle.id === "dom-text";
  const source = renderPlaywrightSpec({
    runtimeSource: readEmbeddedSource("runtime-config.ts", [new URL("./runtime-config.ts", import.meta.url)]),
    delayMatchSource: readEmbeddedSource("delay-match.ts", [
      new URL("./delay-match.ts", import.meta.url),
      new URL("../runner/delay-match.ts", import.meta.url),
    ]),
    domTextSource: readEmbeddedSource("dom-text.ts", [
      new URL("./dom-text.ts", import.meta.url),
      new URL("../runner/dom-text.ts", import.meta.url),
    ]),
    dataExpression: embedJson(exportData(scenario, selected.steps)),
    assertionSource: dom ? DOM_TEXT_ASSERTION : RECORD_COUNT_ASSERTION,
    helperSource: dom ? DOM_TEXT_HELPERS : "",
    expectCount: String(selected.expectCount),
    timeoutMs: String(selected.timeoutMs),
  });
  assertSpecDoesNotLeak(scenario, source);
  return source;
}

export async function writePlaywrightTest(path: string, scenario: Scenario, report: MinimizeReport): Promise<void> {
  const source = exportPlaywrightTest(scenario, report);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
}

export { ExportError } from "./export-error.ts";

function exportData(scenario: Scenario, steps: readonly Step[]): ExportData {
  return {
    oracle: exportOracle(scenario),
    verify: cleanStateVerify(scenario.reset),
    steps: steps.map(exportStep),
  };
}

function exportOracle(scenario: Scenario): ExportOracle {
  const oracle = scenario.oracle;
  if (oracle.id === "dom-text") {
    return { id: "dom-text", selector: oracle.selector, expect: oracle.expect };
  }
  return {
    id: "record-count",
    path: oracle.request.path,
    email: oracle.match.value,
    expect: oracle.expect,
  };
}

function exportStep(step: Step): ExportStep {
  switch (step.kind) {
    case "goto":
      return { id: step.id, kind: "goto", path: step.path };
    case "fill":
      return { id: step.id, kind: "fill", selector: step.selector, value: step.value };
    case "click":
      return { id: step.id, kind: "click", selector: step.selector };
    case "wait":
      return { id: step.id, kind: "wait", ms: step.ms };
    case "delay":
      if (step.method !== "GET" && step.method !== "POST") {
        throw new ExportError(`unsupported delay method for ${step.id}`);
      }
      return { id: step.id, kind: "delay", urlIncludes: step.urlIncludes, method: step.method, ms: step.ms };
    default: {
      const unsupported = step as { id?: string; kind?: string };
      throw new ExportError(`unsupported step ${unsupported.kind ?? unsupported.id ?? "unknown"}`);
    }
  }
}

/**
 * The generated spec embeds these TypeScript sources.
 * The build copies them next to the compiled exporter so the CLI does not need
 * the original `src/` tree at runtime. Source checkouts still read `src/runner`.
 */
function readEmbeddedSource(filename: string, candidates: readonly URL[]): string {
  let missing = true;
  for (const url of candidates) {
    try {
      const source = readFileSync(url, "utf8");
      if (/(^|\n)\s*import\s|require\s*\(/.test(source)) {
        throw new ExportError(`embedded ${filename} must stay free of imports`);
      }
      return source;
    } catch (error) {
      if (error instanceof ExportError) {
        throw error;
      }
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") {
        throw new ExportError(`embedded ${filename} could not be read`);
      }
      missing = true;
    }
  }
  if (missing) {
    throw new ExportError(`embedded ${filename} is missing from the package`);
  }
  throw new ExportError(`embedded ${filename} could not be read`);
}

function assertSpecDoesNotLeak(scenario: Scenario, source: string): void {
  const secret = scenario.target.resetAuthorization;
  if (secret.length >= 8 && source.includes(secret)) {
    throw new ExportError("refusing to write a spec that contains the reset authorization");
  }
  if (source.includes(scenario.target.origin)) {
    throw new ExportError("refusing to embed the scenario origin");
  }
}
