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

  it("finds no private terms in any shipped file", () => {
    const hits = scanShippedFiles(new URL("..", import.meta.url).pathname);
    expect(hits).toEqual([]);
  });
});
