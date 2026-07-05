import { NextRequest, NextResponse } from "next/server";
import { getCandles } from "@/server/marketData";

export const dynamic = "force-dynamic";

const RES_SET = new Set([1, 5, 15, 30, 60, 240, 1440]);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market");
  const res = Number(sp.get("res") ?? 60);
  const nowSec = Math.floor(Date.now() / 1000);
  const from = Number(sp.get("from") ?? nowSec - 7 * 86_400);
  const to = Number(sp.get("to") ?? nowSec);
  if (!market || !RES_SET.has(res) || !Number.isFinite(from) || !Number.isFinite(to)) {
    return NextResponse.json({ error: "market, res∈{1,5,15,30,60,240,1440}, from, to required" }, { status: 400 });
  }
  // clamp the span to what one upstream request can honestly serve (~300
  // bars): from=0 would exceed Coinbase's per-request candle limit, 500 the
  // route, and mark the source degraded from pure user input
  const maxSpanSec = 300 * res * 60;
  const clampedFrom = Math.max(from, to - maxSpanSec);
  try {
    const candles = await getCandles(market, res, clampedFrom, to);
    return NextResponse.json({ candles, clampedFrom: clampedFrom !== from ? clampedFrom : undefined });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "candles unavailable" },
      { status: 502 },
    );
  }
}
