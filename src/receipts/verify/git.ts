import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "./exec.js";

/**
 * The git the verified tier needs, through an injected Exec. Every write happens in a detached
 * `git worktree` under the temp dir; the caller's checkout (its HEAD, index and files) is never
 * touched. The only shared state is the worktree's entry in .git/worktrees, removed on cleanup.
 */
export interface Git {
  repo: string;
  exec: Exec;
  timeoutMs: number;
}

export type GitOutcome<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface ChangedFile {
  status: "A" | "M" | "D" | "R" | "C" | "T";
  path: string;
  /** For renames and copies: the path at the base. */
  from?: string;
}

async function git(g: Git, args: string[], cwd = g.repo): Promise<GitOutcome<{ out: string }>> {
  const result = await g.exec("git", args, {
    cwd,
    timeoutMs: g.timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode === 0) return { ok: true, out: result.stdout };
  return { ok: false, error: `git ${args.join(" ")} failed: ${describe(result)}` };
}

function describe(result: ExecResult): string {
  if (result.timedOut) return "timed out";
  if (result.error) return result.error;
  return result.stderr.trim().split("\n")[0] || `exit ${result.exitCode}`;
}

/** The full SHA of a commit-ish, or an error naming a likely shallow clone. */
export async function resolveCommit(g: Git, ref: string): Promise<GitOutcome<{ sha: string }>> {
  const got = await git(g, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!got.ok) {
    return {
      ok: false,
      error: `commit ${ref} is not in ${g.repo}; fetch it (actions/checkout with fetch-depth: 0)`,
    };
  }
  return { ok: true, sha: got.out.trim() };
}

/**
 * The commit the PR's head was built on. The red run happens here, not at the base branch's
 * current tip, so commits that landed on the base after the PR branched can't make a test red.
 */
export async function mergeBase(
  g: Git,
  base: string,
  head: string,
): Promise<GitOutcome<{ sha: string }>> {
  const got = await git(g, ["merge-base", base, head]);
  if (!got.ok) {
    return {
      ok: false,
      error: `no merge base for ${base} and ${head}; fetch full history (fetch-depth: 0)`,
    };
  }
  return { ok: true, sha: got.out.trim() };
}

/** Files the PR changes between the merge base and the head, renames detected. */
export async function changedFiles(
  g: Git,
  from: string,
  to: string,
): Promise<GitOutcome<{ files: ChangedFile[] }>> {
  const got = await git(g, ["diff", "--name-status", "-M", "-z", "--no-color", from, to]);
  if (!got.ok) return got;
  return { ok: true, files: parseNameStatus(got.out) };
}

/** Parse `git diff --name-status -z` output. */
export function parseNameStatus(text: string): ChangedFile[] {
  const words = text.split("\0").filter((word) => word.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < words.length; ) {
    const status = (words[i] ?? "").charAt(0) as ChangedFile["status"];
    if (status === "R" || status === "C") {
      const from = words[i + 1];
      const path = words[i + 2];
      if (from !== undefined && path !== undefined) files.push({ status, path, from });
      i += 3;
    } else {
      const path = words[i + 1];
      if (path !== undefined) files.push({ status, path });
      i += 2;
    }
  }
  return files;
}

export interface Worktree {
  dir: string;
  sha: string;
  remove: () => Promise<void>;
}

/** A detached worktree of `sha` in a fresh temp dir. */
export async function addWorktree(
  g: Git,
  sha: string,
  label: string,
): Promise<GitOutcome<{ worktree: Worktree }>> {
  const parent = mkdtempSync(join(tmpdir(), `mitchstack-verify-${label}-`));
  const dir = join(parent, "tree");
  const added = await git(g, ["worktree", "add", "--detach", "--force", dir, sha]);
  if (!added.ok) {
    rmSync(parent, { recursive: true, force: true });
    return added;
  }
  const remove = async () => {
    await git(g, ["worktree", "remove", "--force", dir]);
    rmSync(parent, { recursive: true, force: true });
    await git(g, ["worktree", "prune"]);
  };
  return { ok: true, worktree: { dir, sha, remove } };
}

/** Bring `paths` at `sha` into a worktree (index and files), leaving everything else as it is. */
export async function checkoutPaths(
  g: Git,
  worktree: string,
  sha: string,
  paths: string[],
): Promise<GitOutcome<object>> {
  if (paths.length === 0) return { ok: true };
  const got = await git(g, ["checkout", sha, "--", ...paths], worktree);
  return got.ok ? { ok: true } : got;
}
