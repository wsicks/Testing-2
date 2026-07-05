import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runBacktest, type SeriesInput } from "@/lib/engine/backtest/backtester";
import type { HistoryInterval } from "@/lib/polymarket/clob";
import { audit } from "@/server/audit";
import { getHistory, getMarkets } from "@/server/marketData";

export const dynamic = "force-dynamic";

const configSchema = z.object({
  strategyId: z.enum(["momentum", "mean_reversion", "closing_drift"]),
  conditionIds: z.array(z.string()).min(1).max(8),
  days: z.number().min(2).max(180),
  initialCapital: z.number().min(100).max(10_000_000).default(10_000),
  positionPct: z.number().gt(0).lte(25).default(2),
  entryThreshold: z.number().min(0).max(100).default(50),
  holdBars: z.number().min(1).max(500).default(24),
  targetPct: z.number().gt(0).lte(500).default(15),
  stopPct: z.number().gt(0).lte(100).default(10),
  feeRateBps: z.number().min(0).max(1_000).default(0),
  slippageBps: z.number().min(0).max(5_000).default(50),
  spreadAssumption: z.number().min(0).max(0.2).default(0.02),
});

export async function POST(req: NextRequest) {
  const parsed = configSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid backtest config", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const cfg = parsed.data;
  const { markets } = await getMarkets();
  const nowSecs = Math.floor(Date.now() / 1000);
  const from = nowSecs - cfg.days * 86_400;

  const interval: HistoryInterval =
    cfg.days <= 7 ? "1w" : cfg.days <= 31 ? "1m" : "max";
  const fidelity = cfg.days <= 7 ? 60 : cfg.days <= 31 ? 180 : 720;

  const series: SeriesInput[] = [];
  for (const cid of cfg.conditionIds) {
    const m = markets.find((x) => x.conditionId === cid);
    if (!m?.yesTokenId) continue;
    const points = await getHistory(m.yesTokenId, interval, fidelity);
    series.push({ tokenId: m.yesTokenId, marketTitle: m.question, points });
  }
  if (series.length === 0) {
    return NextResponse.json(
      { error: "no price history available for the selected markets" },
      { status: 422 },
    );
  }

  const result = runBacktest(
    {
      strategyId: cfg.strategyId,
      tokenIds: series.map((s) => s.tokenId),
      from,
      to: nowSecs,
      initialCapital: cfg.initialCapital,
      positionPct: cfg.positionPct,
      entryThreshold: cfg.entryThreshold,
      holdBars: cfg.holdBars,
      targetPct: cfg.targetPct,
      stopPct: cfg.stopPct,
      feeRateBps: cfg.feeRateBps,
      slippageBps: cfg.slippageBps,
      spreadAssumption: cfg.spreadAssumption,
    },
    series,
  );

  await audit(
    "user",
    "backtest_run",
    `Backtest ${cfg.strategyId} over ${series.length} market(s), ${cfg.days}d → ${result.stats.trades} trades, ${result.stats.totalReturnPct}% (historical simulation)`,
    { data: { strategy: cfg.strategyId, markets: series.length }, feedType: "user_action" },
  );

  return NextResponse.json({ result });
}
