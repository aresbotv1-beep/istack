import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { runInstallCli } from "../src/install/cli.js";

/** A fresh temporary directory standing in for someone's home or project. Never the real home. */
export function tempDir(prefix = "ms-install-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function put(root: string, path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/** Every file and directory under root, with a content hash per file: "d path" or "f path sha". */
export function snapshot(root: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(root, full);
      if (rel === ".git" || rel.startsWith(`.git/`)) continue;
      if (statSync(full).isDirectory()) {
        lines.push(`d ${rel}`);
        walk(full);
      } else {
        const sha = createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 12);
        lines.push(`f ${rel} ${sha}`);
      }
    }
  };
  walk(root);
  return lines;
}

export async function install(cwd: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runInstallCli(args, {
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

export function gitRepo(files: Record<string, string> = {}): string {
  const dir = tempDir("ms-install-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const [path, text] of Object.entries(files)) put(dir, path, text);
  return dir;
}
