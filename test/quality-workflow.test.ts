import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config/load.js";

const root = new URL("..", import.meta.url).pathname;

it("runs every repo check on the PR head without skipping or masking failures", () => {
  const config = loadConfig(readFileSync(join(root, "mitchstack.yaml"), "utf8"));
  expect(config.ok).toBe(true);
  if (!config.ok) throw new Error("invalid repository config");
  const commands = config.config.checks.map((check) => check.run);
  expect(commands).toEqual([
    "npm run build",
    "node dist/bin/mitchstack.js config check",
    "npm test",
    "npm run typecheck",
    "npm run lint",
  ]);

  const workflow = parse(readFileSync(join(root, ".github/workflows/quality.yml"), "utf8"));
  // Reject execution overrides too (S1): an npm script-shell env or alternate working
  // directory can turn the correct command strings into successful no-ops.
  expect(Object.keys(workflow).sort()).toEqual([
    "concurrency",
    "jobs",
    "name",
    "on",
    "permissions",
  ]);
  // An unconditional pull_request trigger includes forks and avoids pending required checks
  // caused by path/branch filters. The ordinary quality job executes submitted code.
  expect(workflow.on).toEqual({ pull_request: null });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.keys(workflow.jobs)).toEqual(["quality"]);
  const job = workflow.jobs.quality;
  expect(Object.keys(job).sort()).toEqual(["name", "runs-on", "steps", "timeout-minutes"]);
  expect(job["runs-on"]).toBe("ubuntu-latest");
  expect(job.name).toBe("mitchstack/quality");
  expect(job.if).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
  expect(job["timeout-minutes"]).toBeGreaterThan(0);
  const steps = job.steps as Array<{
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    if?: unknown;
    "continue-on-error"?: boolean;
  }>;
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkouts).toHaveLength(1);
  expect(checkouts[0]?.with).toEqual({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression
    ref: "${{ github.event.pull_request.head.sha }}",
    "persist-credentials": false,
  });
  expect(steps[0]).toEqual(checkouts[0]);
  expect(steps.flatMap((step) => (step.uses ? [step.uses] : []))).toEqual([
    expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/),
    expect.stringMatching(/^actions\/setup-node@[0-9a-f]{40}$/),
  ]);
  expect(steps[1]?.with).toEqual({ "node-version": 22 });
  const runs = steps.flatMap((step) => (step.run ? [step.run] : []));
  expect(runs).toEqual(["npm ci --ignore-scripts --no-audit --no-fund", ...commands]);
  for (const step of steps) {
    expect(Object.keys(step).sort()).toEqual(step.uses ? ["uses", "with"] : ["name", "run"]);
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
    if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  }
});
