import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, matchesGlob, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type CaptureResult, capture as realCapture, sha256 } from "../../capture/capture.js";
import { extractReceipts } from "../extract.js";
import type { Receipts } from "../schema.js";
import { type Exec, type ExecResult, outputTail, realExec, runShell, scrubEnv } from "./exec.js";
import {
  addWorktree,
  changedFiles,
  checkoutPaths,
  type Git,
  mergeBase,
  resolveCommit,
  type Worktree,
} from "./git.js";
import {
  combine,
  decideGreen,
  decideRed,
  decideVisual,
  type RunOutcome,
  type Shot,
  type SideVerdict,
  type Status,
  toOutcome,
  type VisualMode,
} from "./verdict.js";

export type ClaimStatus = Status | "skipped";

export interface ClaimVerdict {
  id: string;
  kind: string;
  status: ClaimStatus;
  reasons: string[];
}

export type Conclusion = "pass" | "fail" | "could-not-verify";

export type VerifyReport =
  | {
      ok: true;
      conclusion: Conclusion;
      claims: ClaimVerdict[];
      notes: string[];
      /** The commits CI actually used. Empty when there was nothing to verify. */
      commits: { base: string; mergeBase: string; head: string } | null;
      /** The PR's test files applied at the merge base for the red runs. */
      testFiles: string[];
    }
  | { ok: false; error: string };

export type CaptureFn = (input: { url: string; out: string }) => Promise<CaptureResult>;

export interface VerifyInput {
  /** The repository to verify in; read only — all work happens in temp worktrees. */
  repo: string;
  /** The PR body holding the ```receipts block. */
  body: string;
  /** The PR's base commit (base.sha); the red side runs at its merge base with `head`. */
  base: string;
  /** The PR's head commit. */
  head: string;
  /** Shell command run once in each worktree before any claim (e.g. "npm ci"). */
  setup?: string;
  /**
   * The repo's capture script, run in each worktree per visual claim with ISTACK_SURFACE,
   * ISTACK_CAPTURE_OUT, ISTACK_SIDE (base|head) and ISTACK_CLAIM set. It writes a PNG
   * to ISTACK_CAPTURE_OUT and exits 0, or exits 3 when the surface does not exist at this
   * commit. Without it, only repo-relative file surfaces (e.g. "public/index.html") can be shot.
   */
  captureScript?: string;
  /** Globs for the PR's test files (applied at base for the red run). Default DEFAULT_TEST_GLOBS. */
  testGlobs?: string[];
  /** Per command run or capture. Default 5 minutes. */
  timeoutMs?: number;
  /** For each setup run. Default 15 minutes. */
  setupTimeoutMs?: number;
  /** Red runs this many times (all must fail); green retries up to this many. Default 2. */
  attempts?: number;
  /** How a hash mismatch with no other contradiction is read. Default "lenient". */
  visual?: VisualMode;
  /** Keep the re-captured PNGs here (base-<id>.png, head-<id>.png). Default: a temp dir, removed. */
  shotsDir?: string;
  /** The environment for setup, commands and capture scripts; credentials are scrubbed. */
  env?: Record<string, string | undefined>;
}

export interface VerifyDeps {
  exec?: Exec;
  capture?: CaptureFn;
  log?: (line: string) => void;
}

export const DEFAULT_TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.py",
  "test/**",
  "tests/**",
  "spec/**",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_SETUP_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_ATTEMPTS = 2;
const GIT_TIMEOUT_MS = 2 * 60_000;
/** A capture script's "this surface does not exist at this commit". */
export const SURFACE_ABSENT_EXIT = 3;

type RedGreenClaim = Extract<Receipts["claims"][number], { kind: "red-green" }>;
type VisualClaim = Extract<Receipts["claims"][number], { kind: "visual" }>;

interface Settings {
  setup?: string;
  captureScript?: string;
  timeoutMs: number;
  setupTimeoutMs: number;
  attempts: number;
  visual: VisualMode;
  shotsDir: string;
  env: Record<string, string>;
  exec: Exec;
  capture: CaptureFn;
  log: (line: string) => void;
}

