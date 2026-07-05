import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { previewTrade } from "@/server/execution";

export const dynamic = "force-dynamic";

const schema = z.object({
  conditionId: z.string().optional(),
  tokenId: z.string().min(4),
  outcome: z.string().optional(),
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["limit", "market"]).default("limit"),
  price: z.number().positive().lt(10_000_000),
  size: z.number().positive(),
  signalId: z.string().optional(),
  signalScore: z.number().optional(),
  winProbability: z.number().gt(0).lt(1).optional(),
});

/** PAPER preview — full risk engine, nothing placed */
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid preview", details: parsed.error.flatten() }, { status: 400 });
  }
  const res = await previewTrade({ ...parsed.data, mode: "paper" });
  return NextResponse.json(res);
}
