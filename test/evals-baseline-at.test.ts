import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRequest, AgentRunner } from "../src/evals/agents.js";
import { runEvalsCli } from "../src/evals/cli.js";
import { baselineSchema } from "../src/evals/schema.js";
import { loadSkill } from "../src/evals/skill.js";

const ROOT = new URL("..", import.meta.url).pathname;

/** A repo with the retro skill and its scenarios committed, then the skill edited on top. */
function editedRepo(): { cwd: string; committedHash: string } {
  const cwd = mkdtempSync(join(tmpdir(), "ms-evals-at-"));
  cpSync(join(ROOT, "skills", "retro"), join(cwd, "skills", "retro"), { recursive: true });
  for (const f of ["01-offer-not-run.yaml", "02-run-retro.yaml", "03-before-merge.yaml"])
    cpSync(join(ROOT, "evals", "retro", f), join(cwd, "evals", "retro", f));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base");
  const committedHash = loadSkill(cwd, "retro").hash;
  appendFileSync(join(cwd, "skills", "retro", "SKILL.md"), "\nAN EDIT MADE BY THIS CHANGE.\n");
  return { cwd, committedHash };
}

function recording(seen: string[]): AgentRunner {
  return {
    id: "scripted",
    provider: "test",
    costUsdPerCall: 0,
    run: async (request: AgentRequest) => {
      seen.push(request.system);
      return { kind: "text", text: "nothing", costUsd: 0 };
    },
  };
}

describe("evals baseline --at <ref> (retro 2026-11-13 R2)", () => {
  it("scores the skill as it was at the commit, not the edited working tree", async () => {
    const { cwd, committedHash } = editedRepo();
    const seen: string[] = [];
    const out: string[] = [];
    const code = await runEvalsCli(
      ["baseline", "--skill", "retro", "--at", "HEAD", "--runs", "3"],
      { cwd, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
      { runner: () => recording(seen), now: () => "2026-11-13T00:00:00.000Z" },
    );
    expect(code, out.join("\n")).toBe(0);
    const baseline = baselineSchema.parse(
      JSON.parse(readFileSync(join(cwd, "evals", "baselines", "retro.json"), "utf8")),
    );
    expect(baseline.skillHash).toBe(committedHash);
    expect(baseline.skillHash).not.toBe(loadSkill(cwd, "retro").hash);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.includes("AN EDIT MADE BY THIS CHANGE"))).toBe(false);
  });

  it("refuses an unknown ref, and --at outside baseline", async () => {
    const { cwd } = editedRepo();
    const err: string[] = [];
    const io = { cwd, out: () => {}, err: (l: string) => err.push(l) };
    const deps = { runner: () => recording([]) };
    expect(
      await runEvalsCli(["baseline", "--skill", "retro", "--at", "no-such-ref"], io, deps),
    ).toBe(2);
    expect(err).toContain("not a commit: no-such-ref");
    expect(await runEvalsCli(["run", "--skill", "retro", "--at", "HEAD"], io, deps)).toBe(2);
    expect(err).toContain("--at only goes with baseline");
  });
});
