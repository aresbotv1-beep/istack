import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("..", import.meta.url);
const read = (path: string) =>
  existsSync(new URL(path, root)) ? readFileSync(new URL(path, root), "utf8") : "";

const groundbreak = read("skills/groundbreak/SKILL.md");
const express = read("skills/groundbreak/express.md");
const hunt = read("skills/groundbreak/hunt.md");
const board = read("skills/groundbreak/board.md");
const plan = read("skills/plan/SKILL.md");
const ticket = read("templates/ticket.md");

/** Claude Code and Codex both read `name` + `description` from YAML frontmatter in SKILL.md. */
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

const lines = (text: string) => text.split("\n").length;

describe.each([
  ["groundbreak", groundbreak],
  ["plan", plan],
])("skills/%s/SKILL.md loads as a skill", (name, text) => {
  it("has frontmatter both harnesses accept", () => {
    const fm = frontmatter(text);
    expect(Object.keys(fm).sort()).toEqual(["description", "name"]);
    expect(fm.name).toBe(name);
    expect(fm.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(typeof fm.description).toBe("string");
    const description = fm.description as string;
    // Codex caps descriptions tighter than Claude Code; stay under both.
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(500);
    expect(description).not.toMatch(/[<>]/);
  });

  it("stays lean: details live in sibling reference files", () => {
    expect(lines(text)).toBeGreaterThan(20);
    expect(lines(text)).toBeLessThanOrEqual(130);
  });

  it("links only to reference files that exist", () => {
    expect(text).not.toBe("");
    for (const [, target] of text.matchAll(/\]\(([^)#]+\.md)\)/g)) {
      expect(existsSync(new URL(`skills/${name}/${target}`, root)), target).toBe(true);
    }
  });
});

describe("groundbreak", () => {
  it("has two lanes and the express lane's trigger rules come first", () => {
    expectInOrder(groundbreak, [
      "## Pick the lane",
      "Express lane",
      "Full engine",
      "## The 8 phases",
    ]);
    expect(groundbreak).toMatch(/When unsure, start express/);
    expect(groundbreak).toContain("](express.md)");
  });

  it("names the 8 phases in order", () => {
    expectInOrder(groundbreak, [
      "1 · Anchor",
      "2 · Hunt",
      "3 · Zero-to-one",
      "4 · Board audit",
      "5 · Wall & pin",
      "6 · Break it",
      "7 · Ledger & assembled re-screen",
      "8 · Hand-off to `plan`",
    ]);
  });

  it("zero-to-one writes the launch post first and declares the budget", () => {
    expect(groundbreak).toMatch(/launch post/i);
    expect(groundbreak).toMatch(/budget/i);
  });

  it("wall: real steals, domain-native first, 10x on a named axis", () => {
    expect(groundbreak).toContain("industry → mechanism → mapping");
    expect(groundbreak).toMatch(/subject's own domain first/);
    expect(groundbreak).toMatch(/10x on\s+a named axis/);
    expect(groundbreak).toMatch(/drops to Rethink/);
  });

  it("fights resolve by separation, never compromise", () => {
    expect(groundbreak).toMatch(/separation/i);
    for (const axis of ["time", "place", "condition"]) expect(groundbreak).toContain(axis);
    expect(groundbreak).toMatch(/never by compromise/);
  });

  it("deletion: Musk's rule for requirements and steps, ideas honest-only", () => {
    expect(groundbreak).toMatch(/no kill quota/i);
  });

  it("ledger keeps the owner's words verbatim with LOCKED and OPEN", () => {
    expect(groundbreak).toMatch(/verbatim/);
    expect(groundbreak).toContain("LOCKED");
    expect(groundbreak).toContain("OPEN");
  });
});

describe("groundbreak/express.md — the grill", () => {
  it("every question passes the bar", () => {
    expectInOrder(express, [
      "## The bar",
      "Not answerable from the code",
      "Splits the plan",
      "Concrete scenario",
      "Carries a recommendation",
    ]);
  });

  it("asks a ranked batch of at most 5, shows the cut count, uses the question tool", () => {
    expect(express).toMatch(/at most 5/);
    expect(express).toMatch(/cut count/i);
    expect(express).toMatch(/question tool/);
  });

  it("from round two the owner reacts to a draft ticket", () => {
    expect(express).toMatch(/round two/i);
    expect(express).toMatch(/draft ticket/);
  });

  it('always ends on "How will you know I\'m wrong?"', () => {
    expect(express).toContain("How will you know I'm wrong?");
    expect(express).toMatch(/always the last question/);
  });
});

describe("groundbreak/hunt.md", () => {
  it("runs channels in order, domain-native first and far-field last", () => {
    expectInOrder(hunt, ["own domain", "Primary docs", "Practitioner complaints", "Far-field"]);
    expect(hunt).toMatch(/clean-room/);
    expect(hunt).toContain("rea");
  });

  it("verifies only on two independent agreements and saves a research doc", () => {
    expect(hunt).toMatch(/\*\*verified\*\*/);
    expect(hunt).toMatch(/two independent/);
    expect(hunt).toMatch(/single-source/);
    expect(hunt).toContain("docs/research/<date>-<topic>.md");
    expect(hunt).toContain("## Not found");
  });

  it("is budgeted", () => {
    expect(hunt).toMatch(/two heavy/);
    expect(hunt).toMatch(/time box/);
  });
});

describe("groundbreak/board.md", () => {
  it("seats Musk, Thiel and Feynman as standing seats, plus 2–3 from the bench", () => {
    expectInOrder(board, ["## Standing seats", "Musk", "Thiel", "Feynman", "## The bench"]);
    for (const seat of [
      "Munger",
      "Bezos",
      "Jobs",
      "Carmack",
      "Karpathy",
      "Ohno",
      "Kelly Johnson",
      "Rams",
      "Graham",
      "Taleb",
    ]) {
      expect(board, seat).toContain(seat);
    }
    expect(board).toMatch(/2–3/);
  });

  it("applies tests, never persona role-play, and the owner decides", () => {
    expect(board).toMatch(/never role-play/i);
    expect(board).toMatch(/owner decides/);
    expect(board).toMatch(/named owner/);
  });
});

describe("plan", () => {
  it("agrees test seams before tickets, then tracer-bullet slices", () => {
    expectInOrder(plan, ["test seams", "tracer-bullet"]);
    expect(plan).toMatch(/blocking edges/);
    expect(plan).toMatch(/one context window/);
  });

  it("sorts decisions into mechanical, taste and challenge", () => {
    expectInOrder(plan, ["Mechanical", "Taste", "Challenge"]);
    expect(plan).toMatch(/decided silently/i);
    expect(plan).toMatch(/decided and surfaced/i);
    expect(plan).toMatch(/never auto-decided/i);
  });

  it("describes the spec-run shape and ends at gate 1", () => {
    expect(plan).toMatch(/one integration branch/i);
    expect(plan).toMatch(/at most two implementers/i);
    expect(plan).toMatch(/one pull request/i);
    expect(plan).toMatch(/gate 1/i);
    expect(plan).toContain("templates/ticket.md");
  });
});

describe("templates/ticket.md", () => {
  it("opens with the ask: three plain sentences", () => {
    const firstSection = ticket.match(/^## .+$/m)?.[0];
    expect(firstSection).toBe("## The ask");
    expectInOrder(ticket, ["**Change:**", "**Could break:**", "**You'll know I'm wrong:**"]);
  });

  it("carries every section a builder and reviewer need, in order", () => {
    expectInOrder(ticket, [
      "## The ask",
      "## Scope",
      "## Out of scope",
      "## Designated builder",
      "## Independent reviewers",
      "## Files and reuse",
      "## Acceptance",
      "## Required evidence",
      "## Before asking for the yes",
    ]);
  });
});
