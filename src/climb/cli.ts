import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../config/load.js";
import { discoverJudges, execJudge } from "../council/judges.js";
import { type Judge, runCouncil } from "../council/run.js";
import { type CouncilLog, councilLogSchema } from "../council/schema.js";
import { toFieldErrors } from "../result.js";
import { onPath, stagePictures } from "../ship/cli.js";
import type { Exec } from "../watch/gh.js";
import { councilPanel, councilScore, panelGap } from "./council.js";
import {
  type ClimbChange,
  type ClimbHarness,
  DECISION_TSV_HEADER,
  decisionTsvRow,
  orderLadder,
  runClimb,
} from "./engine.js";
import {
  disposeSnapshot,
  type IgnoredSnapshot,
  ignoredDrift,
  type ListIgnored,
  restoreIgnored,
  skippedBy,
  snapshotIgnored,
} from "./ignored.js";

export type ShellExec = (
  command: string,
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ClimbDeps {
  /** Runs plan commands and git through `sh -c`. Defaults to the real shell. */
  shell?: ShellExec;
  /** Builds the council's judges for `climb council-score`. Defaults to the installed CLIs. */
  judges?: (context: { pictureDir: string }) => Judge[];
  /** Runs judge CLIs when `judges` is not given. */
  exec?: Exec;
  now?: () => string;
}

const USAGE = [
  "usage: mitchstack climb ladder --plan <climb.json>",
  "       mitchstack climb run --plan <climb.json> --log <decision.tsv>",
  "       mitchstack climb council-score --after <png> --control <png> --log <council.json>",
  "                                      [--config mitchstack.yaml] [--budget <usd>] [--seed <n>]",
].join("\n");

const move = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, "letters, digits, dot, dash, underscore"),
  /** Shell command that makes the change in the working tree. */
  apply: z.string().min(1),
  expectedGain: z.number(),
  cost: z.number().positive(),
  note: z.string().optional(),
});

export const climbPlanSchema = z.strictObject({
  target: z.number(),
  minAttempts: z.number().int().min(1),
  runs: z.number().int().min(3),
  noiseFloor: z.number().min(0),
  k: z.number().min(0).default(2),
  confirm: z.boolean().default(true),
  /** Prints one score per run on its last line of output; higher is better. */
  harness: z.string().min(1),
  /** Files the harness reads. Any change to them is refused. */
  frozen: z.array(z.string().min(1)).min(1),
  /** Each must exit 0 for a change to be kept. */
  regressions: z.array(z.string().min(1)).default([]),
  /**
   * Git-ignored paths the climb leaves as they are on a revert: where the harness and the climb
   * write their own records (the council log, run counters). Every other ignored file is put
   * back exactly after a rejected move. A move must not write here, and the harness must not read
   * anything here that a move could change.
   */
  scratch: z.array(z.string().min(1)).default([".artifacts/"]),
  /** A change known to make the score worse. The climb refuses to start unless it does. */
  sensitivity: move.pick({ id: true, apply: true }),
  moves: z.array(move),
});
export type ClimbPlan = z.output<typeof climbPlanSchema>;

/**
 * `args` are the words after `climb`. Exit codes: 0 target reached (run) or done, 1 the climb
 * ended short, refused or broken (or a council round gave no score), 2 could not run.
 */
export async function runClimbCli(
  args: string[],
  io: CliIo,
  deps: ClimbDeps = {},
): Promise<number> {
  const [command, ...rest] = args;
  const flags = parseFlags(rest);
  if (!flags.ok) return usage(io, flags.reason);
  if (command === "ladder") return ladder(flags.flags, io);
  if (command === "run") return run(flags.flags, io, deps);
  if (command === "council-score") return councilScoreCommand(flags.flags, io, deps);
  return usage(io);
}

