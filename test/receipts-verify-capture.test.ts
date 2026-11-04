import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { capture } from "../src/capture/capture.js";
import { verifyReceipts } from "../src/receipts/verify/verify.js";
import { git, image, makeFixtureRepo, prBody } from "./verify-fixture.js";

/**
 * The verified tier with the real headless capture (Chromium): the "agent" captures base and head
 * on this machine, then the verifier re-captures both in temp worktrees and compares hashes.
 */
describe("receipts verify with real Playwright capture", { timeout: 120_000 }, () => {
  it("verifies an honest pair and catches a faked after", async () => {
    const fx = makeFixtureRepo();
    const shots = mkdtempSync(join(tmpdir(), "ms-verify-agent-"));
    const url = pathToFileURL(join(fx.repo, "public/index.html")).href;
    const after = await capture({ url, out: join(shots, "after.png") });
    git(fx.repo, "checkout", "-q", fx.base);
    const before = await capture({ url, out: join(shots, "before.png") });
    git(fx.repo, "checkout", "-q", "fix-sum");
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.sha256).not.toBe(after.sha256);

    const visual = (id: string, afterSha: string) => ({
      id,
      kind: "visual",
      statement: "the greeting names the world",
      surface: "public/index.html",
      before: image(before.sha256),
      after: image(afterSha),
    });
    const fakeAfter = "f".repeat(64);
    const report = await verifyReceipts({
      repo: fx.repo,
      body: prBody(fx.head, [visual("honest", after.sha256), visual("faked", fakeAfter)]),
      base: fx.base,
      head: fx.head,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const byId = Object.fromEntries(report.claims.map((c) => [c.id, c]));
    expect(byId.honest?.status).toBe("verified");
    expect(byId.faked?.status).toBe("failed");
    expect(report.conclusion).toBe("fail");
  });
});
