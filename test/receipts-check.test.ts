import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBLE } from "../src/config/schema.js";
import {
  checkReceipts,
  matchVisibleFiles,
  PRESENT_LABEL,
  visibleChangeFromConfig,
} from "../src/receipts/check.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "receipts");
const body = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const HEAD = "3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a";
const VISIBLE = ["src/settings/SaveButton.tsx", "src/settings/save.ts"];
const DOCS = ["docs/install.md", "README.md"];
const visibleChange = { include: DEFAULT_VISIBLE, exclude: [] };

const run = (fixture: string, changedFiles: string[]) =>
  checkReceipts({ body: body(fixture), headSha: HEAD, changedFiles, visibleChange });

describe("checkReceipts — fixture matrix", () => {
  const matrix: Array<[string, string, string[], "pass" | "fail", RegExp]> = [
    ["honest visual PR", "honest-visual.md", VISIBLE, "pass", /before\/after pair/],
    ["brand-new screen (before: absent)", "new-screen.md", VISIBLE, "pass", /before\/after pair/],
    ["same image twice", "same-image-twice.md", VISIBLE, "fail", /C1.*same image/],
    ["stale head SHA", "stale-head.md", VISIBLE, "fail", /stale.*9e8d7c6b5a4f/],
    ["short head SHA prefix", "short-head.md", VISIBLE, "pass", /before\/after pair/],
    ["missing door", "missing-door.md", VISIBLE, "fail", /door/],
    [
      "visible change, no receipts",
      "no-block.md",
      VISIBLE,
      "fail",
      /visible change.*no.*receipts/i,
    ],
    [
      "visible change with noVisibleChange reason",
      "no-visible-change.md",
      VISIBLE,
      "pass",
      /no visible change: props renamed/,
    ],
    ["visible change, red-green only", "red-green-only.md", VISIBLE, "fail", /before\/after/],
    ["docs-only PR, no block", "no-block.md", DOCS, "pass", /no receipts needed/],
    ["docs-only PR with a valid block", "red-green-only.md", DOCS, "pass", /receipts present/],
    ["duplicate blocks", "duplicate.md", VISIBLE, "fail", /2 receipts blocks/],
    ["duplicate blocks on a docs-only PR", "duplicate.md", DOCS, "fail", /2 receipts blocks/],
    ["invalid JSON on a docs-only PR", "invalid-json.md", DOCS, "fail", /not valid JSON/],
  ];

  for (const [name, fixture, files, conclusion, reason] of matrix) {
    it(`${name} → ${conclusion}`, () => {
      const result = run(fixture, files);
      expect(result.conclusion).toBe(conclusion);
      expect(result.reasons.join("\n")).toMatch(reason);
    });
  }

  it("labels a passing PR that carries receipts", () => {
    expect(run("honest-visual.md", VISIBLE).labels).toEqual([PRESENT_LABEL]);
    expect(PRESENT_LABEL).toBe("receipts: present, not verified");
  });

  it("does not label a docs-only PR without receipts, or any failing PR", () => {
    expect(run("no-block.md", DOCS).labels).toEqual([]);
    expect(run("stale-head.md", VISIBLE).labels).toEqual([]);
  });

  it("names the files that made the change visible", () => {
    expect(run("no-block.md", VISIBLE).visibleFiles).toEqual(["src/settings/SaveButton.tsx"]);
  });

  it("collects every failure, not just the first", () => {
    const staleAndSameImage = body("same-image-twice.md").replace(
      `"head": "${HEAD}"`,
      `"head": "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d"`,
    );
    const result = checkReceipts({
      body: staleAndSameImage,
      headSha: HEAD,
      changedFiles: VISIBLE,
      visibleChange,
    });
    expect(result.conclusion).toBe("fail");
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("treats an empty PR body as no receipts", () => {
    const result = checkReceipts({ body: "", headSha: HEAD, changedFiles: DOCS, visibleChange });
    expect(result.conclusion).toBe("pass");
  });
});

describe("matchVisibleFiles", () => {
  it("honours include and exclude globs", () => {
    const files = ["src/Button.tsx", "src/Button.test.tsx", "src/api.ts", "public/logo.svg"];
    expect(
      matchVisibleFiles(files, {
        include: ["src/**/*.tsx", "public/**"],
        exclude: ["**/*.test.tsx"],
      }),
    ).toEqual(["src/Button.tsx", "public/logo.svg"]);
  });

  it("matches root-level files with a **/ pattern", () => {
    expect(matchVisibleFiles(["App.tsx"], visibleChange)).toEqual(["App.tsx"]);
  });
});

describe("visibleChangeFromConfig", () => {
  it("uses the defaults when the repo has no mitchstack.yaml", () => {
    const result = visibleChangeFromConfig(null);
    expect(result.visibleChange.include).toEqual(DEFAULT_VISIBLE);
    expect(result.notes.join("\n")).toMatch(/no mitchstack.yaml/);
  });

  it("reads visibleChange from a valid config", () => {
    const yaml =
      "version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: t\n    run: npm test\n" +
      "visibleChange:\n  include: ['web/**']\n  exclude: ['web/**/*.md']\n";
    const result = visibleChangeFromConfig(yaml);
    expect(result.visibleChange).toEqual({ include: ["web/**"], exclude: ["web/**/*.md"] });
    expect(result.notes).toEqual([]);
  });

  it("falls back to the defaults, with a note, when the config is invalid", () => {
    const result = visibleChangeFromConfig("version: 1\nprofile: tem\n");
    expect(result.visibleChange.include).toEqual(DEFAULT_VISIBLE);
    expect(result.notes.join("\n")).toMatch(/invalid/);
  });
});

describe("a before picture is the red receipt for a visible change", () => {
  it("passes a visual PR that carries the pair and no separate red→green command", () => {
    const text = body("honest-visual.md");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    json.claims = json.claims.filter((c: { kind: string }) => c.kind === "visual");
    const visualOnly = `## Evidence\n\n\`\`\`receipts\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
    const result = checkReceipts({
      body: visualOnly,
      headSha: HEAD,
      changedFiles: VISIBLE,
      visibleChange,
    });
    expect(result.conclusion).toBe("pass");
  });

  it("is written down in AGENTS.md and the spec", () => {
    const rule = /a before\s+picture\s+of\s+the\s+broken\s+state\s+is\s+the\s+red\s+receipt/i;
    expect(readFileSync(join(import.meta.dirname, "..", "AGENTS.md"), "utf8")).toMatch(rule);
    const spec = readFileSync(
      join(import.meta.dirname, "..", "docs/spec/mitchstack-v1.md"),
      "utf8",
    );
    expect(spec).toMatch(rule);
    expect(spec).not.toMatch(/a merge-danger door, and a red→green\s+record/);
  });
});
