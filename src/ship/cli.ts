import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { z } from "zod";
import type { CliIo } from "../cli.js";
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
}

const USAGE = [
  "usage: mitchstack ship reviewer --builder <provider> [--delegate-task <p1,p2>]",
  "       mitchstack ship review --from <review.json> [--format md|json]",
  "       mitchstack ship body --from <body.json>",
  "       mitchstack ship watch --repo <owner/name> --pr <number>",
].join("\n");

const bodyInputSchema = z.strictObject({
  summary: z.string().min(1),
  evidence: z.string().min(1),
  mergeDanger: z
    .strictObject({ door: z.string().optional(), blastRadius: z.string().optional() })
    .default({}),
  tryItYourself: z.array(z.string()).optional(),
  reviews: z.array(reviewInputSchema).default([]),
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
  return usage(io);
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
  const result = renderPrBody({
    ...input,
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
function onPath(name: string, path: string): boolean {
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
