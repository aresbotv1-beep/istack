import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CliIo } from "../cli.js";
import type { Judge } from "../council/run.js";
import { toFieldErrors } from "../result.js";
import { onPath } from "../ship/cli.js";
import { type AgentRunner, claudeRunner, codexRunner } from "./agents.js";
import { compareToBaseline, type EvalResult, runSkillEvals, toBaseline } from "./run.js";
import { loadScenarios, skillsWithEvals } from "./scenarios.js";
import { type Baseline, baselineSchema } from "./schema.js";
import { applyDegrade, loadDegrade, loadSkill } from "./skill.js";
import { judgeFromRunner } from "./taste.js";

export interface EvalsDeps {
  /** Builds the agent under test. Defaults to the real `claude -p` / `codex exec` adapters. */
  runner?: (spec: { runner: string; model?: string }) => AgentRunner;
  /** Judges for `--taste`. Defaults to one text judge per installed provider CLI. */
  judges?: () => Judge[];
  now?: () => string;
}

const USAGE = [
  "usage: mitchstack evals list",
  "       mitchstack evals run      --skill <name|all> [options]   score now; last line is the score",
  "       mitchstack evals baseline --skill <name|all> [options]   write evals/baselines/<skill>.json",
  "       mitchstack evals compare  --skill <name|all> [options] [--from results.json]",
  "       (baseline --from results.json writes the baseline from a saved run of the current skill)",
  "options: --runs <n> (3)  --runner claude|codex (claude)  --model <id> (the baseline's)  --budget <usd> (2)",
  "         --taste (council-score taste criteria; off by default)  --degrade <spec.json>",
  "         --noise-floor <points> (5)  --k <n> (2)  --out <results.json>  --transcript <file.jsonl>",
].join("\n");

const BOOLEAN = new Set(["taste"]);

/**
 * `args` are the words after `evals`. Exit codes: 0 done (compare: no skill dropped beyond noise),
 * 1 a skill dropped beyond noise, or a run ended without a score, 2 could not run or compare.
 */
