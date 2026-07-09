import type { OrderBookData, RecentTrade } from "@/lib/types";

export interface BookReactorSnapshot {
  tokenId: string;
  ts: number;
  ageMs: number;
  spread?: number;
  midpoint?: number;
  depthImbalance: number;
  tapeImbalance: number;
  vanishedBidUsd: number;
  vanishedAskUsd: number;
  unexplainedVanishUsd: number;
  quoteStability: number;
  spoofRisk: number;
  bookPressure: number;
  microVolatility: number;
  notes: string[];
}

export interface BookReactorInput {
  book: OrderBookData;
  previous?: OrderBookData;
  trades?: RecentTrade[];
  now?: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round(n: number, places = 4): number {
  return Number(n.toFixed(places));
}

function notional(levels: { price: number; size: number }[]): number {
  return levels.reduce((sum, level) => sum + level.price * level.size, 0);
}

function sideVanishUsd(
  prev: { price: number; size: number }[],
  cur: { price: number; size: number }[],
): number {
  const curByPrice = new Map(cur.map((level) => [level.price, level.size]));
  let vanished = 0;
  for (const level of prev) {
    const nowSize = curByPrice.get(level.price) ?? 0;
    if (nowSize < level.size) vanished += (level.size - nowSize) * level.price;
  }
  return vanished;
}

function tradeUsd(trades: RecentTrade[], side: "BUY" | "SELL", since?: number): number {
  return trades
    .filter((trade) => trade.side === side && (since === undefined || trade.ts >= since))
    .reduce((sum, trade) => sum + trade.price * trade.size, 0);
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  const variance = values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function analyzeBookReactor(input: BookReactorInput): BookReactorSnapshot {
  const { book, previous, trades = [], now = Date.now() } = input;
  const bidUsd = book.bidDepthUsd || notional(book.bids.slice(0, 10));
  const askUsd = book.askDepthUsd || notional(book.asks.slice(0, 10));
  const depthTotal = Math.max(1, bidUsd + askUsd);
  const depthImbalance = (bidUsd - askUsd) / depthTotal;

  const recentTrades = trades.filter((trade) => now - trade.ts <= 5 * 60_000);
  const buyUsd = tradeUsd(recentTrades, "BUY");
  const sellUsd = tradeUsd(recentTrades, "SELL");
  const tapeTotal = Math.max(1, buyUsd + sellUsd);
  const tapeImbalance = (buyUsd - sellUsd) / tapeTotal;

  const vanishedBidUsd = previous ? sideVanishUsd(previous.bids, book.bids) : 0;
  const vanishedAskUsd = previous ? sideVanishUsd(previous.asks, book.asks) : 0;
  const printedSellUsd = tradeUsd(recentTrades, "SELL", previous?.ts);
  const printedBuyUsd = tradeUsd(recentTrades, "BUY", previous?.ts);
  const unexplainedVanishUsd =
    Math.max(0, vanishedBidUsd - printedSellUsd) +
    Math.max(0, vanishedAskUsd - printedBuyUsd);
  const prevDepth = previous
    ? Math.max(1, previous.bidDepthUsd + previous.askDepthUsd)
    : depthTotal;
  const quoteStability = clamp(1 - unexplainedVanishUsd / prevDepth, 0, 1);
  const ageMs = Math.max(0, now - book.ts);
  const stalePenalty = clamp((ageMs - 30_000) / 120_000, 0, 1) * 0.25;
  const vanishPenalty = (1 - quoteStability) * 0.75;
  const spoofRisk = clamp(vanishPenalty + stalePenalty, 0, 1);
  const bookPressure = clamp(0.65 * depthImbalance + 0.35 * tapeImbalance - spoofRisk * 0.25, -1, 1);
  const microVolatility = stdev(recentTrades.map((trade) => trade.price));
  const notes: string[] = [];
  if (quoteStability < 0.65) notes.push("vanishing_depth");
  if (spoofRisk > 0.6) notes.push("fragile_quotes");
  if (Math.abs(bookPressure) > 0.5) notes.push(bookPressure > 0 ? "buy_pressure" : "sell_pressure");
  if (ageMs > 60_000) notes.push("stale_book");

  return {
    tokenId: book.tokenId,
    ts: book.ts,
    ageMs,
    spread: book.spread,
    midpoint: book.midpoint,
    depthImbalance: round(depthImbalance),
    tapeImbalance: round(tapeImbalance),
    vanishedBidUsd: round(vanishedBidUsd, 2),
    vanishedAskUsd: round(vanishedAskUsd, 2),
    unexplainedVanishUsd: round(unexplainedVanishUsd, 2),
    quoteStability: round(quoteStability),
    spoofRisk: round(spoofRisk),
    bookPressure: round(bookPressure),
    microVolatility: round(microVolatility),
    notes,
  };
}
