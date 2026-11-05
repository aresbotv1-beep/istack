import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** A scratch repo with one commit and two linked worktrees, a and b. Real git, no mocks. */
export function scratchRepo(files: Record<string, string> = {}): {
  main: string;
  a: string;
  b: string;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ms-env-")));
  const main = join(base, "app");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "scratch\n");
  writeFileSync(join(main, ".gitignore"), ".env.local\nnode_modules\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(main, name), text);
  git(
    main,
    "add",
    "README.md",
    ".gitignore",
    ...Object.keys(files).filter((f) => f !== ".env.local"),
  );
  git(main, "commit", "-q", "-m", "init");
  const a = join(base, "wt-a");
  const b = join(base, "wt-b");
  git(main, "worktree", "add", "-q", "-b", "a", a);
  git(main, "worktree", "add", "-q", "-b", "b", b);
  return { main, a, b };
}

export function runIo(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { cwd, out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
}
