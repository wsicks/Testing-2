import { NextRequest, NextResponse } from "next/server";
import { gradeMarket } from "@/lib/engine/risk/grade";
import { getMarkets } from "@/server/marketData";
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

  // best (most recent, highest score) signal per market
  const bestSignal = new Map<string, { score: number; strategy: string; status: string }>();
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

  const q = sp.get("q")?.toLowerCase();
  const tag = sp.get("tag")?.toLowerCase();
  const closingHrs = num(sp.get("closingHrs"));
  const minLiquidity = num(sp.get("minLiquidity"));
  const minVolume = num(sp.get("minVolume"));
  const maxSpread = num(sp.get("maxSpread"));
  const priceMin = num(sp.get("priceMin"));
  const priceMax = num(sp.get("priceMax"));
  const newOnly = sp.get("newOnly") === "1";
  const highMovement = sp.get("highMovement") === "1";
  const watchlistOnly = sp.get("watchlistOnly") === "1";
  const sort = sp.get("sort") ?? "volume24h";
  const dir = sp.get("dir") === "asc" ? 1 : -1;
  const limit = num(sp.get("limit")) ?? 100;
  const now = Date.now();

  let rows = markets.filter((m) => {
    if (q && !(`${m.question} ${m.eventTitle ?? ""}`.toLowerCase().includes(q)))
      return false;
    if (tag && !m.tags.some((t) => t.toLowerCase() === tag) && m.category?.toLowerCase() !== tag)
      return false;
    if (closingHrs !== undefined) {
      if (!m.endDate) return false;
      const msLeft = new Date(m.endDate).getTime() - now;
      if (msLeft < 0 || msLeft > closingHrs * 3_600_000) return false;
    }
    if (minLiquidity !== undefined && m.liquidity < minLiquidity) return false;
    if (minVolume !== undefined && m.volume24h < minVolume) return false;
    if (maxSpread !== undefined && (m.spread ?? 1) > maxSpread) return false;
    const mid = m.midpoint ?? m.yesPrice ?? 0.5;
    if (priceMin !== undefined && mid < priceMin) return false;
    if (priceMax !== undefined && mid > priceMax) return false;
    if (newOnly && !m.isNew) return false;
    if (highMovement && Math.abs(m.oneDayPriceChange ?? 0) < 0.05) return false;
    if (watchlistOnly && !settings.watchlist.includes(m.conditionId)) return false;
    return true;
  });

  const sortKey = (m: (typeof rows)[number]): number => {
    switch (sort) {
      case "liquidity":
        return m.liquidity;
      case "spread":
        return m.spread ?? 1;
      case "closeTime":
        return m.endDate ? new Date(m.endDate).getTime() : Infinity;
      case "change":
        return Math.abs(m.oneDayPriceChange ?? 0);
      case "signal":
        return bestSignal.get(m.conditionId)?.score ?? -1;
      case "price":
        return m.midpoint ?? 0;
      default:
        return m.volume24h;
    }
  };
  rows.sort((a, b) => (sortKey(a) - sortKey(b)) * dir);
  rows = rows.slice(0, limit);

  const enriched = rows.map((m) => {
    const g = gradeMarket(m, settings.maxSpread);
    const sig = bestSignal.get(m.conditionId);
    return {
      ...m,
      riskGrade: g.grade,
      tradability: g.tradability,
      gradeFactors: g.factors,
      signalScore: sig?.score,
      signalStrategy: sig?.strategy,
      watchlisted: settings.watchlist.includes(m.conditionId),
    };
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
