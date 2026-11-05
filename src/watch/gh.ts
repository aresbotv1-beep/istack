import { execFile } from "node:child_process";
import type { CheckState, Conversation, PrSnapshot } from "./decide.js";

export type Exec = (
  file: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The first line of every comment an agent posts. It names the agent, because agents often post
 * from the owner's account; the watcher uses it to tell the agent's answers from the owner's words.
 */
export function agentHeader(agent: string): string {
  return `> **agent: ${agent}** — posted on the owner's behalf`;
}

const AGENT_HEADER = /^\s*>\s*\*\*agent:\s*[^*\n]+\*\*/;

export function isAgentComment(body: string): boolean {
  return AGENT_HEADER.test(body);
}

/** One query for everything the watcher reads. First pages only; `truncated` says when more exist. */
export const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    autoMergeAllowed
    pullRequest(number: $number) {
      number url state mergeable headRefOid
      autoMergeRequest { enabledAt }
      mergeQueueEntry { state }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        }
      } } } } }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes { id isResolved comments(first: 50) { pageInfo { hasNextPage } nodes { author { login } body url } } }
      }
      comments(first: 100) {
        pageInfo { hasNextPage }
        nodes { id author { login } body url createdAt }
      }
      reviews(first: 100) {
        pageInfo { hasNextPage }
        nodes { id author { login } state body url submittedAt }
      }
    }
  }
}`;

export type SnapshotResult = { ok: true; snapshot: PrSnapshot } | { ok: false; error: string };

/** Read one PR through `gh api graphql`. `exec` is injected so tests never reach GitHub. */
export async function ghSnapshot(input: {
  repo: string;
  number: number;
  exec?: Exec;
}): Promise<SnapshotResult> {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(input.repo);
  if (!match) return { ok: false, error: `repo must look like owner/name, got "${input.repo}"` };
  const exec = input.exec ?? execGh;
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${SNAPSHOT_QUERY}`,
    "-F",
    `owner=${match[1]}`,
    "-F",
    `name=${match[2]}`,
    "-F",
    `number=${input.number}`,
  ];
  const result = await exec("gh", args);
  if (result.code !== 0) {
    return { ok: false, error: `gh exited ${result.code}: ${result.stderr.trim()}` };
  }
  let json: Gql;
  try {
    json = JSON.parse(result.stdout) as Gql;
  } catch (error) {
    return { ok: false, error: `gh returned non-JSON: ${(error as Error).message}` };
  }
  if (json.errors?.length) {
    return { ok: false, error: json.errors.map((e) => e.message).join("; ") };
  }
  if (!json.data?.repository?.pullRequest) {
    return { ok: false, error: `no PR #${input.number} in ${input.repo}` };
  }
  return { ok: true, snapshot: snapshotFromGraphql(json) };
}

const execGh: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
    });
  });

interface Page<T> {
  pageInfo?: { hasNextPage: boolean };
  nodes: T[];
}
interface Author {
  author: { login: string } | null;
  body: string;
  url: string;
}
interface Gql {
  errors?: Array<{ message: string }>;
  data?: {
    repository?: {
      autoMergeAllowed: boolean;
      pullRequest?: {
        number: number;
        url: string;
        state: "OPEN" | "CLOSED" | "MERGED";
        mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
        headRefOid: string;
        autoMergeRequest: object | null;
        mergeQueueEntry: object | null;
        commits: Page<{ commit: { statusCheckRollup: { contexts: Page<CheckNode> } | null } }>;
        reviewThreads: Page<{ id: string; isResolved: boolean; comments: Page<Author> }>;
        comments: Page<Author & { id: string; createdAt: string }>;
        reviews: Page<Author & { id: string; state: string; submittedAt: string | null }>;
      };
    };
  };
}
type CheckNode =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
  | { __typename: "StatusContext"; context: string; state: string };

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

function checkState(node: CheckNode): CheckState {
  if (node.__typename === "StatusContext") {
    if (node.state === "SUCCESS") return "success";
    if (node.state === "FAILURE" || node.state === "ERROR") return "failure";
    return "pending";
  }
  if (node.status !== "COMPLETED") return "pending";
  if (node.conclusion === "SUCCESS") return "success";
  if (node.conclusion === "SKIPPED") return "skipped";
  if (node.conclusion === "NEUTRAL") return "neutral";
  if (node.conclusion && FAILED.has(node.conclusion)) return "failure";
  return "pending";
}

/**
 * Pure mapping from the GraphQL response to a snapshot. "Answered" is decided here:
 * a thread is answered when resolved or when its last comment is the agent's; a top-level
 * comment or review is answered when an agent comment comes after it.
 */
export function snapshotFromGraphql(json: unknown): PrSnapshot {
  const repo = (json as Gql).data?.repository;
  const pr = repo?.pullRequest;
  if (!repo || !pr) throw new Error("the GraphQL response has no pull request");
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts ?? { nodes: [] };
  const login = (a: Author) => a.author?.login ?? "ghost";
  const agentTimes = pr.comments.nodes
    .filter((c) => isAgentComment(c.body))
    .map((c) => c.createdAt);
  const answeredAfter = (time: string | null) => time !== null && agentTimes.some((t) => t > time);

  const conversations: Conversation[] = [];
  for (const thread of pr.reviewThreads.nodes) {
    const first = thread.comments.nodes[0];
    const last = thread.comments.nodes.at(-1);
    if (!first || isAgentComment(first.body)) continue;
    conversations.push({
      id: thread.id,
      kind: "thread",
      author: login(first),
      url: last && !isAgentComment(last.body) ? last.url : first.url,
      excerpt: excerpt(first.body),
      answered: thread.isResolved || (last !== undefined && isAgentComment(last.body)),
    });
  }
  for (const comment of pr.comments.nodes) {
    if (isAgentComment(comment.body)) continue;
    conversations.push({
      id: comment.id,
      kind: "comment",
      author: login(comment),
      url: comment.url,
      excerpt: excerpt(comment.body),
      answered: answeredAfter(comment.createdAt),
    });
  }
  for (const review of pr.reviews.nodes) {
    const actionable = review.state === "CHANGES_REQUESTED" || review.body.trim() !== "";
    if (!actionable || isAgentComment(review.body)) continue;
    conversations.push({
      id: review.id,
      kind: "review",
      author: login(review),
      url: review.url,
      excerpt: excerpt(review.body),
      answered: answeredAfter(review.submittedAt),
    });
  }

  // A thread's own comments are a page too: an unread newest reply must not read as answered.
  const pages = [
    contexts,
    pr.reviewThreads,
    pr.comments,
    pr.reviews,
    ...pr.reviewThreads.nodes.map((t) => t.comments),
  ];
  return {
    number: pr.number,
    url: pr.url,
    headSha: pr.headRefOid,
    state: pr.state.toLowerCase() as PrSnapshot["state"],
    mergeable: pr.mergeable.toLowerCase() as PrSnapshot["mergeable"],
    checks: contexts.nodes.map((node) => ({
      name: node.__typename === "CheckRun" ? node.name : node.context,
      state: checkState(node),
    })),
    conversations,
    autoMerge: pr.autoMergeRequest ? "on" : repo.autoMergeAllowed ? "off" : "disallowed",
    mergeQueue: pr.mergeQueueEntry ? "queued" : "none",
    truncated: pages.some((p) => p.pageInfo?.hasNextPage === true),
  };
}

function excerpt(body: string): string {
  const line = body.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
