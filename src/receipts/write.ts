import { type FieldError, toFieldErrors } from "../result.js";
import { type Receipts, receiptsSchema } from "./schema.js";

export type WriteResult =
  | { ok: true; block: string; receipts: Receipts }
  | { ok: false; errors: FieldError[] };

/**
 * Build the one fenced ```receipts block for a PR body from claims ({ head, door, claims, ... }).
 * `version` defaults to 1. The result is validated against the receipts schema before it is
 * returned, so a block this function hands back always passes `extractReceipts`. Never throws.
 */
export function writeReceipts(input: unknown): WriteResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "", message: "claims must be a JSON object" }] };
  }
  const parsed = receiptsSchema.safeParse({ version: 1, ...input });
  if (!parsed.success) return { ok: false, errors: toFieldErrors(parsed.error.issues) };
  return { ok: true, block: fence(parsed.data), receipts: parsed.data };
}

function fence(receipts: Receipts): string {
  return `\`\`\`receipts\n${JSON.stringify(receipts, null, 2)}\n\`\`\``;
}
