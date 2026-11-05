import { z } from "zod";

const outcome = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fixed"), note: z.string().optional() }),
  z.strictObject({ kind: z.literal("declined"), reason: z.string().min(1, "say why") }),
  z.strictObject({ kind: z.literal("disputed"), reason: z.string().min(1, "say why") }),
]);

const reply = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reply"), text: z.string() }),
  z.strictObject({ kind: z.literal("timeout"), seconds: z.number().nonnegative().optional() }),
  z.strictObject({ kind: z.literal("error"), message: z.string().min(1) }),
]);

/** A review run on disk: who reviewed, the change tags, and each round's reply and outcomes. */
export const reviewInputSchema = z.strictObject({
  reviewer: z.string().min(1),
  tags: z.array(z.string()).optional(),
  rounds: z.array(z.strictObject({ reply, outcomes: z.record(z.string(), outcome).optional() })),
});

export type ReviewInput = z.output<typeof reviewInputSchema>;
