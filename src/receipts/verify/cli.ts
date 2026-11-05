import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parsePullRequestEvent } from "../github.js";
import { renderMarkdown, renderText } from "./report.js";
import { exitCodeFor, type VerifyDeps, type VerifyInput, verifyReceipts } from "./verify.js";

export interface VerifyCliIo {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export const VERIFY_USAGE = [
  "usage: mitchstack receipts verify [--event path | --body file --base sha --head sha]",
  "         [--repo dir] [--setup cmd] [--capture cmd] [--test-glob glob]...",
  "         [--timeout seconds] [--setup-timeout seconds] [--attempts n]",
  "         [--visual lenient|strict] [--shots dir] [--report file.json]",
].join("\n");

/**
 * `args` are the words after `receipts verify`. Exit 0 every checkable claim verified, 1 a claim
 * is contradicted by the re-run, 2 could not verify (timeout, flake, setup, environment) or could
 * not run (bad args, no event, unusable receipts, missing commits).
 */
export async function runVerifyCli(
  args: string[],
  io: VerifyCliIo,
  deps: VerifyDeps = {},
): Promise<number> {
  let flags: ReturnType<typeof parse>;
  try {
    flags = parse(args);
  } catch (error) {
    io.err(`${(error as Error).message}\n${VERIFY_USAGE}`);
    return 2;
  }
  const env = io.env ?? process.env;
  if (env.GITHUB_EVENT_NAME === "pull_request_target") {
    io.err(
      "refusing to run on pull_request_target: it hands fork code a write token; trigger on pull_request",
    );
    return 2;
  }
  const target = readTarget(flags, io.cwd, env);
  if (!target.ok) {
    io.err(`${target.error}\n${VERIFY_USAGE}`);
    return 2;
  }
  const numbers = readNumbers(flags);
  if (!numbers.ok) {
    io.err(`${numbers.error}\n${VERIFY_USAGE}`);
    return 2;
  }
  if (flags.visual !== undefined && flags.visual !== "lenient" && flags.visual !== "strict") {
    io.err(`--visual must be lenient or strict, got "${flags.visual}"\n${VERIFY_USAGE}`);
    return 2;
  }

  const input: VerifyInput = {
    repo: resolve(io.cwd, flags.repo ?? "."),
    ...target.target,
    setup: flags.setup,
    captureScript: flags.capture,
    testGlobs: flags["test-glob"],
    ...numbers.numbers,
    visual: flags.visual as VerifyInput["visual"],
    shotsDir: flags.shots === undefined ? undefined : resolve(io.cwd, flags.shots),
    env,
  };
  const report = await verifyReceipts(input, { log: (line) => io.out(`  … ${line}`), ...deps });
  const code = exitCodeFor(report);
  const print = code === 0 ? io.out : io.err;
  for (const line of renderText(report)) print(line);

  if (flags.report)
    writeFileSync(resolve(io.cwd, flags.report), `${JSON.stringify(report, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  if (env.GITHUB_OUTPUT) {
    const conclusion = report.ok ? report.conclusion : "could-not-run";
    appendFileSync(env.GITHUB_OUTPUT, `conclusion=${conclusion}\n`);
  }
  return code;
}

function parse(args: string[]) {
  return parseArgs({
    args,
    options: {
      event: { type: "string" },
      body: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      repo: { type: "string" },
      setup: { type: "string" },
      capture: { type: "string" },
      "test-glob": { type: "string", multiple: true },
      timeout: { type: "string" },
      "setup-timeout": { type: "string" },
      attempts: { type: "string" },
      visual: { type: "string" },
      shots: { type: "string" },
      report: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }).values;
}

type Flags = ReturnType<typeof parse>;
type Target = Pick<VerifyInput, "body" | "base" | "head">;

/** The PR body and commits: from --body/--base/--head, else the pull_request event. */
function readTarget(
  flags: Flags,
  cwd: string,
  env: Record<string, string | undefined>,
): { ok: true; target: Target } | { ok: false; error: string } {
  if (flags.body !== undefined) {
    if (!flags.base || !flags.head) return { ok: false, error: "--body needs --base and --head" };
    const body = readText(resolve(cwd, flags.body));
    if (!body.ok) return body;
    return { ok: true, target: { body: body.text, base: flags.base, head: flags.head } };
  }
  const path = flags.event ?? env.GITHUB_EVENT_PATH;
  if (!path)
    return {
      ok: false,
      error: "nothing to verify: pass --event, set GITHUB_EVENT_PATH, or give --body/--base/--head",
    };
  const read = readText(resolve(cwd, path));
  if (!read.ok) return read;
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch (error) {
    return { ok: false, error: `event ${path} is not valid JSON: ${(error as Error).message}` };
  }
  const event = parsePullRequestEvent(json);
  if (!event.ok) return event;
  return {
    ok: true,
    target: {
      body: event.pr.body,
      base: flags.base ?? event.pr.baseSha,
      head: flags.head ?? event.pr.headSha,
    },
  };
}

function readNumbers(
  flags: Flags,
):
  | { ok: true; numbers: Pick<VerifyInput, "timeoutMs" | "setupTimeoutMs" | "attempts"> }
  | { ok: false; error: string } {
  const seconds = (name: string, text: string | undefined) => {
    if (text === undefined) return undefined;
    const n = Number(text);
    return Number.isFinite(n) && n > 0
      ? n * 1000
      : new Error(`--${name} must be a positive number of seconds`);
  };
  const timeoutMs = seconds("timeout", flags.timeout);
  const setupTimeoutMs = seconds("setup-timeout", flags["setup-timeout"]);
  const attempts = flags.attempts === undefined ? undefined : Number(flags.attempts);
  if (timeoutMs instanceof Error) return { ok: false, error: timeoutMs.message };
  if (setupTimeoutMs instanceof Error) return { ok: false, error: setupTimeoutMs.message };
  if (attempts !== undefined && !(Number.isInteger(attempts) && attempts >= 1 && attempts <= 5)) {
    return { ok: false, error: "--attempts must be a whole number from 1 to 5" };
  }
  return { ok: true, numbers: { timeoutMs, setupTimeoutMs, attempts } };
}

function readText(path: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    return { ok: false, error: `cannot read ${path}: ${(error as Error).message}` };
  }
}
