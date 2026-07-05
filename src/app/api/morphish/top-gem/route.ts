import { NextResponse } from "next/server";
import { ensureBackgroundScanner } from "@/server/scanner";
import { morphishTopGem } from "@/server/morphish";
import { getHistory } from "@/server/marketData";
import { getMarkets } from "@/server/marketData";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  const payload = await morphishTopGem();
  // sparkline for the winning gem: recent YES price history (cached upstream)
  let spark: { t: number; p: number }[] = [];
  if (payload.gem) {
    try {
      const { markets } = await getMarkets();
      const m = markets.find((x) => x.conditionId === payload.gem!.conditionId);
      if (m?.yesTokenId) spark = await getHistory(m.yesTokenId, "1d", 60);
    } catch {
      /* sparkline is decoration; the gem stands without it */
    }
  }
  return NextResponse.json({ ...payload, spark });
}
