import { mkdirSync, writeFileSync } from "node:fs";
import { exportSchemas } from "../dist/src/schema/export.js";

mkdirSync("schema", { recursive: true });
for (const [name, schema] of Object.entries(exportSchemas())) {
  writeFileSync(`schema/${name}`, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schema/${name}`);
}
