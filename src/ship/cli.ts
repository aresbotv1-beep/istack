import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../config/load.js";
import { discoverJudges, execJudge } from "../council/judges.js";
import { renderCouncilScores } from "../council/markdown.js";
import { type Judge, runCouncil } from "../council/run.js";
import { type CouncilLog, councilLogSchema } from "../council/schema.js";
import { matchVisibleFiles } from "../receipts/check.js";
import { toFieldErrors } from "../result.js";
import { runReview } from "../review/ledger.js";
import { renderOpenDisputes, renderReviewerVerdicts } from "../review/markdown.js";
import { chooseReviewer } from "../review/reviewers.js";
import { reviewInputSchema } from "../review/schema.js";
import { decide } from "../watch/decide.js";
import { type Exec, ghSnapshot } from "../watch/gh.js";
import { renderPrBody } from "./body.js";

export interface ShipDeps {
  /** Runs gh for `ship watch`. Defaults to the real gh on PATH. */
  exec?: Exec;
  /** Builds the council's judges for `ship council`. Defaults to the installed provider CLIs. */
  judges?: (context: { pictureDir: string; prices: Record<string, number> }) => Judge[];
  /** Clock for the council log. */
  now?: () => string;
}

const USAGE = [
  "usage: mitchstack ship reviewer --builder <provider> [--delegate-task <p1,p2>]",
  "       mitchstack ship review --from <review.json> [--format md|json]",
  "       mitchstack ship body --from <body.json>",
  "       mitchstack ship watch --repo <owner/name> --pr <number>",
  "       mitchstack ship council --after <png> --control <png> [--before <png>] --head <sha>",
  "                               --changed <files.txt> --log <council.json>",
  "                               [--changed-since-last <files.txt>] [--door one-way|two-way]",
  "                               [--config mitchstack.yaml] [--seed <n>] [--prices openai=0.2,...]",
].join("\n");

const bodyInputSchema = z.strictObject({
  summary: z.string().min(1),
  evidence: z.string().min(1),
  mergeDanger: z
    .strictObject({ door: z.string().optional(), blastRadius: z.string().optional() })
    .default({}),
  tryItYourself: z.array(z.string()).optional(),
  reviews: z.array(reviewInputSchema).default([]),
  /** Path to the council log written by `ship council`, relative to the working directory. */
  councilLog: z.string().min(1).optional(),
  risks: z.array(z.string()).default([]),
  receipts: z.looseObject({ head: z.string(), claims: z.array(z.unknown()) }),
});

/**
 * `args` are the words after `ship`. Exit codes: 0 ok (approved / ready), 1 refused or not
 * approved / blocked, 2 could not run, 3 waiting (watch only).
 */
export async function runShipCli(args: string[], io: CliIo, deps: ShipDeps = {}): Promise<number> {
  const [command, ...rest] = args;
  const flags = parseFlags(rest);
  if (!flags.ok) return usage(io, flags.reason);
  if (command === "reviewer") return reviewer(flags.flags, io);
  if (command === "review") return review(flags.flags, io);
  if (command === "body") return body(flags.flags, io);
  if (command === "watch") return watch(flags.flags, io, deps);
  if (command === "council") return council(flags.flags, io, deps);
  return usage(io);
}

/**
 * One council round. Scores are measurements, never a gate: every completed decision (kept,
 * discarded, no council, skipped) exits 0. Exit 2 means the council could not run at all.
 */
