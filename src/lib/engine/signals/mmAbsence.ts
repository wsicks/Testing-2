// Strategy 14 — Market Maker Absence (Feature Forge #11).
//
// A normally-tight market whose spread suddenly blows out has lost its
// liquidity provider; quotes during the vacuum can misprice. The rolling
// spread baseline (EMA over ~20 scans) defines "normal"; the blowout must
// be both proportional (≥2.5×) and absolute (≥2c wider). Direction comes
// ONLY from a proven tracked wallet already positioned in the market —
// without one, the signal stays NEUTRAL observation. Entering a wide book
// is expensive by definition, so the edge must clear the CURRENT spread.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { clarityScore } from "./ecl";
import { resolutionClarity } from "./closingSoon";
import { buildSignal, check, ramp } from "./helpers";

const MIN_SAMPLES = 20;
const RATIO_TRIGGER = 2.5;
const ABS_TRIGGER = 0.02;

export const mmAbsenceSignal: SignalStrategy = {
  id: "mm_absence",
  label: "Market Maker Absence",
  description:
    "Detects sudden spread blowouts vs the market's own rolling baseline. Directional only when a proven wallet is already positioned; otherwise a NEUTRAL vacuum observation.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, baseline, walletIntel, alpha, settings, now } = ctx;
    if (market.outcomeType !== "binary") return null;
    if (!baseline || baseline.samples < MIN_SAMPLES) return null;
    const spread = book?.spread ?? market.spread;
    if (spread === undefined) return null;

    const normallyTight = baseline.spreadEma <= 0.03;
    const blowout =
      spread >= Math.max(baseline.spreadEma * RATIO_TRIGGER, baseline.spreadEma + ABS_TRIGGER);
    if (!normallyTight || !blowout) return null;

    const ratio = spread / Math.max(0.001, baseline.spreadEma);
    const clarity = resolutionClarity(market.description, market.resolutionSource);
    const ruleClarity = clarityScore(clarity.level);
    const freshMs = now - market.fetchedAt;

    // a proven wallet already positioned gives the vacuum a direction
    const stance = walletIntel?.entries.find(
      (e) =>
        (e.label === "smart_specialist" || e.label === "broad_smart_wallet") &&
        e.stillHolding &&
        !e.exiting &&
        e.forward !== undefined &&
        alpha !== undefined &&
        e.forward.samples >= alpha.minWalletForwardSamples &&
        e.forward.avgDrift1h > 0,
    );

    const direction = stance ? (stance.side === "YES" ? "BUY_YES" : "BUY_NO") : "NEUTRAL";
    const expectedEdge = stance?.forward?.avgDrift1h ?? 0;
    const friction = spread / 2 + settings.slippageBps / 10_000 + settings.feeRateBps / 10_000;

    const checks = [
      check("baseline_established", baseline.samples >= MIN_SAMPLES,
        `${baseline.samples} baseline samples (min ${MIN_SAMPLES}) — normal spread ${(baseline.spreadEma * 100).toFixed(1)}c`,
        baseline.samples, MIN_SAMPLES),
      check("spread_blowout", blowout,
        `spread ${(spread * 100).toFixed(1)}c vs baseline ${(baseline.spreadEma * 100).toFixed(1)}c → ${ratio.toFixed(1)}× (trigger ${RATIO_TRIGGER}× and +${ABS_TRIGGER * 100}c)`,
        ratio, RATIO_TRIGGER),
      check("normally_liquid", normallyTight && baseline.liquidityEma >= settings.minLiquidityUsd,
        `baseline liquidity $${Math.round(baseline.liquidityEma).toLocaleString()} (min $${settings.minLiquidityUsd.toLocaleString()}) with normally-tight quotes — a wide book that was always wide is not an absence`,
        baseline.liquidityEma, settings.minLiquidityUsd),
      check("data_freshness", freshMs <= 60_000,
        `market data ${(freshMs / 1000).toFixed(0)}s old (max 60s) — a stale blowout may already be refilled`,
        freshMs / 1000, 60),
      check("rule_clarity", ruleClarity >= 0.9,
        `rule clarity ${ruleClarity.toFixed(2)} (${clarity.level.toUpperCase()}) vs min 0.90`, ruleClarity, 0.9),
      check("directional_evidence", stance !== undefined,
        stance
          ? `proven wallet ${stance.displayName ?? stance.walletId.slice(0, 8)} holds ${stance.side} with measured +${((stance.forward?.avgDrift1h ?? 0) * 100).toFixed(2)}c forward drift`
          : "no proven wallet positioned — vacuum is an OBSERVATION, not a trade"),
      check("edge_vs_current_spread", stance !== undefined && expectedEdge > friction,
        stance
          ? `expected edge ${(expectedEdge * 100).toFixed(2)}c vs friction ${(friction * 100).toFixed(2)}c at the CURRENT (blown-out) spread — entering a vacuum pays the vacuum's price`
          : "no directional edge to compare against the blown-out spread"),
    ];

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction,
      score: 25 + 50 * ramp(ratio, RATIO_TRIGGER, 8) * (stance ? 1 : 0.6),
      summary: `MM ABSENCE: spread ${(spread * 100).toFixed(1)}c is ${ratio.toFixed(1)}× the ${(baseline.spreadEma * 100).toFixed(1)}c baseline${stance ? ` — ${stance.displayName ?? "proven wallet"} holds ${stance.side}` : " — no positioned wallet, observation only"}`,
      checks,
      now,
      ttlMs: 5 * 60_000, // vacuums refill fast
      meta: {
        signalType: "mm_absence",
        baselineSpread: baseline.spreadEma,
        currentSpread: spread,
        spreadRatio: ratio,
        baselineSamples: baseline.samples,
        walletId: stance?.walletId,
        walletSide: stance?.side,
        expectedEdge: stance ? expectedEdge : undefined,
        friction,
      },
    });
  },
};
