import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPrivateTerms, scanShippedFiles } from "../src/scrub/scan.js";

describe("private-term scrub", () => {
  it("catches a planted private name (guard proven against a violation)", () => {
    const hits = findPrivateTerms("x.md", "Ask Ben before merging to Peregrine on :3200.");
    expect(hits.map((h) => h.term).sort()).toEqual(["Ben", "Peregrine"]);
  });

  it("does not flag ordinary words that contain a name", () => {
    expect(findPrivateTerms("x.md", "The bench and Bengal tigers.")).toEqual([]);
  });

  it("scans the eval scenarios and baselines too", () => {
    const root = mkdtempSync(join(tmpdir(), "ms-scrub-"));
    mkdirSync(join(root, "evals", "groundbreak"), { recursive: true });
    writeFileSync(join(root, "evals", "groundbreak", "01.yaml"), "prompt: ask Jess first\n");
    expect(scanShippedFiles(root)).toEqual([
      { file: join("evals", "groundbreak", "01.yaml"), line: 1, term: "Jess" },
    ]);
  });

  it("finds no private terms in any shipped file", () => {
    const hits = scanShippedFiles(new URL("..", import.meta.url).pathname);
    expect(hits).toEqual([]);
  });
});
