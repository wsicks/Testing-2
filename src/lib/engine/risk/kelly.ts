// Kelly sizing for binary-outcome tokens.
// Buying a share at price p that pays 1 on a win: net odds b = (1-p)/p.
// Full Kelly fraction f* = (b·q - (1-q)) / b where q = win probability.

export function kellyFraction(winProb: number, entryPrice: number): number {
  if (entryPrice <= 0 || entryPrice >= 1) return 0;
  const b = (1 - entryPrice) / entryPrice;
  const q = Math.min(1, Math.max(0, winProb));
  const f = (b * q - (1 - q)) / b;
  return Math.max(0, f);
}

/**
 * Conservative Kelly: multiply full Kelly by `kellyCap` (e.g. 0.25 for
 * quarter-Kelly) and never exceed `maxFraction` of the portfolio.
 */
export function cappedKelly(
  winProb: number,
  entryPrice: number,
  kellyCap: number,
  maxFraction: number,
): number {
  const full = kellyFraction(winProb, entryPrice);
  return Math.min(full * kellyCap, maxFraction);
}

/**
 * Uncertainty-shrunk Kelly for the autopilot: instead of trusting the point
 * estimate, size on the LOWER bound of a Beta posterior built from the
 * strategy's realized wins/losses blended with the model estimate. Few
 * observations → wide posterior → tiny size; edge only scales up as the
 * strategy proves itself.
 */
export function shrunkKelly(
  modelWinProb: number,
  entryPrice: number,
  record: { wins: number; losses: number },
  kellyCap: number,
  maxFraction: number,
): number {
  const n = record.wins + record.losses;
  // blend: model prior worth ~4 pseudo-observations, then real outcomes
  const alpha = 4 * modelWinProb + record.wins;
  const beta = 4 * (1 - modelWinProb) + record.losses;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  // one-sided ~90% lower confidence bound
  const lcb = Math.max(0, mean - 1.28 * Math.sqrt(variance));
  const f = kellyFraction(lcb, entryPrice) * kellyCap;
  // extra shrink while the sample is tiny
  const confidence = Math.min(1, n / 20 + 0.25);
  return Math.min(f * confidence, maxFraction);
}
