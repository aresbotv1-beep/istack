import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

export interface EnvFileSpec {
  /** Relative to the checkout root. */
  path: string;
  /** KEY → port name ("web") or template ("http://127.0.0.1:{{api}}"). */
  set: Record<string, string>;
}

/** Outcomes name files and keys only. Values never leave the file, so secrets are never printed. */
export interface EnvFileOutcome {
  path: string;
  status: "copied" | "kept" | "missing-in-main" | "main-checkout";
  rewritten: string[];
}

export type SyncResult = { ok: true; files: EnvFileOutcome[] } | { ok: false; reason: string };

export function renderPortValue(value: string, ports: Record<string, number>): string {
  if (Object.hasOwn(ports, value)) return String(ports[value]);
  return value.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.hasOwn(ports, name) ? String(ports[name]) : whole,
  );
}

/** Set each KEY in dotenv text, keeping every other line byte-for-byte. Missing keys are appended. */
export function rewriteEnv(
  text: string,
  assignments: Record<string, string>,
): { text: string; rewritten: string[] } {
  const pending = new Map(Object.entries(assignments));
  const lines = text.split("\n");
  const out = lines.map((line) => {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*$/.exec(line);
    const key = match?.[2];
    if (!match || key === undefined || !pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${match[1]}${key}${match[3]}${value}`;
  });
  const appended = [...pending].map(([key, value]) => `${key}=${value}`);
  if (appended.length > 0) {
    if (out.at(-1) === "") out.pop();
    out.push(...appended, "");
  }
  return { text: out.join("\n"), rewritten: Object.keys(assignments) };
}

export function syncEnvFiles(input: {
  mainRoot: string;
  worktree: string;
  files: EnvFileSpec[];
  ports: Record<string, number>;
}): SyncResult {
  const outcomes: EnvFileOutcome[] = [];
  for (const file of input.files) {
    const rel = normalize(file.path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      return { ok: false, reason: `env file ${file.path} must stay inside the checkout` };
    }
    if (input.worktree === input.mainRoot) {
      outcomes.push({ path: file.path, status: "main-checkout", rewritten: [] });
      continue;
    }
    const target = join(input.worktree, rel);
    const source = join(input.mainRoot, rel);
    if (existsSync(target)) {
      outcomes.push({ path: file.path, status: "kept", rewritten: [] });
      continue;
    }
    if (!existsSync(source)) {
      outcomes.push({ path: file.path, status: "missing-in-main", rewritten: [] });
      continue;
    }
    copyFileSync(source, target);
    const assignments = Object.fromEntries(
      Object.entries(file.set).map(([key, value]) => [key, renderPortValue(value, input.ports)]),
    );
    const { text, rewritten } = rewriteEnv(readFileSync(target, "utf8"), assignments);
    writeFileSync(target, text);
    outcomes.push({ path: file.path, status: "copied", rewritten });
  }
  return { ok: true, files: outcomes };
}
