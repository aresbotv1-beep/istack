export type Severity = "blocker" | "should" | "nit";

export interface Finding {
  /** Stable across rounds: the reviewer reuses S1 when it raises the same point again. */
  id: string;
  severity: Severity;
  text: string;
}

export type ParsedReply =
  | { ok: true; verdict: "APPROVE" | "CHANGES"; findings: Finding[]; warnings: string[] }
  | { ok: false; reason: string };

/** The reply format a reviewer is asked to use. Paste it into the reviewer's prompt verbatim. */
export const REPLY_FORMAT = [
  "Reply in exactly this format. One verdict line, then one line per finding:",
  "",
  "VERDICT: CHANGES",
  "S1 [blocker] what is wrong, where, and the command that shows it",
  "S2 [should] a real bug that is not the intended case",
  "S3 [nit] everything else",
  "",
  "Use VERDICT: APPROVE only when nothing blocker or should is left.",
  "Severity: blocker = the intended case is wrong; should = a real bug; nit = everything else.",
  "Keep an id for the same point across rounds; never reuse an id for a new point.",
].join("\n");

const VERDICT = /^\s*VERDICT:\s*(APPROVE|CHANGES)\b/;
const FINDING = /^\s*(?:[-*]\s+)?([A-Z]{1,3}\d+)\s+\[(blocker|should|nit)\]\s*:?\s*(.+?)\s*$/i;

/** Parse one reviewer reply. Never throws; a reply without exactly one verdict is not an answer. */
export function parseReply(text: string): ParsedReply {
  const lines = text.split(/\r?\n/);
  const verdicts = new Set<"APPROVE" | "CHANGES">();
  const findings: Finding[] = [];
  const warnings: string[] = [];
  for (const line of lines) {
    const verdict = VERDICT.exec(line);
    if (verdict) {
      verdicts.add(verdict[1] as "APPROVE" | "CHANGES");
      continue;
    }
    const finding = FINDING.exec(line);
    if (!finding) continue;
    const id = (finding[1] as string).toUpperCase();
    if (findings.some((f) => f.id === id)) {
      warnings.push(`finding ${id} appears twice; kept the first`);
      continue;
    }
    findings.push({
      id,
      severity: (finding[2] as string).toLowerCase() as Severity,
      text: finding[3] as string,
    });
  }
  if (verdicts.size === 0) return { ok: false, reason: "the reply has no VERDICT line" };
  if (verdicts.size > 1) return { ok: false, reason: "the reply's VERDICT lines disagree" };
  const [verdict] = [...verdicts] as ["APPROVE" | "CHANGES"];
  return { ok: true, verdict, findings, warnings };
}
