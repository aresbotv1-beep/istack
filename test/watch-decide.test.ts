import { describe, expect, it } from "vitest";
import { decide, fullStop, type PrSnapshot } from "../src/watch/decide.js";

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    headSha: "abc1234",
    state: "open",
    mergeable: "mergeable",
    checks: [
      { name: "test", state: "success" },
      { name: "istack/receipts", state: "success" },
    ],
    conversations: [],
    autoMerge: "off",
    mergeQueue: "none",
    truncated: false,
    ...overrides,
  };
}

describe("fullStop", () => {
  it("is fine when auto-merge is already off or the repo disallows it", () => {
    expect(fullStop(snapshot({ autoMerge: "off" })).ok).toBe(true);
    expect(fullStop(snapshot({ autoMerge: "disallowed" })).ok).toBe(true);
  });

  it("is violated by auto-merge on or a merge-queue entry", () => {
    const stop = fullStop(snapshot({ autoMerge: "on", mergeQueue: "queued" }));
    expect(stop.ok).toBe(false);
    expect(stop.violations).toHaveLength(2);
  });
});

describe("decide", () => {
  it("is ready when checks pass, every conversation is answered and full stop holds", () => {
    const decision = decide(
      snapshot({
        conversations: [
          { id: "t1", kind: "thread", author: "rev-bot", excerpt: "S1", answered: true },
        ],
      }),
    );
    expect(decision.verdict).toBe("ready");
    expect(decision.actions).toEqual([
      "present https://github.com/acme/app/pull/7 to the owner; only the owner merges",
    ]);
  });

  it("waits on pending checks with nothing else to do", () => {
    const decision = decide(snapshot({ checks: [{ name: "test", state: "pending" }] }));
    expect(decision.verdict).toBe("waiting");
    expect(decision.reasons.join(" ")).toMatch(/test/);
  });

  it("waits when no checks have reported yet", () => {
    expect(decide(snapshot({ checks: [] })).verdict).toBe("waiting");
  });

  it("blocks on a failing check", () => {
    const decision = decide(snapshot({ checks: [{ name: "lint", state: "failure" }] }));
    expect(decision.verdict).toBe("blocked");
    expect(decision.actions).toContain("fix the failing check: lint");
  });

  it("blocks on an unanswered comment, naming who and where", () => {
    const decision = decide(
      snapshot({
        conversations: [
          {
            id: "c9",
            kind: "comment",
            author: "teammate",
            url: "https://github.com/acme/app/pull/7#issuecomment-9",
            excerpt: "why not reuse the helper?",
            answered: false,
          },
        ],
      }),
    );
    expect(decision.verdict).toBe("blocked");
    expect(decision.actions).toContain(
      "answer comment by teammate: https://github.com/acme/app/pull/7#issuecomment-9",
    );
  });

  it("blocks and asks to disable auto-merge, even when everything else is green", () => {
    const decision = decide(snapshot({ autoMerge: "on" }));
    expect(decision.verdict).toBe("blocked");
    expect(decision.actions).toContain("disable auto-merge: gh pr merge 7 --disable-auto");
    expect(decision.fullStop.ok).toBe(false);
  });

  it("blocks and asks to leave the merge queue", () => {
    const decision = decide(snapshot({ mergeQueue: "queued" }));
    expect(decision.verdict).toBe("blocked");
    expect(decision.actions.join(" ")).toMatch(/merge queue/);
  });

  it("blocks on a merge conflict", () => {
    const decision = decide(snapshot({ mergeable: "conflicting" }));
    expect(decision.verdict).toBe("blocked");
    expect(decision.actions.join(" ")).toMatch(/rebase/);
  });

  it("is never ready on a truncated snapshot", () => {
    const decision = decide(snapshot({ truncated: true }));
    expect(decision.verdict).toBe("blocked");
    expect(decision.actions.join(" ")).toMatch(/read the rest/);
  });

  it("stops watching a closed or merged PR", () => {
    for (const state of ["closed", "merged"] as const) {
      const decision = decide(snapshot({ state }));
      expect(decision.verdict).toBe("blocked");
      expect(decision.actions.join(" ")).toMatch(/stop watching/);
    }
  });
});