interface SideResult {
  /** Set when setup failed: every claim on this side is could-not-verify. */
  setup: SideVerdict | null;
  /** Set when the red runs could not be prepared (the test files did not apply). */
  redBlocked: SideVerdict | null;
  runs: Map<string, RunOutcome[]>;
  shots: Map<string, Shot>;
}

/**
 * The verified tier: re-run every red→green claim (fails at the merge base with only the PR's test
 * files applied, passes at the head) and re-capture every visual claim at both commits. Returns a
 * per-claim verdict and a conclusion: pass only when every checkable claim is verified. Expected
 * problems come back as `{ ok: false }` (the caller exits 2). Never throws for an expected failure.
 */
export async function verifyReceipts(
  input: VerifyInput,
  deps: VerifyDeps = {},
): Promise<VerifyReport> {
  const extracted = extractReceipts(input.body);
  if (!extracted.ok) {
    if (extracted.reason === "missing") {
      return nothingToVerify([
        "no receipts block in the PR body; the present tier decides whether one is needed",
      ]);
    }
    return {
      ok: false,
      error: `the receipts block is unusable: ${extracted.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join("; ")}`,
    };
  }
  const { claims } = extracted.receipts;
  const redGreen = claims.filter((c): c is RedGreenClaim => c.kind === "red-green");
  const visual = claims.filter((c): c is VisualClaim => c.kind === "visual");
  const skipped: ClaimVerdict[] = claims
    .filter((c) => c.kind === "output")
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      status: "skipped",
      reasons: ["output claims are not re-run by the verified tier"],
    }));
  if (redGreen.length + visual.length === 0) {
    return nothingToVerify(["no red-green or visual claims to re-run"], skipped);
  }

  const exec = deps.exec ?? realExec;
  const git: Git = { repo: input.repo, exec, timeoutMs: GIT_TIMEOUT_MS };
  const base = await resolveCommit(git, input.base);
  if (!base.ok) return base;
  const head = await resolveCommit(git, input.head);
  if (!head.ok) return head;
  const merge = await mergeBase(git, base.sha, head.sha);
  if (!merge.ok) return merge;
  const changed = await changedFiles(git, merge.sha, head.sha);
  if (!changed.ok) return changed;
  const globs =
    input.testGlobs && input.testGlobs.length > 0 ? input.testGlobs : DEFAULT_TEST_GLOBS;
  const testFiles = changed.files
    .filter((f) => f.status !== "D" && globs.some((g) => matchesGlob(f.path, g)))
    .map((f) => f.path);

  const ownShots = input.shotsDir === undefined;
  const shotsDir = input.shotsDir ?? mkdtempSync(join(tmpdir(), "istack-verify-shots-"));
  mkdirSync(shotsDir, { recursive: true });
  const settings: Settings = {
    setup: input.setup,
    captureScript: input.captureScript,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    setupTimeoutMs: input.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
    attempts: Math.max(1, input.attempts ?? DEFAULT_ATTEMPTS),
    visual: input.visual ?? "lenient",
    shotsDir,
    env: scrubEnv({ ...(input.env ?? process.env), CI: "true" }),
    exec,
    capture: deps.capture ?? realCapture,
    log: deps.log ?? (() => undefined),
  };

  try {
    const atBase = await atWorktree(git, merge.sha, "base", settings, async (tree, result) => {
      for (const claim of visual) {
        result.shots.set(claim.id, await shoot(tree, claim, "base", settings));
      }
      settings.log(`applying ${testFiles.length} test file(s) from the head at the merge base`);
      const applied = await checkoutPaths(git, tree.dir, head.sha, testFiles);
      if (!applied.ok) {
        result.redBlocked = {
          status: "could-not-verify",
          reasons: [`could not apply the PR's test files at base: ${applied.error}`],
        };
        return;
      }
      for (const claim of redGreen) {
        const runs: RunOutcome[] = [];
        for (let i = 0; i < settings.attempts; i++)
          runs.push(await runClaim(tree, claim, "base", i, settings));
        result.runs.set(claim.id, runs);
      }
    });
    if (!atBase.ok) return atBase;
    const atHead = await atWorktree(git, head.sha, "head", settings, async (tree, result) => {
      for (const claim of visual)
        result.shots.set(claim.id, await shoot(tree, claim, "head", settings));
      for (const claim of redGreen) {
        const runs: RunOutcome[] = [];
        for (let i = 0; i < settings.attempts; i++) {
          const run = await runClaim(tree, claim, "head", i, settings);
          runs.push(run);
          if (run.kind === "exit" && run.code === 0) break;
        }
        result.runs.set(claim.id, runs);
      }
    });
    if (!atHead.ok) return atHead;

    const verdicts: ClaimVerdict[] = [];
    for (const claim of claims) {
      if (claim.kind === "red-green") {
        const red =
          atBase.result.setup ??
          atBase.result.redBlocked ??
          decideRed(atBase.result.runs.get(claim.id) ?? [], claim.red.exitCode);
        const green = atHead.result.setup ?? decideGreen(atHead.result.runs.get(claim.id) ?? []);
        verdicts.push({ id: claim.id, kind: claim.kind, ...combine(red, green) });
      } else if (claim.kind === "visual") {
        const setup = atBase.result.setup ?? atHead.result.setup;
        const decided =
          setup ??
          decideVisual(
            claim,
            atBase.result.shots.get(claim.id) ?? { kind: "error", why: "not captured" },
            atHead.result.shots.get(claim.id) ?? { kind: "error", why: "not captured" },
            settings.visual,
          );
        verdicts.push({ id: claim.id, kind: claim.kind, ...decided });
      }
    }
    verdicts.push(...skipped);
    const notes: string[] = [];
    if (!head.sha.startsWith(extracted.receipts.head)) {
      notes.push(
        `receipts were made against ${extracted.receipts.head}; re-run at the PR head ${head.sha}`,
      );
    }
    return {
      ok: true,
      conclusion: conclude(verdicts),
      claims: verdicts,
      notes,
      commits: { base: base.sha, mergeBase: merge.sha, head: head.sha },
      testFiles,
    };
  } finally {
    if (ownShots) rmSync(shotsDir, { recursive: true, force: true });
  }
}

