import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureBackgroundScanner } from "@/server/scanner";
import {
  approvePromotion,
  ensureSeeded,
  featuresWithEvidence,
  foundryTick,
  generateResearchIdeas,
  isGraveyard,
  RESEARCH_AGENT_PROMPT,
  retireFeature,
  runProsecutor,
} from "@/server/alpha/foundry";
import { getLastRuns, listIdeas } from "@/server/alpha/repo";
import { walletIntelInfo } from "@/server/alpha/walletRadar";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  await ensureSeeded();
  const [features, ideas, lastRuns] = await Promise.all([
    featuresWithEvidence(),
    listIdeas(),
    getLastRuns(),
  ]);
  return NextResponse.json({
    features: features.filter((f) => !isGraveyard(f)),
    graveyard: features.filter(isGraveyard),
    ideas: [...ideas].reverse().slice(0, 30),
    lastRuns,
    walletIntel: walletIntelInfo(),
    researchAgentPrompt: RESEARCH_AGENT_PROMPT,
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tick") }),
  z.object({ action: z.literal("research") }),
  z.object({ action: z.literal("backtest"), featureId: z.string() }),
  z.object({ action: z.literal("prosecute"), featureId: z.string() }),
  z.object({
    action: z.literal("approve"),
    featureId: z.string(),
    approvedBy: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal("retire"),
    featureId: z.string(),
    reason: z.string().min(3).max(500),
    failureClass: z.enum([
      "no_edge", "overfit", "slippage", "latency", "low_liquidity",
      "bad_data", "bad_mapping", "rule_ambiguity", "source_terms", "decay",
    ]),
    lessons: z.string().max(1_000).default(""),
  }),
]);

export async function POST(req: NextRequest) {
  const parsed = actionSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid action", details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;
  switch (body.action) {
    case "tick":
      return NextResponse.json({ result: await foundryTick(true) });
    case "research":
      return NextResponse.json({ ideas: await generateResearchIdeas() });
    case "backtest": {
      const { runWalkForwardBacktest } = await import("@/server/alpha/backtester");
      const res = await runWalkForwardBacktest(body.featureId);
      return res.ok
        ? NextResponse.json(res)
        : NextResponse.json({ ...res, error: res.reason }, { status: 400 });
    }
    case "prosecute":
      return NextResponse.json({ verdict: await runProsecutor(body.featureId) });
    case "approve": {
      const res = await approvePromotion(body.featureId, body.approvedBy);
      return NextResponse.json(res, { status: res.ok ? 200 : 409 });
    }
    case "retire":
      await retireFeature(body.featureId, body.reason, body.failureClass, body.lessons);
      return NextResponse.json({ ok: true });
  }
}
