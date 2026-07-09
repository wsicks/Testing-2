// Autopilot entry policy — pure decision function.
//
// Given fresh signals, the current portfolio, bandit samples and the session
// envelope, produce (a) trade proposals to hand to the risk engine and
// (b) explicit skip decisions with reasons. Nothing here executes; the
// server-side engine owns side effects, and the independent risk engine can
// still veto anything the policy proposes.

import type {
  AppSettings,
  AutopilotConfig,
  AutopilotDecision,
  BanditArm,
  ManagedPosition,
  NormalizedMarket,
  PortfolioState,
  SignalResult,
  TradeProposal,
} from "@/lib/types";
import { regimeAllows, type Regime } from "../micro/regime";
import { shrunkKelly } from "../risk/kelly";
import { genId } from "@/lib/utils";
import type { StrategyHitRate } from "@/lib/alpha/hitRate";
import { privateEdgeVerdict, type PrivateEdgeProfile } from "@/lib/alpha/privateEdge";

// ── Hit-rate governor ────────────────────────────────────────────────────────
// Entries are only taken from strategies whose MEASURED 1h hit rate holds up.
// Below the sample floor a strategy is unproven and may still explore (the
// bandit handles that); at/above it, a hit rate under the cutoff blocks
// entries until the strategy re-proves itself in shadow measurement. The
// ranking boost uses the Wilson lower bound, so small hot streaks never
// outrank a strategy with a genuinely proven win rate.

export const GOVERNOR_MIN_SAMPLES = 20;
export const GOVERNOR_MIN_HIT_RATE = 0.45;

export interface EntryCandidate {
  proposal: TradeProposal;
  signal: SignalResult;
  strategy: string;
  rank: number;
}

export interface PolicyInput {
  signals: SignalResult[];
  markets: Map<string, NormalizedMarket>;
  regimes: Map<string, Regime>;
  portfolio: PortfolioState;
  settings: AppSettings;
  config: AutopilotConfig;
  bandit: BanditArm[];
  managed: ManagedPosition[];
  session: { trades: number; notionalUsd: number; tradesLastHour: number };
  /** measured per-strategy hit rates from the outcome archive */
  hitRates?: Map<string, StrategyHitRate>;
  /** private per-strategy edge profiles from the local outcome archive */
  privateEdge?: Map<string, PrivateEdgeProfile>;
  /**
   * strategies whose latest walk-forward backtest measured NEGATIVE net
   * expectancy with zero positive folds — blocked from entries until a
   * newer backtest passes (evidence outranks enablement)
   */
  backtestBlocked?: Set<string>;
  now: number;
}

/**
 * maker-style entry price: post INSIDE the spread (rounded to the tick)
 * instead of crossing to the ask. On a 2c-spread book this converts ~1c of
 * paid friction per trade into captured spread — the largest single lever
 * on measured expectancy. Falls back to the ask when the spread leaves no
 * room to post inside it.
 */
export function makerEntryPrice(
  bid: number | undefined,
  ask: number | undefined,
  tickSize = 0.01,
): number | undefined {
  if (ask === undefined) return undefined;
  if (bid === undefined || ask - bid <= tickSize + 1e-9) return ask;
  const mid = (bid + ask) / 2;
  const ticked = Math.round(mid / tickSize) * tickSize;
  return Number(Math.min(ask - tickSize, Math.max(bid + tickSize, ticked)).toFixed(3));
}

export interface PolicyOutput {
  candidates: EntryCandidate[];
  skips: AutopilotDecision[];
}

function skip(reason: string, sig?: SignalResult): AutopilotDecision {
  return {
    id: genId("apd"),
    ts: Date.now(),
    kind: "skip",
    strategy: sig?.strategy,
    conditionId: sig?.conditionId,
    marketQuestion: sig?.marketQuestion,
    reason,
  };
}

