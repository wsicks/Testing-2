import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createLiveIntent } from "@/server/execution";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

const intentSchema = z.object({
  conditionId: z.string().optional(),
  tokenId: z.string().min(1),
  outcome: z.string().optional(),
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["limit"]).default("limit"), // live: limit orders first
  price: z.number().gt(0).lt(1),
  size: z.number().gt(0).lte(1_000_000),
  winProbability: z.number().gt(0).lt(1).optional(),
  signalScore: z.number().min(0).max(100).optional(),
  signalId: z.string().optional(),
});

export async function GET() {
  const store = await getStore();
  const intents = await store.listIntents();
  return NextResponse.json({ intents });
}

export async function POST(req: NextRequest) {
  const parsed = intentSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid intent", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await createLiveIntent({ ...parsed.data, mode: "live" });
  return NextResponse.json(result, {
    status: result.intent.status === "rejected" ? 422 : 201,
  });
}
