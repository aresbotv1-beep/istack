import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderHook } from "../src/install/actions.js";
import { renderBlock } from "../src/install/block.js";
import { loadKit } from "../src/install/kit.js";
import { gitRepo, install, put, snapshot, tempDir } from "./install-helpers.js";

const KIT = new URL("..", import.meta.url).pathname;
const kit = loadKit(KIT);
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const MANIFEST = ".mitchstack/install.json";

function manifest(root: string, entries: unknown[]): void {
  put(root, MANIFEST, JSON.stringify({ version: 1, entries }, null, 2));
}

/** A project inside a parent, with a file next to it that no install may ever touch. */
function projectWithVictim() {
  const parent = tempDir("ms-safety-");
  const project = join(parent, "project");
  mkdirSync(project);
  put(parent, "victim.txt", "user-owned file");
  return { parent, project, victimSha: sha("user-owned file") };
}

describe("F6: the install record is validated before anything is touched", () => {
  it("refuses a skill entry whose dir climbs out of the root, and deletes nothing", async () => {
    const { parent, project, victimSha } = projectWithVictim();
    manifest(project, [
      { kind: "skill", host: "codex", dir: "..", files: { "victim.txt": victimSha } },
    ]);
    const before = snapshot(parent);

    const run = await install(project, ["uninstall", "--host", "codex", "--project", project]);

    expect(run.code).toBe(2);
    expect(run.err).toMatch(/install\.json/);
    expect(existsSync(join(parent, "victim.txt"))).toBe(true);
    expect(snapshot(parent)).toEqual(before);
  });

  const bad: Array<[string, (victimSha: string, abs: string) => unknown]> = [
    [
      "an absolute skill dir",
      (s, abs) => ({ kind: "skill", host: "codex", dir: abs, files: { "victim.txt": s } }),
    ],
    [
      "a file key with ..",
      (s) => ({
        kind: "skill",
        host: "codex",
        dir: ".agents/skills/plan",
        files: { "../../../../victim.txt": s },
      }),
    ],
    [
      "an absolute file key",
      (s, abs) => ({
        kind: "skill",
        host: "codex",
        dir: ".agents/skills/plan",
        files: { [join(abs, "victim.txt")]: s },
      }),
    ],
    [
      "a skill dir in another host's location",
      (s) => ({
        kind: "skill",
        host: "codex",
        dir: ".claude/skills/plan",
        files: { "SKILL.md": s },
      }),
    ],
    [
      "a skill dir nested below the skills folder",
      (s) => ({
        kind: "skill",
        host: "codex",
        dir: ".agents/skills/a/b",
        files: { "SKILL.md": s },
      }),
    ],
    [
      "a block path outside the root",
      () => ({
        kind: "block",
        hosts: ["codex"],
        path: "../victim.txt",
        prefix: "",
        createdFile: true,
      }),
    ],
    ["a hook path outside the root", (s) => ({ kind: "hook", path: "../victim.txt", sha: s })],
    ["a dir entry outside the root", () => ({ kind: "dir", owners: ["codex"], path: ".." })],
    [
      "an unknown host",
      (s) => ({ kind: "skill", host: "vim", dir: ".agents/skills/plan", files: { "SKILL.md": s } }),
    ],
    ["a malformed sha", () => ({ kind: "hook", path: ".git/hooks/pre-push", sha: "nope" })],
    ["an unknown kind", () => ({ kind: "file", path: "../victim.txt" })],
  ];

  it.each(bad)("refuses %s, whole, alongside a valid entry — nothing deleted", async (_, make) => {
    const { parent, project, victimSha } = projectWithVictim();
    // A real install first, so the manifest also holds valid entries that a partial run would act on.
    expect(
      (await install(project, ["install", "--host", "codex", "--project", project])).code,
    ).toBe(0);
    const record = JSON.parse(readFileSync(join(project, MANIFEST), "utf8"));
    record.entries.push(make(victimSha, parent));
    put(project, MANIFEST, JSON.stringify(record));
    const before = snapshot(parent);

    const gone = await install(project, ["uninstall", "--host", "all", "--project", project]);
    expect(gone.code, gone.out).toBe(2);
    expect(snapshot(parent)).toEqual(before);

    const again = await install(project, ["install", "--host", "codex", "--project", project]);
    expect(again.code, again.out).toBe(2);
    expect(snapshot(parent)).toEqual(before);
  });

  it("refuses an entry that escapes through a symlink", async () => {
    const { parent, project } = projectWithVictim();
    put(parent, "outside/SKILL.md", "not mitchstack's\n");
    mkdirSync(join(project, ".agents/skills"), { recursive: true });
    symlinkSync(join(parent, "outside"), join(project, ".agents/skills/plan"));
    manifest(project, [
      {
        kind: "skill",
        host: "codex",
        dir: ".agents/skills/plan",
        files: { "SKILL.md": sha("not mitchstack's\n") },
      },
    ]);
    const before = snapshot(parent);

    const run = await install(project, ["uninstall", "--host", "codex", "--project", project]);

    expect(run.code).toBe(2);
    expect(run.err).toMatch(/symlink|outside/i);
    expect(readFileSync(join(parent, "outside/SKILL.md"), "utf8")).toBe("not mitchstack's\n");
    expect(snapshot(parent)).toEqual(before);
  });

  it("still accepts its own records: install, re-install, uninstall round trip", async () => {
    const project = gitRepo({
      "mitchstack.yaml":
        'version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: t\n    run: "true"\n',
    });
    const before = snapshot(project);
    const args = ["--host", "all", "--project", project];
    expect((await install(project, ["install", ...args, "--hooks"])).code).toBe(0);
    expect((await install(project, ["install", ...args, "--hooks"])).code).toBe(0);
    expect((await install(project, ["uninstall", ...args])).code).toBe(0);
    expect(snapshot(project)).toEqual(before);
  });
});

