import { z } from "zod";

/**
 * A skill eval scenario: one owner message, the files the agent would have read, and a rubric of
 * checkable criteria. Deterministic criteria are the default and the score; taste criteria are
 * scored by the council with a control, and only when asked for (`--taste`).
 */

const pattern = z.string().min(1);
const weight = z.number().positive().default(1);

const base = {
  id: z.string().regex(/^[a-z0-9-]+$/, "lower-case letters, digits and dashes"),
  /** What the criterion rewards, in one plain sentence. Shown next to a failure. */
  why: z.string().min(1),
  weight,
};

/**
 * Passes when the reply matches any (or, with `all`, every) pattern. Every pattern in a scenario is
 * a case-insensitive, multi-line regex.
 */
const includes = z.strictObject({
  ...base,
  kind: z.literal("includes"),
  any: z.array(pattern).min(1).optional(),
  all: z.array(pattern).min(1).optional(),
});

/** Passes when the reply matches none of the patterns. */
const excludes = z.strictObject({
  ...base,
  kind: z.literal("excludes"),
  any: z.array(pattern).min(1),
});

/**
 * "questions": every sentence ending in "?". "asked-questions": the numbered questions the agent
 * asks, a sub-question counting as part of its item (plain questions when none are numbered).
 */
const questionKind = z.enum(["questions", "asked-questions"]);

/** Counts questions or matches of a pattern; passes inside [min, max]. */
const count = z.strictObject({
  ...base,
  kind: z.literal("count"),
  of: z.union([questionKind, z.strictObject({ pattern })]),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
});

/** Passes when the last question in the reply matches the pattern. No question: fails. */
const lastQuestion = z.strictObject({
  ...base,
  kind: z.literal("last-question"),
  of: questionKind.default("questions"),
  pattern,
});

/** Passes when the first match of `first` comes before the first match of `later`. */
const order = z.strictObject({ ...base, kind: z.literal("order"), first: pattern, later: pattern });

/** Passes when the reply has at most this many words. */
const maxWords = z.strictObject({
  ...base,
  kind: z.literal("max-words"),
  max: z.number().int().positive(),
});

export const deterministicCriterionSchema = z.discriminatedUnion("kind", [
  includes,
  excludes,
  count,
  lastQuestion,
  order,
  maxWords,
]);
export type DeterministicCriterion = z.output<typeof deterministicCriterionSchema>;

/**
 * A taste criterion: judges score the reply and a fixed control reply on the rubric, never told
 * which is which. The control catches a judge drifting; its band is learned once per council log.
 */
export const tasteCriterionSchema = z.strictObject({
  ...base,
  kind: z.literal("taste"),
  rubric: z.string().min(1),
  /** A committed reference reply. It never changes, so its score shows judge drift. */
  control: z.string().min(1),
});
export type TasteCriterion = z.output<typeof tasteCriterionSchema>;

export const criterionSchema = z.union([deterministicCriterionSchema, tasteCriterionSchema]);
export type Criterion = z.output<typeof criterionSchema>;

export const scenarioSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/, "lower-case letters, digits and dashes"),
    skill: z.string().min(1),
    title: z.string().min(1),
    /** Why this scenario exists: the behavior of the skill it pins. */
    purpose: z.string().min(1),
    /** The owner's message, as they would type it. */
    prompt: z.string().min(1),
    /** Files the agent would have read before replying. Given inline; the agent has no tools. */
    context: z.array(z.strictObject({ path: z.string().min(1), text: z.string() })).default([]),
    criteria: z.array(criterionSchema).min(1),
  })
  .superRefine((scenario, ctx) => {
    const ids = new Set<string>();
    scenario.criteria.forEach((c, i) => {
      if (ids.has(c.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria", i, "id"],
          message: `duplicate id ${c.id}`,
        });
      }
      ids.add(c.id);
      if (c.kind === "includes" && !c.any === !c.all) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria", i],
          message: "give exactly one of any or all",
        });
      }
      if (c.kind === "count" && c.min === undefined && c.max === undefined) {
        ctx.addIssue({ code: "custom", path: ["criteria", i], message: "give min, max or both" });
      }
      for (const p of patternsOf(c)) {
        try {
          new RegExp(p, "i");
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            path: ["criteria", i],
            message: `bad pattern ${p}: ${(error as Error).message}`,
          });
        }
      }
    });
    if (!scenario.criteria.some((c) => c.kind !== "taste")) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "needs at least one deterministic criterion: taste alone is opt-in",
      });
    }
  });
export type Scenario = z.output<typeof scenarioSchema>;

function patternsOf(c: Criterion): string[] {
  switch (c.kind) {
    case "includes":
      return [...(c.any ?? []), ...(c.all ?? [])];
    case "excludes":
      return c.any;
    case "count":
      return typeof c.of === "string" ? [] : [c.of.pattern];
    case "last-question":
      return [c.pattern];
    case "order":
      return [c.first, c.later];
    default:
      return [];
  }
}

/** How a skill is made worse on purpose, to prove the evals can see it. Applied in memory. */
export const degradeSchema = z.strictObject({
  skill: z.string().min(1),
  description: z.string().min(1),
  /** Files under the skill's directory to drop entirely, e.g. "express.md". */
  removeFiles: z.array(z.string().min(1)).default([]),
  /** Markdown headings (the whole line, e.g. "## Pick the lane") whose sections are deleted. */
  removeSections: z.array(z.string().min(1)).default([]),
  /** Lines matching any of these (case-insensitive) are deleted. */
  removeLines: z.array(pattern).default([]),
});
export type Degrade = z.output<typeof degradeSchema>;

const runsArray = z.array(z.number());

/** The committed score for one skill. Never written by hand. */
export const baselineSchema = z.strictObject({
  version: z.literal(1),
  skill: z.string(),
  /** sha256 over the skill's files as scored. */
  skillHash: z.string(),
  /** sha256 over the skill's scenario files. A changed scenario set needs a new baseline. */
  scenariosHash: z.string(),
  producedBy: z.strictObject({
    runner: z.string(),
    provider: z.string(),
    /** The model the runner reported, or "unknown". */
    model: z.string(),
    runs: z.number().int().positive(),
    date: z.string(),
    mode: z.enum(["deterministic", "council"]),
    costUsd: z.number().min(0),
    costSource: z.enum(["measured", "estimated", "mixed"]),
  }),
  /** Median over runs of the per-run skill score, 0–100. */
  score: z.number(),
  /** One skill score per run: the mean of the scenario scores in that run. */
  runScores: runsArray,
  noise: z.strictObject({ floor: z.number().min(0), k: z.number().min(0) }),
  scenarios: z.record(
    z.string(),
    z.strictObject({
      median: z.number(),
      runs: runsArray,
      /** Criterion id → how many runs passed it. */
      passes: z.record(z.string(), z.number().int().min(0)),
    }),
  ),
});
export type Baseline = z.output<typeof baselineSchema>;
