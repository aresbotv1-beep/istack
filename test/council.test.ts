import { describe, expect, it } from "vitest";
import { renderCouncilScores } from "../src/council/markdown.js";
import {
  type CouncilInput,
  councilEligibility,
  type Judge,
  type JudgeRequest,
  RUBRIC,
  runCouncil,
} from "../src/council/run.js";
import { councilLogSchema, type Role } from "../src/council/schema.js";
import { learnBand, median, seededRandom, shuffle } from "../src/council/stats.js";

const PICTURES = {
  before: "/stage/3f1a.png",
  after: "/stage/9c2e.png",
  control: "/stage/77b0.png",
};
const ROLE_OF: Record<string, Role> = {
  [PICTURES.before]: "before",
  [PICTURES.after]: "after",
  [PICTURES.control]: "control",
};

type Script = (role: Role, ctx: { round: number; call: number }) => number;

/** A fake judge: it looks up each picture's role from the test's own map and scores by script. */
function judge(id: string, provider: string, cost: number, script: Script) {
  const requests: JudgeRequest[] = [];
  let round = 1;
  const j: Judge & { requests: JudgeRequest[]; setRound: (n: number) => void } = {
    id,
    provider,
    costUsdPerCall: cost,
    requests,
    setRound: (n) => {
      round = n;
    },
    score: async (request) => {
      requests.push(request);
      const scores: Record<string, number> = {};
      for (const p of request.pictures) {
        scores[p.label] = script(ROLE_OF[p.path] as Role, { round, call: requests.length });
      }
      return { kind: "scores", scores };
    },
  };
  return j;
}

const steady = (role: Role): number => ({ before: 4, after: 7, control: 5 })[role];

function base(overrides: Partial<CouncilInput> = {}): CouncilInput {
  return {
    profile: "factory",
    council: { enabled: true, budgetUsdPerPr: 10 },
    door: "two-way",
    visibleFiles: ["src/app/page.tsx"],
    head: "aaaaaaaaaaaa1111",
    pictures: PICTURES,
    judges: [],
    seed: 42,
    now: () => "2026-11-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("council: planted drift", () => {
  it("discards the round where a judge's control score jumps out of its band, and shows none of its numbers", async () => {
    const cheap = judge("cheap (openai)", "openai", 0.05, (role, { round }) =>
      round === 1 ? steady(role) : { before: 4, after: 6, control: 5 }[role],
    );
    // The planted drifter: steady through baseline and round 1, then everything inflates.
    const drifter = judge("drifter (anthropic)", "anthropic", 0.1, (role, { round }) =>
      round === 1 ? steady(role) : { before: 9, after: 10, control: 9 }[role],
    );
    const pricey = judge("pricey (cursor)", "cursor", 0.2, steady);
    const judges = [pricey, drifter, cheap];

    const first = await runCouncil(base({ judges }));
    expect(first.outcome.status).toBe("kept");

    for (const j of judges) j.setRound(2);
    const pricyCallsBefore = pricey.requests.length;
    const second = await runCouncil(
      base({
        judges,
        log: first.log,
        head: "bbbbbbbbbbbb2222",
        visibleChangedSinceLastRound: ["src/app/page.tsx"],
        seed: 43,
      }),
    );

    expect(second.outcome.status).toBe("discarded");
    expect(second.outcome.reason).toContain("control drift: drifter (anthropic)");
    // Cheapest first: the drift is caught before the priciest judge is paid.
    expect(pricey.requests.length).toBe(pricyCallsBefore);

    const round2 = second.log.rounds[1];
    expect(round2?.status).toBe("discarded");
    expect(round2?.judges.find((j) => j.judge === "drifter (anthropic)")?.controlInBand).toBe(
      false,
    );

    const table = renderCouncilScores(second.log);
    expect(table).toContain("No council scores.");
    expect(table).toContain("discarded");
    expect(table).not.toContain("| Judge |");
    // Round 2's numbers (cheap judge's 6, drifter's 9 and 10) appear nowhere as scores.
    expect(table).not.toMatch(/\| (6|9|10) \|/);
    const discardLine = table.split("\n").find((l) => l.startsWith("**No council scores.**"));
    expect(discardLine).toBeDefined();
    // Only the round number and the baseline band (4–6, learned from 5s) appear in it.
    expect(discardLine?.match(/\d+/g)?.sort()).toEqual(["2", "4", "5", "5", "5", "5", "5", "6"]);
    // The drifted score is kept in the log for anyone auditing the discard.
    expect(round2?.judges.find((j) => j.judge === "drifter (anthropic)")?.median?.control).toBe(9);
    expect(councilLogSchema.safeParse(second.log).success).toBe(true);
  });
});

