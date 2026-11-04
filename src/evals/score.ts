import type { DeterministicCriterion } from "./schema.js";

/** Pure scoring of the deterministic criteria. No model is asked anything here. */

export interface CriterionResult {
  id: string;
  pass: boolean;
  /** What was seen, short enough for a table cell. */
  detail: string;
}

/** Fenced code is the agent's example, not its words: questions and phrases inside it don't count. */
export function prose(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, " ");
}

/**
 * The questions in a reply: each run of text ending in "?" (after optional closing marks), split
 * at sentence ends and line breaks. Rough on purpose; criteria using it give generous bounds.
 */
export function questions(text: string): string[] {
  const out: string[] = [];
  for (const line of prose(text).split("\n")) {
    const re = /[^.!?\n]*\?+["'”’)*_\]]*/g;
    for (const match of line.matchAll(re)) {
      const q = match[0]
        .replace(/\*\*|__/g, "")
        .replace(/^[\s*_>#\-\d.)]+/, "")
        .trim();
      if (q.length > 1) out.push(q);
    }
  }
  return out;
}

/**
 * The asked questions: numbered items ("1. ...", "**2.** ...") that contain a "?", each item running
 * to the next numbered item or heading. A sub-question inside an item is part of that one question.
 * A reply with no numbered question falls back to its plain questions.
 */
export function askedQuestions(text: string): string[] {
  const items: string[] = [];
  let current: string[] | undefined;
  for (const line of prose(text).split("\n")) {
    if (/^\s*(\*\*)?\d+[.)]/.test(line)) {
      if (current) items.push(current.join("\n"));
      current = [line];
    } else if (/^\s*#/.test(line)) {
      if (current) items.push(current.join("\n"));
      current = undefined;
    } else current?.push(line);
  }
  if (current) items.push(current.join("\n"));
  const asked = items
    .filter((item) => item.includes("?"))
    .map((item) => item.replace(/\*\*|__/g, "").trim());
  return asked.length > 0 ? asked : questions(text);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

const re = (p: string) => new RegExp(p, "im");
const reAll = (p: string) => new RegExp(p, "gim");

function firstMatch(text: string, pattern: string): number {
  const m = re(pattern).exec(text);
  return m ? m.index : -1;
}

function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function scoreCriterion(c: DeterministicCriterion, reply: string): CriterionResult {
  // Commands live in code fences, so phrases are matched on the whole reply; only questions skip code.
  const text = reply;
  switch (c.kind) {
    case "includes": {
      if (c.all) {
        const missing = c.all.filter((p) => !re(p).test(text));
        return {
          id: c.id,
          pass: missing.length === 0,
          detail: missing.length === 0 ? "all present" : `missing /${missing.join("/, /")}/`,
        };
      }
      const hit = (c.any ?? []).map((p) => re(p).exec(text)).find(Boolean);
      return {
        id: c.id,
        pass: Boolean(hit),
        detail: hit ? `found "${clip(hit[0], 40)}"` : "none found",
      };
    }
    case "excludes": {
      const hit = c.any.map((p) => re(p).exec(text)).find(Boolean);
      return { id: c.id, pass: !hit, detail: hit ? `found "${clip(hit[0], 40)}"` : "none found" };
    }
    case "count": {
      const n =
        c.of === "questions"
          ? questions(reply).length
          : c.of === "asked-questions"
            ? askedQuestions(reply).length
            : [...text.matchAll(reAll(c.of.pattern))].length;
      const pass = (c.min === undefined || n >= c.min) && (c.max === undefined || n <= c.max);
      const bounds = `${c.min ?? 0}..${c.max ?? "∞"}`;
      return { id: c.id, pass, detail: `${n} (want ${bounds})` };
    }
    case "last-question": {
      const last = (c.of === "asked-questions" ? askedQuestions(reply) : questions(reply)).at(-1);
      if (!last) return { id: c.id, pass: false, detail: "no question" };
      return { id: c.id, pass: re(c.pattern).test(last), detail: `last: "${clip(last, 60)}"` };
    }
    case "order": {
      const a = firstMatch(text, c.first);
      const b = firstMatch(text, c.later);
      const pass = a >= 0 && b >= 0 && a < b;
      return {
        id: c.id,
        pass,
        detail:
          a < 0
            ? "first not found"
            : b < 0
              ? "later not found"
              : pass
                ? "in order"
                : "out of order",
      };
    }
    case "max-words": {
      const n = wordCount(text);
      return { id: c.id, pass: n <= c.max, detail: `${n} words (max ${c.max})` };
    }
  }
}
