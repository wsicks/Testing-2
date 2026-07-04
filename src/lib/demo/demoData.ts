// Demo-mode sample data. EVERYTHING here is deterministic, seeded and
// intentionally unimpressive (flat-to-slightly-negative sample PnL) so it can
// never be mistaken for — or presented as — real account performance.
// Consumers must surface the isSample/SAMPLE labels attached here.

import { mulberry32, gaussian } from "@/lib/rng";
import type {
  FillRecord,
  NormalizedMarket,
  OrderBookData,
  PaperOrder,
  PortfolioState,
  PositionRecord,
  PricePoint,
} from "@/lib/types";
import { genId } from "@/lib/utils";

export const DEMO_SEED = 424242;
export const SAMPLE_LABEL = "SAMPLE — not real performance";

/** Mock markets used ONLY when the Gamma API is unreachable. */
export function mockMarkets(now = Date.now()): NormalizedMarket[] {
  const rand = mulberry32(DEMO_SEED);
  const defs = [
    { q: "MOCK: Will the example index close above 5,000?", cat: "Mock Finance", days: 12 },
    { q: "MOCK: Will Team Alpha win the sample final?", cat: "Mock Sports", days: 3 },
    { q: "MOCK: Will the placeholder bill pass this quarter?", cat: "Mock Politics", days: 30 },
    { q: "MOCK: Will testnet volume exceed 1M units?", cat: "Mock Crypto", days: 1.5 },
    { q: "MOCK: Will the demo satellite launch on schedule?", cat: "Mock Science", days: 20 },
    { q: "MOCK: Sample tournament — over 10 goals scored?", cat: "Mock Sports", days: 0.8 },
  ];
  return defs.map((d, i) => {
    const yes = 0.15 + rand() * 0.7;
    const spread = 0.005 + rand() * 0.03;
    return {
      conditionId: `0xmock${i}`,
      question: d.q,
      eventTitle: d.q.replace("MOCK: ", "MOCK EVENT: "),
      description:
        "Mock market generated for demo mode. This market will resolve to 'Yes' if the placeholder condition is met according to the sample resolution source.",
      category: d.cat,
      tags: [d.cat, "Mock"],
      endDate: new Date(now + d.days * 86_400_000).toISOString(),
      startDate: new Date(now - 10 * 86_400_000).toISOString(),
      active: true,
      closed: false,
      negRisk: false,
      liquidity: 2_000 + Math.round(rand() * 80_000),
      volume24h: 500 + Math.round(rand() * 40_000),
      volumeTotal: 10_000 + Math.round(rand() * 900_000),
      outcomes: [
        { tokenId: `mocktok${i}y`, label: "Yes", price: yes },
        { tokenId: `mocktok${i}n`, label: "No", price: 1 - yes },
      ],
      yesTokenId: `mocktok${i}y`,
      noTokenId: `mocktok${i}n`,
      yesPrice: yes,
      noPrice: 1 - yes,
      bestBid: yes - spread / 2,
      bestAsk: yes + spread / 2,
      spread,
      midpoint: yes,
      oneDayPriceChange: (rand() - 0.5) * 0.1,
      oneHourPriceChange: (rand() - 0.5) * 0.02,
      isNew: i === 3,
      source: "mock",
      fetchedAt: now,
    };
  });
}

/** Mock order book for offline demo — labeled by source: "mock". */
export function mockOrderBook(tokenId: string, mid = 0.5, now = Date.now()): OrderBookData {
  const rand = mulberry32(hashCode(tokenId) ^ DEMO_SEED);
  const bids = [];
  const asks = [];
  let bp = mid - 0.005;
  let ap = mid + 0.005;
  for (let i = 0; i < 12; i++) {
    bids.push({ price: Number(bp.toFixed(3)), size: Math.round(50 + rand() * 4000) });
    asks.push({ price: Number(ap.toFixed(3)), size: Math.round(50 + rand() * 4000) });
    bp -= 0.002 + rand() * 0.01;
    ap += 0.002 + rand() * 0.01;
    if (bp <= 0.01 || ap >= 0.99) break;
  }
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint: mid,
    spread: bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined,
    bidDepthUsd: bids.reduce((a, l) => a + l.price * l.size, 0),
    askDepthUsd: asks.reduce((a, l) => a + l.price * l.size, 0),
    ts: now,
    source: "mock",
  };
}

