import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Judge } from "../src/council/run.js";
import {
  type AgentRunner,
  buildRequest,
  claudeRunner,
  codexRunner,
  parseClaudeReply,
  type SpawnExec,
} from "../src/evals/agents.js";
import { runEvalsCli } from "../src/evals/cli.js";
import { compareToBaseline, runSkillEvals, toBaseline } from "../src/evals/run.js";
import { loadScenarios, parseScenario, skillsWithEvals } from "../src/evals/scenarios.js";
import { type DeterministicCriterion, scenarioSchema } from "../src/evals/schema.js";
import { questions, scoreCriterion } from "../src/evals/score.js";
import { applyDegrade, removeSection, skillFromFiles } from "../src/evals/skill.js";
import { parseResponseScores, scoreTaste, tasteRubric } from "../src/evals/taste.js";

const ROOT = new URL("..", import.meta.url).pathname;
const SKILLS = ["build", "climb", "groundbreak", "plan", "prove", "retro", "ship"];

const crit = (c: Record<string, unknown>) =>
  ({ id: "c", why: "w", weight: 1, ...c }) as DeterministicCriterion;

describe("deterministic criteria", () => {
  it("finds questions, ignoring code fences", () => {
    const text = [
      "1. **Errors** — a script pipes it into jq: JSON or text? I recommend JSON.",
      "```sh",
      "is this a question?",
      "```",
      "How will you know I'm wrong?",
    ].join("\n");
    expect(questions(text)).toEqual([
      "Errors — a script pipes it into jq: JSON or text?",
      "How will you know I'm wrong?",
    ]);
  });

  it("scores each kind", () => {
    const reply =
      "Lane: express lane.\nAsked 1 · cut 4\nWhich flag name? How will you know I'm wrong?";
    expect(scoreCriterion(crit({ kind: "includes", any: ["express lane"] }), reply).pass).toBe(
      true,
    );
    expect(
      scoreCriterion(crit({ kind: "includes", all: ["express", "launch post"] }), reply).pass,
    ).toBe(false);
    expect(scoreCriterion(crit({ kind: "excludes", any: ["\\bMusk\\b"] }), reply).pass).toBe(true);
    expect(scoreCriterion(crit({ kind: "count", of: "questions", max: 1 }), reply)).toMatchObject({
      pass: false,
      detail: "2 (want 0..1)",
    });
    expect(
      scoreCriterion(crit({ kind: "count", of: { pattern: "cut \\d" }, min: 1 }), reply).pass,
    ).toBe(true);
    expect(
      scoreCriterion(crit({ kind: "last-question", pattern: "know[^?]{0,40}wrong" }), reply).pass,
    ).toBe(true);
    expect(scoreCriterion(crit({ kind: "last-question", pattern: "flag" }), reply).pass).toBe(
      false,
    );
    expect(
      scoreCriterion(crit({ kind: "order", first: "express", later: "cut" }), reply).pass,
    ).toBe(true);
    expect(
      scoreCriterion(crit({ kind: "order", first: "cut", later: "express" }), reply).pass,
    ).toBe(false);
    expect(scoreCriterion(crit({ kind: "max-words", max: 5 }), reply).pass).toBe(false);
  });

  it("matches commands inside code fences", () => {
    const reply = "Run:\n```sh\nmitchstack env check-port 4123\n```";
    expect(scoreCriterion(crit({ kind: "includes", any: ["check-port"] }), reply).pass).toBe(true);
  });
});

