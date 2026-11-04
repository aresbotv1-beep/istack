/**
 * Pure rules for the verified tier. Each takes what CI observed and returns a status with reasons;
 * nothing here runs a process. Three outcomes, never a fourth: verified, failed (the claim is
 * contradicted by a re-run), could-not-verify (CI could not tell: timeout, flake, setup broke,
 * environment differs). A could-not-verify is never a pass.
 */

import type { ExecResult } from "./exec.js";

export type Status = "verified" | "failed" | "could-not-verify";

export interface SideVerdict {
  status: Status;
  reasons: string[];
}

/** One run of a command, reduced to what the rules care about. */
export type RunOutcome =
  | { kind: "exit"; code: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "not-run"; why: string };

/** Shell exit codes for "not executable" and "command not found": the command never ran. */
const SHELL_COULD_NOT_RUN = new Set([126, 127]);

export function toOutcome(result: ExecResult, timeoutMs: number): RunOutcome {
  if (result.timedOut) return { kind: "timeout", afterMs: timeoutMs };
  if (result.error) return { kind: "not-run", why: result.error };
  if (result.exitCode === null)
    return { kind: "not-run", why: `killed by ${result.signal ?? "a signal"}` };
  if (SHELL_COULD_NOT_RUN.has(result.exitCode)) {
    return { kind: "not-run", why: `the shell could not run it (exit ${result.exitCode})` };
  }
  return { kind: "exit", code: result.exitCode };
}

function inconclusive(runs: RunOutcome[], where: string): string | undefined {
  const timeout = runs.find((r) => r.kind === "timeout");
  if (timeout?.kind === "timeout")
    return `timed out at ${where} after ${Math.round(timeout.afterMs / 1000)}s`;
  const notRun = runs.find((r) => r.kind === "not-run");
  if (notRun?.kind === "not-run") return `did not run at ${where}: ${notRun.why}`;
  return undefined;
}

/**
 * The red side: the claimed command, run at the merge base with only the PR's test files applied,
 * must fail on every attempt. Red is the anti-faking direction, so it is strict: one pass at base
 * proves the test was not red; a mix of passes and failures is a flake CI cannot vouch for.
 */
export function decideRed(runs: RunOutcome[], claimedExit: number): SideVerdict {
  const why = inconclusive(runs, "base");
  if (why) return { status: "could-not-verify", reasons: [why] };
  const codes = runs.map((r) => (r.kind === "exit" ? r.code : -1));
  const passes = codes.filter((c) => c === 0).length;
  if (passes === codes.length) {
    return {
      status: "failed",
      reasons: [
        `passes at base (exit 0 on ${passes}/${codes.length} runs) with the PR's test files applied: the claimed red never happened`,
      ],
    };
  }
  if (passes > 0) {
    return {
      status: "could-not-verify",
      reasons: [`flaky at base: passed ${passes}/${codes.length} runs; a red must fail every time`],
    };
  }
  const reasons = [
    `fails at base on ${codes.length}/${codes.length} runs (exit ${codes.join(", ")})`,
  ];
  if (!codes.includes(claimedExit)) {
    reasons.push(`note: the receipts recorded red exit ${claimedExit}; CI saw ${codes.join(", ")}`);
  }
  return { status: "verified", reasons };
}

/**
 * The green side: the claimed command at the head must exit 0. Retried like ordinary CI, up to the
 * attempt budget; a pass on a retry is verified with a flake note, since green is not the side a
 * faker profits from (a test that never passes at head still fails every attempt).
 */
export function decideGreen(runs: RunOutcome[]): SideVerdict {
  const passedAt = runs.findIndex((r) => r.kind === "exit" && r.code === 0);
  if (passedAt === 0) return { status: "verified", reasons: ["passes at head (exit 0)"] };
  if (passedAt > 0) {
    return {
      status: "verified",
      reasons: [
        `passes at head on attempt ${passedAt + 1} of ${runs.length} (flaky: an earlier run failed)`,
      ],
    };
  }
  const why = inconclusive(runs, "head");
  if (why) return { status: "could-not-verify", reasons: [why] };
  const codes = runs.map((r) => (r.kind === "exit" ? r.code : -1));
  return {
    status: "failed",
    reasons: [
      `fails at head on every run (exit ${codes.join(", ")}): the claimed green never happened`,
    ],
  };
}

