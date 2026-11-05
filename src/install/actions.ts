import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "../config/load.js";
import { mergeBlock, removeBlock, renderBlock } from "./block.js";
import { type Host, hostTarget, type Scope } from "./hosts.js";
import { type Kit, prefixSkills } from "./kit.js";
import { checkLocations, gitHooksDir } from "./locations.js";
import {
  type BlockEntry,
  type DirEntry,
  type HookEntry,
  MANIFEST_PATH,
  type Manifest,
  type Owner,
  readManifest,
  renderManifest,
  type SkillEntry,
  sha256,
} from "./manifest.js";

export type ItemStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "removed"
  | "skipped"
  | "kept"
  | "note";

export interface ReportItem {
  status: ItemStatus;
  /** Relative to the install root; empty for notes. */
  path: string;
  detail: string;
}

export interface Report {
  scope: Scope;
  dryRun: boolean;
  items: ReportItem[];
  /** True when something was skipped or kept: the user should read the report. */
  attention: boolean;
}

interface Ctx {
  root: string;
  manifest: Manifest;
  dryRun: boolean;
  items: ReportItem[];
}

export interface InstallOptions {
  scope: Scope;
  hosts: Host[];
  kit: Kit;
  /** Install every skill as `mitchstack-<name>` so it cannot clash with a personal skill. */
  prefix?: boolean;
  /** Also write a git pre-push hook running the repo's checks (project scope only). */
  hooks?: boolean;
  dryRun?: boolean;
}

export function install(options: InstallOptions): Report {
  // A fresh install has no record to check, so plan it first (a dry run writes nothing but fills
  // the record it would save) and check every destination in that planned record before any
  // write. The same rule as uninstall: nothing outside mitchstack's locations, nothing through a
  // symlink that leaves the root.
  const planned = installInto(context(options.scope, true), options);
  const problems = checkLocations(planned.manifest, options.scope);
  if (problems.length > 0) {
    throw new Error(
      `the install would write outside mitchstack's install locations, so nothing was written: ${problems.join("; ")}`,
    );
  }
  if (options.dryRun) return finish(planned, options.scope);
  return finish(installInto(context(options.scope, false), options), options.scope);
}

function installInto(ctx: Ctx, options: InstallOptions): Ctx {
  const { scope, kit } = options;
  const blocks = new Map<string, Host[]>();
  const skills = options.prefix ? prefixSkills(kit.skills, "mitchstack-") : kit.skills;
  for (const host of options.hosts) {
    const target = hostTarget(host, scope);
    for (const skill of skills) installSkill(ctx, host, target.skillsDir, skill);
    if (target.agentsFile)
      blocks.set(target.agentsFile, [...(blocks.get(target.agentsFile) ?? []), host]);
    for (const note of target.notes) ctx.items.push({ status: "note", path: "", detail: note });
  }
  for (const [path, hosts] of blocks) installBlock(ctx, path, hosts, kit.contract);
  if (options.hooks) installHook(ctx, kit.hookTemplate);
  return ctx;
}

export interface UninstallOptions {
  scope: Scope;
  hosts: Host[];
  /** Remove the pre-push hook too (implied when every host is removed). */
  hooks?: boolean;
  dryRun?: boolean;
}

export function uninstall(options: UninstallOptions): Report {
  const ctx = context(options.scope, options.dryRun ?? false);
  const hosts = new Set<Owner>(options.hosts);
  if (options.hooks) hosts.add("git");
  const { manifest } = ctx;
  const keep: typeof manifest.entries = [];
  for (const entry of manifest.entries) {
    if (entry.kind === "skill" && hosts.has(entry.host)) {
      const left = uninstallSkill(ctx, entry);
      if (left) keep.push(left);
    } else if (entry.kind === "block" && entry.hosts.some((h) => hosts.has(h))) {
      const left = uninstallBlock(ctx, entry, hosts);
      if (left) keep.push(left);
    } else if (entry.kind === "hook" && hosts.has("git")) {
      const left = uninstallHook(ctx, entry);
      if (left) keep.push(left);
    } else {
      keep.push(entry);
    }
  }
  const dirs = keep.filter((e): e is DirEntry => e.kind === "dir");
  const rest = keep.filter((e) => e.kind !== "dir");
  const keptDirs: DirEntry[] = [];
  for (const dir of [...dirs].sort((a, b) => depth(b.path) - depth(a.path))) {
    const owners = dir.owners.filter((o) => !hosts.has(o));
    if (owners.length > 0) {
      keptDirs.push({ ...dir, owners });
      continue;
    }
    if (!removeDirIfEmpty(ctx, resolve(ctx.root, dir.path))) keptDirs.push(dir);
  }
  manifest.entries = [...keptDirs, ...rest];
  return finish(ctx, options.scope);
}

