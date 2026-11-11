import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocatePorts, findLease, releasePorts } from "../src/env/ports.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ms-ports-"));
  const wt = (name: string) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { registryPath: join(dir, "common", "istack", "ports.json"), wt };
}

const range = { from: 4100, to: 4999 };

describe("port allocation", () => {
  it("is deterministic for a worktree and stable across calls", () => {
    const { registryPath, wt } = setup();
    const a = wt("a");
    const first = allocatePorts({ worktree: a, registryPath, range, names: ["web", "api"] });
    const again = allocatePorts({ worktree: a, registryPath, range, names: ["web", "api"] });
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.ports).toEqual(first.ports);
    expect(again.reused).toBe(true);
    expect(first.ports.web).toBeGreaterThanOrEqual(4100);
    expect(first.ports.api).toBe((first.ports.web as number) + 1);
  });

  it("keeps leases made under the old mitchstack registry path (PR #9 review)", () => {
    const { registryPath, wt } = setup();
    const oldPath = join(registryPath, "..", "..", "mitchstack", "ports.json");
    const one = { from: 4200, to: 4200 };
    const a = allocatePorts({
      worktree: wt("a"),
      registryPath: oldPath,
      range: one,
      names: ["web"],
    });
    expect(a.ok).toBe(true);
    const b = allocatePorts({ worktree: wt("b"), registryPath, range: one, names: ["web"] });
    expect(b.ok).toBe(false);
    expect(findLease({ worktree: wt("a"), registryPath })?.ports).toEqual({ web: 4200 });
  });

  it("never hands two worktrees the same port, even when their hashes collide", () => {
    const { registryPath, wt } = setup();
    // A range with exactly two one-port blocks forces the second worktree to probe.
    const tiny = { from: 5000, to: 5001 };
    const a = allocatePorts({ worktree: wt("a"), registryPath, range: tiny, names: ["web"] });
    const b = allocatePorts({ worktree: wt("b"), registryPath, range: tiny, names: ["web"] });
    const c = allocatePorts({ worktree: wt("c"), registryPath, range: tiny, names: ["web"] });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.ports.web).not.toBe(b.ports.web);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/no free block/);
  });

  it("skips ports named in ownership gates", () => {
    const { registryPath, wt } = setup();
    const r = allocatePorts({
      worktree: wt("a"),
      registryPath,
      range: { from: 5000, to: 5001 },
      names: ["web"],
      reserved: [5000, 5001],
    });
    expect(r.ok).toBe(false);
  });

  it("releases a lease on down, and reclaims leases whose worktree is gone", () => {
    const { registryPath, wt } = setup();
    const tiny = { from: 5000, to: 5000 };
    const a = wt("a");
    expect(allocatePorts({ worktree: a, registryPath, range: tiny, names: ["web"] }).ok).toBe(true);
    const released = releasePorts({ worktree: a, registryPath });
    expect(released.released).toEqual({ web: 5000 });
    expect(findLease({ worktree: a, registryPath })).toBeUndefined();

    const ghost = join(registryPath, "..", "..", "..", "ghost");
    mkdirSync(ghost);
    allocatePorts({ worktree: ghost, registryPath, range: tiny, names: ["web"] });
    // Removing the directory makes the lease stale; another worktree may take the port.
    rmSync(ghost, { recursive: true });
    const b = allocatePorts({ worktree: wt("b"), registryPath, range: tiny, names: ["web"] });
    expect(b.ok).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.leases.map((l: { worktree: string }) => l.worktree)).toEqual([
      join(registryPath, "..", "..", "..", "b"),
    ]);
  });

  it("re-checks a reused lease: a port reserved since, or outside the range now, is reallocated (F10)", () => {
    const { registryPath, wt } = setup();
    const a = wt("a");
    const two = { from: 4100, to: 4101 };
    const first = allocatePorts({ worktree: a, registryPath, range: two, names: ["web"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const taken = first.ports.web as number;
    const second = allocatePorts({
      worktree: a,
      registryPath,
      range: two,
      names: ["web"],
      reserved: [taken],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.ports.web).not.toBe(taken);
    expect(second.reused).toBe(false);
    expect(second.replaced).toMatch(new RegExp(`${taken}.*reserved`));
    expect(findLease({ worktree: a, registryPath })?.ports.web).toBe(second.ports.web);

    // The configured range moved: the old lease is outside it now.
    const moved = allocatePorts({
      worktree: a,
      registryPath,
      range: { from: 4200, to: 4200 },
      names: ["web"],
    });
    expect(moved.ok && moved.ports.web).toBe(4200);
    if (moved.ok) expect(moved.replaced).toMatch(/outside 4200-4200/);
  });
});
