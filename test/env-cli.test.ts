import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEnvCli } from "../src/env/cli.js";
import type { Exec } from "../src/env/git.js";
import { realExec } from "../src/env/git.js";
import { runIo, scratchRepo } from "./env-helpers.js";

const config = `version: 1
owner: Sam
profile: solo
checks:
  - name: test
    run: npm test
ownershipGates:
  - resource: shared local database
    owner: Sam
    rule: never wipe or migrate it
env:
  ports:
    from: 4100
    to: 4199
    names: [web, api]
  files:
    - path: .env.local
      set:
        PORT: web
        API_URL: "http://127.0.0.1:{{api}}"
  database:
    name: "{{repo}}_{{worktree}}"
    create: "createdb {{name}}"
`;

async function env(cwd: string, args: string[], exec?: Exec) {
  const { io, out, err } = runIo(cwd);
  const code = await runEnvCli(args, io, exec ? { exec } : undefined);
  return { code, out, err };
}

function upJson(cwd: string) {
  return env(cwd, ["up", "--json"]).then((r) => ({ ...r, json: JSON.parse(r.out.join("\n")) }));
}

describe("mitchstack env (real git worktrees)", () => {
  it("gives two worktrees distinct ports and records both in the shared registry", async () => {
    const { main, a, b } = scratchRepo({
      "mitchstack.yaml": config,
      ".env.local": "TOKEN=hunter2\nPORT=3000\n",
    });
    const upA = await upJson(a);
    const upB = await upJson(b);
    expect(upA.code).toBe(0);
    expect(upB.code).toBe(0);
    const portsA = Object.values(upA.json.ports) as number[];
    const portsB = Object.values(upB.json.ports) as number[];
    expect(portsA).toHaveLength(2);
    expect(portsA.filter((p) => portsB.includes(p))).toEqual([]);
    const registry = JSON.parse(
      readFileSync(join(main, ".git", "mitchstack", "ports.json"), "utf8"),
    );
    expect(registry.leases).toHaveLength(2);

    // env files: copied with ports rewritten, secret untouched and never printed.
    expect(readFileSync(join(a, ".env.local"), "utf8")).toBe(
      `TOKEN=hunter2\nPORT=${upA.json.ports.web}\nAPI_URL=http://127.0.0.1:${upA.json.ports.api}\n`,
    );
    expect(upA.out.join("\n")).not.toContain("hunter2");
    const human = await env(b, ["status"]);
    expect(human.out.join("\n")).not.toContain("hunter2");

    // Database: planned, not run without --db; ownership gate surfaced.
    expect(upA.json.database).toMatchObject({ ran: false });
    expect(upA.json.database.name).toMatch(/^app_wt_a_[0-9a-f]{8}$/);
    expect(upA.json.database.create).toBe(`createdb ${upA.json.database.name}`);
    expect(upA.json.database.gates[0].resource).toBe("shared local database");
  });

  it("is idempotent, and down releases the lease", async () => {
    const { main, a } = scratchRepo({ "mitchstack.yaml": config });
    const first = await upJson(a);
    const second = await upJson(a);
    expect(second.json.ports).toEqual(first.json.ports);
    const down = await env(a, ["down"]);
    expect(down.code).toBe(0);
    expect(down.out.join("\n")).toMatch(/released/);
    const registry = JSON.parse(
      readFileSync(join(main, ".git", "mitchstack", "ports.json"), "utf8"),
    );
    expect(registry.leases).toEqual([]);
    const status = await env(a, ["status"]);
    expect(status.out.join("\n")).toMatch(/no ports leased/);
  });

  it("reports the install command and runs it only with --install", async () => {
    const { a } = scratchRepo({ "mitchstack.yaml": config, "package-lock.json": "{}" });
    const calls: string[] = [];
    const spy: Exec = (cmd, args, opts) => {
      if (cmd === "npm") {
        calls.push(`${cmd} ${args.join(" ")} @ ${opts.cwd}`);
        return { code: 0, stdout: "", stderr: "" };
      }
      return realExec(cmd, args, opts);
    };
    const dry = await env(a, ["up"], spy);
    expect(dry.out.join("\n")).toMatch(/npm ci/);
    expect(calls).toEqual([]);
    const wet = await env(a, ["up", "--install"], spy);
    expect(wet.code).toBe(0);
    expect(calls).toEqual([`npm ci @ ${a}`]);
  });

  it("runs the database hook only with --db and never from the main checkout", async () => {
    const { main, a } = scratchRepo({ "mitchstack.yaml": config });
    const shell: string[] = [];
    const spy: Exec = (cmd, args, opts) => {
      if (cmd === "sh") {
        shell.push(args.join(" "));
        return { code: 0, stdout: "", stderr: "" };
      }
      return realExec(cmd, args, opts);
    };
    expect((await env(a, ["up", "--db"], spy)).code).toBe(0);
    expect(shell).toHaveLength(1);
    expect(shell[0]).toMatch(/^-c createdb app_wt_a_[0-9a-f]{8}$/);
    const fromMain = await env(main, ["up", "--db"], spy);
    expect(fromMain.code).toBe(1);
    expect(fromMain.err.join("\n")).toMatch(/main checkout/);
    expect(shell).toHaveLength(1);
  });

  it("check-port rejects a foreign listener and accepts one from this worktree", async () => {
    const { a, b } = scratchRepo();
    const lsof: Exec = (cmd, args, opts) => {
      if (cmd !== "lsof") return realExec(cmd, args, opts);
      if (args.some((x) => x.startsWith("-iTCP:")))
        return { code: 0, stdout: "p321\n", stderr: "" };
      return { code: 0, stdout: `p321\nfcwd\nn${a}\n`, stderr: "" };
    };
    const fromB = await env(b, ["check-port", "4100"], lsof);
    expect(fromB.code).toBe(1);
    expect(fromB.err.join("\n")).toMatch(new RegExp(`pid 321.*${a}`));
    const fromA = await env(a, ["check-port", "4100"], lsof);
    expect(fromA.code).toBe(0);
  });

  it("works without a mitchstack.yaml using defaults, and rejects bad usage", async () => {
    const { a } = scratchRepo();
    const up = await upJson(a);
    expect(up.code).toBe(0);
    expect(Object.keys(up.json.ports)).toEqual(["web"]);
    expect((await env(a, ["check-port", "nope"])).code).toBe(2);
    expect((await env(a, ["sideways"])).code).toBe(2);
  });

  it("refuses an invalid mitchstack.yaml", async () => {
    const { a } = scratchRepo();
    writeFileSync(join(a, "mitchstack.yaml"), config.replace("from: 4100", "from: 80"));
    const up = await env(a, ["up"]);
    expect(up.code).toBe(1);
    expect(up.err.join("\n")).toMatch(/env\.ports\.from/);
    expect(existsSync(join(a, ".env.local"))).toBe(false);
  });
  it("check-base refuses a worktree made from the wrong branch, and passes once it contains it", async () => {
    const { main, a } = scratchRepo();
    const g = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd,
        encoding: "utf8",
      }).trim();
    g(main, "checkout", "-q", "-b", "spec/v1");
    g(main, "commit", "-q", "--allow-empty", "-m", "integration work");
    const tip = g(main, "rev-parse", "HEAD");
    g(main, "checkout", "-q", "main");

    const wrong = await env(a, ["check-base", "spec/v1"]);
    expect(wrong.code).toBe(1);
    expect(wrong.err.join("\n")).toContain(tip.slice(0, 7));
    expect(wrong.err.join("\n")).toMatch(/does not contain spec\/v1/);

    g(a, "reset", "-q", "--hard", "spec/v1");
    const right = await env(a, ["check-base", "spec/v1"]);
    expect(right.code).toBe(0);
    expect(right.out.join("\n")).toMatch(/contains spec\/v1/);

    expect((await env(a, ["check-base", "no-such-branch"])).code).toBe(2);
    expect((await env(a, ["check-base"])).code).toBe(2);
  });
  it("check-base also requires origin's copy of the branch, so a stale local branch can't pass", async () => {
    const { main, a } = scratchRepo();
    const g = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd,
        encoding: "utf8",
      }).trim();
    g(main, "branch", "spec/v1");
    g(main, "checkout", "-q", "-b", "ahead");
    g(main, "commit", "-q", "--allow-empty", "-m", "integration work pushed by another agent");
    const ahead = g(main, "rev-parse", "HEAD");
    g(main, "checkout", "-q", "main");
    g(main, "update-ref", "refs/remotes/origin/spec/v1", ahead);

    const stale = await env(a, ["check-base", "spec/v1"]);
    expect(stale.code).toBe(1);
    expect(stale.err.join("\n")).toMatch(/does not contain origin\/spec\/v1/);
    g(a, "reset", "-q", "--hard", ahead);
    expect((await env(a, ["check-base", "spec/v1"])).code).toBe(0);
    expect((await env(a, ["check-base", "origin/spec/v1"])).code).toBe(0);
  });
});
