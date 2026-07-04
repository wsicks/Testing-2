// TradingView UDF-compatible datafeed served entirely from OUR backend's
// normalized data (native Coinbase candles; derived OHLC for Polymarket and
// Kalshi). For use with TradingView Advanced Charts by operators who hold a
// TradingView license — nothing here scrapes or proxies TradingView data.
//
// Symbol scheme:  POLYMARKET:<conditionId>  KALSHI:<ticker>  COINBASE:<product>

import { NextRequest, NextResponse } from "next/server";
import { getMarkets, getCandles } from "@/server/marketData";

export const dynamic = "force-dynamic";

const RESOLUTIONS = ["1", "5", "15", "30", "60", "240", "1D"];

function resToMin(res: string): number {
  if (res === "1D" || res === "D") return 1440;
  const n = Number(res);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function toInternalId(symbol: string): string | null {
  const [venue, ...rest] = symbol.split(":");
  const id = rest.join(":");
  if (!id) return null;
  switch (venue.toUpperCase()) {
    case "POLYMARKET":
      return id;
    case "KALSHI":
      return id.startsWith("ks:") ? id : `ks:${id}`;
    case "COINBASE":
      return id.startsWith("cb:") ? id : `cb:${id}`;
    default:
      return null;
  }
}

function toSymbol(venueId: string, m: { conditionId: string; venueMarketId: string }): string {
  return `${venueId.toUpperCase()}:${venueId === "polymarket" ? m.conditionId : m.venueMarketId}`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fn: string }> },
) {
  const { fn } = await params;
  const sp = req.nextUrl.searchParams;

  if (fn === "config") {
    return NextResponse.json({
      supported_resolutions: RESOLUTIONS,
      supports_search: true,
      supports_group_request: false,
      supports_marks: false,
      supports_timescale_marks: false,
      supports_time: true,
    });
  }

  if (fn === "time") {
    return new NextResponse(String(Math.floor(Date.now() / 1000)));
  }

  if (fn === "search") {
    const q = (sp.get("query") ?? "").toLowerCase();
    const limit = Number(sp.get("limit") ?? 20);
    const { markets } = await getMarkets();
    const hits = markets
      .filter(
        (m) =>
          m.question.toLowerCase().includes(q) ||
          (m.venueTicker ?? "").toLowerCase().includes(q),
      )
      .slice(0, limit)
      .map((m) => ({
        symbol: toSymbol(m.venueId, m),
        full_name: toSymbol(m.venueId, m),
        description: m.question.slice(0, 80),
        exchange: m.venueId.toUpperCase(),
        type: m.outcomeType === "asset" ? "crypto" : "prediction",
      }));
    return NextResponse.json(hits);
  }

  if (fn === "symbols") {
    const symbol = sp.get("symbol") ?? "";
    const internal = toInternalId(symbol);
    if (!internal) return NextResponse.json({ s: "error", errmsg: "unknown symbol" });
    const { markets } = await getMarkets();
    const m = markets.find((x) => x.conditionId === internal);
    if (!m) return NextResponse.json({ s: "error", errmsg: "symbol not found" });
    const isAsset = m.outcomeType === "asset";
    return NextResponse.json({
      name: symbol,
      ticker: symbol,
      description: m.question.slice(0, 120),
      type: isAsset ? "crypto" : "prediction",
      session: "24x7",
      timezone: "Etc/UTC",
      exchange: m.venueId.toUpperCase(),
      minmov: 1,
      pricescale: isAsset ? 100 : 1000, // probabilities to 0.1c
      has_intraday: true,
      supported_resolutions: RESOLUTIONS,
      volume_precision: 2,
      data_status: "endofday", // polled REST backend — honestly not streaming
    });
  }

  if (fn === "history") {
    const internal = toInternalId(sp.get("symbol") ?? "");
    const from = Number(sp.get("from"));
    const to = Number(sp.get("to"));
    const resolution = resToMin(sp.get("resolution") ?? "60");
    if (!internal || !Number.isFinite(from) || !Number.isFinite(to)) {
      return NextResponse.json({ s: "error", errmsg: "bad params" });
    }
    const candles = await getCandles(internal, resolution, from, to);
    if (!candles.length) return NextResponse.json({ s: "no_data" });
    return NextResponse.json({
      s: "ok",
      t: candles.map((c) => c.t),
      o: candles.map((c) => c.o),
      h: candles.map((c) => c.h),
      l: candles.map((c) => c.l),
      c: candles.map((c) => c.c),
      v: candles.map((c) => c.v),
    });
  }

  return NextResponse.json({ s: "error", errmsg: `unknown endpoint ${fn}` }, { status: 404 });
}
