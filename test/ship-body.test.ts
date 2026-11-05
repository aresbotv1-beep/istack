import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractReceipts } from "../src/receipts/extract.js";
import { runReview } from "../src/review/ledger.js";
import { loadPrBodyTemplate, type PrBodyInput, renderPrBody } from "../src/ship/body.js";

const reviewer = "codex exec (openai)";

function input(overrides: Partial<PrBodyInput> = {}): PrBodyInput {
  return {
    summary: "```\nsave() -> dedupe(rows) -> write\n```",
    evidence: "Red then green on `npm test -- save`.",
    mergeDanger: { door: "two-way", blastRadius: "the settings page only" },
    tryItYourself: ["`npm run dev`", "Open http://localhost:3000/settings", "Click **Save** twice"],
    reviews: [
      runReview({ reviewer, rounds: [{ reply: { kind: "reply", text: "VERDICT: APPROVE" } }] }),
    ],
    risks: ["Follow-up: dedupe on the server too."],
    receipts: {
      head: "abc1234",
      claims: [
        {
          id: "c1",
          kind: "red-green",
          statement: "saving twice no longer adds two rows",
          command: "npm test -- save",
          red: { sha: "abc1234", exitCode: 1 },
          green: { sha: "abc1234", exitCode: 0 },
        },
      ],
      noVisibleChange: "the fix is in the data layer only",
    },
    ...overrides,
  };
}

describe("renderPrBody", () => {
  it("renders every section in order, ending with one receipts block", () => {
    const result = renderPrBody(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const headings = [...result.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Summary",
      "Evidence",
      "Merge danger",
      "Try it yourself",
      "Reviewer verdicts",
      "Open disputes",
      "Risks and follow-ups",
    ]);
    expect(result.body).toContain("**Door:** two-way");
    expect(result.body).toContain("**Blast radius:** the settings page only");
    expect(result.body).toContain("1. `npm run dev`");
    expect(result.body).toContain("3. Click **Save** twice");
    expect(result.body).not.toMatch(/\{\{/);
    const receipts = extractReceipts(result.body);
    expect(receipts.ok).toBe(true);
    if (!receipts.ok) return;
    expect(receipts.receipts.door).toEqual({
      kind: "two-way",
      blastRadius: "the settings page only",
    });
    expect(result.body.trimEnd().endsWith("```")).toBe(true);
  });

  it("refuses to render without a door", () => {
    const result = renderPrBody(input({ mergeDanger: { blastRadius: "x" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toContain("mergeDanger.door");
  });

  it("refuses to render without try-it-yourself steps", () => {
    for (const tryItYourself of [undefined, [], ["  "]]) {
      const result = renderPrBody(input({ tryItYourself }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.map((e) => e.path)).toContain("tryItYourself");
    }
  });

  it("refuses to render receipts that do not validate", () => {
    const result = renderPrBody(input({ receipts: { head: "not-a-sha", claims: [] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toContain("receipts.head");
  });

  it("carries a timed-out reviewer into the body as not approved", () => {
    const timedOut = runReview({
      reviewer,
      rounds: [{ reply: { kind: "timeout", seconds: 600 } }],
    });
    const result = renderPrBody(input({ reviews: [timedOut] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verdicts =
      result.body.split("## Reviewer verdicts")[1]?.split("## Open disputes")[0] ?? "";
    expect(verdicts).toContain("**not approved**");
    expect(verdicts.replaceAll("not approved", "")).not.toMatch(/\bapproved\b/);
  });

  it("does not re-expand placeholders that appear inside user text", () => {
    const result = renderPrBody(input({ summary: "literal {{evidence}} stays" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain("literal {{evidence}} stays");
  });

  it("rejects a template missing a placeholder", () => {
    const template = loadPrBodyTemplate().replace("{{openDisputes}}", "");
    const result = renderPrBody(input(), template);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toMatch(/openDisputes/);
  });

  it("loads the shipped template from templates/pr-body.md", () => {
    const shipped = readFileSync(new URL("../templates/pr-body.md", import.meta.url), "utf8");
    expect(loadPrBodyTemplate()).toBe(shipped);
  });
});
