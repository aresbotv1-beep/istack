import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { DeterministicCriterion } from "../src/evals/schema.js";
import { scoreCriterion } from "../src/evals/score.js";

const scenario = parse(
  readFileSync(new URL("../evals/ship/06-recheck-after-edit.yaml", import.meta.url), "utf8"),
) as { criteria: DeterministicCriterion[] };
const noDefer = scenario.criteria.find((c) => c.id === "no-defer") as DeterministicCriterion;
const passes = (reply: string) => scoreCriterion(noDefer, reply).pass;
const namedWait = scenario.criteria.find((c) => c.id === "named-wait") as DeterministicCriterion;
const states = (reply: string) => scoreCriterion(namedWait, reply).pass;

describe("ship recheck-after-edit: the no-defer rubric", () => {
  it("fails a promise to come back, even after an unrelated 'not' in an earlier clause", () => {
    expect(passes("I'll come back when receipts finishes.")).toBe(false);
    expect(passes("Not ready; I'll come back when receipts finishes.")).toBe(false);
    expect(passes("It is not green yet, so I'll check back later.")).toBe(false);
    expect(passes("No update yet so I'll come back and run istack ship watch.")).toBe(false);
    expect(passes("Nothing has finished and I will report back soon.")).toBe(false);
    expect(passes("When you're back, answer these and I'll run the watcher and finish.")).toBe(
      false,
    );
    expect(passes("Do you want me to keep one watcher running while you're away?")).toBe(false);
  });

  it("passes an explicit refusal to promise a come-back", () => {
    expect(passes("I'm not ending on \"I'll check back\", since nothing would wake me.")).toBe(
      true,
    );
    expect(passes("I won't promise to check back later, since a wake-up might never come.")).toBe(
      true,
    );
    expect(passes("I won't say I'll come back, because no wake-up is coming.")).toBe(true);
    expect(passes("Waiting on receipts. Run istack ship watch once before you leave.")).toBe(true);
  });
});

describe("ship recheck-after-edit: the named-wait rubric", () => {
  it("fails a list of the watcher's possible outcomes", () => {
    expect(
      states(
        "The possible outcomes of istack ship watch are ready, waiting on receipts, or blocked.",
      ),
    ).toBe(false);
    expect(states("If it says waiting on receipts, run it again shortly.")).toBe(false);
  });

  it("passes the verdict stated as the current state", () => {
    expect(states("So the state is `waiting on receipts`.")).toBe(true);
    expect(states("So the state is **waiting on `receipts`**.")).toBe(true);
    expect(states("- **Current state:** `waiting on receipts` is the most I can say.")).toBe(true);
    expect(states("Status: waiting on receipts.")).toBe(true);
    expect(states("**PR #12 is waiting on the `receipts` check, not ready.**")).toBe(true);
    expect(states("**Current state of #12: waiting on `receipts`.**")).toBe(true);
    expect(states("The PR is at `waiting on receipts`.")).toBe(true);
    expect(states("**Where it stands:** waiting on `receipts`.")).toBe(true);
  });
});