// — internals —

/**
 * Read and check the install record before anything is touched. A record naming any path mitchstack
 * could not have written (outside the host locations, `..`, absolute, or out through a symlink) is
 * refused whole: the run throws and nothing changes.
 */
function context(scope: Scope, dryRun: boolean): Ctx {
  const manifest = readManifest(scope.root);
  const problems = checkLocations(manifest, scope);
  if (problems.length > 0) {
    throw new Error(
      `${join(scope.root, MANIFEST_PATH)} names paths outside mitchstack's install locations, so it is refused and nothing changed: ${problems.join("; ")}`,
    );
  }
  return { root: scope.root, manifest, dryRun, items: [] };
}

function rel(ctx: Ctx, abs: string): string {
  return relative(ctx.root, abs).split(sep).join("/");
}

function depth(path: string): number {
  return path.split("/").length;
}

function read(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

function finish(ctx: Ctx, scope: Scope): Report {
  saveManifest(ctx);
  const attention = ctx.items.some((i) => i.status === "skipped" || i.status === "kept");
  return { scope, dryRun: ctx.dryRun, items: ctx.items, attention };
}

function saveManifest(ctx: Ctx): void {
  if (ctx.dryRun) return;
  const path = join(ctx.root, MANIFEST_PATH);
  if (ctx.manifest.entries.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    removeDirIfEmpty(ctx, dirname(path));
    return;
  }
  const text = renderManifest(ctx.manifest);
  if (read(path)?.toString("utf8") === text) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function removeDirIfEmpty(ctx: Ctx, abs: string): boolean {
  if (!existsSync(abs)) return true;
  if (!statSync(abs).isDirectory() || readdirSync(abs).length > 0) return false;
  if (!ctx.dryRun) rmdirSync(abs);
  return true;
}

/** Create `abs` and record every directory the install made, so uninstall can take them away. */
function ensureDir(ctx: Ctx, abs: string, owner: Owner): void {
  const missing: string[] = [];
  let dir = abs;
  while (!existsSync(dir)) {
    missing.push(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (missing.length > 0 && !ctx.dryRun) mkdirSync(abs, { recursive: true });
  for (const made of missing) addDirOwner(ctx, rel(ctx, made), owner, true);
  // Directories an earlier install made for another host now serve this one too.
  for (let up = dir; up.startsWith(ctx.root) && up !== ctx.root; up = dirname(up)) {
    addDirOwner(ctx, rel(ctx, up), owner, false);
  }
}

function addDirOwner(ctx: Ctx, path: string, owner: Owner, create: boolean): void {
  const entry = ctx.manifest.entries.find(
    (e): e is DirEntry => e.kind === "dir" && e.path === path,
  );
  if (entry) {
    if (!entry.owners.includes(owner)) entry.owners = [...entry.owners, owner].sort();
  } else if (create) {
    ctx.manifest.entries.push({ kind: "dir", owners: [owner], path });
  }
}

function write(ctx: Ctx, abs: string, data: Buffer | string, owner: Owner, mode?: number): boolean {
  const before = read(abs);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  if (before?.equals(bytes)) return false;
  ensureDir(ctx, dirname(abs), owner);
  if (!ctx.dryRun) {
    writeFileSync(abs, bytes);
    if (mode !== undefined) chmodSync(abs, mode);
  }
  return true;
}

function installSkill(ctx: Ctx, host: Host, skillsDir: string, skill: Kit["skills"][number]): void {
  const dirAbs = join(skillsDir, skill.name);
  const dirRel = rel(ctx, dirAbs);
  const entry = ctx.manifest.entries.find(
    (e): e is SkillEntry => e.kind === "skill" && e.host === host && e.dir === dirRel,
  );
  if (!entry && existsSync(dirAbs)) {
    ctx.items.push({
      status: "skipped",
      path: dirRel,
      detail: `${host}: a skill named ${skill.name} already exists and is not mitchstack's — left untouched (use --prefix to install as mitchstack-${skill.name})`,
    });
    return;
  }
  const edited = Object.entries(entry?.files ?? {}).filter(([file, sha]) => {
    const disk = read(join(dirAbs, file));
    return disk !== null && sha256(disk) !== sha;
  });
  // A file on disk that this record did not write is never adopted, even when its bytes match.
  const foreign = [...skill.files.keys()].filter(
    (file) => !entry?.files[file] && existsSync(join(dirAbs, file)),
  );
  const touched = [...edited.map(([f]) => f), ...foreign];
  if (touched.length > 0) {
    ctx.items.push({
      status: "kept",
      path: dirRel,
      detail: `${host}: ${skill.name} has files changed since install (${touched.join(", ")}) — left as you have it`,
    });
    return;
  }
  let changed = false;
  for (const [file, data] of skill.files)
    changed = write(ctx, join(dirAbs, file), data, host) || changed;
  for (const [file, sha] of Object.entries(entry?.files ?? {})) {
    if (skill.files.has(file)) continue;
    const path = join(dirAbs, file);
    const disk = read(path);
    if (disk && sha256(disk) === sha && !ctx.dryRun) unlinkSync(path);
    changed = true;
  }
  const files = Object.fromEntries([...skill.files].map(([file, data]) => [file, sha256(data)]));
  if (entry) entry.files = files;
  else ctx.manifest.entries.push({ kind: "skill", host, dir: dirRel, files });
  const count = `${skill.files.size} file${skill.files.size === 1 ? "" : "s"}`;
  ctx.items.push({
    status: !entry ? "created" : changed ? "updated" : "unchanged",
    path: dirRel,
    detail: `${host}: skill ${skill.name} (${count})`,
  });
}

function installBlock(ctx: Ctx, abs: string, hosts: Host[], contract: string): void {
  const path = rel(ctx, abs);
  const entry = ctx.manifest.entries.find(
    (e): e is BlockEntry => e.kind === "block" && e.path === path,
  );
  const existing = read(abs)?.toString("utf8") ?? null;
  const merged = mergeBlock(existing, renderBlock(contract), entry?.prefix ?? "");
  const who = hosts.join(" + ");
  if (!merged.ok) {
    ctx.items.push({ status: "skipped", path, detail: `${who}: AGENTS.md ${merged.reason}` });
    return;
  }
  if (!entry && merged.replaced) {
    ctx.items.push({
      status: "skipped",
      path,
      detail: `${who}: AGENTS.md already has a mitchstack block this install did not write — left untouched and not recorded (remove it and re-run to let the installer own it)`,
    });
    return;
  }
  const changed = write(ctx, abs, merged.text, hosts[0] as Host);
  for (const host of hosts.slice(1)) ensureDir(ctx, dirname(abs), host);
  if (entry) {
    entry.hosts = [...new Set([...entry.hosts, ...hosts])].sort();
    entry.prefix = merged.prefix;
  } else {
    ctx.manifest.entries.push({
      kind: "block",
      hosts: [...hosts].sort(),
      path,
      prefix: merged.prefix,
      createdFile: existing === null,
    });
  }
  ctx.items.push({
    status: existing === null ? "created" : changed ? "updated" : "unchanged",
    path,
    detail: `${who}: the mitchstack contract between ${"<!-- mitchstack:begin/end -->"} markers; text outside them untouched`,
  });
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function renderHook(
  template: string,
  checks: ReadonlyArray<{ name: string; run: string }>,
): string {
  const lines = checks.map((c) => `mitchstack_check ${shellQuote(c.name)} ${shellQuote(c.run)}`);
  return template.replace("# @@CHECKS@@", lines.join("\n"));
}

function installHook(ctx: Ctx, template: string): void {
  const hooksDir = gitHooksDir(ctx.root);
  if (!hooksDir) {
    ctx.items.push({ status: "skipped", path: "", detail: "pre-push hook: not a git repository" });
    return;
  }
  const abs = join(hooksDir, "pre-push");
  const path = rel(ctx, abs);
  const configPath = join(ctx.root, "mitchstack.yaml");
  if (!existsSync(configPath)) {
    ctx.items.push({
      status: "skipped",
      path,
      detail: "pre-push hook: no mitchstack.yaml, so no checks to run",
    });
    return;
  }
  const config = loadConfig(readFileSync(configPath, "utf8"));
  if (!config.ok) {
    ctx.items.push({
      status: "skipped",
      path,
      detail: "pre-push hook: mitchstack.yaml is invalid (run mitchstack config check)",
    });
    return;
  }
  const text = renderHook(template, config.config.checks);
  const entry = ctx.manifest.entries.find(
    (e): e is HookEntry => e.kind === "hook" && e.path === path,
  );
  const disk = read(abs);
  // A hook this record did not write is never adopted, even when its bytes match ours.
  if (disk && !entry) {
    ctx.items.push({
      status: "skipped",
      path,
      detail:
        "pre-push hook: this repo already has a pre-push hook mitchstack did not write — left untouched and not recorded; call your checks from it, or remove it and re-run with --hooks",
    });
    return;
  }
  if (disk && entry && sha256(disk) !== entry.sha && !disk.equals(Buffer.from(text))) {
    ctx.items.push({
      status: "kept",
      path,
      detail: "pre-push hook: changed since install — left as you have it",
    });
    return;
  }
  const changed = write(ctx, abs, text, "git", 0o755);
  if (entry) entry.sha = sha256(text);
  else ctx.manifest.entries.push({ kind: "hook", path, sha: sha256(text) });
  ctx.items.push({
    status: !disk ? "created" : changed ? "updated" : "unchanged",
    path,
    detail: `pre-push hook: runs ${config.config.checks.map((c) => c.name).join(", ")} before every push`,
  });
}

function uninstallSkill(ctx: Ctx, entry: SkillEntry): SkillEntry | null {
  const dirAbs = resolve(ctx.root, entry.dir);
  const kept: Record<string, string> = {};
  for (const [file, sha] of Object.entries(entry.files)) {
    const path = join(dirAbs, file);
    const disk = read(path);
    if (!disk) continue;
    if (sha256(disk) === sha) {
      if (!ctx.dryRun) unlinkSync(path);
    } else kept[file] = sha;
  }
  const keptFiles = Object.keys(kept);
  if (keptFiles.length > 0) {
    ctx.items.push({
      status: "kept",
      path: entry.dir,
      detail: `${entry.host}: ${keptFiles.join(", ")} changed since install — left in place`,
    });
    return { ...entry, files: kept };
  }
  ctx.items.push({ status: "removed", path: entry.dir, detail: `${entry.host}: skill` });
  return null;
}

function uninstallBlock(ctx: Ctx, entry: BlockEntry, hosts: Set<Owner>): BlockEntry | null {
  const remaining = entry.hosts.filter((h) => !hosts.has(h));
  if (remaining.length > 0) return { ...entry, hosts: remaining };
  const abs = resolve(ctx.root, entry.path);
  const text = read(abs)?.toString("utf8");
  const next = text === undefined ? null : removeBlock(text, entry.prefix);
  if (next !== null && !ctx.dryRun) {
    if (next === "" && entry.createdFile) unlinkSync(abs);
    else writeFileSync(abs, next);
  }
  ctx.items.push({
    status: "removed",
    path: entry.path,
    detail: `${entry.hosts.join(" + ")}: AGENTS.md block`,
  });
  return null;
}

function uninstallHook(ctx: Ctx, entry: HookEntry): HookEntry | null {
  const abs = resolve(ctx.root, entry.path);
  const disk = read(abs);
  if (disk && sha256(disk) !== entry.sha) {
    ctx.items.push({
      status: "kept",
      path: entry.path,
      detail: "pre-push hook: changed since install — left in place",
    });
    return entry;
  }
  if (disk && !ctx.dryRun) unlinkSync(abs);
  ctx.items.push({ status: "removed", path: entry.path, detail: "pre-push hook" });
  return null;
}
