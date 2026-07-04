// Symbol search across all venues + CoinGecko reference assets.
// Every result carries its venue, tradability class, source and freshness.

import { NextRequest, NextResponse } from "next/server";
import { getMarkets } from "@/server/marketData";
import { getReferencePrices } from "@/server/crossVenue";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").toLowerCase().trim();
  if (q.length < 2) return NextResponse.json({ results: [] });
  const { markets } = await getMarkets();
  const refs = await getReferencePrices();

  const results = markets
    .filter(
      (m) =>
        m.question.toLowerCase().includes(q) ||
        (m.venueTicker ?? "").toLowerCase().includes(q) ||
        (m.eventTitle ?? "").toLowerCase().includes(q),
    )
    .slice(0, 20)
    .map((m) => ({
      kind: "market" as const,
      venueId: m.venueId,
      id: m.conditionId,
      ticker: m.venueTicker,
      title: m.question,
      tradable: m.tradable && !m.referenceOnly,
      dataClass: m.referenceOnly ? "reference" : "tradable",
      lastUpdated: m.fetchedAt,
    }));

  const refResults = refs
    .filter((r) => r.symbol.toLowerCase().includes(q))
    .map((r) => ({
      kind: "reference" as const,
      venueId: r.source,
      id: `ref:${r.symbol}`,
      ticker: r.symbol,
      title: `${r.symbol} reference price $${r.price.toLocaleString()}`,
      tradable: false,
      dataClass: "reference",
      lastUpdated: r.ts,
    }));

  return NextResponse.json({ results: [...results, ...refResults].slice(0, 25) });
}
