import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  type Stats,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Git-ignored files, which `git reset --hard` and `git clean -fd` both leave alone. A rejected move
 * that writes a cache, an env file or a build output would otherwise stay in the tree and colour
 * every later measurement. So before each move the climb copies every ignored file aside, and the
 * revert puts that state back exactly: files the move created are removed, files it changed or
 * deleted are restored. Nothing that existed before the move is ever deleted.
 *
 * Files are compared like git's index compares them: by size, mode, inode and change times. The
 * change time (ctime) cannot be set back by a program, so any write is seen.
 */

type Entry =
  | { kind: "file"; backup: string; stat: Fingerprint }
  | { kind: "symlink"; target: string }
  /** A nested repository git does not descend into: only its presence is checked. */
  | { kind: "opaque" };

interface Fingerprint {
  size: number;
  mode: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface IgnoredSnapshot {
  entries: Map<string, Entry>;
  backupDir: string;
}

/** Lists ignored paths relative to `cwd`, one per entry (git ls-files -z output). */
export type ListIgnored = () => Promise<string[]>;

/** True when `path` is one of the skipped paths or under one of them. */
export function skippedBy(skip: readonly string[]): (path: string) => boolean {
  const prefixes = skip.map((s) => s.replace(/\/+$/, ""));
  return (path) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

export async function snapshotIgnored(
  cwd: string,
  list: ListIgnored,
  skip: (path: string) => boolean,
): Promise<IgnoredSnapshot> {
  const backupDir = mkdtempSync(join(tmpdir(), "mitchstack-climb-ignored-"));
  const entries = new Map<string, Entry>();
  let n = 0;
  for (const raw of await list()) {
    const rel = raw.replace(/\/+$/, "");
    if (skip(rel)) continue;
    const path = resolve(cwd, rel);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      entries.set(rel, { kind: "symlink", target: readlinkSync(path) });
    } else if (stat.isFile()) {
      const backup = join(backupDir, String(n++));
      copyFileSync(path, backup, constants.COPYFILE_FICLONE);
      entries.set(rel, { kind: "file", backup, stat: fingerprint(lstatSync(path)) });
    } else {
      entries.set(rel, { kind: "opaque" });
    }
  }
  return { entries, backupDir };
}

/**
 * Put the ignored files back as they were at the snapshot. Throws when a file cannot be put back;
 * the climb then stops as broken.
 */
export async function restoreIgnored(
  cwd: string,
  snapshot: IgnoredSnapshot,
  list: ListIgnored,
  skip: (path: string) => boolean,
): Promise<void> {
  for (const raw of await list()) {
    const rel = raw.replace(/\/+$/, "");
    if (skip(rel) || snapshot.entries.has(rel)) continue;
    rmSync(resolve(cwd, rel), { recursive: true, force: true });
  }
  for (const [rel, entry] of snapshot.entries) {
    if (same(cwd, rel, entry)) continue;
    const path = resolve(cwd, rel);
    if (entry.kind === "opaque") {
      throw new Error(`${rel} (a nested repository) changed and cannot be restored`);
    }
    rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    if (entry.kind === "symlink") {
      symlinkSync(entry.target, path);
    } else {
      copyFileSync(entry.backup, path);
      chmodSync(path, entry.stat.mode & 0o7777);
      // The restored copy is the snapshot's content: its new times become the reference.
      entry.stat = fingerprint(lstatSync(path));
    }
  }
}

/** The differences between the ignored files now and the snapshot; empty when they match. */
export async function ignoredDrift(
  cwd: string,
  snapshot: IgnoredSnapshot,
  list: ListIgnored,
  skip: (path: string) => boolean,
): Promise<string[]> {
  const drift: string[] = [];
  const now = new Set<string>();
  for (const raw of await list()) {
    const rel = raw.replace(/\/+$/, "");
    if (skip(rel)) continue;
    now.add(rel);
    if (!snapshot.entries.has(rel)) drift.push(`${rel} (created)`);
  }
  for (const [rel, entry] of snapshot.entries) {
    if (!now.has(rel) || !same(cwd, rel, entry)) drift.push(`${rel} (changed)`);
  }
  return drift;
}

export function disposeSnapshot(snapshot: IgnoredSnapshot | undefined): void {
  if (snapshot) rmSync(snapshot.backupDir, { recursive: true, force: true });
}

function same(cwd: string, rel: string, entry: Entry): boolean {
  const path = resolve(cwd, rel);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (entry.kind === "opaque") return !stat.isFile() && !stat.isSymbolicLink();
  if (entry.kind === "symlink") return stat.isSymbolicLink() && readlinkSync(path) === entry.target;
  if (!stat.isFile()) return false;
  const now = fingerprint(stat);
  return (
    now.size === entry.stat.size &&
    now.mode === entry.stat.mode &&
    now.ino === entry.stat.ino &&
    now.mtimeMs === entry.stat.mtimeMs &&
    now.ctimeMs === entry.stat.ctimeMs
  );
}

function fingerprint(stat: Stats): Fingerprint {
  return {
    size: stat.size,
    mode: stat.mode,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}
