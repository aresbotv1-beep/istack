import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCouncilScores } from "../council/markdown.js";
import type { CouncilLog } from "../council/schema.js";
import { writeReceipts } from "../receipts/write.js";
import type { FieldError } from "../result.js";
import type { Ledger } from "../review/ledger.js";
import { renderOpenDisputes, renderReviewerLines, renderReviewRounds } from "../review/markdown.js";

export interface PrBodyInput {
  /** Required: one or two plain sentences on what was wrong or missing, for whom. Opens the body. */
  problem?: string;
  /** The smallest picture of the change: pseudocode, call tree, file tree, diagram or diff sketch. */
  summary: string;
  evidence: string;
  /** Required: what the proof does not cover ("Nothing left out." when that is true). */
  notTested?: string;
  /** Required: the body is refused without a door. */
  mergeDanger: { door?: "one-way" | "two-way"; blastRadius?: string };
  /** Required: exact steps someone can finish in about 30 seconds. */
  tryItYourself?: string[];
  reviews: Ledger[];
  /** The council run log (factory profile). Absent: no council block, and scores stay "no score". */
  council?: CouncilLog;
  risks: string[];
  /** Receipts without the door; the door comes from mergeDanger so it is written once. */
  receipts: { head: string; claims: unknown[]; noVisibleChange?: string };
}

export type BodyResult =
  | { ok: true; body: string; visibleChars: number }
  | { ok: false; errors: FieldError[] };

/** A reader should take in the visible body in about a minute; past this the CLI warns. */
export const PR_BODY_VISIBLE_TARGET = 2500;

const SLOTS = [
  "problem",
  "summary",
  "evidence",
  "notTested",
  "mergeDanger",
  "tryItYourself",
  "reviewerVerdicts",
  "reviewLog",
  "openDisputes",
  "risks",
  "receipts",
] as const;
type Slot = (typeof SLOTS)[number];

const DOORS = {
  "one-way": "one-way — hard to undo once merged (data, migrations, public contracts)",
  "two-way": "two-way — a revert undoes it",
} as const;

/**
 * Render the PR body from the shipped template. Refuses (never throws) when the problem, the
 * not-tested line, the door or the try-it-yourself steps are missing, or when the receipts would
 * not validate. The review log, council scores and receipts are folded into <details> blocks.
 */
export function renderPrBody(input: PrBodyInput, template = loadPrBodyTemplate()): BodyResult {
  const errors: FieldError[] = [];
  const problem = input.problem?.trim() ?? "";
  if (problem === "") {
    errors.push({
      path: "problem",
      message: "open with one or two plain sentences: what was wrong or missing, for whom",
    });
  }
  const notTested = input.notTested?.trim() ?? "";
  if (notTested === "") {
    errors.push({
      path: "notTested",
      message: 'say what the proof does not cover, or "Nothing left out."',
    });
  }
  const door = input.mergeDanger?.door;
  const blastRadius = input.mergeDanger?.blastRadius?.trim() ?? "";
  if (door !== "one-way" && door !== "two-way") {
    errors.push({
      path: "mergeDanger.door",
      message: "say whether the door is one-way or two-way",
    });
  }
  if (blastRadius === "") {
    errors.push({
      path: "mergeDanger.blastRadius",
      message: "say what is affected if this is wrong",
    });
  }
  const steps = (input.tryItYourself ?? []).map((s) => s.trim()).filter((s) => s !== "");
  if (steps.length === 0) {
    errors.push({ path: "tryItYourself", message: "give the exact steps to try the change" });
  }
  const missing = SLOTS.filter((slot) => !template.includes(`{{${slot}}}`));
  if (missing.length > 0) {
    errors.push({
      path: "(template)",
      message: `the template is missing ${missing.map((s) => `{{${s}}}`).join(", ")}`,
    });
  }
  let receiptsBlock = "";
  if (door === "one-way" || door === "two-way") {
    const receipts = writeReceipts({ ...input.receipts, door: { kind: door, blastRadius } });
    if (receipts.ok) receiptsBlock = receipts.block;
    else
      errors.push(...receipts.errors.map((e) => ({ ...e, path: withPrefix("receipts", e.path) })));
  }
  if (errors.length > 0 || door === undefined) return { ok: false, errors };

  const disputes = renderOpenDisputes(input.reviews);
  const log = [
    input.reviews.length > 0 ? renderReviewRounds(input.reviews) : "",
    input.council ? renderCouncilScores(input.council) : "",
  ].filter((part) => part !== "");
  const values: Record<Slot, string> = {
    problem,
    summary: input.summary.trim(),
    evidence: input.evidence.trim(),
    notTested,
    mergeDanger: `**Door:** ${DOORS[door]}\n\n**Blast radius:** ${blastRadius}`,
    tryItYourself: steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    reviewerVerdicts: renderReviewerLines(input.reviews),
    reviewLog:
      log.length === 0
        ? ""
        : `<details><summary>Review log</summary>\n\n${log.join("\n\n")}\n\n</details>`,
    openDisputes: disputes === "None." ? "" : `## Open disputes\n\n${disputes}`,
    risks:
      input.risks.length === 0 ? "None known." : input.risks.map((r) => `- ${r.trim()}`).join("\n"),
    receipts: receiptsBlock,
  };
  // An empty slot drops its line, so the body has no empty gap where it would be.
  const shaped = (Object.keys(values) as Slot[])
    .filter((slot) => values[slot] === "")
    .reduce((t, slot) => t.replace(new RegExp(`\\{\\{${slot}\\}\\}\\n*`), ""), template);
  // One pass, so a placeholder that appears inside user text is left alone.
  const body = shaped.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    (SLOTS as readonly string[]).includes(name) ? values[name as Slot] : match,
  );
  return { ok: true, body, visibleChars: visibleLength(body) };
}

/** Characters a reader sees without opening a folded <details> block. */
export function visibleLength(body: string): number {
  return body.replace(/<details>[\s\S]*?<\/details>/g, "").length;
}

function withPrefix(prefix: string, path: string): string {
  return path === "" ? prefix : `${prefix}.${path}`;
}

/** Read templates/pr-body.md from the package root (works from src/ and from dist/). */
export function loadPrBodyTemplate(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "templates", "pr-body.md");
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    dir = dirname(dir);
  }
  throw new Error("templates/pr-body.md not found next to the mitchstack package");
}