describe("council: runner", () => {
  it("keeps an honest round and reports the median of three samples per judge", async () => {
    let n = 0;
    const wobbly = judge("wobbly (openai)", "openai", 0.05, (role) => {
      n += 1;
      // Baseline: control 5 every time. Round samples vary; medians are before 4, after 7.
      const roundSamples = [
        { before: 3, after: 7, control: 5 },
        { before: 4, after: 9, control: 6 },
        { before: 5, after: 6, control: 5 },
      ];
      const call = Math.ceil(n / 3);
      if (call <= 5) return role === "control" ? 5 : 1;
      return (roundSamples[call - 6] as Record<Role, number>)[role];
    });
    const other = judge("other (anthropic)", "anthropic", 0.1, steady);
    const result = await runCouncil(base({ judges: [wobbly, other] }));
    expect(result.outcome.status).toBe("kept");
    const w = result.log.rounds[0]?.judges.find((j) => j.judge === "wobbly (openai)");
    expect(w?.median).toEqual({ before: 4, after: 7, control: 5 });
    expect(w?.samples.filter((s) => s.phase === "baseline")).toHaveLength(5);
    expect(w?.samples.filter((s) => s.phase === "round")).toHaveLength(3);
    expect(result.log.bands["wobbly (openai)"]).toMatchObject({ center: 5, low: 4, high: 6 });

    const table = renderCouncilScores(result.log);
    expect(table).toContain("| wobbly (openai) | 4 | 7 | 5 | 4–6 | 3 of 3 readable |");
    expect(table).toContain("not a merge gate");
  });

  it("hides the target: neutral labels, neutral rubric, and a seeded random order", async () => {
    const a = judge("a (openai)", "openai", 0.05, steady);
    const b = judge("b (anthropic)", "anthropic", 0.1, steady);
    const first = await runCouncil(base({ judges: [a, b] }));
    for (const request of a.requests) {
      expect(request.rubric).toBe(RUBRIC);
      expect(request.pictures.map((p) => p.label)).toEqual(["Picture 1", "Picture 2", "Picture 3"]);
    }
    expect(RUBRIC).not.toMatch(/before|after|control|goal|expected|target/i);
    const orders = new Set(
      first.log.rounds[0]?.judges.flatMap((j) => j.samples.map((s) => s.order.join())),
    );
    expect(orders.size).toBeGreaterThan(1);

    const again = await runCouncil(
      base({
        judges: [
          judge("a (openai)", "openai", 0.05, steady),
          judge("b (anthropic)", "anthropic", 0.1, steady),
        ],
      }),
    );
    expect(again.log).toEqual(first.log);
  });

  it("refuses to start a round the budget cannot cover: no council (budget), no calls", async () => {
    const a = judge("a (openai)", "openai", 1, steady);
    const b = judge("b (anthropic)", "anthropic", 1, steady);
    // First round needs (5 baseline + 3) × 2 judges × $1 = $16 > $10.
    const result = await runCouncil(base({ judges: [a, b] }));
    expect(result.outcome.status).toBe("budget");
    expect(result.outcome.reason).toMatch(/^no council \(budget\)/);
    expect(a.requests.length + b.requests.length).toBe(0);
    const table = renderCouncilScores(result.log);
    expect(table).toContain("**No council**");
    expect(table).not.toContain("| Judge |");
  });

  it("stops before a call that measured costs would push over the budget, and shows no partial scores", async () => {
    const a = judge("a (openai)", "openai", 0.05, steady);
    const expensive: Judge = {
      id: "b (anthropic)",
      provider: "anthropic",
      costUsdPerCall: 0.1,
      score: async (req) => ({
        kind: "scores",
        scores: Object.fromEntries(req.pictures.map((p) => [p.label, 5])),
        costUsd: 2.5, // measured: far above the estimate
      }),
    };
    const result = await runCouncil(base({ judges: [a, expensive] }));
    expect(result.outcome.status).toBe("budget");
    expect(result.log.spentUsd).toBeLessThanOrEqual(10);
    expect(renderCouncilScores(result.log)).not.toContain("| Judge |");
    const costs = result.log.rounds[0]?.judges[1]?.samples.map((s) => s.costSource);
    expect(costs?.every((c) => c === "measured")).toBe(true);
  });

  // F8: the budget is admitted on estimates; a call can still report more than was left.
  it("tells each judge what is left, and records and renders a measured overrun", async () => {
    const limits: (number | undefined)[] = [];
    const judges: Judge[] = ["a", "b"].map((provider) => ({
      id: provider,
      provider,
      costUsdPerCall: 0.001,
      score: async (req) => {
        limits.push(req.maxBudgetUsd);
        return {
          kind: "scores",
          scores: Object.fromEntries(req.pictures.map((p) => [p.label, 5])),
          costUsd: 5,
        };
      },
    }));
    const result = await runCouncil(
      base({
        council: { enabled: true, budgetUsdPerPr: 0.01 },
        judges,
        options: { samples: 1, baselineSamples: 1 },
      }),
    );
    expect(limits).toEqual([0.01]);
    expect(result.outcome.status).toBe("budget");
    expect(result.log.spentUsd).toBe(5);
    expect(result.log.rounds[0]?.overrunUsd).toBe(4.99);
    expect(result.outcome.reason).toMatch(/over the budget by \$4\.99/);
    const table = renderCouncilScores(result.log);
    expect(table).toMatch(/over the \$0\.01 budget by \$4\.99/);
    expect(table).not.toContain("| Judge |");
  });

  // F17: a sub-precision overrun must not write a log the schema then refuses to read.
  it("keeps every log it writes readable, whatever the measured cost's precision", async () => {
    for (const cost of [5, 0.0101, 0.0100001, 0.01]) {
      const judges: Judge[] = ["a", "b"].map((provider) => ({
        id: provider,
        provider,
        costUsdPerCall: 0.001,
        score: async (req) => ({
          kind: "scores",
          scores: Object.fromEntries(req.pictures.map((p) => [p.label, 5])),
          costUsd: cost,
        }),
      }));
      const result = await runCouncil(
        base({
          council: { enabled: true, budgetUsdPerPr: 0.01 },
          judges,
          options: { samples: 1, baselineSamples: 1 },
        }),
      );
      const parsed = councilLogSchema.safeParse(JSON.parse(JSON.stringify(result.log)));
      expect(parsed.success, `cost ${cost}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("a judge that fails a sample gets no score, never a guessed one", async () => {
    let calls = 0;
    const flaky: Judge = {
      id: "flaky (openai)",
      provider: "openai",
      costUsdPerCall: 0.05,
      score: async (req) => {
        calls += 1;
        if (calls === 7) return { kind: "error", message: "timed out" };
        return {
          kind: "scores",
          scores: Object.fromEntries(req.pictures.map((p) => [p.label, 5])),
        };
      },
    };
    const b = judge("b (anthropic)", "anthropic", 0.1, steady);
    const result = await runCouncil(base({ judges: [flaky, b] }));
    expect(result.outcome.status).toBe("kept");
    const table = renderCouncilScores(result.log);
    expect(table).toMatch(
      /\| flaky \(openai\) \| no score \(2 of 3 samples readable: no score\) \| no score \| no score \|/,
    );
    expect(table).toContain("| b (anthropic) | 4 | 7 | 5 |");
  });

  it("a brand-new screen (no before) shows 'absent' for before", async () => {
    const a = judge("a (openai)", "openai", 0.05, steady);
    const b = judge("b (anthropic)", "anthropic", 0.1, steady);
    const result = await runCouncil(
      base({ judges: [a, b], pictures: { after: PICTURES.after, control: PICTURES.control } }),
    );
    expect(a.requests[0]?.pictures).toHaveLength(2);
    expect(renderCouncilScores(result.log)).toContain("| a (openai) | absent | 7 | 5 |");
  });

  it("needs judges from at least two providers", async () => {
    const a = judge("a (openai)", "openai", 0.05, steady);
    const result = await runCouncil(base({ judges: [a] }));
    expect(result.outcome).toMatchObject({ status: "skipped" });
    expect(a.requests).toHaveLength(0);
  });
});

describe("council: when it runs", () => {
  const ok = { profile: "factory", council: { enabled: true, budgetUsdPerPr: 10 } } as const;

  it("runs only in the factory profile with the council enabled", () => {
    expect(councilEligibility({ ...ok, profile: "team", visibleFiles: ["a.tsx"] })).toMatchObject({
      run: false,
    });
    expect(
      councilEligibility({
        ...ok,
        council: { enabled: false, budgetUsdPerPr: 10 },
        visibleFiles: ["a.tsx"],
      }),
    ).toMatchObject({ run: false });
    expect(councilEligibility({ ...ok, visibleFiles: ["a.tsx"] })).toEqual({ run: true });
  });

  it("runs for a visible change or a one-way door, not for an invisible two-way change", () => {
    expect(councilEligibility({ ...ok, visibleFiles: [], door: "two-way" })).toMatchObject({
      run: false,
    });
    expect(councilEligibility({ ...ok, visibleFiles: [], door: "one-way" })).toEqual({ run: true });
  });

  it("rescores only when visible files changed since the last round", async () => {
    const a = judge("a (openai)", "openai", 0.05, steady);
    const b = judge("b (anthropic)", "anthropic", 0.1, steady);
    const first = await runCouncil(base({ judges: [a, b] }));
    const calls = a.requests.length;
    const unchanged = await runCouncil(
      base({ judges: [a, b], log: first.log, visibleChangedSinceLastRound: [] }),
    );
    expect(unchanged.outcome).toMatchObject({ status: "skipped" });
    expect(unchanged.outcome.reason).toContain("round 1 stands");
    expect(unchanged.log).toEqual(first.log);
    expect(a.requests.length).toBe(calls);

    const unknown = await runCouncil(base({ judges: [a, b], log: first.log }));
    expect(unknown.outcome).toMatchObject({ status: "skipped" });

    const changed = await runCouncil(
      base({ judges: [a, b], log: first.log, visibleChangedSinceLastRound: ["a.tsx"] }),
    );
    expect(changed.outcome.status).toBe("kept");
    // Bands are learned once: round 2 pays for no new baseline.
    expect(changed.log.rounds[1]?.judges[0]?.samples.every((s) => s.phase === "round")).toBe(true);
  });
});

describe("council: stats", () => {
  it("median, band and seeded shuffle", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(learnBand([5, 5, 5, 5, 5], 2, 1)).toMatchObject({ low: 4, high: 6 });
    expect(learnBand([4, 5, 6, 5, 7], 2, 1)).toMatchObject({
      center: 5,
      halfWidth: 2,
      low: 3,
      high: 7,
    });
    const order = shuffle([1, 2, 3, 4], seededRandom(7));
    expect(shuffle([1, 2, 3, 4], seededRandom(7))).toEqual(order);
    expect([...order].sort()).toEqual([1, 2, 3, 4]);
  });
});