export function decideEntries(input: PolicyInput): PolicyOutput {
  const { signals, markets, regimes, config, bandit, managed, session, now } = input;
  const skips: AutopilotDecision[] = [];
  const candidates: EntryCandidate[] = [];

  // session envelope gates (whole-tick)
  if (managed.length >= config.maxOpenPositions) {
    return {
      candidates,
      skips: [skip(`max open positions reached (${managed.length}/${config.maxOpenPositions}) — entries paused, exits continue`)],
    };
  }
  if (session.tradesLastHour >= config.maxTradesPerHour) {
    return {
      candidates,
      skips: [skip(`hourly trade cap reached (${session.tradesLastHour}/${config.maxTradesPerHour})`)],
    };
  }

  const sampledByStrategy = new Map(bandit.map((b) => [b.strategy, b]));
  const heldConditions = new Set(managed.map((m) => m.conditionId));

  for (const sig of signals) {
    if (!config.enabledStrategies.includes(sig.strategy)) continue;
    if (sig.status !== "proposed") {
      skips.push(skip(`signal self-rejected (${sig.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")})`, sig));
      continue;
    }
    if (sig.direction === "NEUTRAL") continue; // informational signals never trade
    if (sig.score < config.minScore) {
      skips.push(skip(`score ${sig.score} below autopilot minimum ${config.minScore}`, sig));
      continue;
    }
    if (sig.expiresAt && now > sig.expiresAt) {
      skips.push(skip("signal expired before evaluation", sig));
      continue;
    }
    if (input.backtestBlocked?.has(sig.strategy)) {
      skips.push(
        skip(
          `backtest gate: '${sig.strategy}' measured negative net expectancy in its walk-forward replay (0 positive folds) — entries blocked until a newer backtest passes`,
          sig,
        ),
      );
      continue;
    }
    const hr = input.hitRates?.get(sig.strategy);
    if (hr && hr.n >= GOVERNOR_MIN_SAMPLES && hr.hitRate < GOVERNOR_MIN_HIT_RATE) {
      skips.push(
        skip(
          `hit-rate governor: measured 1h hit rate ${(hr.hitRate * 100).toFixed(0)}% over ${hr.n} outcomes is below ${(GOVERNOR_MIN_HIT_RATE * 100).toFixed(0)}% — entries blocked until shadow measurement re-proves this strategy`,
          sig,
        ),
      );
      continue;
    }
    if (!sig.conditionId || heldConditions.has(sig.conditionId)) {
      if (sig.conditionId) skips.push(skip("already holding a managed position in this market", sig));
      continue;
    }
    const market = markets.get(sig.conditionId);
    if (!market) continue;

    // autopilot automation is single-venue by design: cross-venue automation
    // requires explicit per-venue opt-in that does not exist yet
    if (market.venueId !== "polymarket") {
      skips.push(skip(`autopilot entries are restricted to polymarket — ${market.venueId} automation requires explicit per-venue opt-in (not available)`, sig));
      continue;
    }
    if (market.referenceOnly || !market.tradable) {
      skips.push(skip("market is reference-only/non-tradable — automation forbidden", sig));
      continue;
    }

    const regime = regimes.get(sig.conditionId) ?? "unknown";
    if (config.requireRegimeMatch && !regimeAllows(sig.strategy, regime)) {
      skips.push(skip(`regime ${regime.toUpperCase()} does not fit ${sig.strategy}`, sig));
      continue;
    }

    const modelWinProb =
      typeof sig.meta?.modelWinProb === "number"
        ? (sig.meta.modelWinProb as number)
        : undefined;

    // per-market NET economics: a strategy with measured evidence must
    // clear THIS market's friction, not just be non-terrible on average —
    // +0.8c of measured drift entered on a 3c-spread book is a losing trade
    const friction =
      (market.spread ?? 0.02) / 2 +
      input.settings.feeRateBps / 10_000 +
      input.settings.slippageBps / 10_000;
    if (hr && hr.n >= GOVERNOR_MIN_SAMPLES && hr.avgDrift1h <= friction) {
      skips.push(
        skip(
          `net economics: measured 1h drift ${(hr.avgDrift1h * 100).toFixed(2)}c does not clear this market's friction ${(friction * 100).toFixed(2)}c`,
          sig,
        ),
      );
      continue;
    }

    const privateEdge = privateEdgeVerdict({
      profile: input.privateEdge?.get(sig.strategy),
      signal: sig,
      market,
      settings: input.settings,
      now,
      modelWinProbability: modelWinProb,
    });
    if (!privateEdge.allow) {
      skips.push(skip(privateEdge.reason ?? "private edge gate blocked entry", sig));
      continue;
    }

    // side & price: buy the signaled outcome token. Maker style posts
    // INSIDE the spread (captures ~half of it); taker crosses to the ask.
    const buyYes = sig.direction === "BUY_YES";
    const tokenId = buyYes ? market.yesTokenId : market.noTokenId;
    if (!tokenId) continue;
    const tick = market.tickSize ?? 0.01;
    // the traded token's own bid/ask (NO book implied by the YES book)
    const tokenBid = buyYes
      ? market.bestBid
      : market.bestAsk !== undefined
        ? 1 - market.bestAsk
        : undefined;
    const tokenAsk = buyYes
      ? market.bestAsk ?? market.yesPrice
      : market.bestBid !== undefined
        ? 1 - market.bestBid
        : market.noPrice;
    const price =
      config.entryStyle === "maker"
        ? makerEntryPrice(tokenBid, tokenAsk, tick)
        : tokenAsk;
    if (price === undefined || price <= 0.02 || price >= 0.98) {
      skips.push(skip("no viable entry price inside the tradable band", sig));
      continue;
    }

    const sizingWinProb = privateEdge.adjustedWinProbability ?? modelWinProb;

    // sizing: uncertainty-shrunk Kelly when the strategy provides a model
    // probability, else the flat per-trade budget; always capped by config
    const arm = sampledByStrategy.get(sig.strategy);
    let notional = config.perTradeUsd;
    if (sizingWinProb !== undefined) {
      const frac = shrunkKelly(
        sizingWinProb,
        price,
        { wins: arm?.wins ?? 0, losses: arm?.losses ?? 0 },
        input.settings.kellyCap,
        input.settings.maxTradePct / 100,
      );
      const kellyUsd = frac * Math.max(1, input.portfolio.totalValue);
      notional = Math.min(config.perTradeUsd, Math.max(5, kellyUsd));
    }
    notional = Math.min(
      config.perTradeUsd,
      Math.max(Math.min(5, config.perTradeUsd), notional * privateEdge.sizeMultiplier),
    );
    if (session.notionalUsd + notional > config.maxSessionNotionalUsd) {
      skips.push(skip(`session notional budget exhausted ($${session.notionalUsd.toFixed(0)}/$${config.maxSessionNotionalUsd})`, sig));
      continue;
    }
    const size = Math.max(1, Math.floor(notional / price));

    const sampled = arm?.sampled ?? 0.5;
    // proven strategies float up the ranking by their Wilson floor; unproven
    // ones get a neutral 0.75 so exploration survives without outranking
    // anything with a demonstrated win rate above ~50%
    const provenBoost =
      hr && hr.n >= GOVERNOR_MIN_SAMPLES ? 0.5 + hr.wilsonLo : 0.75;
    candidates.push({
      strategy: sig.strategy,
      signal: sig,
      rank: sampled * (sig.score / 100) * provenBoost * privateEdge.rankMultiplier,
      proposal: {
        conditionId: sig.conditionId,
        tokenId,
        outcome: buyYes ? "Yes" : "No",
        marketTitle: market.question,
        category: market.category,
        side: "BUY",
        orderType: "limit",
        price: Number(price.toFixed(3)),
        size,
        winProbability: sizingWinProb,
        signalScore: sig.score,
        signalId: sig.id,
      },
    });
  }

  // Thompson ranking: sampled win-prob × normalized score, best first
  candidates.sort((a, b) => b.rank - a.rank);
  // one entry per market per tick; cap remaining room
  const room = Math.min(
    config.maxOpenPositions - managed.length,
    config.maxTradesPerHour - session.tradesLastHour,
  );
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const k = c.proposal.conditionId ?? c.proposal.tokenId;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // enforce the session notional budget across THIS TICK's accepted set —
  // the per-candidate check above compares against the static pre-tick
  // figure, which would let N candidates each "fit" into the same last
  // dollar and overshoot by (maxOpenPositions−1) × perTradeUsd
  let projected = session.notionalUsd;
  const accepted: EntryCandidate[] = [];
  for (const c of unique.slice(0, Math.max(0, room))) {
    const notional = c.proposal.price * c.proposal.size;
    if (projected + notional > config.maxSessionNotionalUsd) {
      skips.push(
        skip(
          `session notional budget exhausted within tick ($${projected.toFixed(0)} + $${notional.toFixed(0)} > $${config.maxSessionNotionalUsd})`,
          c.signal,
        ),
      );
      continue;
    }
    projected += notional;
    accepted.push(c);
  }

  return { candidates: accepted, skips };
}
