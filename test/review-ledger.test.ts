import { describe, expect, it } from "vitest";
import {
  applyRound,
  type RoundInput,
  reviewBudget,
  runReview,
  startReview,
} from "../src/review/ledger.js";
import { renderOpenDisputes, renderReviewerVerdicts } from "../src/review/markdown.js";

const reviewer = "codex exec (openai)";
const reply = (text: string): RoundInput["reply"] => ({ kind: "reply", text });

describe("reviewBudget", () => {
  it("gives 3 rounds by default and 5 for risky tags", () => {
    expect(reviewBudget([]).rounds).toBe(3);
    expect(reviewBudget(["docs"]).rounds).toBe(3);
    for (const tag of ["security", "auth", "data-loss", "data", "concurrency", "Security"]) {
      expect(reviewBudget([tag]).rounds).toBe(5);
    }
    expect(reviewBudget(["auth"]).reason).toMatch(/auth/);
  });
});

describe("review ledger", () => {
  it("approves only on an explicit APPROVE", () => {
    const ledger = runReview({ reviewer, rounds: [{ reply: reply("VERDICT: APPROVE") }] });
    expect(ledger.verdict).toBe("approved");
    expect(ledger.state).toBe("done");
    expect(ledger.rounds).toHaveLength(1);
  });

  it("treats a timeout as not approved, with the reason", () => {
    const ledger = runReview({
      reviewer,
      rounds: [
        {
          reply: reply("VERDICT: CHANGES\nS1 [blocker] crashes on empty input"),
          outcomes: { S1: { kind: "fixed" } },
        },
        { reply: { kind: "timeout", seconds: 600 } },
      ],
    });
    expect(ledger.verdict).toBe("not-approved");
    expect(ledger.state).toBe("done");
    expect(ledger.reason).toMatch(/timed out in round 2/);
    expect(ledger.reason).toMatch(/not approval/);
    expect(ledger.rounds[1]?.reply).toBe("timeout");
  });

  it("treats a reviewer error and an unreadable reply as not approved", () => {
    const failed = runReview({
      reviewer,
      rounds: [{ reply: { kind: "error", message: "exit 1" } }],
    });
    expect(failed.verdict).toBe("not-approved");
    expect(failed.reason).toMatch(/exit 1/);
    const unreadable = runReview({ reviewer, rounds: [{ reply: reply("LGTM ship it") }] });
    expect(unreadable.verdict).toBe("not-approved");
    expect(unreadable.reason).toMatch(/VERDICT/);
  });

  it("does not approve an APPROVE that still lists a blocker or should", () => {
    const ledger = runReview({
      reviewer,
      rounds: [{ reply: reply("VERDICT: APPROVE\nS1 [should] leaks a file handle") }],
    });
    expect(ledger.verdict).toBe("in-progress");
    expect(ledger.state).toBe("reviewing");
    expect(ledger.rounds[0]?.notes.join(" ")).toMatch(/APPROVE ignored.*S1/);
  });

  it("does not approve while an earlier blocker was never answered", () => {
    const ledger = runReview({
      reviewer,
      rounds: [
        { reply: reply("VERDICT: CHANGES\nS1 [blocker] wrong total") },
        { reply: reply("VERDICT: APPROVE") },
      ],
    });
    expect(ledger.verdict).not.toBe("approved");
    expect(ledger.findings.find((f) => f.id === "S1")?.status).toBe("unanswered");
  });

  it("stops early on a nits-only round; without APPROVE it is not approved", () => {
    const ledger = runReview({
      reviewer,
      rounds: [
        { reply: reply("VERDICT: CHANGES\nS1 [nit] typo") },
        { reply: reply("VERDICT: APPROVE") },
      ],
    });
    expect(ledger.state).toBe("done");
    expect(ledger.verdict).toBe("not-approved");
    expect(ledger.reason).toMatch(/only nits/);
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.ignoredRounds).toBe(1);
  });

  it("approves a nits-only round that says APPROVE", () => {
    const ledger = runReview({
      reviewer,
      rounds: [{ reply: reply("VERDICT: APPROVE\nS1 [nit] typo") }],
    });
    expect(ledger.verdict).toBe("approved");
  });

  it("runs out of budget after 3 rounds without approving", () => {
    const changes = {
      reply: reply("VERDICT: CHANGES\nS1 [should] still wrong"),
      outcomes: { S1: { kind: "fixed" as const } },
    };
    const ledger = runReview({ reviewer, rounds: [changes, changes, changes, changes] });
    expect(ledger.budget).toBe(3);
    expect(ledger.rounds).toHaveLength(3);
    expect(ledger.verdict).toBe("not-approved");
    expect(ledger.reason).toMatch(/3 rounds/);
    expect(ledger.ignoredRounds).toBe(1);
  });

  it("allows 5 rounds for a security change", () => {
    const changes = {
      reply: reply("VERDICT: CHANGES\nS1 [should] still wrong"),
      outcomes: { S1: { kind: "fixed" as const } },
    };
    const ledger = runReview({
      reviewer,
      tags: ["security"],
      rounds: [changes, changes, changes, changes, { reply: reply("VERDICT: APPROVE") }],
    });
    expect(ledger.budget).toBe(5);
    expect(ledger.verdict).toBe("approved");
  });

  it("moves an item disputed twice to open disputes without stopping the loop", () => {
    const ledger = runReview({
      reviewer,
      rounds: [
        {
          reply: reply("VERDICT: CHANGES\nS1 [should] use a mutex here\nS2 [blocker] off by one"),
          outcomes: {
            S1: { kind: "disputed", reason: "single-threaded; no shared state" },
            S2: { kind: "fixed" },
          },
        },
        {
          reply: reply("VERDICT: CHANGES\nS1 [should] still want the mutex"),
          outcomes: { S1: { kind: "disputed", reason: "the worker pool is size 1 by config" } },
        },
        { reply: reply("VERDICT: APPROVE\nS1 [should] still want the mutex") },
      ],
    });
    expect(ledger.openDisputes).toEqual([
      {
        id: "S1",
        severity: "should",
        text: "still want the mutex",
        builderReasons: ["single-threaded; no shared state", "the worker pool is size 1 by config"],
      },
    ]);
    expect(ledger.rounds).toHaveLength(3);
    expect(ledger.verdict).toBe("approved");
    expect(ledger.findings.find((f) => f.id === "S1")?.status).toBe("open-dispute");
  });

  it("is a pure step function: applyRound never mutates its input", () => {
    const start = startReview({ reviewer });
    const frozen = JSON.stringify(start);
    const next = applyRound(start, { reply: reply("VERDICT: APPROVE") });
    expect(JSON.stringify(start)).toBe(frozen);
    expect(next.verdict).toBe("approved");
    expect(start.verdict).toBe("in-progress");
    expect(start.reason).toMatch(/no reviewer reply yet/);
  });

  it("records declined findings with their reason", () => {
    const ledger = runReview({
      reviewer,
      rounds: [
        {
          reply: reply("VERDICT: CHANGES\nS1 [should] add caching"),
          outcomes: { S1: { kind: "declined", reason: "out of scope; follow-up ticket" } },
        },
        { reply: reply("VERDICT: APPROVE") },
      ],
    });
    expect(ledger.verdict).toBe("approved");
    expect(ledger.findings[0]).toMatchObject({ id: "S1", status: "declined" });
  });
});