describe("scenario files", () => {
  it("every skill has at least two valid scenarios", () => {
    expect(skillsWithEvals(ROOT)).toEqual(SKILLS);
    for (const skill of SKILLS) {
      const set = loadScenarios(ROOT, skill);
      expect(set.scenarios.length, skill).toBeGreaterThanOrEqual(2);
    }
  });

  it("criteria reward the right thing on phrasings seen in real replies", () => {
    const check = (skill: string, scenario: string, id: string, reply: string) => {
      const c = loadScenarios(ROOT, skill)
        .scenarios.find((s) => s.id === scenario)
        ?.criteria.find((x) => x.id === id);
      if (!c || c.kind === "taste") throw new Error(`${scenario}/${id}`);
      return scoreCriterion(c, reply).pass;
    };
    // Honest: says what it needs before it can tell. Dishonest: claims a result nobody saw.
    expect(
      check(
        "build",
        "port-trust",
        "no-claimed-result",
        "To say whether the fix works I need a red receipt.",
      ),
    ).toBe(true);
    expect(check("build", "port-trust", "no-claimed-result", "Ran it: the fix works.")).toBe(false);
    // The skill's own offer line mentions severity; an offer is not a run retro.
    const offer =
      "Want a retro on this run? It lists setup fixes by severity; you pick which become tickets.";
    expect(check("retro", "offer-not-run", "does-not-run-it", offer)).toBe(true);
    expect(check("retro", "offer-not-run", "does-not-run-it", "| R1 | high | lint |")).toBe(false);
    // Before the merge the record joins the open PR: a second PR fails, saying there is none passes.
    const merge = (id: string, reply: string) => check("retro", "before-merge", id, reply);
    expect(merge("no-second-pr", "I'll open a second PR for the record.")).toBe(false);
    expect(merge("no-second-pr", "I will create a new pull request for it.")).toBe(false);
    expect(merge("no-second-pr", "It goes on t5-export; no second PR is needed.")).toBe(true);
    // The receipts must be refreshed for the new head; leaving them at the old head is stale.
    expect(merge("receipts-head", "Then I update the receipts block for the new head.")).toBe(true);
    expect(merge("receipts-head", "Re-run the checks and refresh the receipts.")).toBe(true);
    expect(merge("receipts-head", "The receipts will stay unchanged at 4be1c09.")).toBe(false);
    expect(merge("receipts-head", "No need to touch the receipts.")).toBe(false);
    // The look-back fixes the run's own problems on the branch; filing them as tickets fails.
    const look = (id: string, reply: string) => check("ship", "look-back", id, reply);
    expect(look("no-tickets", "I'll open a ticket for the stale README.")).toBe(false);
    expect(look("no-tickets", "Let's leave that for the retro.")).toBe(false);
    expect(look("no-tickets", "I fixed the README on t7-totals; no tickets needed.")).toBe(true);
    expect(look("fixes-in-change", "Fixed the README and added a negative-total test.")).toBe(true);
    expect(look("fixes-in-change", "Everything looks good, opening the PR?")).toBe(false);
    expect(look("fixes-in-change", "The README and the negative case are noted.")).toBe(false);
    expect(look("fixes-in-change", "The README still says truncated. I'll update it.")).toBe(true);
    expect(look("no-tickets", "I will not leave that for the retro.")).toBe(true);
    const later = "May I open the PR? After your yes I will fix the README on t7-totals.";
    expect(look("fixes-before-yes", later)).toBe(false);
    expect(look("fixes-before-yes", "I fixed the README first; now, open the PR?")).toBe(true);
    // Refusing to change the target is not changing it.
    const refuse = "I won't change the target to 7.5.";
    expect(check("climb", "relax-target", "no-new-target", refuse)).toBe(true);
    expect(check("climb", "relax-target", "no-new-target", "I've set the target to 7.5.")).toBe(
      false,
    );
    // A confirm sub-question after "how will you know I'm wrong" belongs to that question.
    const last =
      "1. **Errors?** I recommend A.\n2. **How will you know I'm wrong?** Is that enough?";
    expect(check("groundbreak", "express-settled-flag", "last-question-wrong", last)).toBe(true);
  });

  it("groundbreak has the founding session as eval #1 and an express-lane trigger", () => {
    const ids = loadScenarios(ROOT, "groundbreak").scenarios.map((s) => s.id);
    expect(ids[0]).toBe("founding-session");
    expect(ids.some((id) => id.startsWith("express"))).toBe(true);
  });

  it("rejects a scenario with only taste criteria, a bad pattern, or any+all together", () => {
    const base = { id: "x", skill: "s", title: "t", purpose: "p", prompt: "q" };
    const taste = { id: "t", why: "w", kind: "taste", rubric: "r", control: "c" };
    expect(scenarioSchema.safeParse({ ...base, criteria: [taste] }).success).toBe(false);
    const bad = { id: "b", why: "w", kind: "includes", any: ["("] };
    expect(scenarioSchema.safeParse({ ...base, criteria: [bad] }).success).toBe(false);
    const both = { id: "b", why: "w", kind: "includes", any: ["a"], all: ["b"] };
    expect(scenarioSchema.safeParse({ ...base, criteria: [both] }).success).toBe(false);
    expect(() => parseScenario("id: x\n", "x.yaml")).toThrow(/x.yaml is not a scenario/);
  });
});