describe("F9: a file the installer did not write is never owned, whatever its bytes", () => {
  const config =
    'version: 1\nowner: owner\nprofile: solo\nchecks:\n  - name: check\n    run: "true"\n';

  it("leaves a pre-existing pre-push hook alone even when it is byte-identical", async () => {
    const hookText = renderHook(kit.hookTemplate, [{ name: "check", run: "true" }]);
    const project = gitRepo({ "mitchstack.yaml": config, ".git/hooks/pre-push": hookText });
    const hook = join(project, ".git/hooks/pre-push");

    const run = await install(project, [
      "install",
      "--host",
      "claude",
      "--project",
      project,
      "--hooks",
    ]);
    expect(run.code).toBe(1);
    expect(run.out + run.err).toMatch(/pre-push/);
    await install(project, ["uninstall", "--host", "all", "--project", project]);

    expect(existsSync(hook)).toBe(true);
    expect(readFileSync(hook, "utf8")).toBe(hookText);
  });

  it("leaves a pre-existing identical skill file alone when the record does not list it", async () => {
    const home = tempDir();
    await install(home, ["install", "--host", "claude", "--home", home]);
    // board.md is on disk, identical to the kit's, but this record never wrote it.
    const record = JSON.parse(readFileSync(join(home, MANIFEST), "utf8"));
    const skill = record.entries.find(
      (e: { kind: string; dir?: string }) =>
        e.kind === "skill" && e.dir === ".claude/skills/groundbreak",
    );
    delete skill.files["board.md"];
    put(home, MANIFEST, JSON.stringify(record));
    const board = join(home, ".claude/skills/groundbreak/board.md");

    await install(home, ["install", "--host", "claude", "--home", home]);
    await install(home, ["uninstall", "--host", "claude", "--home", home]);

    expect(existsSync(board)).toBe(true);
  });

  it("leaves a pre-existing identical AGENTS.md block alone", async () => {
    const project = gitRepo({ "AGENTS.md": `# Rules\n\n${renderBlock(kit.contract)}\n` });
    const before = snapshot(project);

    const run = await install(project, ["install", "--host", "codex", "--project", project]);
    expect(run.code).toBe(1);
    await install(project, ["uninstall", "--host", "codex", "--project", project]);

    expect(snapshot(project)).toEqual(before);
  });
});

