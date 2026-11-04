import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface PortRange {
  from: number;
  to: number;
}

export interface Lease {
  worktree: string;
  ports: Record<string, number>;
  leasedAt: string;
}

interface Registry {
  version: 1;
  leases: Lease[];
}

export type AllocateResult =
  | { ok: true; ports: Record<string, number>; reused: boolean; registryPath: string }
  | { ok: false; reason: string };

export interface AllocateInput {
  worktree: string;
  registryPath: string;
  range: PortRange;
  /** One port per name, handed out as a contiguous block. */
  names: string[];
  /** Ports nobody may lease (e.g. ones named in ownership gates). */
  reserved?: number[];
  now?: () => Date;
}

/** Hash of the worktree path picks the starting block, so a worktree tends to get the same ports. */
export function preferredBlock(worktree: string, blockCount: number): number {
  const digest = createHash("sha256").update(worktree).digest();
  return digest.readUInt32BE(0) % blockCount;
}

export function allocatePorts(input: AllocateInput): AllocateResult {
  const { worktree, registryPath, range, names } = input;
  const size = names.length;
  const blockCount = Math.floor((range.to - range.from + 1) / size);
  if (blockCount < 1) return { ok: false, reason: `range ${range.from}-${range.to} is too small` };
  return withRegistry(registryPath, (registry) => {
    // A lease whose worktree directory is gone is stale; reclaim it.
    registry.leases = registry.leases.filter((l) => existsSync(l.worktree));
    const mine = registry.leases.find((l) => l.worktree === worktree);
    if (mine && sameNames(mine.ports, names)) {
      return { ok: true, ports: mine.ports, reused: true, registryPath };
    }
    const taken = new Set(input.reserved ?? []);
    for (const lease of registry.leases) {
      if (lease.worktree !== worktree) for (const p of Object.values(lease.ports)) taken.add(p);
    }
    const start = preferredBlock(worktree, blockCount);
    for (let i = 0; i < blockCount; i++) {
      const base = range.from + ((start + i) % blockCount) * size;
      const block = names.map((_, j) => base + j);
      if (block.some((p) => taken.has(p))) continue;
      const ports = Object.fromEntries(names.map((name, j) => [name, block[j] as number]));
      registry.leases = registry.leases.filter((l) => l.worktree !== worktree);
      registry.leases.push({
        worktree,
        ports,
        leasedAt: (input.now ?? (() => new Date()))().toISOString(),
      });
      return { ok: true, ports, reused: false, registryPath };
    }
    return {
      ok: false,
      reason: `no free block of ${size} port(s) left in ${range.from}-${range.to}; run 'mitchstack env down' in a finished worktree`,
    };
  });
}

export function findLease(input: { worktree: string; registryPath: string }): Lease | undefined {
  return readRegistry(input.registryPath).leases.find((l) => l.worktree === input.worktree);
}

export function releasePorts(input: { worktree: string; registryPath: string }): {
  released: Record<string, number> | null;
} {
  if (!existsSync(input.registryPath)) return { released: null };
  return withRegistry(input.registryPath, (registry) => {
    const lease = registry.leases.find((l) => l.worktree === input.worktree);
    registry.leases = registry.leases.filter((l) => l.worktree !== input.worktree);
    return { released: lease?.ports ?? null };
  });
}

function sameNames(ports: Record<string, number>, names: string[]): boolean {
  const have = Object.keys(ports);
  return have.length === names.length && names.every((n, i) => have[i] === n);
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) return { version: 1, leases: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Registry;
  return { version: 1, leases: Array.isArray(parsed.leases) ? parsed.leases : [] };
}

/** Read-modify-write under an exclusive lock file, so two `env up` runs cannot race. */
function withRegistry<T>(path: string, change: (registry: Registry) => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  acquire(lock);
  try {
    const registry = readRegistry(path);
    const result = change(registry);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
    renameSync(tmp, path);
    return result;
  } finally {
    rmSync(lock, { force: true });
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function acquire(lock: string): void {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A lock older than 30s belongs to a run that died; take it over.
      const held = statSync(lock, { throwIfNoEntry: false });
      if (!held) continue;
      if (Date.now() - held.mtimeMs > 30_000) {
        rmSync(lock, { force: true });
        continue;
      }
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  throw new Error(`timed out waiting for the port registry lock at ${lock}`);
}
