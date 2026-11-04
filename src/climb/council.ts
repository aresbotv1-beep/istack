import type { CouncilRound } from "../council/schema.js";
import { median } from "../council/stats.js";

/**
 * One climb sample from one council round: the median, across the judges that scored, of each
 * judge's median score for the after picture. A discarded round (control drift), a budget stop or
 * a round where no judge scored gives no sample, never a guessed one.
 */
export function councilScore(round: CouncilRound): number | undefined {
  if (round.status !== "kept") return undefined;
  const scores = round.judges.flatMap((j) => (j.median ? [j.median.after] : []));
  return scores.length > 0 ? median(scores) : undefined;
}
