import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runProveCli } from "../../src/capture/cli.js";

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProveCli(args, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

const fixture = pathToFileURL(
  new URL("../fixtures/capture/page.html", import.meta.url).pathname,
).href;

describe("prove capture (real Chromium)", { timeout: 60_000 }, () => {
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
});
