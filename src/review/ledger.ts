import { type Finding, parseReply, type Severity } from "./parse.js";

/** What came back from the reviewer for one round. */
export type ReviewerReply =
  | { kind: "reply"; text: string }
  | { kind: "timeout"; seconds?: number }
  | { kind: "error"; message: string };

/** The builder's answer to one finding, given after the round that raised it. */
export type BuilderOutcome =
  | { kind: "fixed"; note?: string }
  | { kind: "declined"; reason: string }
  | { kind: "disputed"; reason: string };

export interface RoundInput {
  reply: ReviewerReply;
  /** Keyed by finding id; only findings raised in this round can be answered. */
  outcomes?: Record<string, BuilderOutcome>;
}

export interface LedgerRound {
  number: number;
  reply: "answered" | "timeout" | "error" | "unreadable";
  verdict?: "APPROVE" | "CHANGES";
  findings: Finding[];
  notes: string[];
}

export type FindingStatus = "unanswered" | "fixed" | "declined" | "disputed" | "open-dispute";

export interface FindingRecord {
  id: string;
  severity: Severity;
  text: string;
  raisedIn: number[];
  outcomes: Array<{ round: number; outcome: BuilderOutcome }>;
  status: FindingStatus;
}

export interface OpenDispute {
  id: string;
  severity: Severity;
  text: string;
  builderReasons: string[];
}

export interface Ledger {
  reviewer: string;
  budget: number;
  budgetReason: string;
  rounds: LedgerRound[];
  findings: FindingRecord[];
  openDisputes: OpenDispute[];
  state: "reviewing" | "done";
  verdict: "approved" | "not-approved" | "in-progress";
  reason: string;
  /** Rounds handed in after the loop had already ended. They change nothing. */
  ignoredRounds: number;
}

export interface ReviewOptions {
  /** How the reviewer is named in the PR body, e.g. "codex exec (openai)". */
  reviewer: string;
  /** Change tags; security, auth, data, data-loss or concurrency raise the budget to 5. */
  tags?: string[];
}

const RISKY = new Set(["security", "auth", "data", "data-loss", "concurrency"]);
/** A finding the builder disputes this many times goes to the owner instead of round six. */
const DISPUTES_BEFORE_OWNER = 2;

export function reviewBudget(tags: string[] = []): { rounds: number; reason: string } {
  const risky = tags.map((t) => t.toLowerCase()).filter((t) => RISKY.has(t));
  if (risky.length > 0) return { rounds: 5, reason: `5 rounds: tagged ${risky.join(", ")}` };
  return { rounds: 3, reason: "3 rounds (default)" };
}

export function startReview(options: ReviewOptions): Ledger {
  const budget = reviewBudget(options.tags);
  return {
    reviewer: options.reviewer,
    budget: budget.rounds,
    budgetReason: budget.reason,
    rounds: [],
    findings: [],
    openDisputes: [],
    state: "reviewing",
    verdict: "in-progress",
    reason: "no reviewer reply yet",
    ignoredRounds: 0,
  };
}

/** Fold every round into a ledger. Rounds after the loop ends are counted and ignored. */
export function runReview(options: ReviewOptions & { rounds: RoundInput[] }): Ledger {
  return options.rounds.reduce(applyRound, startReview(options));
}

