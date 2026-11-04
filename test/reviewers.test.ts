import { describe, expect, it } from "vitest";
import { chooseReviewer, SAME_PROVIDER_LABEL } from "../src/review/reviewers.js";

const has =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name);

describe("chooseReviewer", () => {
  it("prefers the harness's delegate_task when it reaches another provider", () => {
    const choice = chooseReviewer({
      builderProvider: "anthropic",
      probe: { hasCommand: has("codex", "claude"), delegateTaskProviders: ["anthropic", "openai"] },
    });
    expect(choice).toMatchObject({
      kind: "cross-provider",
      via: "delegate_task",
      provider: "openai",
    });
  });

  it("skips delegate_task when it only reaches the builder's own provider", () => {
    const choice = chooseReviewer({
      builderProvider: "anthropic",
      probe: { hasCommand: has("codex"), delegateTaskProviders: ["anthropic"] },
    });
    expect(choice).toMatchObject({ kind: "cross-provider", via: "codex exec", provider: "openai" });
    expect(choice.argv).toEqual(["codex", "exec"]);
  });

  it("falls through codex exec, claude -p, cursor-agent in order, skipping the builder's own", () => {
    expect(
      chooseReviewer({ builderProvider: "openai", probe: { hasCommand: has("codex", "claude") } }),
    ).toMatchObject({ via: "claude -p", provider: "anthropic", argv: ["claude", "-p"] });
    expect(
      chooseReviewer({
        builderProvider: "anthropic",
        probe: { hasCommand: has("claude", "cursor-agent") },
      }),
    ).toMatchObject({ via: "cursor-agent", provider: "cursor", argv: ["cursor-agent", "-p"] });
  });

  it("labels a same-provider fresh-context reviewer when no second provider exists", () => {
    const viaCli = chooseReviewer({
      builderProvider: "anthropic",
      probe: { hasCommand: has("claude") },
    });
    expect(viaCli).toEqual({
      kind: "same-provider",
      via: "claude -p",
      provider: "anthropic",
      argv: ["claude", "-p"],
      label: SAME_PROVIDER_LABEL,
    });
    expect(SAME_PROVIDER_LABEL).toBe("same-provider reviewer (no second provider available)");
    const bare = chooseReviewer({ builderProvider: "anthropic", probe: { hasCommand: has() } });
    expect(bare).toMatchObject({
      kind: "same-provider",
      via: "fresh-context subagent",
      label: SAME_PROVIDER_LABEL,
    });
  });

  it("matches the builder's provider case-insensitively", () => {
    const choice = chooseReviewer({
      builderProvider: "OpenAI",
      probe: { hasCommand: has("codex") },
    });
    expect(choice.kind).toBe("same-provider");
  });

  it("names the reviewer and its provider in the cross-provider label", () => {
    const choice = chooseReviewer({
      builderProvider: "anthropic",
      probe: { hasCommand: has("codex") },
    });
    expect(choice.label).toBe("codex exec (openai)");
  });
});
