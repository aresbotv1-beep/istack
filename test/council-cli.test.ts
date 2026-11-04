import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverJudges, parseScoresReply } from "../src/council/judges.js";
import type { Judge, JudgeRequest } from "../src/council/run.js";
import { councilLogSchema } from "../src/council/schema.js";
import { runShipCli, type ShipDeps } from "../src/ship/cli.js";

const CONFIG = `version: 1
owner: Sam Rivera
profile: factory
checks:
  - name: test
    run: npm test
visibleChange:
  include: ["src/**/*.tsx"]
council:
  enabled: true
  budgetUsdPerPr: 5
  providers: [openai, anthropic]
`;

async function run(args: string[], cwd: string, deps?: ShipDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { cwd, env: {}, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const code = await runShipCli(args, io, deps);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function repo(config = CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), "ms-council-cli-"));
  writeFileSync(join(dir, "mitchstack.yaml"), config);
  writeFileSync(join(dir, "before.png"), "BEFORE-PIXELS");
  writeFileSync(join(dir, "after.png"), "AFTER-PIXELS");
  writeFileSync(join(dir, "control.png"), "CONTROL-PIXELS");
  writeFileSync(join(dir, "changed.txt"), "src/app/page.tsx\nREADME.md\n");
  writeFileSync(join(dir, "since.txt"), "src/app/page.tsx\n");
  return dir;
}

/** Fake judges that recognise a picture by its bytes, the only thing the staged copy keeps. */
function fakeJudges(round: { n: number }, seen: JudgeRequest[]): ShipDeps["judges"] {
  const make = (id: string, provider: string, cost: number, drifts: boolean): Judge => ({
    id,
    provider,
    costUsdPerCall: cost,
    score: async (request) => {
      seen.push(request);
      const scores: Record<string, number> = {};
      for (const p of request.pictures) {
        const bytes = readFileSync(p.path, "utf8");
        const role = bytes.startsWith("BEFORE")
          ? "before"
          : bytes.startsWith("AFTER")
            ? "after"
            : "control";
        const honest = { before: 4, after: 7, control: 5 }[role];
        const inflated = { before: 9, after: 10, control: 9 }[role];
        scores[p.label] = drifts && round.n === 2 ? inflated : honest;
      }
      return { kind: "scores", scores };
    },
  });
  return () => [
    make("a (openai)", "openai", 0.05, false),
    make("b (anthropic)", "anthropic", 0.1, true),
  ];
}

const ARGS = [
  "council",
  "--before",
  "before.png",
  "--after",
  "after.png",
  "--control",
  "control.png",
  "--changed",
  "changed.txt",
  "--log",
  "out/council.json",
];