export async function runEvalsCli(
  args: string[],
  io: CliIo,
  deps: EvalsDeps = {},
): Promise<number> {
  const [command, ...rest] = args;
  const parsed = parseFlags(rest);
  if (!parsed.ok) return usage(io, parsed.reason);
  const flags = parsed.flags;
  if (command === "list") return list(io);
  if (command !== "run" && command !== "baseline" && command !== "compare") return usage(io);

  const skillFlag = flags.get("skill");
  if (!skillFlag) return usage(io, `${command} needs --skill <name|all>`);
  const skills = skillFlag === "all" ? skillsWithEvals(io.cwd) : [skillFlag];
  if (skills.length === 0) {
    io.err(`no scenarios under ${join(io.cwd, "evals")}`);
    return 2;
  }
  const runs = Number(flags.get("runs") ?? "3");
  const budgetUsd = Number(flags.get("budget") ?? "2");
  const noiseFloor = Number(flags.get("noise-floor") ?? "5");
  const k = Number(flags.get("k") ?? "2");
  if (!Number.isInteger(runs) || runs < 1) return usage(io, "--runs is a whole number, at least 1");
  if (!(budgetUsd >= 0)) return usage(io, "--budget is a number of dollars");
  if (!(noiseFloor >= 0) || !(k >= 0)) return usage(io, "--noise-floor and --k are zero or more");
  if (command === "baseline" && runs < 3)
    return usage(io, "a baseline needs --runs 3 or more (a median of fewer is not a median)");

  // compare --from: score a saved run against the committed baselines, without calling an agent.
  let saved: EvalResult[] | undefined;
  const from = flags.get("from");
  if (from) {
    if (command === "run") return usage(io, "--from only goes with compare or baseline");
    try {
      saved = (JSON.parse(readFileSync(resolve(io.cwd, from), "utf8")) as { results: EvalResult[] })
        .results;
    } catch (error) {
      io.err(`cannot read ${from}: ${(error as Error).message}`);
      return 2;
    }
  }

  const degradePath = flags.get("degrade");
  if (command === "baseline" && degradePath) {
    return usage(io, "refusing to write a baseline from a degraded skill");
  }
  const runnerName = flags.get("runner") ?? "claude";
  const model = flags.get("model");
  /**
   * The agent under test. Without --model it is the model the skill's baseline was made with: a
   * run on another model can't be compared with it (v1: an Opus run against a Sonnet baseline).
   */
  const runnerFor = (name: string): AgentRunner | string => {
    let pick = model;
    if (!pick) {
      const path = baselinePath(io.cwd, name);
      const parsed = existsSync(path)
        ? baselineSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
        : undefined;
      const made = parsed?.success ? parsed.data.producedBy : undefined;
      if (
        made?.runner.startsWith(runnerName) &&
        made.model !== "unknown" &&
        !made.model.includes(",")
      ) {
        pick = made.model;
        io.out(`${name}: model ${pick} (from the ${name} baseline)`);
      }
    }
    try {
      return (deps.runner ?? defaultRunner)({
        runner: runnerName,
        ...(pick ? { model: pick } : {}),
      });
    } catch (error) {
      return (error as Error).message;
    }
  };
  let judges: Judge[] | undefined;
  if (flags.has("taste") && !saved) {
    judges = (deps.judges ?? (() => defaultJudges(io)))();
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const transcriptPath = flags.get("transcript");
  if (transcriptPath) mkdirSync(dirname(resolve(io.cwd, transcriptPath)), { recursive: true });
  const results: EvalResult[] = [];
  let spent = 0;
  let exit = 0;

  for (const name of skills) {
    let result: EvalResult | undefined;
    if (saved) {
      result = saved.find((r) => r.skill === name);
      if (!result) {
        io.err(`${from} has no result for ${name}`);
        return 2;
      }
      if (command === "baseline") {
        // The written baseline must describe the skill and scenarios as they are now, from a
        // median of at least 3 complete runs, exactly as a fresh `evals baseline` would.
        const problem =
          result.skillHash !== loadSkill(io.cwd, name).hash
            ? "was scored on other skill text (or degraded)"
            : result.scenariosHash !== loadScenarios(io.cwd, name).hash
              ? "was scored on other scenarios"
              : result.status !== "complete"
                ? `did not complete (${result.status})`
                : (result.runScores?.length ?? 0) < 3
                  ? `has ${result.runScores?.length ?? 0} run${result.runScores?.length === 1 ? "" : "s"}; a baseline needs 3 or more`
                  : undefined;
        if (problem) {
          io.err(`${from}: ${name} ${problem}; not a baseline`);
          return 2;
        }
      }
    } else {
      let skill: ReturnType<typeof loadSkill>;
      let scenarios: ReturnType<typeof loadScenarios>;
      try {
        skill = loadSkill(io.cwd, name);
        scenarios = loadScenarios(io.cwd, name);
        if (degradePath) {
          const spec = loadDegrade(resolve(io.cwd, degradePath));
          if (spec.skill === name) skill = applyDegrade(skill, spec);
        }
      } catch (error) {
        io.err((error as Error).message);
        return 2;
      }
      const runner = runnerFor(name);
      if (typeof runner === "string") {
        io.err(runner);
        return 2;
      }
      result = await runSkillEvals({
        skill,
        scenarios,
        runner,
        runs,
        budgetUsd: Math.max(0, budgetUsd - spent),
        ...(judges ? { taste: { judges, stageDir: join(tmpdir(), "ms-evals-taste") } } : {}),
        record: (entry) => {
          if (transcriptPath) {
            appendFileSync(
              resolve(io.cwd, transcriptPath),
              `${JSON.stringify({ skill: name, ...entry })}\n`,
            );
          }
        },
        now,
      });
      spent += result.costUsd;
    }
    results.push(result);
    printResult(io, result);

    if (result.status !== "complete") {
      io.err(`${name}: no score (${result.status}): ${result.reason}`);
      exit = Math.max(exit, command === "compare" ? 2 : 1);
      continue;
    }
    if (command === "baseline") {
      const baseline = toBaseline(result, { date: now().slice(0, 10), noiseFloor, k });
      const path = baselinePath(io.cwd, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
      io.out(`baseline written: ${path}`);
    }
    if (command === "compare") {
      const baseline = readBaseline(io, name);
      if (!baseline) {
        exit = Math.max(exit, 2);
        continue;
      }
      const c = compareToBaseline(baseline, result);
      if (!c.comparable) {
        io.err(`${name}: cannot compare with its baseline: ${c.reasons.join("; ")}`);
        exit = Math.max(exit, 2);
        continue;
      }
      const verdict = c.regressed ? "dropped beyond noise" : "holds";
      io.out(
        `${name}: ${verdict} — ${c.score} vs baseline ${c.baselineScore} (${signed(c.delta ?? 0)}, noise ${c.noise})`,
      );
      if (c.regressed) exit = Math.max(exit, 1);
    }
  }

  const out = flags.get("out");
  if (out) {
    const path = resolve(io.cwd, out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ results }, null, 2)}\n`);
  }
  if (!saved)
    io.out(
      `cost: $${spent.toFixed(4)} (${[...new Set(results.map((r) => r.costSource))].join(", ")})`,
    );
  // For a climb harness: one skill, one number, last line.
  if (command === "run" && results.length === 1 && results[0]?.score !== undefined)
    io.out(String(results[0].score));
  return exit;
}

function printResult(io: CliIo, r: EvalResult): void {
  io.out(
    `## ${r.skill} — ${r.score ?? "no score"} (median of ${r.runScores.length} runs: ${r.runScores.join(", ") || "-"})`,
  );
  io.out(
    `runner ${r.runner.id} · model ${r.runner.model} · ${r.mode} · $${r.costUsd.toFixed(4)} ${r.costSource}`,
  );
  io.out("| scenario | median | runs | failed criteria (runs passed / runs) |");
  io.out("|---|---|---|---|");
  for (const [id, s] of Object.entries(r.scenarios)) {
    const failed = Object.entries(s.passes)
      .filter(([, n]) => n < s.runs.length)
      .map(([c, n]) => `${c} ${n}/${s.runs.length}`)
      .join(", ");
    io.out(`| ${id} | ${s.median ?? "-"} | ${s.runs.join(", ") || "-"} | ${failed || "none"} |`);
  }
}

