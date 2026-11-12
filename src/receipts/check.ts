import { matchesGlob } from "node:path";
import { loadConfig } from "../config/load.js";
import { DEFAULT_VISIBLE } from "../config/schema.js";
import { type ExtractResult, extractReceipts } from "./extract.js";
import type { Receipts } from "./schema.js";

/** The label a passing PR with receipts carries. The present tier checks shape, not truth. */
export const PRESENT_LABEL = "receipts: present, not verified";

export interface VisibleChange {
  include: string[];
  exclude: string[];
}

export interface CheckInput {
  /** The PR body; receipts live here as one fenced ```receipts JSON block. */
  body: string;
  /** The PR head commit the receipts must have been produced against. */
  headSha: string;
  /** Every path the PR touches (including the old name of a renamed file). */
  changedFiles: string[];
  visibleChange: VisibleChange;
}

export interface CheckResult {
  conclusion: "pass" | "fail";
  /** On fail: every failure. On pass: why it passed. */
  reasons: string[];
  labels: string[];
  /** The changed files that count as a visible change. */
  visibleFiles: string[];
}

/** Changed files that match an include glob and no exclude glob. */
export function matchVisibleFiles(files: string[], visibleChange: VisibleChange): string[] {
  const matches = (file: string, globs: string[]) => globs.some((g) => matchesGlob(file, g));
  return files.filter(
    (file) => matches(file, visibleChange.include) && !matches(file, visibleChange.exclude),
  );
}

/**
 * The visible-change globs from a istack.yaml's text (null = the repo has none). A missing or
 * invalid config falls back to the defaults with a note, so a broken config can't wedge every PR.
 */
export function visibleChangeFromConfig(text: string | null): {
  visibleChange: VisibleChange;
  notes: string[];
} {
  const defaults = { include: [...DEFAULT_VISIBLE], exclude: [] };
  if (text === null) {
    return {
      visibleChange: defaults,
      notes: ["no istack.yaml found; using the default visible-change globs"],
    };
  }
  const loaded = loadConfig(text);
  if (!loaded.ok) {
    const first = loaded.errors[0];
    return {
      visibleChange: defaults,
      notes: [
        `istack.yaml is invalid (${first?.path || "file"}: ${first?.message}); using the default visible-change globs`,
      ],
    };
  }
  return { visibleChange: loaded.config.visibleChange, notes: [] };
}

/** Decide the istack/receipts check for one PR. Pure; never throws. */
export function checkReceipts(input: CheckInput): CheckResult {
  const visibleFiles = matchVisibleFiles(input.changedFiles, input.visibleChange);
  const extracted = extractReceipts(input.body);
  if (!extracted.ok) return withoutReceipts(extracted, visibleFiles);

  const failures = [
    ...staleHead(extracted.receipts, input.headSha),
    ...sameImageTwice(extracted.receipts),
  ];
  const visible = visibleChangeVerdict(extracted.receipts, visibleFiles);
  if (!visible.ok) failures.push(visible.reason);
  if (failures.length > 0)
    return { conclusion: "fail", reasons: failures, labels: [], visibleFiles };
  return { conclusion: "pass", reasons: [visible.reason], labels: [PRESENT_LABEL], visibleFiles };
}

function withoutReceipts(
  extracted: Extract<ExtractResult, { ok: false }>,
  visibleFiles: string[],
): CheckResult {
  if (extracted.reason === "missing" && visibleFiles.length === 0) {
    return {
      conclusion: "pass",
      reasons: ["no receipts needed: no visible change and no receipts block"],
      labels: [],
      visibleFiles,
    };
  }
  const reasons =
    extracted.reason === "missing"
      ? [
          `visible change in ${describeFiles(visibleFiles)} but the PR body has no \`\`\`receipts block`,
        ]
      : extracted.errors.map((e) => (e.path ? `receipts.${e.path}: ${e.message}` : e.message));
  return { conclusion: "fail", reasons, labels: [], visibleFiles };
}

function staleHead(receipts: Receipts, headSha: string): string[] {
  if (headSha.toLowerCase().startsWith(receipts.head)) return [];
  return [
    `receipts are stale: they were made against ${receipts.head}, but the PR head is ${headSha}; re-prove at the head and update the block`,
  ];
}

function sameImageTwice(receipts: Receipts): string[] {
  return receipts.claims.flatMap((claim) =>
    claim.kind === "visual" &&
    claim.before !== "absent" &&
    claim.before.sha256 === claim.after.sha256
      ? [`claim ${claim.id}: before and after are the same image (sha256 ${claim.after.sha256})`]
      : [],
  );
}

function visibleChangeVerdict(
  receipts: Receipts,
  visibleFiles: string[],
): { ok: boolean; reason: string } {
  if (visibleFiles.length === 0) {
    return { ok: true, reason: "receipts present; no visible change in this PR" };
  }
  if (receipts.noVisibleChange) {
    return { ok: true, reason: `no visible change: ${receipts.noVisibleChange}` };
  }
  const pairs = receipts.claims.filter(
    (c) => c.kind === "visual" && (c.before === "absent" || c.before.sha256 !== c.after.sha256),
  );
  if (pairs.length > 0) {
    return { ok: true, reason: `before/after pair: ${pairs.map((c) => c.id).join(", ")}` };
  }
  return {
    ok: false,
    reason: `visible change in ${describeFiles(visibleFiles)} needs a visual claim whose before/after images differ (before: "absent" for a brand-new screen), or a noVisibleChange reason`,
  };
}

function describeFiles(files: string[]): string {
  const shown = files.slice(0, 5).join(", ");
  return files.length > 5 ? `${shown} and ${files.length - 5} more` : shown;
}
