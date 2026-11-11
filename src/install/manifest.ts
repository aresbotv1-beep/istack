import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HOSTS } from "./hosts.js";

const host = z.enum(HOSTS);
const owner = z.enum([...HOSTS, "git"]);
const digest = z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest");
/** Relative to the install root, forward slashes. Where a path may point is checked in locations.ts. */
const path = z.string().min(1);

const skillEntry = z.strictObject({
  kind: z.literal("skill"),
  host,
  dir: path,
  /** File (relative to dir) → sha256 of what the install wrote. */
  files: z.record(path, digest),
});

const blockEntry = z.strictObject({
  kind: z.literal("block"),
  hosts: z.array(host).min(1),
  path,
  /** What the install put before the block, so uninstall restores the file byte for byte. */
  prefix: z.string(),
  createdFile: z.boolean(),
});

const hookEntry = z.strictObject({ kind: z.literal("hook"), path, sha: digest });

const dirEntry = z.strictObject({ kind: z.literal("dir"), owners: z.array(owner).min(1), path });

const manifestSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(z.discriminatedUnion("kind", [skillEntry, blockEntry, hookEntry, dirEntry])),
});

/** Who owns a directory or file: a host, or "git" for the pre-push hook. */
export type Owner = z.infer<typeof owner>;
export type SkillEntry = z.infer<typeof skillEntry>;
export type BlockEntry = z.infer<typeof blockEntry>;
export type HookEntry = z.infer<typeof hookEntry>;
export type DirEntry = z.infer<typeof dirEntry>;
export type Entry = SkillEntry | BlockEntry | HookEntry | DirEntry;

/** No timestamps: re-installing the same kit must leave this file byte-identical. */
export interface Manifest {
  version: 1;
  entries: Entry[];
}

export const MANIFEST_PATH = join(".istack", "install.json");

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Parse the install record. Throws on anything that is not exactly the shape this installer writes. */
export function readManifest(root: string): Manifest {
  const file = join(root, MANIFEST_PATH);
  if (!existsSync(file)) return { version: 1, entries: [] };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}) — nothing changed`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`${file} is not a istack install manifest (${problems}) — nothing changed`);
  }
  return parsed.data;
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