/** pass only when nothing failed and nothing was left unverified. */
export function conclude(verdicts: ClaimVerdict[]): Conclusion {
  if (verdicts.some((v) => v.status === "failed")) return "fail";
  if (verdicts.some((v) => v.status === "could-not-verify")) return "could-not-verify";
  return "pass";
}

/** 0 pass, 1 a claim failed, 2 could not verify or could not run (T2's convention). */
export function exitCodeFor(report: VerifyReport): 0 | 1 | 2 {
  if (!report.ok) return 2;
  return report.conclusion === "pass" ? 0 : report.conclusion === "fail" ? 1 : 2;
}

function nothingToVerify(notes: string[], claims: ClaimVerdict[] = []): VerifyReport {
  return { ok: true, conclusion: "pass", claims, notes, commits: null, testFiles: [] };
}

async function atWorktree(
  git: Git,
  sha: string,
  side: "base" | "head",
  settings: Settings,
  work: (tree: Worktree, result: SideResult) => Promise<void>,
): Promise<{ ok: true; result: SideResult } | { ok: false; error: string }> {
  settings.log(`checking out the ${side} (${sha.slice(0, 12)}) in a temp worktree`);
  const added = await addWorktree(git, sha, side);
  if (!added.ok) return added;
  const tree = added.worktree;
  const result: SideResult = { setup: null, redBlocked: null, runs: new Map(), shots: new Map() };
  try {
    if (settings.setup) {
      settings.log(`setup at ${side}: ${settings.setup}`);
      const ran = await runShell(settings.exec, settings.setup, {
        cwd: tree.dir,
        timeoutMs: settings.setupTimeoutMs,
        env: settings.env,
      });
      if (ran.exitCode !== 0) {
        result.setup = {
          status: "could-not-verify",
          reasons: [`setup failed at ${side}: ${describeRun(ran)}`],
        };
        return { ok: true, result };
      }
    }
    await work(tree, result);
    return { ok: true, result };
  } finally {
    await tree.remove();
  }
}

