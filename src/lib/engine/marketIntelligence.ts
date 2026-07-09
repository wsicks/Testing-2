import type { AppSettings, NormalizedMarket, OrderBookData, RecentTrade, SignalDirection } from "@/lib/types";
import { estimateLimitFillProbability, type FillProbabilityEstimate } from "./execution/fillProbability";
import { analyzeBookReactor, type BookReactorSnapshot } from "./micro/orderbookReactor";

export interface SignalExecutionQuality {
  fillProbability: number;
  expectedWaitMs: number;
  adverseSelectionRisk: number;
  quoteStability: number;
  spoofRisk: number;
  bookPressure: number;
  reasons: string[];
}

export interface MarketIntelligence {
  reactor: BookReactorSnapshot;
  makerBuyYes: FillProbabilityEstimate;
  makerSellYes: FillProbabilityEstimate;
  executionQuality: {
    buyYes: SignalExecutionQuality;
    buyNo: SignalExecutionQuality;
  };
}

export interface MarketIntelligenceInput {
  market: NormalizedMarket;
  book?: OrderBookData;
  previousBook?: OrderBookData;
  trades?: RecentTrade[];
  settings: AppSettings;
  now?: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function qualityFromFill(
  fill: FillProbabilityEstimate,
  reactor: BookReactorSnapshot,
  sideMultiplier: 1 | -1,
): SignalExecutionQuality {
  const pressure = clamp(reactor.bookPressure * sideMultiplier, -1, 1);
  const adverseSelectionRisk = clamp(fill.adverseSelectionRisk + Math.max(0, -pressure) * 0.2, 0, 1);
  return {
    fillProbability: fill.probability,
    expectedWaitMs: fill.expectedWaitMs,
    adverseSelectionRisk,
    quoteStability: reactor.quoteStability,
    spoofRisk: reactor.spoofRisk,
    bookPressure: pressure,
    reasons: [...new Set([...fill.reasons, ...reactor.notes])],
  };
}

export function buildMarketIntelligence(input: MarketIntelligenceInput): MarketIntelligence | undefined {
  const { market, book, previousBook, trades = [], settings, now = Date.now() } = input;
  if (!book || market.outcomeType === "asset") return undefined;
  const reactor = analyzeBookReactor({ book, previous: previousBook, trades, now });
  const tick = market.tickSize ?? 0.01;
  const makerBuyPrice =
    book.bestBid !== undefined && book.bestAsk !== undefined && book.bestAsk - book.bestBid > tick
      ? Math.min(book.bestAsk - tick, Math.max(book.bestBid + tick, book.midpoint ?? market.midpoint ?? book.bestBid))
      : book.bestAsk ?? market.yesPrice ?? market.midpoint ?? 0.5;
  const makerSellPrice =
    book.bestBid !== undefined && book.bestAsk !== undefined && book.bestAsk - book.bestBid > tick
      ? Math.max(book.bestBid + tick, Math.min(book.bestAsk - tick, book.midpoint ?? market.midpoint ?? book.bestAsk))
      : book.bestBid ?? market.yesPrice ?? market.midpoint ?? 0.5;
  const size = Math.max(1, Math.floor(settings.autopilot.perTradeUsd / Math.max(0.01, makerBuyPrice)));
  const ttlMs = Math.max(30_000, settings.autopilot.makerRestMin * 60_000);
  const makerBuyYes = estimateLimitFillProbability({
    proposal: { side: "BUY", orderType: "limit", price: makerBuyPrice, size },
    book,
    trades,
    reactor,
    now,
    ttlMs,
  });
  const makerSellYes = estimateLimitFillProbability({
    proposal: { side: "SELL", orderType: "limit", price: makerSellPrice, size },
    book,
    trades,
    reactor,
    now,
    ttlMs,
  });

  return {
    reactor,
    makerBuyYes,
    makerSellYes,
    executionQuality: {
      buyYes: qualityFromFill(makerBuyYes, reactor, 1),
      buyNo: qualityFromFill(makerSellYes, reactor, -1),
    },
  };
}

export function executionQualityForDirection(
  intelligence: MarketIntelligence | undefined,
  direction: SignalDirection,
): SignalExecutionQuality | undefined {
  if (!intelligence) return undefined;
  if (direction === "BUY_YES") return intelligence.executionQuality.buyYes;
  if (direction === "BUY_NO") return intelligence.executionQuality.buyNo;
  return undefined;
}

export function compactExecutionQuality(q: SignalExecutionQuality): SignalExecutionQuality {
  return {
    fillProbability: q.fillProbability,
    expectedWaitMs: q.expectedWaitMs,
    adverseSelectionRisk: q.adverseSelectionRisk,
    quoteStability: q.quoteStability,
    spoofRisk: q.spoofRisk,
    bookPressure: q.bookPressure,
    reasons: q.reasons.slice(0, 4),
  };
}
