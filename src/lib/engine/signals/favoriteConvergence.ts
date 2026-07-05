// Strategy 18 — Favorite Convergence.
//
// Harvests the favorite–longshot bias: heavy favorites (85–97c) near
// resolution historically drift toward 1 more often than their price implies,
// which is exactly the curvature our own drift-by-price profile measures.
// This is the structurally HIGH-WIN-RATE trade family — most entries win a
// little — but it is negatively skewed: the rare favorite that collapses
// loses many wins' worth at once. Every gate below exists to avoid catching
// that collapse: adverse tape, adverse momentum, rule clarity, and a
// room-vs-cost test that refuses entries whose convergence gain can't clear
// friction plus the cost of locking capital to settlement.
//
// No win rate is promised anywhere: the outcome tracker measures it, the
// hit-rate governor gates on what was measured, and the foundry lifecycle
// decides whether this ever earns paper/live routing.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { capitalLockupCost } from "@/lib/alpha/score";
import { buildSignal, check, ramp } from "./helpers";
import { resolutionClarity } from "./closingSoon";

const FAV_MIN = 0.85;
const FAV_MAX = 0.97;
const MIN_HOURS_LEFT = 2;
const MAX_DAYS_LEFT = 14;
const MAX_SPREAD = 0.02;
/** planned exit before settlement — avoids resolution risk and lockup tail */
const EXIT_AT = 0.98;
const ADVERSE_FLOW_SHARE = 0.65;
const ADVERSE_DAY_MOVE = 0.03;