async function council(flags: Map<string, string>, io: CliIo, deps: ShipDeps): Promise<number> {
  const after = flags.get("after");
  const control = flags.get("control");
  const head = flags.get("head");
  const changedPath = flags.get("changed");
  const logPath = flags.get("log");
  if (!after || !control || !head || !changedPath || !logPath) {
    return usage(io, "council needs --after, --control, --head, --changed and --log");
  }
  const door = flags.get("door");
  if (door !== undefined && door !== "one-way" && door !== "two-way") {
    return usage(io, "--door is one-way or two-way");
  }
  const configPath = resolve(io.cwd, flags.get("config") ?? "mitchstack.yaml");
  if (!existsSync(configPath)) {
    io.err(`no config at ${configPath}: the council needs the profile and council settings`);
    return 2;
  }
  const loaded = loadConfig(readFileSync(configPath, "utf8"));
  if (!loaded.ok) {
    io.err(`${configPath} is invalid:`);
    for (const e of loaded.errors) io.err(`  ${e.path || "(file)"}: ${e.message}`);
    return 2;
  }
  const config = loaded.config;

  const prices = parsePrices(flags.get("prices"));
  if (!prices.ok) return usage(io, prices.reason);

  const lists: Record<string, string[] | undefined> = {};
  for (const name of ["changed", "changed-since-last"]) {
    const value = flags.get(name);
    if (value === undefined) continue;
    const path = resolve(io.cwd, value);
    if (!existsSync(path)) {
      io.err(`no file at ${path}`);
      return 2;
    }
    lists[name] = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }
  const visibleFiles = matchVisibleFiles(lists.changed ?? [], config.visibleChange);
  const since = lists["changed-since-last"];
  const visibleSince = since ? matchVisibleFiles(since, config.visibleChange) : undefined;

  const absoluteLog = resolve(io.cwd, logPath);
  let log: CouncilLog | undefined;
  if (existsSync(absoluteLog)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(absoluteLog, "utf8"));
    } catch (error) {
      io.err(`${absoluteLog} is not valid JSON: ${(error as Error).message}`);
      return 2;
    }
    const parsed = councilLogSchema.safeParse(json);
    if (!parsed.success) {
      io.err(`${absoluteLog} is not a council log:`);
      for (const e of toFieldErrors(parsed.error.issues)) io.err(`  ${e.path}: ${e.message}`);
      return 2;
    }
    log = parsed.data;
  }

  const staged = stagePictures({ before: flags.get("before"), after, control }, io.cwd);
  if (!staged.ok) {
    io.err(staged.reason);
    return 2;
  }

  const seedFlag = flags.get("seed");
  const seed =
    seedFlag !== undefined
      ? Number(seedFlag)
      : (Number.parseInt(head.slice(0, 8), 16) || 0) + (log?.rounds.length ?? 0) + 1;
  if (!Number.isInteger(seed)) return usage(io, "--seed is a whole number");

  const judges = (
    deps.judges ??
    ((context) =>
      discoverJudges({
        probe: { hasCommand: (name) => onPath(name, (io.env ?? process.env).PATH ?? "") },
        providers: config.council.providers,
        prices: context.prices,
        exec: deps.exec ?? execJudge,
        pictureDir: context.pictureDir,
      }))
  )({ pictureDir: staged.dir, prices: prices.prices });

  const result = await runCouncil({
    profile: config.profile,
    council: config.council,
    door,
    visibleFiles,
    visibleChangedSinceLastRound: visibleSince,
    head,
    pictures: staged.pictures,
    judges,
    log,
    seed,
    now: deps.now,
  });

  if (result.outcome.status === "skipped") {
    io.out(`council skipped: ${result.outcome.reason}`);
  } else {
    mkdirSync(dirname(absoluteLog), { recursive: true });
    writeFileSync(absoluteLog, `${JSON.stringify(result.log, null, 2)}\n`);
    io.out(
      `council round ${result.outcome.round.number} ${result.outcome.status}: ${result.outcome.reason}`,
    );
    io.out(`log: ${absoluteLog}`);
  }
  if (result.log.rounds.length > 0) io.out(`\n${renderCouncilScores(result.log)}`);
  return 0;
}

/**
 * Copy each picture to a fresh directory under a name made from its content hash, so nothing a
 * judge can see (file name, folder) says which picture is the before, the after or the control.
 */
export function stagePictures(
  paths: { before?: string; after: string; control: string },
  cwd: string,
):
  | { ok: true; dir: string; pictures: { before?: string; after: string; control: string } }
  | { ok: false; reason: string } {
  const dir = mkdtempSync(join(tmpdir(), "ms-council-"));
  const out: Record<string, string> = {};
  for (const [role, path] of Object.entries(paths)) {
    if (path === undefined) continue;
    const source = resolve(cwd, path);
    if (!existsSync(source)) return { ok: false, reason: `no picture at ${source}` };
    const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
    const target = join(dir, `${hash}${extname(source).toLowerCase() || ".png"}`);
    copyFileSync(source, target);
    out[role] = target;
  }
  return {
    ok: true,
    dir,
    pictures: { before: out.before, after: out.after as string, control: out.control as string },
  };
}

