import { join } from "node:path";

export const HOSTS = ["claude", "codex", "cursor"] as const;
export type Host = (typeof HOSTS)[number];

/**
 * Where an install lands. `home` is a user-level install (every repo on the machine); `project` is
 * one repository. `codexHome` overrides `<home>/.codex` (Codex reads `CODEX_HOME`).
 */
export interface Scope {
  kind: "home" | "project";
  root: string;
  codexHome?: string;
}

export interface HostTarget {
  host: Host;
  /** The directory the host scans for `<name>/SKILL.md`. */
  skillsDir: string;
  /** The AGENTS.md the host reads, when it reads one at this scope. */
  agentsFile?: string;
  notes: string[];
}

/**
 * Discovery paths, from each host's own docs (checked 2026-11-04):
 * - Claude Code: `~/.claude/skills`, `.claude/skills`. The plugin route is preferred (namespaced).
 * - Codex: skills in `~/.agents/skills` and `.agents/skills`; AGENTS.md in `$CODEX_HOME` (default
 *   `~/.codex`) and from the repo root down.
 * - Cursor: skills in `~/.cursor/skills` and `.cursor/skills`; AGENTS.md in the project only.
 */
export function hostTarget(host: Host, scope: Scope): HostTarget {
  const { root } = scope;
  if (host === "claude") {
    return {
      host,
      skillsDir: join(root, ".claude", "skills"),
      notes: [
        "Claude Code: the plugin install namespaces every skill (istack:groundbreak) and never clashes — see the README",
      ],
    };
  }
  if (host === "codex") {
    const agentsFile =
      scope.kind === "home"
        ? join(scope.codexHome ?? join(root, ".codex"), "AGENTS.md")
        : join(root, "AGENTS.md");
    return {
      host,
      skillsDir: join(root, ".agents", "skills"),
      agentsFile,
      notes: [
        "Codex reads AGENTS.override.md instead of AGENTS.md when one exists in the same folder",
      ],
    };
  }
  if (scope.kind === "home") {
    return {
      host,
      skillsDir: join(root, ".cursor", "skills"),
      notes: [
        "Cursor has no user-level AGENTS.md; run with --project <repo> to add the contract to a repo",
      ],
    };
  }
  return {
    host,
    skillsDir: join(root, ".cursor", "skills"),
    agentsFile: join(root, "AGENTS.md"),
    notes: [],
  };
}