export const favoriteConvergenceSignal: SignalStrategy = {
  id: "favorite_convergence",
  label: "Favorite Convergence",
  description:
    "Buys heavy favorites (85–97c) near resolution to harvest the favorite–longshot bias — high measured hit rate, negative skew, so adverse-flow/momentum/clarity/lockup gates do the real work.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, settings, trades, now } = ctx;
    // probability convergence only exists for binary outcome tokens
    if (market.outcomeType !== "binary" || market.referenceOnly || !market.tradable) return null;
    if (!market.endDate) return null;
    const hoursLeft = (new Date(market.endDate).getTime() - now) / 3_600_000;
    if (hoursLeft < MIN_HOURS_LEFT || hoursLeft > MAX_DAYS_LEFT * 24) return null;

    const mid = market.midpoint ?? market.yesPrice;
    if (mid === undefined) return null;

    // which side is the favorite? Buy THAT side's token.
    let favoriteYes: boolean;
    if (mid >= FAV_MIN && mid <= FAV_MAX) favoriteYes = true;
    else if (mid >= 1 - FAV_MAX && mid <= 1 - FAV_MIN) favoriteYes = false;
    else return null;

    // executable entry on the favorite side (NO ask implied by the YES bid)
    const entry = favoriteYes
      ? market.bestAsk ?? market.yesPrice
      : market.bestBid !== undefined
        ? 1 - market.bestBid
        : market.noPrice;
    if (entry === undefined || entry <= 0 || entry > FAV_MAX) return null;

    const spread = market.spread ?? 1;
    const friction =
      spread / 2 + settings.feeRateBps / 10_000 + settings.slippageBps / 10_000;
    const lockup = capitalLockupCost(hoursLeft / 24);
    const room = EXIT_AT - entry;

    // adverse tape: heavy recent flow AGAINST the favorite is exactly the
    // repricing this trade must never step in front of. The tape contains
    // BOTH outcome tokens' prints, so normalize to YES-equivalent pressure:
    // buying NO is selling YES (same convention as the microstructure read)
    let adverseShare: number | undefined;
    const recent = (trades ?? []).filter((t) => now - t.ts < 30 * 60_000).slice(0, 40);
    const vol = recent.reduce((a, t) => a + t.size, 0);
    if (vol > 0) {
      const pushesYesUp = (t: (typeof recent)[number]) =>
        (t.side === "BUY" && t.outcome !== "No") || (t.side === "SELL" && t.outcome === "No");
      const against = recent
        .filter((t) => (favoriteYes ? !pushesYesUp(t) : pushesYesUp(t)))
        .reduce((a, t) => a + t.size, 0);
      adverseShare = against / vol;
    }

    // adverse momentum: the favorite bleeding over the last day is a warning,
    // not an entry discount
    const dayMove = market.oneDayPriceChange;
    const favoriteDayMove =
      dayMove === undefined ? undefined : favoriteYes ? dayMove : -dayMove;

    const clarity = resolutionClarity(market.description, market.resolutionSource);

    const checks = [
      check(
        "spread_gate",
        spread <= Math.min(settings.maxSpread, MAX_SPREAD) + 1e-9,
        `Spread ${(spread * 100).toFixed(1)}c vs max ${(Math.min(settings.maxSpread, MAX_SPREAD) * 100).toFixed(1)}c — convergence edge is small, wide spreads eat all of it`,
        spread,
        Math.min(settings.maxSpread, MAX_SPREAD),
      ),
      check(
        "liquidity_floor",
        market.liquidity >= settings.minLiquidityUsd,
        `Liquidity $${Math.round(market.liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
        market.liquidity,
        settings.minLiquidityUsd,
      ),
      check(
        "clarity_gate",
        clarity.level !== "low",
        `Resolution clarity ${clarity.level.toUpperCase()} — ${clarity.reason}; a 90c market with fuzzy rules is not a favorite, it's a coin flip with extra steps`,
      ),
      check(
        "no_adverse_flow",
        adverseShare === undefined || adverseShare <= ADVERSE_FLOW_SHARE,
        adverseShare === undefined
          ? "No recent tape — no evidence of repricing flow"
          : `${(adverseShare * 100).toFixed(0)}% of recent tape volume is against the favorite (max ${ADVERSE_FLOW_SHARE * 100}%)`,
        adverseShare,
        ADVERSE_FLOW_SHARE,
      ),
      check(
        "no_adverse_momentum",
        favoriteDayMove === undefined || favoriteDayMove >= -ADVERSE_DAY_MOVE,
        favoriteDayMove === undefined
          ? "No 24h change data — momentum unverified"
          : `Favorite moved ${(favoriteDayMove * 100).toFixed(1)}c over 24h (min -${ADVERSE_DAY_MOVE * 100}c) — a bleeding favorite may be repricing on news`,
        favoriteDayMove,
        -ADVERSE_DAY_MOVE,
      ),
      check(
        "room_vs_cost",
        room - friction - lockup >= 0.005,
        `Convergence room ${(room * 100).toFixed(1)}c vs friction ${(friction * 100).toFixed(1)}c + lockup ${(lockup * 100).toFixed(2)}c — must clear by ≥0.5c`,
        room,
        friction + lockup + 0.005,
      ),
    ];

    const favStrength = favoriteYes ? mid : 1 - mid;
    const score =
      35 * ramp(hoursLeft, MAX_DAYS_LEFT * 24, 12) +
      25 * ramp(favStrength, FAV_MIN, 0.95) +
      20 * ramp(spread, MAX_SPREAD, 0.002) +
      20 * ramp(Math.log10(Math.max(1, market.liquidity)), 3.5, 5);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: favoriteYes ? "BUY_YES" : "BUY_NO",
      score,
      summary: `${favoriteYes ? "YES" : "NO"} favorite at ${(entry * 100).toFixed(1)}c, ${hoursLeft < 48 ? `${hoursLeft.toFixed(0)}h` : `${(hoursLeft / 24).toFixed(1)}d`} to close — room ${(room * 100).toFixed(1)}c vs cost ${((friction + lockup) * 100).toFixed(1)}c`,
      checks,
      now,
      ttlMs: 30 * 60_000,
      meta: {
        favoriteSide: favoriteYes ? "YES" : "NO",
        entryPrice: entry,
        roomCents: Number((room * 100).toFixed(2)),
        frictionCents: Number((friction * 100).toFixed(2)),
        lockupCents: Number((lockup * 100).toFixed(2)),
        hoursLeft: Number(hoursLeft.toFixed(1)),
        adverseShare,
        // mechanical exits in ENTRY-token terms: take half once most of the
        // room is captured, exit fully before settlement risk
        exitPlan: {
          partialExitAt: Number((entry + 0.5 * room).toFixed(3)),
          fullExitAt: EXIT_AT,
        },
      },
    });
  },
};