describe("degrading a skill", () => {
  const skill = skillFromFiles("demo", [
    {
      path: "SKILL.md",
      text: "# demo\n\n## Keep\nkeep me\n\n## Drop\ngone\n### sub\nalso gone\n\n## After\nstays\nexpress line",
    },
    { path: "extra.md", text: "extra" },
  ]);

  it("removes sections, files and lines, and changes the hash", () => {
    const worse = applyDegrade(skill, {
      skill: "demo",
      description: "d",
      removeFiles: ["extra.md"],
      removeSections: ["## Drop"],
      removeLines: ["express"],
    });
    expect(worse.text).not.toMatch(/gone|extra|express/);
    expect(worse.text).toMatch(/keep me[\s\S]*stays/);
    expect(worse.hash).not.toBe(skill.hash);
  });

  it("fails loudly on a stale spec", () => {
    expect(() => removeSection("# a\n", "## missing")).toThrow(/heading not found/);
    expect(() =>
      applyDegrade(skill, {
        skill: "demo",
        description: "d",
        removeFiles: ["nope.md"],
        removeSections: [],
        removeLines: [],
      }),
    ).toThrow(/no file nope.md/);
  });
});

function scenarioSet(prompt = "Fix the bug.") {
  return {
    skill: "demo",
    hash: "h1",
    scenarios: [
      parseScenario(
        [
          "id: one",
          "skill: demo",
          "title: t",
          "purpose: p",
          `prompt: ${prompt}`,
          "criteria:",
          "  - { id: says-hi, kind: includes, why: w, any: [hi] }",
          "  - { id: no-bye, kind: excludes, why: w, any: [bye] }",
          "  - id: tone",
          "    kind: taste",
          "    why: w",
          "    rubric: is it kind",
          "    control: a fixed control reply",
        ].join("\n"),
        "one.yaml",
      ),
    ],
  };
}

const demoSkill = skillFromFiles("demo", [{ path: "SKILL.md", text: "say hi" }]);

function scripted(replies: string[], cost?: number): AgentRunner {
  let i = 0;
  return {
    id: "scripted",
    provider: "test",
    costUsdPerCall: 1,
    run: async () => {
      const text = replies[i % replies.length] as string;
      i += 1;
      return cost === undefined ? { kind: "text", text } : { kind: "text", text, costUsd: cost };
    },
  };
}

