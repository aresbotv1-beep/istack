import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all (e.g. ENOENT). */
  error?: string;
}

/** Runs a program without a shell. Injected so tests can stand in for git, lsof or npm. */
export type Exec = (cmd: string, args: string[], opts: { cwd: string }) => ExecResult;

export const realExec: Exec = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ...(r.error ? { error: r.error.message } : {}),
  };
};

/** realpath when the path exists, the path unchanged otherwise. */
export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface WorktreeInfo {
  /** This checkout's top level. */
  root: string;
  /** The main checkout (first entry of `git worktree list`). */
  mainRoot: string;
  /** Every checkout of the repo, main included. */
  worktrees: string[];
  /** The git dir shared by all worktrees; the port registry lives here. */
  commonDir: string;
}

export type WorktreeResult = { ok: true; info: WorktreeInfo } | { ok: false; reason: string };

export function resolveWorktree(cwd: string, exec: Exec): WorktreeResult {
  const top = exec("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd });
  if (top.code !== 0) return { ok: false, reason: `not inside a git checkout: ${cwd}` };
  const [rootLine, commonLine] = top.stdout.trim().split("\n");
  const root = canonical(rootLine as string);
  const common = commonLine as string;
  const commonDir = canonical(isAbsolute(common) ? common : resolve(cwd, common));
  const list = exec("git", ["worktree", "list", "--porcelain"], { cwd });
  if (list.code !== 0)
    return { ok: false, reason: `git worktree list failed: ${list.stderr.trim()}` };
  const worktrees = list.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonical(line.slice("worktree ".length)));
  return {
    ok: true,
    info: { root, mainRoot: worktrees[0] ?? root, worktrees, commonDir },
  };
}

export function registryPathFor(commonDir: string): string {
  return join(commonDir, "istack", "ports.json");
}
