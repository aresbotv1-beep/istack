import { sep } from "node:path";
import { canonical, type Exec } from "./git.js";

export type PortCheck =
  | { ok: true; port: number; pid: number; cwd: string }
  | { ok: false; reason: "foreign"; port: number; pid: number; cwd: string; message: string }
  | { ok: false; reason: "free" | "unavailable"; port: number; message: string };

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/** The deepest checkout containing `path`, so a worktree nested inside another is told apart. */
function owningCheckout(path: string, worktrees: string[]): string | undefined {
  return worktrees
    .filter((w) => inside(path, w))
    .sort((x, y) => y.length - x.length)
    .at(0);
}

/**
 * Is whatever listens on `port` running from THIS worktree? Uses lsof: the listening pids, then
 * each pid's cwd. Any listener whose cwd belongs to another checkout (or to no checkout) is a
 * rejection naming its pid and cwd.
 */
export function checkPortOwnership(input: {
  port: number;
  worktree: string;
  worktrees: string[];
  exec: Exec;
}): PortCheck {
  const { port, exec } = input;
  const listeners = exec("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    cwd: input.worktree,
  });
  if (listeners.error) {
    return {
      ok: false,
      reason: "unavailable",
      port,
      message: `cannot run lsof: ${listeners.error}`,
    };
  }
  const pids = [...new Set(parseField(listeners.stdout, "p").map(Number))].filter(Number.isInteger);
  if (pids.length === 0) {
    return { ok: false, reason: "free", port, message: `nothing is listening on port ${port}` };
  }
  const worktree = canonical(input.worktree);
  const worktrees = input.worktrees.map(canonical);
  let first: { pid: number; cwd: string } | undefined;
  for (const pid of pids) {
    const info = exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { cwd: worktree });
    const raw = parseField(info.stdout, "n")[0];
    const cwd = raw === undefined ? "(unreadable)" : canonical(raw);
    if (raw === undefined || owningCheckout(cwd, worktrees) !== worktree) {
      return {
        ok: false,
        reason: "foreign",
        port,
        pid,
        cwd,
        message: `port ${port} is held by pid ${pid} running in ${cwd}, not in this worktree (${worktree})`,
      };
    }
    first ??= { pid, cwd };
  }
  return { ok: true, port, ...(first as { pid: number; cwd: string }) };
}

/** lsof -F output: one field per line, the first character names the field. */
function parseField(stdout: string, field: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith(field))
    .map((line) => line.slice(1));
}
