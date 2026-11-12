import type { IstackConfig } from "../config/schema.js";
import type { CouncilLog, CouncilRound, JudgeRound, Role, RoleScores, Sample } from "./schema.js";
import { inBand, learnBand, median, seededRandom, shuffle } from "./stats.js";

/**
 * The only instructions a judge gets. It names no goal, no expected answer and no picture's role,
 * so a judge cannot score toward what the builder hoped for.
 */
export const RUBRIC = [
  "You are shown screenshots of a user interface, labelled Picture 1, Picture 2 and so on.",
  "Score each picture on its own from 0 to 10 for how clear, polished and easy to use it looks.",
  "Do not compare them to anything you were not shown. Do not explain.",
  "Reply with one line per picture and nothing else, for example:",
  "Picture 1: 6",
  "Picture 2: 8",
].join("\n");

export interface JudgePicture {
  /** "Picture 1", "Picture 2", … in the order shown. */
  label: string;
  /** A neutrally named copy of the picture; the name must not reveal its role. */
  path: string;
}

export interface JudgeRequest {
  rubric: string;
  pictures: JudgePicture[];
  /**
   * What is left of the budget when the call starts. A judge whose CLI takes a spend limit passes
   * it on (claude -p --max-budget-usd); the others cannot, so a call can still cost more.
   */
  maxBudgetUsd?: number;
}

export type JudgeReply =
  | { kind: "scores"; scores: Record<string, number>; costUsd?: number }
  | { kind: "error"; message: string; costUsd?: number };

export interface Judge {
  /** Shown in the score table, e.g. "codex exec (openai)". */
  id: string;
  provider: string;
  /** Estimated price of one call; used for the budget and when the judge reports no cost. */
  costUsdPerCall: number;
  score: (request: JudgeRequest) => Promise<JudgeReply>;
}

export interface CouncilOptions {
  /** Round samples per judge; the judge's score is their median. */
  samples: number;
  /** Control scorings that teach a judge its band, taken once, the first time it judges. */
  baselineSamples: number;
  /** Band half-width = max(minHalfWidth, bandK × MAD of the baseline). */
  bandK: number;
  minHalfWidth: number;
  /** Fewer distinct providers than this: no council. */
  minProviders: number;
}

export const DEFAULT_OPTIONS: CouncilOptions = {
  samples: 3,
  baselineSamples: 5,
  bandK: 2,
  minHalfWidth: 1,
  minProviders: 2,
};

export interface CouncilInput {
  profile: IstackConfig["profile"];
  council: Pick<IstackConfig["council"], "enabled" | "budgetUsdPerPr">;
  door?: "one-way" | "two-way";
  /** Visible files the PR changes, already matched against visibleChange. */
  visibleFiles: string[];
  /**
   * Visible files changed since the last round's head, already matched. Required once the log
   * has a round: without it the council does not know whether a rescore is due, so it skips.
   */
  visibleChangedSinceLastRound?: string[];
  head: string;
  /** Neutrally named picture paths. `before` is absent for a brand-new screen. */
  pictures: { before?: string; after: string; control: string };
  judges: Judge[];
  log?: CouncilLog;
  seed: number;
  now?: () => string;
  options?: Partial<CouncilOptions>;
  /**
   * Replaces the neutral picture rubric, for councils over something other than screenshots (the
   * skill evals score text replies). It must stay neutral: no goal, no expected answer, no roles.
   */
  rubric?: string;
}

export type CouncilOutcome =
  | { status: "skipped"; reason: string }
  | { status: CouncilRound["status"]; reason: string; round: CouncilRound };

export interface CouncilResult {
  outcome: CouncilOutcome;
  /** The log with the new round appended (unchanged when skipped). Never mutates the input. */
  log: CouncilLog;
}

/** Whether a round should run at all. Pure. */
export function councilEligibility(
  input: Pick<
    CouncilInput,
    "profile" | "council" | "door" | "visibleFiles" | "visibleChangedSinceLastRound" | "log"
  >,
): { run: true } | { run: false; reason: string } {
  if (input.profile !== "factory") {
    return {
      run: false,
      reason: `the council runs only in the factory profile (this repo is ${input.profile})`,
    };
  }
  if (!input.council.enabled)
    return { run: false, reason: "the council is disabled in istack.yaml" };
  if (input.visibleFiles.length === 0 && input.door !== "one-way") {
    return { run: false, reason: "no visible change and the door is two-way" };
  }
  const last = input.log?.rounds.at(-1);
  if (last) {
    if (input.visibleChangedSinceLastRound === undefined) {
      return {
        run: false,
        reason: `round ${last.number} exists; say which visible files changed since ${last.head} before rescoring`,
      };
    }
    if (input.visibleChangedSinceLastRound.length === 0) {
      return {
        run: false,
        reason: `no visible file changed since round ${last.number} (${last.head}); round ${last.number} stands`,
      };
    }
  }
  return { run: true };
}

