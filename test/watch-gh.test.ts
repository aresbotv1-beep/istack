import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decide } from "../src/watch/decide.js";
import {
  agentHeader,
  type Exec,
  ghSnapshot,
  isAgentComment,
  snapshotFromGraphql,
} from "../src/watch/gh.js";

const fixtureText = readFileSync(
  new URL("./fixtures/watch/pr-graphql.json", import.meta.url),
  "utf8",
);
const fixture = () => JSON.parse(fixtureText);

describe("agent author header", () => {
  it("round-trips: a header the kit writes is recognised as an agent comment", () => {
    const header = agentHeader("claude-code");
    expect(header).toBe("> **agent: claude-code** — posted on the owner's behalf");
    expect(isAgentComment(`${header}\n\nFixed in abc1234.`)).toBe(true);
    expect(isAgentComment("Fixed, thanks")).toBe(false);
  });
});

describe("snapshotFromGraphql", () => {
  it("maps checks, conversations, auto-merge and the merge queue", () => {
    const snap = snapshotFromGraphql(fixture());
    expect(snap).toMatchObject({
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      headSha: "abc1234def5678abc1234def5678abc1234def56",
      state: "open",
      mergeable: "mergeable",
      autoMerge: "off",
      mergeQueue: "none",
      truncated: false,
    });
    expect(snap.checks).toEqual([
      { name: "test", state: "success" },
      { name: "lint", state: "pending" },
      { name: "ci/legacy", state: "success" },
    ]);
    const answered = Object.fromEntries(snap.conversations.map((c) => [c.id, c.answered]));
    expect(answered).toEqual({
      T1: true,
      T2: true,
      T3: false,
      IC1: true,
      IC3: false,
      R1: true,
      R3: false,
    });
    expect(snap.conversations.find((c) => c.id === "T3")).toMatchObject({
      kind: "thread",
      author: "review-bot",
      url: "https://github.com/acme/app/pull/7#discussion_r4",
    });
  });

  it("reads auto-merge on, a repo that disallows it, and a queued PR", () => {
    const on = fixture();
    on.data.repository.pullRequest.autoMergeRequest = { enabledAt: "2026-11-04T10:00:00Z" };
    expect(snapshotFromGraphql(on).autoMerge).toBe("on");
    const disallowed = fixture();
    disallowed.data.repository.autoMergeAllowed = false;
    expect(snapshotFromGraphql(disallowed).autoMerge).toBe("disallowed");
    const queued = fixture();
    queued.data.repository.pullRequest.mergeQueueEntry = { state: "QUEUED" };
    expect(snapshotFromGraphql(queued).mergeQueue).toBe("queued");
  });

  it("flags a page it did not read in full", () => {
    const more = fixture();
    more.data.repository.pullRequest.comments.pageInfo.hasNextPage = true;
    expect(snapshotFromGraphql(more).truncated).toBe(true);
  });

  it("maps failing check conclusions to failure", () => {
    const failing = fixture();
    const nodes =
      failing.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes;
    nodes[0].conclusion = "TIMED_OUT";
    nodes[2].state = "ERROR";
    const states = snapshotFromGraphql(failing).checks.map((c) => c.state);
    expect(states).toEqual(["failure", "pending", "failure"]);
  });

  it("feeds decide: the fixture PR is blocked on the open thread and comments", () => {
    const decision = decide(snapshotFromGraphql(fixture()));
    expect(decision.verdict).toBe("blocked");
    expect(decision.actions).toContain(
      "answer thread by review-bot: https://github.com/acme/app/pull/7#discussion_r4",
    );
  });
});

describe("ghSnapshot", () => {
  it("asks gh for one GraphQL query with the repo and PR number", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: Exec = async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: fixtureText, stderr: "" };
    };
    const result = await ghSnapshot({ repo: "acme/app", number: 7, exec });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("gh");
    expect(calls[0]?.args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["-F", "owner=acme", "-F", "name=app", "-F", "number=7"]),
    );
  });

  it("reports gh failures and GraphQL errors instead of guessing", async () => {
    const failed = await ghSnapshot({
      repo: "acme/app",
      number: 7,
      exec: async () => ({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" }),
    });
    expect(failed).toEqual({ ok: false, error: "gh exited 1: HTTP 401: Bad credentials" });
    const errors = await ghSnapshot({
      repo: "acme/app",
      number: 7,
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({ errors: [{ message: "Could not resolve to a PullRequest" }] }),
        stderr: "",
      }),
    });
    expect(errors.ok).toBe(false);
    if (errors.ok) return;
    expect(errors.error).toMatch(/Could not resolve/);
  });

  it("rejects a repo that is not owner/name without calling gh", async () => {
    let called = false;
    const result = await ghSnapshot({
      repo: "acme",
      number: 7,
      exec: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});
