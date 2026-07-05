// Strategy 12 — Smart Wallet Fade / Exit Warning (Wallet Radar).
//
// Two spec signals share the wallet-stance data:
//   FADE — a wallet with MEASURED negative forward drift (reliably wrong or
//   crowd-toxic) entered; the opposite side is a candidate, under the same
//   strict gates as following (evidence, spread, depth, clarity, lockup).
//   EXIT WARNING — a PROVEN wallet is exiting; emitted as NEUTRAL advisory
//   (confidence reduction / no-trade filter), never an automatic short.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { capitalLockupCost } from "@/lib/alpha/score";
import { clarityScore } from "./ecl";
import { resolutionClarity } from "./closingSoon";
import { buildSignal, check } from "./helpers";

export const walletFadeSignal: SignalStrategy = {
  id: "wallet_fade",
  label: "Wallet Fade / Exit Warning",
  description:
    "Fades wallets with measured negative forward drift; surfaces proven-wallet exits as NEUTRAL warnings. Evidence-gated, never automatic.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, walletIntel, alpha, settings, now } = ctx;
    if (!walletIntel || !alpha || market.outcomeType !== "binary") return null;
    if (market.venueId !== "polymarket") return null;

    // exit warning first: a skilled wallet reducing/leaving is information
    const exiting = walletIntel.entries.find(
      (e) =>
        (e.label === "smart_specialist" || e.label === "broad_smart_wallet") &&
        e.exiting,
    );

    const fadeTarget = walletIntel.entries.find(
      (e) =>
        e.label === "fade_candidate" &&
        e.stillHolding &&
        e.forward !== undefined &&
        e.forward.samples >= alpha.minWalletForwardSamples &&
        e.forward.avgDrift1h < 0,
    );

    if (!fadeTarget && exiting) {
      return buildSignal({
        strategy: this.id,
        strategyLabel: this.label,
        market,
        direction: "NEUTRAL",
        score: 35,
        summary: `SMART WALLET EXIT WARNING: ${exiting.displayName ?? exiting.walletId.slice(0, 10)} (${exiting.label.replace(/_/g, " ")}) is reducing its ${exiting.side} position — use as confidence reduction, not a short`,
        checks: [
          check("exit_warning_only", false,
            "advisory: skilled-wallet exits lower confidence and can veto entries; they are never traded automatically"),
        ],
        now,
        ttlMs: 15 * 60_000,
        meta: {
          signalType: "smart_wallet_exit_warning",
          walletId: exiting.walletId,
          walletName: exiting.displayName,
          side: exiting.side,
          walletEntryPrice: exiting.avgEntryPrice,
        },
      });
    }
    if (!fadeTarget) return null;

    const yesAsk = book?.bestAsk ?? market.bestAsk;
    const yesBid = book?.bestBid ?? market.bestBid;
    if (yesAsk === undefined || yesBid === undefined) return null;
    const spread = Math.max(0.001, yesAsk - yesBid);
    // fade = take the OPPOSITE side of the toxic wallet
    const buyYes = fadeTarget.side === "NO";
    const entryPrice = buyYes ? yesAsk : 1 - yesBid;
    const entryDepth = buyYes ? book?.askDepthUsd : book?.bidDepthUsd;

    const clarity = resolutionClarity(market.description, market.resolutionSource);
    const ruleClarity = clarityScore(clarity.level);
    const minutesToClose = market.endDate
      ? (new Date(market.endDate).getTime() - now) / 60_000
      : undefined;
    const daysToClose = minutesToClose !== undefined ? minutesToClose / 1_440 : 30;

    const fwd = fadeTarget.forward!;
    // measured negative drift on the wallet's side = expected positive drift on ours
    const expectedEdge = Math.abs(fwd.avgDrift1h);
    const friction = spread / 2 + settings.feeRateBps / 10_000 + settings.slippageBps / 10_000;
    const lockup = capitalLockupCost(daysToClose);
    const netEdge = expectedEdge - friction - lockup;
    const intelAgeMin = (now - walletIntel.updatedAt) / 60_000;
    const entryAgeMin = (now - fadeTarget.lastTradeTs) / 60_000;
    const inProvenCategory =
      fadeTarget.dimensionSkill !== undefined &&
      fadeTarget.dimensionSkill.sampleSize >= alpha.minWalletSampleSize &&
      fadeTarget.dimensionSkill.costAdjRoi > 0;

    const checks = [
      check("fade_evidence", fwd.samples >= alpha.minWalletForwardSamples && fwd.avgDrift1h < -0.005,
        `measured post-entry drift ${(fwd.avgDrift1h * 100).toFixed(2)}c over ${fwd.samples} tracked entries — fade only trades MEASURED toxicity`,
        fwd.avgDrift1h, -0.005),
      check("outside_proven_category", !inProvenCategory,
        inProvenCategory
          ? "wallet has PROVEN positive skill in this category — never fade a specialist on home turf"
          : "wallet has no proven positive skill in this market's category"),
      check("edge_after_cost", netEdge > 0.01,
        `expected fade edge ${(expectedEdge * 100).toFixed(2)}c − friction ${(friction * 100).toFixed(2)}c − lockup ${(lockup * 100).toFixed(2)}c = ${(netEdge * 100).toFixed(2)}c (min 1.0c)`,
        netEdge, 0.01),
      check("spread_gate", spread <= settings.maxSpread,
        `spread ${(spread * 100).toFixed(1)}c vs max ${(settings.maxSpread * 100).toFixed(1)}c`, spread, settings.maxSpread),
      check("depth_vs_size", (entryDepth ?? 0) >= 5 * alpha.testOrderUsd,
        `entry-side depth $${Math.round(entryDepth ?? 0)} vs 5× test size $${(5 * alpha.testOrderUsd).toFixed(0)} — exit liquidity is the fade's real risk`,
        entryDepth, 5 * alpha.testOrderUsd),
      check("rule_clarity", ruleClarity >= 0.9,
        `rule clarity ${ruleClarity.toFixed(2)} (${clarity.level.toUpperCase()}) vs min 0.90`, ruleClarity, 0.9),
      check("entry_freshness", entryAgeMin <= alpha.maxWalletEntryAgeMin,
        `toxic entry ${Math.round(entryAgeMin)}min old (max ${alpha.maxWalletEntryAgeMin}min) — mean reversion decays`,
        entryAgeMin, alpha.maxWalletEntryAgeMin),
      check("intel_freshness", intelAgeMin <= 15,
        `wallet intel ${intelAgeMin.toFixed(1)}min old (max 15min)`, intelAgeMin, 15),
    ];

    const score = Math.min(
      100,
      100 * Math.max(0, netEdge) * 20 * (fwd.samples >= 30 ? 1 : 0.6),
    );

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: buyYes ? "BUY_YES" : "BUY_NO",
      score,
      summary: `FADE CANDIDATE: ${fadeTarget.displayName ?? fadeTarget.walletId.slice(0, 10)} entered ${fadeTarget.side} @ ${(fadeTarget.avgEntryPrice * 100).toFixed(0)}c; measured ${(fwd.avgDrift1h * 100).toFixed(1)}c post-entry drift over ${fwd.samples} entries → opposite side after costs ${(netEdge * 100).toFixed(1)}c`,
      checks,
      now,
      ttlMs: 10 * 60_000,
      meta: {
        signalType: "smart_wallet_fade",
        walletId: fadeTarget.walletId,
        walletName: fadeTarget.displayName,
        walletLabel: fadeTarget.label,
        walletEntryPrice: fadeTarget.avgEntryPrice,
        currentPrice: entryPrice,
        expectedEdge,
        friction,
        netEdge,
        suggestedTestUsd: Math.min(alpha.testOrderUsd, 25),
        followModeNote: "paper fade requires alpha.walletFollowMode = paper_fade; live is promotion-gated",
      },
    });
  },
};
