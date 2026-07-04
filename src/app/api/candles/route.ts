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
  const candles = await getCandles(market, res, from, to);
  return NextResponse.json({ candles });
}
