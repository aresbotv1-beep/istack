import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptureFn } from "../src/receipts/verify/verify.js";

/** A git env that ignores the user's global config, hooks and signing. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function write(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export const BASE_FILES = {
  "src/math.mjs":
    "export const sum = (a, b) => a - b; // bug\nexport const mul = (a, b) => a * b;\n",
  "test/mul.test.mjs":
    'import assert from "node:assert/strict";\nimport { mul } from "../src/math.mjs";\nassert.equal(mul(2, 3), 6);\n',
  "public/index.html": "<h1>Hello</h1>\n",
};

export const HEAD_FILES = {
  "src/math.mjs": "export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n",
  "test/sum.test.mjs":
    'import assert from "node:assert/strict";\nimport { sum } from "../src/math.mjs";\nassert.equal(sum(2, 3), 5);\n',
  "public/index.html": "<h1>Hello, world</h1>\n",
  "public/new.html": "<h1>A brand-new screen</h1>\n",
};

export interface FixtureRepo {
  repo: string;
  base: string;
  head: string;
}

/**
 * A temp repo: `base` has a sum() bug and a passing mul test; `head` fixes sum, adds a sum test,
 * changes public/index.html and adds public/new.html. The checkout is left at `head`.
 */
export function makeFixtureRepo(): FixtureRepo {
  const repo = mkdtempSync(join(tmpdir(), "ms-verify-fixture-"));
  git(repo, "init", "-q", "-b", "main");
  write(repo, BASE_FILES);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "fix-sum");
  write(repo, HEAD_FILES);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fix sum, add sum test, change the page");
  const head = git(repo, "rev-parse", "HEAD");
  return { repo, base, head };
}

/**
 * A capture that "renders" a file by hashing its bytes: deterministic and browser-free, so the
 * verifier's logic can be tested without Chromium. The real capture has its own test.
 */
export const fileHashCapture: CaptureFn = async ({ url, out }) => {
  const bytes = readFileSync(fileURLToPath(url));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  return { ok: true, path: out, sha256: sha256(bytes) };
};

export function prBody(head: string, claims: unknown[]): string {
  const receipts = {
    version: 1,
    head,
    door: { kind: "two-way", blastRadius: "the fixture only" },
    claims,
  };
  return `## Summary\nfixture PR\n\n\`\`\`receipts\n${JSON.stringify(receipts, null, 2)}\n\`\`\`\n`;
}

export const redGreen = (id: string, command: string, fixture: FixtureRepo) => ({
  id,
  kind: "red-green",
  statement: `${command} fails before the fix and passes after`,
  command,
  red: { sha: fixture.base, exitCode: 1 },
  green: { sha: fixture.head, exitCode: 0 },
});

export const image = (sha: string) => ({ sha256: sha, url: "https://example.com/shot.png" });
