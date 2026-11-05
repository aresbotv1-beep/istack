import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselinePath, runEvalsCli } from "../src/evals/cli.js";
import { loadScenarios, skillsWithEvals } from "../src/evals/scenarios.js";
import { baselineSchema } from "../src/evals/schema.js";
import { loadSkill } from "../src/evals/skill.js";

const root = new URL("..", import.meta.url).pathname;

/**
 * A baseline scores one exact text of a skill. When the skill changes and the baseline does not,
 * every later `evals compare` measures against a skill that no longer exists, and a drop can't be
 * pinned on any one edit (v1: plan moved 89 → 77 across several unmeasured edits). So the commit
 * that changes a skill also carries its new baseline.
 */
describe("committed eval baselines", () => {
  for (const skill of skillsWithEvals(root)) {
    it(`${skill}: the baseline was made from the skill and scenarios as they are now`, () => {
      const baseline = baselineSchema.parse(
        JSON.parse(readFileSync(baselinePath(root, skill), "utf8")),
      );
      expect(baseline.skillHash, "skill text changed: run mitchstack evals baseline").toBe(
        loadSkill(root, skill).hash,
      );
      expect(baseline.scenariosHash).toBe(loadScenarios(root, skill).hash);
    });
  }

  it("evals list says which baselines are current and which are stale", async () => {
    const copy = mkdtempSync(join(tmpdir(), "ms-evals-stale-"));
    cpSync(join(root, "skills"), join(copy, "skills"), { recursive: true });
    cpSync(join(root, "evals"), join(copy, "evals"), { recursive: true });
    appendFileSync(join(copy, "skills", "retro", "SKILL.md"), "\nOne more line.\n");
    const out: string[] = [];
    await runEvalsCli(["list"], { cwd: copy, out: (l) => out.push(l), err: () => {} });
    expect(out[0]).toBe("| skill | scenarios | baseline | produced by | current |");
    expect(out.find((l) => l.startsWith("| retro "))).toMatch(/\| stale: skill changed \|$/);
    expect(out.find((l) => l.startsWith("| prove "))).toMatch(/\| yes \|$/);
  });
  it("baseline --from refuses a run scored on other skill text", async () => {
    const copy = mkdtempSync(join(tmpdir(), "ms-evals-from-"));
    cpSync(join(root, "skills"), join(copy, "skills"), { recursive: true });
    cpSync(join(root, "evals"), join(copy, "evals"), { recursive: true });
    const saved = join(copy, "r.json");
    writeFileSync(saved, JSON.stringify({ results: [{ skill: "retro", skillHash: "old" }] }));
    const err: string[] = [];
    const code = await runEvalsCli(["baseline", "--skill", "retro", "--from", saved], {
      cwd: copy,
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/other skill text/);
    expect(readFileSync(join(copy, "evals/baselines/retro.json"), "utf8")).toBe(
      readFileSync(join(root, "evals/baselines/retro.json"), "utf8"),
    );
  });
});

describe("baseline --from (review G5, G6)", () => {
  const savedRun = (copy: string, overrides: Record<string, unknown>) => {
    const r = {
      skill: "retro",
      status: "complete",
      skillHash: loadSkill(copy, "retro").hash,
      scenariosHash: loadScenarios(copy, "retro").hash,
      runScores: [100, 100, 100],
      ...overrides,
    };
    const path = join(copy, "r.json");
    writeFileSync(path, JSON.stringify({ results: [r] }));
    return path;
  };
  const attempt = async (copy: string, path: string) => {
    const err: string[] = [];
    const code = await runEvalsCli(["baseline", "--skill", "retro", "--from", path], {
      cwd: copy,
      out: () => {},
      err: (l) => err.push(l),
    });
    return { code, err: err.join("\n") };
  };
  const fresh = () => {
    const copy = mkdtempSync(join(tmpdir(), "ms-evals-from-"));
    cpSync(join(root, "skills"), join(copy, "skills"), { recursive: true });
    cpSync(join(root, "evals"), join(copy, "evals"), { recursive: true });
    return copy;
  };

  it("refuses a run scored on other scenarios", async () => {
    const copy = fresh();
    const r = await attempt(copy, savedRun(copy, { scenariosHash: "old" }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/other scenarios/);
  });

  it("refuses a saved run of fewer than 3 runs", async () => {
    const copy = fresh();
    const r = await attempt(copy, savedRun(copy, { runScores: [100] }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/1 run/);
  });
});
