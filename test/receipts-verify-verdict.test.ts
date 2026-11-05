import { describe, expect, it } from "vitest";
import { scrubEnv } from "../src/receipts/verify/exec.js";
import { parseNameStatus } from "../src/receipts/verify/git.js";
import {
  combine,
  decideGreen,
  decideRed,
  decideVisual,
  type RunOutcome,
  type Shot,
  toOutcome,
} from "../src/receipts/verify/verdict.js";

const exit = (code: number): RunOutcome => ({ kind: "exit", code });
const timeout: RunOutcome = { kind: "timeout", afterMs: 300_000 };
const hash = (sha256: string): Shot => ({ kind: "hash", sha256 });
const absent: Shot = { kind: "absent" };

describe("red rule (strict: the anti-faking side)", () => {
  it("verified when every run fails", () => {
    expect(decideRed([exit(1), exit(1)], 1).status).toBe("verified");
  });
  it("failed when every run passes at base", () => {
    expect(decideRed([exit(0), exit(0)], 1).status).toBe("failed");
  });
  it("could-not-verify when base is flaky", () => {
    const v = decideRed([exit(1), exit(0)], 1);
    expect(v.status).toBe("could-not-verify");
    expect(v.reasons[0]).toMatch(/flaky/);
  });
  it("could-not-verify on a timeout, even if another run failed", () => {
    expect(decideRed([exit(1), timeout], 1).status).toBe("could-not-verify");
  });
  it("a command the shell could not find is could-not-verify, not a red", () => {
    const notFound = toOutcome(
      { exitCode: 127, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 1 },
      1000,
    );
    expect(decideRed([notFound, notFound], 1).status).toBe("could-not-verify");
  });
  it("notes an exit code that differs from the recorded one without failing", () => {
    const v = decideRed([exit(2), exit(2)], 1);
    expect(v.status).toBe("verified");
    expect(v.reasons.join(" ")).toMatch(/recorded red exit 1/);
  });
});

describe("green rule (retried like ordinary CI)", () => {
  it("verified on a first-run pass", () => {
    expect(decideGreen([exit(0)]).status).toBe("verified");
  });
  it("verified with a flake note on a retry pass", () => {
    const v = decideGreen([exit(1), exit(0)]);
    expect(v.status).toBe("verified");
    expect(v.reasons[0]).toMatch(/flaky/);
  });
  it("failed when every run fails", () => {
    expect(decideGreen([exit(1), exit(1)]).status).toBe("failed");
  });
  it("could-not-verify on a timeout", () => {
    expect(decideGreen([timeout]).status).toBe("could-not-verify");
  });
});

describe("combine", () => {
  it("failed beats could-not-verify beats verified", () => {
    const v = { status: "verified" as const, reasons: [] };
    const c = { status: "could-not-verify" as const, reasons: [] };
    const f = { status: "failed" as const, reasons: [] };
    expect(combine(v, c).status).toBe("could-not-verify");
    expect(combine(c, f).status).toBe("failed");
    expect(combine(v, v).status).toBe("verified");
  });
});

describe("visual rule", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const X = "c".repeat(64);
  const claim = { surface: "page", before: { sha256: A }, after: { sha256: B } };

  it("verified on an exact match", () => {
    expect(decideVisual(claim, hash(A), hash(B), "lenient").status).toBe("verified");
  });
  it("failed when base and head render the same in CI", () => {
    expect(decideVisual(claim, hash(X), hash(X), "lenient").status).toBe("failed");
  });
  it("failed when one side matches and the other does not (environment proven equal)", () => {
    expect(decideVisual(claim, hash(A), hash(X), "lenient").status).toBe("failed");
  });
  it("lenient: no side matches → could-not-verify; strict → failed", () => {
    const d = "d".repeat(64);
    expect(decideVisual(claim, hash(X), hash(d), "lenient").status).toBe("could-not-verify");
    expect(decideVisual(claim, hash(X), hash(d), "strict").status).toBe("failed");
  });
  it("a missing surface at head fails", () => {
    expect(decideVisual(claim, hash(A), absent, "lenient").status).toBe("failed");
  });
  it("a claimed before picture for a surface absent at base fails", () => {
    expect(decideVisual(claim, absent, hash(B), "lenient").status).toBe("failed");
  });
  it("before: absent needs the surface absent at base", () => {
    const fresh = { surface: "new", before: "absent" as const, after: { sha256: B } };
    expect(decideVisual(fresh, absent, hash(B), "lenient").status).toBe("verified");
    expect(decideVisual(fresh, hash(A), hash(B), "lenient").status).toBe("failed");
    expect(decideVisual(fresh, absent, hash(X), "lenient").status).toBe("could-not-verify");
    expect(decideVisual(fresh, absent, hash(X), "strict").status).toBe("failed");
  });
  it("a broken capture is could-not-verify", () => {
    expect(decideVisual(claim, { kind: "error", why: "boom" }, hash(B), "strict").status).toBe(
      "could-not-verify",
    );
  });
});

describe("plumbing", () => {
  it("parses name-status with renames", () => {
    expect(parseNameStatus("M\0a.ts\0R087\0old.test.ts\0new.test.ts\0A\0b.ts\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "R", path: "new.test.ts", from: "old.test.ts" },
      { status: "A", path: "b.ts" },
    ]);
  });
  it("scrubs tokens and workflow file commands from a command's environment", () => {
    const env = scrubEnv({
      PATH: "/bin",
      GITHUB_TOKEN: "t",
      GH_TOKEN: "t",
      GITHUB_OUTPUT: "/o",
      HOME: "/h",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});
