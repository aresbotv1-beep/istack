import { describe, expect, it } from "vitest";
import {
  type ClimbChange,
  type ClimbHarness,
  type ClimbInput,
  type DecisionRow,
  decisionTsv,
  noiseOf,
  orderLadder,
  runClimb,
} from "../src/climb/engine.js";

/**
 * A tiny world: the "code" is a number line of settings, the harness scores them. Noise is a
 * fixed, replayable wobble so tests are deterministic but the harness is not perfectly flat.
 */
function world(options: { wobble?: number[]; insensitive?: boolean } = {}) {
  const state = { quality: 5, broken: false, harnessFile: "v1", dirty: false };
  const committed = { ...state };
  const wobble = options.wobble ?? [0];
  let call = 0;
  const commits: string[] = [];
  const harness: ClimbHarness = {
    measure: async (runs) =>
      Array.from({ length: runs }, () => {
        const w = wobble[call++ % wobble.length] as number;
        return options.insensitive ? 5 + w : state.quality + w;
      }),
    regressions: async () =>
      state.broken ? { green: false, detail: "npm test exited 1" } : { green: true, detail: "" },
    fingerprint: async () => state.harnessFile,
    restored: async () =>
      state.quality === committed.quality &&
      state.broken === committed.broken &&
      state.harnessFile === committed.harnessFile,
    commit: async (change) => {
      Object.assign(committed, state);
      commits.push(change.id);
    },
  };
  const change = (
    id: string,
    edit: (s: typeof state) => void,
    extra: Partial<ClimbChange> = {},
  ): ClimbChange => ({
    id,
    expectedGain: 1,
    cost: 1,
    apply: async () => edit(state),
    revert: async () => {
      Object.assign(state, committed);
    },
    ...extra,
  });
  return { state, committed, harness, change, commits };
}

function input(w: ReturnType<typeof world>, moves: ClimbChange[], over: Partial<ClimbInput> = {}) {
  const rows: DecisionRow[] = [];
  const base: ClimbInput = {
    target: 9,
    minAttempts: 1,
    runs: 5,
    noiseFloor: 0.5,
    k: 2,
    confirm: true,
    sensitivity: w.change("planted-bad", (s) => {
      s.quality -= 3;
    }),
    moves,
    harness: w.harness,
    record: (row) => rows.push(row),
    ...over,
  };
  return { base, rows };
}

