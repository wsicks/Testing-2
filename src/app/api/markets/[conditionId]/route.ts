import { NextRequest, NextResponse } from "next/server";
import { gradeMarket } from "@/lib/engine/risk/grade";
import { buildMarketIntelligence } from "@/lib/engine/marketIntelligence";
import type { HistoryInterval } from "@/lib/polymarket/clob";
import {
  getBook,
  getHistory,
  getMarketByCondition,
  getTrades,
} from "@/server/marketData";
import { peekBookSnapshot } from "@/server/hotpath/bookMemory";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conditionId: string }> },
) {
  const { conditionId } = await params;
  const interval = (req.nextUrl.searchParams.get("interval") ?? "1w") as HistoryInterval;
  const market = await getMarketByCondition(conditionId);
  if (!market) {
    return NextResponse.json({ error: "market not found" }, { status: 404 });
  }
  const store = await getStore();
  const settings = await store.getSettings();

  const fidelity = interval === "1d" ? 15 : interval === "1w" ? 60 : 180;
  const [yesBook, noBook, history, trades, signals] = await Promise.all([
    market.yesTokenId
      ? getBook(market.yesTokenId, market.midpoint)
      : Promise.resolve(undefined),
    market.noTokenId
      ? getBook(market.noTokenId, 1 - (market.midpoint ?? 0.5))
      : Promise.resolve(undefined),
    market.yesTokenId
      ? getHistory(market.yesTokenId, interval, fidelity)
      : Promise.resolve([]),
    getTrades(conditionId),
    store.listSignals({ conditionId, limit: 20 }),
  ]);

  const grade = gradeMarket(market, settings.maxSpread);
  const intelligence = buildMarketIntelligence({
    market,
    book: yesBook,
    previousBook: market.yesTokenId ? peekBookSnapshot(market.yesTokenId) : undefined,
    trades,
    settings,
    now: Date.now(),
  });

  return NextResponse.json({
    market: { ...market, riskGrade: grade.grade, tradability: grade.tradability, gradeFactors: grade.factors },
    yesBook,
    noBook,
    history,
    trades,
    signals,
    intelligence,
    polymarketUrl: market.eventSlug
      ? `https://polymarket.com/event/${market.eventSlug}`
      : market.slug
        ? `https://polymarket.com/market/${market.slug}`
        : undefined,
    watchlisted: settings.watchlist.includes(conditionId),
  });
}
