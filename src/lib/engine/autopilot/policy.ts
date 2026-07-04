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
  now: number;
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
    if (!sig.conditionId || heldConditions.has(sig.conditionId)) {
      if (sig.conditionId) skips.push(skip("already holding a managed position in this market", sig));
      continue;
    }
    const market = markets.get(sig.conditionId);
    if (!market) continue;

    const regime = regimes.get(sig.conditionId) ?? "unknown";
    if (config.requireRegimeMatch && !regimeAllows(sig.strategy, regime)) {
      skips.push(skip(`regime ${regime.toUpperCase()} does not fit ${sig.strategy}`, sig));
      continue;
    }

    // side & price: buy the signaled outcome token at (near) the ask
    const buyYes = sig.direction === "BUY_YES";
    const tokenId = buyYes ? market.yesTokenId : market.noTokenId;
    if (!tokenId) continue;
    const yesAsk = market.bestAsk ?? market.yesPrice;
    const price = buyYes
      ? yesAsk
      : market.bestBid !== undefined
        ? 1 - market.bestBid // NO ask implied by the YES bid
        : market.noPrice;
    if (price === undefined || price <= 0.02 || price >= 0.98) {
      skips.push(skip("no viable entry price inside the tradable band", sig));
      continue;
    }

    const modelWinProb =
      typeof sig.meta?.modelWinProb === "number"
        ? (sig.meta.modelWinProb as number)
        : undefined;

    // sizing: uncertainty-shrunk Kelly when the strategy provides a model
    // probability, else the flat per-trade budget; always capped by config
    const arm = sampledByStrategy.get(sig.strategy);
    let notional = config.perTradeUsd;
    if (modelWinProb !== undefined) {
      const frac = shrunkKelly(
        modelWinProb,
        price,
        { wins: arm?.wins ?? 0, losses: arm?.losses ?? 0 },
        input.settings.kellyCap,
        input.settings.maxTradePct / 100,
      );
      const kellyUsd = frac * Math.max(1, input.portfolio.totalValue);
      notional = Math.min(config.perTradeUsd, Math.max(5, kellyUsd));
    }
    if (session.notionalUsd + notional > config.maxSessionNotionalUsd) {
      skips.push(skip(`session notional budget exhausted ($${session.notionalUsd.toFixed(0)}/$${config.maxSessionNotionalUsd})`, sig));
      continue;
    }
    const size = Math.max(1, Math.floor(notional / price));

    const sampled = arm?.sampled ?? 0.5;
    candidates.push({
      strategy: sig.strategy,
      signal: sig,
      rank: sampled * (sig.score / 100),
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
        winProbability: modelWinProb,
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

  return { candidates: unique.slice(0, Math.max(0, room)), skips };
}