async function runClaim(
  tree: Worktree,
  claim: RedGreenClaim,
  side: "base" | "head",
  attempt: number,
  settings: Settings,
): Promise<RunOutcome> {
  const ran = await runShell(settings.exec, claim.command, {
    cwd: tree.dir,
    timeoutMs: settings.timeoutMs,
    env: settings.env,
  });
  const outcome = toOutcome(ran, settings.timeoutMs);
  settings.log(`${claim.id} at ${side} (run ${attempt + 1}): ${describeOutcome(outcome)}`);
  return outcome;
}

async function shoot(
  tree: Worktree,
  claim: VisualClaim,
  side: "base" | "head",
  settings: Settings,
): Promise<Shot> {
  const out = join(settings.shotsDir, `${side}-${safeName(claim.id)}.png`);
  const shot = settings.captureScript
    ? await shootWithScript(tree, claim, side, out, settings)
    : await shootFile(tree, claim.surface, out, settings);
  settings.log(
    `${claim.id} at ${side}: ${shot.kind === "hash" ? shot.sha256 : shot.kind === "absent" ? "surface absent" : shot.why}`,
  );
  return shot;
}

async function shootWithScript(
  tree: Worktree,
  claim: VisualClaim,
  side: "base" | "head",
  out: string,
  settings: Settings,
): Promise<Shot> {
  rmSync(out, { force: true });
  const ran = await runShell(settings.exec, settings.captureScript as string, {
    cwd: tree.dir,
    timeoutMs: settings.timeoutMs,
    env: {
      ...settings.env,
      ISTACK_SURFACE: claim.surface,
      ISTACK_CAPTURE_OUT: out,
      ISTACK_SIDE: side,
      ISTACK_CLAIM: claim.id,
    },
  });
  if (ran.exitCode === SURFACE_ABSENT_EXIT) return { kind: "absent" };
  if (ran.exitCode !== 0) return { kind: "error", why: `capture script: ${describeRun(ran)}` };
  if (!existsSync(out))
    return { kind: "error", why: `capture script exited 0 but wrote no PNG to ${out}` };
  return { kind: "hash", sha256: sha256(readFileSync(out)) };
}

/** Built-in capture for a repo-relative file surface; anything else needs the repo's script. */
async function shootFile(
  tree: Worktree,
  surface: string,
  out: string,
  settings: Settings,
): Promise<Shot> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(surface) || isAbsolute(surface)) {
    return {
      kind: "error",
      why: `${surface} is not a repo-relative file; give the verifier the repo's capture script (--capture)`,
    };
  }
  const path = resolve(tree.dir, normalize(surface));
  if (!path.startsWith(tree.dir + sep))
    return { kind: "error", why: `${surface} points outside the repo` };
  if (!existsSync(path)) return { kind: "absent" };
  const shot = await settings.capture({ url: pathToFileURL(path).href, out });
  return shot.ok ? { kind: "hash", sha256: shot.sha256 } : { kind: "error", why: shot.reason };
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function describeOutcome(outcome: RunOutcome): string {
  if (outcome.kind === "exit") return `exit ${outcome.code}`;
  if (outcome.kind === "timeout") return `timed out after ${Math.round(outcome.afterMs / 1000)}s`;
  return `did not run: ${outcome.why}`;
}

function describeRun(ran: ExecResult): string {
  if (ran.timedOut) return `timed out after ${Math.round(ran.durationMs / 1000)}s`;
  if (ran.error) return ran.error;
  const tail = outputTail(ran, 3);
  return `exit ${ran.exitCode ?? ran.signal}${tail ? `: ${tail}` : ""}`;
}
