import type { ClaimStatus, VerifyReport } from "./verify.js";

export const VERIFIED_CHECK = "mitchstack/receipts-verified";

const MARK: Record<ClaimStatus, string> = {
  verified: "verified",
  failed: "FAILED",
  "could-not-verify": "could not verify",
  skipped: "skipped",
};

/** Plain-text lines for the terminal and the job log. */
export function renderText(report: VerifyReport): string[] {
  if (!report.ok) return [`${VERIFIED_CHECK} could not run: ${report.error}`];
  const lines = [`${VERIFIED_CHECK}: ${report.conclusion}`];
  if (report.commits) {
    const { base, mergeBase, head } = report.commits;
    lines.push(`  base ${short(base)} · merge base ${short(mergeBase)} · head ${short(head)}`);
    lines.push(
      `  test files applied at the merge base: ${report.testFiles.length > 0 ? report.testFiles.join(", ") : "none"}`,
    );
  }
  for (const claim of report.claims) {
    lines.push(`  - ${claim.id} (${claim.kind}): ${MARK[claim.status]}`);
    for (const reason of claim.reasons) lines.push(`      ${reason}`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines;
}

/** Markdown for the GitHub job summary. */
export function renderMarkdown(report: VerifyReport): string {
  if (!report.ok) return `## ${VERIFIED_CHECK}: could not run\n\n${report.error}\n`;
  const lines = [`## ${VERIFIED_CHECK}: ${report.conclusion}`, ""];
  if (report.commits) {
    lines.push(
      `Re-ran at merge base \`${short(report.commits.mergeBase)}\` (+ ${report.testFiles.length} PR test file(s)) and head \`${short(report.commits.head)}\`.`,
      "",
    );
  }
  if (report.claims.length > 0) {
    lines.push("| Claim | Kind | Result | Why |", "| --- | --- | --- | --- |");
    for (const c of report.claims) {
      lines.push(
        `| \`${c.id}\` | ${c.kind} | ${MARK[c.status]} | ${c.reasons.map(cell).join("<br>")} |`,
      );
    }
  }
  for (const note of report.notes) lines.push("", `> ${note}`);
  return `${lines.join("\n")}\n`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
