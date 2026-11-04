import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPrivateTerms, scanShippedFiles } from "../src/scrub/scan.js";

const root = new URL("..", import.meta.url).pathname;

// Private terms are built at runtime so this file never holds them in plaintext.
const planted = {
  name: ["B", "en"].join(""),
  service: ["Pere", "grine"].join(""),
  teammate: ["Je", "ss"].join(""),
  doc: ["LOCAL", "WORLD"].join("-"),
  phrase: ["Black", "Label"].join(" "),
};

describe("private-term scrub", () => {
  it("catches a planted private name (guard proven against a violation)", () => {
    const hits = findPrivateTerms(
      "x.md",
      `Ask ${planted.name} before merging to ${planted.service} on :3200.`,
    );
    expect(hits.map((h) => h.term).sort()).toEqual([planted.name, planted.service].sort());
  });

  it("catches hyphenated and multi-word terms in any case", () => {
    const text = `see ${planted.doc}.md and the ${planted.phrase.toUpperCase()} board, ${planted.service.toLowerCase()}-api`;
    const terms = findPrivateTerms("x.md", text).map((h) => h.term);
    expect(terms).toContain(planted.doc);
    expect(terms).toContain(planted.phrase.toUpperCase());
    expect(terms).toContain(planted.service.toLowerCase());
  });

  it("does not flag ordinary words that contain a name", () => {
    expect(findPrivateTerms("x.md", "The bench and Bengal tigers.")).toEqual([]);
  });

  it("scans the eval scenarios and baselines too", () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-scrub-"));
    mkdirSync(join(dir, "evals", "groundbreak"), { recursive: true });
    writeFileSync(
      join(dir, "evals", "groundbreak", "01.yaml"),
      `prompt: ask ${planted.teammate} first\n`,
    );
    expect(scanShippedFiles(dir)).toEqual([
      { file: join("evals", "groundbreak", "01.yaml"), line: 1, term: planted.teammate },
    ]);
  });

  it("finds no private terms in any file outside docs/", () => {
    const hits = scanShippedFiles(root);
    expect(hits).toEqual([]);
  });

  it("finds no private terms in what npm actually publishes, compiled code included", () => {
    if (!existsSync(join(root, "dist", "src", "scrub", "scan.js"))) {
      execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "pipe" });
    }
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { files: { path: string }[] }[];
    const files = (packed[0]?.files ?? []).map((f) => f.path);
    // The scanner's own compiled output ships, so it is scanned like everything else.
    expect(files).toContain("dist/src/scrub/scan.js");
    // LICENSE names the author on purpose (public attribution); nothing else may.
    const hits = files
      .filter((file) => file !== "LICENSE" && !file.endsWith(".png"))
      .flatMap((file) => findPrivateTerms(file, readFileSync(join(root, file), "utf8")));
    expect(hits).toEqual([]);
  }, 60_000);
});
