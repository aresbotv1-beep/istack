import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface KitSkill {
  name: string;
  /** Relative path (forward slashes) → bytes. */
  files: Map<string, Buffer>;
}

export interface Kit {
  root: string;
  skills: KitSkill[];
  contract: string;
  hookTemplate: string;
}

function isKitRoot(dir: string): boolean {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg) || !existsSync(join(dir, "skills")) || !existsSync(join(dir, "AGENTS.md")))
    return false;
  try {
    return JSON.parse(readFileSync(pkg, "utf8")).name === "mitchstack";
  } catch {
    return false;
  }
}

/** The installed package (or this checkout): the nearest parent holding mitchstack's package.json. */
export function findKitRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  while (!isKitRoot(dir)) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`cannot find the mitchstack kit above ${from}`);
    dir = up;
  }
  return dir;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? filesUnder(full) : [full];
    });
}

export function loadKit(root: string): Kit {
  const skillsDir = join(root, "skills");
  const skills = readdirSync(skillsDir)
    .sort()
    .filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
    .map((name) => {
      const dir = join(skillsDir, name);
      const files = new Map<string, Buffer>();
      for (const file of filesUnder(dir)) {
        files.set(relative(dir, file).split(sep).join("/"), readFileSync(file));
      }
      return { name, files };
    });
  return {
    root,
    skills,
    contract: readFileSync(join(root, "AGENTS.md"), "utf8"),
    hookTemplate: readFileSync(join(root, "hooks", "pre-push.sh"), "utf8"),
  };
}

/** Rename a skill for a `mitchstack-` prefixed install: the frontmatter name must match the folder. */
export function renameSkill(skill: KitSkill, name: string): KitSkill {
  const files = new Map(skill.files);
  const text = files.get("SKILL.md")?.toString("utf8");
  if (text !== undefined) {
    files.set(
      "SKILL.md",
      Buffer.from(text.replace(/^(---\r?\nname:\s*).+$/m, `$1${name}`), "utf8"),
    );
  }
  return { name, files };
}
