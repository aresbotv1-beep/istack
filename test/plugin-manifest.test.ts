import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const KIT = new URL("..", import.meta.url).pathname;
const read = (path: string) => JSON.parse(readFileSync(join(KIT, path), "utf8"));

describe("Claude Code plugin + npx skills layout", () => {
  it("plugin.json names the plugin mitchstack at the package version", () => {
    const plugin = read(".claude-plugin/plugin.json");
    const pkg = read("package.json");
    expect(plugin.name).toBe("mitchstack");
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe("MIT");
    // skills/ is the default scan; declaring it again would load every skill twice.
    expect(plugin.skills).toBeUndefined();
  });

  it("marketplace.json lists the plugin at the repo root under the same name", () => {
    const market = read(".claude-plugin/marketplace.json");
    expect(market.name).toBe("mitchstack");
    expect(market.owner.name).toBeTruthy();
    expect(market.plugins).toEqual([expect.objectContaining({ name: "mitchstack", source: "./" })]);
  });

  it("every skill folder holds a SKILL.md whose name matches the folder (Cursor, npx skills)", () => {
    for (const dir of readdirSync(join(KIT, "skills"))) {
      const text = readFileSync(join(KIT, "skills", dir, "SKILL.md"), "utf8");
      const name = text.match(/^---\nname: (.+)\n/)?.[1];
      expect(name, dir).toBe(dir);
      expect(dir).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(text).toMatch(/\ndescription: .+\n/);
    }
  });

  it("ships the hook template and plugin manifest in the npm package", () => {
    const pkg = read("package.json");
    expect(pkg.files).toEqual(expect.arrayContaining([".claude-plugin", "hooks"]));
    expect(existsSync(join(KIT, "hooks/pre-push.sh"))).toBe(true);
  });
});
