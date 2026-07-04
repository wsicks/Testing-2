import { NextRequest, NextResponse } from "next/server";
import type { TerminalMode } from "@/lib/types";
import { demoAccount } from "@/lib/demo/demoData";
import { getMarkets } from "@/server/marketData";
import { computePortfolio } from "@/server/portfolio";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const mode = (req.nextUrl.searchParams.get("mode") ?? "demo") as TerminalMode;
  const portfolio = await computePortfolio(mode);

  let equitySeries: { t: number; equity: number }[];
  if (mode === "demo") {
    const { markets } = await getMarkets();
    equitySeries = demoAccount(markets).equitySeries;
  } else {
    const store = await getStore();
    const snaps = await store.listPortfolioSnapshots(mode, 500);
    equitySeries = snaps.map((s) => ({ t: s.ts, equity: s.totalValue }));
    if (equitySeries.length === 0)
      equitySeries = [{ t: Date.now(), equity: portfolio.totalValue }];
  }

  return NextResponse.json({ portfolio, equitySeries });
}