function ladder(flags: Map<string, string>, io: CliIo): number {
  const plan = readPlan(flags, io);
  if (!plan) return 2;
  io.out("| # | move | expected gain | cost | gain per cost |");
  io.out("|---|---|---|---|---|");
  orderLadder(plan.moves).forEach((m, i) => {
    io.out(
      `| ${i + 1} | ${m.id} | ${m.expectedGain} | ${m.cost} | ${round(m.expectedGain / m.cost)} |`,
    );
  });
  io.out(`\ntarget ${plan.target}, at least ${plan.minAttempts} attempts, median of ${plan.runs}`);
  return 0;
}

async function run(flags: Map<string, string>, io: CliIo, deps: ClimbDeps): Promise<number> {
  const plan = readPlan(flags, io);
  if (!plan) return 2;
  const logFlag = flags.get("log");
  if (!logFlag) return usage(io, "run needs --log <decision.tsv>");
  const shell = deps.shell ?? defaultShell;
  const sh = (command: string) => shell(command, io.cwd);

  const status = await sh("git status --porcelain");
  if (status.code !== 0) {
    io.err(`not a git working tree: ${status.stderr.trim()}`);
    return 2;
  }
  if (status.stdout.trim() !== "") {
    io.err(
      "start from a clean tree: the climb reverts every rejected change with git reset --hard",
    );
    return 2;
  }
  const logPath = resolve(io.cwd, logFlag);
  const inside = relative(io.cwd, logPath);
  if (!inside.startsWith("..") && !isAbsolute(inside)) {
    const ignored = await sh(`git check-ignore -q ${quote(inside)}`);
    if (ignored.code !== 0) {
      io.err(`${logFlag} is inside the repo and not git-ignored; put it under .artifacts/`);
      return 2;
    }
  }
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, DECISION_TSV_HEADER);

  // Ignored files survive git reset and git clean, so the climb snapshots them before each move.
  const listIgnored: ListIgnored = async () => {
    const r = await sh("git ls-files -z --others --ignored --exclude-standard");
    if (r.code !== 0) throw new Error(`git ls-files exited ${r.code}: ${r.stderr.trim()}`);
    return r.stdout.split("\0").filter((p) => p !== "");
  };
  const logInRepo = !inside.startsWith("..") && !isAbsolute(inside);
  const skip = skippedBy([...plan.scratch, ...(logInRepo ? [inside] : [])]);
  let ignored: IgnoredSnapshot | undefined;

  // A nested repository under an ignored path is opaque to the snapshot: a move could change the
  // files inside it and the revert would not see it. Refuse before any move runs.
  const preflight = await snapshotIgnored(io.cwd, listIgnored, skip);
  const opaque = [...preflight.entries].filter(([, e]) => e.kind === "opaque").map(([rel]) => rel);
  disposeSnapshot(preflight);
  if (opaque.length > 0) {
    io.err(
      `${opaque.join(", ")}: ignored nested repository the climb cannot restore after a rejected move; list it under scratch in the plan, or remove it, then rerun`,
    );
    return 2;
  }

  const harness: ClimbHarness = {
    measure: async (runs) => {
      const scores: number[] = [];
      for (let i = 0; i < runs; i += 1) {
        const r = await sh(plan.harness);
        const last = r.stdout.trim().split("\n").at(-1)?.trim() ?? "";
        scores.push(r.code === 0 && last !== "" ? Number(last) : Number.NaN);
      }
      return scores;
    },
    regressions: async () => {
      for (const check of plan.regressions) {
        const r = await sh(check);
        if (r.code !== 0) return { green: false, detail: `"${check}" exited ${r.code}` };
      }
      return { green: true, detail: "" };
    },
    fingerprint: async () => {
      const hash = createHash("sha256").update(`harness:${plan.harness}\n`);
      for (const file of frozenFiles(io.cwd, plan.frozen)) {
        const path = resolve(io.cwd, file);
        hash.update(`${file}\n`);
        hash.update(existsSync(path) ? readFileSync(path) : "(missing)");
      }
      return hash.digest("hex");
    },
    restored: async () => {
      const r = await sh("git status --porcelain");
      if (r.code !== 0 || r.stdout.trim() !== "") return false;
      return !ignored || (await ignoredDrift(io.cwd, ignored, listIgnored, skip)).length === 0;
    },
    commit: async (_change, summary) => {
      const r = await sh(`git add -A && git commit -q -m ${quote(summary)}`);
      if (r.code !== 0) throw new Error(`git commit exited ${r.code}: ${r.stderr.trim()}`);
    },
  };
  const toChange = (m: { id: string; apply: string; expectedGain?: number; cost?: number }) =>
    ({
      id: m.id,
      expectedGain: m.expectedGain ?? 0,
      cost: m.cost ?? 1,
      apply: async () => {
        disposeSnapshot(ignored);
        ignored = undefined;
        ignored = await snapshotIgnored(io.cwd, listIgnored, skip);
        const r = await sh(m.apply);
        if (r.code !== 0) throw new Error(`"${m.apply}" exited ${r.code}`);
      },
      revert: async () => {
        const r = await sh("git reset -q --hard HEAD && git clean -qfd");
        if (r.code !== 0) throw new Error(`git reset exited ${r.code}: ${r.stderr.trim()}`);
        if (!ignored) throw new Error("no snapshot of the ignored files was taken before the move");
        await restoreIgnored(io.cwd, ignored, listIgnored, skip);
      },
    }) satisfies ClimbChange;

  let result: Awaited<ReturnType<typeof runClimb>>;
  try {
    result = await runClimb({
      target: plan.target,
      minAttempts: plan.minAttempts,
      runs: plan.runs,
      noiseFloor: plan.noiseFloor,
      k: plan.k,
      confirm: plan.confirm,
      sensitivity: toChange(plan.sensitivity),
      moves: plan.moves.map(toChange),
      harness,
      record: (row) => appendFileSync(logPath, decisionTsvRow(row)),
    });
  } catch (error) {
    io.err(`the climb could not run: ${(error as Error).message}`);
    return 2;
  } finally {
    disposeSnapshot(ignored);
  }
  io.out(`climb ${result.status}: ${result.reason}`);
  io.out(
    `target ${result.target} · start ${result.startMedian ?? "-"} · now ${result.finalMedian ?? "-"} · ${result.attempts} attempts · kept ${result.kept.length ? result.kept.join(", ") : "nothing"}`,
  );
  io.out(`log: ${logPath}`);
  return result.status === "reached" ? 0 : 1;
}

