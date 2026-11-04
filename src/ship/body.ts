import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReceipts } from "../receipts/write.js";
import type { FieldError } from "../result.js";
import type { Ledger } from "../review/ledger.js";
import { renderOpenDisputes, renderReviewerVerdicts } from "../review/markdown.js";

export interface PrBodyInput {
  /** The smallest picture of the change: pseudocode, call tree, file tree, diagram or diff sketch. */
  summary: string;
  evidence: string;
  /** Required: the body is refused without a door. */
  mergeDanger: { door?: "one-way" | "two-way"; blastRadius?: string };
  /** Required: exact steps someone can finish in about 30 seconds. */
  tryItYourself?: string[];
  reviews: Ledger[];
  risks: string[];
  /** Receipts without the door; the door comes from mergeDanger so it is written once. */
  receipts: { head: string; claims: unknown[]; noVisibleChange?: string };
}

export type BodyResult = { ok: true; body: string } | { ok: false; errors: FieldError[] };

const SLOTS = [
  "summary",
  "evidence",
  "mergeDanger",
  "tryItYourself",
  "reviewerVerdicts",
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
 * Render the PR body from the shipped template. Refuses (never throws) when the door or the
 * try-it-yourself steps are missing, or when the receipts would not validate.
 */
export function renderPrBody(input: PrBodyInput, template = loadPrBodyTemplate()): BodyResult {
  const errors: FieldError[] = [];
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

  const values: Record<Slot, string> = {
    summary: input.summary.trim(),
    evidence: input.evidence.trim(),
    mergeDanger: `**Door:** ${DOORS[door]}\n\n**Blast radius:** ${blastRadius}`,
    tryItYourself: steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    reviewerVerdicts: renderReviewerVerdicts(input.reviews),
    openDisputes: renderOpenDisputes(input.reviews),
    risks:
      input.risks.length === 0 ? "None known." : input.risks.map((r) => `- ${r.trim()}`).join("\n"),
    receipts: receiptsBlock,
  };
  // One pass, so a placeholder that appears inside user text is left alone.
  const body = template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    (SLOTS as readonly string[]).includes(name) ? values[name as Slot] : match,
  );
  return { ok: true, body };
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