/** Combine sides: any failure fails the claim; otherwise any doubt makes it could-not-verify. */
export function combine(...sides: SideVerdict[]): SideVerdict {
  const reasons = sides.flatMap((s) => s.reasons);
  if (sides.some((s) => s.status === "failed")) return { status: "failed", reasons };
  if (sides.some((s) => s.status === "could-not-verify"))
    return { status: "could-not-verify", reasons };
  return { status: "verified", reasons };
}

/** One re-capture of a surface: a hash, "the surface does not exist here", or a broken capture. */
export type Shot =
  | { kind: "hash"; sha256: string }
  | { kind: "absent" }
  | { kind: "error"; why: string };

export type VisualMode = "strict" | "lenient";

export interface VisualClaimView {
  surface: string;
  before: "absent" | { sha256: string };
  after: { sha256: string };
}

/**
 * The visual rule. CI re-captures the surface at the merge base and at the head, then:
 *
 * 1. Environment-independent contradictions fail outright: the surface is missing at head; a
 *    claimed `before: "absent"` surface already exists at base; a claimed before picture for a
 *    surface that does not exist at base; base and head render byte-identically (no visible change).
 * 2. Exact match: every claimed hash equals CI's re-capture → verified.
 * 3. Mismatch. Pixel-exact hashes only reproduce in the same rendering environment (OS, fonts,
 *    Chromium build), and CI cannot read the claimed images to compare them perceptually. So:
 *    - if one side matched exactly, the environment is proven the same, and the other side's
 *      mismatch is a real contradiction → failed;
 *    - in `strict` mode (receipts captured in the CI image) any mismatch → failed;
 *    - otherwise → could-not-verify, never verified.
 */
export function decideVisual(
  claim: VisualClaimView,
  base: Shot,
  head: Shot,
  mode: VisualMode,
): SideVerdict {
  const s = claim.surface;
  if (base.kind === "error")
    return { status: "could-not-verify", reasons: [`capture at base failed: ${base.why}`] };
  if (head.kind === "error")
    return { status: "could-not-verify", reasons: [`capture at head failed: ${head.why}`] };
  if (head.kind === "absent")
    return fail(`${s} does not exist at head, but the claim shows an after picture`);

  if (claim.before === "absent") {
    if (base.kind === "hash") {
      return fail(`claimed a brand-new screen (before: "absent"), but ${s} already exists at base`);
    }
    return matchSides(s, [["after", claim.after.sha256, head.sha256]], mode, [
      "new screen: absent at base",
    ]);
  }
  if (base.kind === "absent") {
    return fail(
      `claimed a before picture, but ${s} does not exist at base; use before: "absent" for a new screen`,
    );
  }
  if (base.sha256 === head.sha256) {
    return fail(
      `${s} renders identically at base and head in CI (sha256 ${head.sha256}): no visible change`,
    );
  }
  return matchSides(
    s,
    [
      ["before", claim.before.sha256, base.sha256],
      ["after", claim.after.sha256, head.sha256],
    ],
    mode,
    [],
  );
}

function matchSides(
  surface: string,
  sides: Array<[label: string, claimed: string, seen: string]>,
  mode: VisualMode,
  context: string[],
): SideVerdict {
  const mismatched = sides.filter(([, claimed, seen]) => claimed !== seen);
  if (mismatched.length === 0) {
    return {
      status: "verified",
      reasons: [...context, `re-capture of ${surface} matches the claimed hashes exactly`],
    };
  }
  const detail = mismatched.map(
    ([label, claimed, seen]) =>
      `${label}: claimed ${claimed.slice(0, 12)}…, CI captured ${seen.slice(0, 12)}…`,
  );
  const someMatched = mismatched.length < sides.length;
  if (someMatched) {
    return fail(
      `re-capture contradicts the claim on ${surface} (${detail.join("; ")}); the other side matched exactly, so the environments agree`,
    );
  }
  if (mode === "strict")
    return fail(`re-capture contradicts the claim on ${surface} (${detail.join("; ")})`);
  return {
    status: "could-not-verify",
    reasons: [
      `re-capture of ${surface} differs from the claim (${detail.join("; ")}); exact hashes only reproduce in the same rendering environment, so CI cannot tell a fake from a font difference. Capture receipts in the CI image and use --visual strict`,
    ],
  };
}

function fail(reason: string): SideVerdict {
  return { status: "failed", reasons: [reason] };
}
