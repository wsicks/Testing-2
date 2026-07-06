// Complement arbitrage math — pure functions, no I/O.
//
// A binary market's YES and NO tokens each settle to $1 or $0, and exactly
// one of them pays. Buying BOTH at a combined cost under $1 locks a profit
// at resolution REGARDLESS of outcome — the only edge in this codebase that
// is mathematics rather than statistics. It exists only when the two books
// (separate order books on the venue) momentarily misprice against each
// other; on a single book it is impossible by construction (ask_yes +
// implied ask_no = 1 + spread).
//
// Honesty rules: executable TOP-OF-BOOK asks only (deeper levels raise the
// cost), fees charged on both legs, and a minimum net discount so noise
// never triggers a pair.

import type { OrderBookData } from "@/lib/types";

export interface ComplementArb {
  yesAsk: number;
  noAsk: number;
  /** combined cost of one YES+NO pair */
  sum: number;
  /** gross locked profit per pair: 1 − sum */
  discount: number;
  /** after fees on both legs */
  netDiscount: number;
  /** pairs available at top-of-book on the THINNER side */
  maxPairs: number;
}

/**
 * Detect a complement arb between the YES token's book and the NO token's
 * book. Returns null unless both asks are live and the NET discount clears
 * `minNetDiscount`.
 */
export function complementArbOpportunity(
  yesBook: Pick<OrderBookData, "asks" | "bestAsk">,
  noBook: Pick<OrderBookData, "asks" | "bestAsk">,
  feeRateBps: number,
  minNetDiscount = 0.005,
): ComplementArb | null {
  const yesTop = yesBook.asks[0];
  const noTop = noBook.asks[0];
  const yesAsk = yesBook.bestAsk ?? yesTop?.price;
  const noAsk = noBook.bestAsk ?? noTop?.price;
  if (
    yesAsk === undefined || noAsk === undefined ||
    yesAsk <= 0 || noAsk <= 0 || yesAsk >= 1 || noAsk >= 1 ||
    !yesTop || !noTop || yesTop.size <= 0 || noTop.size <= 0
  ) {
    return null;
  }
  const sum = yesAsk + noAsk;
  const discount = 1 - sum;
  // fees charged on the notional of BOTH legs
  const fees = (feeRateBps / 10_000) * sum;
  const netDiscount = discount - fees;
  if (netDiscount < minNetDiscount) return null;
  return {
    yesAsk,
    noAsk,
    sum: Number(sum.toFixed(4)),
    discount: Number(discount.toFixed(4)),
    netDiscount: Number(netDiscount.toFixed(4)),
    maxPairs: Math.floor(Math.min(yesTop.size, noTop.size)),
  };
}
