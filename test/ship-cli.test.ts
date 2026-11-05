import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractReceipts } from "../src/receipts/extract.js";
import { runShipCli, type ShipDeps } from "../src/ship/cli.js";

async function run(args: string[], cwd: string, env: Record<string, string> = {}, deps?: ShipDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { cwd, env, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const code = await runShipCli(args, io, deps);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function dirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "ms-ship-"));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
}

const timeoutReview = {
  reviewer: "codex exec (openai)",
  rounds: [{ reply: { kind: "timeout", seconds: 600 } }],
};

const body = {
  summary: "one-line fix",
  evidence: "see receipts",
  mergeDanger: { door: "two-way", blastRadius: "the save button" },
  tryItYourself: ["`npm test -- save`"],
  reviews: [timeoutReview],
  risks: [],
  receipts: { head: "abc1234", claims: [], noVisibleChange: "logic only" },
};

describe("mitchstack ship", () => {
  it("review: a timed-out reviewer prints not approved and exits 1", async () => {
    const dir = dirWith({ "review.json": timeoutReview });
    const result = await run(["review", "--from", "review.json"], dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("**not approved**");
    expect(result.out).toContain("## Open disputes");
  });

  it("review: --format json prints the ledger", async () => {
    const dir = dirWith({ "review.json": timeoutReview });
    const result = await run(["review", "--from", "review.json", "--format", "json"], dir);
    expect(JSON.parse(result.out)).toMatchObject({ verdict: "not-approved", state: "done" });
  });

  it("review: rejects a malformed input file with the field path", async () => {
    const dir = dirWith({
      "review.json": { reviewer: "x", rounds: [{ reply: { kind: "maybe" } }] },
    });
    const result = await run(["review", "--from", "review.json"], dir);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/rounds\.0\.reply/);
  });

  it("body: renders a PR body with a valid receipts block", async () => {
    const dir = dirWith({ "body.json": body });
    const result = await run(["body", "--from", "body.json"], dir);
    expect(result.code).toBe(0);
    expect(extractReceipts(result.out).ok).toBe(true);
    expect(result.out).toContain("**not approved**");
  });

  it("body: refuses without a door, naming the field", async () => {
    const dir = dirWith({ "body.json": { ...body, mergeDanger: { blastRadius: "x" } } });
    const result = await run(["body", "--from", "body.json"], dir);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/mergeDanger\.door/);
  });

  it("reviewer: finds codex on PATH for a non-openai builder, executing nothing", async () => {
    const bin = mkdtempSync(join(tmpdir(), "ms-bin-"));
    const marker = join(bin, "ran");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho ran > ${marker}\n`);
    chmodSync(join(bin, "codex"), 0o755);
    const result = await run(["reviewer", "--builder", "anthropic"], bin, { PATH: bin });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ kind: "cross-provider", via: "codex exec" });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("reviewer: takes delegate_task providers from the harness", async () => {
    const result = await run(
      ["reviewer", "--builder", "anthropic", "--delegate-task", "anthropic,openai"],
      tmpdir(),
      { PATH: "" },
    );
    expect(JSON.parse(result.out)).toMatchObject({ via: "delegate_task", provider: "openai" });
  });

  it("watch: prints the verdict and actions; exit codes 0 ready / 1 blocked / 3 waiting", async () => {
    const fixture = readFileSync(
      new URL("./fixtures/watch/pr-graphql.json", import.meta.url),
      "utf8",
    );
    const exec: ShipDeps["exec"] = async () => ({ code: 0, stdout: fixture, stderr: "" });
    const result = await run(["watch", "--repo", "acme/app", "--pr", "7"], tmpdir(), {}, { exec });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^blocked/);
    expect(result.out).toContain("answer thread by review-bot");
  });

  it("watch: exits 2 when gh fails", async () => {
    const exec: ShipDeps["exec"] = async () => ({ code: 1, stdout: "", stderr: "no auth" });
    const result = await run(["watch", "--repo", "acme/app", "--pr", "7"], tmpdir(), {}, { exec });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/no auth/);
  });

  it("prints usage for an unknown command", async () => {
    const result = await run(["nope"], tmpdir());
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/usage: mitchstack ship/);
  });
});
