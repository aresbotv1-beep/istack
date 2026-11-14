import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { toFieldErrors } from "../result.js";
import { type Degrade, degradeSchema } from "./schema.js";

/** A skill as an agent would load it: SKILL.md first, then every other file it can open. */
export interface SkillText {
  name: string;
  files: { path: string; text: string }[];
  /** Every file, each under its own header, SKILL.md first. */
  text: string;
  /** sha256 over the files as scored. */
  hash: string;
}

export function skillFromFiles(name: string, files: { path: string; text: string }[]): SkillText {
  const sorted = [...files].sort((a, b) =>
    a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path),
  );
  const hash = createHash("sha256");
  for (const f of sorted) hash.update(`${f.path}\n${f.text}\n`);
  const text = sorted.map((f) => `<file path="${f.path}">\n${f.text.trim()}\n</file>`).join("\n\n");
  return { name, files: sorted, text, hash: hash.digest("hex") };
}

/** Reads `skills/<name>/` (text files only). Throws when the skill has no SKILL.md. */
export function loadSkill(root: string, name: string, skillsDir = "skills"): SkillText {
  const dir = join(root, skillsDir, name);
  if (!existsSync(join(dir, "SKILL.md"))) throw new Error(`no skill at ${join(dir, "SKILL.md")}`);
  const files: { path: string; text: string }[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(md|txt|json|ya?ml)$/i.test(entry)) {
        files.push({ path: relative(dir, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return skillFromFiles(name, files);
}

/**
 * Reads `skills/<name>/` as it was at a git commit, without checking it out: the skill a baseline
 * should describe when a change edits it (retro 2026-11-13 R2). Throws on an unknown ref or skill.
 */
export function loadSkillAt(
  root: string,
  name: string,
  ref: string,
  skillsDir = "skills",
): SkillText {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  let commit: string;
  try {
    commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`not a commit: ${ref}`);
  }
  // Paths in a tree are from the repo root; `root` may be a subdirectory (or a symlinked path).
  const prefix = `${git(["rev-parse", "--show-prefix"]).trim()}${skillsDir}/${name}`;
  const paths = git(["ls-tree", "-r", "--full-tree", "--name-only", commit, "--", `${prefix}/`])
    .split("\n")
    .filter(Boolean);
  if (!paths.includes(`${prefix}/SKILL.md`))
    throw new Error(`no skill at ${prefix}/SKILL.md in ${ref}`);
  const files = paths
    .filter((p) => /\.(md|txt|json|ya?ml)$/i.test(p))
    .map((p) => ({ path: p.slice(prefix.length + 1), text: git(["show", `${commit}:${p}`]) }));
  return skillFromFiles(name, files);
}

export function loadDegrade(path: string): Degrade {
  const parsed = degradeSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const errors = toFieldErrors(parsed.error.issues).map((e) => `${e.path}: ${e.message}`);
    throw new Error(`${path} is not a degrade spec: ${errors.join("; ")}`);
  }
  return parsed.data;
}

/**
 * Delete a markdown section: the heading line through the line before the next heading of the
 * same or a higher level. Throws when the heading is not there, so a stale spec fails loudly.
 */
export function removeSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading.trim());
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const level = (heading.match(/^#+/)?.[0].length ?? 0) || 1;
  let end = start + 1;
  while (end < lines.length) {
    const m = (lines[end] as string).match(/^(#+)\s/);
    if (m && (m[1] as string).length <= level) break;
    end += 1;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

export function applyDegrade(skill: SkillText, degrade: Degrade): SkillText {
  if (degrade.skill !== skill.name) {
    throw new Error(`degrade spec is for ${degrade.skill}, not ${skill.name}`);
  }
  for (const f of degrade.removeFiles) {
    if (!skill.files.some((s) => s.path === f)) throw new Error(`no file ${f} in ${skill.name}`);
  }
  const lineRes = degrade.removeLines.map((p) => new RegExp(p, "i"));
  const pending = new Set(degrade.removeSections);
  const files = skill.files
    .filter((f) => !degrade.removeFiles.includes(f.path))
    .map((f) => {
      let text = f.text;
      for (const heading of degrade.removeSections) {
        if (text.split("\n").some((l) => l.trim() === heading.trim())) {
          text = removeSection(text, heading);
          pending.delete(heading);
        }
      }
      text = text
        .split("\n")
        .filter((l) => !lineRes.some((r) => r.test(l)))
        .join("\n");
      return { path: f.path, text };
    });
  if (pending.size > 0) throw new Error(`headings not found: ${[...pending].join(", ")}`);
  return skillFromFiles(skill.name, files);
}
