import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * F1: the code that decides the verdict must come from a trusted revision (the PR's base commit),
 * never from the PR head. The PR head is only data, or, for the verified tier, the thing under test.
 */

const root = new URL("..", import.meta.url).pathname;
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not JS
const BASE_SHA = "${{ github.event.pull_request.base.sha }}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not JS
const HEAD_SHA = "${{ github.event.pull_request.head.sha }}";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

function load(file: string): { workflow: Workflow; steps: Step[] } {
  const workflow = parse(
    readFileSync(join(root, ".github", "workflows", file), "utf8"),
  ) as Workflow;
  const jobs = Object.values(workflow.jobs);
  expect(jobs).toHaveLength(1);
  return { workflow, steps: (jobs[0] as { steps: Step[] }).steps };
}

const checkouts = (steps: Step[]) => steps.filter((s) => s.uses?.startsWith("actions/checkout@"));

for (const [file, action] of [
  ["receipts.yml", "action/receipts"],
  ["receipts-verified.yml", "action/receipts/verified"],
] as const) {
  describe(`${file} runs the checker from the base commit, never the PR head`, () => {
    it("parses as YAML", () => {
      expect(() => load(file)).not.toThrow();
    });

    it("triggers on pull_request only, with read-only permissions", () => {
      const { workflow } = load(file);
      expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
      for (const level of Object.values(workflow.permissions)) expect(level).toBe("read");
      expect(Object.keys(workflow.permissions)).toContain("contents");
    });

    it("checks the base commit out into its own path, without credentials", () => {
      const { steps } = load(file);
      const base = checkouts(steps).filter((s) => s.with?.ref === BASE_SHA);
      expect(base).toHaveLength(1);
      const path = base[0]?.with?.path;
      expect(typeof path).toBe("string");
      expect(path).not.toBe(".");
      for (const s of checkouts(steps)) {
        expect(s.with?.["persist-credentials"]).toBe(false);
        // Every checkout names a path: nothing lands in the workspace root by default, and the
        // only checkout of the base path is the base commit.
        expect(typeof s.with?.path).toBe("string");
        if (s.with?.path === path) expect(s.with?.ref).toBe(BASE_SHA);
      }
    });

    it("uses the action from the base checkout and builds nothing from the PR workspace", () => {
      const { steps } = load(file);
      const basePath = checkouts(steps).find((s) => s.with?.ref === BASE_SHA)?.with?.path;
      const local = steps.filter((s) => s.uses?.startsWith("./"));
      expect(local.map((s) => s.uses)).toEqual([`./${basePath}/${action}`]);
      // The checker is built and run only inside the (base-pinned) action; no workflow step runs
      // node, npm or the CLI itself.
      for (const s of steps) {
        if (s.run) expect(s.run).not.toMatch(/\b(node|npm|npx|mitchstack)\b/);
      }
    });

    it("fails as could-not-run when the base has no checker (bootstrap), never falls back", () => {
      const { steps } = load(file);
      const basePath = checkouts(steps).find((s) => s.with?.ref === BASE_SHA)?.with?.path;
      const guardIndex = steps.findIndex((s) =>
        s.run?.includes(`${basePath}/${action}/action.yml`),
      );
      const useIndex = steps.findIndex((s) => s.uses === `./${basePath}/${action}`);
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(useIndex);
      const guard = steps[guardIndex]?.run ?? "";
      expect(guard).toMatch(/could not run: checker not present on base/);
      expect(guard).toMatch(/exit 1/);
    });
  });
}

describe("receipts-verified.yml treats the PR head as the thing under test", () => {
  it("checks the head out separately, with full history, and points the verifier at it", () => {
    const { steps } = load("receipts-verified.yml");
    const head = checkouts(steps).filter((s) => s.with?.ref === HEAD_SHA);
    expect(head).toHaveLength(1);
    const headPath = head[0]?.with?.path as string;
    const basePath = checkouts(steps).find((s) => s.with?.ref === BASE_SHA)?.with?.path;
    expect(headPath).not.toBe(basePath);
    expect(head[0]?.with?.["fetch-depth"]).toBe(0);
    const verify = steps.find((s) => s.uses?.startsWith("./"));
    expect(verify?.uses?.startsWith(`./${headPath}/`)).toBe(false);
    expect(verify?.with?.path).toBe(`\${{ github.workspace }}/${headPath}`);
  });
});

describe("receipts.yml never checks out the PR head at all", () => {
  it("has only the base checkout", () => {
    const { steps } = load("receipts.yml");
    expect(checkouts(steps).map((s) => s.with?.ref)).toEqual([BASE_SHA]);
  });
});
