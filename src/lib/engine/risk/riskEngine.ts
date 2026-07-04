// Risk engine — evaluates every proposed trade against portfolio limits,
// market microstructure and data quality. Pure function: same inputs, same
// verdict. Every rejection carries an explicit reason.

import type {
  AppSettings,
  NormalizedMarket,
  OrderBookData,
  PortfolioState,
  RiskAssessment,
  RiskCheck,
  RiskLevel,
  TradeProposal,
} from "@/lib/types";
import { clamp } from "@/lib/format";
import { cappedKelly, kellyFraction } from "./kelly";
import { resolutionClarity } from "../signals/closingSoon";

function rc(
  name: string,
  passed: boolean,
  detail: string,
  severity: "block" | "warn",
  value?: number,
  limit?: number,
): RiskCheck {
  return { name, passed, detail, severity, value, limit };
}

export interface RiskEngineInput {
  proposal: TradeProposal;
  portfolio: PortfolioState;
  settings: AppSettings;
  market?: NormalizedMarket;
  book?: OrderBookData;
  now?: number;
}

export function estimateFillProbability(
  proposal: TradeProposal,
  book: OrderBookData | undefined,
): number {
  if (!book?.bestAsk || !book?.bestBid) return 0.5;
  if (proposal.side === "BUY") {
    if (proposal.orderType === "market" || proposal.price >= book.bestAsk) return 0.95;
    const dist = book.bestAsk - proposal.price;
    const spread = Math.max(0.001, book.spread ?? 0.01);
    return clamp(0.85 - (dist / spread) * 0.35, 0.05, 0.9);
  }
  if (proposal.orderType === "market" || proposal.price <= book.bestBid) return 0.95;
  const dist = proposal.price - book.bestBid;
  const spread = Math.max(0.001, book.spread ?? 0.01);
  return clamp(0.85 - (dist / spread) * 0.35, 0.05, 0.9);
}

