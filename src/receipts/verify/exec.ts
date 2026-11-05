import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd: string;
  /** Killed (with its whole process group) after this long; the result says `timedOut`. */
  timeoutMs: number;
  env?: Record<string, string | undefined>;
}

export interface ExecResult {
  /** null when the process was killed by a signal, timed out, or never started. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  error?: string;
  durationMs: number;
}

/**
 * Runs one program. Injected everywhere the verified tier touches git or the PR's commands, so
 * tests can point it at a temp fixture repo or fake a timeout. Never throws.
 */
export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

/** Keep the tail of each stream; a chatty test runner must not exhaust memory. */
const MAX_OUTPUT = 64 * 1024;

/**
 * Credentials a PR's commands must never see. The action does not pass them in; this is the
 * second lock, for anyone running the verifier somewhere that does.
 */
const SCRUBBED_ENV = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
  // Workflow file commands: a PR's command must not set the job's outputs, env, path or summary.
  "GITHUB_OUTPUT",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
];

export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SCRUBBED_ENV.includes(key)) clean[key] = value;
  }
  return clean;
}

export const realExec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer) =>
      (current + chunk.toString()).slice(-MAX_OUTPUT);
    const done = (result: Omit<ExecResult, "stdout" | "stderr" | "durationMs" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, timedOut, stdout, stderr, durationMs: Date.now() - started });
    };

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      // Own process group, so a timeout kills the test runner's children too.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => done({ exitCode: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => {
      killGroup(child.pid); // reap anything the command left running in its group
      done({ exitCode: timedOut ? null : code, signal: signal ?? null });
    });
  });

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Run a shell command line, the way a PR's receipts state it. */
export function runShell(exec: Exec, command: string, options: ExecOptions): Promise<ExecResult> {
  return exec("sh", ["-c", command], options);
}

/** The last few lines of a run's output, for a failure reason. */
export function outputTail(result: ExecResult, lines = 5): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.split(/\r?\n/).slice(-lines).join("\n");
}
