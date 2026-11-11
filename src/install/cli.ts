import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CliIo } from "../cli.js";
import { install, type Report, uninstall } from "./actions.js";
import { HOSTS, type Host, type Scope } from "./hosts.js";
import { findKitRoot, loadKit } from "./kit.js";

const USAGE = [
  "usage: istack install --host claude|codex|cursor|all [--home <dir> | --project <dir>]",
  "                          [--prefix] [--hooks] [--dry-run] [--json]",
  "       istack uninstall --host claude|codex|cursor|all [--home <dir> | --project <dir>]",
  "                          [--hooks] [--dry-run] [--json]",
  "",
  "  --home <dir>     user-level install (default: your home directory)",
  "  --project <dir>  install into one repository instead",
  "  --prefix         install every skill as istack-<name> (never clashes)",
  "  --hooks          also add a git pre-push hook running istack.yaml checks (needs --project)",
  "  --dry-run        print what would change; write nothing",
  "",
  "Never overwrites a skill or file it did not create. What it wrote is recorded in",
  "<root>/.istack/install.json; uninstall removes only those files, and keeps any you edited.",
].join("\n");

export interface InstallDeps {
  /** The istack kit to install from. Defaults to the package this file ships in. */
  kitRoot?: string;
  homedir?: () => string;
}

/**
 * `args` start at the command word: `install ...` or `uninstall ...`. Exit 0 done, 1 done but
 * something was skipped or kept (read the report), 2 bad usage or the install could not run.
 */
export async function runInstallCli(
  args: string[],
  io: CliIo,
  deps: InstallDeps = {},
): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "install" && command !== "uninstall") return usage(io);
  let values: {
    host?: string;
    home?: string;
    project?: string;
    prefix?: boolean;
    hooks?: boolean;
    "dry-run"?: boolean;
    json?: boolean;
  };
  try {
    values = parseArgs({
      args: rest,
      options: {
        host: { type: "string" },
        home: { type: "string" },
        project: { type: "string" },
        prefix: { type: "boolean" },
        hooks: { type: "boolean" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    return usage(io, (error as Error).message);
  }
  if (!values.host) return usage(io, "--host is required");
  const hosts: Host[] =
    values.host === "all"
      ? [...HOSTS]
      : (HOSTS as readonly string[]).includes(values.host)
        ? [values.host as Host]
        : [];
  if (hosts.length === 0) return usage(io, `unknown host ${values.host}`);
  if (values.home && values.project) return usage(io, "pick one of --home and --project");
  if (values.hooks && !values.project) return usage(io, "--hooks needs --project <repo>");
  if (command === "uninstall" && values.prefix) return usage(io, "--prefix is for install");

  const env = io.env ?? process.env;
  let scope: Scope;
  if (values.project) {
    scope = { kind: "project", root: resolve(io.cwd, values.project) };
  } else {
    const root = values.home ? resolve(io.cwd, values.home) : (deps.homedir ?? homedir)();
    scope = { kind: "home", root };
    if (!values.home && env.CODEX_HOME) scope.codexHome = resolve(env.CODEX_HOME);
  }
  if (!existsSync(scope.root) || !statSync(scope.root).isDirectory()) {
    io.err(`istack ${command}: ${scope.root} is not a directory`);
    return 2;
  }

  let report: Report;
  try {
    const dryRun = values["dry-run"] ?? false;
    if (command === "install") {
      const kit = loadKit(deps.kitRoot ?? findKitRoot());
      report = install({ scope, hosts, kit, prefix: values.prefix, hooks: values.hooks, dryRun });
    } else {
      const hooks = values.hooks || values.host === "all";
      report = uninstall({ scope, hosts, hooks, dryRun });
    }
  } catch (error) {
    io.err(`istack ${command} could not run: ${(error as Error).message}`);
    return 2;
  }
  if (values.json) io.out(JSON.stringify(report, null, 2));
  else print(command, report, io);
  return report.attention ? 1 : 0;
}

function print(command: string, report: Report, io: CliIo): void {
  const where = `${report.scope.kind} ${report.scope.root}`;
  io.out(`istack ${command} → ${where}${report.dryRun ? " — dry run, nothing written" : ""}`);
  const width = Math.max(...report.items.map((i) => i.status.length), 0);
  for (const item of report.items) {
    if (item.status === "note") continue;
    const line = `  ${item.status.padEnd(width)}  ${item.path}  ${item.detail}`;
    (item.status === "skipped" || item.status === "kept" ? io.err : io.out)(line);
  }
  for (const item of report.items.filter((i) => i.status === "note"))
    io.out(`  note: ${item.detail}`);
  const counts = new Map<string, number>();
  for (const item of report.items) {
    if (item.status !== "note") counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  const summary = [...counts].map(([status, n]) => `${n} ${status}`).join(", ") || "nothing to do";
  const record = join(report.scope.root, ".istack", "install.json");
  io.out(`${summary}. ${existsSync(record) ? `Record: ${record}` : "No install record left."}`);
}

function usage(io: CliIo, problem?: string): number {
  io.err(problem ? `${problem}\n${USAGE}` : USAGE);
  return 2;
}
