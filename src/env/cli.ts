import type { CliIo } from "../cli.js";
import {
  type DatabaseReport,
  type DownReport,
  envCheckPort,
  envDown,
  envStatus,
  envUp,
  type StatusReport,
  type UpReport,
} from "./actions.js";
import { type Exec, realExec } from "./git.js";
import type { PortCheck } from "./ownership.js";

const USAGE = [
  "usage: mitchstack env up [--install] [--db] [--json]",
  "       mitchstack env status [--json]",
  "       mitchstack env down [--db] [--json]",
  "       mitchstack env check-port <port> [--json]",
  "       mitchstack env check-base <branch>",
].join("\n");

const FLAGS: Record<string, string[]> = {
  up: ["--install", "--db", "--json"],
  status: ["--json"],
  down: ["--db", "--json"],
  "check-port": ["--json"],
  "check-base": [],
};

/**
 * `args` are the words after `env`. Exit 0 ok, 1 refused or failed (including a foreign or absent
 * listener on check-port), 2 bad usage or the check could not run.
 */
export async function runEnvCli(
  args: string[],
  io: CliIo,
  deps: { exec?: Exec } = {},
): Promise<number> {
  const exec = deps.exec ?? realExec;
  const [command, ...rest] = args;
  const allowed = command ? FLAGS[command] : undefined;
  if (!command || !allowed) return usage(io);
  const flags = new Set(rest.filter((w) => w.startsWith("--")));
  const positionals = rest.filter((w) => !w.startsWith("--"));
  const unknown = [...flags].filter((f) => !allowed.includes(f));
  if (unknown.length > 0) return usage(io, `unknown flag ${unknown.join(", ")} for env ${command}`);
  const json = flags.has("--json");

  if (command === "check-port") {
    const port = Number(positionals[0]);
    if (positionals.length !== 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
      return usage(io, "check-port needs one port number");
    }
    const result = envCheckPort({ cwd: io.cwd, exec, port });
    if (json) io.out(JSON.stringify(result, null, 2));
    if (!result.ok && !("port" in result)) return fail(io, result.reason);
    return printCheck(result, io, json);
  }
  if (command === "check-base") {
    if (positionals.length !== 1) return usage(io, "check-base needs one branch name");
    return checkBase(positionals[0] as string, io, exec);
  }
  if (positionals.length > 0) return usage(io, `unexpected argument ${positionals[0]}`);

  if (command === "up") {
    const result = envUp({
      cwd: io.cwd,
      exec,
      install: flags.has("--install"),
      db: flags.has("--db"),
    });
    if (!result.ok) return fail(io, result.reason);
    if (json) io.out(JSON.stringify(result, null, 2));
    else printUp(result, io);
    return 0;
  }
  if (command === "status") {
    const result = envStatus({ cwd: io.cwd, exec });
    if (!result.ok) return fail(io, result.reason);
    if (json) io.out(JSON.stringify(result, null, 2));
    else printStatus(result, io);
    return 0;
  }
  const result = envDown({ cwd: io.cwd, exec, db: flags.has("--db") });
  if (!result.ok) return fail(io, result.reason);
  if (json) io.out(JSON.stringify(result, null, 2));
  else printDown(result, io);
  return 0;
}

function portsLine(ports: Record<string, number>): string {
  return Object.entries(ports)
    .map(([name, port]) => `${name}=${port}`)
    .join(" ");
}

function printDatabase(db: DatabaseReport, io: CliIo, verb: "create" | "drop"): void {
  if (db === null) return;
  if ("refused" in db) {
    io.out(`database: not run — ${db.refused}`);
    return;
  }
  const command = verb === "create" ? db.create : db.drop;
  io.out(`database: ${db.name} (${db.ran ? `ran: ${command}` : `run with --db: ${command}`})`);
  for (const g of db.gates) io.out(`  ownership gate: ${g.resource} (owner ${g.owner}): ${g.rule}`);
}

function printUp(r: UpReport, io: CliIo): void {
  io.out(`worktree: ${r.worktree}`);
  io.out(`ports: ${portsLine(r.ports)}${r.reused ? " (existing lease)" : " (new lease)"}`);
  if (r.replaced) io.out(`  ${r.replaced}`);
  for (const f of r.files) {
    const keys = f.rewritten.length > 0 ? `, set ${f.rewritten.join(", ")}` : "";
    io.out(`env file ${f.path}: ${f.status}${keys}`);
  }
  if (r.deps.manager === null) io.out("deps: no lockfile found");
  else {
    const cmd = r.deps.command.join(" ");
    const state = r.deps.ran
      ? "installed"
      : r.deps.installed
        ? "node_modules present"
        : "not installed";
    io.out(
      `deps: ${r.deps.manager} (${state}); install with: ${cmd}${r.deps.ran ? "" : " (or env up --install)"}`,
    );
  }
  printDatabase(r.database, io, "create");
}

function printStatus(r: StatusReport, io: CliIo): void {
  io.out(`worktree: ${r.worktree}`);
  if (!r.ports) io.out("no ports leased — run: mitchstack env up");
  else io.out(`ports: ${portsLine(r.ports)}`);
  for (const l of r.listeners) {
    if (l.ok) io.out(`  ${l.port}: pid ${l.pid} in this worktree`);
    else io.out(`  ${l.port}: ${l.message}`);
  }
  for (const f of r.files) io.out(`env file ${f.path}: ${f.present ? "present" : "absent"}`);
  if (r.deps.manager === null) io.out("deps: no lockfile found");
  else
    io.out(
      `deps: ${r.deps.manager} (${r.deps.installed ? "node_modules present" : "not installed"})`,
    );
  printDatabase(r.database, io, "create");
}

function printDown(r: DownReport, io: CliIo): void {
  io.out(r.released ? `released ${portsLine(r.released)}` : "no ports were leased");
  printDatabase(r.database, io, "drop");
}

function printCheck(r: PortCheck, io: CliIo, json: boolean): number {
  if (r.ok) {
    if (!json) io.out(`port ${r.port}: pid ${r.pid} runs in this worktree (${r.cwd})`);
    return 0;
  }
  if (!json) io.err(r.message);
  return r.reason === "unavailable" ? 2 : 1;
}

/**
 * A worktree made from the wrong branch builds on stale code and its merge drags in unrelated
 * history. Exit 0 when HEAD contains the branch's tip, 1 when it does not, 2 when the branch is
 * unknown.
 */
function checkBase(branch: string, io: CliIo, exec: Exec): number {
  const tip = exec("git", ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], {
    cwd: io.cwd,
  });
  if (tip.code !== 0) {
    io.err(`no branch or commit named ${branch} here; fetch it first`);
    return 2;
  }
  const want = tip.stdout.trim();
  const head = exec("git", ["rev-parse", "HEAD"], { cwd: io.cwd }).stdout.trim();
  const ok = exec("git", ["merge-base", "--is-ancestor", want, "HEAD"], { cwd: io.cwd });
  if (ok.code === 0) {
    io.out(`HEAD ${head.slice(0, 7)} contains ${branch} (${want.slice(0, 7)})`);
    return 0;
  }
  io.err(
    `HEAD ${head.slice(0, 7)} does not contain ${branch} (${want.slice(0, 7)}): this worktree was made from the wrong branch. With no work yet: git reset --hard ${want}`,
  );
  return 1;
}

function fail(io: CliIo, reason: string): number {
  io.err(reason);
  return 1;
}

function usage(io: CliIo, reason?: string): number {
  if (reason) io.err(reason);
  io.err(USAGE);
  return 2;
}