export function mockPriceHistory(
  tokenId: string,
  bars = 96,
  endTs = Math.floor(Date.now() / 1000),
): PricePoint[] {
  const rand = mulberry32(hashCode(tokenId) ^ 0x9e3779b9);
  let p = 0.2 + rand() * 0.6;
  const out: PricePoint[] = [];
  for (let i = bars - 1; i >= 0; i--) {
    p = Math.min(0.97, Math.max(0.03, p + gaussian(rand) * 0.012));
    out.push({ t: endTs - i * 1800, p: Number(p.toFixed(3)) });
  }
  return out;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export interface DemoAccount {
  positions: PositionRecord[];
  fills: FillRecord[];
  orders: PaperOrder[];
  portfolio: PortfolioState;
  equitySeries: { t: number; equity: number }[];
}

/**
 * Sample demo account: a handful of small positions and a slightly-negative
 * equity path. Deliberately unremarkable — demo mode must never look like a
 * track record.
 */
export function demoAccount(markets: NormalizedMarket[], now = Date.now()): DemoAccount {
  const rand = mulberry32(DEMO_SEED);
  const startingCash = 10_000;
  const picks = markets.slice(0, 4);

  const positions: PositionRecord[] = picks.map((m, i) => {
    const size = Math.round(20 + rand() * 120);
    const mark = m.yesPrice ?? 0.5;
    const avg = Math.min(0.95, Math.max(0.05, mark + (rand() - 0.45) * 0.06));
    return {
      tokenId: m.yesTokenId ?? `demo${i}`,
      mode: "demo",
      conditionId: m.conditionId,
      outcome: "Yes",
      marketTitle: m.question,
      category: m.category,
      size,
      avgPrice: Number(avg.toFixed(3)),
      realizedPnl: Number(((rand() - 0.55) * 18).toFixed(2)),
      updatedAt: now - Math.round(rand() * 86_400_000),
      markPrice: mark,
      unrealizedPnl: Number(((mark - avg) * size).toFixed(2)),
      value: Number((mark * size).toFixed(2)),
    };
  });

  const fills: FillRecord[] = positions.flatMap((p) => [
    {
      id: genId("fill"),
      mode: "demo" as const,
      tokenId: p.tokenId,
      outcome: p.outcome,
      marketTitle: p.marketTitle,
      category: p.category,
      conditionId: p.conditionId,
      side: "BUY" as const,
      price: p.avgPrice,
      size: p.size,
      fee: 0,
      ts: p.updatedAt - 3_600_000,
    },
  ]);

  const orders: PaperOrder[] = picks.slice(0, 2).map((m, i) => ({
    id: genId("dord"),
    mode: "demo",
    conditionId: m.conditionId,
    tokenId: m.yesTokenId ?? `demo${i}`,
    outcome: "Yes",
    marketTitle: m.question,
    category: m.category,
    side: "BUY",
    orderType: "limit",
    price: Number(Math.max(0.02, (m.bestBid ?? 0.4) - 0.02).toFixed(3)),
    size: 50,
    filledSize: 0,
    status: "open",
    reason: "sample resting order",
    createdAt: now - 7_200_000,
    updatedAt: now - 7_200_000,
    expiresAt: now + 86_400_000,
  }));

  // sample equity path: 30 days, mild noise, slight net-negative drift
  const equitySeries: { t: number; equity: number }[] = [];
  let eq = startingCash;
  for (let d = 30; d >= 0; d--) {
    eq = eq * (1 + gaussian(rand) * 0.004 - 0.0006);
    equitySeries.push({ t: now - d * 86_400_000, equity: Number(eq.toFixed(2)) });
  }
  const equity = equitySeries[equitySeries.length - 1].equity;
  const positionsValue = positions.reduce((a, p) => a + (p.value ?? 0), 0);
  const unrealized = positions.reduce((a, p) => a + (p.unrealizedPnl ?? 0), 0);
  const realized = positions.reduce((a, p) => a + p.realizedPnl, 0);
  const exposureByMarket: Record<string, number> = {};
  const exposureByCategory: Record<string, number> = {};
  for (const p of positions) {
    exposureByMarket[p.conditionId ?? p.tokenId] = p.value ?? 0;
    exposureByCategory[p.category ?? "Uncategorized"] =
      (exposureByCategory[p.category ?? "Uncategorized"] ?? 0) + (p.value ?? 0);
  }
  let peak = -Infinity;
  let maxDd = 0;
  for (const pt of equitySeries) {
    peak = Math.max(peak, pt.equity);
    maxDd = Math.max(maxDd, (peak - pt.equity) / peak);
  }

  const portfolio: PortfolioState = {
    mode: "demo",
    cash: Number((equity - positionsValue).toFixed(2)),
    totalValue: equity,
    exposure: Number(positionsValue.toFixed(2)),
    positions,
    exposureByMarket,
    exposureByCategory,
    realizedPnl: Number(realized.toFixed(2)),
    unrealizedPnl: Number(unrealized.toFixed(2)),
    dailyPnl: Number((equity - equitySeries[equitySeries.length - 2].equity).toFixed(2)),
    dailyRealizedPnl: 0,
    allTimePnl: Number((equity - startingCash + unrealized).toFixed(2)),
    winRate: 0.44, // sample value — labeled
    avgRR: 0.9,
    maxDrawdown: Number(maxDd.toFixed(4)),
    liquidityRiskScore: 0.32,
    closedTrades: 9,
    isSample: true,
  };

  return { positions, fills, orders, portfolio, equitySeries };
}
