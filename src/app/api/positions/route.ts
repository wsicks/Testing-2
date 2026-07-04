import { NextRequest, NextResponse } from "next/server";
import type { TerminalMode } from "@/lib/types";
import { computePortfolio } from "@/server/portfolio";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const mode = (req.nextUrl.searchParams.get("mode") ?? "demo") as TerminalMode;
  const portfolio = await computePortfolio(mode);
  return NextResponse.json({
    positions: portfolio.positions,
    isSample: portfolio.isSample,
  });
}