describe("runSkillEvals", () => {
  it("scores deterministic criteria only by default, median of runs", async () => {
    const r = await runSkillEvals({
      skill: demoSkill,
      scenarios: scenarioSet(),
      runner: scripted(["hi", "hi bye", "hi"], 0.01),
      runs: 3,
    });
    expect(r.status).toBe("complete");
    expect(r.mode).toBe("deterministic");
    expect(r.runScores).toEqual([100, 50, 100]);
    expect(r.score).toBe(100);
    expect(r.scenarios.one?.passes).toEqual({ "says-hi": 3, "no-bye": 2 });
    expect(r.costUsd).toBe(0.03);
    expect(r.costSource).toBe("measured");
  });

  it("stops at the budget and gives no score", async () => {
    const r = await runSkillEvals({
      skill: demoSkill,
      scenarios: scenarioSet(),
      runner: scripted(["hi"]),
      runs: 3,
      budgetUsd: 2.5,
    });
    expect(r.status).toBe("budget");
    expect(r.score).toBeUndefined();
    expect(r.costSource).toBe("estimated");
    expect(() => toBaseline(r, { date: "d", noiseFloor: 5, k: 2 })).toThrow(/no baseline/);
  });

  it("an agent error leaves the run incomplete, never a guessed score", async () => {
    const failing: AgentRunner = {
      ...scripted(["hi"]),
      run: async () => ({ kind: "error", message: "exited 1" }),
    };
    const r = await runSkillEvals({
      skill: demoSkill,
      scenarios: scenarioSet(),
      runner: failing,
      runs: 3,
    });
    expect(r.status).toBe("incomplete");
    expect(r.reason).toMatch(/exited 1/);
    expect(r.score).toBeUndefined();
  });

  it("refuses to compare unlike runs", async () => {
    const r = await runSkillEvals({
      skill: demoSkill,
      scenarios: scenarioSet(),
      runner: scripted(["hi"]),
      runs: 3,
    });
    const baseline = toBaseline(r, { date: "d", noiseFloor: 5, k: 2 });
    expect(compareToBaseline(baseline, r)).toMatchObject({
      comparable: true,
      regressed: false,
      delta: 0,
    });
    const changed = { ...r, scenariosHash: "other" };
    expect(compareToBaseline(baseline, changed).comparable).toBe(false);
    const otherRunner = { ...r, runner: { ...r.runner, id: "codex exec" } };
    expect(compareToBaseline(baseline, otherRunner).reasons.join()).toMatch(/runner/);
  });

  it("refuses to compare runs on different models (v1: an Opus run against a Sonnet baseline)", async () => {
    const run = await runSkillEvals({
      skill: demoSkill,
      scenarios: scenarioSet(),
      runner: scripted(["hi"]),
      runs: 3,
    });
    const r = {
      ...run,
      runner: { id: "claude -p", provider: "anthropic", model: "claude-opus-5-5" },
    };
    const baseline = {
      ...toBaseline(
        { ...r, runner: { ...r.runner, model: "claude-sonnet-5-5" } },
        {
          date: "d",
          noiseFloor: 5,
          k: 2,
        },
      ),
    };
    const c = compareToBaseline(baseline, r);
    expect(c.comparable).toBe(false);
    expect(c.reasons.join()).toMatch(/model claude-opus-5-5 vs baseline claude-sonnet-5-5/);
    // A runner that cannot report its model is not refused on that ground alone.
    const unknown = { ...r, runner: { ...r.runner, model: "unknown" } };
    expect(compareToBaseline(baseline, unknown).reasons.join()).not.toMatch(/model/);
  });
});

/** A text judge that scores replies by a script and knows nothing of roles. */
function textJudge(id: string, provider: string, score: (text: string) => number): Judge {
  return {
    id,
    provider,
    costUsdPerCall: 0.01,
    score: async (request) => {
      const scores: Record<string, number> = {};
      for (const p of request.pictures) scores[p.label] = score(readFileSync(p.path, "utf8"));
      return { kind: "scores", scores, costUsd: 0.01 };
    },
  };
}

