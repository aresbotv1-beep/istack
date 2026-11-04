import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(new URL("../skills/ship/SKILL.md", import.meta.url), "utf8");

describe("skills/ship/SKILL.md", () => {
  it("has frontmatter naming the skill", () => {
    expect(skill).toMatch(/^---\nname: ship\ndescription: .+\n---\n/);
  });

  it("covers the rules the ship beat depends on", () => {
    for (const needle of [
      "VERDICT: APPROVE",
      "not approval",
      "Open disputes",
      "gh pr create",
      "--attach",
      "artifact",
      "one watcher",
      "> **agent: ",
      "auto-merge",
      "merge queue",
      "Never merge",
      SAME_PROVIDER,
    ]) {
      expect(skill, needle).toContain(needle);
    }
  });

  it("leaves a clearly marked council placeholder for the factory profile", () => {
    expect(skill).toMatch(/## Council \(factory profile\)/);
    expect(skill).toMatch(/placeholder/i);
  });
});

const SAME_PROVIDER = "same-provider reviewer (no second provider available)";