describe("mitchstack ship council", () => {
  it("writes a log, discards the planted-drift round, and the body shows none of its numbers", async () => {
    const dir = repo();
    const round = { n: 1 };
    const seen: JudgeRequest[] = [];
    const deps: ShipDeps = { judges: fakeJudges(round, seen), now: () => "2026-11-04T00:00:00Z" };

    const first = await run([...ARGS, "--head", "aaaaaaaa1111"], dir, deps);
    expect(first.code).toBe(0);
    expect(first.out).toContain("council round 1 kept");
    expect(first.out).toContain("| a (openai) | 4 | 7 | 5 | 4–6 |");

    // Judges only ever see hash-named copies, never the role in a file name.
    for (const request of seen) {
      for (const p of request.pictures) expect(basename(p.path)).toMatch(/^[0-9a-f]{16}\.png$/);
    }

    round.n = 2;
    const second = await run(
      [...ARGS, "--head", "bbbbbbbb2222", "--changed-since-last", "since.txt"],
      dir,
      deps,
    );
    expect(second.code).toBe(0);
    expect(second.out).toContain("council round 2 discarded: control drift: b (anthropic)");

    const log = councilLogSchema.parse(
      JSON.parse(readFileSync(join(dir, "out/council.json"), "utf8")),
    );
    expect(log.rounds.map((r) => r.status)).toEqual(["kept", "discarded"]);

    writeFileSync(
      join(dir, "body.json"),
      JSON.stringify({
        summary: "new header",
        evidence: "pictures attached",
        mergeDanger: { door: "two-way", blastRadius: "the home page header" },
        tryItYourself: ["`npm run dev`"],
        reviews: [],
        councilLog: "out/council.json",
        risks: [],
        receipts: { head: "bbbbbbbb2222", claims: [], noVisibleChange: "fixture" },
      }),
    );
    const body = await run(["body", "--from", "body.json"], dir);
    expect(body.code).toBe(0);
    expect(body.out).toContain("### Council scores");
    expect(body.out).toContain("No council scores.");
    expect(body.out).not.toMatch(/\| (9|10) \|/);
    expect(body.out.indexOf("### Council scores")).toBeLessThan(
      body.out.indexOf("## Open disputes"),
    );
  });

  it("skips without rescoring when no visible file changed since the last round", async () => {
    const dir = repo();
    const seen: JudgeRequest[] = [];
    const deps: ShipDeps = { judges: fakeJudges({ n: 1 }, seen) };
    await run([...ARGS, "--head", "aaaaaaaa1111"], dir, deps);
    const calls = seen.length;
    writeFileSync(join(dir, "since.txt"), "README.md\n");
    const again = await run(
      [...ARGS, "--head", "cccccccc3333", "--changed-since-last", "since.txt"],
      dir,
      deps,
    );
    expect(again.code).toBe(0);
    expect(again.out).toContain("council skipped: no visible file changed since round 1");
    expect(seen.length).toBe(calls);
  });

  it("does nothing outside the factory profile", async () => {
    const dir = repo(CONFIG.replace("profile: factory", "profile: team"));
    const seen: JudgeRequest[] = [];
    const result = await run([...ARGS, "--head", "aaaaaaaa1111"], dir, {
      judges: fakeJudges({ n: 1 }, seen),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("council skipped: the council runs only in the factory profile");
    expect(seen).toHaveLength(0);
  });

  it("exits 2 with usage when a required flag is missing", async () => {
    const result = await run(["council", "--after", "after.png"], repo());
    expect(result.code).toBe(2);
    expect(result.err).toContain("council needs");
  });
});

describe("council judges (thin adapters)", () => {
  it("parses 'Picture N: score' lines and ignores the rest", () => {
    expect(
      parseScoresReply("Sure!\nPicture 1: 6\n**Picture 2**: 8/10\nPicture 3 - 7.5\nnotes"),
    ).toEqual({
      "Picture 1": 6,
      "Picture 2": 8,
      "Picture 3": 7.5,
    });
  });

  it("builds one judge per installed, allowed provider CLI, priced from the table", async () => {
    const calls: string[][] = [];
    const judges = discoverJudges({
      probe: { hasCommand: (name) => name !== "cursor-agent" },
      providers: [],
      prices: { openai: 0.03 },
      pictureDir: "/stage",
      exec: async (file, args) => {
        calls.push([file, ...args]);
        if (file === "claude") {
          return {
            code: 0,
            stdout: JSON.stringify({ result: "Picture 1: 5\nPicture 2: 6", total_cost_usd: 0.04 }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "Picture 1: 5\nPicture 2: 6", stderr: "" };
      },
    });
    expect(judges.map((j) => [j.id, j.costUsdPerCall])).toEqual([
      ["codex exec (openai)", 0.03],
      ["claude -p (anthropic)", 0.25],
    ]);
    const request = {
      rubric: "R",
      pictures: [
        { label: "Picture 1", path: "/stage/aa.png" },
        { label: "Picture 2", path: "/stage/bb.png" },
      ],
    };
    expect(await judges[0]?.score(request)).toEqual({
      kind: "scores",
      scores: { "Picture 1": 5, "Picture 2": 6 },
    });
    expect(calls[0]).toEqual(expect.arrayContaining(["--image", "/stage/aa.png"]));
    expect(await judges[1]?.score(request)).toMatchObject({ costUsd: 0.04 });
  });
});