/** slippage (price units) from walking the book for `size` shares */
export function estimateSlippage(
  proposal: TradeProposal,
  book: OrderBookData | undefined,
): number {
  if (!book) return 0.01;
  const levels = proposal.side === "BUY" ? book.asks : book.bids;
  if (!levels.length) return 0.05;
  let remaining = proposal.size;
  let cost = 0;
  for (const l of levels) {
    const take = Math.min(remaining, l.size);
    cost += take * l.price;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return 0.05; // book too thin — punitive estimate
  const avg = cost / proposal.size;
  const ref = proposal.side === "BUY" ? levels[0].price : levels[0].price;
  return Math.abs(avg - ref);
}

export function evaluateTrade(input: RiskEngineInput): RiskAssessment {
  const { proposal, portfolio, settings, market, book } = input;
  const now = input.now ?? Date.now();
  const checks: RiskCheck[] = [];
  const reasons: string[] = [];

  const entryPrice = proposal.price;
  const notionalUsd = entryPrice * proposal.size;
  const feeRate = settings.feeRateBps / 10_000;
  const fee = notionalUsd * feeRate;
  const estCostUsd = proposal.side === "BUY" ? notionalUsd + fee : 0;

  // ── data quality ────────────────────────────────────────────────────────
  checks.push(
    rc(
      "kill_switch",
      !settings.killSwitch,
      settings.killSwitch
        ? "KILL SWITCH is engaged — all trading disabled"
        : "Kill switch disengaged",
      "block",
    ),
  );

  const ageSecs = market ? (now - market.fetchedAt) / 1000 : Infinity;
  checks.push(
    rc(
      "data_freshness",
      ageSecs <= settings.staleDataMaxSecs,
      market
        ? `Market data is ${ageSecs.toFixed(0)}s old (max ${settings.staleDataMaxSecs}s)`
        : "No market data attached to proposal",
      "block",
      ageSecs === Infinity ? undefined : ageSecs,
      settings.staleDataMaxSecs,
    ),
  );

  checks.push(
    rc(
      "price_bounds",
      entryPrice >= 0.01 && entryPrice <= 0.99,
      `Entry ${(entryPrice * 100).toFixed(1)}c must be within 1c–99c`,
      "block",
      entryPrice,
    ),
  );

  // ── microstructure ──────────────────────────────────────────────────────
  const spread = book?.spread ?? market?.spread;
  checks.push(
    rc(
      "spread_limit",
      spread !== undefined && spread <= settings.maxSpread,
      spread === undefined
        ? "Spread unavailable"
        : `Spread ${(spread * 100).toFixed(1)}c vs max ${(settings.maxSpread * 100).toFixed(1)}c`,
      "block",
      spread,
      settings.maxSpread,
    ),
  );

  const liquidity = market?.liquidity ?? 0;
  checks.push(
    rc(
      "liquidity_floor",
      liquidity >= settings.minLiquidityUsd,
      `Liquidity $${Math.round(liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
      "block",
      liquidity,
      settings.minLiquidityUsd,
    ),
  );

  const clarity = resolutionClarity(market?.description);
  checks.push(
    rc(
      "resolution_clarity",
      clarity.level !== "low",
      `Resolution clarity ${clarity.level.toUpperCase()}: ${clarity.reason}`,
      "block",
    ),
  );

  // ── slippage & fill ─────────────────────────────────────────────────────
  const slippageEstimate = estimateSlippage(proposal, book);
  const slippageBuffer = settings.slippageBps / 10_000;
  checks.push(
    rc(
      "slippage",
      slippageEstimate <= Math.max(slippageBuffer, 0.02),
      `Estimated slippage ${(slippageEstimate * 100).toFixed(2)}c vs budget ${(Math.max(slippageBuffer, 0.02) * 100).toFixed(2)}c`,
      "warn",
      slippageEstimate,
      Math.max(slippageBuffer, 0.02),
    ),
  );
  const expectedFillProbability = estimateFillProbability(proposal, book);

  // ── edge / EV ───────────────────────────────────────────────────────────
  const implied = book?.midpoint ?? market?.midpoint ?? entryPrice;
  const winProb = proposal.winProbability ?? implied;
  const usedImplied = proposal.winProbability === undefined;
  const grossEdge =
    proposal.side === "BUY" ? winProb - entryPrice : entryPrice - winProb;
  const requiredEdge = (spread ?? 0.01) / 2 + feeRate + slippageBuffer;
  const netEdge = grossEdge - requiredEdge;
  // EV per share for BUY: q(1-p) - (1-q)p - costs
  const evPerShare =
    proposal.side === "BUY"
      ? winProb * (1 - entryPrice) - (1 - winProb) * entryPrice - entryPrice * feeRate
      : grossEdge - entryPrice * feeRate;
  const expectedValueUsd = evPerShare * proposal.size;
  checks.push(
    rc(
      "positive_net_edge",
      netEdge > 0,
      usedImplied
        ? `No win-probability estimate supplied — using market-implied ${(implied * 100).toFixed(1)}%; net edge after costs is ${(netEdge * 100).toFixed(2)}c (market price alone carries no edge)`
        : `Net edge ${(netEdge * 100).toFixed(2)}c after required ${(requiredEdge * 100).toFixed(2)}c (spread/2 + fees + slippage)`,
      "warn",
      netEdge,
      0,
    ),
  );

  // ── signal quality ──────────────────────────────────────────────────────
  if (proposal.signalScore !== undefined) {
    checks.push(
      rc(
        "signal_score",
        proposal.signalScore >= settings.minSignalScore,
        `Signal score ${proposal.signalScore} vs min ${settings.minSignalScore}`,
        "block",
        proposal.signalScore,
        settings.minSignalScore,
      ),
    );
  } else {
    checks.push(
      rc(
        "signal_score",
        true,
        "Manual trade without an attached signal — extra caution advised",
        "warn",
      ),
    );
  }

  // ── sizing & exposure ───────────────────────────────────────────────────
  const pv = Math.max(1, portfolio.totalValue);
  const maxTradeUsd = Math.min(
    settings.maxTradeUsd,
    (settings.maxTradePct / 100) * pv,
  );
  checks.push(
    rc(
      "trade_size_limit",
      estCostUsd <= maxTradeUsd || proposal.side === "SELL",
      `Cost $${estCostUsd.toFixed(2)} vs per-trade cap $${maxTradeUsd.toFixed(2)} (min of $${settings.maxTradeUsd} and ${settings.maxTradePct}% of portfolio)`,
      "block",
      estCostUsd,
      maxTradeUsd,
    ),
  );

  if (proposal.side === "BUY") {
    checks.push(
      rc(
        "cash_available",
        estCostUsd <= portfolio.cash,
        `Cost $${estCostUsd.toFixed(2)} vs cash $${portfolio.cash.toFixed(2)}`,
        "block",
        estCostUsd,
        portfolio.cash,
      ),
    );
  } else {
    const held =
      portfolio.positions.find((p) => p.tokenId === proposal.tokenId)?.size ?? 0;
    checks.push(
      rc(
        "position_available",
        held >= proposal.size,
        `Selling ${proposal.size} shares vs held ${held}`,
        "block",
        held,
        proposal.size,
      ),
    );
  }

  // daily loss budget
  const dailyLossUsed = Math.max(0, -portfolio.dailyRealizedPnl);
  const maxLossUsd = proposal.side === "BUY" ? estCostUsd : 0;
  checks.push(
    rc(
      "daily_loss_budget",
      dailyLossUsed + maxLossUsd <= settings.maxDailyLossUsd,
      `Worst case adds $${maxLossUsd.toFixed(2)} to $${dailyLossUsed.toFixed(2)} realized daily loss (budget $${settings.maxDailyLossUsd})`,
      "block",
      dailyLossUsed + maxLossUsd,
      settings.maxDailyLossUsd,
    ),
  );

  // exposure after trade
  const deltaExposure = proposal.side === "BUY" ? notionalUsd : -notionalUsd;
  const exposureAfter = Math.max(0, portfolio.exposure + deltaExposure);
  const exposureAfterPct = (exposureAfter / pv) * 100;

  const mktKey = proposal.conditionId ?? proposal.tokenId;
  const mktExposure = (portfolio.exposureByMarket[mktKey] ?? 0) + deltaExposure;
  const marketExposureAfterPct = (Math.max(0, mktExposure) / pv) * 100;
  checks.push(
    rc(
      "market_exposure",
      marketExposureAfterPct <= settings.maxMarketExposurePct,
      `Market exposure after trade ${marketExposureAfterPct.toFixed(2)}% vs cap ${settings.maxMarketExposurePct}%`,
      "block",
      marketExposureAfterPct,
      settings.maxMarketExposurePct,
    ),
  );

  const cat = proposal.category ?? market?.category ?? "Uncategorized";
  const catExposure = (portfolio.exposureByCategory[cat] ?? 0) + deltaExposure;
  const categoryExposureAfterPct = (Math.max(0, catExposure) / pv) * 100;
  checks.push(
    rc(
      "category_exposure",
      categoryExposureAfterPct <= settings.maxCategoryExposurePct,
      `"${cat}" exposure after trade ${categoryExposureAfterPct.toFixed(2)}% vs cap ${settings.maxCategoryExposurePct}%`,
      "block",
      categoryExposureAfterPct,
      settings.maxCategoryExposurePct,
    ),
  );

  // liquidity exit risk: order size vs near-mid depth on the exit side
  let liquidityExitRisk: RiskLevel = "medium";
  if (book) {
    const exitDepth = proposal.side === "BUY" ? book.bidDepthUsd : book.askDepthUsd;
    const ratio = exitDepth > 0 ? notionalUsd / exitDepth : Infinity;
    liquidityExitRisk = ratio < 0.1 ? "low" : ratio < 0.25 ? "medium" : "high";
    checks.push(
      rc(
        "liquidity_exit_risk",
        ratio < 0.25,
        `Position is ${(ratio * 100).toFixed(1)}% of near-mid exit depth ($${Math.round(exitDepth).toLocaleString()})`,
        ratio < 0.5 ? "warn" : "block",
        ratio,
        0.25,
      ),
    );
  }

  // ── Kelly sizing ────────────────────────────────────────────────────────
  const fullKelly = kellyFraction(winProb, entryPrice);
  const capped = cappedKelly(
    winProb,
    entryPrice,
    settings.kellyCap,
    settings.maxTradePct / 100,
  );
  const suggestedSizeUsd = usedImplied ? 0 : Math.min(capped * pv, maxTradeUsd);
  const suggestedShares =
    entryPrice > 0 ? Math.floor(suggestedSizeUsd / entryPrice) : 0;

  const targetPrice =
    proposal.targetPrice ??
    (proposal.side === "BUY"
      ? clamp(entryPrice + Math.max(0.05, 2 * requiredEdge), 0.01, 0.99)
      : clamp(entryPrice - Math.max(0.05, 2 * requiredEdge), 0.01, 0.99));
  const stopPrice =
    proposal.stopPrice ??
    (proposal.side === "BUY"
      ? clamp(entryPrice - 0.1, 0.01, 0.99)
      : clamp(entryPrice + 0.1, 0.01, 0.99));

  const blockers = checks.filter((c) => c.severity === "block" && !c.passed);
  const warns = checks.filter((c) => c.severity === "warn" && !c.passed);
  for (const b of blockers) reasons.push(`BLOCKED — ${b.name}: ${b.detail}`);
  for (const w of warns) reasons.push(`WARN — ${w.name}: ${w.detail}`);
  if (blockers.length === 0)
    reasons.unshift(
      `Approved: ${checks.filter((c) => c.passed).length}/${checks.length} checks passed${warns.length ? `, ${warns.length} warning(s)` : ""}`,
    );

  return {
    approved: blockers.length === 0,
    checks,
    entryPrice,
    targetPrice,
    stopPrice,
    notionalUsd,
    estCostUsd,
    maxLossUsd,
    expectedValueUsd,
    requiredEdge,
    grossEdge,
    netEdge,
    kellyFraction: fullKelly,
    cappedKellyFraction: capped,
    suggestedSizeUsd,
    suggestedShares,
    expectedFillProbability,
    slippageEstimate,
    portfolioValue: pv,
    exposureAfterPct,
    marketExposureAfterPct,
    categoryExposureAfterPct,
    liquidityExitRisk,
    resolutionAmbiguityRisk: clarity.level === "high" ? "low" : clarity.level === "medium" ? "medium" : "high",
    reasons,
  };
}
