import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runClimbCli } from "../src/climb/cli.js";
import type { Judge } from "../src/council/run.js";

/**
 * A small deterministic harness in a throwaway git repo: `score.json` is the "code", `bench.mjs`
 * prints its quality plus a fixed, replayable wobble, `check.mjs` is the regression suite.
 */
function climbFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ms-climb-"));
  const files: Record<string, string> = {
    ".gitignore": ".artifacts/\n",
    "score.json": `${JSON.stringify({ quality: 5, broken: false })}\n`,
    "bench.mjs": [
      'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'const { quality } = JSON.parse(readFileSync("score.json", "utf8"));',
      'mkdirSync(".artifacts", { recursive: true });',
      'const n = existsSync(".artifacts/runs") ? Number(readFileSync(".artifacts/runs", "utf8")) : 0;',
      'writeFileSync(".artifacts/runs", String(n + 1));',
      "const wobble = [0, 0.1, -0.1, 0.05, -0.05][n % 5];",
      "console.log(quality + wobble);",
      "",
    ].join("\n"),
    "check.mjs": [
      'import { readFileSync } from "node:fs";',
      'process.exit(JSON.parse(readFileSync("score.json", "utf8")).broken ? 1 : 0);',
      "",
    ].join("\n"),
    "edit.mjs": [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const [delta, flag] = process.argv.slice(2);",
      'const s = JSON.parse(readFileSync("score.json", "utf8"));',
      "s.quality += Number(delta);",
      'if (flag === "broken") s.broken = true;',
      'writeFileSync("score.json", JSON.stringify(s) + "\\n");',
      "",
    ].join("\n"),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "climb@example.com");
  git("config", "user.name", "Climb Fixture");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return dir;
}

const FIXTURE_PLAN = {
  target: 9,
  minAttempts: 3,
  runs: 5,
  noiseFloor: 0.25,
  k: 2,
  harness: "node bench.mjs",
  frozen: ["bench.mjs"],
  regressions: ["node check.mjs"],
  sensitivity: { id: "planted-bad", apply: "node edit.mjs -3" },
  moves: [
    { id: "planted-no-op", apply: "echo 'no-op' >> notes.txt", expectedGain: 2, cost: 1 },
    { id: "planted-improvement", apply: "node edit.mjs 2", expectedGain: 1.5, cost: 1 },
    { id: "planted-regression", apply: "node edit.mjs -1", expectedGain: 1, cost: 1 },
    {
      id: "planted-gain-red-checks",
      apply: "node edit.mjs 3 broken",
      expectedGain: 0.8,
      cost: 1,
    },
    {
      id: "planted-harness-edit",
      apply: "echo 'console.log(10)' >> bench.mjs && node edit.mjs 4",
      expectedGain: 0.5,
      cost: 1,
    },
  ],
};

async function cli(args: string[], cwd: string, deps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    cwd,
    env: process.env,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
  };
  const code = await runClimbCli(args, io, deps);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

