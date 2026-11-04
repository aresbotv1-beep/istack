export type CheckState = "pending" | "success" | "failure" | "skipped" | "neutral";

export interface Conversation {
  id: string;
  kind: "thread" | "comment" | "review";
  author: string;
  url?: string;
  excerpt: string;
  /** Resolved, or the agent has replied in writing after it. */
  answered: boolean;
}

/** Everything the watcher needs about one PR at one moment. Built by an adapter (see gh.ts). */
export interface PrSnapshot {
  number: number;
  url: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  mergeable: "mergeable" | "conflicting" | "unknown";
  checks: Array<{ name: string; state: CheckState }>;
  /** Other people's and bots' threads, comments and reviews. The agent's own are left out. */
  conversations: Conversation[];
  /** "disallowed" = the repo does not allow auto-merge, which counts as off. */
  autoMerge: "on" | "off" | "disallowed";
  mergeQueue: "queued" | "none";
  /** True when a list was longer than one page and was not read in full. */
  truncated: boolean;
}

export interface WatchDecision {
  /** ready: hand the URL to the owner. waiting: nothing to do but wait. blocked: act first. */
  verdict: "ready" | "waiting" | "blocked";
  actions: string[];
  reasons: string[];
  fullStop: { ok: boolean; violations: string[] };
}

/**
 * The full-stop rule: nothing merges without the owner pressing the button. Auto-merge must be
 * off (already off, or not allowed by the repo, is fine) and the PR must not sit in a merge queue.
 * Check it before every push, not only at the end.
 */
export function fullStop(snapshot: PrSnapshot): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (snapshot.autoMerge === "on") violations.push("auto-merge is on");
  if (snapshot.mergeQueue === "queued") violations.push("the PR is in a merge queue");
  return { ok: violations.length === 0, violations };
}

/** Decide what the watcher does next. Pure: the snapshot is the only input. */
export function decide(snapshot: PrSnapshot): WatchDecision {
  const stop = fullStop(snapshot);
  const actions: string[] = [];
  const reasons: string[] = [];

  if (snapshot.state !== "open") {
    return {
      verdict: "blocked",
      actions: [`stop watching: the PR is ${snapshot.state}`],
      reasons: [`PR #${snapshot.number} is ${snapshot.state}`],
      fullStop: stop,
    };
  }
  if (snapshot.autoMerge === "on") {
    actions.push(`disable auto-merge: gh pr merge ${snapshot.number} --disable-auto`);
  }
  if (snapshot.mergeQueue === "queued") {
    actions.push("take the PR out of the merge queue (GraphQL dequeuePullRequest)");
  }
  reasons.push(...stop.violations);

  for (const check of snapshot.checks.filter((c) => c.state === "failure")) {
    actions.push(`fix the failing check: ${check.name}`);
    reasons.push(`${check.name} failed`);
  }
  for (const c of snapshot.conversations.filter((c) => !c.answered)) {
    actions.push(`answer ${c.kind} by ${c.author}: ${c.url ?? c.id}`);
    reasons.push(`${c.kind} by ${c.author} has no written answer`);
  }
  if (snapshot.mergeable === "conflicting") {
    actions.push("rebase onto the base branch and resolve the conflict");
    reasons.push("the PR has a merge conflict");
  }
  if (snapshot.truncated) {
    actions.push(
      "the snapshot was cut at one page; read the rest on GitHub before calling it ready",
    );
    reasons.push("not every comment or check was read");
  }
  if (actions.length > 0) return { verdict: "blocked", actions, reasons, fullStop: stop };

  const pending = snapshot.checks.filter((c) => c.state === "pending").map((c) => c.name);
  if (snapshot.checks.length === 0)
    reasons.push(`no checks have reported on ${snapshot.headSha} yet`);
  if (pending.length > 0) reasons.push(`waiting on ${pending.join(", ")}`);
  if (snapshot.mergeable === "unknown") reasons.push("GitHub has not computed mergeability yet");
  if (reasons.length > 0) return { verdict: "waiting", actions: [], reasons, fullStop: stop };

  return {
    verdict: "ready",
    actions: [`present ${snapshot.url} to the owner; only the owner merges`],
    reasons: ["checks green, every conversation answered, auto-merge off, not queued"],
    fullStop: stop,
  };
}
