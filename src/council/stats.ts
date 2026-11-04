/** Small, pure statistics for the council. No randomness unless a seeded generator is passed. */

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Median absolute deviation: how far a typical sample sits from the median. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export interface Band {
  /** The median of the baseline control scores. */
  center: number;
  /** max(minHalfWidth, k × MAD of the baseline). */
  halfWidth: number;
  low: number;
  high: number;
  /** The baseline control scores the band was learned from. */
  samples: number[];
  k: number;
  minHalfWidth: number;
}

/**
 * Learn a judge's control band from its baseline scorings of the control picture:
 * center = median, half-width = max(minHalfWidth, k × MAD). The median and MAD ignore a single
 * wild baseline sample; the floor keeps a judge that always says "5" from being discarded for a
 * one-point wobble on an integer scale.
 */
export function learnBand(samples: readonly number[], k: number, minHalfWidth: number): Band {
  const center = median(samples);
  const halfWidth = Math.max(minHalfWidth, k * medianAbsoluteDeviation(samples));
  return {
    center,
    halfWidth,
    low: center - halfWidth,
    high: center + halfWidth,
    samples: [...samples],
    k,
    minHalfWidth,
  };
}

/** Inclusive at both edges. */
export function inBand(value: number, band: Band): boolean {
  return value >= band.low && value <= band.high;
}

/** mulberry32: a tiny seeded generator, so presentation order is random but replayable. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with the given generator. Returns a new array. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
