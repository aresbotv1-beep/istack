import { usd } from "./run.js";
import type { CouncilLog, CouncilRound, JudgeRound } from "./schema.js";

const NOTE =
  "Measurements, not a merge gate. Judges saw the pictures in a random order with a neutral rubric and no goal; each score is the median of that judge's samples.";

/**
 * The "Council scores" block for the PR body. Only the latest round counts: older rounds scored
 * older pictures. A discarded or budget-stopped round shows no numbers at all, and a judge without
 * a score says "no score" — nothing is carried over or filled in.
 */
export function renderCouncilScores(log: CouncilLog): string {
  const latest = log.rounds.at(-1);
  const lines = ["### Council scores", ""];
  if (!latest) {
    lines.push("No council round has run. **no score**.");
    return lines.join("\n");
  }
  if (latest.status === "discarded") {
    lines.push(
      `**No council scores.** Round ${latest.number} (${short(latest.head)}) was discarded: ${cell(latest.reason)}. No numbers from a discarded round are shown.`,
    );
  } else if (latest.status === "budget") {
    lines.push(
      `**No council** for round ${latest.number} (${short(latest.head)}): ${cell(latest.reason)}.`,
    );
  } else {
    lines.push(NOTE, "");
    lines.push(
      "| Judge | Before | After | Control | Control band | Samples |",
      "|---|---|---|---|---|---|",
      ...latest.judges.map((j) => judgeRow(j, log)),
    );
    lines.push("", `Round ${latest.number} at ${short(latest.head)}: ${cell(latest.reason)}.`);
  }
  lines.push("", history(log.rounds), "", costLine(log));
  return lines.join("\n");
}

function judgeRow(judge: JudgeRound, log: CouncilLog): string {
  const band = log.bands[judge.judge];
  const bandText = band ? `${band.low}–${band.high}` : "none";
  const roundSamples = judge.samples.filter((s) => s.phase === "round");
  const sampleText = `${roundSamples.filter((s) => s.scores).length} of ${roundSamples.length} readable`;
  if (!judge.median) {
    const why = judge.note ? ` (${cell(judge.note)})` : "";
    return `| ${cell(judge.judge)} | no score${why} | no score | no score | ${bandText} | ${sampleText} |`;
  }
  const before = judge.median.before === undefined ? "absent" : String(judge.median.before);
  return `| ${cell(judge.judge)} | ${before} | ${judge.median.after} | ${judge.median.control} | ${bandText} | ${sampleText} |`;
}

function history(rounds: CouncilRound[]): string {
  const items = rounds.map((r) => {
    const word = r.status === "budget" ? "no council (budget)" : r.status;
    return `round ${r.number} ${word} (${usd(r.costUsd)})`;
  });
  return `Rounds: ${items.join("; ")}.`;
}

function costLine(log: CouncilLog): string {
  const samples = log.rounds.flatMap((r) => r.judges.flatMap((j) => j.samples));
  const measured = samples.filter((s) => s.costSource === "measured").length;
  const basis =
    samples.length === 0
      ? "no calls made"
      : measured === samples.length
        ? "measured"
        : measured === 0
          ? "estimated from the price table"
          : `${measured} of ${samples.length} calls measured, the rest estimated`;
  return `Council cost: ${usd(log.spentUsd)} of the ${usd(log.budgetUsd)} per-PR budget (${basis}).`;
}

function short(sha: string): string {
  return `\`${sha.slice(0, 12)}\``;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}
