// Strategy 15 — Liquidity Vacuum Detector (Feature Forge #9).
//
// Protective screen, not a trade: measures how little aggressive flow it
// takes to move the mid by 1c (walking the actual book) and flags markets
// where displayed prices rest on almost nothing. The spec's own warning is
// the point — "avoid chasing unless edge survives slippage" — so this is
// NEUTRAL with an always-failing execution gate, and other strategies'
// depth checks remain the enforcement.

import type { BookLevel, SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { buildSignal, check, ramp } from "./helpers";

/** USD notional needed to move the touch by `move` via marketable orders */
export function usdToMove(levels: BookLevel[], best: number, move: number, side: "up" | "down"): number {
  let usd = 0;
  for (const lvl of levels) {
    // the level AT best±move is the DESTINATION touch — clearing everything
    // before it already moves the touch there, so it must not be summed
    // (epsilon guards float noise in best+move)
    const past =
      side === "up" ? lvl.price >= best + move - 1e-9 : lvl.price <= best - move + 1e-9;
    if (past) break;
    usd += lvl.price * lvl.size;
  }
  return usd;
}

const VACUUM_USD = 200; // < $200 to move 1c = a vacuum
const MIN_VOLUME = 25_000; // only markets that LOOK active are traps

export const liquidityVacuumSignal: SignalStrategy = {
  id: "liquidity_vacuum",
  label: "Liquidity Vacuum",
  description:
    "Flags active-looking markets where <$200 of flow moves the touch 1c — displayed prices rest on air. Protective screen; never a trade.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, now } = ctx;
    if (market.outcomeType !== "binary" || !book) return null;
    if (market.volume24h < MIN_VOLUME) return null;
    if (book.bestAsk === undefined || book.bestBid === undefined) return null;

    const upUsd = usdToMove(book.asks, book.bestAsk, 0.01, "up");
    const downUsd = usdToMove(book.bids, book.bestBid, 0.01, "down");
    const thinnest = Math.min(upUsd, downUsd);
    if (thinnest >= VACUUM_USD) return null;

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score: 30 + 50 * ramp(VACUUM_USD - thinnest, 0, VACUUM_USD),
      summary: `LIQUIDITY VACUUM: $${Math.round(thinnest)} of flow moves the ${upUsd < downUsd ? "ask" : "bid"} 1c despite $${Math.round(market.volume24h / 1000)}k daily volume — displayed prices rest on air`,
      checks: [
        check("vacuum_detected", true,
          `$${Math.round(upUsd)} to lift 1c / $${Math.round(downUsd)} to hit 1c (vacuum < $${VACUUM_USD})`,
          thinnest, VACUUM_USD),
        check("execution_blocked", false,
          "protective screen: any displayed edge here may not survive its own execution — depth gates in directional strategies enforce this"),
      ],
      now,
      ttlMs: 5 * 60_000,
      meta: {
        signalType: "liquidity_vacuum",
        usdToLift1c: Math.round(upUsd),
        usdToHit1c: Math.round(downUsd),
        volume24h: market.volume24h,
      },
    });
  },
};
