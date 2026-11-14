import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitRepo, install, put, snapshot, tempDir } from "./install-helpers.js";

const KIT = new URL("..", import.meta.url).pathname;
const SKILLS = readdirSync(join(KIT, "skills")).sort();
const BEGIN = "<!-- istack:begin -->";
const END = "<!-- istack:end -->";

const theirSkill = "---\nname: groundbreak\ndescription: my own brainstorm skill\n---\n\nMine.\n";

describe("install never destroys an existing setup", () => {
  it("leaves a personal skill with the same name byte-identical and reports the skip", async () => {
    const home = tempDir();
    put(home, ".claude/skills/groundbreak/SKILL.md", theirSkill);
    put(home, ".claude/skills/groundbreak/notes.md", "my notes\n");
    const before = snapshot(join(home, ".claude/skills/groundbreak"));

    const run = await install(home, ["install", "--host", "claude", "--home", home]);

    expect(snapshot(join(home, ".claude/skills/groundbreak"))).toEqual(before);
    expect(readFileSync(join(home, ".claude/skills/groundbreak/SKILL.md"), "utf8")).toBe(
      theirSkill,
    );
    expect(run.code).toBe(1);
    expect(run.out + run.err).toMatch(/skip.*groundbreak/i);
    // Every other skill still went in.
    for (const name of SKILLS.filter((s) => s !== "groundbreak")) {
      expect(existsSync(join(home, ".claude/skills", name, "SKILL.md"))).toBe(true);
    }
    // And uninstall leaves their skill alone too.
    await install(home, ["uninstall", "--host", "claude", "--home", home]);
    expect(snapshot(join(home, ".claude/skills/groundbreak"))).toEqual(before);
  });

  it("re-install produces an empty diff", async () => {
    for (const host of ["claude", "codex", "cursor", "all"]) {
      const home = tempDir();
      put(home, ".codex/AGENTS.md", "# my rules\n\nBe kind.\n");
      const first = await install(home, ["install", "--host", host, "--home", home]);
      expect(first.code, `${host}: ${first.err}`).toBe(0);
      const after = snapshot(home);
      const again = await install(home, ["install", "--host", host, "--home", home]);
      expect(again.code).toBe(0);
      expect(snapshot(home), host).toEqual(after);
    }
  });

  it("puts each host's skills where that host discovers them and touches no other host", async () => {
    const where = { claude: ".claude/skills", codex: ".agents/skills", cursor: ".cursor/skills" };
    for (const [host, dir] of Object.entries(where)) {
      const home = tempDir();
      const others = Object.values(where).filter((d) => d !== dir);
      for (const other of others) put(home, `${other}/mine/SKILL.md`, "---\nname: mine\n---\n");
      const othersBefore = others.map((o) => snapshot(join(home, o)));

      const run = await install(home, ["install", "--host", host, "--home", home]);

      expect(run.code, run.err).toBe(0);
      for (const name of SKILLS) {
        const kit = readFileSync(join(KIT, "skills", name, "SKILL.md"));
        expect(readFileSync(join(home, dir, name, "SKILL.md")).equals(kit)).toBe(true);
      }
      // Sibling reference files come along.
      expect(existsSync(join(home, dir, "groundbreak", "board.md"))).toBe(true);
      expect(others.map((o) => snapshot(join(home, o)))).toEqual(othersBefore);
    }
  });

  it("uninstall puts the home back exactly as it was", async () => {
    for (const host of ["claude", "codex", "cursor", "all"]) {
      const home = tempDir();
      put(home, ".codex/AGENTS.md", "# my rules\n\nBe kind.");
      put(home, ".claude/skills/groundbreak/SKILL.md", theirSkill);
      const before = snapshot(home);
      await install(home, ["install", "--host", host, "--home", home]);
      const run = await install(home, ["uninstall", "--host", host, "--home", home]);
      expect(run.code, run.err).toBe(0);
      expect(snapshot(home), host).toEqual(before);
    }
  });

  it("uninstalling one host leaves the others installed", async () => {
    const home = tempDir();
    await install(home, ["install", "--host", "all", "--home", home]);
    const cursorBefore = snapshot(join(home, ".cursor"));
    await install(home, ["uninstall", "--host", "claude", "--home", home]);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(snapshot(join(home, ".cursor"))).toEqual(cursorBefore);
    expect(existsSync(join(home, ".agents/skills/plan/SKILL.md"))).toBe(true);
  });

  it("keeps a file the user edited after install, on re-install and on uninstall", async () => {
    const home = tempDir();
    await install(home, ["install", "--host", "claude", "--home", home]);
    const edited = join(home, ".claude/skills/plan/SKILL.md");
    put(home, ".claude/skills/plan/SKILL.md", "my edits\n");

    const again = await install(home, ["install", "--host", "claude", "--home", home]);
    expect(readFileSync(edited, "utf8")).toBe("my edits\n");
    expect(again.code).toBe(1);
    expect(again.out + again.err).toMatch(/plan/);

    const gone = await install(home, ["uninstall", "--host", "claude", "--home", home]);
    expect(readFileSync(edited, "utf8")).toBe("my edits\n");
    expect(gone.code).toBe(1);
    expect(existsSync(join(home, ".claude/skills/build"))).toBe(false);
  });

  it("--prefix installs every skill as istack-<name>, with the frontmatter name to match", async () => {
    const home = tempDir();
    put(home, ".cursor/skills/groundbreak/SKILL.md", theirSkill);
    const run = await install(home, ["install", "--host", "cursor", "--home", home, "--prefix"]);
    expect(run.code, run.err).toBe(0);
    expect(readFileSync(join(home, ".cursor/skills/groundbreak/SKILL.md"), "utf8")).toBe(
      theirSkill,
    );
    const ours = readFileSync(join(home, ".cursor/skills/istack-groundbreak/SKILL.md"), "utf8");
    expect(ours).toMatch(/^---\nname: istack-groundbreak\n/);
    expect(existsSync(join(home, ".cursor/skills/istack-plan/SKILL.md"))).toBe(true);
  });

  it("--dry-run writes nothing", async () => {
    const home = tempDir();
    put(home, ".codex/AGENTS.md", "mine\n");
    const before = snapshot(home);
    const run = await install(home, ["install", "--host", "all", "--home", home, "--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/dry run/i);
    expect(snapshot(home)).toEqual(before);
  });
});

describe("AGENTS.md marked block", () => {
  it("adds the contract inside markers, never changing text outside them", async () => {
    const home = tempDir();
    const theirs = "# my rules\n\nBe kind.\n";
    put(home, ".codex/AGENTS.md", theirs);
    await install(home, ["install", "--host", "codex", "--home", home]);
    const text = readFileSync(join(home, ".codex/AGENTS.md"), "utf8");
    expect(text.startsWith(theirs)).toBe(true);
    expect(text).toContain(BEGIN);
    expect(text).toContain(END);
    expect(text).toContain("## The two gates");
  });

  it("replaces the block in place on re-install, keeping edits on both sides", async () => {
    const home = tempDir();
    await install(home, ["install", "--host", "codex", "--home", home]);
    const path = join(home, ".codex/AGENTS.md");
    const text = readFileSync(path, "utf8");
    const stale = text.replace("## The two gates", "## stale text");
    put(home, ".codex/AGENTS.md", `top\n${stale}bottom\n`);
    await install(home, ["install", "--host", "codex", "--home", home]);
    const next = readFileSync(path, "utf8");
    expect(next).toBe(`top\n${text}bottom\n`);
  });

  it("stops before writing anything into a project that still has only mitchstack.yaml", async () => {
    const project = gitRepo({ "mitchstack.yaml": "version: 1\n", "AGENTS.md": "# Rules\n" });
    const before = snapshot(project);
    const r = await install(project, ["install", "--host", "codex", "--project", project]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/found mitchstack\.yaml — rename it to istack\.yaml/);
    expect(snapshot(project)).toEqual(before);
  });

  it("writes the block to the project AGENTS.md for codex and cursor, once", async () => {
    const project = gitRepo({ "AGENTS.md": "# Project rules\n" });
    await install(project, ["install", "--host", "all", "--project", project]);
    const text = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(text.startsWith("# Project rules\n")).toBe(true);
    expect(text.split(BEGIN)).toHaveLength(2);
    // Removing one host keeps the block the other still needs.
    await install(project, ["uninstall", "--host", "codex", "--project", project]);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain(BEGIN);
    await install(project, ["uninstall", "--host", "cursor", "--project", project]);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("# Project rules\n");
  });

  it("refuses a file with a broken block instead of guessing", async () => {
    const home = tempDir();
    put(home, ".codex/AGENTS.md", `mine\n${BEGIN}\nhalf a block\n`);
    const run = await install(home, ["install", "--host", "codex", "--home", home]);
    expect(run.code).toBe(1);
    expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toBe(
      `mine\n${BEGIN}\nhalf a block\n`,
    );
  });
});

describe("git pre-push hook (opt-in)", () => {
  const config = `version: 1
owner: Sam
profile: solo
checks:
  - name: test
    run: npm test
  - name: quote
    run: echo 'it''s fine'
`;

  it("writes a pre-push hook that runs the repo's checks, and removes only its own", async () => {
    const project = gitRepo({ "istack.yaml": config });
    const run = await install(project, [
      "install",
      "--host",
      "codex",
      "--project",
      project,
      "--hooks",
    ]);
    expect(run.code, run.err).toBe(0);
    const hook = join(project, ".git/hooks/pre-push");
    const text = readFileSync(hook, "utf8");
    expect(text).toContain("npm test");
    expect(text).toContain("istack:pre-push");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    await install(project, ["uninstall", "--host", "all", "--project", project]);
    expect(existsSync(hook)).toBe(false);
  });

  it("never replaces someone else's pre-push hook", async () => {
    const project = gitRepo({
      "istack.yaml": config,
      ".git/hooks/pre-push": "#!/bin/sh\nexit 0\n",
    });
    const run = await install(project, [
      "install",
      "--host",
      "codex",
      "--project",
      project,
      "--hooks",
    ]);
    expect(run.code).toBe(1);
    expect(run.out + run.err).toMatch(/pre-push/);
    expect(readFileSync(join(project, ".git/hooks/pre-push"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  it("the generated hook really runs the checks and stops the push on failure", async () => {
    const failing = config.replace("npm test", "exit 3");
    const project = gitRepo({ "istack.yaml": failing });
    await install(project, ["install", "--host", "codex", "--project", project, "--hooks"]);
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("sh", [".git/hooks/pre-push"], { cwd: project, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/test failed/);
  });
});

describe("git post-checkout hook (retro 2026-11-13 R5)", () => {
  /** A project with one commit on main and the hooks installed. */
  async function project(): Promise<{
    dir: string;
    git: (...args: string[]) => SpawnSyncReturns<string>;
  }> {
    const dir = gitRepo({
      "istack.yaml":
        'version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: test\n    run: "true"\n',
    });
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ISTACK_ALLOW_MAIN_CHECKOUT: "" },
      });
    git("commit", "-q", "--allow-empty", "-m", "base");
    const run = await install(dir, ["install", "--host", "codex", "--project", dir, "--hooks"]);
    expect(run.code, run.err).toBe(0);
    return { dir, git };
  }

  it("fails a switch to another branch in the main checkout and says to use a worktree", async () => {
    const { git } = await project();
    const switched = git("switch", "-q", "-c", "claude/task");
    expect(switched.status).toBe(1);
    expect(switched.stderr).toContain("istack: the main checkout is now on claude/task, not main.");
    expect(switched.stderr).toContain("git worktree add");
    expect(git("switch", "-q", "main").status).toBe(0);
  });

  it("lets worktrees, a detached HEAD and a deliberate switch through", async () => {
    const { dir, git } = await project();
    const wt = join(tempDir("ms-install-wt-"), "wt");
    expect(git("worktree", "add", "-q", "-b", "claude/task", wt).status).toBe(0);
    const inside = spawnSync("git", ["switch", "-q", "-c", "claude/other"], {
      cwd: wt,
      encoding: "utf8",
    });
    expect(inside.status, inside.stderr).toBe(0);
    expect(git("checkout", "-q", "--detach").status).toBe(0);
    expect(git("switch", "-q", "main").status).toBe(0);
    const allowed = spawnSync("git", ["switch", "-q", "-c", "claude/mine"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ISTACK_ALLOW_MAIN_CHECKOUT: "1" },
    });
    expect(allowed.status, allowed.stderr).toBe(0);
  });

  it("is removed with the other hooks", async () => {
    const { dir } = await project();
    const hook = join(dir, ".git/hooks/post-checkout");
    expect(readFileSync(hook, "utf8")).toContain("istack:post-checkout");
    await install(dir, ["uninstall", "--host", "all", "--project", dir]);
    expect(existsSync(hook)).toBe(false);
  });
});

describe("usage", () => {
  it("rejects an unknown host and a missing host", async () => {
    const home = tempDir();
    expect((await install(home, ["install", "--host", "vim", "--home", home])).code).toBe(2);
    expect((await install(home, ["install", "--home", home])).code).toBe(2);
    expect(snapshot(home)).toEqual([]);
  });

  it("--hooks needs a project", async () => {
    const home = tempDir();
    expect(
      (await install(home, ["install", "--host", "codex", "--home", home, "--hooks"])).code,
    ).toBe(2);
  });
});
