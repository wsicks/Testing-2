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
import { getAttention } from "@/server/alpha/attention";
import { allOutcomes } from "@/server/alpha/outcomes";
import { listArbPairs } from "@/server/alpha/arbExecutor";
import { confluenceMatrix, driftByPriceProfile } from "@/lib/alpha/evidenceLab";
import { strategyHitRates } from "@/lib/alpha/hitRate";
import { listErrors } from "@/server/errorLog";
import { getStore } from "@/server/store";
import type { BanditState } from "@/lib/engine/autopilot/bandit";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  await ensureSeeded();
  const store = await getStore();
  const [features, ideas, lastRuns, attention, bandit, outcomes] = await Promise.all([
    featuresWithEvidence(),
    listIdeas(),
    getLastRuns(),
    getAttention(),
    store.getKV<BanditState>("autopilot:bandit"),
    allOutcomes(),
  ]);
  // Evidence Lab — the machine reading its own outcome archive
  const confluence = confluenceMatrix(outcomes);
  const driftProfile = driftByPriceProfile(outcomes);
  // measured per-strategy win rates (1h horizon) + Wilson floors — the same
  // numbers the autopilot hit-rate governor gates on
  const hitRates = strategyHitRates(outcomes);
  const runtimeErrors = (await listErrors()).slice(0, 30);
  // complement-arb ledger: discounts locked at entry (arithmetic, not P&L
  // forecasts) — reported with pair counts and unwind honesty
  const arbPairs = await listArbPairs();
  const arb = {
    pairs: arbPairs.length,
    unwound: arbPairs.filter((p) => p.status === "unwound").length,
    lockedNetUsd: Number(arbPairs.reduce((a, p) => a + p.lockedNetUsd, 0).toFixed(2)),
    recent: arbPairs.slice(-5).reverse(),
  };
  // realized paper PnL per strategy — AUTOPILOT-MANAGED trades only (the
  // bandit learns from realized exits); manual/mimic fills are not attributed
  const paperPnl = Object.fromEntries(
    Object.entries(bandit?.arms ?? {}).map(([k, a]) => [
      k,
      { realizedUsd: a.realizedPnlUsd, wins: a.wins, losses: a.losses },
    ]),
  );
  return NextResponse.json({
    features: features.filter((f) => !isGraveyard(f)),
    graveyard: features.filter(isGraveyard),
    ideas: [...ideas].reverse().slice(0, 30),
    lastRuns,
    walletIntel: walletIntelInfo(),
    attention,
    paperPnl,
    confluence,
    driftProfile,
    hitRates,
    runtimeErrors,
    arb,
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
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
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
