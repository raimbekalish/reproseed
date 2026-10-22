import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { MinimizeReport, Scenario, Step } from "../core/types.ts";
import { embedJson } from "./embed.ts";
import { selectVerifiedExport } from "./eligibility.ts";
import { ExportError } from "./export-error.ts";
import { renderPlaywrightSpec } from "./spec-template.ts";

type ExportStep =
  | { id: string; kind: "goto"; path: string }
  | { id: string; kind: "fill"; selector: string; value: string }
  | { id: string; kind: "click"; selector: string }
  | { id: string; kind: "wait"; ms: number }
  | { id: string; kind: "delay"; urlIncludes: string; method: "POST"; ms: number };

type ExportData = {
  oracle: { path: string; email: string; expect: number };
  steps: ExportStep[];
};

/**
 * Builds a standalone Playwright spec from the original scenario and a verified report.
 * The sanitized report only has step ids and kinds. Selectors, values, and delays come from `scenario`.
 * The spec asserts `oracle.expect`. It does not assert the observed failure count.
 */
export function exportPlaywrightTest(scenario: Scenario, report: MinimizeReport): string {
  const selected = selectVerifiedExport(scenario, report);
  const source = renderPlaywrightSpec({
    runtimeSource: readRuntimeSource(),
    dataExpression: embedJson(exportData(scenario, selected.steps)),
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
    oracle: {
      path: scenario.oracle.request.path,
      email: scenario.oracle.match.value,
      expect: scenario.oracle.expect,
    },
    steps: steps.map(exportStep),
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
      if (step.method !== "POST") {
        throw new ExportError(`unsupported delay method for ${step.id}`);
      }
      return { id: step.id, kind: "delay", urlIncludes: step.urlIncludes, method: "POST", ms: step.ms };
    default: {
      const unsupported = step as { id?: string; kind?: string };
      throw new ExportError(`unsupported step ${unsupported.kind ?? unsupported.id ?? "unknown"}`);
    }
  }
}

/**
 * The generated spec embeds this TypeScript source.
 * The build copies `runtime-config.ts` next to the compiled exporter so the
 * CLI does not need the original `src/` tree at runtime.
 */
function readRuntimeSource(): string {
  const url = new URL("./runtime-config.ts", import.meta.url);
  let source: string;
  try {
    source = readFileSync(url, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    throw new ExportError(
      code === "ENOENT" ? "embedded runtime config is missing from the package" : "embedded runtime config could not be read",
    );
  }
  if (/(^|\n)\s*import\s|require\s*\(/.test(source)) {
    throw new ExportError("embedded runtime config must stay free of imports");
  }
  return source;
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
