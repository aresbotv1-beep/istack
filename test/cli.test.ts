import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, runCli } from "../src/cli.js";
import type { FetchLike } from "../src/receipts/github.js";

async function run(args: string[], cwd: string, extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    ...extra,
  });
  return { code, out, err };
}

describe("mitchstack config check", () => {
  it("names the bad field and exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-"));
    writeFileSync(
      join(dir, "mitchstack.yaml"),
      "version: 1\nowner: Sam\nprofile: tem\nchecks:\n  - name: t\n    run: npm test\n",
    );
    const { code, err } = await run(["config", "check"], dir);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/profile: profile must be one of: solo, team, factory/);
  });

  it("exits 0 on a valid config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-"));
    writeFileSync(
      join(dir, "mitchstack.yaml"),
      "version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: t\n    run: npm test\n",
    );
    expect((await run(["config", "check"], dir)).code).toBe(0);
  });

  it("prints usage and exits 2 on an unknown command", async () => {
    expect((await run(["frobnicate"], tmpdir())).code).toBe(2);
  });
});

const FIXTURES = join(import.meta.dirname, "fixtures", "receipts");
const fx = (name: string) => join(FIXTURES, name);

/** Fake GitHub API: the PR's files and (optionally) a mitchstack.yaml at the base commit. */
function fakeGitHub(files: string[], configYaml: string | null): FetchLike {
  return async (url) => {
    if (url.includes("/pulls/7/files")) {
      const page = url.endsWith("page=1") ? files.map((filename) => ({ filename })) : [];
      return { ok: true, status: 200, text: async () => JSON.stringify(page) };
    }
    if (url.includes("/contents/mitchstack.yaml?ref=65881ed884127d64ec923c1f37f1bd280b5e4e33")) {
      if (configYaml === null) return { ok: false, status: 404, text: async () => "Not Found" };
      return { ok: true, status: 200, text: async () => configYaml };
    }
    return { ok: false, status: 500, text: async () => `unexpected ${url}` };
  };
}

describe("mitchstack receipts check", () => {
  it("passes an honest visual PR from an event file and a local file list", async () => {
    const { code, out } = await run(
      ["receipts", "check", "--event", fx("event-honest.json"), "--files", fx("files-visible.txt")],
      tmpdir(),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/pass/);
    expect(out.join("\n")).toMatch(/receipts: present, not verified/);
  });

  it("fails a visible change with no receipts and prints the reason", async () => {
    const { code, err } = await run(
      [
        "receipts",
        "check",
        "--event",
        fx("event-no-receipts.json"),
        "--files",
        fx("files-visible.txt"),
      ],
      tmpdir(),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/src\/settings\/SaveButton.tsx/);
  });

  it("uses the GitHub API for files and base config, and writes the step summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-"));
    const summary = join(dir, "summary.md");
    const output = join(dir, "output.txt");
    writeFileSync(summary, "");
    writeFileSync(output, "");
    const config =
      "version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: t\n    run: npm test\n" +
      "visibleChange:\n  include: ['docs/**']\n";
    const { code, err } = await run(["receipts", "check"], dir, {
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: fx("event-no-receipts.json"),
        GITHUB_TOKEN: "t0k",
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
      },
      fetch: fakeGitHub(["docs/install.md"], config),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/docs\/install.md/);
    expect(readFileSync(summary, "utf8")).toMatch(/## mitchstack\/receipts: fail/);
    expect(readFileSync(output, "utf8")).toMatch(/^conclusion=fail$/m);
  });

  it("passes a docs-only PR with no block when the repo has no config", async () => {
    const { code, out } = await run(["receipts", "check"], tmpdir(), {
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: fx("event-no-receipts.json"),
        GITHUB_TOKEN: "t0k",
      },
      fetch: fakeGitHub(["docs/install.md", "README.md"], null),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/no receipts needed/);
  });

  it("refuses to run on pull_request_target", async () => {
    const { code, err } = await run(["receipts", "check"], tmpdir(), {
      env: { GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: fx("event-honest.json") },
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/pull_request_target/);
  });

  it("exits 2 when there is no event to read", async () => {
    const { code, err } = await run(["receipts", "check"], tmpdir());
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--event/);
  });

  it("exits 2 when it needs the API but has no token", async () => {
    const { code, err } = await run(
      ["receipts", "check", "--event", fx("event-honest.json")],
      tmpdir(),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/GITHUB_TOKEN/);
  });
});