describe("reviewer verdicts markdown", () => {
  it("says not approved for a timeout and never invents a score", () => {
    const ledger = runReview({ reviewer, rounds: [{ reply: { kind: "timeout", seconds: 600 } }] });
    const md = renderReviewerVerdicts([ledger]);
    expect(md).toContain("**not approved**");
    expect(md.replaceAll("not approved", "")).not.toMatch(/\bapproved\b/);
    expect(md).toContain("no score");
    expect(md).toContain("timed out");
    expect(md).toContain(reviewer);
  });

  it("says approved for an approval, with the findings table", () => {
    const ledger = runReview({
      reviewer,
      rounds: [
        {
          reply: reply("VERDICT: CHANGES\nS1 [blocker] off by one"),
          outcomes: { S1: { kind: "fixed" } },
        },
        { reply: reply("VERDICT: APPROVE") },
      ],
    });
    const md = renderReviewerVerdicts([ledger]);
    expect(md).toMatch(/\| approved \|/);
    expect(md).toMatch(/\| S1 \| blocker \| 1 \| fixed \|/);
  });

  it("says plainly when no reviewer ran", () => {
    expect(renderReviewerVerdicts([])).toMatch(/No reviewer ran.*not approved/s);
  });

  it("lists open disputes, or says none", () => {
    expect(renderOpenDisputes([])).toBe("None.");
    const ledger = runReview({
      reviewer,
      rounds: [
        {
          reply: reply("VERDICT: CHANGES\nS1 [should] x"),
          outcomes: { S1: { kind: "disputed", reason: "a" } },
        },
        {
          reply: reply("VERDICT: CHANGES\nS1 [should] x"),
          outcomes: { S1: { kind: "disputed", reason: "b" } },
        },
      ],
    });
    const md = renderOpenDisputes([ledger]);
    expect(md).toContain("**S1**");
    expect(md).toContain(reviewer);
    expect(md).toContain("a; b");
  });
});
