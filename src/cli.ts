import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runProveCli } from "./capture/cli.js";
import { runClimbCli } from "./climb/cli.js";
import { loadConfig } from "./config/load.js";
import { runEnvCli } from "./env/cli.js";
import { runEvalsCli } from "./evals/cli.js";
import { runInstallCli } from "./install/cli.js";
import type { FetchLike } from "./receipts/github.js";
import { renderSummary, runReceiptsCheck } from "./receipts/run.js";
import { runVerifyCli } from "./receipts/verify/cli.js";
import { runShipCli } from "./ship/cli.js";

export interface CliIo {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
}

const USAGE = [
  "usage: mitchstack config check [path-to-mitchstack.yaml]",
  "       mitchstack receipts check [--event path] [--config path] [--files path]",
  "       mitchstack receipts verify ...",
  "       mitchstack prove capture --url <url> --out <png> | prove receipts --from <claims.json>",
  "       mitchstack ship reviewer|review|body|watch ...",
  "       mitchstack env up|status|down|check-port|check-base ...",
  "       mitchstack climb ladder|run|council-score ...",
  "       mitchstack evals list|run|baseline|compare ...",
  "       mitchstack install|uninstall --host claude|codex|cursor|all ...",
].join("\n");

/** Returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = args;
  if (group === "config" && command === "check") return configCheck(rest[0], io);
  if (group === "receipts" && command === "check") return receiptsCheck(rest, io);
  if (group === "receipts" && command === "verify") return runVerifyCli(rest, io);
  if (group === "prove") return runProveCli(args.slice(1), io);
  if (group === "ship") return runShipCli(args.slice(1), io);
  if (group === "env") return runEnvCli(args.slice(1), io);
  if (group === "climb") return runClimbCli(args.slice(1), io);
  if (group === "evals") return runEvalsCli(args.slice(1), io);
  if (group === "install" || group === "uninstall") return runInstallCli(args, io);
  io.err(USAGE);
  return 2;
}

function configCheck(pathArg: string | undefined, io: CliIo): number {
  const path = resolve(io.cwd, pathArg ?? "mitchstack.yaml");
  if (!existsSync(path)) {
    io.err(`no config at ${path} — copy mitchstack.yaml.example to start`);
    return 1;
  }
  const result = loadConfig(readFileSync(path, "utf8"));
  if (!result.ok) {
    io.err(`${path} is invalid:`);
    for (const e of result.errors) io.err(`  ${e.path || "(file)"}: ${e.message}`);
    return 1;
  }
  io.out(
    `${path} is valid — owner ${result.config.owner}, profile ${result.config.profile}, ${result.config.checks.length} checks`,
  );
  return 0;
}

/** Exit 0 pass, 1 fail, 2 when the check could not run (bad args, no event, API error). */
async function receiptsCheck(rest: string[], io: CliIo): Promise<number> {
  let flags: { event?: string; config?: string; files?: string };
  try {
    flags = parseArgs({
      args: rest,
      options: { event: { type: "string" }, config: { type: "string" }, files: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const env = io.env ?? process.env;
  const run = await runReceiptsCheck({
    eventPath: flags.event,
    configPath: flags.config,
    filesPath: flags.files,
    cwd: io.cwd,
    env,
    fetch: io.fetch ?? fetch,
  });
  if (!run.ok) {
    io.err(`mitchstack/receipts could not run: ${run.error}`);
    return 2;
  }
  const { result, notes } = run;
  const print = result.conclusion === "pass" ? io.out : io.err;
  print(`mitchstack/receipts: ${result.conclusion}`);
  for (const reason of result.reasons) print(`  - ${reason}`);
  for (const label of result.labels) io.out(`  label: ${label}`);
  for (const note of notes) io.out(`  note: ${note}`);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result, notes));
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `conclusion=${result.conclusion}\nlabels=${JSON.stringify(result.labels)}\n`,
    );
  }
  return result.conclusion === "pass" ? 0 : 1;
}
