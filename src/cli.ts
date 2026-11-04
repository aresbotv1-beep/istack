import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config/load.js";

export interface CliIo {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = "usage: mitchstack config check [path-to-mitchstack.yaml]";

/** Returns the process exit code. */
export function runCli(args: string[], io: CliIo): number {
  const [group, command, pathArg] = args;
  if (group !== "config" || command !== "check") {
    io.err(USAGE);
    return 2;
  }
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
