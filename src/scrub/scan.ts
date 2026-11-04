import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Terms from the private workflow mitchstack was extracted from. Shipped files must be generic:
 * owners, ports and repos come from the user's mitchstack.yaml, never from the kit itself.
 */
const PRIVATE_TERMS: ReadonlyArray<{ term: string; pattern: RegExp }> = [
  ...[
    "Isaac",
    "Ben",
    "Jess",
    "Eddie",
    "BuilderWrx",
    "Builderwrx",
    "Kestrel",
    "Peregrine",
    "Osprey",
    "BWX",
    "LOCAL-WORLD",
    "Black Label",
  ].map((term) => ({ term, pattern: new RegExp(`\\b${term}\\b`, "g") })),
  { term: "home path", pattern: /\/Users\/[a-z0-9._-]+/g },
  {
    term: "simulator UDID",
    pattern: /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/g,
  },
];

/** Everything that ships to users. Planning records under docs/ and the scanner itself are excluded. */
const SHIPPED = [
  "AGENTS.md",
  "skills",
  "templates",
  "schema",
  "bin",
  "src",
  "mitchstack.yaml.example",
  "evals",
];
const EXCLUDED = new Set(["src/scrub/scan.ts"]);

export interface PrivateHit {
  file: string;
  line: number;
  term: string;
}

export function findPrivateTerms(file: string, text: string): PrivateHit[] {
  const hits: PrivateHit[] = [];
  text.split("\n").forEach((line, index) => {
    for (const { term, pattern } of PRIVATE_TERMS) {
      if (line.match(pattern)) hits.push({ file, line: index + 1, term });
    }
  });
  return hits;
}

function walk(path: string): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

export function scanShippedFiles(root: string): PrivateHit[] {
  return SHIPPED.flatMap((entry) => walk(join(root, entry)))
    .map((file) => relative(root, file))
    .filter((file) => !EXCLUDED.has(file))
    .flatMap((file) => findPrivateTerms(file, readFileSync(join(root, file), "utf8")));
}
