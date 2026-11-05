import { describe, expect, it } from "vitest";
import { extractReceipts } from "../src/receipts/extract.js";

const block = (json: unknown) =>
  `## Summary\nstuff\n\n\`\`\`receipts\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;

const valid = {
  version: 1,
  head: "65881ed884127d64ec923c1f37f1bd280b5e4e33",
  door: { kind: "two-way", blastRadius: "docs — only the README changes" },
  claims: [
    {
      id: "C1",
      kind: "red-green",
      statement: "config typo is rejected",
      command: "npx vitest run test/config.test.ts",
      red: { sha: "8a453e7", exitCode: 1 },
      green: { sha: "65881ed", exitCode: 0 },
    },
    {
      id: "C2",
      kind: "visual",
      statement: "README renders the tagline",
      surface: "https://github.com/x/y#readme",
      before: "absent",
      after: { sha256: "a".repeat(64), url: "https://github.com/user-attachments/assets/1" },
    },
  ],
};

describe("extractReceipts", () => {
  it("parses a valid receipts block from a PR body", () => {
    const result = extractReceipts(block(valid));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipts.claims).toHaveLength(2);
  });

  it("finds the block folded inside a <details> element, as the PR body renders it", () => {
    const folded = `## Risks\n\nNone.\n\n<details><summary>Receipts</summary>\n\n${block(valid)}\n</details>\n`;
    const result = extractReceipts(folded);
    expect(result.ok).toBe(true);
  });

  it("reports a missing block distinctly from an invalid one", () => {
    const result = extractReceipts("## Summary\nno receipts here");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("rejects two receipts blocks", () => {
    const result = extractReceipts(block(valid) + block(valid));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("duplicate");
  });

  it("rejects invalid JSON with a reason", () => {
    const result = extractReceipts("```receipts\n{ not json\n```");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("requires a door with a blast radius", () => {
    const result = extractReceipts(block({ ...valid, door: { kind: "two-way" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.path === "door.blastRadius")).toBe(true);
  });

  it("requires the red step to have failed", () => {
    const bad = structuredClone(valid);
    (bad.claims[0] as { red: { exitCode: number } }).red.exitCode = 0;
    const result = extractReceipts(block(bad));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((e) => e.path === "claims.0.red.exitCode")).toBe(true);
  });

  it("rejects a 'no visible change' escape without a reason", () => {
    const result = extractReceipts(block({ ...valid, noVisibleChange: "" }));
    expect(result.ok).toBe(false);
  });
});
