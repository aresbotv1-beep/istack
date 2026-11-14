import { describe, expect, it } from "vitest";
import { compareToBaseline, type EvalResult, toBaseline } from "../src/evals/run.js";

/** A finished run scoring `runScores` (median = score). */
function run(runScores: number[], over: Partial<EvalResult> = {}): EvalResult {
  const sorted = [...runScores].sort((a, b) => a - b);
  return {
    status: "complete",
    reason: "",
    skill: "ship",
    skillHash: `skill-${runScores.join("-")}`,
    scenariosHash: "scenarios-1",
    runner: { id: "claude -p", provider: "anthropic", model: "claude-sonnet-5-5" },
    runs: runScores.length,
    mode: "deterministic",
    costUsd: 0,
    costSource: "measured",
    runScores,
    score: sorted[Math.floor(sorted.length / 2)] as number,
    scenarios: {},
    transcript: [],
    ...over,
  };
}
const opts = (date: string) => ({ date, noiseFloor: 5, k: 2 });

describe("baseline best score (retro 2026-11-13 R3)", () => {
  it("a run 4 points under the last baseline holds, but 8 under the best fails", () => {
    // Two rewrites, each within noise of the one before: 97 → 93 → 89.
    const first = toBaseline(run([97, 97, 97]), opts("2026-11-01"));
    const second = toBaseline(run([93, 93, 93]), opts("2026-11-05"), first);
    expect(second.best).toMatchObject({ score: 97, date: "2026-11-01" });
    const c = compareToBaseline(second, run([89, 89, 89]));
    expect(c).toMatchObject({ comparable: true, delta: -4, best: 97, belowBest: true });
    expect(c.regressed).toBe(true);
    expect(compareToBaseline(second, run([93, 93, 93])).regressed).toBe(false);
  });

  it("a higher score becomes the new best", () => {
    const first = toBaseline(run([90, 90, 90]), opts("2026-11-01"));
    const second = toBaseline(run([95, 95, 95]), opts("2026-11-05"), first);
    expect(second.best).toMatchObject({ score: 95, date: "2026-11-05" });
  });

  it("a baseline from before `best` existed seeds the best from its own score", () => {
    const { best: _drop, ...old } = toBaseline(run([96, 96, 96]), opts("2026-11-01"));
    const next = toBaseline(run([92, 92, 92]), opts("2026-11-12"), old);
    expect(next.best).toMatchObject({ score: 96, date: "2026-11-01" });
  });

  it("new scenarios, runner, model or mode start a new best", () => {
    const first = toBaseline(run([97, 97, 97]), opts("2026-11-01"));
    for (const over of [
      { scenariosHash: "scenarios-2" },
      { runner: { id: "codex exec", provider: "openai", model: "gpt" } },
      { runner: { id: "claude -p", provider: "anthropic", model: "claude-opus-5-5" } },
      { mode: "council" as const },
    ]) {
      expect(toBaseline(run([90, 90, 90], over), opts("2026-11-05"), first).best?.score).toBe(90);
    }
  });
});
