import { z } from "zod";

/** The pictures a judge scores. The judge never learns which is which. */
export const ROLES = ["before", "after", "control"] as const;
export type Role = (typeof ROLES)[number];

const score = z.number().min(0).max(10);
const roleScores = z.strictObject({
  before: score.optional(),
  after: score,
  control: score,
});

const band = z.strictObject({
  center: z.number(),
  halfWidth: z.number(),
  low: z.number(),
  high: z.number(),
  samples: z.array(score),
  k: z.number(),
  minHalfWidth: z.number(),
});

const sample = z.strictObject({
  phase: z.enum(["baseline", "round"]),
  /** Presentation order as the judge saw it: order[0] was "Picture 1". */
  order: z.array(z.enum(ROLES)),
  /** Absent when the judge failed or its reply could not be read. */
  scores: roleScores.optional(),
  error: z.string().optional(),
  costUsd: z.number().min(0),
  /** "measured" when the judge reported what the call cost, else the price-table estimate. */
  costSource: z.enum(["measured", "estimated"]),
});

const judgeRound = z.strictObject({
  judge: z.string(),
  provider: z.string(),
  samples: z.array(sample),
  /** Median of the round samples, per picture. Absent when fewer than the required samples. */
  median: roleScores.optional(),
  /** null when the judge has no band or no control median to compare. */
  controlInBand: z.boolean().nullable(),
  note: z.string().optional(),
});

const round = z.strictObject({
  number: z.number().int().positive(),
  head: z.string(),
  at: z.string(),
  seed: z.number().int(),
  /** Visible files that triggered this round. */
  visibleFiles: z.array(z.string()),
  status: z.enum(["kept", "discarded", "budget"]),
  reason: z.string(),
  judges: z.array(judgeRound),
  costUsd: z.number().min(0),
  /**
   * How far past the budget this round's last call took the log. The budget is checked before
   * each call on estimates and measured spend, so one call can still report more than was left.
   */
  overrunUsd: z.number().positive().optional(),
});

export const councilLogSchema = z.strictObject({
  version: z.literal(1),
  budgetUsd: z.number().positive(),
  spentUsd: z.number().min(0),
  /** Each judge's control band, learned once and never relearned or widened. */
  bands: z.record(z.string(), band),
  rounds: z.array(round),
});

export type CouncilLog = z.output<typeof councilLogSchema>;
export type CouncilRound = CouncilLog["rounds"][number];
export type JudgeRound = CouncilRound["judges"][number];
export type Sample = JudgeRound["samples"][number];
export type RoleScores = z.output<typeof roleScores>;
