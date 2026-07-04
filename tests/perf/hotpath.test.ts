// Hot-path performance benchmarks — enforce the <20ms p95 internal budget.
//
// These run against the same pure functions the server uses (scanner
// filter/sort, risk evaluation, signal scoring, registry-style ingest), on
// synthetic universes of 1,000 and 10,000 markets, plus update-rate
// simulations at 100 and 1,000 updates/second equivalents. External API
// latency is explicitly out of scope here — that's upstream infrastructure.

import { describe, expect, it } from "vitest";
import { filterSortMarkets, type SignalJoin } from "@/lib/scannerQuery";
import { evaluateTrade } from "@/lib/engine/risk/riskEngine";
import { runAllStrategies } from "@/lib/engine/signals/registry";
import { kalmanFilter } from "@/lib/engine/micro/kalman";
import { mulberry32 } from "@/lib/rng";
import type { NormalizedMarket, PricePoint } from "@/lib/types";
import { makeBook, makeMarket, makePortfolio, makeSettings } from "../helpers";

function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)];
}

function bench(iterations: number, fn: () => void): number[] {
  // warmup for JIT
  for (let i = 0; i < 10; i++) fn();
  const out: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

function universe(n: number): NormalizedMarket[] {
  const rand = mulberry32(7);
  const cats = ["Politics", "Sports", "Crypto", "Science", "Culture"];
  return Array.from({ length: n }, (_, i) => {
    const yes = 0.05 + rand() * 0.9;
    return makeMarket({
      conditionId: `0xc${i}`,
      question: `Synthetic market #${i} about topic ${i % 97} outcome ${i % 13}?`,
      category: cats[i % cats.length],
      tags: [cats[i % cats.length]],
      liquidity: rand() * 500_000,
      volume24h: rand() * 1_000_000,
      yesPrice: yes,
      midpoint: yes,
      spread: 0.002 + rand() * 0.08,
      oneDayPriceChange: (rand() - 0.5) * 0.3,
      endDate: new Date(Date.now() + rand() * 90 * 86_400_000).toISOString(),
      yesTokenId: `ty${i}`,
      noTokenId: `tn${i}`,
      outcomes: [
        { tokenId: `ty${i}`, label: "Yes", price: yes },
        { tokenId: `tn${i}`, label: "No", price: 1 - yes },
      ],
    });
  });
}

const BUDGET_MS = 20;

describe("scanner filter/sort under the 20ms budget", () => {
  const signals = new Map<string, SignalJoin>();
  const watchlist = new Set<string>(["0xc1", "0xc5"]);

  for (const size of [1_000, 10_000]) {
    it(`filters + sorts ${size.toLocaleString()} markets in <${BUDGET_MS}ms p95`, () => {
      const markets = universe(size);
      const samples = bench(60, () => {
        filterSortMarkets(
          markets,
          {
            q: "topic 42",
            minLiquidity: 5_000,
            maxSpread: 0.05,
            sort: "volume24h",
            dir: "desc",
            limit: 200,
          },
          signals,
          watchlist,
        );
        filterSortMarkets(
          markets,
          { closingHrs: 72, highMovement: true, sort: "change", dir: "desc", limit: 200 },
          signals,
          watchlist,
        );
      });
      expect(p95(samples)).toBeLessThan(BUDGET_MS);
    });
  }
});

describe("risk engine under the 20ms budget", () => {
  it("evaluates a full order preview risk check in <20ms p95", () => {
    const portfolio = makePortfolio({
      positions: Array.from({ length: 50 }, (_, i) => ({
        tokenId: `t${i}`,
        mode: "paper" as const,
        size: 10,
        avgPrice: 0.5,
        realizedPnl: 0,
        updatedAt: Date.now(),
        category: `cat${i % 8}`,
        value: 5,
      })),
      exposureByMarket: Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`0xm${i}`, 5]),
      ),
      exposureByCategory: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`cat${i}`, 30]),
      ),
    });
    const settings = makeSettings();
    const market = makeMarket();
    const book = makeBook();
    const samples = bench(200, () => {
      evaluateTrade({
        proposal: {
          conditionId: "0xcond1",
          tokenId: "tok-yes",
          side: "BUY",
          orderType: "limit",
          price: 0.56,
          size: 50,
          winProbability: 0.62,
          signalScore: 75,
        },
        portfolio,
        settings,
        market,
        book,
      });
    });
    expect(p95(samples)).toBeLessThan(BUDGET_MS);
  });
});

describe("signal engine under the 20ms budget", () => {
  it("re-scores a single market across all 7 strategies in <20ms p95", () => {
    const rand = mulberry32(3);
    const history: PricePoint[] = Array.from({ length: 200 }, (_, i) => ({
      t: 1_700_000_000 + i * 1800,
      p: Math.min(0.95, Math.max(0.05, 0.5 + (rand() - 0.5) * 0.05)),
    }));
    const related = universe(200); // cross-market scans against 200 candidates
    const market = makeMarket({ oneDayPriceChange: 0.12, volume24h: 400_000 });
    const settings = makeSettings();
    const book = makeBook();
    const samples = bench(100, () => {
      runAllStrategies({
        market,
        book,
        history,
        trades: [],
        relatedMarkets: related,
        settings,
        now: Date.now(),
      });
    });
    expect(p95(samples)).toBeLessThan(BUDGET_MS);
  });

  it("kalman-filters a 200-bar series in <20ms p95", () => {
    const rand = mulberry32(11);
    const series: PricePoint[] = Array.from({ length: 200 }, (_, i) => ({
      t: 1_700_000_000 + i * 1800,
      p: 0.5 + (rand() - 0.5) * 0.04,
    }));
    const samples = bench(200, () => kalmanFilter(series));
    expect(p95(samples)).toBeLessThan(BUDGET_MS);
  });
});

describe("registry-style ingest under sustained update load", () => {
  function ingest(markets: NormalizedMarket[]): void {
    // mirrors the hot-path registry rebuild: three keyed maps + price map
    const byCondition = new Map<string, NormalizedMarket>();
    const byToken = new Map<string, NormalizedMarket>();
    const prices = new Map<string, number>();
    for (const m of markets) {
      byCondition.set(m.conditionId, m);
      for (const o of m.outcomes) {
        byToken.set(o.tokenId, m);
        if (o.price !== undefined) prices.set(o.tokenId, o.price);
      }
    }
    if (byCondition.size !== markets.length) throw new Error("ingest lost rows");
  }

  it("full 10,000-market rebuild in <20ms p95", () => {
    const markets = universe(10_000);
    const samples = bench(40, () => ingest(markets));
    expect(p95(samples)).toBeLessThan(BUDGET_MS);
  });

  it("simulated 1,000 updates/second stays under budget per batch", () => {
    const markets = universe(1_000);
    // 1,000 single-market upserts (≙ 1s of tick load) processed in one pass
    const byToken = new Map<string, NormalizedMarket>();
    const samples = bench(50, () => {
      for (const m of markets) {
        byToken.set(m.yesTokenId!, m);
        byToken.set(m.noTokenId!, m);
      }
    });
    expect(p95(samples)).toBeLessThan(BUDGET_MS);
  });
});
