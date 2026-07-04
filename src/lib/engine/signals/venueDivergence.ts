// Strategy 9 — Venue divergence monitor (cross-venue).
// Surfaces price divergence between candidate-matched Polymarket and Kalshi
// markets as a CANDIDATE DISCREPANCY — never as arbitrage. Fires only on
// strong candidates, includes both venues' spreads in the cost buffer, and
// always carries an unresolved rules-verification check so it can never
// self-approve.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { buildSignal, check, ramp } from "./helpers";

export const venueDivergenceSignal: SignalStrategy = {
  id: "venue_divergence",
  label: "Venue Divergence",
  description:
    "Candidate price discrepancies between rule-comparable Polymarket and Kalshi markets. Human review mandatory — never assumes arbitrage.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, crossLinks, relatedMarkets, settings, now } = ctx;
    if (market.outcomeType !== "binary") return null;
    const links = (crossLinks ?? []).filter(
      (l) =>
        (l.sourceMarketId === market.conditionId || l.targetMarketId === market.conditionId) &&
        (l.matchStatus === "strong_candidate" || l.matchStatus === "exact") &&
        l.divergence !== undefined,
    );
    if (!links.length) return null;
    const link = links.sort((a, b) => (b.divergence ?? 0) - (a.divergence ?? 0))[0];
    const otherId =
      link.sourceMarketId === market.conditionId ? link.targetMarketId : link.sourceMarketId;
    const other = relatedMarkets?.find((m) => m.conditionId === otherId);
    if (!other) return null;

    const divergence = link.divergence ?? 0;
    // cost buffer includes BOTH venues' spreads plus fee/slippage budgets —
    // crossing two books is two round-trip cost stacks
    const costBuffer =
      (market.spread ?? 0.02) +
      (other.spread ?? 0.02) +
      (2 * settings.feeRateBps) / 10_000 +
      (2 * settings.slippageBps) / 10_000;
    if (divergence <= costBuffer) return null;

    const bothLiquid =
      market.liquidity >= settings.minLiquidityUsd &&
      other.liquidity >= settings.minLiquidityUsd;

    const checks = [
      check(
        "rule_comparability",
        true,
        `${link.matchStatus.toUpperCase()} (score ${link.matchScore}): ${link.dimensions.filter((d) => d.comparable).length}/${link.dimensions.length} dimensions comparable`,
        link.matchScore,
      ),
      check(
        "divergence_clears_costs",
        divergence > costBuffer,
        `Divergence ${(divergence * 100).toFixed(1)}c vs combined cost buffer ${(costBuffer * 100).toFixed(1)}c (both spreads + fees + slippage)`,
        divergence,
        costBuffer,
      ),
      check(
        "both_venues_liquid",
        bothLiquid,
        `${market.venueId} $${Math.round(market.liquidity).toLocaleString()} / ${other.venueId} $${Math.round(other.liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
      ),
      check(
        "resolution_rules_verified",
        false,
        "Resolution wording, settlement mechanics, fees and eligibility have NOT been verified equivalent across venues — candidate discrepancy only, human review mandatory.",
      ),
      check(
        "settlement_window",
        Boolean(link.dimensions.find((d) => d.name === "close_time")?.comparable),
        link.dimensions.find((d) => d.name === "close_time")?.note ?? "close-time comparison unavailable",
      ),
    ];

    const score = 40 + 60 * ramp(divergence - costBuffer, 0, 0.1);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score,
      summary: `CANDIDATE DISCREPANCY: ${market.venueId} ${(100 * (market.yesPrice ?? 0)).toFixed(0)}% vs ${other.venueId} ${(100 * (other.yesPrice ?? 0)).toFixed(0)}% (Δ ${(divergence * 100).toFixed(1)}c > costs ${(costBuffer * 100).toFixed(1)}c) — rules unverified`,
      checks,
      now,
      ttlMs: 10 * 60_000,
      meta: {
        linkId: link.id,
        matchStatus: link.matchStatus,
        otherVenue: other.venueId,
        otherMarketId: other.conditionId,
        otherYes: other.yesPrice,
        divergence,
        costBuffer,
      },
    });
  },
};
