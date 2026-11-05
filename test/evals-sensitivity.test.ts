import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentReply, AgentRequest, AgentRunner } from "../src/evals/agents.js";
import { runEvalsCli } from "../src/evals/cli.js";
import { compareToBaseline, runSkillEvals, toBaseline } from "../src/evals/run.js";
import { loadScenarios } from "../src/evals/scenarios.js";
import { applyDegrade, loadDegrade, loadSkill } from "../src/evals/skill.js";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Canned replies a skill-following agent might give. The fake runner reads the skill text it was
 * handed: with the express-lane rules present it answers settled work the express way; without
 * them it falls back to the full brainstorm, which is what the deleted rules were preventing.
 */
const EXPRESS_REPLY = [
  "Lane: express lane — the ask names a change, the acceptance check is already written, and it is a two-way door.",
  "",
  "I read the code first: status prints the fields from `collectStatus()`, tests use vitest.",
  "Asked 1 · cut 6 (4 answered from code, 2 don't split the plan)",
  "",
  "Draft ticket: add the flag, print the same fields as JSON, one focused test.",
  "",
  "Weak points of this draft: I have not checked how errors print in JSON mode.",
  "",
  "1. **Errors** — a script pipes the output into jq while the config is missing: JSON error object or plain text on stderr? I recommend a JSON error object, because the script can parse it.",
  "2. How will you know I'm wrong?",
].join("\n");

const ENGINE_REPLY = [
  "Taking the full engine: this is worth a proper look.",
  "",
  "Phase 1 · Anchor: the subject is a command-line tool; the domain is developer tools.",
  "Phase 2 · Hunt: I will run a research hunt across providers and save a research doc.",
  "Phase 3 · Launch post first: a headline and the post a real user would share.",
  "Phase 4 · Board audit with the standing seats (Musk, Thiel, Feynman).",
  "Phase 5 · The wall of ideas, every rung from Polish to Landscape.",
  "",
  "Weak points: the hunt has not run yet, so nothing above is researched.",
  "",
  "What would make this launch post worth sharing for you?",
].join("\n");

function fakeRunner(): AgentRunner & { calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  return {
    id: "fake",
    provider: "test",
    model: "fake-1",
    costUsdPerCall: 0,
    calls,
    async run(request: AgentRequest): Promise<AgentReply> {
      calls.push(request);
      const hasExpress = /## Pick the lane/.test(request.system);
      const settled = /express/.test(request.scenarioId);
      // A small replayable wobble so the noise is not always zero.
      const wobble = calls.length % 4 === 0 ? "\n\n(One more thought: maybe later.)" : "";
      const text = hasExpress && settled ? EXPRESS_REPLY : ENGINE_REPLY;
      return { kind: "text", text: text + wobble, costUsd: 0 };
    },
  };
}

describe("skill eval sensitivity", () => {
  it("a groundbreak copy with the express-lane rules deleted scores lower, beyond noise", async () => {
    const skill = loadSkill(ROOT, "groundbreak");
    const scenarios = loadScenarios(ROOT, "groundbreak");
    const degrade = loadDegrade(join(ROOT, "evals/degraded/groundbreak-no-express-lane.json"));
    const degraded = applyDegrade(skill, degrade);

    expect(degraded.text).not.toMatch(/## Pick the lane/);
    expect(degraded.hash).not.toBe(skill.hash);

    const real = await runSkillEvals({ skill, scenarios, runner: fakeRunner(), runs: 3 });
    const worse = await runSkillEvals({
      skill: degraded,
      scenarios,
      runner: fakeRunner(),
      runs: 3,
    });
    expect(real.status).toBe("complete");
    expect(worse.status).toBe("complete");

    const baseline = toBaseline(real, { date: "2026-11-04", noiseFloor: 5, k: 2 });
    const verdict = compareToBaseline(baseline, worse);
    expect(verdict.regressed).toBe(true);
    expect(verdict.delta).toBeLessThan(-verdict.noise);
    expect(compareToBaseline(baseline, real).regressed).toBe(false);
  });

  it("compare exits 1 for the degraded skill and 0 for the real one", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ms-evals-"));
    cpSync(join(ROOT, "skills"), join(cwd, "skills"), { recursive: true });
    cpSync(join(ROOT, "evals"), join(cwd, "evals"), { recursive: true });
    rmSync(join(cwd, "evals/baselines"), { recursive: true, force: true });
    const lines: string[] = [];
    const io = { cwd, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    const deps = { runner: () => fakeRunner(), now: () => "2026-11-04T00:00:00.000Z" };

    const made = await runEvalsCli(
      ["baseline", "--skill", "groundbreak", "--runs", "3", "--runner", "fake"],
      io,
      deps,
    );
    expect(made).toBe(0);
    const written = JSON.parse(
      readFileSync(join(cwd, "evals/baselines/groundbreak.json"), "utf8"),
    ) as { producedBy: { runner: string; runs: number; mode: string } };
    expect(written.producedBy).toMatchObject({ runner: "fake", runs: 3, mode: "deterministic" });

    const same = await runEvalsCli(
      ["compare", "--skill", "groundbreak", "--runs", "3", "--runner", "fake"],
      io,
      deps,
    );
    expect(same).toBe(0);
    const worse = await runEvalsCli(
      [
        "compare",
        "--skill",
        "groundbreak",
        "--runs",
        "3",
        "--runner",
        "fake",
        "--degrade",
        "evals/degraded/groundbreak-no-express-lane.json",
      ],
      io,
      deps,
    );
    expect(worse).toBe(1);
    expect(lines.join("\n")).toMatch(/groundbreak.*dropped/);
  });
});

describe("evals pick the baseline's model when none is given", () => {
  it("asks the runner for the model the baseline was made with", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ms-evals-model-"));
    cpSync(join(ROOT, "skills"), join(cwd, "skills"), { recursive: true });
    cpSync(join(ROOT, "evals"), join(cwd, "evals"), { recursive: true });
    const asked: Array<{ runner: string; model?: string }> = [];
    const lines: string[] = [];
    const io = { cwd, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    const deps = {
      runner: (spec: { runner: string; model?: string }) => {
        asked.push(spec);
        return fakeRunner();
      },
    };
    await runEvalsCli(["run", "--skill", "retro", "--runs", "1"], io, deps);
    expect(asked).toEqual([{ runner: "claude", model: "claude-sonnet-5-5" }]);
    expect(lines.join("\n")).toMatch(/model claude-sonnet-5-5 \(from the retro baseline\)/);
    asked.length = 0;
    await runEvalsCli(["run", "--skill", "retro", "--runs", "1", "--model", "opus"], io, deps);
    expect(asked).toEqual([{ runner: "claude", model: "opus" }]);
  });
});
