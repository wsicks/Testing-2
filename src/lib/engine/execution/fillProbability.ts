import type { OrderBookData, RecentTrade, TradeProposal } from "@/lib/types";
import type { BookReactorSnapshot } from "../micro/orderbookReactor";

export interface FillProbabilityInput {
  proposal: Pick<TradeProposal, "side" | "orderType" | "price" | "size">;
  book?: OrderBookData;
  trades?: RecentTrade[];
  reactor?: BookReactorSnapshot;
  now?: number;
  ttlMs?: number;
}

export interface FillProbabilityEstimate {
  probability: number;
  queueAheadShares: number;
  queueAheadUsd: number;
  expectedWaitMs: number;
  tradeIntensitySharesPerMin: number;
  adverseSelectionRisk: number;
  liquidityScore: number;
  reasons: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round(n: number, places = 4): number {
  return Number(n.toFixed(places));
}

function recentOppositeFlow(
  proposal: Pick<TradeProposal, "side">,
  trades: RecentTrade[],
  now: number,
): number {
  const desired = proposal.side === "BUY" ? "SELL" : "BUY";
  const recent = trades.filter((trade) => trade.side === desired && now - trade.ts <= 5 * 60_000);
  return recent.reduce((sum, trade) => sum + trade.size, 0) / 5;
}

function queueAheadShares(
  proposal: Pick<TradeProposal, "side" | "price">,
  book: OrderBookData,
): number {
  if (proposal.side === "BUY") {
    if (book.bestAsk !== undefined && proposal.price >= book.bestAsk) return 0;
    const better = book.bids.filter((level) => level.price > proposal.price);
    const same = book.bids.filter((level) => level.price === proposal.price);
    return better.reduce((sum, level) => sum + level.size, 0) + same.reduce((sum, level) => sum + level.size, 0) * 0.5;
  }
  if (book.bestBid !== undefined && proposal.price <= book.bestBid) return 0;
  const better = book.asks.filter((level) => level.price < proposal.price);
  const same = book.asks.filter((level) => level.price === proposal.price);
  return better.reduce((sum, level) => sum + level.size, 0) + same.reduce((sum, level) => sum + level.size, 0) * 0.5;
}

function touchDistancePenalty(
  proposal: Pick<TradeProposal, "side" | "price" | "orderType">,
  book: OrderBookData,
): number {
  if (proposal.orderType === "market") return 0;
  const spread = Math.max(0.001, book.spread ?? 0.01);
  if (proposal.side === "BUY") {
    if (book.bestAsk !== undefined && proposal.price >= book.bestAsk) return 0;
    const dist = Math.max(0, (book.bestAsk ?? proposal.price + spread) - proposal.price);
    return clamp(dist / spread, 0, 2);
  }
  if (book.bestBid !== undefined && proposal.price <= book.bestBid) return 0;
  const dist = Math.max(0, proposal.price - (book.bestBid ?? proposal.price - spread));
  return clamp(dist / spread, 0, 2);
}

export function estimateLimitFillProbability(input: FillProbabilityInput): FillProbabilityEstimate {
  const { proposal, book, trades = [], now = Date.now(), ttlMs = 5 * 60_000, reactor } = input;
  if (!book?.bestAsk || !book.bestBid) {
    return {
      probability: 0.35,
      queueAheadShares: 0,
      queueAheadUsd: 0,
      expectedWaitMs: ttlMs * 2,
      tradeIntensitySharesPerMin: 0,
      adverseSelectionRisk: 0.5,
      liquidityScore: 0,
      reasons: ["book_unavailable"],
    };
  }

  const crossing =
    proposal.orderType === "market" ||
    (proposal.side === "BUY" && proposal.price >= book.bestAsk) ||
    (proposal.side === "SELL" && proposal.price <= book.bestBid);
  if (crossing) {
    return {
      probability: 0.97,
      queueAheadShares: 0,
      queueAheadUsd: 0,
      expectedWaitMs: 0,
      tradeIntensitySharesPerMin: 0,
      adverseSelectionRisk: round(clamp((reactor?.spoofRisk ?? 0) * 0.35, 0, 0.5)),
      liquidityScore: 1,
      reasons: ["crosses_touch"],
    };
  }

  const queueShares = queueAheadShares(proposal, book);
  const queueUsd = queueShares * proposal.price;
  const oppositeFlowPerMin = recentOppositeFlow(proposal, trades, now);
  const syntheticFlow = Math.max(oppositeFlowPerMin, proposal.size * 0.08);
  const expectedWaitMs = ((queueShares + proposal.size * 0.5) / Math.max(1e-6, syntheticFlow)) * 60_000;
  const timeProbability = 1 - Math.exp(-ttlMs / Math.max(1, expectedWaitMs));
  const distancePenalty = touchDistancePenalty(proposal, book) * 0.18;
  const pressure = reactor?.bookPressure ?? 0;
  const pressureAgainst =
    proposal.side === "BUY" ? Math.max(0, -pressure) : Math.max(0, pressure);
  const adverseSelectionRisk = clamp(
    (reactor?.spoofRisk ?? 0.15) * 0.45 +
      pressureAgainst * 0.35 +
      distancePenalty,
    0,
    0.95,
  );
  const liquidityScore = clamp((book.bidDepthUsd + book.askDepthUsd) / Math.max(1, proposal.price * proposal.size * 20), 0, 1);
  const probability = clamp(timeProbability * (0.65 + 0.35 * liquidityScore) * (1 - adverseSelectionRisk * 0.6), 0.02, 0.95);
  const reasons: string[] = [];
  if (probability < 0.25) reasons.push("low_fill_probability");
  if (adverseSelectionRisk > 0.55) reasons.push("adverse_selection");
  if ((reactor?.quoteStability ?? 1) < 0.65) reasons.push("unstable_quotes");
  if (oppositeFlowPerMin <= 0) reasons.push("no_recent_opposite_flow");

  return {
    probability: round(probability),
    queueAheadShares: round(queueShares, 2),
    queueAheadUsd: round(queueUsd, 2),
    expectedWaitMs: Math.round(expectedWaitMs),
    tradeIntensitySharesPerMin: round(oppositeFlowPerMin, 2),
    adverseSelectionRisk: round(adverseSelectionRisk),
    liquidityScore: round(liquidityScore),
    reasons,
  };
}
