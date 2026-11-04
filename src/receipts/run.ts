import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CheckResult, checkReceipts, visibleChangeFromConfig } from "./check.js";
import {
  type FetchLike,
  fetchChangedFiles,
  fetchConfigText,
  type Outcome,
  type PullRequestRef,
  parsePullRequestEvent,
} from "./github.js";

export interface ReceiptsRunOptions {
  /** Path to the pull_request event JSON; defaults to GITHUB_EVENT_PATH. */
  eventPath?: string;
  /** Local mitchstack.yaml; default: the base commit's copy via the API, else ./mitchstack.yaml. */
  configPath?: string;
  /** Newline-separated changed-file list; default: the PR's files via the API. */
  filesPath?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
}

export type ReceiptsRun =
  | { ok: true; result: CheckResult; notes: string[] }
  | { ok: false; error: string };

/**
 * Gather the inputs for one PR (event, changed files, visible-change config), then decide.
 * Expected problems come back as `{ ok: false }`; the caller turns them into exit code 2.
 */
export async function runReceiptsCheck(options: ReceiptsRunOptions): Promise<ReceiptsRun> {
  if (options.env.GITHUB_EVENT_NAME === "pull_request_target") {
    return {
      ok: false,
      error:
        "refusing to run on pull_request_target: it hands fork code a write token; trigger on pull_request",
    };
  }
  const pr = readEvent(options);
  if (!pr.ok) return pr;
  const token = options.env.GITHUB_TOKEN;
  const api = {
    apiUrl: options.env.GITHUB_API_URL ?? "https://api.github.com",
    repo: pr.pr.repo,
    token: token ?? "",
    fetch: options.fetch,
  };

  const files = options.filesPath
    ? readLines(resolve(options.cwd, options.filesPath))
    : token
      ? await fetchChangedFiles({ ...api, number: pr.pr.number })
      : {
          ok: false as const,
          error: "listing the PR's files needs GITHUB_TOKEN (or pass --files)",
        };
  if (!files.ok) return files;

  const configText = await readConfigText(options, pr.pr, token ? api : undefined);
  if (!configText.ok) return configText;
  const { visibleChange, notes } = visibleChangeFromConfig(configText.text);

  const result = checkReceipts({
    body: pr.pr.body,
    headSha: pr.pr.headSha,
    changedFiles: files.files,
    visibleChange,
  });
  return { ok: true, result, notes };
}

function readEvent(options: ReceiptsRunOptions): Outcome<{ pr: PullRequestRef }> {
  const path = options.eventPath ?? options.env.GITHUB_EVENT_PATH;
  if (!path) return { ok: false, error: "no event to read: pass --event or set GITHUB_EVENT_PATH" };
  const read = readFile(resolve(options.cwd, path));
  if (!read.ok) return read;
  try {
    return parsePullRequestEvent(JSON.parse(read.text));
  } catch (error) {
    return { ok: false, error: `event ${path} is not valid JSON: ${(error as Error).message}` };
  }
}

async function readConfigText(
  options: ReceiptsRunOptions,
  pr: PullRequestRef,
  api: Omit<Parameters<typeof fetchConfigText>[0], "ref"> | undefined,
): Promise<Outcome<{ text: string | null }>> {
  if (options.configPath) return readFile(resolve(options.cwd, options.configPath));
  // The base commit's config, so a PR can't loosen its own visible-change globs.
  if (api) return fetchConfigText({ ...api, ref: pr.baseSha });
  const local = resolve(options.cwd, "mitchstack.yaml");
  return existsSync(local) ? readFile(local) : { ok: true, text: null };
}

function readFile(path: string): Outcome<{ text: string }> {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    return { ok: false, error: `cannot read ${path}: ${(error as Error).message}` };
  }
}

function readLines(path: string): Outcome<{ files: string[] }> {
  const read = readFile(path);
  if (!read.ok) return read;
  const files = read.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, files };
}

/** Markdown for the GitHub job summary. */
export function renderSummary(result: CheckResult, notes: string[]): string {
  const lines = [`## mitchstack/receipts: ${result.conclusion}`, ""];
  for (const reason of result.reasons) lines.push(`- ${reason}`);
  if (result.labels.length > 0) {
    lines.push("", `Label: ${result.labels.map((l) => `\`${l}\``).join(", ")}`);
  }
  if (result.visibleFiles.length > 0) {
    lines.push("", `<details><summary>Visible files (${result.visibleFiles.length})</summary>`, "");
    for (const file of result.visibleFiles) lines.push(`- \`${file}\``);
    lines.push("", "</details>");
  }
  for (const note of notes) lines.push("", `> ${note}`);
  return `${lines.join("\n")}\n`;
}