function parsePrices(
  text: string | undefined,
): { ok: true; prices: Record<string, number> } | { ok: false; reason: string } {
  const prices: Record<string, number> = {};
  if (text === undefined) return { ok: true, prices };
  for (const pair of text.split(",").filter(Boolean)) {
    const [provider, value] = pair.split("=");
    const price = Number(value);
    if (!provider || !Number.isFinite(price) || price < 0) {
      return { ok: false, reason: `--prices wants provider=usd pairs, got "${pair}"` };
    }
    prices[provider.trim().toLowerCase()] = price;
  }
  return { ok: true, prices };
}

function reviewer(flags: Map<string, string>, io: CliIo): number {
  const builder = flags.get("builder");
  if (!builder) return usage(io, "reviewer needs --builder <provider>");
  const path = (io.env ?? process.env).PATH ?? "";
  const delegated = flags.get("delegate-task");
  const choice = chooseReviewer({
    builderProvider: builder,
    probe: {
      hasCommand: (name) => onPath(name, path),
      delegateTaskProviders: delegated
        ?.split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    },
  });
  io.out(JSON.stringify(choice, null, 2));
  return 0;
}

function review(flags: Map<string, string>, io: CliIo): number {
  const input = readJson(flags, io, reviewInputSchema);
  if (!input) return 1;
  const ledger = runReview(input);
  if (flags.get("format") === "json") {
    io.out(JSON.stringify(ledger, null, 2));
  } else {
    io.out(
      `## Reviewer verdicts\n\n${renderReviewerVerdicts([ledger])}\n\n## Open disputes\n\n${renderOpenDisputes([ledger])}`,
    );
  }
  return ledger.verdict === "approved" ? 0 : 1;
}

function body(flags: Map<string, string>, io: CliIo): number {
  const input = readJson(flags, io, bodyInputSchema);
  if (!input) return 1;
  let councilLog: CouncilLog | undefined;
  if (input.councilLog !== undefined) {
    const loaded = readJson(new Map([["from", input.councilLog]]), io, councilLogSchema);
    if (!loaded) return 1;
    councilLog = loaded;
  }
  const { councilLog: _path, ...rest } = input;
  const result = renderPrBody({
    ...rest,
    council: councilLog,
    mergeDanger: input.mergeDanger as { door?: "one-way" | "two-way"; blastRadius?: string },
    reviews: input.reviews.map((r) => runReview(r)),
  });
  if (!result.ok) {
    io.err("refusing to render the PR body:");
    for (const e of result.errors) io.err(`  ${e.path || "(input)"}: ${e.message}`);
    return 1;
  }
  io.out(result.body);
  return 0;
}

async function watch(flags: Map<string, string>, io: CliIo, deps: ShipDeps): Promise<number> {
  const repo = flags.get("repo");
  const pr = Number(flags.get("pr"));
  if (!repo || !Number.isInteger(pr) || pr <= 0) {
    return usage(io, "watch needs --repo <owner/name> and --pr <number>");
  }
  const snap = await ghSnapshot({ repo, number: pr, exec: deps.exec });
  if (!snap.ok) {
    io.err(`could not read the PR: ${snap.error}`);
    return 2;
  }
  const decision = decide(snap.snapshot);
  io.out(`${decision.verdict}: ${snap.snapshot.url} at ${snap.snapshot.headSha.slice(0, 12)}`);
  for (const action of decision.actions) io.out(`  action: ${action}`);
  for (const reason of decision.reasons) io.out(`  reason: ${reason}`);
  if (decision.verdict === "ready") return 0;
  return decision.verdict === "waiting" ? 3 : 1;
}

function readJson<T>(flags: Map<string, string>, io: CliIo, schema: z.ZodType<T>): T | undefined {
  const from = flags.get("from");
  if (!from) {
    usage(io, "needs --from <file.json>");
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
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    io.err(`${path} is invalid:`);
    for (const e of toFieldErrors(parsed.error.issues))
      io.err(`  ${e.path || "(file)"}: ${e.message}`);
    return undefined;
  }
  return parsed.data;
}

/** Whether an executable file with this name is on PATH. Looks only; runs nothing. */
export function onPath(name: string, path: string): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      const file = join(dir, name);
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
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
