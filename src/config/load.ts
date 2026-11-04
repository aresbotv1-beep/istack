import { parseDocument } from "yaml";
import { type FieldError, toFieldErrors } from "../result.js";
import { configSchema, type MitchstackConfig } from "./schema.js";

export type LoadConfigResult =
  | { ok: true; config: MitchstackConfig }
  | { ok: false; errors: FieldError[] };

/** Parse and validate the text of a mitchstack.yaml. Never throws. */
export function loadConfig(text: string): LoadConfigResult {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => ({
        path: "",
        message: `YAML syntax error at line ${e.linePos?.[0]?.line ?? "?"}: ${e.message.split("\n")[0]}`,
      })),
    };
  }
  const parsed = configSchema.safeParse(doc.toJS());
  if (!parsed.success) return { ok: false, errors: toFieldErrors(parsed.error.issues) };
  return { ok: true, config: parsed.data };
}
