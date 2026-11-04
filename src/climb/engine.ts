import { median, medianAbsoluteDeviation } from "../council/stats.js";

/**
 * The climb engine. It never improves by noise: a change is kept only when it beats the measured
 * noise twice (the candidate run and a fresh confirm run), with the regression checks green, and
 * without touching the frozen harness. Anything else is fully reverted. The target never moves.
 *
 * Higher scores are better. For a lower-is-better metric, have the harness print its negative.
 */

/** A candidate move on the ladder, before anything is spent on it. */
export interface LadderMove {
  id: string;
  /** Expected score gain, in harness units. A guess, used only to order the ladder. */
  expectedGain: number;
  /** Expected cost (minutes, dollars, lines: any unit, the same for every move). */
  cost: number;
}

/** One change the engine can try and take back. */
export interface ClimbChange extends LadderMove {
  apply: () => Promise<void>;
  /** Must put the tree back exactly as it was before `apply`. */
  revert: () => Promise<void>;
}

export interface ClimbHarness {
  /** Run the frozen harness `runs` times. One score per run; a run that gave no score is NaN. */
  measure: (runs: number) => Promise<number[]>;
  /** The regression checks. Only run for a change that already beat the noise. */
  regressions: () => Promise<{ green: boolean; detail: string }>;
  /** A fingerprint of the frozen harness (its files, its command). Must not change. */
  fingerprint: () => Promise<string>;
  /** True when the tree matches the last kept state exactly. Checked after every revert. */
  restored: () => Promise<boolean>;
  /** Record a kept win: one commit per kept change. */
  commit: (change: ClimbChange, summary: string) => Promise<void>;
}

export interface ClimbInput {
  /** The score to reach. Never lowered by the engine; a climb that falls short says so. */
  target: number;
  /** The climb may not report "short" before this many moves were tried. */
  minAttempts: number;
  /** Harness runs per measurement; the score of a measurement is the median. At least 3. */
  runs: number;
  /** The smallest gain ever counted as real, in harness units. */
  noiseFloor: number;
  /** Multiplier on the median absolute deviation. */
  k: number;
  /** Re-measure a winning change before keeping it (default true). */
  confirm: boolean;
  /** A planted change known to make things worse. It must move the score, or the climb refuses. */
  sensitivity: ClimbChange;
  moves: ClimbChange[];
  harness: ClimbHarness;
  /** Called with each decision row as it is made, so a crash still leaves the record. */
  record?: (row: DecisionRow) => void;
}

export type Decision = "keep" | "revert" | "refuse";

export interface DecisionRow {
  /** 0 is the sensitivity check; moves count from 1. */
  iteration: number;
  change: string;
  baselineMedian: number;
  /** Absent when the change never produced a full measurement. */
  candidateMedian?: number;
  noise?: number;
  decision: Decision;
  reason: string;
}

export type ClimbStatus =
  /** The baseline median reached the target. */
  | "reached"
  /** At least `minAttempts` moves were tried and the target was not reached. */
  | "short"
  /** The moves ran out before `minAttempts`: plan more moves before calling the target unreachable. */
  | "too-few-attempts"
  /** The planted bad change did not move the score: the harness cannot tell better from worse. */
  | "insensitive"
  /** A measurement or revert failed in a way that leaves the baseline untrustworthy. */
  | "broken";

export interface ClimbResult {
  status: ClimbStatus;
  reason: string;
  target: number;
  startMedian?: number;
  finalMedian?: number;
  attempts: number;
  kept: string[];
  rows: DecisionRow[];
}

/**
 * The noise a gain must beat: max(floor, k × MAD(baseline), k × MAD(candidate)). Using the wider
 * of the two spreads means a change that makes the harness jumpier has to clear a higher bar.
 */
export function noiseOf(
  baseline: readonly number[],
  candidate: readonly number[],
  floor: number,
  k: number,
): number {
  return Math.max(
    floor,
    k * medianAbsoluteDeviation(baseline),
    k * medianAbsoluteDeviation(candidate),
  );
}

/** Lowest-hanging first: highest expected gain per unit of cost, then the cheaper move. Stable. */
export function orderLadder<T extends LadderMove>(moves: readonly T[]): T[] {
  const ratio = (m: LadderMove) =>
    m.cost > 0 ? m.expectedGain / m.cost : Number.POSITIVE_INFINITY;
  return moves
    .map((move, index) => ({ move, index }))
    .sort((a, b) => ratio(b.move) - ratio(a.move) || a.move.cost - b.move.cost || a.index - b.index)
    .map(({ move }) => move);
}

