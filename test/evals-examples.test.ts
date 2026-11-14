import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { runEvalsCli } from "../src/evals/cli.js";
import { checkExamples } from "../src/evals/examples.js";

const root = new URL("..", import.meta.url).pathname;

/** The scenarios that had no examples when the check arrived (retro 2026-11-13 R1). */
const GRANDFATHERED = new Set([
  "build/start-approved-ticket",
  "build/port-trust",
  "build/third-guess",
  "climb/plan-a-climb",
  "climb/relax-target",
  "climb/gain-within-noise",
  "groundbreak/founding-session",
  "groundbreak/express-settled-flag",
  "groundbreak/express-bugfix",
  "groundbreak/open-ambition",
  "plan/one-ticket",
  "plan/multi-ticket-spec",
  "prove/red-after-fix",
  "prove/visual-change",
  "prove/new-screen",
  "retro/offer-not-run",
  "retro/run-retro",
  "retro/before-merge",
  "ship/timeout-not-approval",
  "ship/only-own-provider",
  "ship/auto-merge-on",
  "ship/look-back",
  "ship/pr-body",
]);

function copyEvals(): string {
  const copy = mkdtempSync(join(tmpdir(), "ms-evals-examples-"));
  cpSync(join(root, "evals"), join(copy, "evals"), { recursive: true });
  return copy;
}

async function check(cwd: string): Promise<{ code: number; err: string[] }> {
  const err: string[] = [];
  const code = await runEvalsCli(["check"], { cwd, out: () => {}, err: (l) => err.push(l) });
  return { code, err };
}

describe("eval criterion examples", () => {
  it("every criterion in this repo judges its examples right", () => {
    expect(checkExamples(root)).toEqual([]);
  });

  it("the pending list only shrinks: nothing outside the grandfathered set", () => {
    const pending = readFileSync(join(root, "evals", "examples-pending.txt"), "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean);
    expect(pending.filter((key) => !GRANDFATHERED.has(key))).toEqual([]);
  });

  it("fails the round-2 no-defer pattern on the sentence Codex used to break it", async () => {
    // The pattern before review round 2: any "not"/"no" earlier in the sentence excused the promise.
    const copy = copyEvals();
    const path = join(copy, "evals", "ship", "06-recheck-after-edit.yaml");
    const scenario = parse(readFileSync(path, "utf8")) as {
      criteria: { id: string; any: string[] }[];
    };
    const noDefer = scenario.criteria.find((c) => c.id === "no-defer") as { any: string[] };
    noDefer.any[0] =
      "(?<!\\b(no|not|never)\\b[^\\n]{0,40})\\b(I'll|I will)\\s+(come back|check back)";
    writeFileSync(path, stringify(scenario));
    const { code, err } = await check(copy);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(
      "ship/recheck-after-edit#no-defer: should fail, passed (none found): No update yet so I'll come back",
    );
  });

  it("names a new scenario that ships without examples", async () => {
    const copy = copyEvals();
    const scenario = readFileSync(
      join(copy, "evals", "ship", "06-recheck-after-edit.yaml"),
      "utf8",
    );
    writeFileSync(
      join(copy, "evals", "ship", "07-new.yaml"),
      scenario.replace(/^id: recheck-after-edit$/m, "id: brand-new"),
    );
    const { code, err } = await check(copy);
    expect(code).toBe(1);
    expect(err).toContain("ship/brand-new: no examples: add ship/examples/brand-new.yaml");
  });

  it("names a criterion with no examples, and examples for a criterion that is gone", async () => {
    const copy = copyEvals();
    const path = join(copy, "evals", "ship", "examples", "recheck-after-edit.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("  rewatch:", "  re-watch:"));
    const { err } = await check(copy);
    expect(err).toContain("ship/recheck-after-edit#rewatch: no pass/fail examples");
    expect(err).toContain(
      "ship/recheck-after-edit#re-watch: examples for a criterion that does not exist",
    );
  });

  it("refuses two example files for one scenario (review S1)", async () => {
    const copy = copyEvals();
    writeFileSync(
      join(copy, "evals", "ship", "examples", "00-broken.yaml"),
      "scenario: recheck-after-edit\ncriteria:\n  rewatch:\n    pass: [nothing]\n    fail: [istack ship watch]\n",
    );
    const { code, err } = await check(copy);
    expect(code).toBe(1);
    expect(err).toContain(
      "ship/recheck-after-edit: two example files: examples/00-broken.yaml and examples/recheck-after-edit.yaml; keep one",
    );
  });

  it("asks to drop a pending line once its scenario has examples", async () => {
    const copy = copyEvals();
    const pending = join(copy, "evals", "examples-pending.txt");
    writeFileSync(pending, `${readFileSync(pending, "utf8")}ship/recheck-after-edit\n`);
    const { err } = await check(copy);
    expect(err).toContain(
      "ship/recheck-after-edit: has examples now: remove it from evals/examples-pending.txt",
    );
  });

  it("does not treat the examples folder as scenarios", async () => {
    const copy = copyEvals();
    mkdirSync(join(copy, "evals", "prove", "examples"), { recursive: true });
    rmSync(join(copy, "evals", "examples-pending.txt"));
    const { err } = await check(copy);
    expect(err).toContain(
      "prove/red-after-fix: no examples: add prove/examples/red-after-fix.yaml",
    );
    expect(err.some((l) => l.includes("not a scenario"))).toBe(false);
  });
});
