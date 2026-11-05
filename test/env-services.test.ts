import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planDatabase } from "../src/env/database.js";
import { detectDeps } from "../src/env/deps.js";
import { rewriteEnv, syncEnvFiles } from "../src/env/files.js";
import type { Exec } from "../src/env/git.js";
import { checkPortOwnership } from "../src/env/ownership.js";

function dirs() {
  const base = mkdtempSync(join(tmpdir(), "ms-envsvc-"));
  const main = join(base, "main");
  const wt = join(base, "wt");
  mkdirSync(main);
  mkdirSync(wt);
  return { main, wt };
}

describe("env files", () => {
  it("rewrites port keys in place and appends missing ones", () => {
    const { text, rewritten } = rewriteEnv("SECRET=abc\nexport PORT=3000\nAPI_URL=x\n", {
      PORT: "4101",
      API_URL: "http://127.0.0.1:4102",
      NEW_PORT: "4103",
    });
    expect(text).toBe(
      "SECRET=abc\nexport PORT=4101\nAPI_URL=http://127.0.0.1:4102\nNEW_PORT=4103\n",
    );
    expect(rewritten).toEqual(["PORT", "API_URL", "NEW_PORT"]);
  });

  it("copies an absent file from the main checkout, keeps an existing one, reports no values", () => {
    const { main, wt } = dirs();
    writeFileSync(join(main, ".env.local"), "TOKEN=s3cr3t-value\nPORT=3000\n");
    writeFileSync(join(main, ".env.test"), "PORT=3000\n");
    writeFileSync(join(wt, ".env.test"), "PORT=9999\n");
    const result = syncEnvFiles({
      mainRoot: main,
      worktree: wt,
      ports: { web: 4101 },
      files: [
        { path: ".env.local", set: { PORT: "web" } },
        { path: ".env.test", set: { PORT: "web" } },
        { path: ".env.missing", set: {} },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual([
      { path: ".env.local", status: "copied", rewritten: ["PORT"] },
      { path: ".env.test", status: "kept", rewritten: [] },
      { path: ".env.missing", status: "missing-in-main", rewritten: [] },
    ]);
    expect(readFileSync(join(wt, ".env.local"), "utf8")).toBe("TOKEN=s3cr3t-value\nPORT=4101\n");
    expect(readFileSync(join(wt, ".env.test"), "utf8")).toBe("PORT=9999\n");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  it("refuses a path that escapes the checkout", () => {
    const { main, wt } = dirs();
    const result = syncEnvFiles({
      mainRoot: main,
      worktree: wt,
      ports: {},
      files: [{ path: "../outside.env", set: {} }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("dependencies", () => {
  it("detects the package manager from the lockfile and reports the command", () => {
    const { wt } = dirs();
    expect(detectDeps(wt)).toEqual({ manager: null });
    writeFileSync(join(wt, "pnpm-lock.yaml"), "");
    expect(detectDeps(wt)).toMatchObject({
      manager: "pnpm",
      command: ["pnpm", "install", "--frozen-lockfile"],
      installed: false,
    });
    writeFileSync(join(wt, "package-lock.json"), "{}");
    mkdirSync(join(wt, "node_modules"));
    expect(detectDeps(wt)).toMatchObject({
      manager: "npm",
      command: ["npm", "ci"],
      installed: true,
    });
  });
});

describe("database hook", () => {
  const spec = {
    name: "{{repo}}_{{worktree}}",
    create: "createdb {{name}}",
    drop: "dropdb {{name}}",
  };

  it("derives an isolated name from the worktree and renders the commands", () => {
    const plan = planDatabase({ spec, worktree: "/x/wt-A.1", mainRoot: "/x/my-app", gates: [] });
    expect(plan).toMatchObject({
      ok: true,
    });
    if (!plan.ok) return;
    expect(plan.name).toMatch(/^my_app_wt_a_1_[0-9a-f]{8}$/);
    expect(plan.create).toBe(`createdb ${plan.name}`);
    expect(plan.drop).toBe(`dropdb ${plan.name}`);
  });

  it("gives two worktrees with the same directory name different databases (F11)", () => {
    const [one, two] = ["/jobs/one/task", "/jobs/two/task"].map((worktree) =>
      planDatabase({ spec, worktree, mainRoot: "/repo/demo", gates: [] }),
    );
    expect(one?.ok && two?.ok).toBe(true);
    if (!one?.ok || !two?.ok) return;
    expect(one.name).toMatch(/^demo_task_[0-9a-f]{8}$/);
    expect(one.name).not.toBe(two.name);
    expect(one.drop).not.toBe(two.drop);
    // Stable: the same worktree path always gets the same name.
    const again = planDatabase({
      spec,
      worktree: "/jobs/one/task",
      mainRoot: "/repo/demo",
      gates: [],
    });
    expect(again.ok && again.name).toBe(one.name);
  });

  it("keeps the database name within Postgres's 63-byte identifier limit", () => {
    const long = `/x/${"w".repeat(120)}`;
    const plan = planDatabase({
      spec,
      worktree: long,
      mainRoot: `/x/${"r".repeat(80)}`,
      gates: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(Buffer.byteLength(plan.name)).toBeLessThanOrEqual(63);
    expect(plan.name).toMatch(/_[0-9a-f]{8}$/);
  });

  it("refuses to touch the main checkout's database", () => {
    const plan = planDatabase({ spec, worktree: "/x/my-app", mainRoot: "/x/my-app", gates: [] });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/main checkout/);
  });

  it("refuses a name that is not per-worktree, and a create step that wipes or migrates", () => {
    const shared = planDatabase({
      spec: { name: "app", create: "createdb {{name}}" },
      worktree: "/x/wt",
      mainRoot: "/x/app",
      gates: [],
    });
    expect(shared.ok).toBe(false);
    const wipe = planDatabase({
      spec: { name: "{{worktree}}", create: "dropdb app && createdb {{name}}" },
      worktree: "/x/wt",
      mainRoot: "/x/app",
      gates: [],
    });
    expect(wipe.ok).toBe(false);
    if (!wipe.ok) expect(wipe.reason).toMatch(/wipe or migrate/);
  });

  it("surfaces database ownership gates", () => {
    const gate = { resource: "shared local database", owner: "Sam", rule: "never wipe it" };
    const port = { resource: "port 3200", owner: "Sam", rule: "ask first" };
    const plan = planDatabase({ spec, worktree: "/x/wt", mainRoot: "/x/app", gates: [gate, port] });
    expect(plan.ok && plan.gates).toEqual([gate]);
  });
});

describe("port ownership", () => {
  const worktree = "/repo/wt-a";
  const worktrees = ["/repo/main", "/repo/wt-a", "/repo/main/.claude/worktrees/nested"];

  function fakeLsof(pids: Record<string, string>, opts: { missing?: boolean } = {}): Exec {
    return (cmd, args) => {
      if (opts.missing) return { code: -1, stdout: "", stderr: "", error: "spawn lsof ENOENT" };
      expect(cmd).toBe("lsof");
      if (args.includes("-iTCP:4101")) {
        const ids = Object.keys(pids);
        return { code: ids.length ? 0 : 1, stdout: ids.map((p) => `p${p}\n`).join(""), stderr: "" };
      }
      const pid = args[args.indexOf("-p") + 1] as string;
      return { code: 0, stdout: `p${pid}\nfcwd\nn${pids[pid]}\n`, stderr: "" };
    };
  }

  it("accepts a listener whose cwd is inside this worktree", () => {
    const r = checkPortOwnership({
      port: 4101,
      worktree,
      worktrees,
      exec: fakeLsof({ "42": "/repo/wt-a/apps/web" }),
    });
    expect(r).toEqual({ ok: true, port: 4101, pid: 42, cwd: "/repo/wt-a/apps/web" });
  });

  it("rejects a foreign listener and names its pid and cwd", () => {
    const r = checkPortOwnership({
      port: 4101,
      worktree,
      worktrees,
      exec: fakeLsof({ "77": "/repo/wt-b" }),
    });
    expect(r).toMatchObject({ ok: false, reason: "foreign", pid: 77, cwd: "/repo/wt-b" });
    if (!r.ok) expect(r.message).toMatch(/77.*\/repo\/wt-b/);
  });

  it("rejects a listener from a worktree nested inside this checkout", () => {
    const r = checkPortOwnership({
      port: 4101,
      worktree: "/repo/main",
      worktrees,
      exec: fakeLsof({ "9": "/repo/main/.claude/worktrees/nested/src" }),
    });
    expect(r).toMatchObject({ ok: false, reason: "foreign", pid: 9 });
  });

  it("rejects when any one of several listeners is foreign", () => {
    const r = checkPortOwnership({
      port: 4101,
      worktree,
      worktrees,
      exec: fakeLsof({ "1": "/repo/wt-a", "2": "/elsewhere" }),
    });
    expect(r).toMatchObject({ ok: false, reason: "foreign", pid: 2, cwd: "/elsewhere" });
  });

  it("reports a free port and a missing lsof distinctly", () => {
    expect(
      checkPortOwnership({ port: 4101, worktree, worktrees, exec: fakeLsof({}) }),
    ).toMatchObject({ ok: false, reason: "free" });
    expect(
      checkPortOwnership({
        port: 4101,
        worktree,
        worktrees,
        exec: fakeLsof({}, { missing: true }),
      }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
