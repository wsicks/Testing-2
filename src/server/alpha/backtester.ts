// Backtest orchestration — feeds real hourly price histories into the
// purged walk-forward harness and persists the result on the feature.
//
// Data: month-scale hourly bars for the most liquid binary Polymarket
// markets (CLOB prices-history, cached upstream). The result moves an
// idea/data_connected feature to `backtesting` — never further; paper
// forward testing and the prosecutor still stand between a good backtest
// and promotion.

import {
  REPLAY_RULES,
  replayableFeatures,
  walkForwardReplay,
  type ReplaySeries,
  type WalkForwardResult,
} from "@/lib/alpha/walkforward";
import { categorizeMarket } from "@/lib/alpha/score";
import { audit } from "../audit";
import { getHistory, getMarkets } from "../marketData";
import { getStore } from "../store";
import { listFeatures, upsertFeature } from "./repo";

const UNIVERSE = 24; // markets replayed per run
const MIN_LIQUIDITY = 10_000;

export async function runWalkForwardBacktest(
  featureId: string,
): Promise<{ ok: true; result: WalkForwardResult } | { ok: false; reason: string }> {
  const rule = REPLAY_RULES[featureId];
  if (!rule) {
    return {
      ok: false,
      reason: `no point-in-time replay rule exists for '${featureId}' — this feature's evidence comes from forward paper testing only (replayable: ${replayableFeatures().join(", ")})`,
    };
  }
  const store = await getStore();
  const settings = await store.getSettings();
  const { markets } = await getMarkets();
  const universe = markets
    .filter(
      (m) =>
        m.venueId === "polymarket" &&
        m.outcomeType === "binary" &&
        m.tradable &&
        !m.referenceOnly &&
        m.liquidity >= MIN_LIQUIDITY &&
        m.yesTokenId,
    )
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, UNIVERSE);
  if (universe.length < 5) return { ok: false, reason: "fewer than 5 liquid markets available for replay" };

  const series: ReplaySeries[] = [];
  const spreads: number[] = [];
  for (const m of universe) {
    try {
      const bars = await getHistory(m.yesTokenId!, "1m", 60); // ~30d hourly
      if (bars.length >= rule.minBars + 12) {
        series.push({
          marketId: m.conditionId,
          category: categorizeMarket({ question: m.question, category: m.category, tags: m.tags }),
          bars,
        });
        if (m.spread !== undefined) spreads.push(m.spread);
      }
    } catch {
      /* skip markets whose history fails to load */
    }
  }
  if (series.length < 5)
    return { ok: false, reason: `only ${series.length} usable price histories — not enough for folds` };

  const avgSpread = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0.02;
  const frictionC = avgSpread / 2 + settings.slippageBps / 10_000 + settings.feeRateBps / 10_000;
  const result = walkForwardReplay(rule, series, {
    frictionC,
    resolution: "hourly (≈30d)",
    ranAt: Date.now(),
  });

  const features = await listFeatures();
  const f = features.find((x) => x.id === featureId);
  if (f) {
    f.lastBacktest = result;
    if (f.status === "idea" || f.status === "data_connected") f.status = "backtesting";
    f.updatedAt = Date.now();
    await upsertFeature(f);
  }
  await audit(
    "scanner",
    "alpha_backtest",
    `Walk-forward replay for ${featureId}: ${result.outcomes} simulated entries over ${result.markets} markets, avg net ${(result.avgNet * 100).toFixed(2)}c, ${result.positiveFolds}/${result.folds.length} folds positive, single-market share ${(result.singleMarketShare * 100).toFixed(0)}%`,
    { data: { featureId, outcomes: result.outcomes, avgNet: result.avgNet } },
  );
  return { ok: true, result };
}