/**
 * Run one council round. Judges go cheapest first; each sees the pictures in a fresh random order
 * with the neutral rubric. A judge's score is the median of its samples. The control picture is
 * scored in every call; if any judge's control median leaves the band learned from its baseline,
 * the whole round is discarded and the remaining judges are not called.
 *
 * The per-PR budget is enforced before each call, on the judge's price (its estimate, or the most
 * it has really cost) plus what was already spent: a round whose estimate does not fit never
 * starts, and a call that would not fit is never made. It is not a hard cap: a call can report
 * more than was left. Each call is told what is left, for CLIs that take a spend limit; when one
 * still goes over, the overrun is recorded on the round and the round stops as a budget stop.
 * So the budget can be exceeded by at most one call's overrun.
 */
export async function runCouncil(input: CouncilInput): Promise<CouncilResult> {
  const options = { ...DEFAULT_OPTIONS, ...input.options };
  const log: CouncilLog = input.log
    ? structuredClone(input.log)
    : { version: 1, budgetUsd: input.council.budgetUsdPerPr, spentUsd: 0, bands: {}, rounds: [] };
  log.budgetUsd = input.council.budgetUsdPerPr;

  const eligible = councilEligibility(input);
  if (!eligible.run) return { outcome: { status: "skipped", reason: eligible.reason }, log };

  const providers = new Set(input.judges.map((j) => j.provider.toLowerCase()));
  if (providers.size < options.minProviders) {
    return {
      outcome: {
        status: "skipped",
        reason: `no council: needs judges from ${options.minProviders} providers, found ${providers.size}`,
      },
      log,
    };
  }

  const judges = [...input.judges].sort(
    (a, b) => a.costUsdPerCall - b.costUsdPerCall || a.id.localeCompare(b.id),
  );
  const round: CouncilRound = {
    number: log.rounds.length + 1,
    head: input.head,
    at: (input.now ?? (() => new Date().toISOString()))(),
    seed: input.seed,
    visibleFiles: [...(input.visibleChangedSinceLastRound ?? input.visibleFiles)],
    status: "kept",
    reason: "",
    judges: [],
    costUsd: 0,
  };
  const finish = (status: CouncilRound["status"], reason: string): CouncilResult => {
    round.status = status;
    round.reason = reason;
    round.costUsd = roundMoney(round.costUsd);
    log.spentUsd = roundMoney(log.spentUsd);
    log.rounds.push(round);
    return { outcome: { status, reason, round }, log };
  };

  // A judge's price is its estimate, or the most it has really cost per call, whichever is higher.
  const price = (judge: Judge): number => {
    const measured = log.rounds
      .flatMap((r) => r.judges.filter((j) => j.judge === judge.id))
      .concat(round.judges.filter((j) => j.judge === judge.id))
      .flatMap((j) => j.samples)
      .filter((s) => s.costSource === "measured")
      .map((s) => s.costUsd);
    return Math.max(judge.costUsdPerCall, ...measured);
  };
  const estimate = judges.reduce(
    (sum, j) =>
      sum + price(j) * (options.samples + (log.bands[j.id] ? 0 : options.baselineSamples)),
    0,
  );
  const left = log.budgetUsd - log.spentUsd;
  if (estimate > left + 1e-9) {
    return finish(
      "budget",
      `no council (budget): this round would cost about ${usd(estimate)}, ${usd(Math.max(0, left))} of ${usd(log.budgetUsd)} is left`,
    );
  }

  const roles: Role[] = input.pictures.before
    ? ["before", "after", "control"]
    : ["after", "control"];
  const random = seededRandom(input.seed);
  const rubric = input.rubric ?? RUBRIC;
  /** Set when a call's cost took the log past the budget. */
  let overrun: string | undefined;

  for (const [index, judge] of judges.entries()) {
    const record: JudgeRound = {
      judge: judge.id,
      provider: judge.provider,
      samples: [],
      controlInBand: null,
    };
    round.judges.push(record);

    const call = async (phase: Sample["phase"]): Promise<Sample | "budget"> => {
      if (log.spentUsd + price(judge) > log.budgetUsd + 1e-9) return "budget";
      const left = roundMoney(log.budgetUsd - log.spentUsd);
      const sample = await callJudge(judge, phase, roles, input.pictures, random, rubric, left);
      record.samples.push(sample);
      log.spentUsd += sample.costUsd;
      round.costUsd += sample.costUsd;
      // Compare, store and validate at the same precision: an overrun that rounds to zero is
      // within the budget, so it is never written as a zero the schema would refuse.
      const over = roundMoney(log.spentUsd - log.budgetUsd);
      if (over > 0) {
        round.overrunUsd = over;
        overrun = `a call to ${judge.id} cost ${usd(sample.costUsd)} (${sample.costSource}) with ${usd(left)} left`;
        return "budget";
      }
      return sample;
    };
    const outOfBudget = () =>
      finish(
        "budget",
        overrun
          ? `no council (budget): ${overrun}; ${usd(log.spentUsd)} of ${usd(log.budgetUsd)} spent, over the budget by ${usd(round.overrunUsd ?? 0)}`
          : `no council (budget): stopped before a call to ${judge.id}; ${usd(log.spentUsd)} of ${usd(log.budgetUsd)} spent`,
      );

    if (!log.bands[judge.id]) {
      const controls: number[] = [];
      for (let i = 0; i < options.baselineSamples; i += 1) {
        const sample = await call("baseline");
        if (sample === "budget") return outOfBudget();
        if (sample.scores) controls.push(sample.scores.control);
      }
      if (controls.length < options.baselineSamples) {
        record.note = `baseline incomplete (${controls.length} of ${options.baselineSamples} readable): no band, so no score`;
        continue;
      }
      log.bands[judge.id] = learnBand(controls, options.bandK, options.minHalfWidth);
    }
    const band = log.bands[judge.id];

    const scored: RoleScores[] = [];
    for (let i = 0; i < options.samples; i += 1) {
      const sample = await call("round");
      if (sample === "budget") return outOfBudget();
      if (sample.scores) scored.push(sample.scores);
    }
    if (scored.length < options.samples) {
      record.note = `${scored.length} of ${options.samples} samples readable: no score`;
      continue;
    }
    record.median = medianScores(scored, roles);
    record.controlInBand = band ? inBand(record.median.control, band) : null;

    if (record.controlInBand === false && band) {
      const skipped = judges.slice(index + 1).map((j) => j.id);
      return finish(
        "discarded",
        // The drifted score itself stays in the log; the reason (which reaches the PR body) omits it.
        `control drift: ${judge.id}'s control score left its band ${band.low}–${band.high} (learned from baseline ${band.samples.join(", ")})` +
          (skipped.length > 0 ? `; not called after the drift: ${skipped.join(", ")}` : ""),
      );
    }
  }

  const scoredJudges = round.judges.filter((j) => j.median).length;
  return finish(
    "kept",
    scoredJudges === 0
      ? "no judge produced a readable score"
      : `every scored judge's control stayed in its band (${scoredJudges} of ${judges.length} judges scored)`,
  );
}

