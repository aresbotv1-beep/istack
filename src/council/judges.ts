import { execFile } from "node:child_process";
import { REVIEWER_CLIS, type ReviewerCli, type ReviewerProbe } from "../review/reviewers.js";
import type { Exec } from "../watch/gh.js";
import type { Judge, JudgeReply, JudgeRequest } from "./run.js";

/**
 * Estimated US dollars per judge call (three screenshots in, a few lines out). These are
 * conservative guesses, not quotes: agentic CLIs may take several turns to open the images.
 * Override with --prices; a call that reports its real cost is logged as measured instead.
 */
export const DEFAULT_PRICES_USD: Readonly<Record<string, number>> = {
  openai: 0.2,
  anthropic: 0.25,
  cursor: 0.2,
};
export const FALLBACK_PRICE_USD = 0.25;

/** "Picture 2: 7" lines → { "Picture 2": 7 }. Anything else in the reply is ignored. */
export function parseScoresReply(text: string): Record<string, number> {
  const scores: Record<string, number> = {};
  const line = /^\s*\**\s*Picture\s+(\d+)\s*\**\s*[:=-]\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?\s*$/gim;
  for (const match of text.matchAll(line)) {
    const label = `Picture ${match[1]}`;
    if (!(label in scores)) scores[label] = Number(match[2]);
  }
  return scores;
}

/** The prompt text: the neutral rubric, then each picture's label and neutral path. */
export function judgePrompt(request: JudgeRequest): string {
  return [
    request.rubric,
    "",
    "Open each image file and score it:",
    ...request.pictures.map((p) => `${p.label}: ${p.path}`),
  ].join("\n");
}

/**
 * One judge per installed CLI whose provider is allowed (all when `providers` is empty).
 * Thin by design: it builds argv, runs it, and parses "Picture N: score" lines. It has not been
 * exercised against the real provider CLIs in tests; the runner's behaviour is tested with fakes.
 * The harness's delegate_task cannot be called from a CLI, so it is not a judge here.
 */
export function discoverJudges(input: {
  probe: Pick<ReviewerProbe, "hasCommand">;
  providers: string[];
  prices?: Record<string, number>;
  exec: Exec;
  /** Directory holding the staged pictures, for CLIs that must be told what they may read. */
  pictureDir: string;
}): Judge[] {
  const allowed = input.providers.map((p) => p.toLowerCase());
  const prices = { ...DEFAULT_PRICES_USD, ...input.prices };
  return REVIEWER_CLIS.filter((cli) => input.probe.hasCommand(cli.command))
    .filter((cli) => allowed.length === 0 || allowed.includes(cli.provider))
    .map((cli) => ({
      id: `${cli.via} (${cli.provider})`,
      provider: cli.provider,
      costUsdPerCall: prices[cli.provider] ?? FALLBACK_PRICE_USD,
      score: (request) => callCli(cli, request, input.exec, input.pictureDir),
    }));
}

async function callCli(
  cli: ReviewerCli,
  request: JudgeRequest,
  exec: Exec,
  pictureDir: string,
): Promise<JudgeReply> {
  const prompt = judgePrompt(request);
  const [file, ...base] = cli.argv as [string, ...string[]];
  let args: string[];
  if (cli.provider === "openai") {
    args = [...base, ...request.pictures.flatMap((p) => ["--image", p.path]), prompt];
  } else if (cli.provider === "anthropic") {
    args = [
      ...base,
      "--output-format",
      "json",
      "--allowedTools",
      "Read",
      "--add-dir",
      pictureDir,
      // The only judge CLI with a spend limit (`claude --help`: "only works with --print").
      // codex exec and cursor-agent have none, so they get no flag.
      ...(request.maxBudgetUsd === undefined
        ? []
        : ["--max-budget-usd", String(Math.max(0, request.maxBudgetUsd))]),
      prompt,
    ];
  } else {
    args = [...base, prompt];
  }
  const result = await exec(file, args);
  let text = result.stdout;
  let costUsd: number | undefined;
  if (cli.provider === "anthropic") {
    // Read the cost even from a failed call (a spend-limit stop still reports what it spent).
    try {
      const json = JSON.parse(result.stdout) as { result?: unknown; total_cost_usd?: unknown };
      if (typeof json.result === "string") text = json.result;
      if (typeof json.total_cost_usd === "number") costUsd = json.total_cost_usd;
    } catch {
      // Not JSON: read the plain text.
    }
  }
  const cost = costUsd === undefined ? {} : { costUsd };
  if (result.code !== 0) {
    return {
      kind: "error",
      message: `${cli.via} exited ${result.code}: ${result.stderr.slice(0, 200)}`,
      ...cost,
    };
  }
  const scores = parseScoresReply(text);
  return costUsd === undefined ? { kind: "scores", scores } : { kind: "scores", scores, costUsd };
}

/** Runs a judge CLI with a ten-minute cap. A judge that hangs ends as an error sample. */
export const execJudge: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
      },
    );
  });