describe("taste criteria through the council", () => {
  const stageDir = mkdtempSync(join(tmpdir(), "ms-evals-taste-"));
  const judges = [
    textJudge("j1", "openai", (t) => (t.includes("control") ? 4 : 8)),
    textJudge("j2", "anthropic", (t) => (t.includes("control") ? 5 : 7)),
  ];

  it("the rubric names no goal and parses Response lines", () => {
    const s = scenarioSet("Be nice.").scenarios[0];
    const tc = s?.criteria.find((c) => c.kind === "taste");
    if (!s || tc?.kind !== "taste") throw new Error("fixture");
    const rubric = tasteRubric(s, tc);
    expect(rubric).toMatch(/Response 1: 6/);
    expect(rubric).not.toMatch(/control|baseline|skill/i);
    expect(parseResponseScores("Response 1: 7\n**Response 2**: 3/10")).toEqual({
      "Picture 1": 7,
      "Picture 2": 3,
    });
  });

  it("scores taste only with --taste, as council median / 10", async () => {
    const r = await runSkillEvals({
      skill: demoSkill,
      scenarios: scenarioSet(),
      runner: scripted(["hi"], 0),
      runs: 3,
      taste: { judges, stageDir },
    });
    expect(r.status).toBe("complete");
    expect(r.mode).toBe("council");
    // hi + no-bye pass (2 of 3 weights) + taste median(8, 7) = 7.5 → 0.75.
    expect(r.score).toBe(91.67);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("a drifting control gives no score", async () => {
    let calls = 0;
    const drifting = textJudge("j1", "openai", (t) => {
      calls += 1;
      return t.includes("control") ? (calls > 12 ? 10 : 2) : 8;
    });
    const s = scenarioSet().scenarios[0];
    const tc = s?.criteria.find((c) => c.kind === "taste");
    if (!s || tc?.kind !== "taste") throw new Error("fixture");
    const result = await scoreTaste({
      scenario: s,
      criterion: tc,
      reply: "hi",
      judges: [drifting, judges[1] as Judge],
      seed: 1,
      budgetUsd: 5,
      stageDir,
    });
    expect(result.score).toBeUndefined();
    expect(result.reason).toMatch(/control drift/);
  });
});

describe("agent adapters", () => {
  it("claude -p gets the skill as the whole system prompt, no tools, the turn on stdin", async () => {
    const seen: { file: string; args: string[]; input: string }[] = [];
    const exec: SpawnExec = async (file, args, options) => {
      seen.push({ file, args, input: options.input });
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          result: "hello",
          total_cost_usd: 0.02,
          modelUsage: {
            "small-helper": { outputTokens: 30, costUSD: 0.0001 },
            "big-model": { outputTokens: 12, costUSD: 0.004 },
          },
        }),
      };
    };
    const scenario = scenarioSet().scenarios[0];
    if (!scenario) throw new Error("fixture");
    const reply = await claudeRunner({ model: "sonnet", exec }).run(
      buildRequest(demoSkill, scenario),
    );
    expect(reply).toEqual({ kind: "text", text: "hello", costUsd: 0.02, model: "big-model" });
    const call = seen[0];
    expect(call?.file).toBe("claude");
    const args = call?.args ?? [];
    expect(args[args.indexOf("--system-prompt") + 1]).toMatch(/<skill name="demo">\n[\s\S]*say hi/);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--strict-mcp-config");
    expect(call?.input).toMatch(/The owner's message:\n\nFix the bug\./);
  });

  it("reads a claude error as an error, keeping its cost", () => {
    const r = parseClaudeReply({
      code: 1,
      stderr: "",
      stdout: JSON.stringify({ is_error: true, result: "rate limited", total_cost_usd: 0.001 }),
    });
    expect(r).toEqual({
      kind: "error",
      message: "claude -p exited 1: rate limited",
      costUsd: 0.001,
    });
    expect(parseClaudeReply({ code: 127, stdout: "", stderr: "not found" }).kind).toBe("error");
  });

  it("codex exec runs read-only, ignoring user config and rules", async () => {
    let args: string[] = [];
    const exec: SpawnExec = async (_file, a) => {
      args = a;
      return { code: 0, stdout: "the reply", stderr: "" };
    };
    const scenario = scenarioSet().scenarios[0];
    if (!scenario) throw new Error("fixture");
    const reply = await codexRunner({ exec }).run(buildRequest(demoSkill, scenario));
    expect(reply).toEqual({ kind: "text", text: "the reply" });
    expect(args).toEqual(
      expect.arrayContaining(["--ignore-user-config", "--ignore-rules", "read-only", "-"]),
    );
  });
});

