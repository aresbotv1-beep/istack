import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runVerifyCli } from "../src/receipts/verify/cli.js";
import {
  type FixtureRepo,
  fileHashCapture,
  makeFixtureRepo,
  prBody,
  redGreen,
} from "./verify-fixture.js";

function io(cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fullEnv = { PATH: process.env.PATH, ...env };
  return {
    io: { cwd, out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: fullEnv },
    out,
    err,
  };
}

const deps = { capture: fileHashCapture };

describe("istack receipts verify (CLI)", { timeout: 60_000 }, () => {
  let fx: FixtureRepo;
  let dir: string;
  beforeAll(() => {
    fx = makeFixtureRepo();
    dir = mkdtempSync(join(tmpdir(), "ms-verify-cli-"));
  });

  const bodyFile = (name: string, claims: unknown[]) => {
    const path = join(dir, name);
    writeFileSync(path, prBody(fx.head, claims));
    return path;
  };

  it("exits 1 and names the faked claim", async () => {
    const body = bodyFile("faked.md", [
      redGreen("honest", "node test/sum.test.mjs", fx),
      redGreen("faked", "node test/mul.test.mjs", fx),
    ]);
    const t = io(dir);
    const code = await runVerifyCli(
      ["--body", body, "--base", fx.base, "--head", fx.head, "--repo", fx.repo],
      t.io,
      deps,
    );
    expect(code).toBe(1);
    const text = t.err.join("\n");
    expect(text).toMatch(/istack\/receipts-verified: fail/);
    expect(text).toMatch(/faked \(red-green\): FAILED/);
    expect(text).toMatch(/honest \(red-green\): verified/);
  });

  it("exits 0 on honest receipts read from a pull_request event, and writes the outputs", async () => {
    const event = join(dir, "event.json");
    writeFileSync(
      event,
      JSON.stringify({
        repository: { full_name: "o/r" },
        pull_request: {
          number: 7,
          body: prBody(fx.head, [redGreen("honest", "node test/sum.test.mjs", fx)]),
          head: { sha: fx.head },
          base: { sha: fx.base },
        },
      }),
    );
    const output = join(dir, "output.txt");
    const summary = join(dir, "summary.md");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const t = io(dir, {
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      PATH: process.env.PATH,
    });
    const code = await runVerifyCli(["--repo", fx.repo, "--report", "report.json"], t.io, deps);
    expect(code).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("conclusion=pass\n");
    expect(readFileSync(summary, "utf8")).toMatch(/\| `honest` \| red-green \| verified \|/);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    expect(report.claims[0].status).toBe("verified");
  });

  it("exits 2 when it cannot run", async () => {
    const t = io(dir);
    expect(await runVerifyCli(["--bogus"], t.io, deps)).toBe(2);
    expect(await runVerifyCli([], t.io, deps)).toBe(2);
    const body = bodyFile("ok.md", [redGreen("honest", "node test/sum.test.mjs", fx)]);
    const missing = "0".repeat(40);
    expect(
      await runVerifyCli(
        ["--body", body, "--base", missing, "--head", fx.head, "--repo", fx.repo],
        t.io,
        deps,
      ),
    ).toBe(2);
    expect(t.err.join("\n")).toMatch(/fetch-depth: 0/);
    expect(
      await runVerifyCli(
        ["--body", body, "--base", fx.base, "--head", fx.head, "--attempts", "0"],
        t.io,
        deps,
      ),
    ).toBe(2);
  });

  it("refuses pull_request_target", async () => {
    const t = io(dir, { GITHUB_EVENT_NAME: "pull_request_target" });
    expect(await runVerifyCli([], t.io, deps)).toBe(2);
    expect(t.err.join("\n")).toMatch(/pull_request_target/);
  });
});