async function callJudge(
  judge: Judge,
  phase: Sample["phase"],
  roles: Role[],
  pictures: CouncilInput["pictures"],
  random: () => number,
  rubric: string,
  maxBudgetUsd: number,
): Promise<Sample> {
  const order = shuffle(roles, random);
  const shown = order.map((role, i) => ({
    label: `Picture ${i + 1}`,
    path: pictures[role] as string,
  }));
  let reply: JudgeReply;
  try {
    reply = await judge.score({ rubric, pictures: shown, maxBudgetUsd });
  } catch (error) {
    reply = { kind: "error", message: (error as Error).message };
  }
  const measured = typeof reply.costUsd === "number" && reply.costUsd >= 0;
  const cost = {
    costUsd: measured ? (reply.costUsd as number) : judge.costUsdPerCall,
    costSource: measured ? ("measured" as const) : ("estimated" as const),
  };
  if (reply.kind === "error") return { phase, order, error: reply.message, ...cost };

  const byRole: Partial<Record<Role, number>> = {};
  for (const [i, role] of order.entries()) {
    const value = reply.scores[`Picture ${i + 1}`];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10) {
      return { phase, order, error: `no usable score for Picture ${i + 1}`, ...cost };
    }
    byRole[role] = value;
  }
  return { phase, order, scores: byRole as RoleScores, ...cost };
}

function medianScores(samples: RoleScores[], roles: Role[]): RoleScores {
  const of = (role: Role) => median(samples.map((s) => s[role] as number));
  return {
    ...(roles.includes("before") ? { before: of("before") } : {}),
    after: of("after"),
    control: of("control"),
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
