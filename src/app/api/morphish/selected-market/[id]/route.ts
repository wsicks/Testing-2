import { NextRequest, NextResponse } from "next/server";
import { getBook, getMarketByCondition } from "@/server/marketData";
import { getCrossVenueLinks } from "@/server/crossVenue";
import { recentSignals } from "@/server/hotpath/signalCache";
import { getWalletIntel } from "@/server/alpha/walletRadar";
import { clarityScore } from "@/lib/engine/signals/ecl";
import { resolutionClarity } from "@/lib/engine/signals/closingSoon";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const market = await getMarketByCondition(id);
  if (!market) return NextResponse.json({ error: "unknown market" }, { status: 404 });
  const book = market.yesTokenId
    ? await getBook(market.yesTokenId, market.midpoint ?? 0.5).catch(() => undefined)
    : undefined;
  const links = (await getCrossVenueLinks().catch(() => [])).filter(
    (l) => l.sourceMarketId === id || l.targetMarketId === id,
  );
  const signals = recentSignals().filter((s) => s.conditionId === id).slice(0, 8);
  const clarity = resolutionClarity(market.description, market.resolutionSource);

  // reasons to trade / not to trade — straight from signal check trails,
  // never invented
  const reasonsFor: string[] = [];
  const reasonsAgainst: string[] = [];
  for (const s of signals) {
    for (const c of s.checks) {
      const line = `[${s.strategy}] ${c.detail}`;
      if (c.passed && s.direction !== "NEUTRAL" && reasonsFor.length < 6) reasonsFor.push(line);
      if (!c.passed && reasonsAgainst.length < 6) reasonsAgainst.push(line);
    }
  }

  return NextResponse.json({
    market,
    book,
    signals,
    crossLinks: links,
    walletIntel: getWalletIntel(id),
    ruleClarity: clarityScore(clarity.level),
    clarityReason: clarity.reason,
    reasonsFor,
    reasonsAgainst,
  });
}