/** Every markdown link in every installed skill file, with whether its target exists. */
function links(skillsDir: string): Array<{ from: string; target: string; ok: boolean }> {
  const found: Array<{ from: string; target: string; ok: boolean }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) {
        const text = readFileSync(full, "utf8");
        for (const [, raw] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
          const target = (raw ?? "").split("#")[0] ?? "";
          if (!target || /^[a-z]+:/i.test(target)) continue;
          found.push({ from: full, target, ok: existsSync(resolve(dirname(full), target)) });
        }
      }
    }
  };
  walk(skillsDir);
  return found;
}

const SKILL_DIRS = [".claude/skills", ".agents/skills", ".cursor/skills"];

describe("F12: every file an installed skill points at is installed with it", () => {
  it("bundles the templates next to the skills that use them, identical to templates/", () => {
    const pairs = [
      ["templates/ticket.md", "skills/plan/ticket-template.md"],
      ["templates/ticket.md", "skills/groundbreak/ticket-template.md"],
      ["templates/pr-body.md", "skills/ship/pr-body.md"],
    ];
    for (const [canonical, copy] of pairs) {
      expect(existsSync(join(KIT, copy as string)), copy).toBe(true);
      expect(readFileSync(join(KIT, copy as string), "utf8"), copy).toBe(
        readFileSync(join(KIT, canonical as string), "utf8"),
      );
    }
  });

  it("resolves every relative link after install and names no kit-only path", async () => {
    const project = gitRepo();
    expect((await install(project, ["install", "--host", "all", "--project", project])).code).toBe(
      0,
    );
    for (const dir of SKILL_DIRS) {
      const found = links(join(project, dir));
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((l) => !l.ok)).toEqual([]);
      for (const name of readdirSync(join(project, dir))) {
        for (const file of readdirSync(join(project, dir, name))) {
          const text = readFileSync(join(project, dir, name, file), "utf8");
          expect(text, `${dir}/${name}/${file}`).not.toMatch(/`templates\//);
        }
      }
    }
  });
});

describe("F13: --prefix keeps cross-skill links working", () => {
  it("rewrites ../<skill>/ links to the prefixed folder, and every link resolves", async () => {
    const project = gitRepo();
    const args = ["install", "--host", "all", "--project", project, "--prefix"];
    expect((await install(project, args)).code).toBe(0);
    for (const dir of SKILL_DIRS) {
      expect(links(join(project, dir)).filter((l) => !l.ok)).toEqual([]);
      const climb = readFileSync(join(project, dir, "mitchstack-climb/SKILL.md"), "utf8");
      expect(climb).toContain("](../mitchstack-ship/council.md)");
    }
  });

  it("records the hashes of the rewritten bytes, so a prefixed re-install changes nothing", async () => {
    const project = gitRepo();
    const args = ["install", "--host", "all", "--project", project, "--prefix"];
    await install(project, args);
    const record = JSON.parse(readFileSync(join(project, MANIFEST), "utf8"));
    for (const entry of record.entries.filter((e: { kind: string }) => e.kind === "skill")) {
      for (const [file, digest] of Object.entries(entry.files as Record<string, string>)) {
        expect(sha(readFileSync(join(project, entry.dir, file))), `${entry.dir}/${file}`).toBe(
          digest,
        );
      }
    }
    const after = snapshot(project);
    const again = await install(project, args);
    expect(again.code).toBe(0);
    expect(snapshot(project)).toEqual(after);
    expect(
      (await install(project, ["uninstall", "--host", "all", "--project", project])).code,
    ).toBe(0);
    expect(snapshot(project)).toEqual([]);
  });
});
