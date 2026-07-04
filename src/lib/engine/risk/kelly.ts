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
