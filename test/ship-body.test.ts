import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractReceipts } from "../src/receipts/extract.js";
import { runReview } from "../src/review/ledger.js";
import {
  loadPrBodyTemplate,
  PR_BODY_VISIBLE_TARGET,
  type PrBodyInput,
  renderPrBody,
} from "../src/ship/body.js";

const reviewer = "codex exec (openai)";

/** The body a reader sees without opening a folded block. */
function visible(body: string): string {
  return body.replace(/<details>[\s\S]*?<\/details>/g, "");
}

function section(body: string, heading: string): string {
  return body.split(`## ${heading}\n`)[1]?.split(/^## /m)[0] ?? "";
}

function input(overrides: Partial<PrBodyInput> = {}): PrBodyInput {
  return {
    problem: "Saving the settings twice added two rows, so the list showed every setting twice.",
    summary: "```\nsave() -> dedupe(rows) -> write\n```",
    evidence: "Red then green on `npm test -- save`.",
    notTested: "Two browser tabs saving at the same moment.",
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
  it("opens with the problem, then every section in order, receipts folded at the end", () => {
    const result = renderPrBody(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.startsWith("Saving the settings twice added two rows")).toBe(true);
    const headings = [...result.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Summary",
      "Evidence",
      "Not tested",
      "Merge danger",
      "Try it yourself",
      "Review",
      "Risks and follow-ups",
    ]);
    expect(result.body).toContain("Two browser tabs saving at the same moment.");
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
    expect(result.body).toMatch(/<details><summary>Receipts<\/summary>\n\n```receipts\n/);
    expect(result.body.trimEnd().endsWith("```\n\n</details>")).toBe(true);
    expect(visible(result.body)).not.toContain("```receipts");
  });

  it("refuses to render without the problem or the not-tested line", () => {
    for (const [field, value] of [
      ["problem", undefined],
      ["problem", "  "],
      ["notTested", undefined],
      ["notTested", ""],
    ] as const) {
      const result = renderPrBody(input({ [field]: value }));
      expect(result.ok, `${field}=${value}`).toBe(false);
      if (result.ok) return;
      expect(result.errors.map((e) => e.path)).toContain(field);
    }
  });

  it("shows one line per reviewer and folds the round-by-round log", () => {
    const changes = runReview({
      reviewer: "second (openai)",
      rounds: [
        {
          reply: { kind: "reply", text: "VERDICT: CHANGES\nS1 [should] off by one" },
          outcomes: { S1: { kind: "fixed", note: "abc" } },
        },
        { reply: { kind: "reply", text: "VERDICT: APPROVE" } },
      ],
    });
    const result = renderPrBody(input({ reviews: [...input().reviews, changes] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const review = section(visible(result.body), "Review");
    expect(review).toContain(`- **${reviewer}**: approved, 1 of 3 rounds, no score`);
    expect(review).toContain("- **second (openai)**: approved, 2 of 3 rounds, no score");
    expect(review).not.toContain("| S1 |");
    expect(result.body).toMatch(/<details><summary>Review log<\/summary>[\s\S]*\| S1 \| should \|/);
  });

  it("shows open disputes only when there are some", () => {
    const plain = renderPrBody(input());
    expect(plain.ok && plain.body).not.toContain("Open disputes");
    const disputed = runReview({
      reviewer,
      rounds: [1, 2].map((n) => ({
        reply: { kind: "reply" as const, text: "VERDICT: CHANGES\nS1 [should] x" },
        outcomes: { S1: { kind: "disputed" as const, reason: `r${n}` } },
      })),
    });
    const result = renderPrBody(input({ reviews: [disputed] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(visible(result.body)).toMatch(/## Open disputes\n\n- \*\*S1\*\*/);
  });

  it("measures the visible body, outside the folded blocks", () => {
    const result = renderPrBody(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visibleChars).toBe(visible(result.body).length);
    expect(result.visibleChars).toBeLessThan(result.body.length);
  });

  it("counts a literal <details> in the author's text as visible (S1)", () => {
    const code = "```html\n<details>\n" + "x".repeat(2600) + "\n</details>\n```";
    const result = renderPrBody(input({ evidence: code }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visibleChars).toBeGreaterThan(2600);
  });

  it("re-renders PR #2's content under 2,500 visible characters, unhappy verdict in view", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/ship/pr-2-body.json", import.meta.url), "utf8"),
    );
    const result = renderPrBody({ ...fixture, reviews: fixture.reviews.map(runReview) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visibleChars).toBeLessThanOrEqual(PR_BODY_VISIBLE_TARGET);
    expect(PR_BODY_VISIBLE_TARGET).toBe(2500);
    expect(section(visible(result.body), "Review")).toMatch(
      /look-back commits\*\*: \*\*not approved\*\*, 3 of 3 rounds/,
    );
    expect(extractReceipts(result.body).ok).toBe(true);
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
    const verdicts = section(visible(result.body), "Review");
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