describe("climb engine", () => {
  it("reverts a planted no-op change", async () => {
    const w = world({ wobble: [0, 0.2, -0.2, 0.1, -0.1] });
    const { base, rows } = input(w, [w.change("planted-no-op", () => {})]);
    const result = await runClimb(base);
    const row = rows.find((r) => r.change === "planted-no-op");
    expect(row?.decision).toBe("revert");
    expect(row?.reason).toMatch(/beyond noise/);
    expect(result.kept).toEqual([]);
    expect(w.commits).toEqual([]);
    expect(w.state.quality).toBe(5);
  });

  it("keeps a real improvement, commits it once, and moves the baseline", async () => {
    const w = world({ wobble: [0, 0.2, -0.2, 0.1, -0.1] });
    const { base, rows } = input(w, [
      w.change("better", (s) => {
        s.quality += 2;
      }),
    ]);
    const result = await runClimb(base);
    expect(rows.find((r) => r.change === "better")?.decision).toBe("keep");
    expect(w.commits).toEqual(["better"]);
    expect(result.kept).toEqual(["better"]);
    expect(result.finalMedian).toBe(7);
  });

  it("reverts a gain whose regressions are red", async () => {
    const w = world();
    const { base, rows } = input(w, [
      w.change("faster-but-broken", (s) => {
        s.quality += 2;
        s.broken = true;
      }),
    ]);
    await runClimb(base);
    const row = rows.find((r) => r.change === "faster-but-broken");
    expect(row?.decision).toBe("revert");
    expect(row?.reason).toMatch(/regressions red: npm test exited 1/);
    expect(w.state.broken).toBe(false);
  });

  it("reverts a regression in score", async () => {
    const w = world();
    const { base, rows } = input(w, [
      w.change("worse", (s) => {
        s.quality -= 1;
      }),
    ]);
    await runClimb(base);
    expect(rows.find((r) => r.change === "worse")?.decision).toBe("revert");
    expect(w.state.quality).toBe(5);
  });

  it("refuses to climb on a harness a planted bad change cannot move", async () => {
    const w = world({ insensitive: true });
    const { base, rows } = input(w, [
      w.change("better", (s) => {
        s.quality += 2;
      }),
    ]);
    const result = await runClimb(base);
    expect(result.status).toBe("insensitive");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("refuse");
    expect(w.commits).toEqual([]);
  });

  it("reverts a change that edits the frozen harness, even when the score jumps", async () => {
    const w = world();
    const { base, rows } = input(w, [
      w.change("game-the-eval", (s) => {
        s.harnessFile = "v2";
        s.quality += 4;
      }),
    ]);
    const result = await runClimb(base);
    expect(rows.find((r) => r.change === "game-the-eval")?.reason).toMatch(/frozen harness/);
    expect(result.kept).toEqual([]);
    expect(w.state.harnessFile).toBe("v1");
  });

  it("reverts a lucky draw that the confirm re-run does not reproduce", async () => {
    const w = world();
    let measured = 0;
    const lucky: ClimbHarness = {
      ...w.harness,
      // baseline, sensitivity, candidate (lucky high), confirm (back to normal)
      measure: async (runs) => {
        measured += 1;
        const value = measured === 3 ? 8 : measured === 2 ? 2 : 5;
        return Array.from({ length: runs }, () => value);
      },
    };
    const { base, rows } = input(w, [w.change("lucky", () => {})], { harness: lucky });
    await runClimb(base);
    const row = rows.find((r) => r.change === "lucky");
    expect(row?.decision).toBe("revert");
    expect(row?.reason).toMatch(/confirm re-run/);
  });

  it("stops as broken when a revert does not restore the tree", async () => {
    const w = world();
    const sticky = w.change(
      "sticky",
      (s) => {
        s.quality += 0;
        s.broken = true;
      },
      { revert: async () => {} },
    );
    const { base } = input(w, [sticky, w.change("never-tried", () => {})]);
    const result = await runClimb(base);
    expect(result.status).toBe("broken");
    expect(result.attempts).toBe(1);
  });

  it("never relaxes the target: short when moves run out, too-few when under the minimum", async () => {
    const w = world();
    const one = input(w, [w.change("noop", () => {})], { minAttempts: 1 });
    const short = await runClimb(one.base);
    expect(short.status).toBe("short");
    expect(short.target).toBe(9);

    const w2 = world();
    const two = input(w2, [w2.change("noop", () => {})], { minAttempts: 3 });
    expect((await runClimb(two.base)).status).toBe("too-few-attempts");
  });

  it("stops once the target is reached", async () => {
    const w = world();
    const { base, rows } = input(
      w,
      [
        w.change("big", (s) => {
          s.quality = 9.5;
        }),
        w.change("unneeded", (s) => {
          s.quality = 10;
        }),
      ],
      { target: 9 },
    );
    const result = await runClimb(base);
    expect(result.status).toBe("reached");
    expect(rows.map((r) => r.change)).toEqual(["planted-bad", "big"]);
  });

  it("treats a run that gave no score as an incomplete measurement", async () => {
    const w = world();
    let measured = 0;
    const flaky: ClimbHarness = {
      ...w.harness,
      measure: async (runs) => {
        measured += 1;
        const values = await w.harness.measure(runs);
        return measured === 3 ? [...values.slice(1), Number.NaN] : values;
      },
    };
    const { base, rows } = input(
      w,
      [
        w.change("better", (s) => {
          s.quality += 2;
        }),
      ],
      {
        harness: flaky,
      },
    );
    await runClimb(base);
    expect(rows.find((r) => r.change === "better")?.reason).toMatch(/4 of 5 runs/);
  });
});

describe("noise rule", () => {
  it("is the larger of the floor and k × MAD of either sample set", () => {
    expect(noiseOf([5, 5, 5], [5, 5, 5], 0.5, 2)).toBe(0.5);
    expect(noiseOf([4, 5, 6], [5, 5, 5], 0.5, 2)).toBe(2);
    expect(noiseOf([5, 5, 5], [3, 5, 7], 0.5, 2)).toBe(4);
  });
});

describe("ladder", () => {
  it("puts the lowest-hanging moves first: gain per cost, then cheaper first", () => {
    const moves = [
      { id: "rewrite", expectedGain: 3, cost: 10 },
      { id: "flag", expectedGain: 1, cost: 1 },
      { id: "cache", expectedGain: 2, cost: 1 },
      { id: "tweak", expectedGain: 0.5, cost: 0.5 },
    ];
    expect(orderLadder(moves).map((m) => m.id)).toEqual(["cache", "tweak", "flag", "rewrite"]);
  });
});

describe("decision.tsv", () => {
  it("has a header and one tab-separated row per decision, with tabs scrubbed from reasons", () => {
    const tsv = decisionTsv([
      {
        iteration: 1,
        change: "a",
        baselineMedian: 5,
        candidateMedian: 5.25,
        noise: 0.5,
        decision: "revert",
        reason: "no\tgain\nhere",
      },
    ]);
    expect(tsv).toBe(
      "iteration\tchange\tbaseline_median\tcandidate_median\tnoise\tdecision\treason\n" +
        "1\ta\t5\t5.25\t0.5\trevert\tno gain here\n",
    );
  });
});
