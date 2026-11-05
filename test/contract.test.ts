import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("agent copies of the repo are never checked as if they were the repo", () => {
  it("vitest skips .claude/ (agent worktrees live in .claude/worktrees)", () => {
    expect(vitestConfig.test?.exclude).toContain(".claude/**");
  });

  it("biome skips .claude/, so a nested biome.json there cannot stop lint", () => {
    const biome = JSON.parse(read("biome.json"));
    expect(biome.files.includes).toContain("!.claude");
  });
});

describe("AGENTS.md", () => {
  it("counts a check only by its exit code", () => {
    expect(read("AGENTS.md")).toMatch(
      /A check passes only when its exit code is 0, shown with the run\. Blank output is not a pass\./,
    );
  });
});

describe("build skill, spec runs", () => {
  it("has each ticket attacked by a reviewer before it merges into the integration branch", () => {
    const build = read("skills/build/SKILL.md");
    expect(build).toMatch(/\*\*Attack each ticket before it merges in\.\*\*/);
    expect(build).toMatch(/hostile input/);
  });
});
