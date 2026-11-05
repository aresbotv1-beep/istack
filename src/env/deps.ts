import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type DepsPlan =
  | { manager: null }
  | {
      manager: PackageManager;
      lockfile: string;
      /** The install command, as argv. Runs only when asked (`env up --install`). */
      command: string[];
      installed: boolean;
    };

/** First match wins, so a repo carrying a stray second lockfile still gets one answer. */
const LOCKFILES: ReadonlyArray<[string, PackageManager, string[]]> = [
  ["package-lock.json", "npm", ["npm", "ci"]],
  ["pnpm-lock.yaml", "pnpm", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", "yarn", ["yarn", "install", "--frozen-lockfile"]],
  ["bun.lock", "bun", ["bun", "install", "--frozen-lockfile"]],
  ["bun.lockb", "bun", ["bun", "install", "--frozen-lockfile"]],
];

export function detectDeps(root: string): DepsPlan {
  for (const [lockfile, manager, command] of LOCKFILES) {
    if (existsSync(join(root, lockfile))) {
      return { manager, lockfile, command, installed: existsSync(join(root, "node_modules")) };
    }
  }
  return { manager: null };
}
