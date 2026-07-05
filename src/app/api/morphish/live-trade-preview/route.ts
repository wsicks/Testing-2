import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { liveGate, previewTrade } from "@/server/execution";
import { getStore } from "@/server/store";

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

/**
 * LIVE preview — preview ONLY. Nothing can be placed from the Morphish
 * board; placing requires the normal intent flow with its per-venue gates
 * and typed confirmation. The gate verdict ships with the preview so
 * blocked users see exactly why.
 */
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid preview", details: parsed.error.flatten() }, { status: 400 });
  }
  const store = await getStore();
  const settings = await store.getSettings();
  const gate = liveGate(settings);
  const res = await previewTrade({ ...parsed.data, mode: "live" });
  return NextResponse.json({
    ...res,
    liveGateOpen: gate.allowed,
    liveGateReasons: gate.reasons,
    note: "preview only — live orders route exclusively through the intent flow (per-venue gates + explicit confirmation)",
  });
}