/** One step of the review loop. Pure: returns a new ledger and never mutates its input. */
export function applyRound(previous: Ledger, input: RoundInput): Ledger {
  const ledger = structuredClone(previous);
  if (ledger.state === "done") {
    ledger.ignoredRounds += 1;
    return ledger;
  }
  const number = ledger.rounds.length + 1;
  const reply = input.reply;

  if (reply.kind === "timeout") {
    const after = reply.seconds === undefined ? "" : ` after ${reply.seconds}s`;
    ledger.rounds.push({ number, reply: "timeout", findings: [], notes: [] });
    return finish(
      ledger,
      "not-approved",
      `reviewer timed out in round ${number}${after}; a timeout is not approval`,
    );
  }
  if (reply.kind === "error") {
    ledger.rounds.push({ number, reply: "error", findings: [], notes: [reply.message] });
    return finish(
      ledger,
      "not-approved",
      `reviewer failed in round ${number} (${reply.message}); an error is not approval`,
    );
  }
  const parsed = parseReply(reply.text);
  if (!parsed.ok) {
    ledger.rounds.push({ number, reply: "unreadable", findings: [], notes: [parsed.reason] });
    return finish(
      ledger,
      "not-approved",
      `round ${number}: ${parsed.reason}; an unreadable reply is not approval`,
    );
  }

  const round: LedgerRound = {
    number,
    reply: "answered",
    verdict: parsed.verdict,
    findings: parsed.findings,
    notes: [...parsed.warnings],
  };
  ledger.rounds.push(round);
  for (const finding of parsed.findings) record(ledger, finding, number);
  for (const [id, outcome] of Object.entries(input.outcomes ?? {})) {
    if (!parsed.findings.some((f) => f.id === id)) {
      round.notes.push(`outcome for ${id} ignored: not raised in round ${number}`);
      continue;
    }
    answer(ledger, id, number, outcome);
  }

  const disputed = new Set(ledger.openDisputes.map((d) => d.id));
  const blocking = parsed.findings.filter((f) => f.severity !== "nit" && !disputed.has(f.id));
  const stale = ledger.findings.filter(
    (f) =>
      f.severity !== "nit" &&
      f.status === "unanswered" &&
      !parsed.findings.some((p) => p.id === f.id),
  );
  const nitsOnly = parsed.findings.every((f) => f.severity === "nit");

  if (parsed.verdict === "APPROVE") {
    if (blocking.length === 0 && stale.length === 0) {
      return finish(
        ledger,
        "approved",
        `reviewer said APPROVE in round ${number} with no open blocker or should`,
      );
    }
    const open = [...blocking, ...stale].map((f) => `${f.id} (${f.severity})`).join(", ");
    round.notes.push(`APPROVE ignored: ${open} still open`);
  } else if (nitsOnly) {
    return finish(
      ledger,
      "not-approved",
      `round ${number} returned only nits but said CHANGES, not APPROVE; stopped early`,
    );
  }
  if (number >= ledger.budget) {
    return finish(
      ledger,
      "not-approved",
      `the ${ledger.budget} rounds of review were used up without an APPROVE; running out of rounds is not approval`,
    );
  }
  ledger.reason = `waiting for round ${number + 1} of ${ledger.budget}`;
  return ledger;
}

function finish(ledger: Ledger, verdict: "approved" | "not-approved", reason: string): Ledger {
  ledger.state = "done";
  ledger.verdict = verdict;
  ledger.reason = reason;
  return ledger;
}

function record(ledger: Ledger, finding: Finding, round: number): void {
  const existing = ledger.findings.find((f) => f.id === finding.id);
  if (!existing) {
    ledger.findings.push({ ...finding, raisedIn: [round], outcomes: [], status: "unanswered" });
    return;
  }
  existing.severity = finding.severity;
  existing.text = finding.text;
  existing.raisedIn.push(round);
  const dispute = ledger.openDisputes.find((d) => d.id === finding.id);
  if (dispute) {
    dispute.severity = finding.severity;
    dispute.text = finding.text;
  } else {
    // Raised again: whatever the builder did last time did not satisfy the reviewer.
    existing.status = "unanswered";
  }
}

function answer(ledger: Ledger, id: string, round: number, outcome: BuilderOutcome): void {
  const finding = ledger.findings.find((f) => f.id === id) as FindingRecord;
  finding.outcomes.push({ round, outcome });
  if (finding.status === "open-dispute") return;
  finding.status = outcome.kind;
  if (outcome.kind !== "disputed") return;
  const reasons = finding.outcomes.flatMap(({ outcome: o }) =>
    o.kind === "disputed" ? [o.reason] : [],
  );
  if (reasons.length < DISPUTES_BEFORE_OWNER) return;
  finding.status = "open-dispute";
  ledger.openDisputes.push({
    id,
    severity: finding.severity,
    text: finding.text,
    builderReasons: reasons,
  });
}
