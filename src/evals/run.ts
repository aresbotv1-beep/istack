import { noiseOf } from "../climb/engine.js";
import type { Judge } from "../council/run.js";
import type { CouncilLog } from "../council/schema.js";
import { median } from "../council/stats.js";
import { type AgentReply, type AgentRunner, buildRequest } from "./agents.js";
import type { ScenarioSet } from "./scenarios.js";
import type { Baseline } from "./schema.js";
import { type CriterionResult, scoreCriterion } from "./score.js";
import type { SkillText } from "./skill.js";
import { scoreTaste } from "./taste.js";

/**
 * The scoring rule, in one place:
 *
 *   criterion  deterministic: 1 pass, 0 fail · taste: council score / 10 (only with --taste)
 *   scenario   100 × Σ(weight × criterion) / Σ weight            (one run)
 *   run        mean of the scenario scores in that run
 *   skill      median of the run scores
 *   regressed  skill − baseline < −noise, noise = max(floor, k × MAD(baseline runs), k × MAD(runs))
 *
 * The noise rule is the climb's (`noiseOf`), so "a skill edit must not lower the eval score" means
 * the same thing here as a climb's keep rule. A run with a failed agent call, an unscored taste
 * criterion or a budget stop gives no score: the result says so instead of guessing.
 */

export interface TasteOptions {
  judges: Judge[];
  stageDir: string;
}

export interface EvalInput {
  skill: SkillText;
  scenarios: ScenarioSet;
  runner: AgentRunner;
  /** Runs per scenario. The skill score is the median of the run scores. */
  runs: number;
  /** Dollars all agent and judge calls may spend together. Default: unlimited. */
  budgetUsd?: number;
  /** Score taste criteria through the council. Off by default: deterministic only. */
  taste?: TasteOptions;
  /** Called with every reply as it arrives, so a crash still leaves the transcript. */
  record?: (entry: TranscriptEntry) => void;
  now?: () => string;
}

export interface TranscriptEntry {
  run: number;
  scenario: string;
  reply?: string;
  error?: string;
  model?: string;
  costUsd: number;
  costSource: "measured" | "estimated";
  criteria: (CriterionResult & { weight: number; points?: number })[];
  score?: number;
}

export interface ScenarioOutcome {
  /** One score per completed run, 0–100. */
  runs: number[];
  median?: number;
  passes: Record<string, number>;
}

export interface EvalResult {
  status: "complete" | "budget" | "incomplete";
  reason: string;
  skill: string;
  skillHash: string;
  scenariosHash: string;
  runner: { id: string; provider: string; model: string };
  runs: number;
  mode: "deterministic" | "council";
  costUsd: number;
  costSource: "measured" | "estimated" | "mixed";
  runScores: number[];
  /** Median of runScores; absent unless status is complete. */
  score?: number;
  scenarios: Record<string, ScenarioOutcome>;
  transcript: TranscriptEntry[];
}

