import type { BuilderOutcome, FindingRecord, Ledger, LedgerRound } from "./ledger.js";

/**
 * The "Reviewer verdicts" section body. Every reviewer is listed, the unhappy ones included.
 * The review loop produces no score; the score column says "no score" until a council
 * measures one. Only an approved ledger is ever called approved.
 */
export function renderReviewerVerdicts(ledgers: Ledger[]): string {
  if (ledgers.length === 0) return "No reviewer ran. **not approved**.";
  return [
    "| Reviewer | Verdict | Rounds | Score | Why |",
    "|---|---|---|---|---|",
    ...ledgers.map(
      (l) =>
        `| ${cell(l.reviewer)} | ${verdictText(l)} | ${l.rounds.length} of ${l.budget} | no score | ${cell(l.reason)} |`,
    ),
    "",
    renderReviewRounds(ledgers),
  ].join("\n");
}

/**
 * One line per reviewer for the PR body: its real verdict (bold when not approved), the rounds
 * used and "no score". The rounds themselves go in the folded review log.
 */
export function renderReviewerLines(ledgers: Ledger[]): string {
  if (ledgers.length === 0) return "No reviewer ran. **not approved**.";
  return ledgers
    .map(
      (l) =>
        `- **${l.reviewer.replaceAll("\n", " ")}**: ${verdictText(l)}, ${l.rounds.length} of ${l.budget} rounds, no score. ${sentence(l.reason)}`,
    )
    .join("\n");
}

/** Each reviewer's rounds and findings table: the detail behind the verdict lines. */
export function renderReviewRounds(ledgers: Ledger[]): string {
  const lines: string[] = [];
  for (const ledger of ledgers) {
    if (lines.length > 0) lines.push("");
    lines.push(`**${ledger.reviewer}**, round by round; budget ${ledger.budgetReason}:`, "");
    for (const round of ledger.rounds) lines.push(`- ${roundText(round)}`);
    if (ledger.rounds.length === 0) lines.push("- no reply yet");
    if (ledger.findings.length > 0) {
      lines.push("", "| Id | Severity | Raised in | Outcome |", "|---|---|---|---|");
      for (const f of ledger.findings) {
        lines.push(`| ${f.id} | ${f.severity} | ${f.raisedIn.join(", ")} | ${outcomeText(f)} |`);
      }
    }
  }
  return lines.join("\n");
}

/** The "Open disputes" section body: findings disputed twice, left for the owner at the merge. */
export function renderOpenDisputes(ledgers: Ledger[]): string {
  const items = ledgers.flatMap((ledger) =>
    ledger.openDisputes.map(
      (d) =>
        `- **${d.id}** (${d.severity}, ${ledger.reviewer}): ${d.text}. Builder: ${d.builderReasons.join("; ")}. Still disputed after two replies; the owner decides.`,
    ),
  );
  return items.length === 0 ? "None." : items.join("\n");
}

function verdictText(ledger: Ledger): string {
  if (ledger.verdict === "approved") return "approved";
  if (ledger.verdict === "in-progress") return "**not approved** (review unfinished)";
  return "**not approved**";
}

function roundText(round: LedgerRound): string {
  const head = `Round ${round.number}: `;
  const notes = round.notes.length > 0 ? ` (${round.notes.join("; ")})` : "";
  if (round.reply === "timeout") return `${head}timed out, no reply${notes}`;
  if (round.reply === "error") return `${head}reviewer failed${notes}`;
  if (round.reply === "unreadable") return `${head}reply could not be read${notes}`;
  const counts = (["blocker", "should", "nit"] as const)
    .map((s) => [s, round.findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  const findings = counts.length > 0 ? counts.join(", ") : "no findings";
  return `${head}VERDICT: ${round.verdict}, ${findings}${notes}`;
}

function outcomeText(finding: FindingRecord): string {
  const last = finding.outcomes.at(-1)?.outcome;
  if (finding.status === "open-dispute") return "open dispute";
  if (finding.status === "unanswered" || !last) return "**unanswered**";
  return cell(describe(last));
}

function describe(outcome: BuilderOutcome): string {
  if (outcome.kind === "fixed") return outcome.note ? `fixed: ${outcome.note}` : "fixed";
  if (outcome.kind === "declined") return `declined: ${outcome.reason}`;
  return `disputed: ${outcome.reason}`;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function sentence(text: string): string {
  const flat = text.replaceAll("\n", " ").trim();
  return flat.charAt(0).toUpperCase() + flat.slice(1);
}
