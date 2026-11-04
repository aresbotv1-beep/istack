import { basename } from "node:path";

export interface DatabaseSpec {
  /** Template for the isolated database name; must use {{worktree}}. */
  name: string;
  /** Shell command template that creates it, e.g. "createdb {{name}}". */
  create: string;
  /** Optional shell command template run on `env down --db`. */
  drop?: string;
}

export interface Gate {
  resource: string;
  owner: string;
  rule: string;
}

export type DatabasePlan =
  | { ok: true; name: string; create: string; drop?: string; gates: Gate[] }
  | { ok: false; reason: string };

/** Lowercase, [a-z0-9_] only: safe as a database name and inside a shell command. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "x"
  );
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] as string) : whole,
  );
}

const DESTRUCTIVE = /\b(drop\w*|reset|migrat\w*|truncate|wipe|purge)\b/i;
const DATABASE_GATE = /\b(database|db|postgres\w*|mysql|sqlite|schema)\b/i;

/**
 * Plan the per-worktree database. The hook only ever targets a name derived from the worktree:
 * it refuses the main checkout (whose database is the shared one), names that are not
 * per-worktree, and create steps that wipe or migrate anything.
 */
export function planDatabase(input: {
  spec: DatabaseSpec;
  worktree: string;
  mainRoot: string;
  gates: Gate[];
}): DatabasePlan {
  const { spec, worktree, mainRoot } = input;
  if (worktree === mainRoot) {
    return {
      ok: false,
      reason:
        "refusing to run the database hook in the main checkout: its database is the shared one",
    };
  }
  if (!spec.name.includes("{{worktree}}")) {
    return { ok: false, reason: `database name "${spec.name}" must include {{worktree}}` };
  }
  if (!spec.create.includes("{{name}}")) {
    return { ok: false, reason: "database create command must target {{name}}" };
  }
  if (DESTRUCTIVE.test(spec.create)) {
    return {
      ok: false,
      reason: "database create command must not wipe or migrate anything; run migrations yourself",
    };
  }
  if (spec.drop !== undefined && !spec.drop.includes("{{name}}")) {
    return { ok: false, reason: "database drop command must target {{name}}" };
  }
  const name = slug(
    renderTemplate(spec.name, {
      repo: slug(basename(mainRoot)),
      worktree: slug(basename(worktree)),
    }),
  );
  const vars = { name };
  return {
    ok: true,
    name,
    create: renderTemplate(spec.create, vars),
    ...(spec.drop !== undefined ? { drop: renderTemplate(spec.drop, vars) } : {}),
    gates: input.gates.filter((g) => DATABASE_GATE.test(g.resource)),
  };
}