/**
 * One council round over the after picture and the control, printed as one number so a UI climb
 * can use it as its harness. The council never learns the target; a drifted round prints nothing.
 */
async function councilScoreCommand(
  flags: Map<string, string>,
  io: CliIo,
  deps: ClimbDeps,
): Promise<number> {
  const after = flags.get("after");
  const control = flags.get("control");
  const logFlag = flags.get("log");
  if (!after || !control || !logFlag) {
    return usage(io, "council-score needs --after, --control and --log");
  }
  const budget = Number(flags.get("budget") ?? "10");
  if (!(budget > 0)) return usage(io, "--budget is a positive number of dollars");

  let providers: string[] = [];
  const configPath = resolve(io.cwd, flags.get("config") ?? "mitchstack.yaml");
  if (existsSync(configPath)) {
    const loaded = loadConfig(readFileSync(configPath, "utf8"));
    if (!loaded.ok) {
      io.err(`${configPath} is invalid:`);
      for (const e of loaded.errors) io.err(`  ${e.path || "(file)"}: ${e.message}`);
      return 2;
    }
    providers = loaded.config.council.providers;
  }

  const logPath = resolve(io.cwd, logFlag);
  let log: CouncilLog | undefined;
  if (existsSync(logPath)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(logPath, "utf8"));
    } catch (error) {
      io.err(`${logPath} is not valid JSON: ${(error as Error).message}`);
      return 2;
    }
    const parsed = councilLogSchema.safeParse(json);
    if (!parsed.success) {
      io.err(`${logPath} is not a council log:`);
      for (const e of toFieldErrors(parsed.error.issues)) io.err(`  ${e.path}: ${e.message}`);
      return 2;
    }
    log = parsed.data;
  }

  const staged = stagePictures({ after, control }, io.cwd);
  if (!staged.ok) {
    io.err(staged.reason);
    return 2;
  }
  const seed = Number(flags.get("seed") ?? String((log?.rounds.length ?? 0) + 1));
  if (!Number.isInteger(seed)) return usage(io, "--seed is a whole number");

  const judges = (
    deps.judges ??
    ((context) =>
      discoverJudges({
        probe: { hasCommand: (name) => onPath(name, (io.env ?? process.env).PATH ?? "") },
        providers,
        exec: deps.exec ?? execJudge,
        pictureDir: context.pictureDir,
      }))
  )({ pictureDir: staged.dir });

  // A climb measures the same screen again and again on purpose, so every call is a rescore.
  const result = await runCouncil({
    profile: "factory",
    council: { enabled: true, budgetUsdPerPr: budget },
    visibleFiles: ["(climb)"],
    visibleChangedSinceLastRound: ["(climb)"],
    head: "climb",
    pictures: staged.pictures,
    judges,
    log,
    seed,
    now: deps.now,
  });
  if (result.outcome.status === "skipped") {
    io.err(`no score: ${result.outcome.reason}`);
    return 1;
  }
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${JSON.stringify(result.log, null, 2)}\n`);
  const round = result.outcome.round;
  if (round.status !== "kept") {
    io.err(`no score: round ${round.number} ${round.status}: ${result.outcome.reason}`);
    return 1;
  }
  // Every sample of a climb comes from the same judges: the ones that scored first in this log.
  const panel = councilPanel(result.log);
  const missing = panel ? panelGap(round, panel) : [];
  if (missing.length > 0) {
    io.err(
      `no score: round ${round.number}: judge panel changed: ${missing.join(", ")} gave no score; the climb's panel is ${panel?.join(", ")}, and a partial panel is a different instrument`,
    );
    return 1;
  }
  const score = councilScore(round, panel);
  if (score === undefined) {
    io.err(`no score: round ${round.number} ${round.status}: ${result.outcome.reason}`);
    return 1;
  }
  io.out(String(score));
  return 0;
}

