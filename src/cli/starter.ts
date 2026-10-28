export type StarterOracle = "record-count" | "dom-text";

export const STARTER_ORIGIN = "http://127.0.0.1:3000";
export const STARTER_APP_ID = "replace-with-your-app-id";
export const STARTER_SCENARIO_ID = "replace-with-scenario-id";

const BUDGET = {
  maxReplayExecutions: 60,
  maxWallClockMs: 300000,
  attemptTimeoutMs: 20000,
  baselineRuns: 3,
  reductionConfirmRuns: 2,
  verifyRuns: 5,
} as const;

/**
 * A schema-valid scenario with loopback sample data and no reset credential.
 * The decoy step is intentionally unnecessary so minimization has something it can remove.
 */
export function starterScenario(oracle: StarterOracle): Record<string, unknown> {
  if (oracle === "dom-text") {
    return {
      id: STARTER_SCENARIO_ID,
      target: { origin: STARTER_ORIGIN, appId: STARTER_APP_ID },
      reset: {
        method: "POST",
        path: "/__reproseed/reset",
        verify: { kind: "json-array-empty", method: "GET", path: "/api/events" },
      },
      steps: [
        { id: "open", kind: "goto", path: "/", dependsOn: [] },
        { id: "decoy-note", kind: "fill", selector: "#note", value: "not required", dependsOn: ["open"] },
        { id: "query-alpha", kind: "fill", selector: "#query", value: "alpha", dependsOn: ["open"] },
        {
          id: "slow-alpha",
          kind: "delay",
          urlIncludes: "/api/search?q=alpha",
          method: "GET",
          ms: 800,
          dependsOn: [],
        },
        { id: "search-alpha", kind: "click", selector: "#search", dependsOn: ["open", "query-alpha"] },
        { id: "gap", kind: "wait", ms: 300, dependsOn: [] },
        { id: "query-beta", kind: "fill", selector: "#query", value: "beta", dependsOn: ["open"] },
        { id: "search-beta", kind: "click", selector: "#search", dependsOn: ["open", "query-beta"] },
      ],
      oracle: { id: "dom-text", selector: "#results", expect: "Results for beta" },
      budget: BUDGET,
    };
  }
  return {
    id: STARTER_SCENARIO_ID,
    target: { origin: STARTER_ORIGIN, appId: STARTER_APP_ID },
    reset: {
      method: "POST",
      path: "/__reproseed/reset",
      verify: { kind: "json-array-empty", method: "GET", path: "/api/items" },
    },
    steps: [
      { id: "open", kind: "goto", path: "/", dependsOn: [] },
      { id: "decoy-note", kind: "fill", selector: "#note", value: "not required", dependsOn: ["open"] },
      { id: "email", kind: "fill", selector: "#email", value: "a@example.com", dependsOn: ["open"] },
      { id: "slow-save", kind: "delay", urlIncludes: "/api/items", method: "POST", ms: 1000, dependsOn: [] },
      { id: "save", kind: "click", selector: "#save", dependsOn: ["open", "email"] },
      { id: "gap", kind: "wait", ms: 500, dependsOn: [] },
      { id: "save-again", kind: "click", selector: "#save", dependsOn: ["open", "email"] },
    ],
    oracle: {
      id: "record-count",
      request: { method: "GET", path: "/api/items" },
      match: { field: "email", value: "a@example.com" },
      expect: 1,
    },
    budget: BUDGET,
  };
}

export function starterNotes(oracle: StarterOracle, requestedPath: string): string {
  const verifyPath = oracle === "dom-text" ? "/api/events" : "/api/items";
  const oracleNote =
    oracle === "dom-text"
      ? "oracle.expect is the intended element text, not the buggy text."
      : "oracle.expect is the intended record count, not the buggy count. The match field must stay email.";
  return `Wrote ${requestedPath}
Oracle: ${oracle}
This file matches the scenario schema. It does not contain a reset credential, and its sample origin is ${STARTER_ORIGIN}.

Replace these before minimize:
- id (${STARTER_SCENARIO_ID})
- target.appId (${STARTER_APP_ID})
- target.origin (${STARTER_ORIGIN}). Change only the port. Do not use a production URL.
- selectors, typed values, the delay needle, and reset.verify.path (currently ${verifyPath})
- ${oracleNote}

The decoy-note step is sample data. Minimization can remove a step the failure does not need.

Set these in the environment. Do not put the reset credential in the scenario file:
- REPROSEED_ORIGIN must match target.origin
- REPROSEED_APP_ID must match target.appId and GET /__reproseed/identity
- REPROSEED_RESET_AUTHORIZATION is the credential your application checks. ReproSeed does not generate one.

Your application has to opt in. ReproSeed does not add GET /__reproseed/identity or POST /__reproseed/reset for you.
After the application is listening, run: reproseed doctor ${requestedPath}
`;
}
