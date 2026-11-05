import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { councilScore } from "../climb/council.js";
import type { Judge, JudgeReply, JudgeRequest } from "../council/run.js";
import { runCouncil } from "../council/run.js";
import type { CouncilLog } from "../council/schema.js";
import type { AgentRunner } from "./agents.js";
import type { Scenario, TasteCriterion } from "./schema.js";

/**
 * Taste criteria go through the ship council: several providers, a fixed control reply in every
 * call, a band learned from the control, a budget. Judges see neutrally named replies and a
 * neutral rubric; they never learn which reply is the skill's or what score was hoped for.
 */

/** The rubric a judge gets for one taste criterion. Names no goal and no role. */
export function tasteRubric(scenario: Scenario, criterion: TasteCriterion): string {
  return [
    "Below is a message someone sent to an AI assistant, then several replies to it, labelled",
    "Response 1, Response 2 and so on.",
    `Score each reply on its own from 0 to 10 for this: ${criterion.rubric}`,
    "Do not compare them to anything you were not shown. Do not explain.",
    "Reply with one line per response and nothing else, for example:",
    "Response 1: 6",
    "Response 2: 8",
    "",
    "The message:",
    "<<<",
    scenario.prompt.trim(),
    ">>>",
  ].join("\n");
}

/** "Response 2: 7" lines → { "Picture 2": 7 }, the council's labels. */
export function parseResponseScores(text: string): Record<string, number> {
  const scores: Record<string, number> = {};
  const line = /^\s*\**\s*Response\s+(\d+)\s*\**\s*[:=-]\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?\s*$/gim;
  for (const match of text.matchAll(line)) {
    const label = `Picture ${match[1]}`;
    if (!(label in scores)) scores[label] = Number(match[2]);
  }
  return scores;
}

/** Any agent runner can judge: the rubric is its instructions, the replies its turn. */
export function judgeFromRunner(runner: AgentRunner): Judge {
  return {
    id: `${runner.id} (${runner.provider})`,
    provider: runner.provider,
    costUsdPerCall: runner.costUsdPerCall,
    async score(request: JudgeRequest): Promise<JudgeReply> {
      const user = request.pictures
        .map(
          (p) =>
            `${p.label.replace("Picture", "Response")}:\n<<<\n${readFileSync(p.path, "utf8").trim()}\n>>>`,
        )
        .join("\n\n");
      const reply = await runner.run({
        skill: "(judge)",
        scenarioId: "(judge)",
        system: request.rubric,
        user,
      });
      const cost = reply.costUsd === undefined ? {} : { costUsd: reply.costUsd };
      if (reply.kind === "error") return { kind: "error", message: reply.message, ...cost };
      return { kind: "scores", scores: parseResponseScores(reply.text), ...cost };
    },
  };
}

export interface TasteInput {
  scenario: Scenario;
  criterion: TasteCriterion;
  reply: string;
  judges: Judge[];
  /** One log per scenario and criterion, so each control's band is learned once. */
  log?: CouncilLog;
  seed: number;
  /** Dollars this call may still spend. */
  budgetUsd: number;
  stageDir: string;
  now?: () => string;
}

export interface TasteResult {
  /** 0–10, absent when the council gave no score (drift, budget, too few providers). */
  score?: number;
  reason: string;
  log?: CouncilLog;
  costUsd: number;
}

function stage(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const name = `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.txt`;
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

export async function scoreTaste(input: TasteInput): Promise<TasteResult> {
  const spentBefore = input.log?.spentUsd ?? 0;
  if (!(input.budgetUsd > 0))
    return { reason: "no council (budget): nothing left", costUsd: 0, log: input.log };
  const after = stage(input.stageDir, input.reply);
  const control = stage(input.stageDir, input.criterion.control);
  if (after === control)
    return { reason: "the reply is the control, word for word", costUsd: 0, log: input.log };
  const result = await runCouncil({
    profile: "factory",
    council: { enabled: true, budgetUsdPerPr: spentBefore + input.budgetUsd },
    visibleFiles: ["(evals)"],
    visibleChangedSinceLastRound: ["(evals)"],
    head: `${input.scenario.id}/${input.criterion.id}`,
    pictures: { after, control },
    judges: input.judges,
    log: input.log,
    seed: input.seed,
    now: input.now,
    rubric: tasteRubric(input.scenario, input.criterion),
  });
  const costUsd = Math.max(0, result.log.spentUsd - spentBefore);
  if (result.outcome.status === "skipped")
    return { reason: result.outcome.reason, costUsd, log: result.log };
  const score = councilScore(result.outcome.round);
  return score === undefined
    ? { reason: `${result.outcome.status}: ${result.outcome.reason}`, costUsd, log: result.log }
    : { score, reason: result.outcome.reason, costUsd, log: result.log };
}
