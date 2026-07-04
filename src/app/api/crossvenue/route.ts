import { NextRequest, NextResponse } from "next/server";
import { getCrossVenueLinks } from "@/server/crossVenue";
import { ensureBackgroundScanner } from "@/server/scanner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureBackgroundScanner();
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const marketId = req.nextUrl.searchParams.get("marketId") ?? undefined;
  let links = await getCrossVenueLinks();
  if (status) links = links.filter((l) => l.matchStatus === status);
  if (marketId)
    links = links.filter(
      (l) => l.sourceMarketId === marketId || l.targetMarketId === marketId,
    );
  return NextResponse.json({ links });
}
