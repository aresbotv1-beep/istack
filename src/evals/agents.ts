import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEWER_CLIS } from "../review/reviewers.js";
import type { Scenario } from "./schema.js";
import type { SkillText } from "./skill.js";

/** What the agent under test is handed: the skill as its instructions, the scenario as its turn. */
export interface AgentRequest {
  skill: string;
  scenarioId: string;
  /** The eval framing plus the full skill text. */
  system: string;
  /** The context files and the owner's message. */
  user: string;
}

export type AgentReply =
  | { kind: "text"; text: string; costUsd?: number; model?: string }
  | { kind: "error"; message: string; costUsd?: number };

export interface AgentRunner {
  /** Shown in results and baselines, e.g. "claude -p". */
  id: string;
  provider: string;
  /** The model asked for, when one was; the reply's model wins when it reports one. */
  model?: string;
  /** Estimated price of one call; used for the budget and when the reply reports no cost. */
  costUsdPerCall: number;
  run: (request: AgentRequest) => Promise<AgentReply>;
}

export const EVAL_FRAME = [
  "You are an AI coding agent working in a software repository. The skill below is loaded for this",
  "conversation and you follow it.",
  "",
  "This is the first turn of a real session with the owner of the repository. Reply exactly as you",
  "would in that session. In this session you cannot run tools or commands: the files you would",
  "have read are given with the owner's message, and anything not given is not available. There is",
  "no question tool, so any questions go in this reply, numbered. The repository is the one the",
  "files come from: ignore any working directory, git state or environment details you may be",
  "shown, which describe an empty placeholder. Do not mention that this is a test.",
].join("\n");

export function buildRequest(skill: SkillText, scenario: Scenario): AgentRequest {
  const system = `${EVAL_FRAME}\n\n<skill name="${skill.name}">\n${skill.text}\n</skill>`;
  const context = scenario.context.map(
    (f) => `<file path="${f.path}">\n${f.text.trimEnd()}\n</file>`,
  );
  const user = [
    ...(context.length > 0 ? ["Files you have already read:", "", ...context, ""] : []),
    "The owner's message:",
    "",
    scenario.prompt.trim(),
  ].join("\n");
  return { skill: skill.name, scenarioId: scenario.id, system, user };
}

export type SpawnExec = (
  file: string,
  args: string[],
  options: { input: string; cwd: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const spawnExec: SpawnExec = (file, args, options) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\n(timed out after ${options.timeoutMs} ms)`;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.input);
  });

/** Estimated dollars per call when the CLI reports no cost: skill text in, about a page out. */
export const DEFAULT_AGENT_PRICES_USD: Readonly<Record<string, number>> = {
  anthropic: 0.06,
  openai: 0.06,
};

const TEN_MINUTES = 10 * 60 * 1000;

/**
 * `claude -p` with the eval frame and skill as the whole system prompt, every tool off, no slash
 * commands or skills, no MCP servers, no user settings, run in an empty directory so no CLAUDE.md
 * or installed skill leaks in. Reports its real cost.
 */
export function claudeRunner(input: {
  model?: string;
  exec?: SpawnExec;
  price?: number;
}): AgentRunner {
  const cli = REVIEWER_CLIS.find((c) => c.provider === "anthropic");
  const [file, ...base] = (cli?.argv ?? ["claude", "-p"]) as [string, ...string[]];
  const exec = input.exec ?? spawnExec;
  return {
    id: cli?.via ?? "claude -p",
    provider: "anthropic",
    model: input.model,
    costUsdPerCall: input.price ?? DEFAULT_AGENT_PRICES_USD.anthropic ?? 0.06,
    async run(request) {
      const cwd = mkdtempSync(join(tmpdir(), "ms-evals-agent-"));
      try {
        const args = [
          ...base,
          "--system-prompt",
          request.system,
          "--tools",
          "",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--setting-sources",
          "project",
          "--no-session-persistence",
          "--output-format",
          "json",
          ...(input.model ? ["--model", input.model] : []),
        ];
        const r = await exec(file, args, { input: request.user, cwd, timeoutMs: TEN_MINUTES });
        return parseClaudeReply(r);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

export function parseClaudeReply(r: { code: number; stdout: string; stderr: string }): AgentReply {
  let json: {
    result?: unknown;
    is_error?: unknown;
    total_cost_usd?: unknown;
    modelUsage?: Record<string, { outputTokens?: number; costUSD?: number }>;
  };
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return {
      kind: "error",
      message: `claude -p exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`,
    };
  }
  const costUsd = typeof json.total_cost_usd === "number" ? json.total_cost_usd : undefined;
  if (r.code !== 0 || json.is_error === true || typeof json.result !== "string") {
    return {
      kind: "error",
      message: `claude -p exited ${r.code}: ${String(json.result ?? r.stderr).slice(0, 300)}`,
      ...(costUsd === undefined ? {} : { costUsd }),
    };
  }
  // The model that wrote the reply is the one that cost the most: a small helper model can write
  // more tokens than the main model on a one-line reply, but it never costs more.
  const model = Object.entries(json.modelUsage ?? {}).sort(
    (a, b) =>
      (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0) ||
      (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0),
  )[0]?.[0];
  return {
    kind: "text",
    text: json.result,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model ? { model } : {}),
  };
}

/**
 * `codex exec` in a read-only sandbox in an empty directory, ignoring the user's config and rules,
 * with the frame, skill and turn on stdin. It reports no dollar cost, so every call is estimated.
 */
export function codexRunner(input: {
  model?: string;
  exec?: SpawnExec;
  price?: number;
}): AgentRunner {
  const cli = REVIEWER_CLIS.find((c) => c.provider === "openai");
  const [file, ...base] = (cli?.argv ?? ["codex", "exec"]) as [string, ...string[]];
  const exec = input.exec ?? spawnExec;
  return {
    id: cli?.via ?? "codex exec",
    provider: "openai",
    model: input.model,
    costUsdPerCall: input.price ?? DEFAULT_AGENT_PRICES_USD.openai ?? 0.06,
    async run(request) {
      const cwd = mkdtempSync(join(tmpdir(), "ms-evals-agent-"));
      const last = join(cwd, "last-message.txt");
      try {
        const args = [
          ...base,
          "--skip-git-repo-check",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--sandbox",
          "read-only",
          "-C",
          cwd,
          "-o",
          last,
          ...(input.model ? ["-m", input.model] : []),
          "-",
        ];
        const prompt = `${request.system}\n\n---\n\n${request.user}`;
        const r = await exec(file, args, { input: prompt, cwd, timeoutMs: TEN_MINUTES });
        if (r.code !== 0) {
          return { kind: "error", message: `codex exec exited ${r.code}: ${r.stderr.slice(-300)}` };
        }
        let text = r.stdout;
        try {
          text = readFileSync(last, "utf8");
        } catch {
          // Fall back to stdout.
        }
        return text.trim() === ""
          ? { kind: "error", message: "codex exec gave an empty reply" }
          : { kind: "text", text, ...(input.model ? { model: input.model } : {}) };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