export async function runSkillEvals(input: EvalInput): Promise<EvalResult> {
  if (!Number.isInteger(input.runs) || input.runs < 1)
    throw new Error("runs must be a whole number of at least 1");
  const budget = input.budgetUsd ?? Number.POSITIVE_INFINITY;
  const { skill, scenarios, runner } = input;
  const transcript: TranscriptEntry[] = [];
  const outcomes: Record<string, ScenarioOutcome> = Object.fromEntries(
    scenarios.scenarios.map((s) => [s.id, { runs: [], passes: {} }]),
  );
  const runScores: number[] = [];
  const models = new Set<string>();
  const sources = new Set<"measured" | "estimated">();
  const logs = new Map<string, CouncilLog | undefined>();
  let spent = 0;
  let stop: { status: EvalResult["status"]; reason: string } | undefined;

  for (let run = 1; run <= input.runs && !stop; run += 1) {
    const perScenario: number[] = [];
    for (const scenario of scenarios.scenarios) {
      if (spent + runner.costUsdPerCall > budget + 1e-9) {
        stop = {
          status: "budget",
          reason: `budget: stopped before run ${run} of ${scenario.id}; $${spent.toFixed(2)} of $${budget.toFixed(2)} spent`,
        };
        break;
      }
      const reply: AgentReply = await runner
        .run(buildRequest(skill, scenario))
        .catch((error: Error) => ({ kind: "error", message: error.message }));
      const measured = typeof reply.costUsd === "number";
      const cost = measured ? (reply.costUsd as number) : runner.costUsdPerCall;
      spent += cost;
      sources.add(measured ? "measured" : "estimated");
      const entry: TranscriptEntry = {
        run,
        scenario: scenario.id,
        costUsd: cost,
        costSource: measured ? "measured" : "estimated",
        criteria: [],
      };
      if (reply.kind === "error") {
        entry.error = reply.message;
        transcript.push(entry);
        input.record?.(entry);
        stop = { status: "incomplete", reason: `run ${run} of ${scenario.id}: ${reply.message}` };
        break;
      }
      entry.reply = reply.text;
      if (reply.model) {
        entry.model = reply.model;
        models.add(reply.model);
      }

      let total = 0;
      let weights = 0;
      for (const criterion of scenario.criteria) {
        if (criterion.kind === "taste") {
          if (!input.taste) continue;
          const key = `${scenario.id}/${criterion.id}`;
          const taste = await scoreTaste({
            scenario,
            criterion,
            reply: reply.text,
            judges: input.taste.judges,
            log: logs.get(key),
            seed: run,
            budgetUsd: budget - spent,
            stageDir: input.taste.stageDir,
            now: input.now,
          });
          logs.set(key, taste.log);
          spent += taste.costUsd;
          if (taste.score === undefined) {
            entry.criteria.push({
              id: criterion.id,
              pass: false,
              detail: `no score: ${taste.reason}`,
              weight: criterion.weight,
            });
            stop = {
              status: "incomplete",
              reason: `run ${run} of ${scenario.id}, ${criterion.id}: no score (${taste.reason})`,
            };
            break;
          }
          const points = taste.score / 10;
          entry.criteria.push({
            id: criterion.id,
            pass: points >= 0.5,
            detail: `council ${taste.score}/10`,
            weight: criterion.weight,
            points,
          });
          total += criterion.weight * points;
          weights += criterion.weight;
          continue;
        }
        const result = scoreCriterion(criterion, reply.text);
        entry.criteria.push({ ...result, weight: criterion.weight });
        if (result.pass) {
          const outcome = outcomes[scenario.id] as ScenarioOutcome;
          outcome.passes[criterion.id] = (outcome.passes[criterion.id] ?? 0) + 1;
          total += criterion.weight;
        } else {
          (outcomes[scenario.id] as ScenarioOutcome).passes[criterion.id] ??= 0;
        }
        weights += criterion.weight;
      }
      if (stop) {
        transcript.push(entry);
        input.record?.(entry);
        break;
      }
      entry.score = round((100 * total) / weights);
      (outcomes[scenario.id] as ScenarioOutcome).runs.push(entry.score);
      perScenario.push(entry.score);
      transcript.push(entry);
      input.record?.(entry);
    }
    if (!stop) runScores.push(round(perScenario.reduce((a, b) => a + b, 0) / perScenario.length));
  }

  for (const outcome of Object.values(outcomes)) {
    if (outcome.runs.length > 0) outcome.median = median(outcome.runs);
  }
  const costSource =
    sources.size === 2 ? "mixed" : sources.has("measured") ? "measured" : "estimated";
  const result: EvalResult = {
    status: stop?.status ?? "complete",
    reason: stop?.reason ?? `${input.runs} runs of ${scenarios.scenarios.length} scenarios`,
    skill: skill.name,
    skillHash: skill.hash,
    scenariosHash: scenarios.hash,
    runner: {
      id: runner.id,
      provider: runner.provider,
      model: [...models].sort().join(", ") || runner.model || "unknown",
    },
    runs: input.runs,
    mode: input.taste ? "council" : "deterministic",
    costUsd: round(spent, 6),
    costSource,
    runScores,
    scenarios: outcomes,
    transcript,
  };
  if (!stop) result.score = median(runScores);
  return result;
}

export function toBaseline(
  result: EvalResult,
  options: { date: string; noiseFloor: number; k: number },
): Baseline {
  if (result.status !== "complete" || result.score === undefined) {
    throw new Error(`no baseline from an ${result.status} run: ${result.reason}`);
  }
  return {
    version: 1,
    skill: result.skill,
    skillHash: result.skillHash,
    scenariosHash: result.scenariosHash,
    producedBy: {
      runner: result.runner.id,
      provider: result.runner.provider,
      model: result.runner.model,
      runs: result.runs,
      date: options.date,
      mode: result.mode,
      costUsd: result.costUsd,
      costSource: result.costSource,
    },
    score: result.score,
    runScores: result.runScores,
    noise: { floor: options.noiseFloor, k: options.k },
    scenarios: Object.fromEntries(
      Object.entries(result.scenarios).map(([id, s]) => [
        id,
        { median: s.median ?? 0, runs: s.runs, passes: s.passes },
      ]),
    ),
  };
}

export interface Comparison {
  comparable: boolean;
  /** Why the two cannot be compared, when they cannot. */
  reasons: string[];
  baselineScore: number;
  score?: number;
  delta?: number;
  noise: number;
  regressed: boolean;
}

/** Does `result` score lower than `baseline` beyond noise? Refuses to compare unlike runs. */
export function compareToBaseline(baseline: Baseline, result: EvalResult): Comparison {
  const reasons: string[] = [];
  if (result.status !== "complete" || result.score === undefined)
    reasons.push(`the run is ${result.status}: ${result.reason}`);
  if (result.scenariosHash !== baseline.scenariosHash) {
    reasons.push(
      "the scenarios changed since the baseline; write a new baseline before the skill edit",
    );
  }
  if (result.mode !== baseline.producedBy.mode)
    reasons.push(`mode ${result.mode} vs baseline ${baseline.producedBy.mode}`);
  if (result.runner.id !== baseline.producedBy.runner) {
    reasons.push(`runner ${result.runner.id} vs baseline ${baseline.producedBy.runner}`);
  }
  const noise = noiseOf(
    baseline.runScores,
    result.runScores.length > 0 ? result.runScores : [0],
    baseline.noise.floor,
    baseline.noise.k,
  );
  if (reasons.length > 0 || result.score === undefined) {
    return { comparable: false, reasons, baselineScore: baseline.score, noise, regressed: false };
  }
  const delta = round(result.score - baseline.score);
  return {
    comparable: true,
    reasons,
    baselineScore: baseline.score,
    score: result.score,
    delta,
    noise: round(noise),
    regressed: delta < -noise,
  };
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
