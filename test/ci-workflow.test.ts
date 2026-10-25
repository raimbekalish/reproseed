import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

describe("CI workflow", () => {
  it("keeps least privilege and the required checks", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    assert.equal(workflow.includes("pull_request_target"), false);
    assert.equal(workflow.includes("npm publish"), false);
    assert.equal(workflow.includes("continue-on-error"), false);
    assert.equal(workflow.includes("self-hosted"), false);
    assert.equal(workflow.includes("secrets."), false);
    assert.match(workflow, /cancel-in-progress:\s*true/);
    assert.match(workflow, /branches:\n\s+- main/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /runs-on: ubuntu-latest/);
    assert.match(workflow, /node-version-file: \.node-version/);
    assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
    assert.match(workflow, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7\.1\.0/);
    assert.match(workflow, /persist-credentials: false/);
    for (const command of [
      "npm ci",
      "npm run typecheck",
      "npm run build",
      "npm test",
      "npm run test:cli",
      "npm run test:demo",
      "npm run test:search",
      "npm run test:runner",
      "npm run test:export",
      "npm run test:cli:e2e",
      "npm run test:package",
      "node scripts/install-playwright-chromium.mjs",
    ]) {
      assert.equal(workflow.includes(command), true, command);
    }
    assert.equal(/\$\{\{\s*github\.event\.pull_request\.(title|body|head_ref)/.test(workflow), false);
    assert.match(workflow, /timeout-minutes: 15/);
    assert.match(workflow, /timeout-minutes: 120/);
    assert.match(workflow, /timeout-minutes: 20/);
  });
});
