import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "./hosts.js";

/** Who owns a directory or file: a host, or "git" for the pre-push hook. */
export type Owner = Host | "git";

export interface SkillEntry {
  kind: "skill";
  host: Host;
  /** Paths are relative to the install root, forward slashes. */
  dir: string;
  /** File (relative to dir) → sha256 of what the install wrote. */
  files: Record<string, string>;
}

export interface BlockEntry {
  kind: "block";
  hosts: Host[];
  path: string;
  /** What the install put before the block, so uninstall restores the file byte for byte. */
  prefix: string;
  createdFile: boolean;
}

export interface HookEntry {
  kind: "hook";
  path: string;
  sha: string;
}

export interface DirEntry {
  kind: "dir";
  owners: Owner[];
  path: string;
}

export type Entry = SkillEntry | BlockEntry | HookEntry | DirEntry;

/** No timestamps: re-installing the same kit must leave this file byte-identical. */
export interface Manifest {
  version: 1;
  entries: Entry[];
}

export const MANIFEST_PATH = join(".mitchstack", "install.json");

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function readManifest(root: string): Manifest {
  const path = join(root, MANIFEST_PATH);
  if (!existsSync(path)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`${path} is not a mitchstack install manifest`);
  }
  return parsed;
}

const ORDER = { dir: 0, skill: 1, block: 2, hook: 3 } as const;

export function renderManifest(manifest: Manifest): string {
  const entries = [...manifest.entries].sort((a, b) =>
    ORDER[a.kind] !== ORDER[b.kind]
      ? ORDER[a.kind] - ORDER[b.kind]
      : keyOf(a) < keyOf(b)
        ? -1
        : keyOf(a) > keyOf(b)
          ? 1
          : 0,
  );
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

function keyOf(entry: Entry): string {
  return entry.kind === "skill" ? `${entry.host}:${entry.dir}` : entry.path;
}
