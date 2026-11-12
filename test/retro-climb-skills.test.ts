import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("..", import.meta.url);
const read = (path: string) =>
  existsSync(new URL(path, root)) ? readFileSync(new URL(path, root), "utf8") : "";

const retro = read("skills/retro/SKILL.md");
const climb = read("skills/climb/SKILL.md");

function frontmatter(text: string): Record<string, unknown> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, "frontmatter block").not.toBeNull();
  return parse(match?.[1] ?? "") as Record<string, unknown>;
}

function expectInOrder(text: string, needles: string[]) {
  let from = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle, from + 1);
    expect(at, `"${needle}" after position ${from}`).toBeGreaterThan(from);
    from = at;
  }
}

describe.each([
  ["retro", retro],
  ["climb", climb],
])("skills/%s/SKILL.md loads as a skill", (name, text) => {
  it("has frontmatter both harnesses accept", () => {
    const fm = frontmatter(text);
    expect(Object.keys(fm).sort()).toEqual(["description", "name"]);
    expect(fm.name).toBe(name);
    const description = fm.description as string;
    expect(typeof description).toBe("string");
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(500);
    expect(description).not.toMatch(/[<>]/);
  });

  it("stays lean", () => {
    expect(text.split("\n").length).toBeLessThanOrEqual(130);
  });

  it("links only to files that exist", () => {
    for (const [, target] of text.matchAll(/\]\(([^)#]+\.md)\)/g)) {
      expect(existsSync(new URL(`skills/${name}/${target}`, root)), target).toBe(true);
    }
  });
});

describe("retro", () => {
  it("is offered in one line and runs only on request", () => {
    expect(retro).toMatch(/offer the retro in \*\*one line\*\*/);
    expect(retro).toMatch(/Run it only when the owner asks/);
    expect(retro).toMatch(/never on a schedule/);
  });

  it("names the six categories", () => {
    for (const category of [
      "Navigation",
      "Automated checks",
      "Standards",
      "Steering-file bloat",
      "Tool economy",
      "Information access",
    ]) {
      expect(retro, category).toContain(`**${category}**`);
    }
  });

  it("ranks by severity and sorts Accepted / Rejected / Backlog after the owner sorts", () => {
    expect(retro).toMatch(/most severe first/);
    expectInOrder(retro, ["**Accepted**", "**Rejected**", "**Backlog**"]);
    expect(retro).toContain("Do not file anything before the owner has sorted");
  });

  it("turns lintable findings into checks", () => {
    expect(retro).toContain("the fix is a check, not a sentence");
  });

  it("shows the gh issue create commands first and runs them only after a yes", () => {
    expectInOrder(retro, [
      "Show the exact commands",
      "gh issue create",
      "only after the owner says yes",
    ]);
  });

  it("records the retro in docs/factory/retros", () => {
    expect(retro).toContain("docs/factory/retros/<YYYY-MM-DD>.md");
  });

  it("is offered before the merge, so its record lands on the run's own PR", () => {
    expectInOrder(retro, ["## 1. Offer it, do not run it", "before the merge"]);
    expect(retro).toContain("one more commit on the run's branch");
    // The receipts check refuses receipts made against an older head.
    expect(retro).toContain("update the `receipts` block");
    // After the merge it is a separate change that needs its own PR yes.
    expectInOrder(retro, ["When the PR has already merged", "the owner's yes for that PR"]);
  });
});

describe("climb", () => {
  it("plans the ladder before anything is measured", () => {
    expectInOrder(climb, ["## 1. Ladder first", "expected", "cost", "lowest", "## 2."]);
    expect(climb).toContain("istack climb ladder");
  });

  it("states the discipline", () => {
    for (const needle of [
      "minimum attempts",
      "Never relax the target",
      "frozen",
      "planted bad change",
      "refuses to start",
      "median",
      "max(noiseFloor, k × MAD(baseline runs), k × MAD(candidate runs))",
      "regression checks are green",
      "fully reverted",
      "one commit",
      "decision.tsv",
      "istack climb run",
    ]) {
      expect(climb, needle).toContain(needle);
    }
  });

  it("uses the council with a hidden target and a control for UI climbs", () => {
    expect(climb).toContain("istack climb council-score");
    expect(climb).toMatch(/\*\*target stays hidden\*\*/);
    expect(climb).toMatch(/\*\*control\*\* picture/);
  });

  it("names the engine's log columns exactly", () => {
    expect(climb).toContain(
      "`iteration · change · baseline_median · candidate_median · noise · decision · reason`",
    );
  });
});
