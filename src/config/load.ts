import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { type FieldError, toFieldErrors } from "../result.js";
import { configSchema, type IstackConfig } from "./schema.js";

export type LoadConfigResult =
  | { ok: true; config: IstackConfig }
  | { ok: false; errors: FieldError[] };

/**
 * The project was called mitchstack. A repo still holding only the old config file gets told to
 * rename it, instead of being silently run with defaults. Null when there is nothing to say.
 */
export const OLD_CONFIG =
  "found mitchstack.yaml — rename it to istack.yaml (mitchstack is now istack)";

export function oldConfigProblem(dir: string): string | null {
  if (existsSync(join(dir, "istack.yaml")) || !existsSync(join(dir, "mitchstack.yaml")))
    return null;
  return `${OLD_CONFIG} in ${dir}`;
}

/** Parse and validate the text of an istack.yaml. Never throws. */
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
