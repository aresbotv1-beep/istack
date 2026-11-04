import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { type EnvConfig, envSchema } from "../config/schema.js";
import { type DatabasePlan, type Gate, planDatabase } from "./database.js";
import { type DepsPlan, detectDeps } from "./deps.js";
import { type EnvFileOutcome, syncEnvFiles } from "./files.js";
import { type Exec, registryPathFor, resolveWorktree, type WorktreeInfo } from "./git.js";
import { checkPortOwnership, type PortCheck } from "./ownership.js";
import { allocatePorts, findLease, releasePorts } from "./ports.js";

/**
 * The env actions decide when each step runs (and whether it may); the services in this folder
 * do the work. Every action returns a structured report; the CLI only prints it.
 */

type Failure = { ok: false; reason: string };

interface Context {
  info: WorktreeInfo;
  env: EnvConfig;
  gates: Gate[];
  registryPath: string;
}

export type DatabaseReport =
  | null
  | { name: string; create: string; drop?: string; gates: Gate[]; ran: boolean }
  | { refused: string };

export interface UpReport {
  ok: true;
  worktree: string;
  mainRoot: string;
  registryPath: string;
  ports: Record<string, number>;
  reused: boolean;
  /** Set when the previous lease was no longer valid (reserved or out of range) and was replaced. */
  replaced?: string;
  files: EnvFileOutcome[];
  deps: DepsPlan & { ran: boolean };
  database: DatabaseReport;
}

export interface StatusReport {
  ok: true;
  worktree: string;
  ports: Record<string, number> | null;
  listeners: PortCheck[];
  files: { path: string; present: boolean }[];
  deps: DepsPlan;
  database: DatabaseReport;
}

export interface DownReport {
  ok: true;
  worktree: string;
  released: Record<string, number> | null;
  database: DatabaseReport;
}

function context(cwd: string, exec: Exec): { ok: true; ctx: Context } | Failure {
  const wt = resolveWorktree(cwd, exec);
  if (!wt.ok) return wt;
  const path = join(wt.info.root, "mitchstack.yaml");
  let env: EnvConfig = envSchema.parse(undefined);
  let gates: Gate[] = [];
  if (existsSync(path)) {
    const loaded = loadConfig(readFileSync(path, "utf8"));
    if (!loaded.ok) {
      const lines = loaded.errors.map((e) => `  ${e.path || "(file)"}: ${e.message}`);
      return { ok: false, reason: [`${path} is invalid:`, ...lines].join("\n") };
    }
    env = loaded.config.env;
    gates = loaded.config.ownershipGates;
  }
  return {
    ok: true,
    ctx: { info: wt.info, env, gates, registryPath: registryPathFor(wt.info.commonDir) },
  };
}

/** Ports named in ownership gates ("port 3200", "ports 5432") are never leased. */
export function gatedPorts(gates: Gate[]): number[] {
  return gates.flatMap((g) =>
    [...g.resource.matchAll(/\bports?\s+(\d{2,5})\b/gi)].map((m) => Number(m[1])),
  );
}

function databasePlan(ctx: Context): DatabasePlan | null {
  if (!ctx.env.database) return null;
  return planDatabase({
    spec: ctx.env.database,
    worktree: ctx.info.root,
    mainRoot: ctx.info.mainRoot,
    gates: ctx.gates,
  });
}

function runShell(command: string, cwd: string, exec: Exec): Failure | null {
  const r = exec("sh", ["-c", command], { cwd });
  if (r.code === 0) return null;
  return {
    ok: false,
    reason: `"${command}" failed (exit ${r.code}): ${(r.error ?? r.stderr).trim()}`,
  };
}