export async function runClimb(input: ClimbInput): Promise<ClimbResult> {
  if (!Number.isInteger(input.runs) || input.runs < 3) {
    throw new Error(
      "runs must be a whole number of at least 3 (a median of fewer is not a median)",
    );
  }
  if (!(input.noiseFloor >= 0) || !(input.k >= 0)) {
    throw new Error("noiseFloor and k must be zero or more");
  }
  const { harness } = input;
  const rows: DecisionRow[] = [];
  const kept: string[] = [];
  let attempts = 0;
  const push = (row: DecisionRow) => {
    rows.push(row);
    input.record?.(row);
  };
  const result = (
    status: ClimbStatus,
    reason: string,
    medians: { start?: number; final?: number },
  ): ClimbResult => ({
    status,
    reason,
    target: input.target,
    startMedian: medians.start,
    finalMedian: medians.final,
    attempts,
    kept,
    rows,
  });

  const frozen = await harness.fingerprint();
  const first = await measure(harness, input.runs);
  if (!first.ok) return result("broken", `baseline: ${first.reason}`, {});
  let baseline = first.samples;
  const start = median(baseline);

  // 1. Prove the harness is sensitive: a planted bad change must drop the score beyond noise.
  const bad = await tryChange(input.sensitivity, async () => {
    const m = await measure(harness, input.runs);
    if (!m.ok) return { done: "refuse", reason: `sensitivity check: ${m.reason}` };
    const noise = noiseOf(baseline, m.samples, input.noiseFloor, input.k);
    const delta = median(m.samples) - start;
    return delta < -noise
      ? {
          done: "revert",
          sensitive: true,
          candidate: m.samples,
          noise,
          reason: `sensitivity check passed: the planted bad change moved the median ${fmt(delta)}, beyond noise ${num(noise)}`,
        }
      : {
          done: "refuse",
          candidate: m.samples,
          noise,
          reason: `sensitivity check failed: the planted bad change moved the median ${fmt(delta)}, not beyond noise ${num(noise)}; the harness cannot tell worse from better`,
        };
  });
  push({ iteration: 0, change: input.sensitivity.id, baselineMedian: start, ...bad.row });
  if (bad.broken) return result("broken", bad.broken, { start, final: start });
  // Only an explicitly passed measurement proves sensitivity; a failed apply or measurement does not.
  if (!bad.sensitive) return result("insensitive", bad.row.reason, { start });

  if (start >= input.target) {
    return result(
      "reached",
      `the baseline median ${num(start)} already meets the target ${num(input.target)}`,
      {
        start,
        final: start,
      },
    );
  }

  // 2. Climb: one change per iteration, lowest-hanging first.
  for (const change of orderLadder(input.moves)) {
    attempts += 1;
    const before = median(baseline);
    const outcome = await tryChange(change, async () => {
      const m = await measure(harness, input.runs);
      if (!m.ok) return { done: "revert", reason: m.reason };
      const noise = noiseOf(baseline, m.samples, input.noiseFloor, input.k);
      const gain = median(m.samples) - before;
      const seen = { candidate: m.samples, noise };
      if (!(gain > noise)) {
        return {
          done: "revert",
          ...seen,
          reason: `no gain beyond noise: ${fmt(gain)} is not more than ${num(noise)}`,
        };
      }
      const checks = await harness.regressions();
      if (!checks.green)
        return { done: "revert", ...seen, reason: `regressions red: ${checks.detail}` };
      let next = m.samples;
      if (input.confirm) {
        const again = await measure(harness, input.runs);
        if (!again.ok)
          return { done: "revert", ...seen, reason: `confirm re-run: ${again.reason}` };
        const confirmNoise = noiseOf(baseline, again.samples, input.noiseFloor, input.k);
        const confirmGain = median(again.samples) - before;
        if (!(confirmGain > confirmNoise)) {
          return {
            done: "revert",
            ...seen,
            reason: `confirm re-run did not hold: ${fmt(confirmGain)} is not more than ${num(confirmNoise)} (first run ${fmt(gain)})`,
          };
        }
        next = again.samples;
      }
      return {
        done: "keep",
        ...seen,
        next,
        reason: `gain ${fmt(gain)} beats noise ${num(noise)}${input.confirm ? `, confirmed at ${fmt(median(next) - before)}` : ""}; regressions green`,
      };
    });
    push({ iteration: attempts, change: change.id, baselineMedian: before, ...outcome.row });
    if (outcome.broken) {
      return result("broken", outcome.broken, { start, final: median(baseline) });
    }
    if (outcome.row.decision === "keep" && outcome.next) {
      // The confirm samples become the new baseline: they were not used to pick the winner.
      baseline = outcome.next;
      kept.push(change.id);
      await harness.commit(
        change,
        `climb: keep ${change.id} (median ${num(before)} -> ${num(median(baseline))})`,
      );
      if (median(baseline) >= input.target) {
        return result(
          "reached",
          `median ${num(median(baseline))} meets the target ${num(input.target)}`,
          {
            start,
            final: median(baseline),
          },
        );
      }
    }
  }

  const final = median(baseline);
  if (attempts < input.minAttempts) {
    return result(
      "too-few-attempts",
      `only ${attempts} of the minimum ${input.minAttempts} attempts were planned; add moves to the ladder before calling the target unreachable`,
      { start, final },
    );
  }
  return result(
    "short",
    `median ${num(final)} is short of the target ${num(input.target)} after ${attempts} attempts; the target stands`,
    { start, final },
  );

  /**
   * Apply, check the harness is untouched, judge, check the harness again, and revert unless
   * kept. The second check runs after every measurement and regression check, immediately before
   * a keep (and so before its commit) or a passed sensitivity check: a harness that changed while
   * it was measuring gave no trustworthy number. A revert that does not restore the tree (or the
   * harness) is "broken": nothing after it could be trusted.
   */
  async function tryChange(
    change: ClimbChange,
    judge: () => Promise<{
      done: Decision;
      reason: string;
      candidate?: number[];
      noise?: number;
      next?: number[];
      /** Set only by a sensitivity measurement that saw the planted bad change. */
      sensitive?: boolean;
    }>,
  ): Promise<{
    row: Omit<DecisionRow, "iteration" | "change" | "baselineMedian">;
    next?: number[];
    sensitive?: boolean;
    broken?: string;
  }> {
    const planted = change === input.sensitivity;
    const notTrusted = planted ? "refuse" : "revert";
    let verdict: Awaited<ReturnType<typeof judge>>;
    try {
      await change.apply();
      verdict =
        (await harness.fingerprint()) === frozen
          ? await judge()
          : { done: notTrusted, reason: "the change touched the frozen harness" };
      if (
        (verdict.done === "keep" || verdict.sensitive) &&
        (await harness.fingerprint()) !== frozen
      ) {
        verdict = {
          done: notTrusted,
          candidate: verdict.candidate,
          noise: verdict.noise,
          reason: "the frozen harness changed while the change was measured or checked",
        };
      }
    } catch (error) {
      const why = `apply failed: ${(error as Error).message}`;
      verdict = {
        done: notTrusted,
        reason: planted ? `sensitivity check could not run: ${why}` : why,
      };
    }
    const row = {
      candidateMedian: verdict.candidate ? median(verdict.candidate) : undefined,
      noise: verdict.noise,
      decision: verdict.done,
      reason: verdict.reason,
    };
    if (verdict.done === "keep") return { row, next: verdict.next };

    let broken: string | undefined;
    try {
      await change.revert();
      if (!(await harness.restored())) broken = `revert of ${change.id} did not restore the tree`;
      else if ((await harness.fingerprint()) !== frozen) {
        broken = `revert of ${change.id} did not restore the frozen harness`;
      }
    } catch (error) {
      broken = `revert of ${change.id} failed: ${(error as Error).message}`;
    }
    return { row, broken, sensitive: verdict.sensitive === true };
  }
}

