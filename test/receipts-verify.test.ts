import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type Exec, realExec } from "../src/receipts/verify/exec.js";
import { type VerifyReport, verifyReceipts } from "../src/receipts/verify/verify.js";
import {
  BASE_FILES,
  type FixtureRepo,
  fileHashCapture,
  git,
  HEAD_FILES,
  image,
  makeFixtureRepo,
  prBody,
  redGreen,
  sha256,
} from "./verify-fixture.js";

const deps = { exec: realExec, capture: fileHashCapture };

function claim(report: VerifyReport, id: string) {
  if (!report.ok) throw new Error(`verify could not run: ${report.error}`);
  const found = report.claims.find((c) => c.id === id);
  if (!found) throw new Error(`no verdict for ${id}`);
  return found;
}

describe("receipts verify: red→green re-run in a fixture repo", { timeout: 60_000 }, () => {
  let fx: FixtureRepo;
  beforeAll(() => {
    fx = makeFixtureRepo();
  });

  it("catches a faked red→green: the claimed test already passes at base", async () => {
    const body = prBody(fx.head, [redGreen("faked", "node test/mul.test.mjs", fx)]);
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head },
      deps,
    );
    const verdict = claim(report, "faked");
    expect(verdict.status).toBe("failed");
    expect(verdict.reasons.join("\n")).toMatch(/passes at base/);
    expect(report.ok && report.conclusion).toBe("fail");
  });

  it("verifies an honest red→green: the new test fails at base and passes at head", async () => {
    const body = prBody(fx.head, [redGreen("honest", "node test/sum.test.mjs", fx)]);
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head },
      deps,
    );
    expect(claim(report, "honest").status).toBe("verified");
    expect(report.ok && report.conclusion).toBe("pass");
  });

  it("catches a claimed green that fails at head", async () => {
    const body = prBody(fx.head, [redGreen("never-green", "node -e 'process.exit(3)'", fx)]);
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head },
      deps,
    );
    const verdict = claim(report, "never-green");
    expect(verdict.status).toBe("failed");
    expect(verdict.reasons.join("\n")).toMatch(/fails at head/);
  });

  it("a timeout is could-not-verify, never a pass", async () => {
    const body = prBody(fx.head, [redGreen("slow", "sleep 5", fx)]);
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head, timeoutMs: 300 },
      deps,
    );
    const verdict = claim(report, "slow");
    expect(verdict.status).toBe("could-not-verify");
    expect(verdict.reasons.join("\n")).toMatch(/timed out/);
    expect(report.ok && report.conclusion).toBe("could-not-verify");
  });

  it("a failing setup is could-not-verify, not a failed claim", async () => {
    const body = prBody(fx.head, [redGreen("honest", "node test/sum.test.mjs", fx)]);
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head, setup: "exit 9" },
      deps,
    );
    expect(claim(report, "honest").status).toBe("could-not-verify");
  });

  it("never mutates the caller's checkout and leaves no worktrees behind", async () => {
    const before = {
      head: git(fx.repo, "rev-parse", "HEAD"),
      status: git(fx.repo, "status", "--porcelain"),
      worktrees: git(fx.repo, "worktree", "list", "--porcelain"),
    };
    const body = prBody(fx.head, [
      redGreen("honest", "node test/sum.test.mjs", fx),
      redGreen("faked", "node test/mul.test.mjs", fx),
    ]);
    // Record the worktrees this run creates (other test files verify in parallel in the same tmpdir).
    const created: string[] = [];
    const recording: Exec = (file, args, options) => {
      if (file === "git" && args[0] === "worktree" && args[1] === "add") {
        created.push(args[args.length - 2] as string);
      }
      return realExec(file, args, options);
    };
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head },
      { ...deps, exec: recording },
    );
    expect(report.ok).toBe(true);
    expect(created).toHaveLength(2);
    for (const dir of created) expect(existsSync(dir)).toBe(false);
    expect(git(fx.repo, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(fx.repo, "status", "--porcelain")).toBe(before.status);
    expect(git(fx.repo, "worktree", "list", "--porcelain")).toBe(before.worktrees);
  });
});

describe("receipts verify: visual re-capture in a fixture repo", { timeout: 60_000 }, () => {
  let fx: FixtureRepo;
  beforeAll(() => {
    fx = makeFixtureRepo();
  });
  const baseShot = sha256(BASE_FILES["public/index.html"]);
  const headShot = sha256(HEAD_FILES["public/index.html"]);
  const visual = (id: string, surface: string, before: unknown, after: unknown) => ({
    id,
    kind: "visual",
    statement: `${surface} changed`,
    surface,
    before,
    after,
  });

  it("verifies an honest before/after pair", async () => {
    const body = prBody(fx.head, [
      visual("honest", "public/index.html", image(baseShot), image(headShot)),
    ]);
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head },
      deps,
    );
    expect(claim(report, "honest").status).toBe("verified");
  });

  it("catches a faked after: the claimed hash does not match the re-capture", async () => {
    const body = prBody(fx.head, [
      visual("faked", "public/index.html", image(baseShot), image(sha256("not the real page"))),
    ]);
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head },
      deps,
    );
    const verdict = claim(report, "faked");
    expect(verdict.status).toBe("failed");
    expect(verdict.reasons.join("\n")).toMatch(/after/);
  });

  it("when neither side matches: strict fails, lenient cannot verify (environments may differ)", async () => {
    const body = prBody(fx.head, [
      visual("other-env", "public/index.html", image(sha256("x")), image(sha256("y"))),
    ]);
    const input = { repo: fx.repo, body, base: fx.base, head: fx.head };
    const lenient = await verifyReceipts(input, deps);
    const strict = await verifyReceipts({ ...input, visual: "strict" as const }, deps);
    expect(claim(lenient, "other-env").status).toBe("could-not-verify");
    expect(claim(strict, "other-env").status).toBe("failed");
  });

  it("before: absent verifies only when the surface does not exist at base", async () => {
    const newShot = sha256(HEAD_FILES["public/new.html"]);
    const body = prBody(fx.head, [
      visual("new-screen", "public/new.html", "absent", image(newShot)),
      visual("not-new", "public/index.html", "absent", image(headShot)),
    ]);
    const report = await verifyReceipts(
      { repo: fx.repo, body, base: fx.base, head: fx.head },
      deps,
    );
    expect(claim(report, "new-screen").status).toBe("verified");
    const notNew = claim(report, "not-new");
    expect(notNew.status).toBe("failed");
    expect(notNew.reasons.join("\n")).toMatch(/already exists at base/);
  });
});
