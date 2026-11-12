import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { HOSTS, type Host, hostTarget, type Scope } from "./hosts.js";
import type { Entry, Manifest } from "./manifest.js";

/** The git hooks directory for `root`, or null when it is not a git repository. */
export function gitHooksDir(root: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return resolve(root, out.trim());
  } catch {
    return null;
  }
}

/** A place the installer may write, and the directory a write there must stay inside. */
interface Anchor {
  path: string;
  base: string;
  /** Folders below `path` count too (a skill's own subfolders). */
  subtree?: boolean;
}

interface Permitted {
  skillsDirs: Map<Host, string>;
  agentsFiles: Map<Host, Anchor[]>;
  hooks: Anchor[];
  /** Directories the installer may have created: these and their ancestors, below each base. */
  dirAnchors: Anchor[];
}

/**
 * Every location an install at `scope.root` can write, for both scope kinds (the root is the same;
 * the record does not say which kind wrote it). Nothing else may appear in the record.
 */
function permitted(scope: Scope): Permitted {
  const root = scope.root;
  const skillsDirs = new Map<Host, string>();
  const agentsFiles = new Map<Host, Anchor[]>();
  const dirAnchors: Anchor[] = [];
  for (const host of HOSTS) {
    for (const kind of ["home", "project"] as const) {
      const target = hostTarget(host, { ...scope, kind });
      skillsDirs.set(host, target.skillsDir);
      dirAnchors.push({ path: target.skillsDir, base: root, subtree: true });
      if (!target.agentsFile) continue;
      const outside = !within(root, target.agentsFile);
      const base = outside ? dirname(dirname(target.agentsFile)) : root;
      const list = agentsFiles.get(host) ?? [];
      list.push({ path: target.agentsFile, base });
      agentsFiles.set(host, list);
      dirAnchors.push({ path: dirname(target.agentsFile), base });
    }
  }
  const hooksDirs = new Set([join(root, ".git", "hooks")]);
  const fromGit = gitHooksDir(root);
  if (fromGit) hooksDirs.add(fromGit);
  const hooks = [...hooksDirs].map((dir) => ({ path: join(dir, "pre-push"), base: dir }));
  for (const dir of hooksDirs) dirAnchors.push({ path: dir, base: dirname(dir) });
  return { skillsDirs, agentsFiles, hooks, dirAnchors };
}

function within(base: string, path: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** realpath of the longest existing prefix of `path`, with the rest appended as written. */
function realish(path: string): string {
  const rest: string[] = [];
  let cur = path;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return path;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/** A relative path of plain segments: no `..`, no `.`, no empty segment, not absolute. */
function plainRelative(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function rel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/**
 * Check every entry against the locations an install can write, before anything is touched. Returns
 * the problems; an empty list means every path the record names is one istack could have written
 * and still resolves (through any symlink) inside the directory it belongs to.
 */
export function checkLocations(manifest: Manifest, scope: Scope): string[] {
  const root = scope.root;
  const allowed = permitted(scope);
  const problems: string[] = [];
  const mustStayIn = (label: string, abs: string, base: string, strict = false) => {
    const real = realish(abs);
    const realBase = realish(base);
    if (!within(realBase, real) || (strict && real === realBase)) {
      problems.push(
        `${label} resolves to ${real}, outside ${realBase}${real !== abs ? " (through a symlink)" : ""}`,
      );
    }
  };
  manifest.entries.forEach((entry: Entry, i) => {
    const label = `entry ${i} (${entry.kind} ${entry.kind === "skill" ? entry.dir : entry.path})`;
    if (entry.kind === "skill") {
      const skillsDir = allowed.skillsDirs.get(entry.host) as string;
      const abs = resolve(root, entry.dir);
      if (
        dirname(abs) !== skillsDir ||
        !plainRelative(basename(abs)) ||
        entry.dir !== rel(root, abs)
      ) {
        problems.push(`${label}: not a ${entry.host} skill folder under ${rel(root, skillsDir)}/`);
        return;
      }
      mustStayIn(label, abs, root, true);
      for (const file of Object.keys(entry.files)) {
        if (!plainRelative(file)) {
          problems.push(`${label}: file ${JSON.stringify(file)} is not a plain relative path`);
          continue;
        }
        mustStayIn(`${label} file ${file}`, join(abs, file), abs, true);
      }
    } else if (entry.kind === "block") {
      const abs = resolve(root, entry.path);
      for (const host of entry.hosts) {
        const match = (allowed.agentsFiles.get(host) ?? []).find((a) => a.path === abs);
        if (!match) problems.push(`${label}: not an AGENTS.md ${host} reads`);
        else mustStayIn(label, abs, match.base, true);
      }
    } else if (entry.kind === "hook") {
      const abs = resolve(root, entry.path);
      const match = allowed.hooks.find((a) => a.path === abs);
      if (!match) problems.push(`${label}: not this repository's git pre-push hook`);
      else mustStayIn(label, abs, match.base, true);
    } else {
      const abs = resolve(root, entry.path);
      const anchor = allowed.dirAnchors.find(
        (a) =>
          within(a.base, abs) &&
          abs !== a.base &&
          (within(abs, a.path) || (a.subtree === true && within(a.path, abs))),
      );
      if (!anchor) problems.push(`${label}: not a folder an install creates`);
      else mustStayIn(label, abs, anchor.base, true);
    }
  });
  return problems;
}