async function measure(
  harness: ClimbHarness,
  runs: number,
): Promise<{ ok: true; samples: number[] } | { ok: false; reason: string }> {
  let samples: number[];
  try {
    samples = await harness.measure(runs);
  } catch (error) {
    return { ok: false, reason: `measurement failed: ${(error as Error).message}` };
  }
  const scored = samples.filter((s) => Number.isFinite(s));
  if (samples.length !== runs || scored.length !== runs) {
    return {
      ok: false,
      reason: `measurement incomplete: ${scored.length} of ${runs} runs gave a score`,
    };
  }
  return { ok: true, samples: scored };
}

function num(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

/** A signed difference: "+0.5", "-3", "0". */
function fmt(value: number): string {
  const text = num(value);
  return value > 0 && text !== "0" ? `+${text}` : text;
}

const HEADER = [
  "iteration",
  "change",
  "baseline_median",
  "candidate_median",
  "noise",
  "decision",
  "reason",
];

function cell(value: string | number | undefined): string {
  if (value === undefined) return "-";
  if (typeof value === "number") return num(value);
  return value.replace(/[\t\r\n]+/g, " ");
}

export function decisionTsvRow(row: DecisionRow): string {
  return `${[
    row.iteration,
    row.change,
    row.baselineMedian,
    row.candidateMedian,
    row.noise,
    row.decision,
    row.reason,
  ]
    .map(cell)
    .join("\t")}\n`;
}

export const DECISION_TSV_HEADER = `${HEADER.join("\t")}\n`;

export function decisionTsv(rows: readonly DecisionRow[]): string {
  return DECISION_TSV_HEADER + rows.map(decisionTsvRow).join("");
}
