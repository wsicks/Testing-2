// Strategy 1 — Liquidity / spread tradability signal.
// Flags markets with tight spread, sufficient book depth and adequate volume.
// The score is a TRADABILITY score — explicitly not a buy/sell recommendation.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { buildSignal, check, ramp } from "./helpers";

export const liquiditySpreadSignal: SignalStrategy = {
  id: "liquidity_spread",
  label: "Liquidity / Spread",
  description:
    "Tradability screen: tight spread, adequate resting depth and 24h volume. Produces a tradability score, not a directional call.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, settings, now } = ctx;
    // tradability thresholds are calibrated to 0..1 outcome tokens; asset
    // rows (reference spot products) produce meaningless "tradability"
    if (market.outcomeType !== "binary") return null;
    const spread = book?.spread ?? market.spread;
    if (spread === undefined) return null;

    const liquidity = market.liquidity;
    const volume = market.volume24h;
    const depthUsd = book ? book.bidDepthUsd + book.askDepthUsd : undefined;

    const checks = [
      check(
        "spread_tight",
        spread <= settings.maxSpread,
        `Spread ${(spread * 100).toFixed(1)}c vs max ${(settings.maxSpread * 100).toFixed(1)}c`,
        spread,
        settings.maxSpread,
      ),
      check(
        "liquidity_floor",
        liquidity >= settings.minLiquidityUsd,
        `Liquidity $${Math.round(liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
        liquidity,
        settings.minLiquidityUsd,
      ),
      check(
        "volume_floor",
        volume >= 1_000,
        `24h volume $${Math.round(volume).toLocaleString()} vs min $1,000`,
        volume,
        1_000,
      ),
    ];

    if (depthUsd !== undefined) {
      checks.push(
        check(
          "book_depth",
          depthUsd >= 500,
          `Resting depth within 5c of mid: $${Math.round(depthUsd).toLocaleString()} vs min $500`,
          depthUsd,
          500,
        ),
      );
    }
    if (
      market.midpoint !== undefined &&
      (market.midpoint < 0.03 || market.midpoint > 0.97)
    ) {
      checks.push(
        check(
          "price_not_extreme",
          false,
          `Midpoint ${(market.midpoint * 100).toFixed(1)}c is near a boundary — thin economics`,
          market.midpoint,
        ),
      );
    }

    const score =
      45 * ramp(spread, settings.maxSpread * 2, 0.005) +
      30 * ramp(Math.log10(Math.max(1, liquidity)), 3, 6) +
      25 * ramp(Math.log10(Math.max(1, volume)), 3, 6);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score,
      summary: `Tradability ${Math.round(score)}/100 — spread ${(spread * 100).toFixed(1)}c, liq $${Math.round(liquidity / 1000)}K, vol24h $${Math.round(volume / 1000)}K`,
      checks,
      now,
      meta: { spread, liquidity, volume24h: volume, depthUsd },
    });
  },
};