function list(io: CliIo): number {
  const skills = skillsWithEvals(io.cwd);
  io.out("| skill | scenarios | baseline | produced by | current |");
  io.out("|---|---|---|---|---|");
  for (const name of skills) {
    const scenarios = loadScenarios(io.cwd, name);
    const path = baselinePath(io.cwd, name);
    let score = "missing";
    let by = "-";
    let current = "-";
    if (existsSync(path)) {
      const parsed = baselineSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) {
        const p = parsed.data.producedBy;
        score = String(parsed.data.score);
        by = `${p.runner} · ${p.model} · N=${p.runs} · ${p.mode} · ${p.date}`;
        // A baseline scores one exact text; after an edit it describes a skill that is gone.
        if (parsed.data.skillHash !== loadSkill(io.cwd, name).hash)
          current = "stale: skill changed";
        else if (parsed.data.scenariosHash !== scenarios.hash) current = "stale: scenarios changed";
        else current = "yes";
      } else score = "invalid";
    }
    io.out(`| ${name} | ${scenarios.scenarios.length} | ${score} | ${by} | ${current} |`);
  }
  return 0;
}

export function baselinePath(cwd: string, skill: string): string {
  return join(cwd, "evals", "baselines", `${skill}.json`);
}

function readBaseline(io: CliIo, skill: string): Baseline | undefined {
  const path = baselinePath(io.cwd, skill);
  if (!existsSync(path)) {
    io.err(
      `${skill}: no baseline at ${path}; write one with \`mitchstack evals baseline --skill ${skill}\``,
    );
    return undefined;
  }
  const parsed = baselineSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    io.err(`${path} is not a baseline:`);
    for (const e of toFieldErrors(parsed.error.issues)) io.err(`  ${e.path}: ${e.message}`);
    return undefined;
  }
  return parsed.data;
}

function defaultRunner(spec: { runner: string; model?: string }): AgentRunner {
  if (spec.runner === "claude")
    return claudeRunner({ ...(spec.model ? { model: spec.model } : {}) });
  if (spec.runner === "codex") return codexRunner({ ...(spec.model ? { model: spec.model } : {}) });
  throw new Error(`unknown runner ${spec.runner}: use claude or codex`);
}

function defaultJudges(io: CliIo): Judge[] {
  const path = (io.env ?? process.env).PATH ?? "";
  const judges: Judge[] = [];
  if (onPath("codex", path)) judges.push(judgeFromRunner(codexRunner({})));
  if (onPath("claude", path)) judges.push(judgeFromRunner(claudeRunner({})));
  return judges;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function parseFlags(
  words: string[],
): { ok: true; flags: Map<string, string> } | { ok: false; reason: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    if (!word.startsWith("--")) return { ok: false, reason: `expected a --flag, got "${word}"` };
    const name = word.slice(2);
    if (BOOLEAN.has(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = words[i + 1];
    if (value === undefined || value.startsWith("--"))
      return { ok: false, reason: `--${name} needs a value` };
    flags.set(name, value);
    i += 1;
  }
  return { ok: true, flags };
}

function usage(io: CliIo, reason?: string): number {
  if (reason) io.err(reason);
  io.err(USAGE);
  return 2;
}
