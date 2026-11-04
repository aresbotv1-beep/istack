import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runProveCli } from "../src/capture/cli.js";
import { extractReceipts } from "../src/receipts/extract.js";

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProveCli(args, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

const fixture = pathToFileURL(
  new URL("./fixtures/capture/page.html", import.meta.url).pathname,
).href;

describe("prove capture", { timeout: 60_000 }, () => {
  it("captures a page, writes the PNG relative to cwd and prints its sha256", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-prove-"));
    const args = ["capture", "--url", fixture, "--out", "shot.png", "--viewport", "640x400"];
    const first = await run(args, dir);
    const second = await run([...args.slice(0, 4), "again.png", "--viewport", "640x400"], dir);
    expect(first.code).toBe(0);
    expect(first.out[0]).toMatch(new RegExp(`^[0-9a-f]{64}  ${join(dir, "shot.png")}$`));
    expect(second.out[0]?.slice(0, 64)).toBe(first.out[0]?.slice(0, 64));
  });

  it("accepts repeated --mask selectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-prove-"));
    const { code } = await run(
      ["capture", "--url", fixture, "--out", "m.png", "--mask", "#clock", "--mask", ".bar"],
      dir,
    );
    expect(code).toBe(0);
  });

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
