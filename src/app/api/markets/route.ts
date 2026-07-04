import { NextRequest, NextResponse } from "next/server";
import { gradeMarket } from "@/lib/engine/risk/grade";
import {
  filterSortMarkets,
  type ScannerQuery,
  type SignalJoin,
} from "@/lib/scannerQuery";
import { getMarkets } from "@/server/marketData";
import { measureSync } from "@/server/perf";
import { ensureBackgroundScanner } from "@/server/scanner";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureBackgroundScanner();
  const sp = req.nextUrl.searchParams;
  const { markets, source, fetchedAt } = await getMarkets();
  const store = await getStore();
  const settings = await store.getSettings();
  const signals = await store.listSignals({ limit: 400 });

  // best (highest score) signal per market
  const bestSignal = new Map<string, SignalJoin>();
  for (const s of signals) {
    if (!s.conditionId) continue;
    const cur = bestSignal.get(s.conditionId);
    if (!cur || s.score > cur.score)
      bestSignal.set(s.conditionId, {
        score: s.score,
        strategy: s.strategy,
        status: s.status,
      });
  }

  const query: ScannerQuery = {
    q: sp.get("q") ?? undefined,
    venue: sp.get("venue") ?? undefined,
    tradableOnly: sp.get("tradableOnly") === "1",
    hideReference: sp.get("hideReference") === "1",
    maxDataAgeSecs: num(sp.get("maxDataAgeSecs")),
    tag: sp.get("tag") ?? undefined,
    closingHrs: num(sp.get("closingHrs")),
    minLiquidity: num(sp.get("minLiquidity")),
    minVolume: num(sp.get("minVolume")),
    maxSpread: num(sp.get("maxSpread")),
    priceMin: num(sp.get("priceMin")),
    priceMax: num(sp.get("priceMax")),
    newOnly: sp.get("newOnly") === "1",
    highMovement: sp.get("highMovement") === "1",
    watchlistOnly: sp.get("watchlistOnly") === "1",
    sort: sp.get("sort") ?? "volume24h",
    dir: sp.get("dir") === "asc" ? "asc" : "desc",
    limit: num(sp.get("limit")) ?? 100,
  };
  const watchlist = new Set(settings.watchlist);

  // hot path: pure in-memory filter/sort + enrich, held to the <20ms budget
  const enriched = measureSync("hot.scanner_filter_sort", () => {
    const rows = filterSortMarkets(markets, query, bestSignal, watchlist);
    return rows.map((m) => {
      const g = gradeMarket(m, settings.maxSpread);
      const sig = bestSignal.get(m.conditionId);
      return {
        ...m,
        riskGrade: g.grade,
        tradability: g.tradability,
        gradeFactors: g.factors,
        signalScore: sig?.score,
        signalStrategy: sig?.strategy,
        watchlisted: watchlist.has(m.conditionId),
      };
    });
  });

  // category list for the filter dropdown
  const tags = new Map<string, number>();
  for (const m of markets) {
    const c = m.category ?? "Uncategorized";
    tags.set(c, (tags.get(c) ?? 0) + 1);
  }

  return NextResponse.json({
    markets: enriched,
    total: markets.length,
    source,
    fetchedAt,
    categories: [...tags.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([label, count]) => ({ label, count })),
  });
}

function num(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