export function envUp(input: {
  cwd: string;
  exec: Exec;
  install: boolean;
  db: boolean;
}): UpReport | Failure {
  const c = context(input.cwd, input.exec);
  if (!c.ok) return c;
  const { ctx } = c;
  const { root, mainRoot } = ctx.info;

  const plan = databasePlan(ctx);
  if (input.db && !plan)
    return { ok: false, reason: "--db given but mitchstack.yaml has no env.database" };
  if (input.db && plan && !plan.ok) return plan;

  const lease = allocatePorts({
    worktree: root,
    registryPath: ctx.registryPath,
    range: { from: ctx.env.ports.from, to: ctx.env.ports.to },
    names: ctx.env.ports.names,
    reserved: gatedPorts(ctx.gates),
  });
  if (!lease.ok) return lease;

  const files = syncEnvFiles({
    mainRoot,
    worktree: root,
    files: ctx.env.files,
    ports: lease.ports,
  });
  if (!files.ok) return files;

  const deps = detectDeps(root);
  let ranInstall = false;
  if (input.install && deps.manager) {
    const [cmd, ...args] = deps.command;
    const r = input.exec(cmd as string, args, { cwd: root });
    if (r.code !== 0) {
      return {
        ok: false,
        reason: `${deps.command.join(" ")} failed (exit ${r.code}): ${(r.error ?? r.stderr).trim()}`,
      };
    }
    ranInstall = true;
  }

  let database: DatabaseReport = null;
  if (plan && !plan.ok) database = { refused: plan.reason };
  if (plan?.ok) {
    if (input.db) {
      const failed = runShell(plan.create, root, input.exec);
      if (failed) return failed;
    }
    database = {
      name: plan.name,
      create: plan.create,
      drop: plan.drop,
      gates: plan.gates,
      ran: input.db,
    };
  }

  return {
    ok: true,
    worktree: root,
    mainRoot,
    registryPath: ctx.registryPath,
    ports: lease.ports,
    reused: lease.reused,
    ...(lease.replaced ? { replaced: lease.replaced } : {}),
    files: files.files,
    deps: { ...deps, ran: ranInstall },
    database,
  };
}

export function envStatus(input: { cwd: string; exec: Exec }): StatusReport | Failure {
  const c = context(input.cwd, input.exec);
  if (!c.ok) return c;
  const { ctx } = c;
  const { root } = ctx.info;
  const lease = findLease({ worktree: root, registryPath: ctx.registryPath });
  const listeners = Object.values(lease?.ports ?? {}).map((port) =>
    checkPortOwnership({ port, worktree: root, worktrees: ctx.info.worktrees, exec: input.exec }),
  );
  const plan = databasePlan(ctx);
  return {
    ok: true,
    worktree: root,
    ports: lease?.ports ?? null,
    listeners,
    files: ctx.env.files.map((f) => ({ path: f.path, present: existsSync(join(root, f.path)) })),
    deps: detectDeps(root),
    database: plan === null ? null : plan.ok ? { ...plan, ran: false } : { refused: plan.reason },
  };
}

export function envDown(input: { cwd: string; exec: Exec; db: boolean }): DownReport | Failure {
  const c = context(input.cwd, input.exec);
  if (!c.ok) return c;
  const { ctx } = c;
  const { root } = ctx.info;
  const plan = databasePlan(ctx);
  let database: DatabaseReport = null;
  if (input.db) {
    if (!plan) return { ok: false, reason: "--db given but mitchstack.yaml has no env.database" };
    if (!plan.ok) return plan;
    if (!plan.drop) return { ok: false, reason: "--db given but env.database has no drop command" };
    const failed = runShell(plan.drop, root, input.exec);
    if (failed) return failed;
    database = { ...plan, ran: true };
  }
  const { released } = releasePorts({ worktree: root, registryPath: ctx.registryPath });
  return { ok: true, worktree: root, released, database };
}

export function envCheckPort(input: {
  cwd: string;
  exec: Exec;
  port: number;
}): PortCheck | Failure {
  const wt = resolveWorktree(input.cwd, input.exec);
  if (!wt.ok) return wt;
  return checkPortOwnership({
    port: input.port,
    worktree: wt.info.root,
    worktrees: wt.info.worktrees,
    exec: input.exec,
  });
}
