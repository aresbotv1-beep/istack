import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";

const example = readFileSync(new URL("../istack.yaml.example", import.meta.url), "utf8");

describe("loadConfig", () => {
  it("accepts the shipped example config", () => {
    const result = loadConfig(example);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.profile).toBe("team");
      expect(result.config.checks.length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown profile and names the field", () => {
    const result = loadConfig(example.replace("profile: team", "profile: tem"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("profile");
      expect(result.errors[0]?.message).toMatch(/solo.*team.*factory/);
    }
  });

  it("rejects a misspelled top-level key instead of ignoring it", () => {
    const result = loadConfig(`${example}\nprofle: solo\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.message.includes("profle"))).toBe(true);
  });

  it("reports YAML syntax errors with a line number", () => {
    const result = loadConfig("version: 1\nowner: [unclosed\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/line \d+/);
  });

  it("applies defaults for optional sections", () => {
    const result = loadConfig(
      "version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: test\n    run: npm test\n",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.visibleChange.include.length).toBeGreaterThan(0);
      expect(result.config.ownershipGates).toEqual([]);
      expect(result.config.council.enabled).toBe(false);
    }
  });

  it("defaults the env section and validates port names used by env files", () => {
    const base =
      "version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: test\n    run: npm test\n";
    const plain = loadConfig(base);
    expect(plain.ok && plain.config.env.ports).toEqual({ from: 4100, to: 4999, names: ["web"] });
    const bad = loadConfig(
      `${base}env:\n  files:\n    - path: .env.local\n      set:\n        PORT: "{{nope}}"\n`,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]?.path).toBe("env.files.0.set.PORT");
    if (example.includes("env:")) {
      const shipped = loadConfig(example);
      expect(shipped.ok && shipped.config.env.files.length).toBeGreaterThan(0);
    } else {
      expect.fail("istack.yaml.example should show an env section");
    }
  });

  it("refuses council in the solo profile", () => {
    const result = loadConfig(
      "version: 1\nowner: Sam\nprofile: solo\nchecks:\n  - name: test\n    run: npm test\ncouncil:\n  enabled: true\n  budgetUsdPerPr: 5\n",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe("council.enabled");
  });
});
