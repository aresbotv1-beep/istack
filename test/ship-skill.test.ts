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

  it("offers the retro at the full stop, before presenting the URL", () => {
    const fullStop = skill.slice(skill.indexOf("## 7. Full stop"), skill.indexOf("## Council"));
    const offer = fullStop.indexOf("offer the retro in one line");
    expect(offer, "retro offer in the full stop").toBeGreaterThan(-1);
    expect(fullStop.indexOf("Then present the URL")).toBeGreaterThan(offer);
    expect(skill).toContain("the retro offered, and the URL presented");
  });

  it("looks back at the run before asking for the PR yes, every run, fixing on the branch", () => {
    const lookBack = skill.indexOf("### Look back before you ask");
    expect(lookBack, "look-back section").toBeGreaterThan(-1);
    expect(lookBack).toBeGreaterThan(skill.indexOf("## 2. Run the review loop"));
    expect(lookBack).toBeLessThan(skill.indexOf("## 3. Ask for the PR yes"));
    const section = skill.slice(lookBack, skill.indexOf("## 3. Ask for the PR yes"));
    for (const needle of [
      "Every run",
      "not optional",
      "fix it on this branch",
      "**Risks and follow-ups**",
      "no tickets",
    ]) {
      expect(section, needle).toContain(needle);
    }
    expect(skill).toContain("the look-back done");
  });

  it("describes the one-minute body: problem first, not tested, folded log and receipts", () => {
    const write = skill.slice(
      skill.indexOf("## 4. Write the body"),
      skill.indexOf("## 5. Open it"),
    );
    for (const needle of [
      "**Problem**",
      "**Not tested**",
      "**Review**",
      "<details>",
      "2,500",
      "BAD:",
      "GOOD:",
      "Nothing left out.",
    ]) {
      expect(write, needle).toContain(needle);
    }
    expect(write.indexOf("**Problem**")).toBeLessThan(write.indexOf("**Summary**"));
    expect(write).not.toContain("**Reviewer verdicts**");
  });

  it("points to the council rules instead of a placeholder", () => {
    expect(skill).toMatch(/## Council \(factory profile\)/);
    expect(skill).not.toMatch(/placeholder/i);
    expect(skill).toContain("[council.md](council.md)");
    expect(skill).toContain("never a merge gate");
  });
});

describe("skills/ship/council.md", () => {
  const council = readFileSync(new URL("../skills/ship/council.md", import.meta.url), "utf8");

  it("states the rules the council runner enforces", () => {
    for (const needle of [
      "control picture",
      "Cheapest judge first",
      "Target hidden",
      "Median of 3",
      "max(1, 2 × MAD)",
      "whole round is discarded",
      "no council (budget)",
      "no score",
      "does not gate the merge",
      "mitchstack ship council",
      "Theo Browne",
    ]) {
      expect(council, needle).toContain(needle);
    }
  });
});

const SAME_PROVIDER = "same-provider reviewer (no second provider available)";
