import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { previewTrade } from "@/server/execution";

export const dynamic = "force-dynamic";

const previewSchema = z.object({
  mode: z.enum(["demo", "paper", "live"]),
  conditionId: z.string().optional(),
  tokenId: z.string().min(1),
  outcome: z.string().optional(),
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["limit", "market"]).default("limit"),
  price: z.number().gt(0).lt(1),
  size: z.number().gt(0).lte(1_000_000),
  winProbability: z.number().gt(0).lt(1).optional(),
  signalScore: z.number().min(0).max(100).optional(),
  signalId: z.string().optional(),
  targetPrice: z.number().gt(0).lt(1).optional(),
  stopPrice: z.number().gt(0).lt(1).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = previewSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid preview request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await previewTrade(parsed.data);
  return NextResponse.json(result);
}
