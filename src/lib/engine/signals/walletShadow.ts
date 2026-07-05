// Strategy 11 — Smart Wallet Shadow (Wallet Radar).
//
// A wallet with PROVEN category-specific skill entered this market and the
// price hasn't run away yet. Every spec gate is an explicit check: sample
// size in THIS category, measured forward evidence (the only honest
// "copyable edge"), ≤2c drift from the wallet's entry, wallet still holding,
// spread vs remaining edge, depth, rule clarity, close buffer, capital
// lockup. When proven wallets DISAGREE, this strategy emits a NEUTRAL
// divergence signal instead of picking a side.
//
// Copy execution is a separate concern: watch_only by default, paper mimic
// behind a setting, live NEVER auto (promotion + approval + live gates +
// per-order confirmation).

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import type { WalletMarketEntry } from "@/lib/alpha/types";
import { assessMimic, capitalLockupCost } from "@/lib/alpha/score";
import { clarityScore } from "./ecl";
import { resolutionClarity } from "./closingSoon";
import { buildSignal, check } from "./helpers";

function qualifies(e: WalletMarketEntry): boolean {
  return (
    (e.label === "smart_specialist" ||
      e.label === "broad_smart_wallet" ||
      e.label === "closing_market_sniper") &&
    e.stillHolding
  );
}

