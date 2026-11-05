import { type FieldError, toFieldErrors } from "../result.js";
import { type Receipts, receiptsSchema } from "./schema.js";

export type ExtractResult =
  | { ok: true; receipts: Receipts }
  | { ok: false; reason: "missing" | "duplicate" | "invalid"; errors: FieldError[] };

const FENCE = /^```receipts[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/** Find the single ```receipts fenced JSON block in a PR body and validate it. Never throws. */
export function extractReceipts(body: string): ExtractResult {
  const blocks = [...body.matchAll(FENCE)].map((m) => m[1] ?? "");
  if (blocks.length === 0) {
    return {
      ok: false,
      reason: "missing",
      errors: [{ path: "", message: "no ```receipts block in the PR body" }],
    };
  }
  if (blocks.length > 1) {
    return {
      ok: false,
      reason: "duplicate",
      errors: [{ path: "", message: `found ${blocks.length} receipts blocks; keep one` }],
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(blocks[0] as string);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid",
      errors: [
        { path: "", message: `receipts block is not valid JSON: ${(error as Error).message}` },
      ],
    };
  }
  const parsed = receiptsSchema.safeParse(json);
  if (!parsed.success)
    return { ok: false, reason: "invalid", errors: toFieldErrors(parsed.error.issues) };
  return { ok: true, receipts: parsed.data };
}
