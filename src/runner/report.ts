import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { cleanStateVerify } from "../core/clean-state.ts";
import type { Budget, MinimizeReport, Oracle, Scenario, Step } from "../core/types.ts";

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /^(resetauthorization|authorization|password|cookie|set-cookie|x-reproseed-reset-authorization)$/i;

export type SanitizedMinimizeArtifact = {
  scenario: {
    id: string;
    target: { origin: string; appId: string };
    reset: Scenario["reset"];
    steps: Array<{ id: string; kind: Step["kind"] }>;
    oracle: Oracle;
    budget: Budget;
  };
  report: MinimizeReport;
};

/**
 * Copies the public scenario fields and the minimizer report.
 * `resetAuthorization` is omitted, and any copy of that credential is replaced.
 */
export function sanitizeArtifact(scenario: Scenario, report: MinimizeReport): SanitizedMinimizeArtifact {
  const artifact: SanitizedMinimizeArtifact = {
    scenario: {
      id: scenario.id,
      target: {
        origin: scenario.target.origin,
        appId: scenario.target.appId,
      },
      reset: {
        method: scenario.reset.method,
        path: scenario.reset.path,
        verify: cleanStateVerify(scenario.reset),
      },
      steps: scenario.steps.map((step) => ({ id: step.id, kind: step.kind })),
      oracle: copyOracle(scenario.oracle),
      budget: { ...scenario.budget },
    },
    report: JSON.parse(JSON.stringify(report)) as MinimizeReport,
  };
  return redactValue(artifact, usableSecrets([scenario.target.resetAuthorization])) as SanitizedMinimizeArtifact;
}

export async function writeSanitizedReport(path: string, scenario: Scenario, report: MinimizeReport): Promise<void> {
  const artifact = sanitizeArtifact(scenario, report);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function copyOracle(oracle: Oracle): Oracle {
  if (oracle.id === "record-count") {
    return {
      id: "record-count",
      request: { method: oracle.request.method, path: oracle.request.path },
      match: { field: oracle.match.field, value: oracle.match.value },
      expect: oracle.expect,
    };
  }
  return {
    id: "dom-text",
    selector: oracle.selector,
    expect: oracle.expect,
  };
}

function usableSecrets(secrets: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 8) {
      unique.add(trimmed);
    }
  }
  return [...unique].sort((left, right) => right.length - left.length);
}

function redactString(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) {
    if (text.includes(secret)) {
      text = text.split(secret).join(REDACTED);
    }
  }
  return text;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        continue;
      }
      output[redactString(key, secrets)] = redactValue(item, secrets);
    }
    return output;
  }
  return value;
}