export const walletShadowSignal: SignalStrategy = {
  id: "wallet_shadow",
  label: "Smart Wallet Shadow",
  description:
    "A wallet with proven category-specific skill entered before broad repricing. Follows only with forward evidence, fresh entries, and every mimic gate passing.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, walletIntel, alpha, settings, now } = ctx;
    if (!walletIntel || !alpha || market.outcomeType !== "binary") return null;
    if (market.venueId !== "polymarket") return null; // wallet data is Polymarket-only

    const smart = walletIntel.entries.filter(qualifies);
    if (smart.length === 0) return null;

    // divergence: proven wallets on BOTH sides → NEUTRAL, never pick a side
    const yes = smart.filter((e) => e.side === "YES");
    const no = smart.filter((e) => e.side === "NO");
    if (yes.length > 0 && no.length > 0) {
      return buildSignal({
        strategy: this.id,
        strategyLabel: this.label,
        market,
        direction: "NEUTRAL",
        score: 40,
        summary: `SMART WALLET DIVERGENCE: ${yes.length} proven wallet(s) on YES vs ${no.length} on NO — conflicting specialists block following either side`,
        checks: [
          check("specialist_consensus", false,
            `YES: ${yes.map((e) => e.displayName ?? e.walletId.slice(0, 8)).join(", ")} | NO: ${no.map((e) => e.displayName ?? e.walletId.slice(0, 8)).join(", ")} — divergence reduces confidence and blocks size`),
        ],
        now,
        ttlMs: 10 * 60_000,
        meta: {
          signalType: "smart_wallet_divergence",
          yesWallets: yes.map((e) => ({ id: e.walletId, name: e.displayName, entry: e.avgEntryPrice, skill: e.dimensionSkill?.costAdjRoi })),
          noWallets: no.map((e) => ({ id: e.walletId, name: e.displayName, entry: e.avgEntryPrice, skill: e.dimensionSkill?.costAdjRoi })),
        },
      });
    }

    // best single stance by (skill × freshness); accumulation = multiple buys
    const best = [...smart].sort(
      (a, b) =>
        (b.dimensionSkill?.costAdjRoi ?? 0) * (b.dimensionSkill?.confidence ?? 0) -
        (a.dimensionSkill?.costAdjRoi ?? 0) * (a.dimensionSkill?.confidence ?? 0),
    )[0];

    const yesAsk = book?.bestAsk ?? market.bestAsk;
    const yesBid = book?.bestBid ?? market.bestBid;
    if (yesAsk === undefined || yesBid === undefined) return null;
    const spread = Math.max(0.001, yesAsk - yesBid);
    const buyYes = best.side === "YES";
    const entryPrice = buyYes ? yesAsk : 1 - yesBid; // our executable price on the wallet's side
    // avgEntryPrice from the data-api is ALREADY denominated in the held
    // token (a NO stance's avgPrice is the NO price paid) — no conversion
    const walletRefPrice = best.avgEntryPrice;
    const entryDepth = buyYes ? book?.askDepthUsd : book?.bidDepthUsd;

    const clarity = resolutionClarity(market.description, market.resolutionSource);
    const ruleClarity = clarityScore(clarity.level);
    const minutesToClose = market.endDate
      ? (new Date(market.endDate).getTime() - now) / 60_000
      : undefined;

    const mimic = assessMimic({
      entry: best,
      currentPrice: entryPrice,
      spread,
      entrySideDepthUsd: entryDepth,
      ruleClarity,
      crowdSameSide: walletIntel.crowdSameSide,
      minutesToClose,
      alpha,
      feeRateBps: settings.feeRateBps,
      slippageBps: settings.slippageBps,
      now,
    });

    const intelAgeMin = (now - walletIntel.updatedAt) / 60_000;
    const daysToClose = minutesToClose !== undefined ? minutesToClose / 1_440 : 30;
    const lockup = capitalLockupCost(daysToClose);
    const blocked = (reason: string) => mimic.blocks.some((b) => b.reason === reason);
    const blockDetail = (reason: string, fallback: string) =>
      mimic.blocks.find((b) => b.reason === reason)?.detail ?? fallback;

    const checks = [
      check("wallet_sample", !blocked("sample_size"),
        blockDetail("sample_size", `${best.dimensionSkill?.sampleSize ?? 0} closed trades in ${best.dimensionSkill?.dimension ?? "category"} (min ${alpha.minWalletSampleSize}) — cost-adj ROI ${((best.dimensionSkill?.costAdjRoi ?? 0) * 100).toFixed(1)}%`),
        best.dimensionSkill?.sampleSize, alpha.minWalletSampleSize),
      check("forward_evidence", !blocked("forward_evidence") && !blocked("forward_negative"),
        best.forward
          ? `measured post-detection drift: ${(best.forward.avgDrift1h * 100).toFixed(2)}c avg over ${best.forward.samples} tracked entries (need ≥${alpha.minWalletForwardSamples}, positive)`
          : `no forward evidence yet — this signal self-rejects while the tracker accumulates it (by design)`,
        best.forward?.samples, alpha.minWalletForwardSamples),
      check("entry_drift", !blocked("price_drift"),
        blockDetail("price_drift", `price ${(Math.abs(entryPrice - walletRefPrice) * 100).toFixed(1)}c from wallet entry ${(walletRefPrice * 100).toFixed(1)}c (max ${alpha.maxCopyDriftCents}c)`)),
      check("entry_freshness", !blocked("entry_stale"),
        blockDetail("entry_stale", `wallet entry ${Math.round((now - best.lastTradeTs) / 60_000)}min old (max ${alpha.maxWalletEntryAgeMin}min)`)),
      check("intel_freshness", intelAgeMin <= 15,
        `wallet intel refreshed ${intelAgeMin.toFixed(1)}min ago (max 15min) — stale wallet data must never drive entries`,
        intelAgeMin, 15),
      check("wallet_still_in", !blocked("wallet_exiting"),
        best.exiting ? "wallet has started exiting — following a leaving wallet is chasing" : `wallet holds $${Math.round(best.sizeUsd)} across ${best.entries} entr${best.entries === 1 ? "y" : "ies"}${best.entries > 1 ? " (accumulation)" : ""}`),
      check("spread_vs_edge", !blocked("spread_vs_edge") && spread <= settings.maxSpread,
        `spread ${(spread * 100).toFixed(1)}c vs remaining edge ${(mimic.remainingEdge * 100).toFixed(1)}c and max ${(settings.maxSpread * 100).toFixed(1)}c`,
        spread, settings.maxSpread),
      check("depth_vs_size", !blocked("liquidity"),
        blockDetail("liquidity", `entry-side depth $${Math.round(entryDepth ?? 0)} vs 5× test size`)),
      check("rule_clarity", ruleClarity >= 0.9,
        `rule clarity ${ruleClarity.toFixed(2)} (${clarity.level.toUpperCase()}) vs min 0.90`, ruleClarity, 0.9),
      check("close_buffer", !blocked("close_too_near"),
        minutesToClose !== undefined ? `${Math.round(minutesToClose)}min to close (min 60 for a safe exit)` : "no close time — buffer unverifiable, treated as open"),
      check("capital_lockup", mimic.remainingEdge - lockup > 0 || mimic.remainingEdge === 0,
        `remaining edge ${(mimic.remainingEdge * 100).toFixed(2)}c vs lockup cost ${(lockup * 100).toFixed(2)}c (${daysToClose.toFixed(1)}d to settlement @10%/yr)`,
        mimic.remainingEdge - lockup, 0),
    ];

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: buyYes ? "BUY_YES" : "BUY_NO",
      score: mimic.score,
      summary: `SMART WALLET ${best.entries > 1 ? "ACCUMULATION" : "ENTRY"}: ${best.displayName ?? best.walletId.slice(0, 10)} (${best.label.replace(/_/g, " ")}) ${best.side} @ ${(best.avgEntryPrice * 100).toFixed(0)}c — mimicability ${mimic.score.toFixed(0)}/100${mimic.blocks.length ? `, ${mimic.blocks.length} block(s)` : ""}`,
      checks,
      now,
      ttlMs: 10 * 60_000,
      meta: {
        signalType: best.entries > 1 ? "smart_wallet_accumulation" : "smart_wallet_entry",
        walletId: best.walletId,
        walletName: best.displayName,
        walletLabel: best.label,
        walletEntryPrice: best.avgEntryPrice,
        currentPrice: entryPrice,
        priceDrift: entryPrice - walletRefPrice,
        mimicability: mimic.score,
        mimicComponents: mimic.components,
        mimicBlocks: mimic.blocks,
        remainingEdge: mimic.remainingEdge,
        friction: mimic.friction,
        suggestedTestUsd: Number(mimic.maxSizeUsd.toFixed(2)),
        recommendation: mimic.recommendation,
        crowdSameSide: walletIntel.crowdSameSide,
        followModeNote:
          "execution governed by alpha.walletFollowMode — watch_only default; live copy requires promotion + human approval + live gates + per-order confirmation",
      },
    });
  },
};
