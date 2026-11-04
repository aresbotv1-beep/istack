import { describe, expect, it } from "vitest";
import { extractReceipts } from "../src/receipts/extract.js";
import { writeReceipts } from "../src/receipts/write.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const input = {
  head: "abc1234",
  door: { kind: "two-way", blastRadius: "the settings page only" },
  claims: [
    {
      id: "c1",
      kind: "visual",
      statement: "the save button is visible on small screens",
      surface: "http://localhost:3000/settings",
      before: { sha256: hashA, url: "https://example.com/before.png" },
      after: { sha256: hashB, url: "https://example.com/after.png" },
    },
    {
      id: "c2",
      kind: "visual",
      statement: "a new empty-state screen",
      surface: "http://localhost:3000/empty",
      before: "absent",
      after: { sha256: hashB, url: "https://example.com/empty.png" },
    },
    {
      id: "c3",
      kind: "red-green",
      statement: "saving twice no longer duplicates the row",
      command: "npm test -- save",
      red: { sha: "abc1234", exitCode: 1 },
      green: { sha: "def5678", exitCode: 0 },
    },
  ],
};

describe("writeReceipts", () => {
  it("builds one fenced receipts block that extractReceipts accepts unchanged", () => {
    const result = writeReceipts(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.startsWith("```receipts\n")).toBe(true);
    expect(result.block.endsWith("\n```")).toBe(true);
    const body = `## Evidence\n\n${result.block}\n\nmore text`;
    const back = extractReceipts(body);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.receipts).toEqual({ version: 1, ...input });
    expect(back.receipts).toEqual(result.receipts);
  });

  it("supports before: absent for a brand-new screen", () => {
    const result = writeReceipts({ ...input, claims: [input.claims[1]] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipts.claims[0]).toMatchObject({ before: "absent" });
  });

  it("supports a no-visible-change receipt with no claims", () => {
    const result = writeReceipts({ ...input, claims: [], noVisibleChange: "backend only" });
    expect(result.ok).toBe(true);
  });

  it("refuses an invalid claim and names the field", () => {
    const bad = structuredClone(input) as typeof input;
    (bad.claims[2] as { red: { exitCode: number } }).red.exitCode = 0;
    const result = writeReceipts(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toContain("claims.2.red.exitCode");
  });

  it("refuses a wrong version instead of silently replacing it", () => {
    const result = writeReceipts({ ...input, version: 2 });
    expect(result.ok).toBe(false);
  });

  it("refuses input that is not an object", () => {
    expect(writeReceipts(null).ok).toBe(false);
    expect(writeReceipts([]).ok).toBe(false);
  });
});
