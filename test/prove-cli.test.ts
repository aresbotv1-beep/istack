import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runProveCli } from "../src/capture/cli.js";
import { extractReceipts } from "../src/receipts/extract.js";
import { receiptsSchema } from "../src/receipts/schema.js";

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProveCli(args, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

const fixture = pathToFileURL(
  new URL("./fixtures/capture/page.html", import.meta.url).pathname,
).href;

describe("prove capture (argument handling; the real captures are in test/browser)", () => {
  it("rejects a malformed viewport with usage", async () => {
    const { code, err } = await run(
      ["capture", "--url", fixture, "--out", "x.png", "--viewport", "wide"],
      tmpdir(),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/viewport/);
  });

  it("requires --url and --out", async () => {
    expect((await run(["capture", "--out", "x.png"], tmpdir())).code).toBe(2);
    expect((await run(["capture", "--url", fixture], tmpdir())).code).toBe(2);
  });
});

describe("prove receipts", () => {
  const claims = {
    head: "abc1234",
    door: { kind: "two-way", blastRadius: "one page" },
    claims: [
      {
        id: "c1",
        kind: "visual",
        statement: "new screen",
        surface: "http://localhost:3000/new",
        before: "absent",
        after: { sha256: "c".repeat(64), url: "https://example.com/after.png" },
      },
    ],
  };

  it("prints a fenced block that round-trips through extractReceipts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-prove-"));
    writeFileSync(join(dir, "claims.json"), JSON.stringify(claims));
    const { code, out } = await run(["receipts", "--from", "claims.json"], dir);
    expect(code).toBe(0);
    const back = extractReceipts(out.join("\n"));
    expect(back.ok).toBe(true);
  });

  it("names the bad field and exits 1 on invalid claims", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-prove-"));
    writeFileSync(join(dir, "claims.json"), JSON.stringify({ ...claims, head: "nope" }));
    const { code, err } = await run(["receipts", "--from", "claims.json"], dir);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/head: must be a git commit SHA/);
  });

  it("exits 1 on a missing or non-JSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-prove-"));
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect((await run(["receipts", "--from", "missing.json"], dir)).code).toBe(1);
    expect((await run(["receipts", "--from", "bad.json"], dir)).code).toBe(1);
  });

  it("prints usage and exits 2 on an unknown command", async () => {
    expect((await run(["frobnicate"], tmpdir())).code).toBe(2);
    expect((await run([], tmpdir())).code).toBe(2);
  });
});

describe("prove run", () => {
  function repo(): { dir: string; sha: string } {
    const dir = mkdtempSync(join(tmpdir(), "ms-prove-run-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    return { dir, sha: git("rev-parse", "HEAD") };
  }

  it("records a failing command's real exit code and exits with it", async () => {
    const { dir, sha } = repo();
    const { code, out } = await run(["run", "--", "sh", "-c", "exit 3"], dir);
    expect(code).toBe(3);
    expect(JSON.parse(out.join("\n"))).toEqual({
      command: "sh -c 'exit 3'",
      run: { sha, exitCode: 3 },
    });
  });

  it("records 0 and the HEAD sha for a passing command", async () => {
    const { dir, sha } = repo();
    const { code, out } = await run(["run", "--", "true"], dir);
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ command: "true", run: { sha, exitCode: 0 } });
  });

  it("exits 127 when the program does not exist", async () => {
    const { dir } = repo();
    const { code, out } = await run(["run", "--", "no-such-program-istack"], dir);
    expect(code).toBe(127);
    expect(JSON.parse(out.join("\n")).run.exitCode).toBe(127);
  });

  it("prints `run` exactly as the receipt's red / green entry, so it pastes in as is", async () => {
    const { dir } = repo();
    const claim = receiptsSchema.shape.claims.element.options[1].shape;
    const red = JSON.parse((await run(["run", "--", "sh", "-c", "exit 3"], dir)).out.join("\n"));
    const green = JSON.parse((await run(["run", "--", "true"], dir)).out.join("\n"));
    expect(claim.red.safeParse(red.run).success).toBe(true);
    expect(claim.green.safeParse(green.run).success).toBe(true);
    expect(claim.command.safeParse(red.command).success).toBe(true);
  });

  it("warns on stderr when the tree has uncommitted changes", async () => {
    const { dir } = repo();
    writeFileSync(join(dir, "dirty.txt"), "x");
    const { err } = await run(["run", "--", "true"], dir);
    expect(err.join("\n")).toMatch(/uncommitted/);
  });

  it("needs a command after --, and a git checkout", async () => {
    const { dir } = repo();
    expect((await run(["run"], dir)).code).toBe(2);
    expect((await run(["run", "--"], dir)).code).toBe(2);
    expect((await run(["run", "--", ""], dir)).code).toBe(2);
    expect((await run(["run", "--", "true"], mkdtempSync(join(tmpdir(), "ms-nogit-")))).code).toBe(
      2,
    );
  });
});