function readPlan(flags: Map<string, string>, io: CliIo): ClimbPlan | undefined {
  const from = flags.get("plan");
  if (!from) {
    usage(io, "needs --plan <climb.json>");
    return undefined;
  }
  const path = resolve(io.cwd, from);
  if (!existsSync(path)) {
    io.err(`no file at ${path}`);
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    io.err(`${path} is not valid JSON: ${(error as Error).message}`);
    return undefined;
  }
  const parsed = climbPlanSchema.safeParse(json);
  if (!parsed.success) {
    io.err(`${path} is not a climb plan:`);
    for (const e of toFieldErrors(parsed.error.issues))
      io.err(`  ${e.path || "(file)"}: ${e.message}`);
    return undefined;
  }
  return parsed.data;
}

const defaultShell: ShellExec = async (command, cwd) => {
  const r = spawnSync("sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? r.error?.message ?? "",
  };
};

/** The frozen paths, with directories expanded to every file under them, sorted. */
function frozenFiles(cwd: string, paths: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const stat = statSync(resolve(cwd, rel), { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      for (const name of readdirSync(resolve(cwd, rel))) walk(join(rel, name));
    } else {
      out.push(rel);
    }
  };
  for (const path of paths) walk(path);
  return [...new Set(out)].sort();
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseFlags(
  words: string[],
): { ok: true; flags: Map<string, string> } | { ok: false; reason: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < words.length; i += 2) {
    const name = words[i] as string;
    const value = words[i + 1];
    if (!name.startsWith("--") || value === undefined || value.startsWith("--")) {
      return { ok: false, reason: `expected "--flag value", got "${name}"` };
    }
    flags.set(name.slice(2), value);
  }
  return { ok: true, flags };
}

function usage(io: CliIo, reason?: string): number {
  if (reason) io.err(reason);
  io.err(USAGE);
  return 2;
}
