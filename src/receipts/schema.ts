import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{7,40}$/, "must be a git commit SHA");

const image = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest of the image"),
  url: z.url(),
});

const visualClaim = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("visual"),
  statement: z.string().min(1),
  surface: z.string().min(1).describe("the URL or screen the pictures were taken on"),
  before: z.union([z.literal("absent"), image]).describe("'absent' only for a brand-new screen"),
  after: image,
});

const redGreenClaim = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("red-green"),
  statement: z.string().min(1),
  command: z.string().min(1),
  red: z.strictObject({
    sha,
    exitCode: z
      .number()
      .int()
      .refine((code) => code !== 0, "the red run must have failed (non-zero exit)"),
  }),
  green: z.strictObject({ sha, exitCode: z.literal(0, { error: "the green run must exit 0" }) }),
});

const outputClaim = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("output"),
  statement: z.string().min(1),
  command: z.string().min(1),
  before: z.string(),
  after: z.string(),
});

export const receiptsSchema = z.strictObject({
  version: z.literal(1),
  head: sha.describe("the PR head commit these receipts were produced against"),
  door: z.strictObject({
    kind: z.enum(["one-way", "two-way"]),
    blastRadius: z.string().min(1, "say what could be affected if this is wrong"),
  }),
  claims: z.array(z.discriminatedUnion("kind", [visualClaim, redGreenClaim, outputClaim])),
  noVisibleChange: z.string().min(1, "give the reason there is no visible change").optional(),
});

export type Receipts = z.output<typeof receiptsSchema>;
