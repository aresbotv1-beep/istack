import { describe, expect, it } from "vitest";
import { parseReply, REPLY_FORMAT } from "../src/review/parse.js";

describe("parseReply", () => {
  it("reads the verdict line and every finding with its id and severity", () => {
    const reply = [
      "Looked at the diff.",
      "VERDICT: CHANGES",
      "S1 [blocker] The retry loop never ends when the server returns 500.",
      "- S2 [should]: the timeout is read in seconds but passed as ms",
      "S3 [nit] rename `x` to `count`",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed).toEqual({
      ok: true,
      verdict: "CHANGES",
      findings: [
        {
          id: "S1",
          severity: "blocker",
          text: "The retry loop never ends when the server returns 500.",
        },
        { id: "S2", severity: "should", text: "the timeout is read in seconds but passed as ms" },
        { id: "S3", severity: "nit", text: "rename `x` to `count`" },
      ],
      warnings: [],
    });
  });

  it("accepts an approval with no findings", () => {
    expect(parseReply("VERDICT: APPROVE\n")).toMatchObject({
      ok: true,
      verdict: "APPROVE",
      findings: [],
    });
  });

  it("rejects a reply with no verdict line", () => {
    const parsed = parseReply("Looks good to me!\nS1 [nit] typo");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/no VERDICT line/);
  });

  it("rejects a reply whose verdict lines disagree", () => {
    const parsed = parseReply("VERDICT: APPROVE\nVERDICT: CHANGES");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/disagree/);
  });

  it("keeps the first of two findings that share an id and warns", () => {
    const parsed = parseReply("VERDICT: CHANGES\nS1 [should] first\nS1 [nit] second");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.findings).toEqual([{ id: "S1", severity: "should", text: "first" }]);
    expect(parsed.warnings).toEqual(["finding S1 appears twice; kept the first"]);
  });

  it("documents the format it parses", () => {
    expect(REPLY_FORMAT).toContain("VERDICT: APPROVE");
    expect(REPLY_FORMAT).toContain("[blocker]");
    const example = REPLY_FORMAT.split("\n")
      .filter((l) => l.startsWith("VERDICT: CHANGES") || /^S\d/.test(l))
      .join("\n");
    expect(parseReply(example).ok).toBe(true);
  });
});
