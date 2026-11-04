import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(args, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe("mitchstack config check", () => {
  it("names the bad field and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-"));
    writeFileSync(
      join(dir, "mitchstack.yaml"),
      "version: 1\nowner: Sam\nprofile: tem\nchecks:\n  - name: t\n    run: npm test\n",
    );
    const { code, err } = run(["config", "check"], dir);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/profile: profile must be one of: solo, team, factory/);
  });

  it("exits 0 on a valid config", () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-"));
    writeFileSync(
      join(dir, "mitchstack.yaml"),
      "version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: t\n    run: npm test\n",
    );
    expect(run(["config", "check"], dir).code).toBe(0);
  });

  it("prints usage and exits 2 on an unknown command", () => {
    expect(run(["frobnicate"], tmpdir()).code).toBe(2);
  });
});