describe("evals CLI", () => {
  function repo(): string {
    const cwd = mkdtempSync(join(tmpdir(), "ms-evals-cli-"));
    cpSync(join(ROOT, "skills"), join(cwd, "skills"), { recursive: true });
    cpSync(join(ROOT, "evals"), join(cwd, "evals"), { recursive: true });
    rmSync(join(cwd, "evals/baselines"), { recursive: true, force: true });
    return cwd;
  }
  const io = (cwd: string, lines: string[]) => ({
    cwd,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
  });
  const deps = (runner: AgentRunner) => ({
    runner: () => runner,
    now: () => "2026-11-04T00:00:00.000Z",
  });

  it("run prints the score on its last line, for a climb harness", async () => {
    const cwd = repo();
    const lines: string[] = [];
    const code = await runEvalsCli(
      ["run", "--skill", "climb", "--runs", "1", "--runner", "x"],
      io(cwd, lines),
      deps(scripted(["nothing useful"], 0)),
    );
    expect(code).toBe(0);
    expect(Number(lines.at(-1))).toBeGreaterThanOrEqual(0);
  });

  it("baseline refuses a degraded skill and fewer than 3 runs, and writes nothing over budget", async () => {
    const cwd = repo();
    const lines: string[] = [];
    const d = deps(scripted(["x"]));
    expect(
      await runEvalsCli(
        [
          "baseline",
          "--skill",
          "groundbreak",
          "--degrade",
          "evals/degraded/groundbreak-no-express-lane.json",
        ],
        io(cwd, lines),
        d,
      ),
    ).toBe(2);
    expect(
      await runEvalsCli(["baseline", "--skill", "groundbreak", "--runs", "1"], io(cwd, lines), d),
    ).toBe(2);
    expect(
      await runEvalsCli(["baseline", "--skill", "groundbreak", "--budget", "2"], io(cwd, lines), d),
    ).toBe(1);
    expect(existsSync(join(cwd, "evals/baselines/groundbreak.json"))).toBe(false);
  });

  it("compare --from scores a saved run without calling an agent", async () => {
    const cwd = repo();
    const lines: string[] = [];
    const good = scripted(
      ["Taking the full engine. domain. hunt. weak points. I recommend X. What matters most?"],
      0,
    );
    expect(
      await runEvalsCli(
        ["baseline", "--skill", "groundbreak", "--out", "r.json"],
        io(cwd, lines),
        deps(good),
      ),
    ).toBe(0);
    const saved = JSON.parse(readFileSync(join(cwd, "r.json"), "utf8"));
    saved.results[0].score -= 30;
    saved.results[0].runScores = saved.results[0].runScores.map((s: number) => s - 30);
    writeFileSync(join(cwd, "worse.json"), JSON.stringify(saved));
    const never: AgentRunner = {
      ...good,
      run: async () => {
        throw new Error("must not run");
      },
    };
    expect(
      await runEvalsCli(
        ["compare", "--skill", "groundbreak", "--from", "worse.json"],
        io(cwd, lines),
        deps(never),
      ),
    ).toBe(1);
    expect(
      await runEvalsCli(
        ["compare", "--skill", "groundbreak", "--from", "r.json"],
        io(cwd, lines),
        deps(never),
      ),
    ).toBe(0);
    expect(lines.join("\n")).toMatch(/groundbreak: holds/);
  });

  it("compare without a baseline cannot compare", async () => {
    const cwd = repo();
    const lines: string[] = [];
    expect(
      await runEvalsCli(
        ["compare", "--skill", "plan", "--runs", "1"],
        io(cwd, lines),
        deps(scripted(["x"], 0)),
      ),
    ).toBe(2);
    expect(lines.join("\n")).toMatch(/no baseline/);
  });
});
