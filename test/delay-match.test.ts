import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requestMatchesDelay } from "../src/runner/delay-match.ts";
import { normalizeDomText } from "../src/runner/dom-text.ts";
import { domTextOutcome } from "../src/runner/oracle.ts";

const ORIGIN = "http://127.0.0.1:4020";

describe("delay matching", () => {
  it("keeps POST substring matching and does not catch GET", () => {
    assert.equal(
      requestMatchesDelay({
        method: "POST",
        url: `${ORIGIN}/api/records`,
        origin: ORIGIN,
        urlIncludes: "/api/records",
        delayMethod: "POST",
      }),
      true,
    );
    assert.equal(
      requestMatchesDelay({
        method: "POST",
        url: `${ORIGIN}/api/records?x=1`,
        origin: ORIGIN,
        urlIncludes: "/api/records",
        delayMethod: "POST",
      }),
      true,
    );
    assert.equal(
      requestMatchesDelay({
        method: "GET",
        url: `${ORIGIN}/api/records`,
        origin: ORIGIN,
        urlIncludes: "/api/records",
        delayMethod: "POST",
      }),
      false,
    );
  });

  it("matches one GET search and leaves other GETs alone", () => {
    const needle = "/api/search?q=alpha";
    const match = (url: string, method = "GET"): boolean =>
      requestMatchesDelay({
        method,
        url: `${ORIGIN}${url}`,
        origin: ORIGIN,
        urlIncludes: needle,
        delayMethod: "GET",
      });
    assert.equal(match("/api/search?q=alpha"), true);
    assert.equal(match("/api/search?q=alpha&extra=1"), true);
    assert.equal(match("/api/search?q=alphabet"), false);
    assert.equal(match("/api/search?q=beta"), false);
    assert.equal(match("/"), false);
    assert.equal(match("/__reproseed/identity"), false);
    assert.equal(match("/__reproseed/reset", "POST"), false);
    assert.equal(match("/api/records"), false);
    assert.equal(match("/api/search?q=alpha", "POST"), false);
  });

  it("normalizes DOM text and keeps different actual strings distinct", () => {
    assert.equal(normalizeDomText(" Results\u00a0for   beta "), "Results for beta");
    const mismatch = domTextOutcome({
      selector: "#results",
      actual: "Results for alpha",
      expect: "Results for beta",
      durationMs: 4,
    });
    const same = domTextOutcome({
      selector: "#results",
      actual: "Results for beta",
      expect: " Results for beta ",
      durationMs: 4,
    });
    assert.equal(same.status, "pass");
    assert.equal(mismatch.status, "fail");
    if (mismatch.status !== "fail" || mismatch.signature.oracleId !== "dom-text") {
      return;
    }
    assert.equal(mismatch.signature.code, "DOM_MISMATCH");
    assert.equal(mismatch.signature.facts.actual, "Results for alpha");
    assert.equal(mismatch.signature.facts.expect, "Results for beta");
  });
});
