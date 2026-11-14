import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { toFieldErrors } from "../result.js";
import { loadScenarios, skillsWithEvals } from "./scenarios.js";
import type { Criterion, DeterministicCriterion, Scenario } from "./schema.js";
import { scoreCriterion } from "./score.js";

/**
 * Reply examples for a scenario's criteria, in `evals/<skill>/examples/<scenario-id>.yaml`. A regex
 * criterion is checked against sentences it must pass and sentences it must fail before any paid
 * eval run trusts it (retro 2026-11-13 R1: a rubric misjudged replies across three review rounds).
 * Examples live beside the scenarios, not in them, so adding one does not stale a baseline.
 */
export const examplesSchema = z.strictObject({
  scenario: z.string().min(1),
  criteria: z.record(
    z.string(),
    z.strictObject({
      pass: z.array(z.string().min(1)).min(1),
      fail: z.array(z.string().min(1)).min(1),
    }),
  ),
});
export type Examples = z.output<typeof examplesSchema>;

/** Scenarios not yet covered, one `<skill>/<scenario-id>` per line. The list only shrinks. */
export const PENDING_FILE = join("evals", "examples-pending.txt");

/** A criterion is judged by a pattern someone wrote, so it needs examples. */
export function needsExamples(c: Criterion): boolean {
  switch (c.kind) {
    case "includes":
    case "excludes":
    case "last-question":
    case "order":
      return true;
    case "count":
      return typeof c.of !== "string";
    default:
      return false;
  }
}

export interface ExampleProblem {
  /** `<skill>/<scenario-id>`, plus `#<criterion-id>` when one criterion is at fault. */
  where: string;
  problem: string;
}

/** Every problem with the examples under `root`: misjudged sentences, missing or stray examples. */
export function checkExamples(root: string, evalsDir = "evals"): ExampleProblem[] {
  const problems: ExampleProblem[] = [];
  const pendingPath = join(root, evalsDir, "examples-pending.txt");
  const pending = new Set(
    existsSync(pendingPath)
      ? readFileSync(pendingPath, "utf8")
          .split("\n")
          .map((l) => l.replace(/#.*/, "").trim())
          .filter(Boolean)
      : [],
  );
  const seen = new Set<string>();
  for (const skill of skillsWithEvals(root, evalsDir)) {
    const { scenarios } = loadScenarios(root, skill, evalsDir);
    const dir = join(root, evalsDir, skill, "examples");
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)) : [];
    const byScenario = new Map<string, { file: string; examples: Examples }>();
    for (const file of files) {
      const parsed = examplesSchema.safeParse(parse(readFileSync(join(dir, file), "utf8")));
      if (!parsed.success) {
        const errors = toFieldErrors(parsed.error.issues).map((e) => `${e.path}: ${e.message}`);
        problems.push({ where: `${skill}/examples/${file}`, problem: errors.join("; ") });
        continue;
      }
      const other = byScenario.get(parsed.data.scenario);
      if (other) {
        problems.push({
          where: `${skill}/${parsed.data.scenario}`,
          problem: `two example files: examples/${other.file} and examples/${file}; keep one`,
        });
        continue;
      }
      byScenario.set(parsed.data.scenario, { file, examples: parsed.data });
    }
    for (const id of byScenario.keys()) {
      if (!scenarios.some((s) => s.id === id))
        problems.push({
          where: `${skill}/${id}`,
          problem: "examples for a scenario that does not exist",
        });
    }
    for (const scenario of scenarios) {
      const key = `${skill}/${scenario.id}`;
      seen.add(key);
      const entry = byScenario.get(scenario.id);
      if (!entry) {
        if (!pending.has(key) && scenario.criteria.some(needsExamples))
          problems.push({
            where: key,
            problem: `no examples: add ${skill}/examples/${scenario.id}.yaml`,
          });
        continue;
      }
      if (pending.has(key))
        problems.push({ where: key, problem: `has examples now: remove it from ${PENDING_FILE}` });
      problems.push(...checkScenario(key, scenario, entry.examples));
    }
  }
  for (const key of pending) {
    if (!seen.has(key))
      problems.push({ where: key, problem: `listed in ${PENDING_FILE} but no such scenario` });
  }
  return problems;
}

function checkScenario(key: string, scenario: Scenario, examples: Examples): ExampleProblem[] {
  const problems: ExampleProblem[] = [];
  for (const id of Object.keys(examples.criteria)) {
    if (!scenario.criteria.some((c) => c.id === id))
      problems.push({
        where: `${key}#${id}`,
        problem: "examples for a criterion that does not exist",
      });
  }
  for (const c of scenario.criteria) {
    if (!needsExamples(c)) continue;
    const where = `${key}#${c.id}`;
    const set = examples.criteria[c.id];
    if (!set) {
      problems.push({ where, problem: "no pass/fail examples" });
      continue;
    }
    const criterion = c as DeterministicCriterion;
    for (const reply of set.pass) {
      const r = scoreCriterion(criterion, reply);
      if (!r.pass) problems.push({ where, problem: `should pass, failed (${r.detail}): ${reply}` });
    }
    for (const reply of set.fail) {
      const r = scoreCriterion(criterion, reply);
      if (r.pass) problems.push({ where, problem: `should fail, passed (${r.detail}): ${reply}` });
    }
  }
  return problems;
}
