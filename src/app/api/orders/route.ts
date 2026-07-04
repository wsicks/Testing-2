import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { placePaperOrder } from "@/server/execution";
import { ensureBackgroundScanner } from "@/server/scanner";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

const placeSchema = z.object({
  mode: z.enum(["demo", "paper"]),
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

export async function GET(req: NextRequest) {
  // reads are side-effect free — resting orders are settled by the scanner
  // tick (30s), which serializes settlement through the per-mode mutex
  ensureBackgroundScanner();
  const mode = req.nextUrl.searchParams.get("mode") ?? undefined;
  const store = await getStore();
  const orders = await store.listOrders(mode);
  return NextResponse.json({ orders });
}

export async function POST(req: NextRequest) {
  const parsed = placeSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid order", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await placePaperOrder(parsed.data);
  return NextResponse.json(result, { status: result.rejected ? 422 : 201 });
}
