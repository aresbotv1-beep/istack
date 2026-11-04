import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportSchemas } from "../src/schema/export.js";

describe("published JSON schemas", () => {
  it("match the committed files (run `npm run schema` after changing a schema)", () => {
    for (const [name, schema] of Object.entries(exportSchemas())) {
      const committed = JSON.parse(
        readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8"),
      );
      expect(committed, name).toEqual(schema);
    }
  });
});