describe("mitchstack climb run", () => {
  it("reverts the no-op, keeps the improvement once, reverts every regression", async () => {
    const dir = climbFixture();
    writeFileSync(join(dir, "plan.json"), JSON.stringify(FIXTURE_PLAN));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "plan");
    const r = await cli(["run", "--plan", "plan.json", "--log", ".artifacts/decision.tsv"], dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(1); // short of the target 9: the target is never relaxed
    expect(r.out).toMatch(/climb short/);

    const rows = readFileSync(join(dir, ".artifacts/decision.tsv"), "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split("\t"));
    const decision = Object.fromEntries(rows.slice(1).map((c) => [c[1], c[5]]));
    expect(decision).toEqual({
      "planted-bad": "revert",
      "planted-no-op": "revert",
      "planted-improvement": "keep",
      "planted-regression": "revert",
      "planted-gain-red-checks": "revert",
      "planted-harness-edit": "revert",
    });

    // One commit per kept win, and the tree holds exactly the kept change.
    expect(git(dir, "log", "--format=%s").trim().split("\n")).toEqual([
      "climb: keep planted-improvement (median 5 -> 7)",
      "plan",
      "fixture",
    ]);
    expect(JSON.parse(readFileSync(join(dir, "score.json"), "utf8"))).toEqual({
      quality: 7,
      broken: false,
    });
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("refuses to start on a dirty tree or with a tracked log", async () => {
    const dir = climbFixture();
    writeFileSync(join(dir, "plan.json"), JSON.stringify(FIXTURE_PLAN));
    const dirty = await cli(["run", "--plan", "plan.json", "--log", ".artifacts/d.tsv"], dir);
    expect(dirty.code).toBe(2);
    expect(dirty.err).toMatch(/clean tree/);

    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "plan");
    const tracked = await cli(["run", "--plan", "plan.json", "--log", "decision.tsv"], dir);
    expect(tracked.code).toBe(2);
    expect(tracked.err).toMatch(/not git-ignored/);
  });

  it("refuses to climb when the planted bad change does not move the score", async () => {
    const dir = climbFixture();
    const plan = { ...FIXTURE_PLAN, sensitivity: { id: "planted-bad", apply: "echo x > x.txt" } };
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "plan");
    const r = await cli(["run", "--plan", "plan.json", "--log", ".artifacts/d.tsv"], dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/climb insensitive/);
    expect(git(dir, "log", "--format=%s").trim().split("\n")).toEqual(["plan", "fixture"]);
  });
});

describe("mitchstack climb ladder", () => {
  it("lists the moves lowest-hanging first", async () => {
    const dir = climbFixture();
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({
        ...FIXTURE_PLAN,
        moves: [
          { id: "rewrite", apply: "true", expectedGain: 3, cost: 10 },
          { id: "cache", apply: "true", expectedGain: 2, cost: 1 },
        ],
      }),
    );
    const r = await cli(["ladder", "--plan", "plan.json"], dir);
    expect(r.code).toBe(0);
    expect(r.out.indexOf("cache")).toBeLessThan(r.out.indexOf("rewrite"));
  });

  it("rejects a plan without a sensitivity check", async () => {
    const dir = climbFixture();
    const { sensitivity: _s, ...plan } = FIXTURE_PLAN;
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
    const r = await cli(["ladder", "--plan", "plan.json"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/sensitivity/);
  });
});

describe("mitchstack climb council-score", () => {
  const judge = (id: string, provider: string, afterScore: number, control = 5): Judge => ({
    id,
    provider,
    costUsdPerCall: 0.01,
    score: async (request) => {
      const scores: Record<string, number> = {};
      for (const p of request.pictures) {
        scores[p.label] = readFileSync(p.path, "utf8") === "CONTROL" ? control : afterScore;
      }
      return { kind: "scores", scores };
    },
  });

  function pictures(): string {
    const dir = mkdtempSync(join(tmpdir(), "ms-climb-council-"));
    writeFileSync(join(dir, "after.png"), "AFTER");
    writeFileSync(join(dir, "control.png"), "CONTROL");
    return dir;
  }

  const args = ["council-score", "--after", "after.png", "--control", "control.png"];

  it("prints the median after score and rescores the same screen on every call", async () => {
    const dir = pictures();
    const judges = () => [judge("a (openai)", "openai", 7), judge("b (anthropic)", "anthropic", 8)];
    const first = await cli([...args, "--log", "council.json"], dir, { judges });
    expect(first).toMatchObject({ code: 0, out: "7.5" });
    const second = await cli([...args, "--log", "council.json"], dir, { judges });
    expect(second).toMatchObject({ code: 0, out: "7.5" });
    const log = JSON.parse(readFileSync(join(dir, "council.json"), "utf8"));
    expect(log.rounds).toHaveLength(2);
  });

  it("gives no score when a judge's control drifts", async () => {
    const dir = pictures();
    const steady = () => [judge("a (openai)", "openai", 7), judge("b (anthropic)", "anthropic", 8)];
    await cli([...args, "--log", "council.json"], dir, { judges: steady });
    const drifting = () => [
      judge("a (openai)", "openai", 9, 9),
      judge("b (anthropic)", "anthropic", 9),
    ];
    const r = await cli([...args, "--log", "council.json"], dir, { judges: drifting });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/no score: round 2 discarded: control drift/);
  });
});
