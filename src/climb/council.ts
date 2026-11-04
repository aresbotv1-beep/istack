import type { CouncilLog, CouncilRound } from "../council/schema.js";
import { median } from "../council/stats.js";

/**
 * One climb sample from one council round: the median, across the judges that scored, of each
 * judge's median score for the after picture. A discarded round (control drift), a budget stop or
 * a round where no judge scored gives no sample, never a guessed one.
 *
 * With a `panel`, the sample is only comparable to earlier ones when every judge on the panel
 * scored: a judge that drops out changes the instrument, so the rest of the panel gives no score.
 * Judges outside the panel are left out of the median for the same reason.
 */
export function councilScore(round: CouncilRound, panel?: readonly string[]): number | undefined {
  if (round.status !== "kept") return undefined;
  if (panel && panelGap(round, panel).length > 0) return undefined;
  const scores = round.judges.flatMap((j) =>
    j.median && (!panel || panel.includes(j.judge)) ? [j.median.after] : [],
  );
  return scores.length > 0 ? median(scores) : undefined;
}

/**
 * The judge panel a climb's samples are compared on: the judges that scored in the first kept
 * round of the log that gave a score. Undefined while no round has scored.
 */
export function councilPanel(log: CouncilLog): string[] | undefined {
  for (const round of log.rounds) {
    if (round.status !== "kept") continue;
    const scored = round.judges.filter((j) => j.median).map((j) => j.judge);
    if (scored.length > 0) return scored;
  }
  return undefined;
}

/** The panel judges that gave no score in this round. */
export function panelGap(round: CouncilRound, panel: readonly string[]): string[] {
  const scored = new Set(round.judges.filter((j) => j.median).map((j) => j.judge));
  return panel.filter((judge) => !scored.has(judge));
}
