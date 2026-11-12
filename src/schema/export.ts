import { z } from "zod";
import { configSchema } from "../config/schema.js";
import { receiptsSchema } from "../receipts/schema.js";

/** JSON Schemas published for other tools (editors, CI, other kits) to consume. */
export function exportSchemas(): Record<string, unknown> {
  return {
    "istack.schema.json": z.toJSONSchema(configSchema, { io: "input" }),
    "receipts.schema.json": z.toJSONSchema(receiptsSchema, { io: "input" }),
  };
}
