import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * Terms from the private workflow mitchstack was extracted from. Shipped files must be generic:
 * owners, ports and repos come from the user's mitchstack.yaml, never from the kit itself.
 *
 * The terms themselves are private, so only the SHA-256 of each normalised term ships (see
 * `normaliseTerm`). The scan hashes every word, hyphen part and 2-3 word phrase of a file and
 * looks the hash up here. To add a term, append `sha256(normaliseTerm(term))`.
 */
const PRIVATE_TERM_HASHES: ReadonlySet<string> = new Set([
  "1fd6227a465211891ddf2da7cd8b8f143097d5ebefa804e65afe3724ee127a20",
  "6700869c8ff7480e34a70a708b028700dbaa3a033b5652b903afe89f49a31456",
  "00f2e65596ab8c1915dc21331298a28a711a8212d873c5913d45b672c47f6e7d",
  "3b9d8298f1b5086d012618feebb2da1a394357c1dab7523443c9f6a743c4c84d",
  "85afbc3ba8e4b7b26ad1d16b658adc665c3c25cca5e201a95b4a06a8167d6dd3",
  "07f15cde5b181425db8524becd96263d600c9652c7de5b89fe1a644f8fd0724b",
  "48bcfd4617c9cce391fef80949ffde546c8b7ae4d626236c707ea97ac94dfdae",
  "ba6a65698d97b04861de63a9d0a2e5a562e0a572dad90fd523ae1f147ba21ab2",
  "b8104c6e90f3513820ccd21a0778317e867a7509a0617ed6491c8fcc802d2636",
  "6c1a826fc4d890af486e8db5f93cd1f7326e3383c2ba2dbe513119a47b028b98",
  "e9b3fde0b6021cb8cdca0d60246a243e3f3f339d7c0d86988b0e739d17ca49ae",
]);

/** Generic patterns that are not private in themselves, so they stay readable. */
const PRIVATE_PATTERNS: ReadonlyArray<{ term: string; pattern: RegExp }> = [
  { term: "home path", pattern: /\/Users\/[a-z0-9._-]+/g },
  {
    term: "simulator UDID",
    pattern: /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/g,
  },
];

/** Lowercase, whitespace collapsed to one space: the form that is hashed. */
export function normaliseTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hashTerm(term: string): string {
  return createHash("sha256").update(normaliseTerm(term)).digest("hex");
}

/** A word, hyphens kept inside it (so "a-b" is one token and also its parts). */
const WORD = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;
const MAX_PHRASE = 3;

/** Every candidate in a line: words, hyphen parts, and 2-3 word phrases, with the text matched. */
function candidates(line: string): string[] {
  const words = [...line.matchAll(WORD)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
  const out: string[] = [];
  words.forEach((word, i) => {
    out.push(word.text);
    if (word.text.includes("-")) out.push(...word.text.split("-"));
    for (let n = 2; n <= MAX_PHRASE && i + n <= words.length; n++) {
      out.push(line.slice(word.start, (words[i + n - 1] as { end: number }).end));
    }
  });
  return out;
}

/** Everything outside docs/ (planning records) is scanned, shipped or not. */
const SCANNED = [
  "AGENTS.md",
  "CREDITS.md",
  "README.md",
  "package.json",
  "mitchstack.yaml.example",
  "skills",
  "templates",
  "schema",
  "bin",
  "src",
  "hooks",
  "scripts",
  "action",
  "evals",
  "test",
  ".github",
  ".claude-plugin",
];

/**
 * Files allowed to name a private term, with the reason. LICENSE carries the author's name on
 * purpose: public attribution is what an MIT licence is for.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([["LICENSE", "author attribution"]]);

const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2"]);

export interface PrivateHit {
  file: string;
  line: number;
  /** The text as it appears in the file (for a hashed term), or the pattern's name. */
  term: string;
}

export function findPrivateTerms(file: string, text: string): PrivateHit[] {
  const hits: PrivateHit[] = [];
  text.split("\n").forEach((line, index) => {
    const seen = new Set<string>();
    for (const candidate of candidates(line)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (PRIVATE_TERM_HASHES.has(hashTerm(candidate))) {
        hits.push({ file, line: index + 1, term: candidate });
      }
    }
    for (const { term, pattern } of PRIVATE_PATTERNS) {
      if (line.match(pattern)) hits.push({ file, line: index + 1, term });
    }
  });
  return hits;
}

function walk(path: string): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) =>
    entry === "node_modules" ? [] : walk(join(path, entry)),
  );
}

/** Scan the given repo-relative files (e.g. the list `npm pack` would publish). */
export function scanFiles(root: string, files: string[]): PrivateHit[] {
  return files
    .filter((file) => !ALLOWED.has(file.split(sep).join("/")))
    .filter((file) => !BINARY.has(extname(file).toLowerCase()))
    .flatMap((file) => findPrivateTerms(file, readFileSync(join(root, file), "utf8")));
}

export function scanShippedFiles(root: string): PrivateHit[] {
  const files = SCANNED.flatMap((entry) => walk(join(root, entry))).map((file) =>
    relative(root, file),
  );
  return scanFiles(root, files);
}
