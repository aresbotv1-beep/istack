import { spawnSync } from "node:child_process";
import { constants } from "node:os";

/** One run of a command, in the shape of a receipt's `red` / `green` entry plus the command. */
export interface RunRecord {
  command: string;
  sha: string;
  exitCode: number;
}

export type RunResult =
  | { ok: true; record: RunRecord; dirty: boolean }
  | { ok: false; reason: string };

/**
 * Runs `argv` without a shell in `cwd` and records its own exit code (never a pipe's) and the
 * commit it ran at. The command's output goes to this process's stderr, so stdout stays free for
 * the record.
 */
export function runAndRecord(argv: string[], cwd: string): RunResult {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (head.status !== 0) return { ok: false, reason: `not a git checkout with a commit: ${cwd}` };
  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  const dirty = status.status !== 0 || status.stdout.trim() !== "";

  const [file, ...args] = argv as [string, ...string[]];
  const child = spawnSync(file, args, { cwd, stdio: ["inherit", 2, 2] });
  return {
    ok: true,
    dirty,
    record: {
      command: argv.map(quote).join(" "),
      sha: head.stdout.trim(),
      exitCode: exitCode(child),
    },
  };
}

function exitCode(child: ReturnType<typeof spawnSync>): number {
  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? 127 : 126;
  }
  if (child.status !== null) return child.status;
  const signal = child.signal ? constants.signals[child.signal] : undefined;
  return 128 + (signal ?? 0);
}

/** Shell-style quoting, so the recorded command can be pasted back into a shell. */
function quote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
