import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { toFieldErrors } from "../result.js";
import { type Scenario, scenarioSchema } from "./schema.js";

export interface ScenarioSet {
  skill: string;
  scenarios: Scenario[];
  /** sha256 over the scenario files, in name order. */
  hash: string;
}

/** Every `evals/<skill>/*.yaml`, in file-name order. Throws on an invalid file, naming the field. */
export function loadScenarios(root: string, skill: string, evalsDir = "evals"): ScenarioSet {
  const dir = join(root, evalsDir, skill);
  if (!existsSync(dir)) throw new Error(`no scenarios at ${dir}`);
  const names = readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort();
  if (names.length === 0) throw new Error(`no scenarios at ${dir}`);
  const hash = createHash("sha256");
  const scenarios = names.map((name) => {
    const text = readFileSync(join(dir, name), "utf8");
    hash.update(`${name}\n${text}\n`);
    return parseScenario(text, join(dir, name), skill);
  });
  const ids = new Set<string>();
  for (const s of scenarios) {
    if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id} in ${dir}`);
    ids.add(s.id);
  }
  return { skill, scenarios, hash: hash.digest("hex") };
}

export function parseScenario(text: string, where: string, skill?: string): Scenario {
  const parsed = scenarioSchema.safeParse(parse(text));
  if (!parsed.success) {
    const errors = toFieldErrors(parsed.error.issues).map(
      (e) => `${e.path || "(file)"}: ${e.message}`,
    );
    throw new Error(`${where} is not a scenario: ${errors.join("; ")}`);
  }
  if (skill && parsed.data.skill !== skill) {
    throw new Error(`${where} is for skill ${parsed.data.skill}, not ${skill}`);
  }
  return parsed.data;
}

/** Skills with a scenario directory under `evals/`. */
export function skillsWithEvals(root: string, evalsDir = "evals"): string[] {
  const dir = join(root, evalsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !["baselines", "degraded"].includes(d.name))
    .filter((d) => readdirSync(join(dir, d.name)).some((n) => /\.ya?ml$/.test(n)))
    .map((d) => d.name)
    .sort();
}
